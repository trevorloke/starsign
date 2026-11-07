import type { ActivityInput, ActivityKind, Media, MetricInput, MetricName, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, downloadMedia, isAfter, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource, sendBody, setMediaFile, uploadForm, withMedia, type StreamingForm } from "./media-io.ts";
import { OAuth2Client, clientFromEnv, type OAuth2Token } from "./oauth.ts";
import type { AccountIdentity, AccountRef, AuthRefresh, ConnectedAccount, Connector, ConnectorCapabilities, ModerationInput, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * VK (VKontakte) adapter: VK ID OAuth 2.1 (authorization code + PKCE) for the login, VK API methods
 * (https://api.vk.com/method/<name>, form-encoded, `v` + `access_token`) for everything else.
 *
 * One login yields the user's own wall plus every community they manage (groups.get filter=admin,editor): one
 * account per wall, externalId = owner_id (negative for communities). Community posts go out with from_group=1.
 *
 * VK reports most errors with HTTP 200 and a JSON `error` object; `mapVkError` turns error_code into
 * ConnectorError kinds.
 *
 * VK ID specifics: the token exchange and refresh need the `device_id` VK appends to the redirect, and refresh
 * tokens are single-use (rotated on every refresh). TODO(verify): core passes only `code` to oauthConnect today;
 * `device_id` must reach it (see vk.md, "core change").
 */

// TODO(verify): VK ID scope names for API access (wall, photos, video, groups, stats) and whether wall/groups need
// extended-access approval for the app.
export const VK_OAUTH_SCOPES = ["vkid.personal_info", "wall", "photos", "video", "groups", "stats"];

// TODO(verify): latest VK API version (5.199 is the latest we could confirm).
export const VK_API_VERSION = "5.199";
const API = "https://api.vk.com/method";

export const VkAuth = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.string().optional(),
  scope: z.string().optional(),
  /** VK ID device id from the redirect; the refresh request needs it. */
  deviceId: z.string().optional(),
  userId: z.string().optional(),
});
export type VkAuth = z.infer<typeof VkAuth>;

export interface VkConnectorOptions {
  clientId?: string;
  clientSecret?: string;
  apiUrl?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  version?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** Recent wall posts whose comments fetchActivity reads. */
  recentPosts?: number;
}

interface VkErrorBody {
  error_code?: number;
  error_msg?: string;
}

export interface VkFailure {
  status: number;
  code?: number;
  body: unknown;
}

interface VkUser {
  id: number;
  first_name?: string;
  last_name?: string;
  screen_name?: string;
}

interface VkGroup {
  id: number;
  name?: string;
  screen_name?: string;
  is_admin?: number;
  admin_level?: number;
}

interface VkPost {
  id: number;
  owner_id: number;
  from_id?: number;
  date?: number;
  text?: string;
  comments?: { count?: number };
  likes?: { count?: number };
  reposts?: { count?: number };
  views?: { count?: number };
}

interface VkComment {
  id: number;
  from_id: number;
  owner_id?: number;
  post_id?: number;
  date: number;
  text?: string;
  reply_to_comment?: number;
  reply_to_user?: number;
  deleted?: boolean;
  thread?: { count?: number; items?: VkComment[] };
}

const RATE_LIMIT_CODES = new Set([6, 9, 29]);
const AUTH_CODES = new Set([5, 7, 17, 18, 27, 28, 200, 203]);
const REJECTED_CODES = new Set([14, 15, 100, 113, 212, 213, 214, 219, 220, 222, 223, 224]);

/** VK error_code (in the JSON `error` object, usually with HTTP 200) → ConnectorError. */
export function mapVkError(error: VkErrorBody, what: string, status = 200, body: unknown = { error }): ConnectorError {
  const code = error.error_code;
  const msg = `vk ${what}: error ${code ?? "?"}${error.error_msg ? ` ${error.error_msg}` : ""}`;
  const cause: VkFailure = { status, ...(code !== undefined ? { code } : {}), body };
  if (code !== undefined) {
    if (RATE_LIMIT_CODES.has(code)) return new ConnectorError(`${msg} (rate limited)`, "rate_limit", true, cause);
    if (code === 5) return new ConnectorError(`${msg} (token expired or revoked; reconnect VK)`, "auth", false, cause);
    if (AUTH_CODES.has(code)) return new ConnectorError(msg, "auth", false, cause);
    if (code === 14) return new ConnectorError(`${msg} (VK wants a captcha; slow down and retry later)`, "rejected", false, cause);
    if (REJECTED_CODES.has(code)) return new ConnectorError(msg, "rejected", false, cause);
    if (code === 1 || code === 10) return new ConnectorError(msg, "network", true, cause);
  }
  return new ConnectorError(msg, "unknown", false, cause);
}

function codeOf(err: unknown): number | undefined {
  return err instanceof ConnectorError ? (err.cause as VkFailure | undefined)?.code : undefined;
}

function parseAuth(account: AccountRef): VkAuth {
  const p = VkAuth.safeParse(account.auth ?? {});
  if (!p.success) throw new ConnectorError(`vk account ${account.handle}: auth blob needs accessToken`, "auth", false, p.error);
  return p.data;
}

/** owner_id of the account's wall (negative for a community). */
function ownerOf(account: AccountRef): number {
  const n = Number(account.config.ownerId ?? account.externalId);
  if (!Number.isInteger(n) || n === 0) throw new ConnectorError(`vk account ${account.handle}: no owner id`, "auth", false);
  return n;
}

export function vkPostUrl(ownerId: number | string, postId: number | string, commentId?: number | string): string {
  return `https://vk.com/wall${ownerId}_${postId}${commentId !== undefined ? `?reply=${commentId}` : ""}`;
}

/** "<owner>_<post>" or "<owner>_<post>_<comment>". */
export function parseVkRef(externalId: string): { ownerId: number; postId: number; commentId?: number } {
  const m = /^(-?\d+)_(\d+)(?:_(\d+))?$/.exec(externalId);
  if (!m) throw new ConnectorError(`vk: "${externalId}" is not a wall post or comment id`, "rejected", false);
  return { ownerId: Number(m[1]), postId: Number(m[2]), ...(m[3] ? { commentId: Number(m[3]) } : {}) };
}

export class VkConnector implements Connector {
  readonly name = "vk";
  readonly networks: readonly Network[] = ["vk"];
  readonly connectMethod = "oauth" as const;
  media?: Connector["media"];

  readonly oauth: OAuth2Client;
  private readonly apiUrl: string;
  private readonly version: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly recentPosts: number;
  private readonly published = new IdempotencyCache<PublishResult>();
  private readonly replies = new IdempotencyCache<PublishResult>();
  /** Accounts of one login share a token; VK ID refresh tokens are single-use. Old → new, so siblings reuse it. */
  private readonly rotated = new Map<string, OAuth2Token>();
  private readonly opts: VkConnectorOptions;

  constructor(opts: VkConnectorOptions = {}) {
    this.apiUrl = (opts.apiUrl ?? API).replace(/\/+$/, "");
    this.version = opts.version ?? VK_API_VERSION;
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.recentPosts = opts.recentPosts ?? 20;
    this.opts = opts;
    this.oauth = this.client(undefined);
  }

  /** An OAuth2Client whose token requests carry VK ID's extra `device_id` (and `state`) form fields. */
  private client(extra: Record<string, string> | undefined): OAuth2Client {
    const opts = this.opts;
    const base = opts.fetch;
    const fetchWithExtra: FetchLike | undefined =
      extra && Object.keys(extra).length > 0
        ? (input, init) => {
            const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
            for (const [k, v] of Object.entries(extra)) form.set(k, v);
            return resolveFetch(base)(input, { ...init, body: form.toString() });
          }
        : base;
    return new OAuth2Client(
      {
        name: "vk",
        authorizeUrl: opts.authorizeUrl ?? "https://id.vk.com/authorize",
        tokenUrl: opts.tokenUrl ?? "https://id.vk.com/oauth2/auth",
        scopes: VK_OAUTH_SCOPES,
        pkce: true,
        clientAuth: "body",
        ...(opts.clientId ? { clientId: opts.clientId } : {}),
        ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
      },
      fetchWithExtra,
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
      webhooks: false,
      video: true,
      kinds: ["post", "link", "carousel", "video"],
    };
  }

  // ---- connect ---------------------------------------------------------------------------

  oauthAuthorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    return this.oauth.authorizeUrl({ state: p.state, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge });
  }

  /**
   * Exchange the code (with PKCE verifier and VK ID's device_id) and return the user's wall plus managed communities.
   * `callbackParams` is the full redirect query when core supplies it (device_id, state); `config.deviceId` also works.
   */
  async oauthConnect(p: { code: string; codeVerifier: string; redirectUri: string; config?: Record<string, unknown>; callbackParams?: Record<string, string> }): Promise<ConnectedAccount[]> {
    const deviceId = p.callbackParams?.device_id ?? (typeof p.config?.deviceId === "string" ? p.config.deviceId : undefined);
    const extra: Record<string, string> = { ...(deviceId ? { device_id: deviceId } : {}), ...(p.callbackParams?.state ? { state: p.callbackParams.state } : {}) };
    // TODO(verify): VK ID requires device_id (and state) in the code exchange, and its access token is accepted by
    // api.vk.com methods (wall.*, photos.*, groups.*) without a separate legacy OAuth token.
    const token = await this.client(extra).exchange({ code: p.code, codeVerifier: p.codeVerifier, redirectUri: p.redirectUri });
    const auth = authFromToken(token, deviceId);
    const me = await this.me(auth.accessToken);
    auth.userId = String(me.id);
    const out: ConnectedAccount[] = [
      {
        network: "vk",
        identity: userIdentity(me),
        auth,
        config: { ownerId: me.id, kind: "user" },
      },
    ];
    let groups: VkGroup[] = [];
    try {
      const r = await this.call<{ items?: VkGroup[] }>(auth.accessToken, "groups.get", { user_id: me.id, filter: "admin,editor", extended: 1, count: 1000 }, "groups.get");
      groups = r.items ?? [];
    } catch (err) {
      // Without the groups scope the login still connects the user's own wall.
      if (!(err instanceof ConnectorError && err.kind === "auth" && codeOf(err) !== 5)) throw err;
    }
    for (const g of groups) {
      out.push({
        network: "vk",
        identity: { externalId: String(-g.id), handle: g.screen_name ?? `club${g.id}`, displayName: g.name ?? null },
        auth: { ...auth },
        config: { ownerId: -g.id, groupId: g.id, kind: "group", ...(g.admin_level !== undefined ? { adminLevel: g.admin_level } : {}) },
      });
    }
    return out;
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const token = typeof auth.accessToken === "string" ? auth.accessToken : null;
    if (!token) throw new ConnectorError("vk: accessToken is required", "auth", false);
    return userIdentity(await this.me(token));
  }

  /** VK ID access tokens last about an hour; refresh with the single-use refresh token and the device id. */
  async refreshAuth(account: AccountRef): Promise<AuthRefresh | null> {
    const auth = parseAuth(account);
    if (!auth.refreshToken) return null;
    let t = this.rotated.get(auth.refreshToken);
    if (!t || (t.expiresAt && Date.parse(t.expiresAt) <= this.now().getTime() + 60_000)) {
      t = await this.client(auth.deviceId ? { device_id: auth.deviceId } : undefined).refresh(auth.refreshToken);
      if (t.refreshToken && t.refreshToken !== auth.refreshToken) this.rotated.set(auth.refreshToken, t);
    }
    return { auth: { ...authFromToken(t, auth.deviceId), ...(auth.userId ? { userId: auth.userId } : {}) } };
  }

  private async me(token: string): Promise<VkUser> {
    const r = await this.call<VkUser[] | { items?: VkUser[] }>(token, "users.get", { fields: "screen_name" }, "users.get");
    const me = Array.isArray(r) ? r[0] : r.items?.[0];
    if (!me?.id) throw new ConnectorError("vk users.get: no user in response", "unknown", false, r);
    return me;
  }

  // ---- validate & publish ---------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const o = input.options ?? {};
    if (!input.text.trim() && input.media.length === 0 && !o.link) issues.push({ code: "empty", message: "a VK post needs text, media or a link" });
    if (input.media.some((m) => m.kind === "document")) issues.push({ code: "unsupported_media", message: "documents are not supported for VK posts yet" });
    // Up to 10 attachments, and the link counts as one.
    const attachments = input.media.length + (o.link ? 1 : 0);
    if (attachments > 10) issues.push({ code: "too_many_media", message: `${attachments} > 10 attachments in a VK post (a link counts as one)` });
    if ([...input.text].length > 15_895) issues.push({ code: "too_long", message: "VK posts are limited to about 16,000 characters" });
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "VK posts have no threads" });
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.published.run(input.idempotencyKey, async () => {
      const issues = this.validate(account, input);
      if (issues.length) throw new ConnectorError(`vk publish: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
      const auth = parseAuth(account);
      const owner = ownerOf(account);
      const attachments: string[] = [];
      for (const m of input.media) attachments.push(m.kind === "video" ? await this.uploadVideo(auth, owner, m, input.options?.title) : await this.uploadPhoto(auth, owner, m));
      if (input.options?.link) attachments.push(input.options.link);
      const r = await this.call<{ post_id?: number }>(
        auth.accessToken,
        "wall.post",
        {
          owner_id: owner,
          ...(owner < 0 ? { from_group: 1 } : {}),
          ...(input.text ? { message: input.text } : {}),
          ...(attachments.length ? { attachments: attachments.join(",") } : {}),
        },
        "wall.post",
      );
      if (!r.post_id) throw new ConnectorError("vk wall.post: response had no post_id", "unknown", false, r);
      return { externalId: `${owner}_${r.post_id}`, url: vkPostUrl(owner, r.post_id), raw: r };
    });
  }

  /** photos.getWallUploadServer → POST the file → photos.saveWallPhoto → "photo<owner>_<id>". */
  private async uploadPhoto(auth: VkAuth, owner: number, m: Media): Promise<string> {
    const group = owner < 0 ? { group_id: -owner } : {};
    const server = await this.call<{ upload_url?: string }>(auth.accessToken, "photos.getWallUploadServer", group, "photos.getWallUploadServer");
    if (!server.upload_url) throw new ConnectorError("vk photos.getWallUploadServer: no upload_url", "unknown", false, server);
    const { bytes, mime } = await this.read(m);
    const form = new FormData();
    form.set("photo", new Blob([bytes], { type: mime }), `photo.${mime.split("/")[1] ?? "jpg"}`);
    const up = await this.upload<{ server?: number; photo?: string; hash?: string }>(server.upload_url, form, "photo upload");
    if (!up.photo || up.photo === "[]") throw new ConnectorError("vk photo upload: VK did not accept the file", "rejected", false, up);
    const saved = await this.call<{ id: number; owner_id: number; access_key?: string }[]>(
      auth.accessToken,
      "photos.saveWallPhoto",
      { ...(owner < 0 ? { group_id: -owner } : { user_id: owner }), server: up.server ?? "", photo: up.photo, hash: up.hash ?? "", ...(m.alt ? { caption: m.alt } : {}) },
      "photos.saveWallPhoto",
    );
    const p = saved[0];
    if (!p) throw new ConnectorError("vk photos.saveWallPhoto: no photo returned", "unknown", false, saved);
    return `photo${p.owner_id}_${p.id}`;
  }

  /** video.save → POST the file → "video<owner>_<id>". */
  // TODO(verify): video.save parameters for community walls (group_id, wallpost=0) and the upload response shape.
  private async uploadVideo(auth: VkAuth, owner: number, m: Media, title: string | undefined): Promise<string> {
    const save = await this.call<{ upload_url?: string; video_id?: number; owner_id?: number }>(
      auth.accessToken,
      "video.save",
      { ...(owner < 0 ? { group_id: -owner } : {}), name: title ?? m.alt ?? "Video", wallpost: 0 },
      "video.save",
    );
    if (!save.upload_url) throw new ConnectorError("vk video.save: no upload_url", "unknown", false, save);
    // The video goes up as a streamed multipart body with an exact Content-Length, never held whole.
    const up = await withMedia(mediaSource(this.media, this.fetchImpl), m, async (file) => {
      const form = uploadForm([file]);
      setMediaFile(form, "video_file", file, "video.mp4");
      return this.upload<{ video_id?: number; owner_id?: number }>(save.upload_url!, form, "video upload");
    });
    const id = up.video_id ?? save.video_id;
    const vOwner = up.owner_id ?? save.owner_id ?? owner;
    if (!id) throw new ConnectorError("vk video upload: no video_id", "unknown", false, up);
    return `video${vOwner}_${id}`;
  }

  private read(m: Media): Promise<{ bytes: Uint8Array; mime: string }> {
    return this.media ? this.media.fetch(m) : downloadMedia(resolveFetch(this.fetchImpl), m);
  }

  // ---- inbox ----------------------------------------------------------------------------

  /** Comments (and comment threads) on the account's most recent wall posts. */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const owner = ownerOf(account);
    const posts = await this.call<{ items?: VkPost[] }>(auth.accessToken, "wall.get", { owner_id: owner, count: this.recentPosts }, "wall.get");
    const out: ActivityInput[] = [];
    for (const post of posts.items ?? []) {
      if (!post.comments?.count) continue;
      const r = await this.call<{ items?: VkComment[]; profiles?: VkUser[]; groups?: VkGroup[] }>(
        auth.accessToken,
        "wall.getComments",
        { owner_id: owner, post_id: post.id, count: 100, sort: "desc", extended: 1, thread_items_count: 10 },
        "wall.getComments",
      );
      const names = new Map<number, { handle: string | null; name: string | null }>();
      for (const u of r.profiles ?? []) names.set(u.id, { handle: u.screen_name ?? `id${u.id}`, name: [u.first_name, u.last_name].filter(Boolean).join(" ") || null });
      for (const g of r.groups ?? []) names.set(-g.id, { handle: g.screen_name ?? `club${g.id}`, name: g.name ?? null });
      const all: VkComment[] = [];
      for (const c of r.items ?? []) all.push(c, ...(c.thread?.items ?? []));
      const byId = new Map(all.map((c) => [c.id, c]));
      for (const c of all) {
        const item = vkCommentToActivity(c, { ownerId: owner, postId: post.id, names, parentByAccount: c.reply_to_comment !== undefined && byId.get(c.reply_to_comment)?.from_id === owner });
        if (item && isAfter(item.occurredAt, since)) out.push(item);
      }
    }
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  /** Comment on a post ("<owner>_<post>") or answer a comment ("<owner>_<post>_<comment>"); communities answer as the community. */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.replies.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const ref = parseVkRef(input.parentExternalId);
      const owner = ownerOf(account);
      const r = await this.call<{ comment_id?: number }>(
        auth.accessToken,
        "wall.createComment",
        {
          owner_id: ref.ownerId,
          post_id: ref.postId,
          message: input.text,
          ...(ref.commentId ? { reply_to_comment: ref.commentId } : {}),
          ...(owner < 0 && ref.ownerId === owner ? { from_group: -owner } : {}),
        },
        "wall.createComment",
      );
      if (!r.comment_id) throw new ConnectorError("vk wall.createComment: no comment_id", "unknown", false, r);
      return { externalId: `${ref.ownerId}_${ref.postId}_${r.comment_id}`, url: vkPostUrl(ref.ownerId, ref.postId, r.comment_id), raw: r };
    });
  }

  /** delete → wall.deleteComment (or wall.delete for a post); like/unlike → likes.add/delete. VK has no hide. */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    const auth = parseAuth(account);
    const ref = parseVkRef(input.externalId);
    const isComment = ref.commentId !== undefined;
    switch (input.action) {
      case "delete":
        if (isComment) await this.call(auth.accessToken, "wall.deleteComment", { owner_id: ref.ownerId, comment_id: ref.commentId }, "wall.deleteComment");
        else await this.call(auth.accessToken, "wall.delete", { owner_id: ref.ownerId, post_id: ref.postId }, "wall.delete");
        return;
      case "like":
      case "unlike":
        await this.call(auth.accessToken, input.action === "like" ? "likes.add" : "likes.delete", { type: isComment ? "comment" : "post", owner_id: ref.ownerId, item_id: isComment ? ref.commentId : ref.postId }, input.action === "like" ? "likes.add" : "likes.delete");
        return;
      default:
        throw new ConnectorError(`vk cannot ${input.action} comments (delete, like and unlike are available)`, "rejected", false);
    }
  }

  // ---- metrics --------------------------------------------------------------------------

  /** Views, likes, reposts and comments per post from wall.getById (100 posts per call). */
  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    const ids = externalIds.filter((id) => /^-?\d+_\d+$/.test(id));
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      // TODO(verify): wall.getById returns { items } in 5.199 (older versions returned a bare array); both are read.
      const r = await this.call<VkPost[] | { items?: VkPost[] }>(auth.accessToken, "wall.getById", { posts: chunk.join(",") }, "wall.getById");
      for (const p of Array.isArray(r) ? r : (r.items ?? [])) {
        const entityId = `${p.owner_id}_${p.id}`;
        const row = (metric: MetricName, value: unknown): MetricInput[] => (typeof value === "number" ? [{ entityType: "post_variant", entityId, metric, value, observedAt, source: "vk" }] : []);
        const likes = p.likes?.count;
        const reposts = p.reposts?.count;
        const comments = p.comments?.count;
        const any = [likes, reposts, comments].some((v) => typeof v === "number");
        out.push(
          ...row("impressions", p.views?.count),
          ...row("likes", likes),
          ...row("reposts", reposts),
          ...row("replies", comments),
          ...(any ? row("engagements", (likes ?? 0) + (reposts ?? 0) + (comments ?? 0)) : []),
        );
      }
    }
    return out;
  }

  /** followers_total: community members (groups.getMembers count) or the user's followers (users.getFollowers count). */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const owner = ownerOf(account);
    const r =
      owner < 0
        ? await this.call<{ count?: number }>(auth.accessToken, "groups.getMembers", { group_id: -owner, count: 0 }, "groups.getMembers")
        : await this.call<{ count?: number }>(auth.accessToken, "users.getFollowers", { user_id: owner, count: 0 }, "users.getFollowers");
    if (typeof r.count !== "number") return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: r.count, observedAt: this.now().toISOString(), source: "vk" }];
  }

  // ---- transport ------------------------------------------------------------------------

  /** Call a VK API method. Errors come back as HTTP 200 with `{ error: { error_code, error_msg } }`. */
  async call<T>(token: string, method: string, params: Record<string, string | number | undefined>, what: string): Promise<T> {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) form.set(k, String(v));
    form.set("v", this.version);
    form.set("access_token", token);
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(`${this.apiUrl}/${method}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form.toString() });
    } catch (err) {
      throw asNetworkError(err, `vk ${what}`);
    }
    const data = (await readJson(res)) as { response?: unknown; error?: VkErrorBody } | string | undefined;
    if (data && typeof data === "object" && data.error) throw mapVkError(data.error, what, res.status, data);
    if (!res.ok) {
      const { kind, retryable } = classifyHttpStatus(res.status);
      throw new ConnectorError(`vk ${what}: HTTP ${res.status}`, kind, retryable, { status: res.status, body: data } satisfies VkFailure);
    }
    if (!data || typeof data !== "object" || !("response" in data)) throw new ConnectorError(`vk ${what}: unexpected response`, "unknown", false, data);
    return data.response as T;
  }

  /** POST a file to a VK upload server; those answer with JSON (and their own `error` strings). */
  private async upload<T>(url: string, form: FormData | StreamingForm, what: string): Promise<T> {
    let res: Response;
    try {
      res = await sendBody(resolveFetch(this.fetchImpl), url, { method: "POST" }, form);
    } catch (err) {
      throw asNetworkError(err, `vk ${what}`);
    }
    const data = (await readJson(res)) as Record<string, unknown> | undefined;
    if (!res.ok) {
      const { kind, retryable } = classifyHttpStatus(res.status);
      throw new ConnectorError(`vk ${what}: HTTP ${res.status}`, kind === "auth" ? "rejected" : kind, retryable, { status: res.status, body: data });
    }
    if (data && typeof data === "object" && data.error) throw new ConnectorError(`vk ${what}: ${typeof data.error === "string" ? data.error : JSON.stringify(data.error)}`, "rejected", false, data);
    return (data ?? {}) as T;
  }
}

/** One wall comment → activity. The account's own comments are skipped. */
export function vkCommentToActivity(
  c: VkComment,
  ctx: { ownerId: number; postId: number; names: Map<number, { handle: string | null; name: string | null }>; parentByAccount: boolean },
): ActivityInput | null {
  if (c.deleted || c.from_id === ctx.ownerId || typeof c.date !== "number") return null;
  const who = ctx.names.get(c.from_id);
  const kind: ActivityKind = ctx.parentByAccount ? "reply" : "comment";
  return {
    network: "vk",
    kind,
    externalId: `${ctx.ownerId}_${ctx.postId}_${c.id}`,
    authorHandle: who?.handle ?? (c.from_id > 0 ? `id${c.from_id}` : `club${-c.from_id}`),
    authorName: who?.name ?? null,
    text: c.text || null,
    url: vkPostUrl(ctx.ownerId, ctx.postId, c.id),
    parentExternalId: c.reply_to_comment ? `${ctx.ownerId}_${ctx.postId}_${c.reply_to_comment}` : `${ctx.ownerId}_${ctx.postId}`,
    occurredAt: new Date(c.date * 1000).toISOString(),
    raw: c,
  };
}

function userIdentity(me: VkUser): AccountIdentity {
  return { externalId: String(me.id), handle: me.screen_name ?? `id${me.id}`, displayName: [me.first_name, me.last_name].filter(Boolean).join(" ") || null };
}

function authFromToken(t: OAuth2Token, deviceId: string | undefined): VkAuth {
  const uid = t.raw.user_id;
  return {
    accessToken: t.accessToken,
    ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
    ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
    ...(t.scope ? { scope: t.scope } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(typeof uid === "number" || typeof uid === "string" ? { userId: String(uid) } : {}),
  };
}

/** Registry entry for VK: VK_CLIENT_ID (VK ID app id), VK_CLIENT_SECRET (optional with PKCE). */
export function createVkConnectors(env: NodeJS.ProcessEnv): Connector[] {
  const { clientId, clientSecret } = clientFromEnv(env, "VK");
  return [
    new VkConnector({
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(env.VK_API_VERSION ? { version: env.VK_API_VERSION } : {}),
    }),
  ];
}
