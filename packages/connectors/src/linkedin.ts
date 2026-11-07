import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActivityInput, ActivityKind, Media, MetricInput, MetricName, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, downloadMedia, isAfter, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource, openMedia, rawBody, sendStream, withMedia, type StreamBody } from "./media-io.ts";
import { OAuth2Client, clientFromEnv, type OAuth2Token } from "./oauth.ts";
import type {
  AccountIdentity,
  AccountRef,
  AuthRefresh,
  ConnectedAccount,
  Connector,
  ConnectorCapabilities,
  ModerationInput,
  PublishInput,
  PublishResult,
  ValidationIssue,
  WebhookBatch,
  WebhookHandler,
} from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * LinkedIn adapter over the versioned REST API (https://api.linkedin.com/rest, `LinkedIn-Version: YYYYMM`,
 * `X-Restli-Protocol-Version: 2.0.0`).
 *
 * One login connects the member (person URN) plus every organization (company page) the member administers.
 * All of those accounts share the member's token; each account's `config.authorUrn` says who posts.
 *
 * What the member scopes allow is narrow: posting, commenting and reacting (w_member_social). Reading a member's
 * own posts and comments needs r_member_social, which LinkedIn keeps closed, so the member account's inbox is
 * empty. Organization accounts (Community Management API) can read posts, comments and page analytics.
 */

/** A supported version as of November 2026 (202610 is the latest release; versions live at least a year). */
export const LINKEDIN_DEFAULT_VERSION = "202610";

/** Sign in with LinkedIn (OIDC) + posting as the member. Self-serve products. */
export const LINKEDIN_MEMBER_SCOPES = ["openid", "profile", "email", "w_member_social"];
/**
 * Company pages: Community Management API (requires LinkedIn's approval).
 * TODO(verify): whether comments/reactions still need the June-2023 feed scopes (r_organization_social_feed,
 * w_organization_social_feed, w_member_social_feed) on top of these; add them via LINKEDIN_SCOPES if the app has them.
 */
export const LINKEDIN_ORGANIZATION_SCOPES = ["w_organization_social", "r_organization_social", "rw_organization_admin", "r_organization_admin"];
export const LINKEDIN_OAUTH_SCOPES = [...LINKEDIN_MEMBER_SCOPES, ...LINKEDIN_ORGANIZATION_SCOPES];

export const LinkedInAuth = z.object({
  accessToken: z.string().min(1),
  /** Present only for apps LinkedIn enabled for programmatic refresh tokens. */
  refreshToken: z.string().min(1).optional(),
  /** ISO time the access token expires (60 days after the grant). */
  expiresAt: z.string().optional(),
  /** ISO time the refresh token expires (365 days after the original grant; refreshing does not extend it). */
  refreshExpiresAt: z.string().optional(),
  scope: z.string().optional(),
  /** urn:li:person:{sub} of the member who granted the token. */
  personUrn: z.string().startsWith("urn:li:person:"),
});
export type LinkedInAuth = z.infer<typeof LinkedInAuth>;

/** Non-secret per-account config: who the account posts as. */
export interface LinkedInAccountConfig {
  authorUrn: string;
  kind: "member" | "organization";
  organizationId?: string;
}

export interface LinkedInConnectorOptions {
  clientId?: string;
  clientSecret?: string;
  /** LinkedIn-Version header (YYYYMM). */
  apiVersion?: string;
  /** Override the requested scopes (e.g. only member scopes before Community Management approval). */
  scopes?: string[];
  baseUrl?: string;
  /** https://www.linkedin.com/oauth/v2 */
  oauthBaseUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Wait between asset status polls. */
  pollIntervalMs?: number;
  /** Polls before giving up with a retryable error (default 30, about a minute at 2s). */
  maxPolls?: number;
  /** Recent organization posts whose comments fetchActivity reads (each is one call). */
  activityPosts?: number;
}

/** Attached as `cause` to errors raised from HTTP responses. */
export interface LinkedInHttpFailure {
  status: number;
  body: unknown;
}

interface Res<T> {
  status: number;
  headers: Headers;
  body: T;
}

interface LinkedInComment {
  id?: string;
  commentUrn?: string;
  actor?: string;
  object?: string;
  parentComment?: string;
  message?: { text?: string };
  created?: { time?: number };
}

interface LinkedInPost {
  id?: string;
  author?: string;
  commentary?: string;
  createdAt?: number;
  publishedAt?: number;
  lastModifiedAt?: number;
}

interface ShareStatistics {
  impressionCount?: number;
  uniqueImpressionsCount?: number;
  clickCount?: number;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  engagement?: number;
}

const enc = encodeURIComponent;

export function linkedInPostUrl(urn: string): string {
  return `https://www.linkedin.com/feed/update/${urn}/`;
}

/** urn:li:comment:(urn:li:activity:123,456) → { object: urn:li:activity:123, id: 456 } */
export function parseCommentUrn(urn: string): { object: string; id: string } | null {
  const m = /^urn:li:comment:\((urn:li:[A-Za-z]+:[^,()]+),([^)]+)\)$/.exec(urn);
  return m && m[1] && m[2] ? { object: m[1], id: m[2] } : null;
}

/**
 * Post commentary uses LinkedIn's "little" text format: these characters are markup and must be escaped, or the
 * post is truncated or rejected. `#` is left alone so hashtags keep working.
 * TODO(verify): whether plain `#tag` still renders as a hashtag in the 2026 versions, or needs {hashtag|\#|tag}.
 */
export function escapeLittleText(s: string): string {
  return s.replace(/[\\|{}@[\]()<>*_~]/g, (c) => `\\${c}`);
}

function errorDetail(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 200);
  if (!body || typeof body !== "object") return "";
  const b = body as { message?: unknown; serviceErrorCode?: unknown; code?: unknown; error?: unknown; error_description?: unknown };
  return [b.code, b.message, b.error, b.error_description, b.serviceErrorCode !== undefined ? `serviceErrorCode=${String(b.serviceErrorCode)}` : undefined]
    .filter((x): x is string => typeof x === "string")
    .join(": ");
}

/** HTTP status → ConnectorError. LinkedIn limits are per day and reset at midnight UTC; 429s carry no reset header. */
export function mapLinkedInError(status: number, headers: Headers, body: unknown, what: string): ConnectorError {
  const detail = errorDetail(body);
  const msg = `linkedin ${what}: HTTP ${status}${detail ? ` ${detail}` : ""}`;
  const cause: LinkedInHttpFailure = { status, body };
  if (status === 401) return new ConnectorError(`${msg} (token expired or revoked)`, "auth", false, cause);
  if (status === 403) return new ConnectorError(`${msg} (missing scope, or the member is not an administrator of this page)`, "auth", false, cause);
  if (status === 426) return new ConnectorError(`${msg} (LinkedIn-Version is no longer active; set LINKEDIN_API_VERSION to a current YYYYMM)`, "rejected", false, cause);
  if (status === 429) {
    const retryAfter = headers.get("retry-after");
    const next = new Date();
    next.setUTCHours(24, 0, 0, 0);
    const reset = retryAfter ? `retry after ${retryAfter}s` : `daily quota resets at ${next.toISOString()}`;
    return new ConnectorError(`${msg}; ${reset}`, "rate_limit", true, cause);
  }
  const { kind, retryable } = classifyHttpStatus(status);
  return new ConnectorError(msg, kind, retryable, cause);
}

function statusOf(err: unknown): number | undefined {
  const c = err instanceof ConnectorError ? (err.cause as Partial<LinkedInHttpFailure> | undefined) : undefined;
  return typeof c?.status === "number" ? c.status : undefined;
}

function authorOf(account: AccountRef): string {
  const urn = typeof account.config?.authorUrn === "string" ? account.config.authorUrn : account.externalId;
  if (!/^urn:li:(person|organization):/.test(urn)) throw new ConnectorError(`linkedin account ${account.handle}: no author URN (config.authorUrn)`, "auth", false);
  return urn;
}

const isOrg = (urn: string) => urn.startsWith("urn:li:organization:");

function parseAuth(account: AccountRef): LinkedInAuth {
  const p = LinkedInAuth.safeParse(account.auth ?? {});
  if (!p.success) throw new ConnectorError(`linkedin account ${account.handle}: auth blob needs accessToken and personUrn`, "auth", false, p.error);
  return p.data;
}

const POLL_DURATIONS: [number, string][] = [
  [1440, "ONE_DAY"],
  [4320, "THREE_DAYS"],
  [10080, "ONE_WEEK"],
  [20160, "TWO_WEEKS"],
];

export class LinkedInConnector implements Connector {
  readonly name = "linkedin";
  readonly networks: readonly Network[] = ["linkedin"];
  readonly connectMethod = "oauth" as const;
  media?: Connector["media"];

  readonly oauth: OAuth2Client;
  readonly apiVersion: string;
  private readonly clientSecret: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly activityPosts: number;
  private readonly published = new IdempotencyCache<PublishResult>();
  private readonly replies = new IdempotencyCache<PublishResult>();
  /** Media URNs already uploaded per idempotency key, so a retry after a processing timeout does not re-upload. */
  private readonly uploads = new Map<string, (string | undefined)[]>();

  constructor(opts: LinkedInConnectorOptions = {}) {
    this.clientSecret = opts.clientSecret;
    this.apiVersion = opts.apiVersion ?? LINKEDIN_DEFAULT_VERSION;
    this.baseUrl = (opts.baseUrl ?? "https://api.linkedin.com").replace(/\/+$/, "");
    const oauthBase = (opts.oauthBaseUrl ?? "https://www.linkedin.com/oauth/v2").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.maxPolls = opts.maxPolls ?? 30;
    this.activityPosts = opts.activityPosts ?? 10;
    this.oauth = new OAuth2Client(
      {
        name: "linkedin",
        authorizeUrl: `${oauthBase}/authorization`,
        tokenUrl: `${oauthBase}/accessToken`,
        scopes: opts.scopes ?? LINKEDIN_OAUTH_SCOPES,
        // Web apps are confidential clients; LinkedIn's PKCE flow is for native apps.
        pkce: false,
        clientAuth: "body",
        ...(opts.clientId ? { clientId: opts.clientId } : {}),
        ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
      },
      opts.fetch,
      this.now,
    );
  }

  get connectConfigured(): boolean {
    return this.oauth.configured;
  }

  capabilities(): ConnectorCapabilities {
    return {
      publish: true,
      fetchActivity: true,
      fetchMetrics: true,
      meteredReads: false,
      reply: true,
      moderate: true,
      accountMetrics: true,
      webhooks: true,
      video: true,
      kinds: ["post", "link", "carousel", "video", "poll"],
    };
  }

  // ---- connect ---------------------------------------------------------------------------

  oauthAuthorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    return this.oauth.authorizeUrl({ state: p.state, redirectUri: p.redirectUri });
  }

  async oauthConnect(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<ConnectedAccount[]> {
    const token = await this.oauth.exchange({ code: p.code, redirectUri: p.redirectUri });
    const me = await this.userinfo(token.accessToken);
    const auth = this.authFromToken(token, me.externalId);
    const accounts: ConnectedAccount[] = [
      { network: "linkedin", identity: me, auth, config: { authorUrn: me.externalId, kind: "member" } satisfies LinkedInAccountConfig },
    ];
    for (const org of await this.administeredOrganizations(auth)) {
      accounts.push({
        network: "linkedin",
        identity: org,
        auth,
        config: { authorUrn: org.externalId, kind: "organization", organizationId: org.externalId.split(":").pop() ?? "" } satisfies LinkedInAccountConfig,
      });
    }
    return accounts;
  }

  /** The member behind a token (OIDC userinfo). Organizations cannot be told apart from the blob alone. */
  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const token = typeof auth.accessToken === "string" ? auth.accessToken : null;
    if (!token) throw new ConnectorError("linkedin: accessToken is required", "auth", false);
    return this.userinfo(token);
  }

  /**
   * Programmatic refresh tokens exist only for apps LinkedIn enabled for them (approved Marketing/Community
   * Management partners). Without one, null tells core the member must sign in again before the 60 days run out.
   */
  async refreshAuth(account: AccountRef): Promise<AuthRefresh | null> {
    const auth = parseAuth(account);
    if (!auth.refreshToken) return null;
    if (auth.refreshExpiresAt && Date.parse(auth.refreshExpiresAt) <= this.now().getTime()) return null;
    const t = await this.oauth.refresh(auth.refreshToken);
    const next = this.authFromToken(t, auth.personUrn);
    // The refresh token's expiry counts from the original grant; keep it when the response omits it.
    if (!next.refreshExpiresAt && auth.refreshExpiresAt) next.refreshExpiresAt = auth.refreshExpiresAt;
    return { auth: next };
  }

  private authFromToken(t: OAuth2Token, personUrn: string): LinkedInAuth {
    return {
      accessToken: t.accessToken,
      ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
      ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
      ...(t.refreshExpiresAt ? { refreshExpiresAt: t.refreshExpiresAt } : {}),
      ...(t.scope ? { scope: t.scope } : {}),
      personUrn,
    };
  }

  private async userinfo(token: string): Promise<AccountIdentity> {
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(`${this.baseUrl}/v2/userinfo`, { headers: { authorization: `Bearer ${token}` } });
    } catch (err) {
      throw asNetworkError(err, "linkedin userinfo");
    }
    const body = (await readJson(res)) as { sub?: string; name?: string; email?: string; given_name?: string; family_name?: string } | undefined;
    if (!res.ok) throw mapLinkedInError(res.status, res.headers, body, "userinfo");
    if (!body?.sub) throw new ConnectorError("linkedin userinfo: response had no sub", "unknown", false, body);
    const name = body.name ?? ([body.given_name, body.family_name].filter(Boolean).join(" ") || null);
    // OIDC exposes no vanity name; the email (or name) is the most recognizable handle we have.
    return { externalId: `urn:li:person:${body.sub}`, handle: body.email ?? name ?? body.sub, displayName: name };
  }

  /** Organizations where the member is an approved ADMINISTRATOR. Empty when the app lacks the admin scopes. */
  private async administeredOrganizations(auth: LinkedInAuth): Promise<AccountIdentity[]> {
    const urns: string[] = [];
    try {
      for (let start = 0, page = 0; page < 5; page++) {
        const r = await this.call<{ elements?: { organization?: string; organizationTarget?: string }[]; paging?: { total?: number } }>(
          auth,
          "GET",
          `/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&start=${start}&count=100`,
          { what: "organizationAcls" },
        );
        const els = r.body.elements ?? [];
        for (const e of els) {
          const urn = e.organization ?? e.organizationTarget;
          if (urn && isOrg(urn) && !urns.includes(urn)) urns.push(urn);
        }
        start += els.length;
        if (els.length < 100 || (r.body.paging?.total !== undefined && start >= r.body.paging.total)) break;
      }
    } catch (err) {
      // Member-only apps (no Community Management approval) are refused here; the member account still connects.
      if (statusOf(err) === 403 || statusOf(err) === 401) return [];
      throw err;
    }
    const out: AccountIdentity[] = [];
    for (const urn of urns) {
      const id = urn.split(":").pop() ?? "";
      try {
        const r = await this.call<{ localizedName?: string; vanityName?: string }>(auth, "GET", `/rest/organizations/${enc(id)}`, { what: "organizations" });
        out.push({ externalId: urn, handle: r.body.vanityName ?? id, displayName: r.body.localizedName ?? null });
      } catch (err) {
        if (statusOf(err) !== 403 && statusOf(err) !== 404) throw err;
        out.push({ externalId: urn, handle: id, displayName: null });
      }
    }
    return out;
  }

  // ---- validate & publish ---------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const media = input.media;
    const images = media.filter((m) => m.kind === "image" || m.kind === "gif");
    const videos = media.filter((m) => m.kind === "video");
    const docs = media.filter((m) => m.kind === "document");
    const o = input.options ?? {};
    if (videos.length > 1) issues.push({ code: "too_many_media", message: "linkedin posts take one video" });
    if (docs.length > 1) issues.push({ code: "too_many_media", message: "linkedin posts take one document" });
    if ((videos.length > 0 || docs.length > 0) && media.length > 1) issues.push({ code: "unsupported_media", message: "linkedin cannot mix a video or document with other media in one post" });
    if (images.length > 20) issues.push({ code: "too_many_media", message: `${images.length} > 20 images in a linkedin multi-image post` });
    for (const v of videos) {
      if (v.durationSeconds !== undefined && (v.durationSeconds < 3 || v.durationSeconds > 1800)) issues.push({ code: "unsupported_media", message: `linkedin video must be 3 seconds to 30 minutes (got ${v.durationSeconds}s)` });
      // TODO(verify): maximum video file size for multi-part uploads (documented as 75 KB to 5 GB, MP4).
      if (v.bytes !== undefined && (v.bytes < 75 * 1024 || v.bytes > 5 * 1024 ** 3)) issues.push({ code: "unsupported_media", message: "linkedin video must be between 75 KB and 5 GB" });
    }
    for (const d of docs) {
      if (d.mime && !/^application\/(pdf|msword|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.(presentationml\.presentation|wordprocessingml\.document))$/.test(d.mime)) {
        issues.push({ code: "unsupported_media", message: `linkedin documents must be PDF, PPT(X) or DOC(X) (got ${d.mime})` });
      }
      // TODO(verify): document limits (100 MB, 300 pages per LinkedIn's help; the API reference may differ).
      if (d.bytes !== undefined && d.bytes > 100 * 1024 * 1024) issues.push({ code: "unsupported_media", message: "linkedin documents must be 100 MB or smaller" });
    }
    if (o.poll) {
      if (media.length > 0) issues.push({ code: "unsupported_media", message: "linkedin polls cannot carry media" });
      if (!o.title) issues.push({ code: "empty", message: "linkedin polls need a question: set options.title" });
      else if (o.title.length > 140) issues.push({ code: "too_long", message: "linkedin poll question is limited to 140 characters" });
      if (o.poll.options.length > 4) issues.push({ code: "too_many_media", message: "linkedin polls take 2 to 4 options" });
      if (o.poll.options.some((x) => x.length > 30)) issues.push({ code: "too_long", message: "linkedin poll options are limited to 30 characters" });
    }
    if (docs.length > 0 && o.title && o.title.length > 400) issues.push({ code: "too_long", message: "linkedin document title is too long" });
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.published.run(input.idempotencyKey, () => this.createPost(account, parseAuth(account), input));
  }

  private async createPost(account: AccountRef, auth: LinkedInAuth, input: PublishInput): Promise<PublishResult> {
    const author = authorOf(account);
    const o = input.options ?? {};
    const issues = this.validate(account, input);
    if (issues.length) throw new ConnectorError(`linkedin publish: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);

    const urns = await this.uploadAll(auth, author, input);
    let commentary = input.text;
    let content: Record<string, unknown> | undefined;
    const first = input.media[0];
    const kind = first?.kind;

    if (o.poll) {
      const minutes = o.poll.durationMinutes;
      const duration = (POLL_DURATIONS.find(([m]) => minutes <= m) ?? POLL_DURATIONS[POLL_DURATIONS.length - 1]!)[1];
      // TODO(verify): poll content schema { question, options[{text}], settings{duration} } in the current Posts API.
      content = { poll: { question: o.title ?? "", options: o.poll.options.map((text) => ({ text })), settings: { duration } } };
    } else if (!first) {
      if (o.link) content = { article: { source: o.link, ...(o.title ? { title: o.title } : {}) } };
    } else if (kind === "video") {
      content = { media: { id: urns[0], ...(o.title ? { title: o.title } : {}) } };
    } else if (kind === "document") {
      content = { media: { id: urns[0], title: o.title ?? "Document" } };
    } else if (input.media.length === 1 && o.link) {
      // A link with one image: an article card that uses the image as its thumbnail.
      content = { article: { source: o.link, thumbnail: urns[0], ...(o.title ? { title: o.title } : {}) } };
    } else if (input.media.length === 1) {
      content = { media: { id: urns[0], ...(first.alt ? { altText: first.alt } : {}) } };
    } else {
      content = { multiImage: { images: input.media.map((m, i) => ({ id: urns[i], ...(m.alt ? { altText: m.alt } : {}) })) } };
    }
    // A link that did not become an article card still belongs in the text, where LinkedIn links it.
    const linkInCard = !!content && "article" in content;
    if (o.link && !linkInCard && !commentary.includes(o.link)) commentary = commentary ? `${commentary}\n\n${o.link}` : o.link;

    const body: Record<string, unknown> = {
      author,
      commentary: escapeLittleText(commentary),
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
      ...(content ? { content } : {}),
    };
    const r = await this.call<{ id?: string }>(auth, "POST", "/rest/posts", { json: body, what: "create post" });
    const id = r.headers.get("x-restli-id") ?? r.headers.get("x-linkedin-id") ?? r.body?.id;
    if (!id) throw new ConnectorError("linkedin create post: response carried no post URN (x-restli-id)", "unknown", false, r.body);
    this.uploads.delete(input.idempotencyKey);
    return { externalId: id, url: linkedInPostUrl(id), raw: { id, media: urns } };
  }

  private async uploadAll(auth: LinkedInAuth, owner: string, input: PublishInput): Promise<string[]> {
    const done = this.uploads.get(input.idempotencyKey) ?? [];
    this.uploads.set(input.idempotencyKey, done);
    const out: string[] = [];
    for (let i = 0; i < input.media.length; i++) {
      const m = input.media[i]!;
      let urn = done[i];
      if (!urn) {
        urn = m.kind === "video" ? await this.uploadVideo(auth, owner, m, input.options?.thumbnailUrl) : m.kind === "document" ? await this.uploadSimple(auth, owner, m, "documents") : await this.uploadSimple(auth, owner, m, "images");
        done[i] = urn;
      }
      const resource = m.kind === "video" ? "videos" : m.kind === "document" ? "documents" : "images";
      await this.waitAvailable(auth, resource, urn);
      out.push(urn);
    }
    return out;
  }

  private async bytesOf(m: Media): Promise<{ bytes: Uint8Array; mime: string }> {
    return this.media ? this.media.fetch(m) : downloadMedia(resolveFetch(this.fetchImpl), m);
  }

  /** Images API / Documents API: initializeUpload, then one PUT of the bytes to the returned uploadUrl. */
  private async uploadSimple(auth: LinkedInAuth, owner: string, m: Media, resource: "images" | "documents"): Promise<string> {
    // Documents (up to 100 MB) are sent as a streamed body; images are read whole as before.
    const file = resource === "documents" ? await openMedia(mediaSource(this.media, this.fetchImpl), m) : null;
    try {
      const { bytes, mime } = file ? { bytes: null, mime: file.mime } : await this.bytesOf(m);
      const init = await this.call<{ value?: { uploadUrl?: string; image?: string; document?: string } }>(auth, "POST", `/rest/${resource}?action=initializeUpload`, {
        json: { initializeUploadRequest: { owner } },
        what: `${resource} initializeUpload`,
      });
      const v = init.body?.value;
      const urn = resource === "images" ? v?.image : v?.document;
      if (!v?.uploadUrl || !urn) throw new ConnectorError(`linkedin ${resource} initializeUpload: no uploadUrl/URN in response`, "unknown", false, init.body);
      await this.put(auth, v.uploadUrl, file ? rawBody(file) : bytes!, mime, `${resource} upload`);
      return urn;
    } finally {
      await file?.close();
    }
  }

  /** Videos API: initializeUpload → PUT each part (collect ETags) → finalizeUpload. Each part is read only for its own PUT. */
  private async uploadVideo(auth: LinkedInAuth, owner: string, m: Media, thumbnailUrl: string | undefined): Promise<string> {
    return withMedia(mediaSource(this.media, this.fetchImpl), m, async (file) => {
      const init = await this.call<{
        value?: { video?: string; uploadToken?: string; uploadInstructions?: { uploadUrl?: string; firstByte?: number; lastByte?: number }[]; thumbnailUploadUrl?: string };
      }>(auth, "POST", "/rest/videos?action=initializeUpload", {
        json: { initializeUploadRequest: { owner, fileSizeBytes: file.size, uploadCaptions: false, uploadThumbnail: !!thumbnailUrl } },
        what: "videos initializeUpload",
      });
      const v = init.body?.value;
      if (!v?.video || !v.uploadInstructions?.length) throw new ConnectorError("linkedin videos initializeUpload: no video URN or upload instructions", "unknown", false, init.body);
      const etags: string[] = [];
      for (const part of v.uploadInstructions) {
        if (!part.uploadUrl) throw new ConnectorError("linkedin videos: upload instruction without uploadUrl", "unknown", false, part);
        const from = part.firstByte ?? 0;
        const to = Math.min(file.size, (part.lastByte ?? file.size - 1) + 1);
        const res = await this.put(auth, part.uploadUrl, await file.read(from, to - from), "application/octet-stream", "video part upload");
        const etag = res.headers.get("etag");
        if (!etag) throw new ConnectorError("linkedin video part upload: response had no ETag", "unknown", true);
        etags.push(etag);
      }
      if (thumbnailUrl && v.thumbnailUploadUrl) {
        const thumb = await downloadMedia(resolveFetch(this.fetchImpl), { kind: "image", url: thumbnailUrl });
        await this.put(auth, v.thumbnailUploadUrl, thumb.bytes, thumb.mime, "video thumbnail upload");
      }
      await this.call(auth, "POST", "/rest/videos?action=finalizeUpload", {
        json: { finalizeUploadRequest: { video: v.video, uploadToken: v.uploadToken ?? "", uploadedPartIds: etags } },
        what: "videos finalizeUpload",
      });
      return v.video;
    });
  }

  /** Poll an uploaded asset until AVAILABLE; failure is final, a timeout is retryable (the upload is remembered). */
  private async waitAvailable(auth: LinkedInAuth, resource: "images" | "videos" | "documents", urn: string): Promise<void> {
    for (let i = 0; i < this.maxPolls; i++) {
      const r = await this.call<{ status?: string; processingFailureReason?: string }>(auth, "GET", `/rest/${resource}/${enc(urn)}`, { what: `${resource} status` });
      const status = r.body?.status;
      if (status === "AVAILABLE") return;
      if (status === "PROCESSING_FAILED" || status === "FAILED") {
        throw new ConnectorError(`linkedin ${resource} ${urn} failed processing${r.body?.processingFailureReason ? `: ${r.body.processingFailureReason}` : ""}`, "rejected", false, r.body);
      }
      if (status === undefined) return; // no status field: nothing to wait for
      await this.sleep(this.pollIntervalMs);
    }
    throw new ConnectorError(`linkedin ${resource} ${urn} is still processing; retry later`, "unknown", true);
  }

  // ---- reply & moderate -----------------------------------------------------------------

  /** Comment on a post, or reply to a comment (nested comment). Also how core posts the first comment. */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.replies.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const actor = authorOf(account);
      const parent = parseCommentUrn(input.parentExternalId);
      const object = parent ? parent.object : input.parentExternalId;
      const body: Record<string, unknown> = { actor, object, message: { text: input.text }, ...(parent ? { parentComment: input.parentExternalId } : {}) };
      const r = await this.call<LinkedInComment>(auth, "POST", `/rest/socialActions/${enc(input.parentExternalId)}/comments`, { json: body, what: "create comment" });
      const rawId = r.body?.commentUrn ?? r.headers.get("x-restli-id") ?? r.body?.id;
      if (!rawId) throw new ConnectorError("linkedin create comment: no comment id in response", "unknown", false, r.body);
      const urn = rawId.startsWith("urn:li:comment:") ? rawId : `urn:li:comment:(${object},${rawId})`;
      return { externalId: urn, url: `${linkedInPostUrl(object)}?commentUrn=${enc(urn)}`, raw: r.body };
    });
  }

  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    const auth = parseAuth(account);
    const actor = authorOf(account);
    const id = input.externalId;
    switch (input.action) {
      case "like":
        // TODO(verify): the Reactions API accepts a comment URN as `root` (documented for shares and ugcPosts).
        await this.call(auth, "POST", `/rest/reactions?actor=${enc(actor)}`, { json: { root: id, reactionType: "LIKE" }, what: "like" });
        return;
      case "unlike":
        await this.call(auth, "DELETE", `/rest/reactions/(actor:${enc(actor)},entity:${enc(id)})`, { what: "unlike", restliMethod: "DELETE" });
        return;
      case "delete": {
        const c = parseCommentUrn(id);
        if (c) await this.call(auth, "DELETE", `/rest/socialActions/${enc(c.object)}/comments/${enc(c.id)}?actor=${enc(actor)}`, { what: "delete comment", restliMethod: "DELETE" });
        else await this.call(auth, "DELETE", `/rest/posts/${enc(id)}`, { what: "delete post", restliMethod: "DELETE" });
        return;
      }
      default:
        throw new ConnectorError(`linkedin: the API cannot ${input.action} comments (only delete and like/unlike)`, "rejected", false);
    }
  }

  // ---- inbox ----------------------------------------------------------------------------

  /**
   * Organizations: recent own posts plus the top-level comments on them. Members: nothing, because reading a
   * member's posts and comments needs r_member_social, which LinkedIn does not grant to new apps.
   */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const author = authorOf(account);
    if (!isOrg(author)) return [];
    const auth = parseAuth(account);
    const r = await this.call<{ elements?: LinkedInPost[] }>(auth, "GET", `/rest/posts?author=${enc(author)}&q=author&count=${Math.max(this.activityPosts, 10)}&sortBy=LAST_MODIFIED`, {
      what: "list posts",
      restliMethod: "FINDER",
    });
    const out: ActivityInput[] = [];
    const posts = (r.body.elements ?? []).filter((p): p is LinkedInPost & { id: string } => typeof p.id === "string");
    for (const p of posts) {
      const at = new Date(p.publishedAt ?? p.createdAt ?? p.lastModifiedAt ?? this.now().getTime()).toISOString();
      if (isAfter(at, since)) {
        out.push({ network: "linkedin", kind: "own_post", externalId: p.id, authorHandle: account.handle, authorName: null, text: p.commentary ?? null, url: linkedInPostUrl(p.id), parentExternalId: null, occurredAt: at, raw: p });
      }
    }
    // TODO(verify): nested replies are only listed via socialActions/{commentUrn}/comments; webhooks deliver them instead.
    for (const p of posts.slice(0, this.activityPosts)) {
      const c = await this.call<{ elements?: LinkedInComment[] }>(auth, "GET", `/rest/socialActions/${enc(p.id)}/comments?count=50`, { what: "list comments" });
      for (const cm of c.body.elements ?? []) {
        if (cm.actor === author) continue;
        const item = commentToActivity(cm, p.id, this.now());
        if (item && isAfter(item.occurredAt, since)) out.push(item);
      }
    }
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  // ---- metrics --------------------------------------------------------------------------

  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    if (externalIds.length === 0) return [];
    const auth = parseAuth(account);
    const author = authorOf(account);
    const observedAt = this.now().toISOString();
    return isOrg(author) ? this.orgPostMetrics(auth, author, externalIds, observedAt) : this.memberPostMetrics(auth, externalIds, observedAt);
  }

  /** organizationalEntityShareStatistics for specific shares/ugcPosts (lifetime totals). */
  private async orgPostMetrics(auth: LinkedInAuth, org: string, ids: string[], observedAt: string): Promise<MetricInput[]> {
    const out: MetricInput[] = [];
    // TODO(verify): maximum number of shares/ugcPosts per call; 20 keeps URLs short.
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      const shares = chunk.filter((x) => x.startsWith("urn:li:share:"));
      const ugc = chunk.filter((x) => x.startsWith("urn:li:ugcPost:"));
      let q = `/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${enc(org)}`;
      if (shares.length) q += `&shares=List(${shares.map(enc).join(",")})`;
      if (ugc.length) q += `&ugcPosts=List(${ugc.map(enc).join(",")})`;
      if (!shares.length && !ugc.length) continue;
      const r = await this.call<{ elements?: ({ share?: string; ugcPost?: string; totalShareStatistics?: ShareStatistics })[] }>(auth, "GET", q, { what: "share statistics" });
      for (const el of r.body.elements ?? []) {
        const id = el.share ?? el.ugcPost;
        if (!id || !el.totalShareStatistics) continue;
        out.push(...shareStatsToMetrics(id, el.totalShareStatistics, observedAt));
      }
    }
    return out;
  }

  /**
   * memberCreatorPostAnalytics (r_member_postAnalytics, Community Management). Without that permission LinkedIn
   * answers 403 and the member's posts simply have no metrics.
   */
  private async memberPostMetrics(auth: LinkedInAuth, ids: string[], observedAt: string): Promise<MetricInput[]> {
    const types: [string, MetricName][] = [
      ["IMPRESSION", "impressions"],
      ["MEMBERS_REACHED", "reach"],
      ["REACTION", "likes"],
      ["COMMENT", "replies"],
      ["RESHARE", "reposts"],
    ];
    const out: MetricInput[] = [];
    for (const id of ids) {
      const key = id.startsWith("urn:li:ugcPost:") ? "ugc" : "share";
      let engagements = 0;
      let any = false;
      for (const [queryType, metric] of types) {
        let r: Res<{ elements?: { count?: number }[] }>;
        try {
          // TODO(verify): entity union syntax and the `count` field of memberCreatorPostAnalytics elements.
          r = await this.call(auth, "GET", `/rest/memberCreatorPostAnalytics?q=entity&entity=(${key}:${enc(id)})&queryType=${queryType}&aggregation=TOTAL`, { what: "member post analytics" });
        } catch (err) {
          if (statusOf(err) === 403) return out; // permission not granted: stop asking
          throw err;
        }
        const value = r.body.elements?.reduce((s, e) => s + (typeof e.count === "number" ? e.count : 0), 0);
        if (typeof value === "number" && r.body.elements?.length) {
          any = true;
          out.push({ entityType: "post_variant", entityId: id, metric, value, observedAt, source: "linkedin" });
          if (metric === "likes" || metric === "replies" || metric === "reposts") engagements += value;
        }
      }
      if (any) out.push({ entityType: "post_variant", entityId: id, metric: "engagements", value: engagements, observedAt, source: "linkedin" });
    }
    return out;
  }

  /** followers_total: networkSizes for pages, memberFollowersCount for members (needs member analytics consent). */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const author = authorOf(account);
    const observedAt = this.now().toISOString();
    const row = (metric: MetricName, value: number): MetricInput => ({ entityType: "social_account", entityId: account.id, metric, value, observedAt, source: "linkedin" });
    if (isOrg(author)) {
      // TODO(verify): edgeType spelling in the versioned API (COMPANY_FOLLOWED_BY_MEMBER vs legacy CompanyFollowedByMember).
      const r = await this.call<{ firstDegreeSize?: number }>(auth, "GET", `/rest/networkSizes/${enc(author)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`, { what: "networkSizes" });
      return typeof r.body.firstDegreeSize === "number" ? [row("followers_total", r.body.firstDegreeSize)] : [];
    }
    try {
      // TODO(verify): required permission for memberFollowersCount (reported as r_member_profileAnalytics).
      const r = await this.call<{ elements?: { memberFollowersCount?: number }[] }>(auth, "GET", "/rest/memberFollowersCount?q=me", { what: "memberFollowersCount" });
      const n = r.body.elements?.[0]?.memberFollowersCount;
      return typeof n === "number" ? [row("followers_total", n)] : [];
    } catch (err) {
      if (statusOf(err) === 403) return [];
      throw err;
    }
  }

  // ---- webhooks -------------------------------------------------------------------------

  /**
   * Organization social action notifications (Community Management partners subscribe via eventSubscriptions).
   * Handshake: GET ?challengeCode=… answered with {challengeCode, challengeResponse = hex HMAC-SHA256(code, secret)}.
   * Deliveries: X-LI-Signature = hex HMAC-SHA256("hmacsha256=" + rawBody, secret).
   */
  readonly webhook: WebhookHandler = {
    challenge: (query) => {
      const code = query.challengeCode;
      if (!code || !this.clientSecret) return null;
      // TODO(verify): LinkedIn accepts the JSON answer when core serves it as text/plain.
      const challengeResponse = createHmac("sha256", this.clientSecret).update(code).digest("hex");
      return JSON.stringify({ challengeCode: code, challengeResponse });
    },
    verify: (headers, rawBody) => {
      if (!this.clientSecret) return false;
      const header = headers["x-li-signature"] ?? headers["X-LI-Signature"];
      if (!header) return false;
      const got = header.replace(/^hmacsha256=/i, "").trim().toLowerCase();
      // TODO(verify): Microsoft documents the "hmacsha256=" prefix inside the signed string; some guides sign the bare body.
      const candidates = [`hmacsha256=${rawBody}`, rawBody].map((s) => createHmac("sha256", this.clientSecret!).update(s).digest("hex"));
      let ok = false;
      for (const c of candidates) ok = safeEqualHex(got, c) || ok;
      return ok;
    },
    parse: (body) => parseLinkedInWebhook(body),
  };

  // ---- transport ------------------------------------------------------------------------

  private async call<T = unknown>(auth: LinkedInAuth, method: string, path: string, opts: { json?: unknown; what: string; restliMethod?: string }): Promise<Res<T>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${auth.accessToken}`,
      "linkedin-version": this.apiVersion,
      "x-restli-protocol-version": "2.0.0",
    };
    if (opts.restliMethod) headers["x-restli-method"] = opts.restliMethod;
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(`${this.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch (err) {
      throw asNetworkError(err, `linkedin ${opts.what}`);
    }
    const data = await readJson(res);
    if (!res.ok) throw mapLinkedInError(res.status, res.headers, data, opts.what);
    return { status: res.status, headers: res.headers, body: (data ?? {}) as T };
  }

  /** Upload URLs are LinkedIn-hosted and take the same bearer token. */
  private async put(auth: LinkedInAuth, url: string, bytes: Uint8Array | StreamBody, mime: string, what: string): Promise<Response> {
    let res: Response;
    try {
      const headers = { authorization: `Bearer ${auth.accessToken}`, "content-type": mime };
      res =
        bytes instanceof Uint8Array
          ? await resolveFetch(this.fetchImpl)(url, { method: "PUT", headers, body: new Blob([bytes], { type: mime }) })
          : await sendStream(resolveFetch(this.fetchImpl), url, { method: "PUT", headers }, bytes);
    } catch (err) {
      throw asNetworkError(err, `linkedin ${what}`);
    }
    if (!res.ok) throw mapLinkedInError(res.status, res.headers, await readJson(res), what);
    return res;
  }
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(bb, bb); // keep the timing similar on length mismatch
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function commentToActivity(c: LinkedInComment, postUrn: string, now: Date): ActivityInput | null {
  const object = c.object ?? postUrn;
  const urn = c.commentUrn ?? (c.id ? `urn:li:comment:(${object},${c.id})` : null);
  if (!urn) return null;
  return {
    network: "linkedin",
    kind: c.parentComment ? "reply" : "comment",
    externalId: urn,
    // Member names need profile scopes LinkedIn does not grant; the person URN identifies the author.
    authorHandle: c.actor ?? null,
    authorName: null,
    text: c.message?.text ?? null,
    url: `${linkedInPostUrl(postUrn)}?commentUrn=${enc(urn)}`,
    parentExternalId: c.parentComment ?? postUrn,
    occurredAt: new Date(c.created?.time ?? now.getTime()).toISOString(),
    raw: c,
  };
}

function shareStatsToMetrics(id: string, s: ShareStatistics, observedAt: string): MetricInput[] {
  const row = (metric: MetricName, value: number | undefined): MetricInput[] => (typeof value === "number" ? [{ entityType: "post_variant", entityId: id, metric, value, observedAt, source: "linkedin" }] : []);
  return [
    ...row("impressions", s.impressionCount),
    ...row("reach", s.uniqueImpressionsCount),
    ...row("likes", s.likeCount),
    ...row("replies", s.commentCount),
    ...row("reposts", s.shareCount),
    ...row("clicks", s.clickCount),
    // LinkedIn's `engagement` is a rate: (clicks + likes + comments + shares + follows) / impressions.
    ...row("engagement_rate", s.engagement),
    ...row("engagements", (s.likeCount ?? 0) + (s.commentCount ?? 0) + (s.shareCount ?? 0) + (s.clickCount ?? 0)),
  ];
}

interface LinkedInNotification {
  action?: string;
  organizationalEntity?: string;
  sourcePost?: string;
  generatedActivity?: string;
  actor?: string;
  lastModifiedAt?: number;
  notificationId?: number | string;
  decoratedGeneratedActivity?: { comment?: { text?: string; entity?: string }; mention?: { text?: string }; share?: { text?: string } };
  decoratedSourcePost?: { text?: string };
}

const NOTIFICATION_KINDS: Record<string, ActivityKind> = {
  COMMENT: "comment",
  ADMIN_COMMENT: "comment",
  SHARE_MENTION: "mention",
  COMMENT_MENTION: "mention",
  LIKE: "like",
  SHARE: "repost",
};

/**
 * ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS deliveries → batches per organization.
 * TODO(verify): notification field names (action, organizationalEntity, sourcePost, generatedActivity, actor,
 * decoratedGeneratedActivity) against a real delivery.
 */
export function parseLinkedInWebhook(body: unknown): WebhookBatch[] {
  const b = (body ?? {}) as { notifications?: LinkedInNotification[] };
  const byOrg = new Map<string, ActivityInput[]>();
  for (const n of Array.isArray(b.notifications) ? b.notifications : []) {
    const kind = n.action ? NOTIFICATION_KINDS[n.action] : undefined;
    if (!kind || !n.organizationalEntity) continue;
    const externalId = n.generatedActivity ?? (n.notificationId !== undefined ? `notification:${n.notificationId}` : null);
    if (!externalId) continue;
    const d = n.decoratedGeneratedActivity;
    const comment = parseCommentUrn(externalId);
    const item: ActivityInput = {
      network: "linkedin",
      kind,
      externalId,
      authorHandle: n.actor ?? null,
      authorName: null,
      text: d?.comment?.text ?? d?.mention?.text ?? d?.share?.text ?? null,
      url: n.sourcePost ? (comment ? `${linkedInPostUrl(n.sourcePost)}?commentUrn=${enc(externalId)}` : linkedInPostUrl(n.sourcePost)) : null,
      parentExternalId: n.sourcePost ?? null,
      occurredAt: new Date(n.lastModifiedAt ?? Date.now()).toISOString(),
      raw: n,
    };
    const list = byOrg.get(n.organizationalEntity) ?? [];
    list.push(item);
    byOrg.set(n.organizationalEntity, list);
  }
  return [...byOrg].map(([accountExternalId, items]) => ({ network: "linkedin" as const, accountExternalId, items }));
}

/** Registry entry for LinkedIn. LINKEDIN_API_VERSION defaults to a supported YYYYMM; LINKEDIN_SCOPES overrides scopes. */
export function createLinkedInConnectors(env: NodeJS.ProcessEnv): Connector[] {
  const { clientId, clientSecret } = clientFromEnv(env, "LINKEDIN");
  const version = env.LINKEDIN_API_VERSION && /^\d{6}$/.test(env.LINKEDIN_API_VERSION) ? env.LINKEDIN_API_VERSION : LINKEDIN_DEFAULT_VERSION;
  const scopes = env.LINKEDIN_SCOPES ? env.LINKEDIN_SCOPES.split(/[\s,]+/).filter(Boolean) : undefined;
  return [
    new LinkedInConnector({
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      apiVersion: version,
      ...(scopes ? { scopes } : {}),
      ...(env.LINKEDIN_API_BASE_URL ? { baseUrl: env.LINKEDIN_API_BASE_URL } : {}),
    }),
  ];
}
