import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActivityInput, ActivityKind, Media, MetricInput, MetricName, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, isAfter, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource, sendBody, withMedia, type StreamBody } from "./media-io.ts";
import { OAuth2Client, clientFromEnv } from "./oauth.ts";
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
 * Meta (Facebook Pages + Instagram professional accounts) over the Graph API, connected with Facebook Login for Business.
 *
 * One login yields every Page the person can act for and every Instagram professional account linked to those Pages.
 * Each account's auth blob carries the Page access token (Page tokens derived from a long-lived user token do not
 * expire) plus the long-lived user token it came from, so refreshAuth can mint a new Page token when Meta invalidates one.
 * Instagram calls use the linked Page's token on graph.facebook.com (the "Instagram API with Facebook Login" path).
 */

/** Graph API version used when META_GRAPH_VERSION is unset. v26.0 was released 2026-07-29 (expiry TBD) per Meta's version list. */
export const META_DEFAULT_GRAPH_VERSION = "v26.0";

/**
 * Permissions requested at login. Names confirmed against Meta's Facebook Login for Business and Instagram Platform docs
 * (Nov 2026). business_management lets Pages owned through a Business portfolio show up in /me/accounts.
 */
export const META_SCOPES = [
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
  "pages_manage_engagement",
  "pages_read_user_content",
  "pages_manage_metadata", // needed to subscribe a Page to webhooks (POST /{page-id}/subscribed_apps)
  "read_insights",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "instagram_manage_insights",
  "business_management",
];

export const MetaAuth = z.object({
  /** Page access token: acts as the Page, and for the linked Instagram account. */
  pageAccessToken: z.string().min(1),
  pageId: z.string().min(1),
  /** Present on Instagram accounts. */
  igUserId: z.string().min(1).optional(),
  /** Long-lived user token the Page token was derived from; lets refreshAuth re-derive the Page token. */
  userAccessToken: z.string().min(1).optional(),
  userId: z.string().optional(),
  /** ISO time the long-lived user token expires (about 60 days). Deliberately not `expiresAt`: Page tokens do not expire. */
  userTokenExpiresAt: z.string().optional(),
});
export type MetaAuth = z.infer<typeof MetaAuth>;

export interface MetaConnectorOptions {
  clientId?: string;
  clientSecret?: string;
  webhookVerifyToken?: string;
  graphVersion?: string;
  /** Facebook Login for Business configuration id; when set it is sent as config_id. */
  loginConfigId?: string;
  graphBaseUrl?: string;
  ruploadBaseUrl?: string;
  dialogBaseUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Delay between container/video status polls (default 3000 ms). */
  pollIntervalMs?: number;
  /** Status polls before giving up with a retryable error (default 20, so about a minute). */
  maxPolls?: number;
  /** Recent posts walked per account when reading comments (default 25). */
  maxActivityPosts?: number;
  /** Facebook videos larger than this go through the Resumable Upload API instead of file_url (default 1 GiB). */
  resumableThresholdBytes?: number;
}

// ---- shared Graph helpers (also used by threads.ts) ------------------------------------------

export interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_user_msg?: string; error_user_title?: string; is_transient?: boolean; fbtrace_id?: string };
}

/** Attached as `cause` on ConnectorErrors raised from Graph responses. */
export interface GraphFailure {
  status: number;
  code?: number;
  subcode?: number;
  body: unknown;
}

/** Graph throttling codes: app (4), user (17), Pages (32), custom (613), business use case (80001-80014). */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);
/** Instagram "max publishing limit reached" (code 9 / subcode 2207042). TODO(verify): subcode against the current IG error table. */
const IG_PUBLISH_LIMIT_SUBCODE = 2207042;

/** Seconds until Meta says access is regained, from X-Business-Use-Case-Usage (minutes) when present. */
function regainSeconds(headers: Headers): number | undefined {
  const raw = headers.get("x-business-use-case-usage");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, { estimated_time_to_regain_access?: number }[]>;
    let max = 0;
    for (const list of Object.values(parsed)) for (const u of list ?? []) max = Math.max(max, Number(u.estimated_time_to_regain_access ?? 0));
    return max > 0 ? max * 60 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Graph error → ConnectorError. Meta reports most failures as HTTP 400 with an error code, so the code decides:
 * throttling codes → rate_limit, OAuth/permission codes → auth, transient/service codes and 5xx → network.
 */
export function mapGraphError(service: string, what: string, status: number, headers: Headers, body: unknown): ConnectorError {
  const e = (body && typeof body === "object" ? (body as GraphErrorBody).error : undefined) ?? {};
  const code = typeof e.code === "number" ? e.code : undefined;
  const subcode = typeof e.error_subcode === "number" ? e.error_subcode : undefined;
  const detail = [e.message, e.error_user_msg].filter((x): x is string => typeof x === "string" && x.length > 0).join(" — ") || (typeof body === "string" ? body.slice(0, 200) : "");
  const tag = code !== undefined ? ` (code ${code}${subcode !== undefined ? `/${subcode}` : ""})` : "";
  const msg = `${service} ${what}: HTTP ${status}${detail ? ` ${detail}` : ""}${tag}`;
  const cause: GraphFailure = { status, ...(code !== undefined ? { code } : {}), ...(subcode !== undefined ? { subcode } : {}), body };
  if (status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code)) || (code === 9 && subcode === IG_PUBLISH_LIMIT_SUBCODE)) {
    const wait = regainSeconds(headers);
    return new ConnectorError(`${msg}; rate limited${wait ? `, retry after ~${wait}s` : ""}`, "rate_limit", true, cause);
  }
  if (code === 190 || code === 102 || code === 10 || (code !== undefined && code >= 200 && code < 300) || status === 401) {
    return new ConnectorError(`${msg} (token or permission rejected)`, "auth", false, cause);
  }
  if (e.is_transient === true || code === 1 || code === 2 || status >= 500) return new ConnectorError(msg, "network", true, cause);
  const { kind, retryable } = classifyHttpStatus(status);
  return new ConnectorError(msg, kind === "unknown" ? "rejected" : kind, retryable, cause);
}

export function graphCode(err: unknown): number | undefined {
  const cause = err instanceof ConnectorError ? (err.cause as Partial<GraphFailure> | undefined) : undefined;
  return typeof cause?.code === "number" ? cause.code : undefined;
}

/** Meta's webhook subscription handshake: echo hub.challenge when the verify token matches. */
export function hubChallenge(query: Record<string, string>, verifyToken: string | undefined): string | null {
  if (!verifyToken) return null;
  if (query["hub.mode"] !== "subscribe") return null;
  const given = query["hub.verify_token"] ?? "";
  if (!safeEqual(given, verifyToken)) return null;
  return query["hub.challenge"] ?? null;
}

/** X-Hub-Signature-256 = "sha256=" + hex HMAC-SHA256(app secret, raw body). Constant-time compare. */
export function verifyHubSignature(secret: string | undefined, headers: Record<string, string>, rawBody: string): boolean {
  if (!secret) return false;
  const sig = headers["x-hub-signature-256"] ?? headers["X-Hub-Signature-256"] ?? "";
  const want = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  return safeEqual(sig, want);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Graph timestamps come as "2026-11-02T10:00:00+0000" or unix seconds; normalize to ISO with offset. */
export function graphTime(v: unknown, fallback: Date): string {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) return graphTime(Number(v), fallback);
    const t = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return fallback.toISOString();
}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One insights row as Graph returns it (Pages, Instagram and Threads share the shape). */
export interface InsightRow {
  name: string;
  period?: string;
  values?: { value?: unknown; end_time?: string }[];
  total_value?: { value?: unknown };
}

/** Latest value of an insights row: total_value when present, else the last period value. */
export function insightValue(row: InsightRow): number | Record<string, number> | undefined {
  const v = row.total_value?.value ?? row.values?.[row.values.length - 1]?.value;
  if (typeof v === "number") return v;
  if (v && typeof v === "object") return v as Record<string, number>;
  return undefined;
}

// ---- connector -------------------------------------------------------------------------------

interface GraphPage {
  id: string;
  name?: string;
  username?: string;
  access_token?: string;
  tasks?: string[];
  instagram_business_account?: { id: string; username?: string; name?: string };
}

interface Paged<T> {
  data?: T[];
  paging?: { next?: string; cursors?: { after?: string } };
}

interface FbComment {
  id: string;
  message?: string;
  from?: { id?: string; name?: string };
  created_time?: string;
  parent?: { id?: string };
  permalink_url?: string;
}

interface FbPost {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  from?: { id?: string; name?: string };
  comments?: Paged<FbComment>;
}

interface IgComment {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
  from?: { id?: string; username?: string };
  parent_id?: string;
  replies?: Paged<IgComment>;
}

interface IgMedia {
  id: string;
  caption?: string;
  timestamp?: string;
  permalink?: string;
  username?: string;
  media_type?: string;
  media_product_type?: string;
  like_count?: number;
  comments_count?: number;
  comments?: Paged<IgComment>;
}

/** Instagram publish progress for one idempotency key, so a retry resumes instead of creating a second post. */
interface IgProgress {
  children?: string[];
  creationId?: string;
  mediaId?: string;
}

interface FbProgress {
  postId?: string;
  url?: string | null;
  raw?: unknown;
}

/** Per-post-type Instagram insight metrics (Nov 2026). `impressions`, `plays` and `video_views` were removed in 2025 in favor of `views`. */
const IG_METRICS: Record<string, string[]> = {
  FEED: ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions", "profile_visits", "follows"],
  // TODO(verify): ig_reels_video_view_total_time / ig_reels_avg_watch_time names; only third-party sources list them.
  REELS: ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions", "ig_reels_video_view_total_time"],
  STORY: ["views", "reach", "replies", "shares", "total_interactions", "follows", "profile_visits"],
};

/**
 * Facebook post metrics after the Nov 2025 / June 2026 deprecations: post_impressions → post_media_view,
 * post_impressions_unique → post_total_media_view_unique. TODO(verify): post_video_views and post_video_view_time
 * survived the "video impressions" deprecation in v26.0.
 */
const FB_POST_METRICS = ["post_media_view", "post_total_media_view_unique", "post_clicks", "post_clicks_by_type", "post_video_views", "post_video_view_time"];
const FB_PAGE_METRICS = ["page_media_view", "page_total_media_view_unique", "page_post_engagements"];
const IG_ACCOUNT_METRICS = ["reach", "views", "total_interactions", "profile_links_taps"];

export class MetaConnector implements Connector {
  readonly name = "meta";
  readonly networks: readonly Network[] = ["facebook", "instagram"];
  readonly connectMethod = "oauth" as const;
  media?: Connector["media"];

  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly verifyToken: string | undefined;
  readonly version: string;
  private readonly loginConfigId: string | undefined;
  private readonly graphBase: string;
  private readonly ruploadBase: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly maxActivityPosts: number;
  private readonly resumableThreshold: number;
  private readonly oauth: OAuth2Client;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  private readonly igProgress = new Map<string, IgProgress>();
  private readonly fbProgress = new Map<string, FbProgress>();
  /** Instagram media ids this process published, so replies to them (first comments) go straight to /comments. */
  private readonly igMedia = new Set<string>();
  /** Metric names Graph refused (code 100) for a given object kind; not requested again in this process. */
  private readonly invalidMetrics = new Set<string>();

  constructor(opts: MetaConnectorOptions = {}) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.verifyToken = opts.webhookVerifyToken;
    this.version = (opts.graphVersion ?? META_DEFAULT_GRAPH_VERSION).replace(/^(?!v)/, "v");
    this.loginConfigId = opts.loginConfigId;
    this.graphBase = (opts.graphBaseUrl ?? "https://graph.facebook.com").replace(/\/+$/, "");
    this.ruploadBase = (opts.ruploadBaseUrl ?? "https://rupload.facebook.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? defaultSleep;
    this.pollIntervalMs = opts.pollIntervalMs ?? 3000;
    this.maxPolls = opts.maxPolls ?? 20;
    this.maxActivityPosts = opts.maxActivityPosts ?? 25;
    this.resumableThreshold = opts.resumableThresholdBytes ?? 1024 ** 3;
    const dialog = (opts.dialogBaseUrl ?? "https://www.facebook.com").replace(/\/+$/, "");
    this.oauth = new OAuth2Client(
      {
        name: "meta",
        authorizeUrl: `${dialog}/${this.version}/dialog/oauth`,
        tokenUrl: `${this.graphBase}/${this.version}/oauth/access_token`,
        scopes: META_SCOPES,
        scopeSeparator: ",",
        pkce: false,
        clientAuth: "body",
        // TODO(verify): with a Login for Business configuration Meta takes permissions from config_id and ignores scope.
        ...(this.loginConfigId ? { extraAuthorizeParams: { config_id: this.loginConfigId } } : {}),
        ...(this.clientId ? { clientId: this.clientId } : {}),
        ...(this.clientSecret ? { clientSecret: this.clientSecret } : {}),
      },
      (i, init) => resolveFetch(this.fetchImpl)(i, init),
      this.now,
    );
  }

  get connectConfigured(): boolean {
    return !!this.clientId && !!this.clientSecret;
  }

  capabilities(network: Network): ConnectorCapabilities {
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
      kinds: network === "instagram" ? ["post", "carousel", "reel", "story", "video"] : ["post", "link", "video", "reel", "story"],
    };
  }

  // ---- connect -------------------------------------------------------------------------------

  oauthAuthorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    return this.oauth.authorizeUrl({ state: p.state, redirectUri: p.redirectUri });
  }

  /** Code → short-lived user token → long-lived user token → every Page (with its token) and linked Instagram account. */
  async oauthConnect(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<ConnectedAccount[]> {
    this.requireApp("oauth");
    const short = await this.oauth.exchange({ code: p.code, redirectUri: p.redirectUri });
    const long = await this.exchangeLongLived(short.accessToken);
    const me = await this.graph<{ id: string; name?: string }>("GET", "/me", long.token, { query: { fields: "id,name" }, what: "me" });
    const pages = await this.listPages(long.token);
    const out: ConnectedAccount[] = [];
    for (const page of pages) {
      if (!page.access_token) continue; // the person has no task on this Page that yields a token
      const base: MetaAuth = {
        pageAccessToken: page.access_token,
        pageId: page.id,
        userAccessToken: long.token,
        userId: me.id,
        ...(long.expiresAt ? { userTokenExpiresAt: long.expiresAt } : {}),
      };
      const ig = page.instagram_business_account;
      const webhooksSubscribed = await this.subscribePage(page.id, page.access_token);
      out.push({
        network: "facebook",
        identity: { externalId: page.id, handle: page.username ?? page.id, displayName: page.name ?? null },
        auth: { ...base },
        config: { pageId: page.id, ...(ig ? { igUserId: ig.id } : {}), tasks: page.tasks ?? [], webhooksSubscribed },
      });
      if (ig) {
        out.push({
          network: "instagram",
          identity: { externalId: ig.id, handle: ig.username ?? ig.id, displayName: ig.name ?? null },
          auth: { ...base, igUserId: ig.id },
          config: { pageId: page.id },
        });
      }
    }
    if (out.length === 0) throw new ConnectorError("meta oauth: the login granted no Pages; pick at least one Page (and its Instagram account) in the Facebook dialog", "auth", false);
    return out;
  }

  /**
   * Page webhooks (feed, mention) only fire for Pages that installed the app: POST /{page-id}/subscribed_apps
   * (needs pages_manage_metadata). Instagram comment/mention webhooks also ride on the linked Page's installation.
   * Best effort: a failure leaves polling working and is reported in the account config.
   */
  private async subscribePage(pageId: string, pageToken: string): Promise<boolean> {
    try {
      const r = await this.graph<{ success?: boolean }>("POST", `/${pageId}/subscribed_apps`, pageToken, { json: { subscribed_fields: "feed,mention" }, what: "subscribed_apps" });
      return r.success !== false;
    } catch {
      return false;
    }
  }

  async describeAccount(raw: Record<string, unknown>): Promise<AccountIdentity> {
    const parsed = MetaAuth.safeParse(raw);
    if (!parsed.success) throw new ConnectorError("meta: auth blob needs pageAccessToken and pageId", "auth", false, parsed.error);
    const a = parsed.data;
    if (a.igUserId) {
      const ig = await this.graph<{ id: string; username?: string; name?: string }>("GET", `/${a.igUserId}`, a.pageAccessToken, { query: { fields: "id,username,name" }, what: "ig user" });
      return { externalId: ig.id, handle: ig.username ?? ig.id, displayName: ig.name ?? null };
    }
    const page = await this.graph<{ id: string; username?: string; name?: string }>("GET", `/${a.pageId}`, a.pageAccessToken, { query: { fields: "id,name,username" }, what: "page" });
    return { externalId: page.id, handle: page.username ?? page.id, displayName: page.name ?? null };
  }

  /**
   * Page tokens derived from a long-lived user token do not expire, but Meta invalidates them when the person changes
   * password, loses their Page role or the user token's data access lapses. Re-extend the user token while it is still
   * valid, then re-derive the Page token from it. Returns null when there is no user token to work from.
   */
  async refreshAuth(account: AccountRef): Promise<AuthRefresh | null> {
    const auth = parseAuth(account);
    if (!auth.userAccessToken) return null;
    let userToken = auth.userAccessToken;
    let userExp = auth.userTokenExpiresAt;
    try {
      // TODO(verify): Meta documents fb_exchange_token for short-lived tokens; re-exchanging a valid long-lived one is commonly accepted.
      const ext = await this.exchangeLongLived(userToken);
      userToken = ext.token;
      userExp = ext.expiresAt ?? userExp;
    } catch (err) {
      if (err instanceof ConnectorError && err.kind === "auth") return null; // the user token is dead; only a new login helps
    }
    const page = await this.graph<{ access_token?: string }>("GET", `/${auth.pageId}`, userToken, { query: { fields: "access_token" }, what: "page token" });
    if (!page.access_token) return null;
    const next: MetaAuth = { ...auth, pageAccessToken: page.access_token, userAccessToken: userToken, ...(userExp ? { userTokenExpiresAt: userExp } : {}) };
    return { auth: next };
  }

  private async exchangeLongLived(token: string): Promise<{ token: string; expiresAt?: string }> {
    this.requireApp("token exchange");
    const res = await this.graph<{ access_token?: string; expires_in?: number }>("GET", "/oauth/access_token", null, {
      query: { grant_type: "fb_exchange_token", client_id: this.clientId, client_secret: this.clientSecret, fb_exchange_token: token },
      what: "long-lived token exchange",
    });
    if (!res.access_token) throw new ConnectorError("meta: long-lived token exchange returned no access_token", "auth", false, res);
    return { token: res.access_token, ...(typeof res.expires_in === "number" ? { expiresAt: new Date(this.now().getTime() + res.expires_in * 1000).toISOString() } : {}) };
  }

  private async listPages(userToken: string): Promise<GraphPage[]> {
    const pages: GraphPage[] = [];
    let next: string | undefined = undefined;
    for (let i = 0; i < 20; i++) {
      const res: Paged<GraphPage> = next
        ? await this.graph<Paged<GraphPage>>("GET", next, userToken, { what: "me/accounts" })
        : await this.graph<Paged<GraphPage>>("GET", "/me/accounts", userToken, {
            query: { fields: "id,name,username,access_token,tasks,instagram_business_account{id,username,name}", limit: 100 },
            what: "me/accounts",
          });
      pages.push(...(res.data ?? []));
      next = res.paging?.next;
      if (!next) break;
    }
    return pages;
  }

  // ---- validate ------------------------------------------------------------------------------

  validate(account: AccountRef, input: PublishInput): ValidationIssue[] {
    return account.network === "instagram" ? validateInstagram(input) : validateFacebook(input);
  }

  // ---- publish -------------------------------------------------------------------------------

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    const auth = parseAuth(account);
    return this.idempotency.run(input.idempotencyKey, () => (account.network === "instagram" ? this.publishInstagram(account, auth, input) : this.publishFacebook(account, auth, input)));
  }

  private async publishFacebook(account: AccountRef, auth: MetaAuth, input: PublishInput): Promise<PublishResult> {
    const issues = validateFacebook(input);
    if (issues.length) throw new ConnectorError(`facebook: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
    const key = input.idempotencyKey;
    const state: FbProgress = this.fbProgress.get(key) ?? {};
    this.fbProgress.set(key, state);
    const page = auth.pageId;
    const token = auth.pageAccessToken;
    const opts = input.options ?? {};
    const kind = opts.kind ?? "post";
    const videos = input.media.filter((m) => m.kind === "video");
    const images = input.media.filter((m) => m.kind === "image" || m.kind === "gif");

    if (!state.postId) {
      let postId: string;
      let url: string | null;
      let raw: unknown;
      if (kind === "reel") {
        const r = await this.ruploadFlow(token, `/${page}/video_reels`, videos[0]!, { video_state: "PUBLISHED", description: input.text, ...(opts.title ? { title: opts.title } : {}) });
        postId = r.postId ?? r.videoId;
        url = `https://www.facebook.com/reel/${r.videoId}`;
        raw = r.raw;
      } else if (kind === "story") {
        const m = input.media[0]!;
        if (m.kind === "video") {
          const r = await this.ruploadFlow(token, `/${page}/video_stories`, m, {});
          postId = r.postId ?? r.videoId;
          raw = r.raw;
        } else {
          const photo = await this.graph<{ id: string }>("POST", `/${page}/photos`, token, { json: { url: m.url, published: false }, what: "story photo", creating: true });
          const r = await this.graph<{ success?: boolean; post_id?: string }>("POST", `/${page}/photo_stories`, token, { json: { photo_id: photo.id }, what: "photo story", creating: true });
          postId = r.post_id ?? photo.id;
          raw = r;
        }
        url = null;
      } else if (videos.length > 0) {
        const v = videos[0]!;
        const body: Record<string, unknown> = { description: input.text, ...(opts.title ? { title: opts.title } : {}), ...(opts.thumbnailUrl ? { thumb: opts.thumbnailUrl } : {}) };
        if (v.bytes !== undefined && v.bytes > this.resumableThreshold) body.fbuploader_video_file_chunk = await this.resumableUpload(auth, v);
        else body.file_url = v.url;
        const r = await this.graph<{ id: string; post_id?: string }>("POST", `/${page}/videos`, token, { json: body, what: "video", creating: true });
        postId = r.post_id ?? r.id;
        url = `https://www.facebook.com/${page}/videos/${r.id}`;
        raw = r;
      } else if (images.length === 1) {
        const r = await this.graph<{ id: string; post_id?: string }>("POST", `/${page}/photos`, token, { json: { url: images[0]!.url, caption: input.text }, what: "photo", creating: true });
        postId = r.post_id ?? r.id;
        url = `https://www.facebook.com/${postId}`;
        raw = r;
      } else if (images.length > 1) {
        // Multi-photo: upload each unpublished, then one feed post that attaches them all.
        const ids: string[] = [];
        for (const m of images) {
          const r = await this.graph<{ id: string }>("POST", `/${page}/photos`, token, { json: { url: m.url, published: false, ...(m.alt ? { alt_text_custom: m.alt } : {}) }, what: "photo (unpublished)", creating: true });
          ids.push(r.id);
        }
        const r = await this.graph<{ id: string }>("POST", `/${page}/feed`, token, { json: { message: input.text, attached_media: ids.map((id) => ({ media_fbid: id })) }, what: "multi-photo post", creating: true });
        postId = r.id;
        url = `https://www.facebook.com/${postId}`;
        raw = { ...r, photoIds: ids };
      } else {
        const body: Record<string, unknown> = { message: input.text };
        if (opts.link) body.link = opts.link;
        const r = await this.graph<{ id: string }>("POST", `/${page}/feed`, token, { json: body, what: opts.link ? "link post" : "text post", creating: true });
        postId = r.id;
        url = `https://www.facebook.com/${postId}`;
        raw = r;
      }
      state.postId = postId;
      state.url = url;
      state.raw = raw;
    }

    // options.firstComment is posted by core through reply() after publish succeeds.
    const postId = state.postId;
    this.fbProgress.delete(key);
    return { externalId: postId, url: state.url ?? null, raw: state.raw };
  }

  /**
   * Reels and video stories: start an upload session, have rupload.facebook.com pull the file by URL, then finish.
   * Finish is accepted before encoding completes; poll a few times only to surface a processing error early.
   */
  private async ruploadFlow(token: string, edge: string, media: Media, finish: Record<string, unknown>): Promise<{ videoId: string; postId?: string; raw: unknown }> {
    const start = await this.graph<{ video_id?: string; upload_url?: string }>("POST", edge, token, { json: { upload_phase: "start" }, what: `${edge} start`, creating: true });
    if (!start.video_id) throw new ConnectorError(`facebook ${edge} start: no video_id`, "unknown", false, start);
    const uploadUrl = start.upload_url ?? `${this.ruploadBase}/video-upload/${this.version}/${start.video_id}`;
    await this.rawRequest("POST", uploadUrl, { authorization: `OAuth ${token}`, file_url: media.url }, undefined, `${edge} upload`);
    const done = await this.graph<{ success?: boolean; post_id?: string }>("POST", edge, token, { json: { upload_phase: "finish", video_id: start.video_id, ...finish }, what: `${edge} finish`, creating: true });
    for (let i = 0; i < Math.min(this.maxPolls, 5); i++) {
      const s = await this.graph<{ status?: { video_status?: string; processing_phase?: { status?: string; error?: { message?: string } } } }>("GET", `/${start.video_id}`, token, { query: { fields: "status" }, what: "video status" }).catch(() => null);
      const vs = s?.status?.video_status;
      if (vs === "error" || s?.status?.processing_phase?.status === "error") {
        throw new ConnectorError(`facebook video ${start.video_id} failed processing: ${s?.status?.processing_phase?.error?.message ?? "unknown error"}`, "rejected", false, s);
      }
      if (!vs || vs === "ready" || vs === "published") break;
      await this.sleep(this.pollIntervalMs);
    }
    return { videoId: start.video_id, ...(done.post_id ? { postId: done.post_id } : {}), raw: { start, finish: done } };
  }

  /** Resumable Upload API: session on the app, bytes POSTed with file_offset (resumed from the server's offset), returns a file handle. */
  private async resumableUpload(auth: MetaAuth, media: Media): Promise<string> {
    this.requireApp("resumable upload");
    if (!auth.userAccessToken) throw new ConnectorError("facebook resumable upload needs the user access token on the account; reconnect the Page", "auth", false);
    const token = auth.userAccessToken;
    // The bytes from file_offset on go up as one streamed body (exact Content-Length), so the video is never held whole.
    return withMedia(mediaSource(this.media, this.fetchImpl), media, async (file) => {
      const session = await this.graph<{ id?: string }>("POST", `/${this.clientId}/uploads`, token, {
        query: { file_name: `starsign-${Date.now()}.mp4`, file_length: file.size, file_type: file.mime },
        what: "upload session",
        creating: true,
      });
      if (!session.id) throw new ConnectorError("facebook upload session: no id", "unknown", false, session);
      let offset = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const body = file.bytes ? new Blob([file.bytes.subarray(offset)]) : file.body(offset, file.size - offset, "application/octet-stream");
          const res = (await this.rawRequest("POST", `${this.graphBase}/${this.version}/${session.id}`, { authorization: `OAuth ${token}`, file_offset: String(offset) }, body, "upload bytes")) as { h?: string };
          if (res.h) return res.h;
          throw new ConnectorError("facebook upload: response carried no file handle", "unknown", false, res);
        } catch (err) {
          if (!(err instanceof ConnectorError) || err.kind !== "network" || attempt === 2) throw err;
          const s = (await this.rawRequest("GET", `${this.graphBase}/${this.version}/${session.id}`, { authorization: `OAuth ${token}` }, undefined, "upload offset")) as { file_offset?: number };
          offset = Number(s.file_offset ?? 0);
        }
      }
      throw new ConnectorError("facebook upload: gave up", "network", true);
    });
  }

  private async publishInstagram(account: AccountRef, auth: MetaAuth, input: PublishInput): Promise<PublishResult> {
    const issues = validateInstagram(input);
    if (issues.length) throw new ConnectorError(`instagram: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
    const ig = igUserIdOf(account, auth);
    const token = auth.pageAccessToken;
    const key = input.idempotencyKey;
    const state: IgProgress = this.igProgress.get(key) ?? {};
    this.igProgress.set(key, state);
    const opts = input.options ?? {};
    const kind = opts.kind ?? "post";

    if (!state.mediaId) {
      if (!state.creationId) {
        await this.checkPublishingLimit(ig, token);
        const body: Record<string, unknown> = {};
        const media = input.media;
        if (kind === "story") {
          const m = media[0]!;
          body.media_type = "STORIES";
          body[m.kind === "video" ? "video_url" : "image_url"] = m.url;
        } else if (kind === "carousel" || media.length > 1) {
          if (!state.children) {
            const children: string[] = [];
            for (const m of media) {
              const child = await this.graph<{ id: string }>("POST", `/${ig}/media`, token, {
                json: m.kind === "video" ? { media_type: "VIDEO", video_url: m.url, is_carousel_item: true } : { image_url: m.url, is_carousel_item: true, ...(m.alt ? { alt_text: m.alt } : {}) },
                what: "carousel item",
                creating: true,
              });
              children.push(child.id);
            }
            state.children = children;
          }
          for (const c of state.children) await this.waitForContainer(c, token, () => (state.children = undefined));
          body.media_type = "CAROUSEL";
          body.children = state.children.join(",");
          body.caption = input.text;
        } else if (media[0]!.kind === "video") {
          // Single videos publish as Reels; media_type=VIDEO is no longer accepted for feed videos.
          body.media_type = "REELS";
          body.video_url = media[0]!.url;
          body.caption = input.text;
          body.share_to_feed = true;
          if (opts.thumbnailUrl) body.cover_url = opts.thumbnailUrl;
        } else {
          body.image_url = media[0]!.url;
          body.caption = input.text;
          // TODO(verify): alt_text on single-image containers (added 2025 for the Instagram API).
          if (media[0]!.alt) body.alt_text = media[0]!.alt;
        }
        const c = await this.graph<{ id: string }>("POST", `/${ig}/media`, token, { json: body, what: "media container", creating: true });
        state.creationId = c.id;
      }
      await this.waitForContainer(state.creationId, token, () => {
        state.creationId = undefined;
        state.children = undefined;
      });
      const pub = await this.graph<{ id: string }>("POST", `/${ig}/media_publish`, token, { json: { creation_id: state.creationId }, what: "media_publish", creating: true });
      state.mediaId = pub.id;
    }

    const mediaId = state.mediaId;
    this.igMedia.add(mediaId);
    const permalink = await this.graph<{ permalink?: string }>("GET", `/${mediaId}`, token, { query: { fields: "permalink" }, what: "permalink" }).then((r) => r.permalink ?? null, () => null);
    // options.firstComment is posted by core through reply() (→ POST /{media-id}/comments) after publish succeeds.
    this.igProgress.delete(key);
    return { externalId: mediaId, url: permalink, raw: { mediaId, creationId: state.creationId, children: state.children } };
  }

  /** content_publishing_limit: refuse early (retryable) instead of burning a container when the 24h quota is spent. */
  private async checkPublishingLimit(ig: string, token: string): Promise<void> {
    let res: { data?: { quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }[] };
    try {
      res = await this.graph("GET", `/${ig}/content_publishing_limit`, token, { query: { fields: "config,quota_usage" }, what: "content_publishing_limit" });
    } catch (err) {
      if (err instanceof ConnectorError && (err.kind === "auth" || err.kind === "rate_limit")) throw err;
      return; // the check is advisory; media_publish enforces the limit anyway
    }
    const row = res.data?.[0];
    const total = row?.config?.quota_total;
    if (row && typeof total === "number" && typeof row.quota_usage === "number" && row.quota_usage >= total) {
      throw new ConnectorError(`instagram: publishing limit reached (${row.quota_usage}/${total} in the last ${Math.round((row.config?.quota_duration ?? 86400) / 3600)}h)`, "rate_limit", true, res);
    }
  }

  /**
   * Poll a container's status_code until FINISHED. ERROR/EXPIRED drop the container (so a retry makes a new one);
   * still IN_PROGRESS after maxPolls is a retryable error that keeps the container for the next attempt.
   */
  private async waitForContainer(id: string, token: string, discard: () => void): Promise<void> {
    for (let i = 0; i < this.maxPolls; i++) {
      const s = await this.graph<{ status_code?: string; status?: string }>("GET", `/${id}`, token, { query: { fields: "status_code,status" }, what: "container status" });
      const code = s.status_code;
      if (code === "FINISHED" || code === "PUBLISHED") return;
      if (code === "ERROR") {
        discard();
        throw new ConnectorError(`instagram container ${id} failed: ${s.status ?? "ERROR"}`, "rejected", false, s);
      }
      if (code === "EXPIRED") {
        discard();
        throw new ConnectorError(`instagram container ${id} expired before publishing; retry to create a new one`, "network", true, s);
      }
      if (i < this.maxPolls - 1) await this.sleep(this.pollIntervalMs);
    }
    throw new ConnectorError(`instagram container ${id} is still processing after ${this.maxPolls} checks; retry later to publish it`, "network", true, { containerId: id });
  }

  // ---- inbox ---------------------------------------------------------------------------------

  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const items = account.network === "instagram" ? await this.instagramActivity(account, auth, since) : await this.facebookActivity(auth, since);
    return items.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  private async facebookActivity(auth: MetaAuth, since: Date | null): Promise<ActivityInput[]> {
    const token = auth.pageAccessToken;
    const now = this.now();
    const out: ActivityInput[] = [];
    // Comments arrive on old posts too, so walk recent posts regardless of `since` and filter comments by time.
    const posts = await this.graph<Paged<FbPost>>("GET", `/${auth.pageId}/published_posts`, token, {
      query: {
        fields: "id,message,created_time,permalink_url,comments.filter(stream).order(reverse_chronological).limit(50){id,message,from{id,name},created_time,parent{id},permalink_url}",
        limit: this.maxActivityPosts,
      },
      what: "published_posts",
    });
    for (const p of posts.data ?? []) {
      const at = graphTime(p.created_time, now);
      if (isAfter(at, since)) {
        out.push({ network: "facebook", kind: "own_post", externalId: p.id, authorHandle: null, authorName: null, text: p.message ?? null, url: p.permalink_url ?? null, parentExternalId: null, occurredAt: at, raw: { ...p, comments: undefined } });
      }
      for (const c of p.comments?.data ?? []) {
        if (c.from?.id === auth.pageId) continue; // the Page's own replies
        const cat = graphTime(c.created_time, now);
        if (!isAfter(cat, since)) continue;
        out.push({ network: "facebook", kind: "comment", externalId: c.id, authorHandle: null, authorName: c.from?.name ?? null, text: c.message ?? null, url: c.permalink_url ?? null, parentExternalId: c.parent?.id ?? p.id, occurredAt: cat, raw: c });
      }
    }
    // Posts that tag the Page.
    try {
      const tagged = await this.graph<Paged<FbPost>>("GET", `/${auth.pageId}/tagged`, token, { query: { fields: "id,message,created_time,permalink_url,from{id,name}", limit: 25 }, what: "tagged" });
      for (const t of tagged.data ?? []) {
        const at = graphTime(t.created_time, now);
        if (!isAfter(at, since)) continue;
        out.push({ network: "facebook", kind: "mention", externalId: t.id, authorHandle: null, authorName: t.from?.name ?? null, text: t.message ?? null, url: t.permalink_url ?? null, parentExternalId: null, occurredAt: at, raw: t });
      }
    } catch (err) {
      if (err instanceof ConnectorError && err.kind !== "rejected") throw err;
    }
    return out;
  }

  private async instagramActivity(account: AccountRef, auth: MetaAuth, since: Date | null): Promise<ActivityInput[]> {
    const ig = igUserIdOf(account, auth);
    const token = auth.pageAccessToken;
    const now = this.now();
    const out: ActivityInput[] = [];
    const commentFields = "id,text,timestamp,username,from{id,username},parent_id";
    const media = await this.graph<Paged<IgMedia>>("GET", `/${ig}/media`, token, {
      query: { fields: `id,caption,timestamp,permalink,media_type,media_product_type,comments.limit(50){${commentFields},replies.limit(50){${commentFields}}}`, limit: this.maxActivityPosts },
      what: "ig media",
    });
    const pushComment = (c: IgComment, m: IgMedia) => {
      if (c.from?.id === ig || (c.username && c.username === account.handle)) return;
      const at = graphTime(c.timestamp, now);
      if (!isAfter(at, since)) return;
      out.push({ network: "instagram", kind: c.parent_id ? "reply" : "comment", externalId: c.id, authorHandle: c.username ?? c.from?.username ?? null, authorName: null, text: c.text ?? null, url: m.permalink ?? null, parentExternalId: c.parent_id ?? m.id, occurredAt: at, raw: { ...c, replies: undefined, mediaId: m.id } });
    };
    for (const m of media.data ?? []) {
      const at = graphTime(m.timestamp, now);
      if (isAfter(at, since)) {
        out.push({ network: "instagram", kind: "own_post", externalId: m.id, authorHandle: account.handle, authorName: null, text: m.caption ?? null, url: m.permalink ?? null, parentExternalId: null, occurredAt: at, raw: { ...m, comments: undefined } });
      }
      for (const c of m.comments?.data ?? []) {
        pushComment(c, m);
        for (const r of c.replies?.data ?? []) pushComment({ ...r, parent_id: r.parent_id ?? c.id }, m);
      }
    }
    // Media other accounts tagged us in. Caption @mentions without a tag only arrive through the `mentions` webhook.
    try {
      const tags = await this.graph<Paged<IgMedia>>("GET", `/${ig}/tags`, token, { query: { fields: "id,caption,timestamp,permalink,username,media_type", limit: 25 }, what: "ig tags" });
      for (const t of tags.data ?? []) {
        const at = graphTime(t.timestamp, now);
        if (!isAfter(at, since)) continue;
        out.push({ network: "instagram", kind: "mention", externalId: t.id, authorHandle: t.username ?? null, authorName: null, text: t.caption ?? null, url: t.permalink ?? null, parentExternalId: null, occurredAt: at, raw: t });
      }
    } catch (err) {
      if (err instanceof ConnectorError && err.kind !== "rejected") throw err;
    }
    return out;
  }

  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    const auth = parseAuth(account);
    return this.idempotency.run(`reply:${input.idempotencyKey}`, async () => {
      const token = auth.pageAccessToken;
      if (account.network === "facebook") {
        const r = await this.graph<{ id: string }>("POST", `/${input.parentExternalId}/comments`, token, { json: { message: input.text }, what: "reply", creating: true });
        return { externalId: r.id, url: `https://www.facebook.com/${r.id}`, raw: r };
      }
      // Instagram: comments take /replies, media take /comments. Media we just published go straight to /comments;
      // otherwise try the comment form first, since Graph answers code 100 for a media id.
      // TODO(verify): code 100 is what /{media-id}/replies returns (vs a different code) on current versions.
      if (!this.igMedia.has(input.parentExternalId)) {
        try {
          const r = await this.graph<{ id: string }>("POST", `/${input.parentExternalId}/replies`, token, { json: { message: input.text }, what: "reply", creating: true });
          return { externalId: r.id, url: null, raw: r };
        } catch (err) {
          if (graphCode(err) !== 100) throw err;
        }
      }
      const r = await this.graph<{ id: string }>("POST", `/${input.parentExternalId}/comments`, token, { json: { message: input.text }, what: "comment", creating: true });
      return { externalId: r.id, url: null, raw: r };
    });
  }

  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    const auth = parseAuth(account);
    const token = auth.pageAccessToken;
    const id = input.externalId;
    if (input.action === "delete") {
      await this.graph("DELETE", `/${id}`, token, { what: "delete comment" });
      return;
    }
    if (account.network === "instagram") {
      if (input.action === "like" || input.action === "unlike") throw new ConnectorError("instagram: the API cannot like comments", "rejected", false);
      await this.graph("POST", `/${id}`, token, { json: { hide: input.action === "hide" }, what: `${input.action} comment` });
      return;
    }
    if (input.action === "hide" || input.action === "unhide") {
      await this.graph("POST", `/${id}`, token, { json: { is_hidden: input.action === "hide" }, what: `${input.action} comment` });
      return;
    }
    await this.graph(input.action === "like" ? "POST" : "DELETE", `/${id}/likes`, token, { what: input.action });
  }

  // ---- metrics -------------------------------------------------------------------------------

  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const out: MetricInput[] = [];
    for (const id of externalIds) out.push(...(account.network === "instagram" ? await this.igMediaMetrics(auth, id) : await this.fbPostMetrics(auth, id)));
    return out;
  }

  private async fbPostMetrics(auth: MetaAuth, id: string): Promise<MetricInput[]> {
    const token = auth.pageAccessToken;
    const observedAt = this.now().toISOString();
    const rows: MetricInput[] = [];
    const add = (metric: MetricName, value: number | undefined) => {
      if (typeof value === "number" && Number.isFinite(value)) rows.push({ entityType: "post_variant", entityId: id, metric, value, observedAt, source: "facebook" });
    };
    const counts = await this.tolerantFields<{ shares?: { count?: number }; reactions?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } } }>(
      id,
      token,
      ["shares", "reactions.summary(total_count).limit(0)", "comments.summary(total_count).limit(0)"],
    );
    const ins = await this.tolerantInsights(`/${id}/insights`, token, FB_POST_METRICS, "fb_post", {});
    const likes = counts.reactions?.summary?.total_count;
    const replies = counts.comments?.summary?.total_count;
    const shares = counts.shares?.count ?? (counts.reactions || counts.comments ? 0 : undefined);
    add("likes", likes);
    add("replies", replies);
    add("shares", shares);
    add("impressions", num(ins.get("post_media_view")));
    add("reach", num(ins.get("post_total_media_view_unique")));
    add("clicks", num(ins.get("post_clicks")));
    const byType = ins.get("post_clicks_by_type");
    if (byType && typeof byType === "object") add("link_clicks", byType["link clicks"] ?? 0);
    add("video_views", num(ins.get("post_video_views")));
    const viewMs = num(ins.get("post_video_view_time"));
    if (viewMs !== undefined) add("watch_time_seconds", Math.round(viewMs / 1000));
    if (likes !== undefined || replies !== undefined) add("engagements", (likes ?? 0) + (replies ?? 0) + (shares ?? 0));
    return rows;
  }

  private async igMediaMetrics(auth: MetaAuth, id: string): Promise<MetricInput[]> {
    const token = auth.pageAccessToken;
    const observedAt = this.now().toISOString();
    const rows: MetricInput[] = [];
    const add = (metric: MetricName, value: number | undefined) => {
      if (typeof value === "number" && Number.isFinite(value)) rows.push({ entityType: "post_variant", entityId: id, metric, value, observedAt, source: "instagram" });
    };
    const media = await this.graph<IgMedia>("GET", `/${id}`, token, { query: { fields: "id,media_type,media_product_type,like_count,comments_count" }, what: "ig media" });
    const product = media.media_product_type === "REELS" || media.media_product_type === "STORY" ? media.media_product_type : "FEED";
    const ins = await this.tolerantInsights(`/${id}/insights`, token, IG_METRICS[product]!, `ig_${product}`, {});
    const views = num(ins.get("views"));
    add("impressions", views);
    if (product === "REELS" || media.media_type === "VIDEO") add("video_views", views);
    add("reach", num(ins.get("reach")));
    add("likes", num(ins.get("likes")) ?? media.like_count);
    add("replies", num(ins.get("comments")) ?? num(ins.get("replies")) ?? media.comments_count);
    add("shares", num(ins.get("shares")));
    add("saves", num(ins.get("saved")));
    add("engagements", num(ins.get("total_interactions")));
    add("profile_visits", num(ins.get("profile_visits")));
    add("follows", num(ins.get("follows")));
    const watchMs = num(ins.get("ig_reels_video_view_total_time"));
    if (watchMs !== undefined) add("watch_time_seconds", Math.round(watchMs / 1000));
    return rows;
  }

  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const token = auth.pageAccessToken;
    const observedAt = this.now().toISOString();
    const rows: MetricInput[] = [];
    const add = (metric: MetricName, value: number | undefined) => {
      if (typeof value === "number" && Number.isFinite(value)) rows.push({ entityType: "social_account", entityId: account.id, metric, value, observedAt, source: account.network });
    };
    if (account.network === "instagram") {
      const ig = igUserIdOf(account, auth);
      const user = await this.graph<{ followers_count?: number }>("GET", `/${ig}`, token, { query: { fields: "followers_count,media_count" }, what: "ig user" });
      add("followers_total", user.followers_count);
      const ins = await this.tolerantInsights(`/${ig}/insights`, token, IG_ACCOUNT_METRICS, "ig_user", { period: "day", metric_type: "total_value" });
      add("reach", num(ins.get("reach")));
      add("impressions", num(ins.get("views")));
      add("engagements", num(ins.get("total_interactions")));
      add("link_clicks", num(ins.get("profile_links_taps")));
      return rows;
    }
    const page = await this.graph<{ followers_count?: number; fan_count?: number }>("GET", `/${auth.pageId}`, token, { query: { fields: "followers_count,fan_count" }, what: "page" });
    add("followers_total", page.followers_count ?? page.fan_count);
    const ins = await this.tolerantInsights(`/${auth.pageId}/insights`, token, FB_PAGE_METRICS, "fb_page", { period: "day" });
    add("impressions", num(ins.get("page_media_view")));
    add("reach", num(ins.get("page_total_media_view_unique")));
    add("engagements", num(ins.get("page_post_engagements")));
    return rows;
  }

  /**
   * Insights with metric-name churn in mind: request all metrics at once; if Graph refuses (code 100, an invalid or
   * retired metric) fall back to one request per metric and remember the refused names for this process.
   */
  private async tolerantInsights(path: string, token: string, metrics: string[], kind: string, extra: Record<string, string>): Promise<Map<string, number | Record<string, number>>> {
    const out = new Map<string, number | Record<string, number>>();
    const wanted = metrics.filter((m) => !this.invalidMetrics.has(`${kind}:${m}`));
    if (wanted.length === 0) return out;
    const collect = (res: { data?: InsightRow[] }) => {
      for (const row of res.data ?? []) {
        const v = insightValue(row);
        if (v !== undefined) out.set(row.name, v);
      }
    };
    try {
      collect(await this.graph<{ data?: InsightRow[] }>("GET", path, token, { query: { metric: wanted.join(","), ...extra }, what: "insights" }));
      return out;
    } catch (err) {
      if (!(err instanceof ConnectorError) || err.kind !== "rejected") throw err;
      if (wanted.length === 1) {
        this.invalidMetrics.add(`${kind}:${wanted[0]}`);
        return out;
      }
    }
    for (const m of wanted) {
      try {
        collect(await this.graph<{ data?: InsightRow[] }>("GET", path, token, { query: { metric: m, ...extra }, what: `insights ${m}` }));
      } catch (err) {
        if (!(err instanceof ConnectorError) || err.kind !== "rejected") throw err;
        this.invalidMetrics.add(`${kind}:${m}`);
      }
    }
    return out;
  }

  /** Object fields with the same fallback: one call, or one per field when a field is invalid for this object type. */
  private async tolerantFields<T extends object>(id: string, token: string, fields: string[]): Promise<Partial<T>> {
    try {
      return await this.graph<Partial<T>>("GET", `/${id}`, token, { query: { fields: fields.join(",") }, what: "post fields" });
    } catch (err) {
      if (!(err instanceof ConnectorError) || err.kind !== "rejected") throw err;
    }
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      try {
        Object.assign(out, await this.graph<Record<string, unknown>>("GET", `/${id}`, token, { query: { fields: f }, what: `post field ${f}` }));
      } catch (err) {
        if (!(err instanceof ConnectorError) || err.kind !== "rejected") throw err;
      }
    }
    return out as Partial<T>;
  }

  // ---- webhooks ------------------------------------------------------------------------------

  readonly webhook: WebhookHandler = {
    challenge: (query) => hubChallenge(query, this.verifyToken),
    verify: (headers, rawBody) => verifyHubSignature(this.clientSecret, headers, rawBody),
    parse: (body) => parseMetaWebhook(body, this.now()),
  };

  // ---- transport -----------------------------------------------------------------------------

  private requireApp(what: string): void {
    if (!this.clientId || !this.clientSecret) throw new ConnectorError(`meta ${what}: META_CLIENT_ID and META_CLIENT_SECRET must be configured`, "auth", false);
  }

  /** appsecret_proof = HMAC-SHA256(app secret, token). Required when "Require App Secret" is on; harmless otherwise. */
  private proof(token: string): string | undefined {
    return this.clientSecret ? createHmac("sha256", this.clientSecret).update(token).digest("hex") : undefined;
  }

  private async graph<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    token: string | null,
    opts: { query?: Record<string, string | number | boolean | undefined>; json?: Record<string, unknown>; what?: string; creating?: boolean } = {},
  ): Promise<T> {
    const url = new URL(path.startsWith("http") ? path : `${this.graphBase}/${this.version}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) {
      headers.authorization = `Bearer ${token}`;
      const proof = this.proof(token);
      if (proof && !url.searchParams.has("appsecret_proof")) url.searchParams.set("appsecret_proof", proof);
    }
    let body: string | undefined;
    if (opts.json) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    const what = opts.what ?? `${method} ${path}`;
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(url.toString(), { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch (err) {
      throw asNetworkError(err, `meta ${what}`);
    }
    const data = await readJson(res);
    if (!res.ok || (data && typeof data === "object" && "error" in data)) throw mapGraphError("meta", what, res.ok ? 400 : res.status, res.headers, data);
    return data as T;
  }

  private async rawRequest(method: "GET" | "POST", url: string, headers: Record<string, string>, body: Blob | StreamBody | undefined, what: string): Promise<unknown> {
    let res: Response;
    try {
      res = await sendBody(resolveFetch(this.fetchImpl), url, { method, headers }, body);
    } catch (err) {
      throw asNetworkError(err, `meta ${what}`);
    }
    const data = await readJson(res);
    if (!res.ok) throw mapGraphError("meta", what, res.status, res.headers, data);
    return data;
  }
}

// ---- validation -------------------------------------------------------------------------------

function validateFacebook(input: PublishInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const kind = input.options?.kind ?? "post";
  const videos = input.media.filter((m) => m.kind === "video");
  const images = input.media.filter((m) => m.kind === "image" || m.kind === "gif");
  if (input.media.some((m) => m.kind === "document")) issues.push({ code: "unsupported_media", message: "facebook Pages cannot publish document attachments" });
  if (!["post", "link", "video", "reel", "story"].includes(kind)) issues.push({ code: "unsupported_media", message: `facebook connector does not publish kind "${kind}"` });
  if (videos.length > 1) issues.push({ code: "too_many_media", message: "facebook takes one video per post" });
  if (videos.length > 0 && images.length > 0) issues.push({ code: "unsupported_media", message: "facebook cannot mix photos and a video in one post" });
  if (kind === "reel") {
    if (videos.length !== 1 || images.length > 0) issues.push({ code: "media_required", message: "a facebook reel needs exactly one video" });
    // TODO(verify): Page reels length limits (3-90 s per the Reels Publishing API guide).
    const d = videos[0]?.durationSeconds;
    if (d !== undefined && (d < 3 || d > 90)) issues.push({ code: "unsupported_media", message: `facebook reels must be 3-90 seconds (got ${d}s)` });
  }
  if (kind === "story" && input.media.length !== 1) issues.push({ code: "media_required", message: "a facebook story needs exactly one photo or video" });
  if (kind === "video" && videos.length !== 1) issues.push({ code: "media_required", message: "a facebook video post needs one video" });
  return issues;
}

const HASHTAG_RE = /(^|\s)#[\p{L}\p{N}_]+/gu;
const MENTION_RE = /(^|\s)@[A-Za-z0-9._]+/g;

function validateInstagram(input: PublishInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const kind = input.options?.kind ?? "post";
  const media = input.media;
  const videos = media.filter((m) => m.kind === "video");
  if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "instagram has no threads; use a carousel or the first comment" });
  if (media.length === 0) issues.push({ code: "media_required", message: "instagram posts need at least one image or video" });
  for (const m of media) {
    if (m.kind === "document" || m.kind === "gif") issues.push({ code: "unsupported_media", message: `instagram does not accept ${m.kind} media` });
    if (m.kind === "image" && m.mime && !/^image\/jpe?g$/i.test(m.mime)) issues.push({ code: "unsupported_media", message: `instagram image_url must be a JPEG (got ${m.mime})` });
    if (m.kind === "image" && m.width && m.height && kind !== "story") {
      const r = m.width / m.height;
      if (r < 0.8 - 0.005 || r > 1.91 + 0.005) issues.push({ code: "unsupported_media", message: `instagram feed images must be between 4:5 and 1.91:1 (got ${m.width}x${m.height})` });
    }
  }
  if (!["post", "carousel", "reel", "story", "video"].includes(kind)) issues.push({ code: "unsupported_media", message: `instagram connector does not publish kind "${kind}"` });
  if (kind === "carousel" || (media.length > 1 && kind === "post")) {
    if (media.length < 2) issues.push({ code: "media_required", message: "an instagram carousel needs 2-10 items" });
    if (media.length > 10) issues.push({ code: "too_many_media", message: "an instagram carousel takes at most 10 items" });
  }
  if (kind === "reel" || kind === "video") {
    if (media.length !== 1 || videos.length !== 1) issues.push({ code: "media_required", message: "an instagram reel needs exactly one video" });
    const d = videos[0]?.durationSeconds;
    if (d !== undefined && (d < 3 || d > 900)) issues.push({ code: "unsupported_media", message: `instagram reels must be 3 s to 15 min (got ${d}s)` });
  }
  if (kind === "story") {
    if (media.length !== 1) issues.push({ code: "too_many_media", message: "an instagram story takes exactly one image or video" });
    const d = videos[0]?.durationSeconds;
    if (d !== undefined && d > 60) issues.push({ code: "unsupported_media", message: `instagram story videos must be 60 s or shorter (got ${d}s)` });
  }
  if ((input.text.match(HASHTAG_RE)?.length ?? 0) > 30) issues.push({ code: "too_long", message: "instagram captions allow at most 30 hashtags" });
  if ((input.text.match(MENTION_RE)?.length ?? 0) > 20) issues.push({ code: "too_long", message: "instagram captions allow at most 20 @mentions" });
  return issues;
}

// ---- webhook parsing --------------------------------------------------------------------------

interface MetaWebhookChange {
  field?: string;
  value?: Record<string, unknown>;
}

interface MetaWebhookEntry {
  id?: string;
  time?: number;
  changes?: MetaWebhookChange[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : null);

/**
 * Page `feed` comment/visitor-post changes and `mention` changes → facebook items routed by Page id;
 * Instagram `comments` and `mentions` changes → instagram items routed by IG user id. Removals, edits by the
 * account itself and unknown fields are dropped.
 */
export function parseMetaWebhook(body: unknown, now: Date): WebhookBatch[] {
  const b = (body ?? {}) as { object?: string; entry?: MetaWebhookEntry[] };
  const network: Network | null = b.object === "page" ? "facebook" : b.object === "instagram" ? "instagram" : null;
  if (!network || !Array.isArray(b.entry)) return [];
  const batches: WebhookBatch[] = [];
  for (const entry of b.entry) {
    const accountId = str(entry.id);
    if (!accountId) continue;
    const entryTime = graphTime(entry.time, now);
    const items: ActivityInput[] = [];
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const item = network === "facebook" ? fbChangeToActivity(accountId, change.field, v, entryTime, now) : igChangeToActivity(accountId, change.field, v, entryTime);
      if (item) items.push({ ...item, raw: { field: change.field, value: v, entryId: accountId } });
    }
    if (items.length > 0) batches.push({ network, accountExternalId: accountId, items });
  }
  return batches;
}

function fbChangeToActivity(pageId: string, field: string | undefined, v: Record<string, unknown>, entryTime: string, now: Date): ActivityInput | null {
  const from = (v.from ?? {}) as { id?: unknown; name?: unknown };
  const occurredAt = v.created_time !== undefined ? graphTime(v.created_time, now) : entryTime;
  if (field === "feed") {
    if (v.verb !== "add") return null;
    if (str(from.id) === pageId) return null;
    const postId = str(v.post_id);
    if (v.item === "comment") {
      const commentId = str(v.comment_id);
      if (!commentId) return null;
      return { network: "facebook", kind: "comment", externalId: commentId, authorHandle: null, authorName: str(from.name), text: str(v.message), url: postId ? `https://www.facebook.com/${postId}` : null, parentExternalId: str(v.parent_id) ?? postId, occurredAt, raw: v };
    }
    if ((v.item === "post" || v.item === "status" || v.item === "photo" || v.item === "video") && postId) {
      // A visitor post on the Page.
      return { network: "facebook", kind: "mention", externalId: postId, authorHandle: null, authorName: str(from.name), text: str(v.message), url: `https://www.facebook.com/${postId}`, parentExternalId: null, occurredAt, raw: v };
    }
    return null;
  }
  if (field === "mention") {
    if (v.verb && v.verb !== "add") return null;
    const id = str(v.comment_id) ?? str(v.post_id);
    if (!id) return null;
    return { network: "facebook", kind: "mention", externalId: id, authorHandle: null, authorName: str(v.sender_name), text: str(v.message), url: str(v.post_id) ? `https://www.facebook.com/${str(v.post_id)}` : null, parentExternalId: str(v.comment_id) ? str(v.post_id) : null, occurredAt, raw: v };
  }
  return null;
}

function igChangeToActivity(igId: string, field: string | undefined, v: Record<string, unknown>, entryTime: string): ActivityInput | null {
  if (field === "comments" || field === "live_comments") {
    const from = (v.from ?? {}) as { id?: unknown; username?: unknown };
    if (str(from.id) === igId) return null;
    const id = str(v.id);
    if (!id) return null;
    const media = (v.media ?? {}) as { id?: unknown };
    const parent = str(v.parent_id);
    return { network: "instagram", kind: parent ? "reply" : "comment", externalId: id, authorHandle: str(from.username), authorName: null, text: str(v.text), url: null, parentExternalId: parent ?? str(media.id), occurredAt: entryTime, raw: v };
  }
  if (field === "mentions") {
    const mediaId = str(v.media_id);
    const commentId = str(v.comment_id);
    const id = commentId ?? mediaId;
    if (!id) return null;
    // The payload carries only ids; text and author need GET /{ig-user-id}?fields=mentioned_comment / mentioned_media.
    return { network: "instagram", kind: "mention", externalId: id, authorHandle: null, authorName: null, text: null, url: null, parentExternalId: commentId ? mediaId : null, occurredAt: entryTime, raw: v };
  }
  return null;
}

// ---- helpers ----------------------------------------------------------------------------------

function parseAuth(account: AccountRef): MetaAuth {
  const parsed = MetaAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`meta account ${account.handle}: auth blob needs pageAccessToken and pageId; reconnect with Facebook`, "auth", false, parsed.error);
  return parsed.data;
}

function igUserIdOf(account: AccountRef, auth: MetaAuth): string {
  return auth.igUserId ?? account.externalId;
}

function num(v: number | Record<string, number> | undefined): number | undefined {
  return typeof v === "number" ? v : undefined;
}

export function createMetaConnectors(env: NodeJS.ProcessEnv): Connector[] {
  const { clientId, clientSecret } = clientFromEnv(env, "META");
  return [
    new MetaConnector({
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(env.META_WEBHOOK_VERIFY_TOKEN ? { webhookVerifyToken: env.META_WEBHOOK_VERIFY_TOKEN } : {}),
      ...(env.META_GRAPH_VERSION ? { graphVersion: env.META_GRAPH_VERSION } : {}),
      ...(env.META_LOGIN_CONFIG_ID ? { loginConfigId: env.META_LOGIN_CONFIG_ID } : {}),
    }),
  ];
}
