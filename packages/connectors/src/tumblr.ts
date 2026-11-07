import type { ActivityInput, ActivityKind, MetricInput, MetricName, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, isAfter, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource, openForUpload, sendBody, setMediaFile, uploadForm, type MediaReader, type StreamingForm } from "./media-io.ts";
import { OAuth2Client, clientFromEnv, type OAuth2Token } from "./oauth.ts";
import type { AccountIdentity, AccountRef, AuthRefresh, ConnectedAccount, Connector, ConnectorCapabilities, ModerationInput, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Tumblr adapter over API v2 (https://api.tumblr.com/v2) with OAuth 2.0.
 *
 * One login can post to several blogs (the primary blog plus secondary and group blogs): `oauthConnect` returns one
 * account per blog from GET /v2/user/info, all sharing the same user token. Posts are created in the Neue Post
 * Format (NPF): text blocks (one per paragraph), image/video blocks uploaded as multipart parts referenced by
 * `identifier`, and a link block for `options.link`.
 *
 * The inbox reads the blog's activity (GET /v2/blog/{blog}/notifications). The public API has no endpoint to write a
 * reply, so `reply` is not offered; `moderate` can like/unlike posts. Reblogs are out of scope.
 */

/** basic: read the user and blogs; write: create posts, like; offline_access: get a refresh token. */
export const TUMBLR_OAUTH_SCOPES = ["basic", "write", "offline_access"];

const API = "https://api.tumblr.com/v2";

/** Notification types fetched for the inbox, and the activity kind each becomes. */
// TODO(verify): the full list of notification type names (mention_in_reply / mention_in_post vs a single "mention").
const NOTIFICATION_KINDS: Record<string, ActivityKind> = {
  reply: "reply",
  reblog_with_content: "quote",
  mention: "mention",
  mention_in_reply: "mention",
  mention_in_post: "mention",
  like: "like",
  follow: "follow",
  // TODO(verify): asks are questions sent to the blog; mapped to "dm" since they are addressed to the business.
  ask: "dm",
};

export const TumblrAuth = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.string().optional(),
  scope: z.string().optional(),
  /** Blog name (the subdomain), used in every blog path. */
  blogName: z.string().min(1),
  blogUuid: z.string().optional(),
});
export type TumblrAuth = z.infer<typeof TumblrAuth>;

export interface TumblrConnectorOptions {
  clientId?: string;
  clientSecret?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** Pages of 20 notifications fetchActivity walks back. */
  maxPages?: number;
}

interface TumblrBlog {
  uuid?: string;
  name?: string;
  title?: string;
  url?: string;
  primary?: boolean;
  admin?: boolean;
  type?: string;
}

interface TumblrNotification {
  id?: string;
  type?: string;
  timestamp?: number;
  from_tumblelog_name?: string;
  from_tumblelog_uuid?: string;
  target_post_id?: string;
  target_tumblelog_name?: string;
  post_id?: string;
  reply_text?: string;
  added_text?: string;
  post_summary?: string;
  [k: string]: unknown;
}

export interface TumblrHttpFailure {
  status: number;
  body: unknown;
}

export function tumblrPostUrl(blog: string, id: string): string {
  return `https://www.tumblr.com/${blog}/${id}`;
}

function errorDetail(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 200);
  if (!body || typeof body !== "object") return "";
  const b = body as { meta?: { msg?: string }; errors?: { title?: string; detail?: string; code?: number }[]; error_description?: string };
  const errs = (b.errors ?? []).map((e) => [e.code !== undefined ? `code ${e.code}` : null, e.detail ?? e.title].filter(Boolean).join(" ")).filter(Boolean);
  return [b.meta?.msg, ...errs, b.error_description].filter(Boolean).join(": ");
}

/** HTTP status (Tumblr wraps errors in { meta, errors }) → ConnectorError. */
export function mapTumblrError(status: number, headers: Headers, body: unknown, what: string): ConnectorError {
  const detail = errorDetail(body);
  const msg = `tumblr ${what}: HTTP ${status}${detail ? ` ${detail}` : ""}`;
  const cause: TumblrHttpFailure = { status, body };
  if (status === 401) return new ConnectorError(`${msg} (token expired or revoked)`, "auth", false, cause);
  if (status === 429) {
    const after = headers.get("retry-after");
    return new ConnectorError(`${msg}; ${after ? `retry after ${after}s` : "rate limited"}`, "rate_limit", true, cause);
  }
  // 400 with the daily post limit is a quota, not a bad request.
  if (status === 400 && /limit/i.test(detail)) return new ConnectorError(`${msg} (daily posting limit reached)`, "rate_limit", true, cause);
  const { kind, retryable } = classifyHttpStatus(status);
  return new ConnectorError(msg, kind, retryable, cause);
}

function parseAuth(account: AccountRef): TumblrAuth {
  const p = TumblrAuth.safeParse({ blogName: account.handle, ...(account.auth ?? {}) });
  if (!p.success) throw new ConnectorError(`tumblr account ${account.handle}: auth blob needs accessToken and blogName`, "auth", false, p.error);
  return p.data;
}

/** Split text into NPF text blocks: one per paragraph (blank line), and long paragraphs at line breaks. */
export function textToBlocks(text: string, maxBlock = 4096): { type: "text"; text: string }[] {
  const out: { type: "text"; text: string }[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= maxBlock) {
      out.push({ type: "text", text: p });
      continue;
    }
    const pieces = p.split("\n").flatMap((line) => {
      const parts: string[] = [];
      for (let i = 0; i < line.length; i += maxBlock) parts.push(line.slice(i, i + maxBlock));
      return parts;
    });
    let buf = "";
    for (const piece of pieces) {
      if (buf && buf.length + 1 + piece.length > maxBlock) {
        out.push({ type: "text", text: buf });
        buf = "";
      }
      buf = buf ? `${buf}\n${piece}` : piece;
    }
    if (buf) out.push({ type: "text", text: buf });
  }
  return out;
}

const extOf = (mime: string) => (mime.split("/")[1] ?? "bin").replace("jpeg", "jpg").replace("quicktime", "mov");

export class TumblrConnector implements Connector {
  readonly name = "tumblr";
  readonly networks: readonly Network[] = ["tumblr"];
  readonly connectMethod = "oauth" as const;
  media?: Connector["media"];

  readonly oauth: OAuth2Client;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly maxPages: number;
  private readonly published = new IdempotencyCache<PublishResult>();
  /**
   * Every blog account of one login shares a token. When Tumblr rotates the refresh token on refresh, the other
   * blogs still hold the old one; remember old → new so their refresh in this process reuses the new token.
   */
  private readonly rotated = new Map<string, OAuth2Token>();

  constructor(opts: TumblrConnectorOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? API).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.maxPages = opts.maxPages ?? 3;
    this.oauth = new OAuth2Client(
      {
        name: "tumblr",
        authorizeUrl: "https://www.tumblr.com/oauth2/authorize",
        tokenUrl: `${API}/oauth2/token`,
        scopes: TUMBLR_OAUTH_SCOPES,
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
      // TODO(verify): the public API has no endpoint to write a reply to a post.
      reply: false,
      moderate: true,
      accountMetrics: true,
      webhooks: false,
      video: true,
      kinds: ["post", "link", "carousel", "video"],
    };
  }

  // ---- connect ---------------------------------------------------------------------------

  oauthAuthorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    return this.oauth.authorizeUrl({ state: p.state, redirectUri: p.redirectUri });
  }

  /** One account per blog the user belongs to (primary, secondary and group blogs). */
  async oauthConnect(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<ConnectedAccount[]> {
    const token = await this.oauth.exchange({ code: p.code, redirectUri: p.redirectUri });
    const blogs = await this.blogs(token.accessToken);
    return blogs.map((b) => ({
      network: "tumblr" as const,
      identity: { externalId: b.uuid!, handle: b.name!, displayName: b.title || b.name || null },
      auth: authFromToken(token, b),
      config: { blogName: b.name, blogUuid: b.uuid, primary: b.primary ?? false, ...(b.url ? { url: b.url } : {}) },
    }));
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const token = typeof auth.accessToken === "string" ? auth.accessToken : null;
    if (!token) throw new ConnectorError("tumblr: accessToken is required", "auth", false);
    const blogs = await this.blogs(token);
    const want = typeof auth.blogUuid === "string" ? auth.blogUuid : typeof auth.blogName === "string" ? auth.blogName : null;
    const b = blogs.find((x) => x.uuid === want || x.name === want) ?? blogs.find((x) => x.primary) ?? blogs[0]!;
    return { externalId: b.uuid!, handle: b.name!, displayName: b.title || b.name || null };
  }

  /** Access tokens last about 42 minutes; offline_access gives a refresh token. */
  async refreshAuth(account: AccountRef): Promise<AuthRefresh | null> {
    const auth = parseAuth(account);
    if (!auth.refreshToken) return null;
    let t = this.rotated.get(auth.refreshToken);
    if (!t || (t.expiresAt && Date.parse(t.expiresAt) <= this.now().getTime() + 60_000)) {
      // TODO(verify): whether Tumblr rotates refresh tokens (OAuth2Client keeps the old one when none comes back).
      t = await this.oauth.refresh(auth.refreshToken);
      if (t.refreshToken && t.refreshToken !== auth.refreshToken) this.rotated.set(auth.refreshToken, t);
    }
    return { auth: authFromToken(t, { name: auth.blogName, ...(auth.blogUuid ? { uuid: auth.blogUuid } : {}) }) };
  }

  private async blogs(token: string): Promise<TumblrBlog[]> {
    const r = await this.request<{ user?: { name?: string; blogs?: TumblrBlog[] } }>(token, "GET", "/user/info", { what: "user info" });
    const blogs = (r.user?.blogs ?? []).filter((b) => b.uuid && b.name);
    if (blogs.length === 0) throw new ConnectorError("tumblr user info: this login has no blogs", "auth", false, r);
    return blogs;
  }

  // ---- validate & publish ---------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const o = input.options ?? {};
    if (!input.text.trim() && input.media.length === 0 && !o.link) issues.push({ code: "empty", message: "a Tumblr post needs text, media or a link" });
    if (input.media.some((m) => m.kind === "document")) issues.push({ code: "unsupported_media", message: "tumblr does not accept documents" });
    if (input.media.length > 10) issues.push({ code: "too_many_media", message: `${input.media.length} > 10 media in one Tumblr post` });
    // TODO(verify): one video per post.
    if (input.media.filter((m) => m.kind === "video").length > 1) issues.push({ code: "unsupported_media", message: "a Tumblr post carries at most one video" });
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "tumblr posts have no threads" });
    for (const t of o.tags ?? []) if (t.length > 140) issues.push({ code: "too_long", message: `tag "${t.slice(0, 20)}…" is longer than 140 characters` });
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.published.run(input.idempotencyKey, () => this.createPost(account, parseAuth(account), input));
  }

  private async createPost(account: AccountRef, auth: TumblrAuth, input: PublishInput): Promise<PublishResult> {
    const issues = this.validate(account, input);
    if (issues.length) throw new ConnectorError(`tumblr publish: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
    const o = input.options ?? {};
    const content: Record<string, unknown>[] = [];
    if (o.title) content.push({ type: "text", subtype: "heading1", text: o.title });
    content.push(...textToBlocks(input.text));
    // Videos are opened for streaming: the multipart body is then streamed with an exact Content-Length.
    const files: { identifier: string; file: MediaReader; mime: string }[] = [];
    let r: { id?: string | number; id_string?: string };
    try {
      for (const [i, m] of input.media.entries()) {
        const file = await openForUpload(mediaSource(this.media, this.fetchImpl), m);
        const mime = file.mime;
        const identifier = `${m.kind === "video" ? "video" : "image"}${i}`;
        files.push({ identifier, file, mime });
        const media = { type: mime, identifier, ...(m.width ? { width: m.width } : {}), ...(m.height ? { height: m.height } : {}) };
        // Image blocks take an array of sizes; video blocks a single media object.
        content.push(m.kind === "video" ? { type: "video", media } : { type: "image", media: [media], ...(m.alt ? { alt_text: m.alt } : {}) });
      }
      if (o.link) content.push({ type: "link", url: o.link, ...(o.title ? { title: o.title } : {}) });
      const post: Record<string, unknown> = {
        content,
        state: "published",
        ...(o.tags?.length ? { tags: o.tags.map((t) => t.replace(/,/g, " ").replace(/^#/, "")).join(",") } : {}),
      };
      const path = `/blog/${encodeURIComponent(auth.blogName)}/posts`;
      if (files.length === 0) {
        r = await this.request(auth.accessToken, "POST", path, { json: post, what: "create post" });
      } else {
        // Multipart: the post JSON in a "json" part, each file in a part named by its identifier.
        // TODO(verify): NPF also accepts `media: [{ url }]` for public URLs; uploading bytes is the documented path.
        const form = uploadForm(files.map((f) => f.file));
        form.set("json", new Blob([JSON.stringify(post)], { type: "application/json" }));
        for (const f of files) setMediaFile(form, f.identifier, f.file, `${f.identifier}.${extOf(f.mime)}`);
        r = await this.request(auth.accessToken, "POST", path, { form, what: "create post" });
      }
    } finally {
      for (const f of files) await f.file.close();
    }
    const id = r.id_string ?? (r.id !== undefined ? String(r.id) : undefined);
    if (!id) throw new ConnectorError("tumblr create post: response had no id", "unknown", false, r);
    return { externalId: id, url: tumblrPostUrl(auth.blogName, id), raw: r };
  }

  // ---- inbox ----------------------------------------------------------------------------

  /** The blog's activity: replies, reblogs with comments, mentions, likes, follows, asks. */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const out: ActivityInput[] = [];
    let before: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const q = new URLSearchParams();
      for (const t of Object.keys(NOTIFICATION_KINDS)) q.append("types[]", t);
      if (before) q.set("before", before);
      const r = await this.request<{ notifications?: TumblrNotification[]; _links?: { next?: { query_params?: { before?: string | number } } } }>(
        auth.accessToken,
        "GET",
        `/blog/${encodeURIComponent(auth.blogName)}/notifications?${q}`,
        { what: "notifications" },
      );
      let older = false;
      for (const n of r.notifications ?? []) {
        const item = tumblrNotificationToActivity(n, auth.blogName);
        if (!item) continue;
        if (!isAfter(item.occurredAt, since)) {
          older = true;
          continue;
        }
        out.push(item);
      }
      const next = r._links?.next?.query_params?.before;
      if (next === undefined || older) break;
      before = String(next);
    }
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  /** like/unlike a post. externalId is "<blog>:<post id>" (activity items) or a post id on the account's own blog. */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    if (input.action !== "like" && input.action !== "unlike") throw new ConnectorError(`tumblr cannot ${input.action} content through the API`, "rejected", false);
    const auth = parseAuth(account);
    const [blog, id] = splitPostRef(input.externalId, auth.blogName);
    const post = await this.request<{ id_string?: string; reblog_key?: string; post?: { reblog_key?: string } }>(auth.accessToken, "GET", `/blog/${encodeURIComponent(blog)}/posts/${encodeURIComponent(id)}`, { what: "read post" });
    const reblogKey = post.reblog_key ?? post.post?.reblog_key;
    if (!reblogKey) throw new ConnectorError(`tumblr ${input.action}: post ${blog}/${id} has no reblog_key`, "unknown", false, post);
    await this.request(auth.accessToken, "POST", `/user/${input.action}`, { json: { id, reblog_key: reblogKey }, what: input.action });
  }

  // ---- metrics --------------------------------------------------------------------------

  /** Notes per post: total notes (engagements), likes and reblogs when the notes endpoint reports them. */
  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    for (const externalId of externalIds) {
      const [blog, id] = splitPostRef(externalId, auth.blogName);
      // TODO(verify): mode=all returns total_notes, total_likes and total_reblogs alongside the notes page.
      const r = await this.request<{ total_notes?: number; total_likes?: number; total_reblogs?: number; notes?: { type?: string }[] }>(
        auth.accessToken,
        "GET",
        `/blog/${encodeURIComponent(blog)}/notes?${new URLSearchParams({ id, mode: "all" })}`,
        { what: "notes" },
      );
      const row = (metric: MetricName, value: unknown): MetricInput[] => (typeof value === "number" ? [{ entityType: "post_variant", entityId: externalId, metric, value, observedAt, source: "tumblr" }] : []);
      out.push(...row("engagements", r.total_notes), ...row("likes", r.total_likes), ...row("reposts", r.total_reblogs));
    }
    return out;
  }

  /** followers_total from /blog/{blog}/followers (the blog's owner only). */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const r = await this.request<{ total_users?: number }>(auth.accessToken, "GET", `/blog/${encodeURIComponent(auth.blogName)}/followers?limit=1`, { what: "followers" });
    if (typeof r.total_users !== "number") return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: r.total_users, observedAt: this.now().toISOString(), source: "tumblr" }];
  }

  // ---- transport ------------------------------------------------------------------------

  private async request<T>(token: string, method: string, path: string, opts: { json?: unknown; form?: FormData | StreamingForm; what: string }): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
    let body: string | FormData | StreamingForm | undefined;
    if (opts.form) body = opts.form;
    else if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    let res: Response;
    try {
      res = await sendBody(resolveFetch(this.fetchImpl), `${this.baseUrl}${path}`, { method, headers }, body);
    } catch (err) {
      throw asNetworkError(err, `tumblr ${opts.what}`);
    }
    const data = await readJson(res);
    if (!res.ok) throw mapTumblrError(res.status, res.headers, data, opts.what);
    const env = (data ?? {}) as { response?: unknown };
    return (env.response ?? {}) as T;
  }
}

function splitPostRef(externalId: string, ownBlog: string): [string, string] {
  const i = externalId.lastIndexOf(":");
  return i > 0 ? [externalId.slice(0, i), externalId.slice(i + 1)] : [ownBlog, externalId];
}

/** One notification → activity. Unknown types are dropped. */
export function tumblrNotificationToActivity(n: TumblrNotification, blogName: string): ActivityInput | null {
  const kind = n.type ? NOTIFICATION_KINDS[n.type] : undefined;
  if (!kind || typeof n.timestamp !== "number") return null;
  const from = n.from_tumblelog_name ?? null;
  const occurredAt = new Date(n.timestamp * 1000).toISOString();
  const target = n.target_post_id ? String(n.target_post_id) : null;
  const targetBlog = n.target_tumblelog_name ?? blogName;
  const parentExternalId = target ? `${targetBlog}:${target}` : null;
  // Reblogs and mentions in posts are posts on the other blog: their own id lets moderate (like) find them.
  const ownPost = (kind === "quote" || n.type === "mention_in_post") && n.post_id && from ? `${from}:${n.post_id}` : null;
  const externalId = ownPost ?? (n.id ? `notification:${n.id}` : `${n.type}:${from ?? "?"}:${target ?? "-"}:${n.timestamp}`);
  const text = n.reply_text ?? n.added_text ?? (kind === "dm" || kind === "mention" ? (n.post_summary ?? null) : null);
  const url = ownPost && from && n.post_id ? tumblrPostUrl(from, String(n.post_id)) : target ? tumblrPostUrl(targetBlog, target) : from ? `https://www.tumblr.com/${from}` : null;
  return {
    network: "tumblr",
    kind,
    externalId,
    authorHandle: from,
    authorName: null,
    text: typeof text === "string" && text ? text : null,
    url,
    parentExternalId: kind === "follow" ? null : parentExternalId,
    occurredAt,
    raw: n,
  };
}

function authFromToken(t: OAuth2Token, blog: { name?: string; uuid?: string }): TumblrAuth {
  return {
    accessToken: t.accessToken,
    ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
    ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
    ...(t.scope ? { scope: t.scope } : {}),
    blogName: blog.name ?? "",
    ...(blog.uuid ? { blogUuid: blog.uuid } : {}),
  };
}

/** Registry entry for Tumblr (TUMBLR_CLIENT_ID / TUMBLR_CLIENT_SECRET). */
export function createTumblrConnectors(env: NodeJS.ProcessEnv): Connector[] {
  const { clientId, clientSecret } = clientFromEnv(env, "TUMBLR");
  return [new TumblrConnector({ ...(clientId ? { clientId } : {}), ...(clientSecret ? { clientSecret } : {}) })];
}
