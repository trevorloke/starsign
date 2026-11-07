import type { ActivityInput, MetricInput, MetricName, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, isAfter, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { OAuth2Client, clientFromEnv, type OAuth2Token } from "./oauth.ts";
import type { AccountIdentity, AccountRef, AuthRefresh, ConnectedAccount, Connector, ConnectorCapabilities, ModerationInput, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Naver Band (네이버 밴드) through the BAND Open API (https://openapi.band.us). OAuth 2.0 authorization code at
 * auth.band.us (client credentials in a Basic header at the token endpoint); every API call carries the
 * `access_token` as a parameter.
 *
 * One login yields one account per band the person belongs to and may post in (externalId = band_key). Bands are
 * community groups, so new posts by members arrive as "message" items in the band's conversation and comments on
 * recent posts as "comment" items.
 *
 * External ids: posts "<band_key>:<post_key>", comments "<band_key>:<post_key>:<comment_key>".
 *
 * Responses are `{ result_code, result_data }`; result_code 1 is success, anything else is an error even with HTTP 200.
 * The official guide (developers.band.us) was not reachable from the build sandbox; shapes follow the API reference as
 * quoted by third-party clients (Go `naverbandgo`, the band MCP server). Unconfirmed details are marked TODO(verify).
 */

const API = "https://openapi.band.us";

export const BandAuth = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.string().optional(),
  userKey: z.string().optional(),
});
export type BandAuth = z.infer<typeof BandAuth>;

export interface BandConnectorOptions {
  clientId?: string;
  clientSecret?: string;
  apiUrl?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** Recent posts whose comments fetchActivity reads. */
  recentPosts?: number;
  /** Most bands whose posting permission is checked at connect. */
  maxBands?: number;
}

export interface BandFailure {
  status: number;
  code?: number;
  body: unknown;
}

interface BandAuthor {
  name?: string;
  description?: string;
  role?: string;
  profile_image_url?: string;
  user_key?: string;
}

export interface BandPost {
  band_key?: string;
  post_key: string;
  content?: string;
  author?: BandAuthor;
  created_at?: number;
  comment_count?: number;
  emotion_count?: number;
  photos?: { url?: string }[];
}

export interface BandComment {
  band_key?: string;
  post_key?: string;
  comment_key: string;
  content?: string;
  author?: BandAuthor;
  created_at?: number;
  emotion_count?: number;
}

export interface BandAccountConfig {
  bandKey: string;
  bandName: string | null;
  userKey: string | null;
  userName: string | null;
  coverUrl: string | null;
  memberCount: number | null;
  /** Permissions BAND reported at connect (posting, commenting, contents_deletion), or null when not checked. */
  permissions: string[] | null;
  /** Send members a push notification for new posts. Off unless set. */
  doPush?: boolean;
}

// TODO(verify): BAND result codes. Our reading of the reference: 1 success; 211/212 bad or missing parameter;
// 1001 app quota, 1002 user quota, 1003 cool-down; 2142 band leaders only; 3000-3003 invalid request / limits;
// 10401 invalid access token; 10403 forbidden; 60000-60300 member/band/post not found or not allowed.
const RATE_CODES = new Set([1001, 1002, 1003]);
const AUTH_CODES = new Set([10401]);

/** BAND result_code → ConnectorError. */
export function mapBandError(code: number | undefined, message: string | undefined, what: string, status = 200, body: unknown = undefined): ConnectorError {
  const msg = `band ${what}: ${code !== undefined ? `result ${code}` : `HTTP ${status}`}${message ? ` ${message}` : ""}`;
  const cause: BandFailure = { status, ...(code !== undefined ? { code } : {}), body };
  if (code !== undefined) {
    if (AUTH_CODES.has(code)) return new ConnectorError(`${msg} (access token rejected; reconnect BAND)`, "auth", false, cause);
    if (RATE_CODES.has(code)) return new ConnectorError(`${msg} (BAND quota or cool-down reached; try later)`, "rate_limit", true, cause);
    if (code === 10403) return new ConnectorError(`${msg} (this login may not do that in this band)`, "rejected", false, cause);
    if (code === 2142) return new ConnectorError(`${msg} (only band leaders may do this)`, "rejected", false, cause);
    if (code >= 60000 && code < 61000) return new ConnectorError(`${msg} (not a member, or the band or post is gone)`, "rejected", false, cause);
    return new ConnectorError(msg, "rejected", false, cause);
  }
  const { kind, retryable } = classifyHttpStatus(status);
  return new ConnectorError(msg, kind, retryable, cause);
}

function parseAuth(account: AccountRef): BandAuth {
  const p = BandAuth.safeParse(account.auth ?? {});
  if (!p.success) throw new ConnectorError(`band account ${account.handle}: auth blob needs accessToken`, "auth", false, p.error);
  return p.data;
}

function bandKeyOf(account: AccountRef): string {
  const k = (account.config as Partial<BandAccountConfig>).bandKey ?? account.externalId;
  if (!k) throw new ConnectorError(`band account ${account.handle}: no band key`, "auth", false);
  return k;
}

/** "<band>:<post>" or "<band>:<post>:<comment>". */
export function parseBandRef(externalId: string): { bandKey: string; postKey: string; commentKey?: string } {
  const parts = externalId.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !p)) throw new ConnectorError(`band: "${externalId}" is not a post or comment id`, "rejected", false);
  return { bandKey: parts[0]!, postKey: parts[1]!, ...(parts[2] ? { commentKey: parts[2] } : {}) };
}

export class BandConnector implements Connector {
  readonly name = "band";
  readonly networks: readonly Network[] = ["band"];
  readonly connectMethod = "oauth" as const;
  media?: Connector["media"];

  readonly oauth: OAuth2Client;
  private readonly apiUrl: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly recentPosts: number;
  private readonly maxBands: number;
  private readonly published = new IdempotencyCache<PublishResult>();
  private readonly replies = new IdempotencyCache<PublishResult>();

  constructor(opts: BandConnectorOptions = {}) {
    this.apiUrl = (opts.apiUrl ?? API).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.recentPosts = opts.recentPosts ?? 10;
    this.maxBands = opts.maxBands ?? 50;
    // BAND's token endpoint is documented as a GET with the parameters in the query string and the client id/secret
    // in a Basic header. OAuth2Client POSTs a form; this adapter moves the form into the query of a GET.
    // TODO(verify): whether auth.band.us/oauth2/token also accepts the POST form (then this shim can go).
    const base = opts.fetch;
    const asGet: FetchLike = (input, init) => {
      if (init?.method === "POST" && typeof init.body === "string") {
        const url = `${String(input)}${String(input).includes("?") ? "&" : "?"}${init.body}`;
        const headers = { ...(init.headers as Record<string, string>) };
        delete headers["content-type"];
        return resolveFetch(base)(url, { method: "GET", headers });
      }
      return resolveFetch(base)(input, init);
    };
    this.oauth = new OAuth2Client(
      {
        name: "band",
        authorizeUrl: opts.authorizeUrl ?? "https://auth.band.us/oauth2/authorize",
        tokenUrl: opts.tokenUrl ?? "https://auth.band.us/oauth2/token",
        // BAND has no scopes in the authorize request; access is what the person allows on the consent screen.
        scopes: [],
        pkce: false,
        clientAuth: "basic",
        ...(opts.clientId ? { clientId: opts.clientId } : {}),
        ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
      },
      asGet,
      this.now,
    );
  }

  get connectConfigured(): boolean {
    return this.oauth.configured;
  }

  capabilities(): ConnectorCapabilities {
    // Text posts (links in the text); BAND's Open API has no photo upload for posts.
    return { publish: true, fetchActivity: true, fetchMetrics: true, meteredReads: false, reply: true, moderate: true, accountMetrics: true, webhooks: false, video: false, kinds: ["post", "link"] };
  }

  // ---- connect ---------------------------------------------------------------------------

  oauthAuthorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL(this.oauth.authorizeUrl({ state: p.state, redirectUri: p.redirectUri }));
    url.searchParams.delete("scope");
    return url.toString();
  }

  /** One account per band the person belongs to and may post in. */
  async oauthConnect(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<ConnectedAccount[]> {
    const token = await this.oauth.exchange({ code: p.code, redirectUri: p.redirectUri });
    const auth = authFromToken(token);
    const profile = await this.profile(auth.accessToken).catch((err: unknown) => {
      if (err instanceof ConnectorError && err.kind === "auth") throw err;
      return null;
    });
    if (profile?.user_key) auth.userKey = profile.user_key;
    const bands = await this.bands(auth.accessToken);
    const out: ConnectedAccount[] = [];
    for (const b of bands.slice(0, this.maxBands)) {
      let permissions: string[] | null = null;
      try {
        permissions = await this.permissions(auth.accessToken, b.band_key);
      } catch (err) {
        if (err instanceof ConnectorError && (err.kind === "auth" || err.kind === "rate_limit")) throw err;
        // Unknown permissions: keep the band; publishing will say if it is not allowed.
      }
      if (permissions && !permissions.includes("posting")) continue;
      const config: BandAccountConfig = {
        bandKey: b.band_key,
        bandName: b.name ?? null,
        userKey: profile?.user_key ?? auth.userKey ?? null,
        userName: profile?.name ?? null,
        coverUrl: b.cover ?? null,
        memberCount: typeof b.member_count === "number" ? b.member_count : null,
        permissions,
      };
      out.push({ network: "band", identity: { externalId: b.band_key, handle: b.name ?? b.band_key, displayName: b.name ?? null }, auth: { ...auth }, config: { ...config } });
    }
    return out;
  }

  /** The login itself (BAND accounts are bands; this names the person who connected them). */
  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const token = typeof auth.accessToken === "string" ? auth.accessToken : null;
    if (!token) throw new ConnectorError("band: accessToken is required", "auth", false);
    const p = await this.profile(token);
    return { externalId: p.user_key ?? "me", handle: p.name ?? p.user_key ?? "band user", displayName: p.name ?? null };
  }

  /** BAND access tokens are long-lived (years); refresh only when a refresh token exists. */
  async refreshAuth(account: AccountRef): Promise<AuthRefresh | null> {
    const auth = parseAuth(account);
    if (!auth.refreshToken) return null;
    const t = await this.oauth.refresh(auth.refreshToken);
    return { auth: { ...authFromToken(t), ...(auth.userKey ? { userKey: auth.userKey } : {}) } };
  }

  private profile(token: string) {
    return this.get<{ user_key?: string; name?: string; profile_image_url?: string }>(token, "/v2/profile", {}, "profile");
  }

  private async bands(token: string) {
    const r = await this.get<{ bands?: { band_key: string; name?: string; cover?: string; member_count?: number }[] }>(token, "/v2.1/bands", {}, "bands");
    return r.bands ?? [];
  }

  // TODO(verify): GET /v2/band/permissions with permissions=posting,commenting,contents_deletion → { permissions: [...] }.
  private async permissions(token: string, bandKey: string): Promise<string[]> {
    const r = await this.get<{ permissions?: string[] }>(token, "/v2/band/permissions", { band_key: bandKey, permissions: "posting,commenting,contents_deletion" }, "permissions");
    return r.permissions ?? [];
  }

  // ---- validate & publish ---------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const content = contentOf(input);
    if (!content.trim()) issues.push({ code: "empty", message: "a BAND post needs text" });
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "BAND posts have no threads" });
    // TODO(verify): BAND's post length limit (10,000 is the platform table's figure).
    if ([...content].length > 10_000) issues.push({ code: "too_long", message: "BAND posts are limited to 10,000 characters here" });
    if (input.media.length > 10) issues.push({ code: "too_many_media", message: "at most 10 media links in a BAND post" });
    return issues;
  }

  /**
   * POST /v2.2/band/post/create with the text. Media go in as links in the text: the Open API has no photo upload.
   * TODO(verify): that post/create still accepts no image parameter (checked against third-party clients only).
   */
  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    if (input.replyToExternalId) return this.reply(account, { parentExternalId: input.replyToExternalId, text: input.text, idempotencyKey: input.idempotencyKey });
    return this.published.run(input.idempotencyKey, async () => {
      const issues = this.validate(account, input);
      if (issues.length) throw new ConnectorError(`band publish: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
      const auth = parseAuth(account);
      const bandKey = bandKeyOf(account);
      const doPush = (account.config as Partial<BandAccountConfig>).doPush === true;
      const r = await this.post<{ band_key?: string; post_key?: string }>(auth.accessToken, "/v2.2/band/post/create", { band_key: bandKey, content: contentOf(input), do_push: doPush ? "true" : "false" }, "post create");
      if (!r.post_key) throw new ConnectorError("band post create: response had no post_key", "unknown", false, r);
      return { externalId: `${bandKey}:${r.post_key}`, url: null, raw: r };
    });
  }

  // ---- inbox ----------------------------------------------------------------------------

  /**
   * New posts by other members ("message" in the band's conversation) and comments on recent posts ("comment").
   * The account's own posts and comments are skipped.
   */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const bandKey = bandKeyOf(account);
    const cfg = account.config as Partial<BandAccountConfig>;
    const me = cfg.userKey ?? auth.userKey ?? null;
    const conversation = { id: bandKey, name: cfg.bandName ?? account.handle ?? null, type: "group" as const };
    // TODO(verify): locale is required by /v2/band/posts.
    const r = await this.get<{ items?: BandPost[] }>(auth.accessToken, "/v2/band/posts", { band_key: bandKey, locale: "ko_KR" }, "posts");
    const out: ActivityInput[] = [];
    const posts = r.items ?? [];
    for (const p of posts) {
      const item = bandPostToActivity(bandKey, p, conversation, me);
      if (item && isAfter(item.occurredAt, since)) out.push(item);
    }
    for (const p of posts.slice(0, this.recentPosts)) {
      if (!p.comment_count) continue;
      const c = await this.get<{ items?: BandComment[] }>(auth.accessToken, "/v2/band/post/comments", { band_key: bandKey, post_key: p.post_key, sort: "-created_at" }, "comments");
      for (const cm of c.items ?? []) {
        const item = bandCommentToActivity(bandKey, p.post_key, cm, conversation, me);
        if (item && isAfter(item.occurredAt, since)) out.push(item);
      }
    }
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  /** Comment on the post (answering a comment comments on its post: the API has no nested replies). */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.replies.run(input.idempotencyKey, async () => {
      const ref = parseBandRef(input.parentExternalId);
      if (!input.text.trim()) throw new ConnectorError("band reply: text is empty", "rejected", false);
      const auth = parseAuth(account);
      // TODO(verify): the comment text parameter is `body` and the response carries comment_key (else none).
      const r = await this.post<{ comment_key?: string; message?: string }>(auth.accessToken, "/v2/band/post/comment/create", { band_key: ref.bandKey, post_key: ref.postKey, body: input.text }, "comment create");
      const key = r.comment_key ?? `sent-${input.idempotencyKey}`;
      return { externalId: `${ref.bandKey}:${ref.postKey}:${key}`, url: null, raw: r };
    });
  }

  /** delete → remove the login's own post or comment (band leaders may remove others'). Nothing else is offered. */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    if (input.action !== "delete") throw new ConnectorError(`band: ${input.action} is not available through the Open API (only delete)`, "rejected", false);
    const ref = parseBandRef(input.externalId);
    if (ref.commentKey?.startsWith("sent-")) throw new ConnectorError("band: this comment's id was not returned by BAND, so it cannot be removed through the API", "rejected", false);
    const auth = parseAuth(account);
    if (ref.commentKey) await this.post(auth.accessToken, "/v2/band/post/comment/remove", { band_key: ref.bandKey, post_key: ref.postKey, comment_key: ref.commentKey }, "comment remove");
    else await this.post(auth.accessToken, "/v2/band/post/remove", { band_key: ref.bandKey, post_key: ref.postKey }, "post remove");
  }

  // ---- metrics --------------------------------------------------------------------------

  /** comment_count → replies, emotion_count → likes, per post (GET /v2.1/band/post). */
  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    for (const id of externalIds) {
      let ref: ReturnType<typeof parseBandRef>;
      try {
        ref = parseBandRef(id);
      } catch {
        continue;
      }
      if (ref.commentKey) continue;
      const r = await this.get<{ post?: BandPost }>(auth.accessToken, "/v2.1/band/post", { band_key: ref.bandKey, post_key: ref.postKey }, "post");
      const p = r.post;
      if (!p) continue;
      const row = (metric: MetricName, value: unknown): MetricInput[] => (typeof value === "number" ? [{ entityType: "post_variant", entityId: id, metric, value, observedAt, source: "band" }] : []);
      const any = typeof p.comment_count === "number" || typeof p.emotion_count === "number";
      out.push(...row("likes", p.emotion_count), ...row("replies", p.comment_count), ...(any ? row("engagements", (p.emotion_count ?? 0) + (p.comment_count ?? 0)) : []));
    }
    return out;
  }

  /** followers_total = the band's member_count from the band list. */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const bandKey = bandKeyOf(account);
    const b = (await this.bands(auth.accessToken)).find((x) => x.band_key === bandKey);
    if (typeof b?.member_count !== "number") return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: b.member_count, observedAt: this.now().toISOString(), source: "band" }];
  }

  // ---- transport ------------------------------------------------------------------------

  private get<T>(token: string, path: string, params: Record<string, string>, what: string): Promise<T> {
    const q = new URLSearchParams({ ...params, access_token: token });
    return this.request<T>(token, `${this.apiUrl}${path}?${q}`, { method: "GET", headers: { accept: "application/json" } }, what);
  }

  // TODO(verify): BAND's POST endpoints read form-encoded bodies (the reference shows query parameters).
  private post<T>(token: string, path: string, params: Record<string, string>, what: string): Promise<T> {
    const body = new URLSearchParams({ ...params, access_token: token }).toString();
    return this.request<T>(token, `${this.apiUrl}${path}`, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body }, what);
  }

  private async request<T>(token: string, url: string, init: RequestInit, what: string): Promise<T> {
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(url, init);
    } catch (err) {
      throw asNetworkError(err instanceof Error ? new Error(err.message.replaceAll(token, "<token>")) : err, `band ${what}`);
    }
    const data = (await readJson(res)) as { result_code?: number; result_data?: Record<string, unknown> & { message?: string } } | string | undefined;
    const body = data && typeof data === "object" ? data : undefined;
    if (body && typeof body.result_code === "number" && body.result_code !== 1) {
      throw mapBandError(body.result_code, typeof body.result_data?.message === "string" ? body.result_data.message : undefined, what, res.status, data);
    }
    if (!res.ok) throw mapBandError(undefined, undefined, what, res.status, data);
    if (!body || body.result_code !== 1) throw new ConnectorError(`band ${what}: unexpected response`, "unknown", false, data);
    return (body.result_data ?? {}) as T;
  }
}

/** Text of the post: the text, then the link and each media URL on their own lines (unless already in the text). */
function contentOf(input: PublishInput): string {
  const extra = [input.options?.link, ...input.media.map((m) => m.url)].filter((u): u is string => !!u && !input.text.includes(u));
  return [input.text, ...extra].filter(Boolean).join("\n");
}

const tsOf = (ms: number | undefined) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** A member's post → "message" in the band's conversation. The login's own posts are skipped. */
export function bandPostToActivity(bandKey: string, p: BandPost, conversation: { id: string; name: string | null; type: "group" }, me: string | null): ActivityInput | null {
  if (me && p.author?.user_key === me) return null;
  const occurredAt = tsOf(p.created_at);
  if (!occurredAt) return null;
  const photos = (p.photos ?? []).length;
  const text = [p.content ?? "", photos ? `[${photos} photo${photos > 1 ? "s" : ""}]` : ""].filter(Boolean).join(" ") || null;
  return { network: "band", kind: "message", externalId: `${bandKey}:${p.post_key}`, authorHandle: p.author?.user_key ?? null, authorName: p.author?.name ?? null, text, url: null, parentExternalId: null, occurredAt, raw: p, conversation };
}

/** A comment on a post → "comment", parent = the post. The login's own comments are skipped. */
export function bandCommentToActivity(bandKey: string, postKey: string, c: BandComment, conversation: { id: string; name: string | null; type: "group" }, me: string | null): ActivityInput | null {
  if (me && c.author?.user_key === me) return null;
  const occurredAt = tsOf(c.created_at);
  if (!occurredAt) return null;
  return { network: "band", kind: "comment", externalId: `${bandKey}:${postKey}:${c.comment_key}`, authorHandle: c.author?.user_key ?? null, authorName: c.author?.name ?? null, text: c.content || null, url: null, parentExternalId: `${bandKey}:${postKey}`, occurredAt, raw: c, conversation };
}

function authFromToken(t: OAuth2Token): BandAuth {
  const userKey = t.raw.user_key;
  return {
    accessToken: t.accessToken,
    ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
    ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
    ...(typeof userKey === "string" ? { userKey } : {}),
  };
}

/** Registry entry for BAND: BAND_CLIENT_ID, BAND_CLIENT_SECRET (from developers.band.us). */
export function createBandConnectors(env: NodeJS.ProcessEnv): Connector[] {
  const { clientId, clientSecret } = clientFromEnv(env, "BAND");
  return [new BandConnector({ ...(clientId ? { clientId } : {}), ...(clientSecret ? { clientSecret } : {}) })];
}
