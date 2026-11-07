import type { ActivityInput, Media, MetricInput, MetricName, Network, VariantOptions } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, isAfter, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { StreamingForm, mediaSource, rangeBody, sendBody, setMediaFile, uploadForm, withMedia, type MediaReader } from "./media-io.ts";
import { OAuth2Client, clientFromEnv, type OAuth2ProviderConfig, type OAuth2Token } from "./oauth.ts";
import type {
  AccountIdentity,
  AccountRef,
  AuthRefresh,
  ConnectedAccount,
  Connector,
  ConnectorCapabilities,
  MediaFetcher,
  PublishInput,
  PublishResult,
  ValidationIssue,
} from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Douyin (抖音, mainland China) adapter on the Douyin Open Platform (open.douyin.com): OAuth with `client_key`,
 * video upload (whole or in parts) + create_video, 图文 (picture) posts, comments on the account's videos, video data
 * and fan count.
 *
 * Douyin is not TikTok. It is a separate platform with its own developer accounts, apps and review; a Douyin app needs
 * a mainland-China registered developer (enterprise) and Douyin's capability review for each scope. TikTok is the
 * `tiktok` connector.
 *
 * Most request/response shapes here come from Douyin's docs as quoted in search results and from the long-standing
 * community SDK douyin-go (zhangshuai/douyin-go); developer.open-douyin.com was not reachable from the build sandbox.
 * Everything not confirmed is marked TODO(verify).
 */

/** Scopes requested at login. Each must be granted to the app in the Douyin console first. */
export const DOUYIN_SCOPES = ["user_info", "video.create.bind", "video.data.bind", "item.comment"];

export const DouyinAuth = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  /** ISO time the access token expires (Douyin: 15 days). */
  expiresAt: z.string().optional(),
  /** ISO time the refresh token expires (Douyin: 30 days; renewable up to 5 times with renew_refresh_token). */
  refreshExpiresAt: z.string().optional(),
  /** The user's open_id for this client_key: the account's externalId. */
  openId: z.string().min(1),
  scope: z.string().optional(),
  /** How many times the refresh token has been renewed (Douyin allows 5, then the person must log in again). */
  renewals: z.number().int().nonnegative().optional(),
});
export type DouyinAuth = z.infer<typeof DouyinAuth>;

export interface DouyinConnectorOptions {
  clientKey?: string;
  clientSecret?: string;
  scopes?: string[];
  baseUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Largest file sent with one upload_video request (default 128 MB, Douyin's limit); larger files go up in parts. */
  singleUploadMaxBytes?: number;
  /** Part size for part upload (default 20 MB, Douyin's recommendation; minimum 5 MB). */
  partSizeBytes?: number;
  /** video_data checks after create_video to read the review result and share URL (default 2; 0 disables). */
  reviewPolls?: number;
  reviewIntervalMs?: number;
  /** Most recent videos whose comments fetchActivity reads (default 10). */
  maxVideos?: number;
  /** Comment pages (50 each) per video per poll (default 2). */
  maxCommentPages?: number;
  /** Renew the refresh token when it has less than this left (default 3 days). */
  renewBeforeMs?: number;
}

export const DOUYIN_LIMITS = {
  /** create_video `text`: title incl. #hashtags and @mentions. */
  maxText: 1000,
  maxVideoBytes: 4 * 1024 * 1024 * 1024,
  /** Over this, part upload is required. */
  singleUploadMax: 128 * 1024 * 1024,
  /** Recommended part size, and the smallest part Douyin accepts. */
  partSize: 20 * 1024 * 1024,
  minPartSize: 5 * 1024 * 1024,
  /** TODO(verify): item_ids per video_data call. */
  videoDataBatch: 20,
  /** renew_refresh_token works at most this many times. */
  maxRenewals: 5,
} as const;

/**
 * Starsign privacy → create_video `private_status`.
 * TODO(verify): 0 = everyone, 1 = only me, 2 = friends. Douyin has no "followers only" or "unlisted".
 */
export const DOUYIN_PRIVACY: Record<NonNullable<VariantOptions["privacy"]>, number | null> = {
  public: 0,
  self: 1,
  private: 1,
  friends: 2,
  followers: null,
  unlisted: null,
};

/** Part plan: parts of `partSize`; a tail under the 5 MB minimum is merged into the previous part. part_number starts at 1. */
export function douyinPartPlan(size: number, partSize: number = DOUYIN_LIMITS.partSize): { partNumber: number; start: number; length: number }[] {
  if (size <= 0) throw new ConnectorError("douyin upload: empty video", "rejected", false);
  const ps = Math.max(partSize, DOUYIN_LIMITS.minPartSize);
  const parts: { partNumber: number; start: number; length: number }[] = [];
  for (let start = 0; start < size; start += ps) parts.push({ partNumber: parts.length + 1, start, length: Math.min(ps, size - start) });
  const last = parts[parts.length - 1]!;
  if (parts.length > 1 && last.length < DOUYIN_LIMITS.minPartSize) {
    parts.pop();
    parts[parts.length - 1]!.length += last.length;
  }
  return parts;
}

// ---- errors ---------------------------------------------------------------------------------

export interface DouyinFailure {
  status: number;
  code?: number;
  description?: string;
  logid?: string;
  body: unknown;
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : undefined);

/** The first non-zero error code in a Douyin envelope (`data.error_code`, `extra.error_code`, `err_no`), with its text. */
export function douyinEnvelopeError(body: unknown): { code: number; description: string; logid?: string } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { data?: Record<string, unknown>; extra?: Record<string, unknown>; err_no?: unknown; err_msg?: unknown; error_code?: unknown; description?: unknown; message?: unknown };
  const data = b.data && typeof b.data === "object" ? b.data : {};
  const extra = b.extra && typeof b.extra === "object" ? b.extra : {};
  const logid = typeof extra.logid === "string" ? extra.logid : undefined;
  const candidates: [unknown, unknown][] = [
    [data.error_code, data.description],
    [extra.error_code, extra.sub_description ?? extra.description],
    [extra.sub_error_code, extra.sub_description],
    [b.err_no, b.err_msg],
    [b.error_code, b.description ?? b.message],
  ];
  for (const [c, d] of candidates) {
    const code = num(c);
    if (code !== undefined && code !== 0) return { code, description: typeof d === "string" ? d : "", ...(logid ? { logid } : {}) };
  }
  return null;
}

/** Access token expired / invalid / not this user's. */
const AUTH_CODES = new Set([2190008, 10008, 28001008, 2190002, 10009, 28001015, 10010, 10020]);
/** TODO(verify): 2190001 quota exhausted (mirrors TikTok's code table); 2100004 / 28001005 system busy. */
const RATE_CODES = new Set([2190001]);
const RETRY_CODES = new Set([2100004, 28001005]);
/** The app or the person did not grant this capability. Not "auth": reconnecting does not help until the scope is approved. */
const PERMISSION_CODES = new Set([2190004, 10004]);

export function mapDouyinError(status: number, body: unknown, what: string): ConnectorError {
  const env = douyinEnvelopeError(body);
  const code = env?.code;
  const desc = env?.description || (typeof body === "string" ? body.slice(0, 200) : "");
  const msg = `douyin ${what}: ${code !== undefined ? `error ${code}` : `HTTP ${status}`}${desc ? `: ${desc}` : ""}${env?.logid ? ` (logid ${env.logid})` : ""}`;
  const cause: DouyinFailure = { status, ...(code !== undefined ? { code } : {}), ...(desc ? { description: desc } : {}), ...(env?.logid ? { logid: env.logid } : {}), body };
  if (code !== undefined && AUTH_CODES.has(code)) {
    const hint = code === 10010 || code === 10020 ? " — the refresh token is used up; log in to Douyin again" : " — the Douyin access token expired or is invalid; it is refreshed automatically, else reconnect";
    return new ConnectorError(`${msg}${hint}`, "auth", false, cause);
  }
  if (code !== undefined && PERMISSION_CODES.has(code)) return new ConnectorError(`${msg} — this capability (scope) is not approved for the app in the Douyin console, or the person did not grant it`, "rejected", false, cause);
  if (status === 429 || (code !== undefined && RATE_CODES.has(code)) || /频率|频繁|限流|rate limit|too many requests|qps/i.test(desc)) {
    return new ConnectorError(`${msg} — Douyin rate limit; retry later`, "rate_limit", true, cause);
  }
  if ((code !== undefined && RETRY_CODES.has(code)) || status >= 500 || /系统繁忙|system busy|internal error/i.test(desc)) return new ConnectorError(msg, "network", true, cause);
  if (/审核|违规|敏感|违反|不适宜|review|audit/i.test(desc)) return new ConnectorError(`${msg} — Douyin's content review refused this post`, "rejected", false, cause);
  if (code !== undefined) return new ConnectorError(msg, "rejected", false, cause);
  const { kind, retryable } = classifyHttpStatus(status >= 400 ? status : 400);
  return new ConnectorError(msg, kind, retryable, cause);
}

// ---- shapes -----------------------------------------------------------------------------------

export interface DouyinStatistics {
  play_count?: number;
  digg_count?: number;
  comment_count?: number;
  share_count?: number;
  forward_count?: number;
  download_count?: number;
}

export interface DouyinVideo {
  item_id?: string;
  video_id?: string;
  title?: string;
  create_time?: number;
  share_url?: string;
  cover?: string;
  is_reviewed?: boolean;
  /** 1 published, 2 not suitable for public display, 4 under review, 5 public. */
  video_status?: number;
  /** 2 picture set (图集), 4 video. */
  media_type?: number;
  statistics?: DouyinStatistics;
}

export interface DouyinComment {
  comment_id?: string;
  comment_user_id?: string;
  content?: string;
  create_time?: number;
  digg_count?: number;
  reply_comment_total?: number;
  top?: boolean;
  nick_name?: string;
  avatar?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Activity external ids for comments: "<item_id>:<comment_id>" (item ids and comment ids are opaque, base64-like). */
export function douyinCommentId(itemId: string, commentId: string): string {
  return `${itemId}:${commentId}`;
}

export class DouyinConnector implements Connector {
  readonly name = "douyin";
  readonly networks: readonly Network[] = ["douyin"];
  readonly connectMethod = "oauth" as const;
  media?: MediaFetcher;

  private readonly oauth: OAuth2Client;
  private readonly refreshClient: OAuth2Client;
  private readonly clientKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly singleMax: number;
  private readonly partSize: number;
  private readonly reviewPolls: number;
  private readonly reviewIntervalMs: number;
  private readonly maxVideos: number;
  private readonly maxCommentPages: number;
  private readonly renewBeforeMs: number;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  /** idempotencyKey → video_id / image_ids already uploaded, so a retry of create does not upload again. */
  private readonly uploaded = new Map<string, { videoId?: string; imageIds?: string[]; coverId?: string }>();
  /** `${accountId}:${itemId}` → comment_count last seen, so unchanged videos are skipped. */
  private readonly commentCounts = new Map<string, number>();

  constructor(opts: DouyinConnectorOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://open.douyin.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? defaultSleep;
    this.clientKey = opts.clientKey;
    this.singleMax = opts.singleUploadMaxBytes ?? DOUYIN_LIMITS.singleUploadMax;
    this.partSize = opts.partSizeBytes ?? DOUYIN_LIMITS.partSize;
    this.reviewPolls = opts.reviewPolls ?? 2;
    this.reviewIntervalMs = opts.reviewIntervalMs ?? 5000;
    this.maxVideos = opts.maxVideos ?? 10;
    this.maxCommentPages = opts.maxCommentPages ?? 2;
    this.renewBeforeMs = opts.renewBeforeMs ?? 3 * 24 * 3600_000;
    const config: OAuth2ProviderConfig = {
      name: "douyin",
      authorizeUrl: `${this.baseUrl}/platform/oauth/connect/`,
      tokenUrl: `${this.baseUrl}/oauth/access_token/`,
      scopes: opts.scopes ?? DOUYIN_SCOPES,
      scopeSeparator: ",",
      clientIdParam: "client_key",
      pkce: false,
      // TODO(verify): current docs show a JSON body for /oauth/access_token/; older docs and SDKs use form/query
      // parameters, which OAuth2Client sends as a form body.
      clientAuth: "body",
      ...(opts.clientKey ? { clientId: opts.clientKey } : {}),
      ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
    };
    const f: FetchLike = (i, init) => resolveFetch(this.fetchImpl)(i, init);
    this.oauth = new OAuth2Client(config, f, this.now);
    // Douyin refreshes at its own URL: /oauth/refresh_token/ (client_key, grant_type=refresh_token, refresh_token).
    this.refreshClient = new OAuth2Client({ ...config, tokenUrl: `${this.baseUrl}/oauth/refresh_token/` }, f, this.now);
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
      moderate: false,
      accountMetrics: true,
      webhooks: false,
      video: true,
      kinds: ["video", "post"],
    };
  }

  // ---- connect ----------------------------------------------------------------------------

  oauthAuthorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    return this.oauth.authorizeUrl({ state: p.state, redirectUri: p.redirectUri });
  }

  async oauthConnect(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<ConnectedAccount[]> {
    const token = await this.oauth.exchange({ code: p.code, redirectUri: p.redirectUri }).catch((e: unknown) => {
      throw enrichOAuthError(e);
    });
    const openId = typeof token.raw.open_id === "string" ? token.raw.open_id : undefined;
    if (!openId) throw new ConnectorError("douyin oauth: token response had no open_id", "auth", false);
    const auth = this.toAuth(token, openId, undefined, 0);
    const identity = await this.describeAccount(auth);
    // One Douyin login = one Douyin account (personal or 企业号).
    return [{ network: "douyin", identity, auth, config: { openId } }];
  }

  /** /oauth/userinfo/: open_id, nickname, avatar, e_account_role. Douyin exposes no @handle; the nickname stands in. */
  async describeAccount(raw: Record<string, unknown>): Promise<AccountIdentity> {
    const parsed = DouyinAuth.safeParse(raw);
    if (!parsed.success) throw new ConnectorError("douyin: auth needs accessToken and openId", "auth", false);
    const a = parsed.data;
    // TODO(verify): POST with a form body (access_token, open_id); older docs use GET with the same query parameters.
    const data = await this.call<{ open_id?: string; nickname?: string; e_account_role?: string }>("POST", `${this.baseUrl}/oauth/userinfo/`, { what: "oauth/userinfo", form: new URLSearchParams({ access_token: a.accessToken, open_id: a.openId }) });
    const openId = data.open_id || a.openId;
    return { externalId: openId, handle: data.nickname || openId, displayName: data.nickname || null };
  }

  /**
   * Refresh the access token (15 days) with the refresh token (30 days). When the refresh token itself is close to
   * expiry, renew it first with renew_refresh_token (at most 5 times; then the person must log in again).
   */
  async refreshAuth(account: AccountRef): Promise<AuthRefresh | null> {
    const auth = parseAuth(account);
    if (!auth.refreshToken) return null;
    const now = this.now().getTime();
    const refreshExp = auth.refreshExpiresAt ? Date.parse(auth.refreshExpiresAt) : NaN;
    if (Number.isFinite(refreshExp) && refreshExp <= now) return null; // dead; person must reconnect
    let refreshToken = auth.refreshToken;
    let refreshExpiresAt = auth.refreshExpiresAt;
    let renewals = auth.renewals ?? 0;
    if (Number.isFinite(refreshExp) && refreshExp - now < this.renewBeforeMs && renewals < DOUYIN_LIMITS.maxRenewals) {
      try {
        const r = await this.renewRefreshToken(refreshToken);
        refreshToken = r.refreshToken;
        if (r.expiresAt) refreshExpiresAt = r.expiresAt;
        renewals++;
      } catch (e) {
        // Not allowed (scope), or limit reached: keep using the current refresh token while it lasts.
        if (!(e instanceof ConnectorError) || e.retryable) throw e;
      }
    }
    const token = await this.refreshClient.refresh(refreshToken).catch((e: unknown) => {
      throw enrichOAuthError(e);
    });
    return { auth: this.toAuth({ ...token, ...(token.refreshExpiresAt ? {} : refreshExpiresAt ? { refreshExpiresAt } : {}) }, auth.openId, auth.scope, renewals) };
  }

  /** POST /oauth/renew_refresh_token/ (client_key, refresh_token) → a new 30-day refresh token; the old one dies. */
  private async renewRefreshToken(refreshToken: string): Promise<{ refreshToken: string; expiresAt?: string }> {
    if (!this.clientKey) throw new ConnectorError("douyin oauth: client key is not configured", "auth", false);
    const data = await this.call<{ refresh_token?: string; expires_in?: number }>("POST", `${this.baseUrl}/oauth/renew_refresh_token/`, {
      what: "oauth/renew_refresh_token",
      form: new URLSearchParams({ client_key: this.clientKey, refresh_token: refreshToken }),
    });
    if (!data.refresh_token) throw new ConnectorError("douyin renew_refresh_token: no refresh_token", "auth", false, data);
    const exp = num(data.expires_in);
    return { refreshToken: data.refresh_token, ...(exp ? { expiresAt: new Date(this.now().getTime() + exp * 1000).toISOString() } : {}) };
  }

  private toAuth(token: OAuth2Token, openId: string, scope: string | undefined, renewals: number): DouyinAuth {
    const s = token.scope ?? scope;
    return {
      accessToken: token.accessToken,
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
      ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
      ...(token.refreshExpiresAt ? { refreshExpiresAt: token.refreshExpiresAt } : {}),
      openId: typeof token.raw.open_id === "string" && token.raw.open_id ? token.raw.open_id : openId,
      ...(s ? { scope: s } : {}),
      renewals,
    };
  }

  // ---- validation -------------------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const o = input.options ?? {};
    const videos = input.media.filter((m) => m.kind === "video");
    const images = input.media.filter((m) => m.kind === "image");
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "douyin has no threads" });
    if (input.media.length === 0) issues.push({ code: "media_required", message: "douyin posts need a video (or pictures for a 图文 post)" });
    for (const m of input.media) if (m.kind === "gif" || m.kind === "document") issues.push({ code: "unsupported_media", message: `douyin does not take ${m.kind === "gif" ? "GIFs; convert to MP4" : "documents"}` });
    if (videos.length > 1) issues.push({ code: "too_many_media", message: "douyin takes one video per post" });
    if (videos.length > 0 && images.length > 0) issues.push({ code: "unsupported_media", message: "douyin cannot mix a video and pictures in one post" });
    for (const v of videos) if (v.bytes && v.bytes > DOUYIN_LIMITS.maxVideoBytes) issues.push({ code: "unsupported_media", message: "douyin videos are limited to 4 GB" });
    if ([...input.text].length > DOUYIN_LIMITS.maxText) issues.push({ code: "too_long", message: `douyin titles (with #hashtags) are limited to ${DOUYIN_LIMITS.maxText} characters`, segment: 0 });
    if (o.privacy && DOUYIN_PRIVACY[o.privacy] === null) issues.push({ code: "empty", message: `douyin has no '${o.privacy}' visibility; choose public, friends or self` });
    return issues;
  }

  // ---- publishing -------------------------------------------------------------------------

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, () => this.publishOnce(account, parseAuth(account), input));
  }

  private async publishOnce(account: AccountRef, auth: DouyinAuth, input: PublishInput): Promise<PublishResult> {
    const issues = this.validate(account, input);
    if (issues.length > 0) throw new ConnectorError(`douyin publish: ${issues.map((i) => i.message).join("; ")}`, "rejected", false, issues);
    const o = input.options ?? {};
    const privacy = o.privacy ? DOUYIN_PRIVACY[o.privacy] : null;
    const key = input.idempotencyKey;
    const state = this.uploaded.get(key) ?? {};
    const video = input.media.find((m) => m.kind === "video");
    let itemId: string | undefined;
    let raw: unknown;
    if (video) {
      state.videoId ??= await this.uploadVideo(auth, video);
      this.uploaded.set(key, state);
      if (o.thumbnailUrl && !state.coverId) {
        state.coverId = await this.uploadImage(auth, { kind: "image", url: o.thumbnailUrl });
        this.uploaded.set(key, state);
      }
      const data = await this.api<{ item_id?: string }>(auth, "POST", "/api/douyin/v1/video/create_video/", {
        what: "create_video",
        json: {
          video_id: state.videoId,
          text: input.text,
          ...(privacy !== null && privacy !== undefined ? { private_status: privacy } : {}),
          // TODO(verify): custom_cover_image_url takes the image_id from upload_image (despite its name).
          ...(state.coverId ? { custom_cover_image_url: state.coverId } : {}),
        },
      });
      itemId = data.item_id;
      raw = data;
    } else {
      // 图文 (picture) post. TODO(verify): upload_image + create_image_text are open to the video.create.bind scope.
      state.imageIds ??= await Promise.all(input.media.map((m) => this.uploadImage(auth, m)));
      this.uploaded.set(key, state);
      const data = await this.api<{ item_id?: string }>(auth, "POST", "/api/douyin/v1/video/create_image_text/", {
        what: "create_image_text",
        json: { image_list: state.imageIds, text: input.text, ...(privacy !== null && privacy !== undefined ? { private_status: privacy } : {}) },
      });
      itemId = data.item_id;
      raw = data;
    }
    if (!itemId) throw new ConnectorError("douyin publish: create returned no item_id", "unknown", false, raw);
    this.uploaded.delete(key);
    const review = await this.waitForReview(auth, itemId);
    const url = review?.share_url ?? null;
    if (review?.is_reviewed && review.video_status === 2) {
      const err = new ConnectorError(`douyin publish: the post was created (${itemId}) but Douyin's review marked it not suitable for public display`, "rejected", false, review);
      err.partial = { externalId: itemId, url, threadExternalIds: [] };
      throw err;
    }
    return { externalId: itemId, url, raw: { create: raw, review: review ?? null } };
  }

  /** Read the item back a few times to learn the review result and the share URL. Bounded; never fails the publish. */
  private async waitForReview(auth: DouyinAuth, itemId: string): Promise<DouyinVideo | undefined> {
    let last: DouyinVideo | undefined;
    for (let i = 0; i < this.reviewPolls; i++) {
      if (i > 0) await this.sleep(this.reviewIntervalMs);
      const list = await this.videoData(auth, [itemId]).catch(() => [] as DouyinVideo[]);
      last = list.find((v) => v.item_id === itemId) ?? last;
      if (last?.is_reviewed) break;
    }
    return last;
  }

  /**
   * ≤ singleUploadMax: one upload_video request whose multipart body is streamed. Larger: init → upload_video_part
   * per part (each part a streamed multipart body; one part at most is read at a time) → complete.
   */
  private async uploadVideo(auth: DouyinAuth, video: Media): Promise<string> {
    return withMedia(mediaSource(this.media, this.fetchImpl), video, async (file) => {
      if (file.size > DOUYIN_LIMITS.maxVideoBytes) throw new ConnectorError("douyin publish: video exceeds 4 GB", "rejected", false);
      const mime = file.mime || "video/mp4";
      if (file.size <= this.singleMax) {
        const form = uploadForm([file]);
        setMediaFile(form, "video", file, "video.mp4", mime);
        const data = await this.api<{ video?: { video_id?: string } }>(auth, "POST", "/api/douyin/v1/video/upload_video/", { what: "upload_video", body: form });
        if (!data.video?.video_id) throw new ConnectorError("douyin upload_video: no video_id", "unknown", false, data);
        return data.video.video_id;
      }
      const init = await this.api<{ upload_id?: string }>(auth, "POST", "/api/douyin/v1/video/init_video_part_upload/", { what: "init_video_part_upload" });
      if (!init.upload_id) throw new ConnectorError("douyin init_video_part_upload: no upload_id", "unknown", false, init);
      // TODO(verify): upload_id lives 2 hours; parts are sent one after another (no parallelism, flat memory).
      for (const part of douyinPartPlan(file.size, this.partSize)) {
        await this.api(auth, "POST", "/api/douyin/v1/video/upload_video_part/", {
          what: `upload_video_part ${part.partNumber}`,
          query: { upload_id: init.upload_id, part_number: String(part.partNumber) },
          body: partForm(file, part.start, part.length, mime),
        });
      }
      const done = await this.api<{ video?: { video_id?: string } }>(auth, "POST", "/api/douyin/v1/video/complete_video_part_upload/", {
        what: "complete_video_part_upload",
        query: { upload_id: init.upload_id },
      });
      if (!done.video?.video_id) throw new ConnectorError("douyin complete_video_part_upload: no video_id", "unknown", false, done);
      return done.video.video_id;
    });
  }

  /** upload_image (multipart `image`) → image_id. Images are small and read whole. */
  private async uploadImage(auth: DouyinAuth, m: Media): Promise<string> {
    const { bytes, mime } = await mediaSource(this.media, this.fetchImpl).fetch(m);
    const form = new FormData();
    form.set("image", new Blob([bytes], { type: mime }), mime === "image/png" ? "image.png" : "image.jpg");
    const data = await this.api<{ image?: { image_id?: string } }>(auth, "POST", "/api/douyin/v1/video/upload_image/", { what: "upload_image", body: form });
    if (!data.image?.image_id) throw new ConnectorError("douyin upload_image: no image_id", "unknown", false, data);
    return data.image.image_id;
  }

  // ---- inbox ------------------------------------------------------------------------------

  /** The account's own videos, newest first (video_list, 20 per page). */
  async listVideos(auth: DouyinAuth, count: number): Promise<DouyinVideo[]> {
    const out: DouyinVideo[] = [];
    let cursor = 0;
    while (out.length < count) {
      const data = await this.api<{ list?: DouyinVideo[]; cursor?: number; has_more?: boolean }>(auth, "GET", "/api/douyin/v1/video/video_list/", {
        what: "video_list",
        query: { cursor: String(cursor), count: String(Math.min(20, count - out.length)) },
      });
      out.push(...(data.list ?? []));
      if (!data.has_more || data.cursor === undefined || (data.list ?? []).length === 0) break;
      cursor = data.cursor;
    }
    return out.slice(0, count);
  }

  /**
   * Comments on the account's most recent videos (item comment list, scope item.comment). Videos whose comment count
   * has not changed since the last poll are skipped. TODO(verify): which account types (企业号 only?) may use the
   * comment APIs today.
   */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const out: ActivityInput[] = [];
    for (const v of await this.listVideos(auth, this.maxVideos)) {
      if (!v.item_id) continue;
      const countKey = `${account.id}:${v.item_id}`;
      const count = v.statistics?.comment_count;
      if (typeof count === "number") {
        const before = this.commentCounts.get(countKey);
        this.commentCounts.set(countKey, count);
        if (count === 0 || before === count) continue;
      }
      let cursor = 0;
      for (let page = 0; page < this.maxCommentPages; page++) {
        const data = await this.api<{ list?: DouyinComment[]; cursor?: number; has_more?: boolean }>(auth, "GET", "/item/comment/list/", {
          what: "item/comment/list",
          query: { item_id: v.item_id, cursor: String(cursor), count: "50", sort_type: "time" },
        });
        let older = false;
        for (const c of data.list ?? []) {
          if (!c.comment_id) continue;
          const at = c.create_time ? new Date(c.create_time * 1000).toISOString() : this.now().toISOString();
          if (!isAfter(at, since)) {
            older = true;
            continue;
          }
          out.push({
            network: "douyin",
            kind: "comment",
            externalId: douyinCommentId(v.item_id, c.comment_id),
            // comment_user_id is an opaque id; Douyin gives no public handle.
            authorHandle: c.comment_user_id ?? null,
            authorName: c.nick_name ?? null,
            text: c.content ?? null,
            url: v.share_url ?? null,
            parentExternalId: v.item_id,
            occurredAt: at,
            raw: { ...c, item_id: v.item_id },
          });
        }
        if (older || !data.has_more || data.cursor === undefined) break;
        cursor = data.cursor;
      }
    }
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  /** Reply to a comment ("<item_id>:<comment_id>") or comment on a video (item_id) with /item/comment/reply/. */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      if (!input.text.trim()) throw new ConnectorError("douyin reply: empty text", "rejected", false);
      const sep = input.parentExternalId.indexOf(":");
      const itemId = sep >= 0 ? input.parentExternalId.slice(0, sep) : input.parentExternalId;
      const commentId = sep >= 0 ? input.parentExternalId.slice(sep + 1) : undefined;
      const data = await this.api<{ comment_id?: string }>(auth, "POST", "/item/comment/reply/", {
        what: "item/comment/reply",
        json: { item_id: itemId, content: input.text, ...(commentId ? { comment_id: commentId } : {}) },
      });
      if (!data.comment_id) throw new ConnectorError("douyin item/comment/reply: no comment_id", "unknown", false, data);
      return { externalId: douyinCommentId(itemId, data.comment_id), url: null, raw: data };
    });
  }

  // ---- metrics ----------------------------------------------------------------------------

  async videoData(auth: DouyinAuth, itemIds: string[]): Promise<DouyinVideo[]> {
    const data = await this.api<{ list?: DouyinVideo[] }>(auth, "POST", "/api/douyin/v1/video/video_data/", { what: "video_data", json: { item_ids: itemIds } });
    return data.list ?? [];
  }

  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    if (externalIds.length === 0) return [];
    const auth = parseAuth(account);
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    for (let i = 0; i < externalIds.length; i += DOUYIN_LIMITS.videoDataBatch) {
      const batch = externalIds.slice(i, i + DOUYIN_LIMITS.videoDataBatch);
      for (const v of await this.videoData(auth, batch)) {
        if (!v.item_id || !batch.includes(v.item_id)) continue;
        const s = v.statistics ?? {};
        const row = (metric: MetricName, value: number | undefined): MetricInput[] => (typeof value === "number" ? [{ entityType: "post_variant", entityId: v.item_id!, metric, value, observedAt, source: "douyin" }] : []);
        const total = (s.digg_count ?? 0) + (s.comment_count ?? 0) + (s.share_count ?? 0) + (s.forward_count ?? 0);
        // play_count is visible to the author only, and reads 0 once a public video is made private.
        out.push(...row("video_views", s.play_count), ...row("likes", s.digg_count), ...row("replies", s.comment_count), ...row("shares", s.share_count), ...row("reposts", s.forward_count), ...row("engagements", total));
      }
    }
    return out;
  }

  /** followers_total from fans_data (all_fans_num). TODO(verify): scope and whether small accounts get it; [] when refused. */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    let data: { fans_data?: { all_fans_num?: number } };
    try {
      data = await this.api(auth, "GET", "/api/douyin/v1/user/fans_data/", { what: "user/fans_data" });
    } catch (e) {
      if (e instanceof ConnectorError && e.kind === "rejected") return [];
      throw e;
    }
    const n = num(data.fans_data?.all_fans_num);
    if (n === undefined) return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: n, observedAt: this.now().toISOString(), source: "douyin" }];
  }

  // ---- transport --------------------------------------------------------------------------

  /**
   * OpenAPI call: `access-token` header, `open_id` in the query, JSON or multipart body. Douyin answers HTTP 200 with
   * an error code in `data.error_code` / `extra.error_code` on failure.
   * TODO(verify): the /api/douyin/v1/ endpoints take the token in the `access-token` header (current OpenAPI style);
   * the older paths took `access_token` in the query.
   */
  private async api<T>(auth: DouyinAuth, method: "GET" | "POST", path: string, opts: { what: string; query?: Record<string, string>; json?: unknown; body?: FormData | StreamingForm }): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("open_id", auth.openId);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { "access-token": auth.accessToken, accept: "application/json" };
    let body: unknown;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else body = opts.body;
    return this.send<T>(method, url.toString(), headers, body, opts.what);
  }

  /** A form-encoded call outside the OpenAPI gateway (userinfo, renew_refresh_token). */
  private async call<T>(method: "POST", url: string, opts: { what: string; form: URLSearchParams }): Promise<T> {
    return this.send<T>(method, url, { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, opts.form.toString(), opts.what);
  }

  private async send<T>(method: "GET" | "POST", url: string, headers: Record<string, string>, body: unknown, what: string): Promise<T> {
    let res: Response;
    try {
      res = await sendBody(resolveFetch(this.fetchImpl), url, { method, headers }, body);
    } catch (err) {
      throw asNetworkError(err, `douyin ${what}`);
    }
    const text = await res.text().catch(() => "");
    let parsed: unknown = undefined;
    try {
      parsed = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok || douyinEnvelopeError(parsed)) throw mapDouyinError(res.status, parsed, what);
    const data = parsed && typeof parsed === "object" ? (parsed as { data?: unknown }).data : undefined;
    return (data ?? {}) as T;
  }
}

/** One part as a multipart body (`video` field): a slice when the file is in memory, else read piece by piece as sent. */
function partForm(file: MediaReader, start: number, length: number, mime: string): FormData | StreamingForm {
  const body = rangeBody(file, start, length, mime);
  if (body instanceof Uint8Array) {
    const f = new FormData();
    f.set("video", new Blob([body], { type: mime }), "video.mp4");
    return f;
  }
  const f = new StreamingForm();
  f.setFile("video", body, "video.mp4");
  return f;
}

/** OAuth2Client reports Douyin's in-body failures as "HTTP 200"; add Douyin's own code and description. */
function enrichOAuthError(e: unknown): unknown {
  if (!(e instanceof ConnectorError)) return e;
  const body = (e.cause as { body?: unknown } | undefined)?.body;
  const env = douyinEnvelopeError(body);
  if (!env) return e;
  return new ConnectorError(`${e.message} (douyin error ${env.code}${env.description ? `: ${env.description}` : ""})`, e.kind, e.retryable, e.cause);
}

function parseAuth(account: AccountRef): DouyinAuth {
  const parsed = DouyinAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`douyin account ${account.handle}: auth needs accessToken and openId`, "auth", false, parsed.error);
  return parsed.data;
}

export function createDouyinConnectors(env: NodeJS.ProcessEnv): Connector[] {
  const fallback = clientFromEnv(env, "DOUYIN");
  const clientKey = env.DOUYIN_CLIENT_KEY || fallback.clientId;
  const clientSecret = env.DOUYIN_CLIENT_SECRET || fallback.clientSecret;
  const scopes = env.DOUYIN_SCOPES?.split(/[\s,]+/).filter(Boolean);
  return [
    new DouyinConnector({
      ...(clientKey ? { clientKey } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(scopes && scopes.length > 0 ? { scopes } : {}),
      ...(env.DOUYIN_API_BASE ? { baseUrl: env.DOUYIN_API_BASE } : {}),
    }),
  ];
}
