import type { ActivityInput, ActivityKind, Media, MetricInput, MetricName, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, downloadMedia, isAfter, isoSeconds, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource, withMedia } from "./media-io.ts";
import type { AccountRef, AuthRefresh, Connector, ConnectorCapabilities, MediaFetcher, ModerationInput, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/** OAuth 2.0 user-context credentials for one X account. `userId` is the numeric X user id. */
export const XAuth = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  /** ISO timestamp; informational, the API's 401 is the source of truth. */
  expiresAt: z.string().optional(),
  userId: z.string().min(1),
});
export type XAuth = z.infer<typeof XAuth>;

export interface XConnectorOptions {
  /** OAuth 2.0 app credentials; needed only for refreshAuth(). A missing secret means a public (PKCE) client. */
  clientId?: string;
  clientSecret?: string;
  baseUrl?: string;
  /** Where people authorize the app (default https://x.com/i/oauth2/authorize). */
  authorizeUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** Upper bound on pages (100 tweets each) walked per timeline; each page costs money. */
  maxPages?: number;
  /** Bytes per APPEND segment in chunked upload (default 4 MiB; X allows up to 5 MB per segment). */
  chunkBytes?: number;
  /** How many STATUS checks to make while X processes a video before giving up with a retryable error. */
  maxProcessingChecks?: number;
  /** Injectable sleep so tests do not wait on check_after_secs. */
  sleep?: (ms: number) => Promise<void>;
}

/** The parts of X's v2 tweet object we read. */
export interface XTweet {
  id: string;
  text?: string;
  created_at?: string;
  author_id?: string;
  conversation_id?: string;
  referenced_tweets?: { type: "replied_to" | "quoted" | "retweeted" | (string & {}); id: string }[];
  public_metrics?: Record<string, number>;
  non_public_metrics?: Record<string, number>;
}

export interface XUser {
  id: string;
  username?: string;
  name?: string;
}

interface XTimelineResponse {
  data?: XTweet[];
  includes?: { users?: XUser[] };
  meta?: { next_token?: string; result_count?: number };
  errors?: unknown[];
}

/** Attached as `cause` on every ConnectorError raised from an HTTP response so callers can branch on status. */
export interface XHttpFailure {
  status: number;
  body: unknown;
}

const TWEET_FIELDS = "created_at,author_id,conversation_id,referenced_tweets";

export function xTweetUrl(username: string | undefined | null, id: string): string {
  // x.com/i/web/status/<id> resolves without knowing the author; used when the user expansion is missing.
  return `https://x.com/${username ?? "i/web"}/status/${id}`;
}

function xErrorDetail(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 200);
  if (!body || typeof body !== "object") return "";
  const b = body as { title?: unknown; detail?: unknown; error?: unknown; error_description?: unknown; errors?: { message?: unknown; detail?: unknown }[] };
  const first = Array.isArray(b.errors) ? b.errors[0] : undefined;
  return [b.title, b.detail, first?.message, first?.detail, b.error, b.error_description].filter((x): x is string => typeof x === "string").join(": ");
}

/**
 * HTTP status → ConnectorError for X. 403 is ambiguous on X: on a create it means the request was
 * refused (duplicate text, disallowed reply), elsewhere it means the token lacks a scope.
 */
export function mapXError(status: number, headers: Headers, body: unknown, ctx: { what: string; creating: boolean }): ConnectorError {
  const detail = xErrorDetail(body);
  const msg = `x ${ctx.what}: HTTP ${status}${detail ? ` ${detail}` : ""}`;
  const cause: XHttpFailure = { status, body };
  if (status === 401) return new ConnectorError(`${msg} (token rejected; refreshAuth() can mint a new one when a refresh token is on file)`, "auth", false, cause);
  if (status === 403) return new ConnectorError(msg, ctx.creating ? "rejected" : "auth", false, cause);
  if (status === 429) {
    const reset = headers.get("x-rate-limit-reset");
    const resetAt = reset && Number.isFinite(Number(reset)) ? new Date(Number(reset) * 1000).toISOString() : "unknown";
    return new ConnectorError(`${msg}; rate limit resets at ${resetAt} (x-rate-limit-reset=${reset ?? "?"})`, "rate_limit", true, cause);
  }
  const { kind, retryable } = classifyHttpStatus(status);
  return new ConnectorError(msg, kind, retryable, cause);
}

function xStatusOf(err: unknown): number | undefined {
  const cause = err instanceof ConnectorError ? (err.cause as Partial<XHttpFailure> | undefined) : undefined;
  return typeof cause?.status === "number" ? cause.status : undefined;
}

/**
 * Native X (Twitter) adapter over API v2 with OAuth 2.0 user-context tokens.
 *
 * Reads are metered: every tweet object returned by any read endpoint increments `readsUsed`, which
 * core uses to enforce spend caps. The adapter never refreshes tokens behind core's back, because X
 * rotates refresh tokens and the new pair has to be persisted; on 401 it throws an auth error and
 * core calls refreshAuth() explicitly.
 */
/**
 * Scopes a Starsign X account needs: read and write posts, read the user, upload media, like/unlike,
 * hide replies, refresh without the user.
 */
export const X_OAUTH_SCOPES = ["tweet.read", "tweet.write", "users.read", "media.write", "like.write", "tweet.moderate.write", "offline.access"];

/** X polls: 2 to 4 options of at most 25 characters, open 5 minutes to 7 days. */
const X_POLL = { minOptions: 2, maxOptions: 4, maxOptionChars: 25, minMinutes: 5, maxMinutes: 10080 } as const;
/** Media items that went up for an idempotency key, so a retry after "still processing" polls instead of re-uploading. */
interface UploadedMedia {
  id: string;
  /** Video and GIF uploads are processed asynchronously and must reach "succeeded" before a tweet can use them. */
  async: boolean;
}

export class XConnector implements Connector {
  readonly connectMethod = "oauth" as const;

  get connectConfigured(): boolean {
    return !!this.clientId;
  }

  oauthAuthorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    if (!this.clientId) throw new ConnectorError("x oauth: X_CLIENT_ID is not configured", "auth", false);
    const q = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: p.redirectUri,
      scope: X_OAUTH_SCOPES.join(" "),
      state: p.state,
      code_challenge: p.codeChallenge,
      code_challenge_method: "S256",
    });
    return `${this.authorizeBase}?${q}`;
  }

  async oauthExchange(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<Record<string, unknown>> {
    if (!this.clientId) throw new ConnectorError("x oauth: X_CLIENT_ID is not configured", "auth", false);
    const form = new URLSearchParams({ grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (this.clientSecret) headers.authorization = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
    else form.set("client_id", this.clientId);
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(`${this.baseUrl}/2/oauth2/token`, { method: "POST", headers, body: form.toString() });
    } catch (err) {
      throw asNetworkError(err, "x oauth");
    }
    const body = await readJson(res);
    if (!res.ok) throw new ConnectorError(`x oauth: code exchange failed (HTTP ${res.status} ${xErrorDetail(body)})`, "auth", false, { status: res.status, body } satisfies XHttpFailure);
    const token = (body ?? {}) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    if (typeof token.access_token !== "string") throw new ConnectorError("x oauth: token response had no access_token", "unknown", false, body);
    const me = await this.describeAccount({ accessToken: token.access_token });
    const auth: XAuth = {
      accessToken: token.access_token,
      ...(typeof token.refresh_token === "string" ? { refreshToken: token.refresh_token } : {}),
      userId: me.externalId,
      ...(typeof token.expires_in === "number" ? { expiresAt: new Date(this.now().getTime() + token.expires_in * 1000).toISOString() } : {}),
    };
    return auth;
  }

  /** Whose token is this: GET /2/users/me. */
  async describeAccount(auth: Record<string, unknown>) {
    const token = typeof auth.accessToken === "string" ? auth.accessToken : null;
    if (!token) throw new ConnectorError("x: accessToken is required", "auth", false);
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(`${this.baseUrl}/2/users/me`, { headers: { authorization: `Bearer ${token}` } });
    } catch (err) {
      throw asNetworkError(err, "x users/me");
    }
    const body = await readJson(res);
    if (!res.ok) throw mapXError(res.status, res.headers, body, { what: "users/me", creating: false });
    const data = (body as { data?: { id?: string; username?: string; name?: string } } | null)?.data;
    if (!data?.id || !data.username) throw new ConnectorError("x users/me: response had no id/username", "unknown", false, body);
    return { externalId: data.id, handle: data.username, displayName: data.name ?? null };
  }
  readonly name = "x";
  readonly networks: readonly Network[] = ["x"];
  /** Tweet objects returned by read endpoints since construction. */
  readsUsed = 0;

  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly baseUrl: string;
  private readonly authorizeBase: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly maxPages: number;
  private readonly chunkBytes: number;
  private readonly maxProcessingChecks: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  private readonly progress = new Map<string, string[]>();
  private readonly uploaded = new Map<string, UploadedMedia[]>();
  /** Set by core at boot; falls back to downloading `media.url`. */
  media?: MediaFetcher;

  constructor(opts: XConnectorOptions = {}) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.baseUrl = (opts.baseUrl ?? "https://api.x.com").replace(/\/+$/, "");
    this.authorizeBase = opts.authorizeUrl ?? "https://x.com/i/oauth2/authorize";
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.maxPages = opts.maxPages ?? 5;
    this.chunkBytes = opts.chunkBytes ?? 4 * 1024 * 1024;
    this.maxProcessingChecks = opts.maxProcessingChecks ?? 30;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  capabilities(): ConnectorCapabilities {
    return { publish: true, fetchActivity: true, fetchMetrics: true, meteredReads: true, reply: true, moderate: true, accountMetrics: true, webhooks: false, video: true, kinds: ["post", "video", "poll"] };
  }

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const motion = input.media.filter((m) => m.kind === "video" || m.kind === "gif");
    for (const m of input.media) {
      if (m.kind === "document") issues.push({ code: "unsupported_media", message: "x has no document attachments" });
    }
    // A tweet carries up to 4 images, or exactly one video or GIF.
    if (motion.length > 0 && input.media.length > 1) issues.push({ code: "too_many_media", message: "x allows one video or GIF per tweet, and it cannot be mixed with images" });
    const poll = input.options?.poll;
    if (poll) {
      if (input.media.length > 0) issues.push({ code: "unsupported_media", message: "x polls cannot carry media" });
      if (poll.options.length < X_POLL.minOptions || poll.options.length > X_POLL.maxOptions) issues.push({ code: "too_many_media", message: `x polls take ${X_POLL.minOptions} to ${X_POLL.maxOptions} options (got ${poll.options.length})` });
      for (const o of poll.options) if ([...o].length > X_POLL.maxOptionChars) issues.push({ code: "too_long", message: `x poll option "${o.slice(0, 30)}" is longer than ${X_POLL.maxOptionChars} characters` });
    }
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, () => this.publishSegments(account, parseAuth(account), input));
  }

  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const mentions = await this.timeline(account, auth, `/2/users/${auth.userId}/mentions`, since, {}, (t, users) => this.mentionToActivity(t, users));
    const own = await this.timeline(account, auth, `/2/users/${auth.userId}/tweets`, since, { exclude: "retweets" }, (t, users) => this.ownTweetToActivity(t, users, account));
    return [...mentions, ...own].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    if (externalIds.length === 0) return [];
    const auth = parseAuth(account);
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    // GET /2/tweets takes at most 100 ids per call.
    for (let i = 0; i < externalIds.length; i += 100) {
      for (const t of await this.lookup(account, auth, externalIds.slice(i, i + 100).join(","))) out.push(...tweetMetrics(t, observedAt));
    }
    return out;
  }

  /**
   * Exchange the refresh token for a new access token. Returns null when there is nothing to refresh
   * with (no refresh token), so core knows the user has to re-authorize.
   */
  async refreshAuth(account: AccountRef): Promise<AuthRefresh | null> {
    const auth = parseAuth(account);
    if (!auth.refreshToken) return null;
    if (!this.clientId) throw new ConnectorError("x refreshAuth: no clientId configured (X_CLIENT_ID), cannot refresh tokens", "auth", false);
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: auth.refreshToken });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    // Confidential clients authenticate with Basic auth; public (PKCE-only) clients name themselves in the body.
    if (this.clientSecret) headers.authorization = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
    else form.set("client_id", this.clientId);

    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(`${this.baseUrl}/2/oauth2/token`, { method: "POST", headers, body: form.toString() });
    } catch (err) {
      throw asNetworkError(err, "x refreshAuth");
    }
    const body = await readJson(res);
    if (!res.ok) {
      // invalid_grant (400) or 401 here means the refresh token itself is dead; only the user can fix that.
      if (res.status === 400 || res.status === 401) throw new ConnectorError(`x refreshAuth: refresh token rejected (HTTP ${res.status} ${xErrorDetail(body)}); user must re-authorize`, "auth", false, { status: res.status, body } satisfies XHttpFailure);
      throw mapXError(res.status, res.headers, body, { what: "refreshAuth", creating: false });
    }
    const token = (body ?? {}) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    if (typeof token.access_token !== "string") throw new ConnectorError("x refreshAuth: token response had no access_token", "unknown", false, body);
    const next: XAuth = {
      accessToken: token.access_token,
      // X rotates refresh tokens; keep the old one only if the response did not issue a new one.
      refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : auth.refreshToken,
      userId: auth.userId,
      ...(typeof token.expires_in === "number" ? { expiresAt: new Date(this.now().getTime() + token.expires_in * 1000).toISOString() } : {}),
    };
    return { auth: next };
  }

  /** Reply to a tweet (POST /2/tweets with reply.in_reply_to_tweet_id). */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const res = await this.request<{ data?: { id?: string } }>(account, auth, "POST", "/2/tweets", { json: { text: input.text, reply: { in_reply_to_tweet_id: input.parentExternalId } }, creating: true });
      const id = res.data?.id;
      if (!id) throw new ConnectorError("x reply: response carried no tweet id", "unknown", false, res);
      return { externalId: id, url: xTweetUrl(account.handle, id), raw: res };
    });
  }

  /**
   * like/unlike (POST/DELETE /2/users/:id/likes), hide/unhide a reply to one of our conversations
   * (PUT /2/tweets/:id/hidden), delete our own tweet (DELETE /2/tweets/:id).
   */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    const auth = parseAuth(account);
    const id = encodeURIComponent(input.externalId);
    switch (input.action) {
      case "like":
        await this.request(account, auth, "POST", `/2/users/${auth.userId}/likes`, { json: { tweet_id: input.externalId }, creating: true });
        return;
      case "unlike":
        await this.request(account, auth, "DELETE", `/2/users/${auth.userId}/likes/${id}`, { creating: true });
        return;
      case "hide":
      case "unhide":
        await this.request(account, auth, "PUT", `/2/tweets/${id}/hidden`, { json: { hidden: input.action === "hide" }, creating: true });
        return;
      case "delete":
        await this.request(account, auth, "DELETE", `/2/tweets/${id}`, { creating: true });
        return;
    }
  }

  /** followers_total from GET /2/users/me?user.fields=public_metrics. Counts as one metered read. */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const res = await this.request<{ data?: { public_metrics?: Record<string, number> } }>(account, auth, "GET", "/2/users/me", { query: { "user.fields": "public_metrics" } });
    this.readsUsed += 1;
    const followers = res.data?.public_metrics?.followers_count;
    if (typeof followers !== "number") return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: followers, observedAt: this.now().toISOString(), source: "x" }];
  }

  // ---- publishing -------------------------------------------------------------------------

  private async publishSegments(account: AccountRef, auth: XAuth, input: PublishInput): Promise<PublishResult> {
    const key = input.idempotencyKey;
    const segments = [input.text, ...input.thread];
    // Segments already posted by an earlier, failed attempt are not posted again.
    const posted: string[] = this.progress.get(key) ?? [];
    const mediaIds = posted.length === 0 ? await this.prepareMedia(account, auth, key, input.media) : [];
    const poll = input.options?.poll;

    try {
      for (let i = posted.length; i < segments.length; i++) {
        const parent = posted[posted.length - 1] ?? input.replyToExternalId ?? undefined;
        const body: Record<string, unknown> = { text: segments[i] ?? "" };
        if (parent) body.reply = { in_reply_to_tweet_id: parent };
        if (i === 0 && mediaIds.length > 0) body.media = { media_ids: mediaIds };
        if (i === 0 && poll && mediaIds.length === 0) body.poll = { options: poll.options, duration_minutes: Math.min(X_POLL.maxMinutes, Math.max(X_POLL.minMinutes, poll.durationMinutes)) };
        const res = await this.request<{ data?: { id?: string } }>(account, auth, "POST", "/2/tweets", { json: body, creating: true });
        const id = res.data?.id;
        if (!id) throw new ConnectorError("x publish: response carried no tweet id", "unknown", false, res);
        posted.push(id);
        this.progress.set(key, posted);
      }
    } catch (err) {
      // Part of the thread is live: tell core which ids exist so the variant is never an orphan on the network.
      const root = posted[0];
      if (root) {
        const ce = err instanceof ConnectorError ? err : new ConnectorError(err instanceof Error ? err.message : String(err), "unknown", true, err);
        ce.partial = { externalId: root, url: xTweetUrl(account.handle, root), threadExternalIds: [...posted] };
        throw ce;
      }
      throw err;
    }

    const root = posted[0];
    if (!root) throw new ConnectorError("x publish: nothing to post", "rejected", false);
    this.progress.delete(key);
    this.uploaded.delete(key);
    return {
      externalId: root,
      url: xTweetUrl(account.handle, root),
      // Every tweet of the thread in order, root included, so metrics can follow each segment.
      ...(input.thread.length > 0 ? { threadExternalIds: [...posted] } : {}),
      raw: { ids: posted },
    };
  }

  /**
   * Upload every attachment once per idempotency key and wait until X has processed the async ones.
   * A retry after "still processing" re-checks the same media ids instead of uploading again.
   */
  private async prepareMedia(account: AccountRef, auth: XAuth, key: string, media: Media[]): Promise<string[]> {
    let items = this.uploaded.get(key);
    if (!items) {
      items = [];
      for (const m of media) {
        if (m.kind === "document") continue; // validate() refuses documents
        items.push(m.kind === "image" ? { id: await this.uploadSimple(account, auth, m), async: false } : { id: await this.uploadChunked(account, auth, m), async: true });
        if (m.alt) await this.setAltText(account, auth, items[items.length - 1]!.id, m.alt);
      }
      this.uploaded.set(key, items);
    }
    for (const it of items) if (it.async) await this.waitForProcessing(account, auth, it.id);
    return items.map((i) => i.id);
  }

  private async bytesOf(m: Media): Promise<{ bytes: Uint8Array; mime: string }> {
    return this.media ? this.media.fetch(m) : downloadMedia(resolveFetch(this.fetchImpl), m);
  }

  /** v2 one-shot upload (POST /2/media/upload, multipart) for still images. */
  private async uploadSimple(account: AccountRef, auth: XAuth, m: Media): Promise<string> {
    const { bytes, mime } = await this.bytesOf(m);
    const form = new FormData();
    form.set("media", new Blob([bytes], { type: mime }), `upload.${mime.split("/")[1] ?? "bin"}`);
    form.set("media_category", "tweet_image");
    form.set("media_type", mime);
    const res = await this.request<{ data?: { id?: string; media_key?: string } }>(account, auth, "POST", "/2/media/upload", { form, creating: true });
    const id = res.data?.id ?? res.data?.media_key;
    if (!id) throw new ConnectorError("x media upload: response carried no media id", "unknown", false, res);
    return id;
  }

  /**
   * v2 chunked upload for video and GIF: initialize → append segments → finalize.
   * TODO(verify): path-style endpoints (/2/media/upload/initialize, /{id}/append, /{id}/finalize) replaced the
   * command-style INIT/APPEND/FINALIZE on /2/media/upload in 2025; X's quickstart still shows the old form.
   */
  private async uploadChunked(account: AccountRef, auth: XAuth, m: Media): Promise<string> {
    // The file is read one segment at a time (ranged reads), so a large video never sits in memory whole.
    return withMedia(mediaSource(this.media, this.fetchImpl), m, async (file) => {
      const category = m.kind === "gif" ? "tweet_gif" : "tweet_video";
      const init = await this.request<{ data?: { id?: string } }>(account, auth, "POST", "/2/media/upload/initialize", { json: { media_type: file.mime, total_bytes: file.size, media_category: category }, creating: true });
      const id = init.data?.id;
      if (!id) throw new ConnectorError("x media initialize: response carried no media id", "unknown", false, init);
      let segment = 0;
      for await (const chunk of file.chunks(this.chunkBytes)) {
        const form = new FormData();
        form.set("segment_index", String(segment++));
        form.set("media", new Blob([chunk], { type: "application/octet-stream" }), "chunk");
        await this.request(account, auth, "POST", `/2/media/upload/${id}/append`, { form, creating: true });
      }
      await this.request(account, auth, "POST", `/2/media/upload/${id}/finalize`, { creating: true });
      return id;
    });
  }

  /** TODO(verify): v2 alt text lives at POST /2/media/metadata with { id, metadata: { alt_text: { text } } }. */
  private async setAltText(account: AccountRef, auth: XAuth, id: string, alt: string): Promise<void> {
    await this.request(account, auth, "POST", "/2/media/metadata", { json: { id, metadata: { alt_text: { text: alt.slice(0, 1000) } } }, creating: true });
  }

  /** Poll GET /2/media/upload?command=STATUS until processing succeeds; bounded, then a retryable error. */
  private async waitForProcessing(account: AccountRef, auth: XAuth, id: string): Promise<void> {
    for (let i = 0; i < this.maxProcessingChecks; i++) {
      const res = await this.request<{ data?: { processing_info?: { state?: string; check_after_secs?: number; error?: { message?: string } } } }>(account, auth, "GET", "/2/media/upload", { query: { command: "STATUS", media_id: id } });
      const info = res.data?.processing_info;
      // No processing_info means nothing is pending for this media.
      if (!info || info.state === "succeeded") return;
      if (info.state === "failed") throw new ConnectorError(`x media ${id}: processing failed${info.error?.message ? `: ${info.error.message}` : ""}`, "rejected", false, res);
      await this.sleep(Math.min(30, Math.max(1, info.check_after_secs ?? 2)) * 1000);
    }
    throw new ConnectorError(`x media ${id}: still processing after ${this.maxProcessingChecks} checks; retry later (the upload is kept)`, "unknown", true);
  }

  // ---- reading ----------------------------------------------------------------------------

  private async timeline(
    account: AccountRef,
    auth: XAuth,
    path: string,
    since: Date | null,
    extraQuery: Record<string, string>,
    map: (t: XTweet, users: Map<string, XUser>) => ActivityInput,
  ): Promise<ActivityInput[]> {
    const out: ActivityInput[] = [];
    let next: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const res = await this.request<XTimelineResponse>(account, auth, "GET", path, {
        query: {
          "tweet.fields": TWEET_FIELDS,
          expansions: "author_id",
          "user.fields": "username,name",
          max_results: "100",
          ...(since ? { start_time: isoSeconds(since) } : {}),
          ...(next ? { pagination_token: next } : {}),
          ...extraQuery,
        },
      });
      const tweets = res.data ?? [];
      this.readsUsed += tweets.length;
      const users = new Map((res.includes?.users ?? []).map((u) => [u.id, u] as const));
      for (const t of tweets) {
        if (t.created_at && !isAfter(t.created_at, since)) continue;
        out.push(map(t, users));
      }
      next = res.meta?.next_token;
      if (!next || tweets.length === 0) break;
    }
    return out;
  }

  private async lookup(account: AccountRef, auth: XAuth, ids: string): Promise<XTweet[]> {
    const get = (fields: string) => this.request<XTimelineResponse>(account, auth, "GET", "/2/tweets", { query: { ids, "tweet.fields": fields } });
    let res: XTimelineResponse;
    try {
      res = await get("public_metrics,non_public_metrics");
    } catch (err) {
      // non_public_metrics exist only for the authenticated user's own tweets; X answers 403 for
      // anyone else's, so fall back to what everyone can see.
      if (xStatusOf(err) !== 403) throw err;
      res = await get("public_metrics");
    }
    const tweets = res.data ?? [];
    this.readsUsed += tweets.length;
    return tweets;
  }

  private mentionToActivity(t: XTweet, users: Map<string, XUser>): ActivityInput {
    const author = t.author_id ? users.get(t.author_id) : undefined;
    const replied = t.referenced_tweets?.find((r) => r.type === "replied_to");
    const quoted = t.referenced_tweets?.find((r) => r.type === "quoted");
    const kind: ActivityKind = replied ? "reply" : quoted ? "quote" : "mention";
    return {
      network: "x",
      kind,
      externalId: t.id,
      authorHandle: author?.username ?? null,
      authorName: author?.name ?? null,
      text: t.text ?? null,
      url: xTweetUrl(author?.username, t.id),
      parentExternalId: replied?.id ?? quoted?.id ?? null,
      occurredAt: t.created_at ?? this.now().toISOString(),
      raw: t,
    };
  }

  private ownTweetToActivity(t: XTweet, users: Map<string, XUser>, account: AccountRef): ActivityInput {
    const author = t.author_id ? users.get(t.author_id) : undefined;
    const handle = author?.username ?? account.handle;
    const replied = t.referenced_tweets?.find((r) => r.type === "replied_to");
    return {
      network: "x",
      kind: "own_post",
      externalId: t.id,
      authorHandle: handle,
      authorName: author?.name ?? null,
      text: t.text ?? null,
      url: xTweetUrl(handle, t.id),
      parentExternalId: replied?.id ?? null,
      occurredAt: t.created_at ?? this.now().toISOString(),
      raw: t,
    };
  }

  // ---- transport --------------------------------------------------------------------------

  private async request<T>(
    account: AccountRef,
    auth: XAuth,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts: { query?: Record<string, string | undefined>; json?: unknown; form?: FormData; creating?: boolean } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const headers: Record<string, string> = { authorization: `Bearer ${auth.accessToken}` };
    let body: string | FormData | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      body = opts.form; // fetch sets the multipart boundary itself
    }
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(url.toString(), { method, headers, body });
    } catch (err) {
      throw asNetworkError(err, `x ${method} ${path} (${account.handle})`);
    }
    const data = await readJson(res);
    if (!res.ok) throw mapXError(res.status, res.headers, data, { what: `${method} ${path}`, creating: opts.creating ?? false });
    return data as T;
  }
}

function parseAuth(account: AccountRef): XAuth {
  const parsed = XAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`x account ${account.handle}: auth blob needs accessToken and userId`, "auth", false, parsed.error);
  return parsed.data;
}

/** Native metric names → Starsign's canon. Only metrics X actually returned become rows. */
function tweetMetrics(t: XTweet, observedAt: string): MetricInput[] {
  const pub = t.public_metrics ?? {};
  const priv = t.non_public_metrics ?? {};
  const row = (metric: MetricName, value: number | undefined): MetricInput[] => (typeof value === "number" ? [{ entityType: "post_variant", entityId: t.id, metric, value, observedAt, source: "x" }] : []);
  const likes = pub.like_count ?? 0;
  const replies = pub.reply_count ?? 0;
  const reposts = pub.retweet_count ?? 0;
  const quotes = pub.quote_count ?? 0;
  return [
    ...row("impressions", pub.impression_count ?? priv.impression_count),
    ...row("likes", pub.like_count),
    ...row("replies", pub.reply_count),
    ...row("reposts", pub.retweet_count),
    ...row("quotes", pub.quote_count),
    ...row("saves", pub.bookmark_count),
    ...row("link_clicks", priv.url_link_clicks),
    ...row("profile_visits", priv.user_profile_clicks),
    ...row("engagements", likes + replies + reposts + quotes),
  ];
}
