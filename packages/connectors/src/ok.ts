import { createHash } from "node:crypto";
import type { ActivityInput, ActivityKind, Media, MetricInput, MetricName, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, downloadMedia, isAfter, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource, sendBody, setMediaFile, uploadForm, withMedia, type StreamingForm } from "./media-io.ts";
import { OAuth2Client, clientFromEnv, type OAuth2Token } from "./oauth.ts";
import type { AccountIdentity, AccountRef, AuthRefresh, ConnectedAccount, Connector, ConnectorCapabilities, ModerationInput, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * OK.ru (Odnoklassniki) through the official OK REST API (https://api.ok.ru/fb.do). OAuth 2.0 authorization code
 * (connect.ok.ru, no PKCE) for the login; every API call then carries `application_key`, the session's
 * `access_token` and a signature:
 *
 *   secret = md5(access_token + application_secret_key)                    (lowercase hex)
 *   sig    = md5(sorted "key=value" pairs, concatenated, without access_token/session_key/sig + secret)
 *
 * One login yields the user's own feed plus every group the user administers or moderates: one account per group,
 * externalId "group:<gid>" (the user is "<uid>"). Group posts are media topics (mediatopic.post type GROUP_THEME).
 *
 * OK reports errors as `{ error_code, error_msg, error_data }`, usually with HTTP 200; `mapOkError` turns codes into
 * ConnectorError kinds.
 */

// TODO(verify): scope names, and that GROUP_CONTENT / VIDEO_CONTENT / PUBLISH_TO_STREAM are granted only after
// asking OK API support (api-support@ok.ru) for the app. LONG_ACCESS_TOKEN makes refresh tokens last 30 days.
export const OK_OAUTH_SCOPES = ["VALUABLE_ACCESS", "LONG_ACCESS_TOKEN", "PHOTO_CONTENT", "VIDEO_CONTENT", "GROUP_CONTENT", "PUBLISH_TO_STREAM"];
const API = "https://api.ok.ru/fb.do";

export const OkAuth = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.string().optional(),
  scope: z.string().optional(),
  userId: z.string().optional(),
});
export type OkAuth = z.infer<typeof OkAuth>;

export interface OkConnectorOptions {
  clientId?: string;
  clientSecret?: string;
  /** Public application key (OK_APPLICATION_KEY), sent with every call. */
  applicationKey?: string;
  apiUrl?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** Recent topics whose comments fetchActivity reads. */
  recentTopics?: number;
}

export interface OkFailure {
  status: number;
  code?: number;
  body: unknown;
}

interface OkErrorBody {
  error_code?: number;
  error_msg?: string;
  error_data?: unknown;
}

interface OkTopic {
  id: string;
  created_ms?: number;
  author_ref?: string;
  discussion_summary?: { comments_count?: number };
  like_summary?: { count?: number };
  reshare_summary?: { count?: number };
}

export interface OkComment {
  id: string;
  author_id?: string;
  author_name?: string;
  text?: string;
  /** "yyyy-MM-dd HH:mm:ss" (Moscow time) or epoch ms in date_ms. */
  date?: string;
  date_ms?: number;
  reply_to_comment_id?: string;
  reply_to_id?: string;
  like_count?: number;
}

// ---- pure helpers -----------------------------------------------------------------------

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

/** The session secret: md5(access_token + application secret key), lowercase hex. */
export function okSessionSecret(accessToken: string, clientSecret: string): string {
  return md5(accessToken + clientSecret);
}

/** The string OK signs: params sorted by key as "k=v", concatenated, without sig, access_token and session_key. */
export function okSignatureBase(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((k) => k !== "sig" && k !== "access_token" && k !== "session_key")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("");
}

/** sig = md5(okSignatureBase(params) + md5(access_token + client_secret)), lowercase hex. */
export function okSignature(params: Record<string, string>, accessToken: string, clientSecret: string): string {
  return md5(okSignatureBase(params) + okSessionSecret(accessToken, clientSecret));
}

const AUTH_CODES = new Set([101, 102, 103, 104, 105]);
const RATE_CODES = new Set([8, 11, 26, 5000]);
const NETWORK_CODES = new Set([1, 2, 50, 51]);

/** OK error_code → ConnectorError. */
export function mapOkError(error: OkErrorBody, what: string, status = 200, body: unknown = error): ConnectorError {
  const code = error.error_code;
  const msg = `ok ${what}: error ${code ?? "?"}${error.error_msg ? ` ${error.error_msg}` : ""}`;
  const cause: OkFailure = { status, ...(code !== undefined ? { code } : {}), body };
  if (code !== undefined) {
    if (code === 102) return new ConnectorError(`${msg} (session expired; Starsign refreshes it, or reconnect OK)`, "auth", false, cause);
    if (AUTH_CODES.has(code)) return new ConnectorError(`${msg} (the session or app key was rejected; reconnect OK)`, "auth", false, cause);
    // TODO(verify): 5000 is listed as a rate condition in the brief; OK's own table was not reachable.
    if (RATE_CODES.has(code)) return new ConnectorError(`${msg} (rate or daily limit reached; try later)`, "rate_limit", true, cause);
    if (code === 10) return new ConnectorError(`${msg} (permission denied: the app lacks this permission from OK, or the user is not an administrator of this group)`, "rejected", false, cause);
    if (NETWORK_CODES.has(code)) return new ConnectorError(msg, "network", true, cause);
    return new ConnectorError(msg, "rejected", false, cause);
  }
  return new ConnectorError(msg, "unknown", false, cause);
}

function codeOf(err: unknown): number | undefined {
  return err instanceof ConnectorError ? (err.cause as OkFailure | undefined)?.code : undefined;
}

/** OK comment time → ISO. date_ms when present; else "yyyy-MM-dd HH:mm:ss" read as Moscow time (UTC+3). */
// TODO(verify): the time zone of discussions.getComments `date` (Moscow time is our reading).
export function okCommentTime(c: Pick<OkComment, "date" | "date_ms">): string | null {
  if (typeof c.date_ms === "number" && Number.isFinite(c.date_ms)) return new Date(c.date_ms).toISOString();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(c.date ?? "");
  if (!m) return null;
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]! - 3, +m[5]!, +m[6]!)).toISOString();
}

export interface OkAccountConfig {
  kind: "user" | "group";
  uid: string;
  gid?: string;
  role?: string;
  name?: string | null;
}

function parseAuth(account: AccountRef): OkAuth {
  const p = OkAuth.safeParse(account.auth ?? {});
  if (!p.success) throw new ConnectorError(`ok account ${account.handle}: auth blob needs accessToken`, "auth", false, p.error);
  return p.data;
}

function configOf(account: AccountRef): OkAccountConfig {
  const c = account.config as Partial<OkAccountConfig>;
  if (c.kind === "group" && c.gid) return { kind: "group", gid: String(c.gid), uid: String(c.uid ?? "") };
  if (c.kind === "user" && c.uid) return { kind: "user", uid: String(c.uid) };
  const m = /^group:(\d+)$/.exec(account.externalId);
  if (m) return { kind: "group", gid: m[1]!, uid: String(c.uid ?? "") };
  if (/^\d+$/.test(account.externalId)) return { kind: "user", uid: account.externalId };
  throw new ConnectorError(`ok account ${account.handle}: no user or group id`, "auth", false);
}

/** Discussion type of a topic on this account's feed. */
const discussionType = (cfg: OkAccountConfig) => (cfg.kind === "group" ? "GROUP_TOPIC" : "USER_STATUS");

export function okTopicUrl(cfg: OkAccountConfig, topicId: string): string {
  return cfg.kind === "group" ? `https://ok.ru/group/${cfg.gid}/topic/${topicId}` : `https://ok.ru/profile/${cfg.uid}/statuses/${topicId}`;
}

/** "<topic>" or "<topic>:<comment>". */
export function parseOkRef(externalId: string): { topicId: string; commentId?: string } {
  const m = /^(\d+)(?::([A-Za-z0-9_=-]+))?$/.exec(externalId);
  if (!m) throw new ConnectorError(`ok: "${externalId}" is not a topic or comment id`, "rejected", false);
  return { topicId: m[1]!, ...(m[2] ? { commentId: m[2] } : {}) };
}

/** Group roles that can post as the group and moderate it. */
// TODO(verify): status values of group.getUserGroupsV2 (ADMIN, MODERATOR, SUPER_MODERATOR, EDITOR are our reading).
const MANAGER_ROLES = new Set(["ADMIN", "MODERATOR", "SUPER_MODERATOR", "EDITOR"]);

// ---- connector --------------------------------------------------------------------------

export class OkConnector implements Connector {
  readonly name = "ok";
  readonly networks: readonly Network[] = ["ok"];
  readonly connectMethod = "oauth" as const;
  media?: Connector["media"];

  readonly oauth: OAuth2Client;
  private readonly apiUrl: string;
  private readonly applicationKey: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly recentTopics: number;
  private readonly published = new IdempotencyCache<PublishResult>();
  private readonly replies = new IdempotencyCache<PublishResult>();

  constructor(opts: OkConnectorOptions = {}) {
    this.apiUrl = opts.apiUrl ?? API;
    this.applicationKey = opts.applicationKey;
    this.clientSecret = opts.clientSecret;
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.recentTopics = opts.recentTopics ?? 10;
    this.oauth = new OAuth2Client(
      {
        name: "ok",
        authorizeUrl: opts.authorizeUrl ?? "https://connect.ok.ru/oauth/authorize",
        // TODO(verify): token.do accepts the form body (OK's docs show the parameters in the query string of a POST).
        tokenUrl: opts.tokenUrl ?? "https://api.ok.ru/oauth/token.do",
        scopes: OK_OAUTH_SCOPES,
        scopeSeparator: ";",
        pkce: false,
        clientAuth: "body",
        extraAuthorizeParams: { layout: "w" },
        ...(opts.clientId ? { clientId: opts.clientId } : {}),
        ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
      },
      opts.fetch,
      this.now,
    );
  }

  get connectConfigured(): boolean {
    return this.oauth.configured && !!this.applicationKey;
  }

  capabilities(): ConnectorCapabilities {
    return { publish: true, fetchActivity: true, fetchMetrics: true, meteredReads: false, reply: true, moderate: true, accountMetrics: true, webhooks: false, video: true, kinds: ["post", "link", "carousel", "video"] };
  }

  // ---- connect ---------------------------------------------------------------------------

  oauthAuthorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    return this.oauth.authorizeUrl({ state: p.state, redirectUri: p.redirectUri });
  }

  /** The user's own feed plus one account per group the user administers or moderates. */
  async oauthConnect(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<ConnectedAccount[]> {
    const token = await this.oauth.exchange({ code: p.code, redirectUri: p.redirectUri });
    const auth = authFromToken(token);
    const me = await this.me(auth.accessToken);
    auth.userId = me.uid;
    const out: ConnectedAccount[] = [{ network: "ok", identity: userIdentity(me), auth, config: { kind: "user", uid: me.uid, name: me.name ?? null } satisfies OkAccountConfig }];
    let managed: { groupId: string; status?: string }[] = [];
    try {
      managed = await this.managedGroups(auth.accessToken);
    } catch (err) {
      // Without GROUP_CONTENT the login still connects the user's own feed.
      if (!(err instanceof ConnectorError && codeOf(err) === 10)) throw err;
    }
    if (managed.length) {
      const info = new Map<string, { uid: string; name?: string; shortname?: string; members_count?: number }>();
      for (let i = 0; i < managed.length; i += 100) {
        const r = await this.call<{ uid: string; name?: string; shortname?: string; members_count?: number }[]>(auth.accessToken, "group.getInfo", { uids: managed.slice(i, i + 100).map((g) => g.groupId).join(","), fields: "uid,name,shortname,members_count" }, "group.getInfo");
        for (const g of Array.isArray(r) ? r : []) info.set(String(g.uid), g);
      }
      for (const g of managed) {
        const gi = info.get(g.groupId);
        out.push({
          network: "ok",
          identity: { externalId: `group:${g.groupId}`, handle: gi?.shortname || `group/${g.groupId}`, displayName: gi?.name ?? null },
          auth: { ...auth },
          config: { kind: "group", uid: me.uid, gid: g.groupId, ...(g.status ? { role: g.status } : {}), name: gi?.name ?? null } satisfies OkAccountConfig,
        });
      }
    }
    return out;
  }

  /** group.getUserGroupsV2, paged by anchor, kept to the groups the user manages. */
  private async managedGroups(token: string): Promise<{ groupId: string; status?: string }[]> {
    const out: { groupId: string; status?: string }[] = [];
    let anchor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await this.call<{ groups?: { groupId: string | number; status?: string }[]; anchor?: string }>(token, "group.getUserGroupsV2", { count: 100, ...(anchor ? { anchor, direction: "FORWARD" } : {}) }, "group.getUserGroupsV2");
      const groups = r.groups ?? [];
      for (const g of groups) if (g.status && MANAGER_ROLES.has(g.status.toUpperCase())) out.push({ groupId: String(g.groupId), status: g.status.toUpperCase() });
      if (!r.anchor || groups.length < 100) break;
      anchor = r.anchor;
    }
    return out;
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const token = typeof auth.accessToken === "string" ? auth.accessToken : null;
    if (!token) throw new ConnectorError("ok: accessToken is required", "auth", false);
    return userIdentity(await this.me(token));
  }

  /** Access tokens last 30 minutes; refresh tokens (with LONG_ACCESS_TOKEN) 30 days and are not rotated. */
  async refreshAuth(account: AccountRef): Promise<AuthRefresh | null> {
    const auth = parseAuth(account);
    if (!auth.refreshToken) return null;
    const t = await this.oauth.refresh(auth.refreshToken);
    return { auth: { ...authFromToken(t), ...(auth.userId ? { userId: auth.userId } : {}) } };
  }

  private async me(token: string): Promise<{ uid: string; name?: string; first_name?: string; last_name?: string }> {
    const r = await this.call<{ uid?: string | number; name?: string; first_name?: string; last_name?: string }>(token, "users.getCurrentUser", { fields: "uid,name,first_name,last_name" }, "users.getCurrentUser");
    if (r.uid === undefined) throw new ConnectorError("ok users.getCurrentUser: no uid in response", "unknown", false, r);
    return { ...r, uid: String(r.uid) };
  }

  // ---- validate & publish ---------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const o = input.options ?? {};
    if (!input.text.trim() && input.media.length === 0 && !o.link) issues.push({ code: "empty", message: "an OK post needs text, media or a link" });
    if (input.media.some((m) => m.kind === "document")) issues.push({ code: "unsupported_media", message: "documents cannot be attached to OK posts" });
    if (input.media.length > 10) issues.push({ code: "too_many_media", message: `${input.media.length} > 10 media in an OK post` });
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "OK posts have no threads" });
    // TODO(verify): OK's topic text limit; 10,000 is the platform table's figure.
    if ([...input.text].length > 10_000) issues.push({ code: "too_long", message: "OK posts are limited to 10,000 characters here" });
    return issues;
  }

  /** mediatopic.post with an attachment: text, link, photos (photosV2 upload tokens), videos (video upload ids). */
  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    if (input.replyToExternalId) return this.reply(account, { parentExternalId: input.replyToExternalId, text: input.text, idempotencyKey: input.idempotencyKey });
    return this.published.run(input.idempotencyKey, async () => {
      const issues = this.validate(account, input);
      if (issues.length) throw new ConnectorError(`ok publish: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
      const auth = parseAuth(account);
      const cfg = configOf(account);
      const media: Record<string, unknown>[] = [];
      if (input.text.trim()) media.push({ type: "text", text: input.text });
      if (input.options?.link) media.push({ type: "link", url: input.options.link });
      const photos: { id: string }[] = [];
      const movies: { id: string }[] = [];
      for (const m of input.media) {
        if (m.kind === "video") movies.push({ id: await this.uploadVideo(auth, cfg, m, input.options?.title ?? null, input.text) });
        else photos.push({ id: await this.uploadPhoto(auth, cfg, m) });
      }
      if (photos.length) media.push({ type: "photo", list: photos });
      if (movies.length) media.push({ type: "movie", list: movies });
      const params: Record<string, string> = { type: cfg.kind === "group" ? "GROUP_THEME" : "USER", attachment: JSON.stringify({ media }) };
      if (cfg.kind === "group") params.gid = cfg.gid!;
      const r = await this.call<string | number | { id?: string }>(auth.accessToken, "mediatopic.post", params, "mediatopic.post");
      const id = typeof r === "string" || typeof r === "number" ? String(r) : r?.id;
      if (!id) throw new ConnectorError("ok mediatopic.post: response had no topic id", "unknown", false, r);
      return { externalId: id, url: okTopicUrl(cfg, id), raw: r };
    });
  }

  /** photosV2.getUploadUrl → POST the image → its upload token (used directly as the attachment id). */
  private async uploadPhoto(auth: OkAuth, cfg: OkAccountConfig, m: Media): Promise<string> {
    // Group topics: no album id (aid), or OK tries to file the photo into an album.
    const lease = await this.call<{ upload_url?: string; photo_ids?: string[] }>(auth.accessToken, "photosV2.getUploadUrl", { count: 1, ...(cfg.kind === "group" ? { gid: cfg.gid! } : {}) }, "photosV2.getUploadUrl");
    if (!lease.upload_url) throw new ConnectorError("ok photosV2.getUploadUrl: no upload_url", "unknown", false, lease);
    const { bytes, mime } = this.media ? await this.media.fetch(m) : await downloadMedia(resolveFetch(this.fetchImpl), m);
    const form = new FormData();
    form.set("pic1", new Blob([bytes], { type: mime }), `photo.${mime.split("/")[1] ?? "jpg"}`);
    const up = await this.upload<{ photos?: Record<string, { token?: string }> }>(lease.upload_url, form, "photo upload");
    const want = lease.photo_ids?.[0];
    const entry = (want && up.photos?.[want]) || Object.values(up.photos ?? {})[0];
    if (!entry?.token) throw new ConnectorError("ok photo upload: no token in the upload response", "rejected", false, up);
    return entry.token;
  }

  /**
   * video.getUploadUrl (with the file's size) → POST the file as a streamed multipart body → video.update (title) →
   * the video id, attached as a "movie". The file is never held whole.
   */
  // TODO(verify): video.getUploadUrl parameters (gid, file_name, file_size), the multipart field name "data", and
  // whether a topic may attach the video before OK has finished processing it.
  private async uploadVideo(auth: OkAuth, cfg: OkAccountConfig, m: Media, title: string | null, text: string): Promise<string> {
    return withMedia(mediaSource(this.media, this.fetchImpl), m, async (file) => {
      const lease = await this.call<{ upload_url?: string; video_id?: string | number }>(
        auth.accessToken,
        "video.getUploadUrl",
        { file_name: fileName(m, "video.mp4"), file_size: file.size, ...(cfg.kind === "group" ? { gid: cfg.gid! } : {}) },
        "video.getUploadUrl",
      );
      if (!lease.upload_url || lease.video_id === undefined) throw new ConnectorError("ok video.getUploadUrl: no upload_url or video_id", "unknown", false, lease);
      const form = uploadForm([file]);
      setMediaFile(form, "data", file, fileName(m, "video.mp4"));
      await this.upload<unknown>(lease.upload_url, form, "video upload");
      const vid = String(lease.video_id);
      // The upload alone leaves the video invisible; video.update publishes it with a title.
      await this.call(auth.accessToken, "video.update", { vid, title: (title ?? m.alt ?? text.split("\n")[0] ?? "Video").slice(0, 200) || "Video" }, "video.update");
      return vid;
    });
  }

  // ---- inbox ----------------------------------------------------------------------------

  /** Comments on the account's most recent topics (mediatopic.getTopics → discussions.getComments). */
  // TODO(verify): mediatopic.getTopics accepts uid for a user's own feed, and the getComments response shape.
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const cfg = configOf(account);
    const topics = await this.call<{ media_topics?: OkTopic[] }>(
      auth.accessToken,
      "mediatopic.getTopics",
      { count: this.recentTopics, fields: "media_topic.*", ...(cfg.kind === "group" ? { gid: cfg.gid! } : { uid: cfg.uid }) },
      "mediatopic.getTopics",
    );
    const out: ActivityInput[] = [];
    for (const t of topics.media_topics ?? []) {
      if (!t.discussion_summary?.comments_count) continue;
      const r = await this.call<{ comments?: OkComment[]; entities?: { users?: { uid: string; name?: string }[] } }>(
        auth.accessToken,
        "discussions.getComments",
        { discussionId: t.id, discussionType: discussionType(cfg), count: 100 },
        "discussions.getComments",
      );
      const names = new Map((r.entities?.users ?? []).map((u) => [String(u.uid), u.name ?? null]));
      const own = new Set([cfg.uid, cfg.gid].filter(Boolean) as string[]);
      for (const c of r.comments ?? []) {
        const item = okCommentToActivity(c, { cfg, topicId: t.id, names, own });
        if (item && isAfter(item.occurredAt, since)) out.push(item);
      }
    }
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  /** discussions.comment on a topic ("<topic>") or in answer to a comment ("<topic>:<comment>"). */
  // TODO(verify): the reply_to_comment_id parameter name for answering a specific comment, and that group
  // administrators comment as the group (as_admin=true).
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.replies.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const cfg = configOf(account);
      const ref = parseOkRef(input.parentExternalId);
      if (!input.text.trim()) throw new ConnectorError("ok reply: text is empty", "rejected", false);
      const r = await this.call<string | number | { id?: string }>(
        auth.accessToken,
        "discussions.comment",
        { discussionId: ref.topicId, discussionType: discussionType(cfg), comment: input.text, ...(ref.commentId ? { reply_to_comment_id: ref.commentId } : {}), ...(cfg.kind === "group" ? { as_admin: "true" } : {}) },
        "discussions.comment",
      );
      const id = typeof r === "string" || typeof r === "number" ? String(r) : r?.id;
      if (!id) throw new ConnectorError("ok discussions.comment: no comment id", "unknown", false, r);
      return { externalId: `${ref.topicId}:${id}`, url: okTopicUrl(cfg, ref.topicId), raw: r };
    });
  }

  /** delete → discussions.deleteComment. OK offers no hide or like for comments through this connector. */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    const ref = parseOkRef(input.externalId);
    if (input.action !== "delete" || !ref.commentId) throw new ConnectorError(`ok: only deleting comments is available (asked to ${input.action} ${ref.commentId ? "a comment" : "a topic"})`, "rejected", false);
    const auth = parseAuth(account);
    const cfg = configOf(account);
    await this.call(auth.accessToken, "discussions.deleteComment", { discussionId: ref.topicId, discussionType: discussionType(cfg), commentId: ref.commentId }, "discussions.deleteComment");
  }

  // ---- metrics --------------------------------------------------------------------------

  /** Likes, reshares and comments per topic from mediatopic.getByIds. */
  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const observedAt = this.now().toISOString();
    const ids = externalIds.filter((id) => /^\d+$/.test(id));
    const out: MetricInput[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const r = await this.call<{ media_topics?: OkTopic[] }>(auth.accessToken, "mediatopic.getByIds", { topic_ids: ids.slice(i, i + 50).join(","), fields: "media_topic.*" }, "mediatopic.getByIds");
      for (const t of r.media_topics ?? []) {
        const row = (metric: MetricName, value: unknown): MetricInput[] => (typeof value === "number" ? [{ entityType: "post_variant", entityId: String(t.id), metric, value, observedAt, source: "ok" }] : []);
        const likes = t.like_summary?.count;
        const reshares = t.reshare_summary?.count;
        const comments = t.discussion_summary?.comments_count;
        const any = [likes, reshares, comments].some((v) => typeof v === "number");
        out.push(...row("likes", likes), ...row("reposts", reshares), ...row("replies", comments), ...(any ? row("engagements", (likes ?? 0) + (reshares ?? 0) + (comments ?? 0)) : []));
      }
    }
    return out;
  }

  /** followers_total for groups: members_count from group.getInfo. A user's own feed has no follower count here. */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const cfg = configOf(account);
    if (cfg.kind !== "group") return [];
    const auth = parseAuth(account);
    const r = await this.call<{ uid: string; members_count?: number }[]>(auth.accessToken, "group.getInfo", { uids: cfg.gid!, fields: "uid,members_count" }, "group.getInfo");
    const n = Array.isArray(r) ? r[0]?.members_count : undefined;
    if (typeof n !== "number") return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: n, observedAt: this.now().toISOString(), source: "ok" }];
  }

  // ---- transport ------------------------------------------------------------------------

  /** Sign and call an OK REST method. Errors come back as `{ error_code, error_msg }`, usually with HTTP 200. */
  async call<T>(token: string, method: string, params: Record<string, string | number | undefined>, what: string): Promise<T> {
    if (!this.applicationKey || !this.clientSecret) throw new ConnectorError("ok: OK_APPLICATION_KEY and OK_CLIENT_SECRET are required to sign API calls", "auth", false);
    const p: Record<string, string> = { application_key: this.applicationKey, format: "json", method };
    for (const [k, v] of Object.entries(params)) if (v !== undefined) p[k] = String(v);
    p.sig = okSignature(p, token, this.clientSecret);
    p.access_token = token;
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(this.apiUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(p).toString() });
    } catch (err) {
      throw asNetworkError(err instanceof Error ? new Error(err.message.replaceAll(token, "<token>")) : err, `ok ${what}`);
    }
    const data = await readJson(res);
    if (data && typeof data === "object" && "error_code" in data) throw mapOkError(data as OkErrorBody, what, res.status, data);
    if (!res.ok) {
      const { kind, retryable } = classifyHttpStatus(res.status);
      throw new ConnectorError(`ok ${what}: HTTP ${res.status}`, kind, retryable, { status: res.status, body: data } satisfies OkFailure);
    }
    return data as T;
  }

  /** POST a file to an OK upload URL (the URL itself carries the upload's authorisation). */
  private async upload<T>(url: string, form: FormData | StreamingForm, what: string): Promise<T> {
    let res: Response;
    try {
      res = await sendBody(resolveFetch(this.fetchImpl), url, { method: "POST" }, form);
    } catch (err) {
      throw asNetworkError(err, `ok ${what}`);
    }
    const data = await readJson(res);
    if (!res.ok) {
      const { kind, retryable } = classifyHttpStatus(res.status);
      throw new ConnectorError(`ok ${what}: HTTP ${res.status}`, kind === "auth" ? "rejected" : kind, retryable, { status: res.status, body: data });
    }
    if (data && typeof data === "object" && "error_code" in data) throw mapOkError(data as OkErrorBody, what, res.status, data);
    return (data ?? {}) as T;
  }
}

/** One comment → activity. The account's own comments (as the user or as the group) are skipped. */
export function okCommentToActivity(c: OkComment, ctx: { cfg: OkAccountConfig; topicId: string; names: Map<string, string | null>; own: Set<string> }): ActivityInput | null {
  const author = c.author_id ? String(c.author_id) : null;
  if (author && ctx.own.has(author)) return null;
  const occurredAt = okCommentTime(c);
  if (!occurredAt) return null;
  const parent = c.reply_to_comment_id ?? c.reply_to_id;
  const kind: ActivityKind = "comment";
  return {
    network: "ok",
    kind,
    externalId: `${ctx.topicId}:${c.id}`,
    authorHandle: author,
    authorName: c.author_name ?? (author ? (ctx.names.get(author) ?? null) : null),
    text: c.text || null,
    url: okTopicUrl(ctx.cfg, ctx.topicId),
    parentExternalId: parent ? `${ctx.topicId}:${parent}` : ctx.topicId,
    occurredAt,
    raw: c,
  };
}

function fileName(m: Media, fallback: string): string {
  try {
    const last = new URL(m.url).pathname.split("/").pop();
    return last && /\.[A-Za-z0-9]{2,5}$/.test(last) ? decodeURIComponent(last) : fallback;
  } catch {
    return fallback;
  }
}

function userIdentity(me: { uid: string; name?: string; first_name?: string; last_name?: string }): AccountIdentity {
  return { externalId: me.uid, handle: `profile/${me.uid}`, displayName: me.name ?? ([me.first_name, me.last_name].filter(Boolean).join(" ") || null) };
}

function authFromToken(t: OAuth2Token): OkAuth {
  return {
    accessToken: t.accessToken,
    ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
    ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
    ...(t.scope ? { scope: t.scope } : {}),
  };
}

/** Registry entry for OK: OK_CLIENT_ID (application id), OK_CLIENT_SECRET (secret key), OK_APPLICATION_KEY (public key). */
export function createOkConnectors(env: NodeJS.ProcessEnv): Connector[] {
  const { clientId, clientSecret } = clientFromEnv(env, "OK");
  return [
    new OkConnector({
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(env.OK_APPLICATION_KEY ? { applicationKey: env.OK_APPLICATION_KEY } : {}),
    }),
  ];
}
