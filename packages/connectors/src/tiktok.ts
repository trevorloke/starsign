import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActivityInput, Media, MetricInput, MetricName, Network, VariantOptions } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, isAfter, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource, rangeBody, sendBody, withMedia } from "./media-io.ts";
import { OAuth2Client, type OAuth2Token } from "./oauth.ts";
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
  WebhookBatch,
  WebhookHandler,
} from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Native TikTok adapter: Login Kit (OAuth 2.0, `client_key`) + Content Posting API v2 (Direct Post) + Display API
 * (user/info, video/list, video/query) on open.tiktokapis.com.
 *
 * What TikTok does not offer publicly: comments (read, reply, moderate) and DMs. `reply`/`moderate` are absent.
 *
 * Unaudited apps: TikTok restricts every post from an unaudited client to SELF_ONLY on private accounts and caps it
 * at 5 posting users per 24h. The API answers `unaudited_client_can_only_post_to_private_accounts` /
 * `reached_active_user_cap`; both become ConnectorError("rejected") that names the audit.
 */

/** Scopes requested at login. TikTok lets the person untick some; a missing scope surfaces as scope_not_authorized. */
export const TIKTOK_SCOPES = ["user.info.basic", "user.info.profile", "user.info.stats", "video.publish", "video.upload", "video.list"];

export const TikTokAuth = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  /** ISO time the access token expires (TikTok: 24h). */
  expiresAt: z.string().optional(),
  /** ISO time the refresh token expires (TikTok: 365 days). */
  refreshExpiresAt: z.string().optional(),
  /** The user's open_id for this client_key: the account's externalId and the webhook routing key. */
  openId: z.string().min(1),
  scope: z.string().optional(),
});
export type TikTokAuth = z.infer<typeof TikTokAuth>;

export type TikTokVideoSource = "FILE_UPLOAD" | "PULL_FROM_URL";

export interface TikTokConnectorOptions {
  clientKey?: string;
  clientSecret?: string;
  /** Webhook signing key. TikTok signs with the app's client secret; this overrides it if TikTok ever issues a separate one. */
  webhookSecret?: string;
  /** How video bytes reach TikTok. FILE_UPLOAD (default) needs no domain verification; PULL_FROM_URL needs a verified media domain. */
  videoSource?: TikTokVideoSource;
  baseUrl?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Status polls after init before giving up with a retryable error (default 20). */
  maxPolls?: number;
  /** Delay between status polls (default 3000 ms). */
  pollIntervalMs?: number;
  /** Pages of video/list (20 videos each) walked per fetchActivity (default 5). */
  maxPages?: number;
  /** Max accepted clock skew for webhook signatures (default 300 s). */
  webhookToleranceSeconds?: number;
}

/** creator_info/query response (data). */
export interface TikTokCreatorInfo {
  creator_avatar_url?: string;
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

export interface TikTokVideo {
  id: string;
  title?: string;
  video_description?: string;
  create_time?: number;
  share_url?: string;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
  duration?: number;
}

interface TikTokStatus {
  status?: string;
  fail_reason?: string;
  /** TikTok's field name really is misspelled ("publicaly"); accept both spellings. */
  publicaly_available_post_id?: (string | number)[];
  publicly_available_post_id?: (string | number)[];
  uploaded_bytes?: number;
  downloaded_bytes?: number;
}

export interface TikTokHttpFailure {
  status: number;
  code?: string;
  body: unknown;
}

/** Starsign privacy → TikTok privacy_level. "unlisted" has no TikTok equivalent. */
export const TIKTOK_PRIVACY: Record<NonNullable<VariantOptions["privacy"]>, string | null> = {
  public: "PUBLIC_TO_EVERYONE",
  friends: "MUTUAL_FOLLOW_FRIENDS",
  followers: "FOLLOWER_OF_CREATOR",
  self: "SELF_ONLY",
  private: "SELF_ONLY",
  unlisted: null,
};

const AUDIT_HINT =
  "TikTok only lets unaudited API clients post SELF_ONLY (private) to private accounts, for at most 5 users per 24h. " +
  "Set the TikTok account to private and choose privacy 'self', or have the app audited for Direct Post in the TikTok developer portal.";

/** Video caption limit (UTF-16 units), photo title and description limits. */
export const TIKTOK_LIMITS = {
  videoCaption: 2200,
  photoTitle: 90,
  photoDescription: 4000,
  maxPhotos: 35,
  maxVideoBytes: 4 * 1024 * 1024 * 1024,
  /** Whole-file upload allowed up to this size; above it, chunks are required. */
  singleChunkMax: 64 * 1024 * 1024,
  /** Chunk size used for multi-chunk uploads (TikTok: 5 MB–64 MB per chunk, last chunk may be larger, ≤1000 chunks). */
  chunkSize: 10_000_000,
} as const;

/**
 * Chunk plan for FILE_UPLOAD. TikTok: total_chunk_count = floor(video_size / chunk_size); the last chunk absorbs the
 * remainder (so it can be up to 2× chunk_size). Files ≤ 64 MB go up as one chunk.
 */
export function tiktokChunkPlan(size: number): { chunkSize: number; totalChunks: number; ranges: { start: number; end: number }[] } {
  if (size <= 0) throw new ConnectorError("tiktok upload: empty video", "rejected", false);
  if (size <= TIKTOK_LIMITS.singleChunkMax) return { chunkSize: size, totalChunks: 1, ranges: [{ start: 0, end: size - 1 }] };
  const chunkSize = TIKTOK_LIMITS.chunkSize;
  const totalChunks = Math.floor(size / chunkSize);
  const ranges = Array.from({ length: totalChunks }, (_, i) => ({ start: i * chunkSize, end: i === totalChunks - 1 ? size - 1 : (i + 1) * chunkSize - 1 }));
  return { chunkSize, totalChunks, ranges };
}

/** TikTok error codes whose meaning beats the HTTP status. */
const REJECTED_CODES: Record<string, string> = {
  unaudited_client_can_only_post_to_private_accounts: AUDIT_HINT,
  reached_active_user_cap: AUDIT_HINT,
  privacy_level_option_mismatch: "the privacy level is not one this creator can use right now (creator_info changed); pick again",
  url_ownership_unverified: "PULL_FROM_URL needs the media domain (or URL prefix) verified in the TikTok developer portal; verify it or use FILE_UPLOAD",
  spam_risk_user_banned_from_posting: "TikTok has banned this account from posting",
  spam_risk_text: "TikTok flagged the caption as spam",
  spam_risk: "TikTok flagged the post as spam",
};
const AUTH_CODES = new Set(["access_token_invalid", "scope_not_authorized", "scope_permission_missed", "token_expired", "access_token_expired"]);

export function mapTikTokError(status: number, body: unknown, what: string): ConnectorError {
  const err = (body as { error?: { code?: unknown; message?: unknown; log_id?: unknown } } | undefined)?.error;
  const code = typeof err?.code === "string" ? err.code : undefined;
  const message = typeof err?.message === "string" ? err.message : typeof body === "string" ? body.slice(0, 200) : "";
  const msg = `tiktok ${what}: HTTP ${status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`;
  const cause: TikTokHttpFailure = { status, ...(code ? { code } : {}), body };
  if (code && REJECTED_CODES[code]) return new ConnectorError(`${msg} — ${REJECTED_CODES[code]}`, "rejected", false, cause);
  if (code && AUTH_CODES.has(code)) return new ConnectorError(msg, "auth", false, cause);
  if (code === "rate_limit_exceeded" || status === 429) return new ConnectorError(`${msg} (TikTok rate limits are per user token per minute; retry in about a minute)`, "rate_limit", true, cause);
  // The creator's daily post cap (shared across every app) — retry later, not now.
  if (code === "spam_risk_too_many_posts") return new ConnectorError(`${msg} (daily post cap for this creator reached; retry tomorrow)`, "rate_limit", true, cause);
  if (code === "internal_error" || status >= 500) return new ConnectorError(msg, "network", true, cause);
  if (code === "invalid_params" || code?.startsWith("invalid_") || code === "file_format_check_failed") return new ConnectorError(msg, "rejected", false, cause);
  const { kind, retryable } = classifyHttpStatus(status === 200 ? 400 : status);
  return new ConnectorError(msg, kind, retryable, cause);
}

/**
 * TikTok returns post ids as int64 JSON numbers (e.g. publicaly_available_post_id: [7300000000000000001]), which
 * JSON.parse rounds. Quote the integers of the id fields before parsing so ids survive intact.
 */
export function parseTikTokJson(text: string): unknown {
  if (!text) return undefined;
  const safe = text
    .replace(/("(?:publicaly|publicly)_available_post_id"\s*:\s*\[)([^\]]*)\]/g, (_m, head: string, list: string) => `${head}${list.replace(/(^|,)\s*(-?\d+)\s*(?=,|$)/g, '$1"$2"')}]`)
    .replace(/("(?:post_id|id)"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g, '$1"$2"');
  try {
    return JSON.parse(safe) as unknown;
  } catch {
    return text;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isPublishId(id: string): boolean {
  // publish ids look like "v_pub_file~v2-1.7…" / "p_pub_url~v2.7…"; video ids are plain digits.
  return /^[a-z]_(pub|inbox)_/i.test(id) || id.includes("~");
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v;
  return undefined;
}

function isPhotoMime(m: Media): boolean {
  const mime = m.mime?.toLowerCase();
  if (mime) return mime === "image/jpeg" || mime === "image/jpg" || mime === "image/webp";
  return /\.(jpe?g|webp)(\?|$)/i.test(m.url) || !/\.(png|gif|heic|bmp|tiff?)(\?|$)/i.test(m.url);
}

export class TikTokConnector implements Connector {
  readonly name = "tiktok";
  readonly networks: readonly Network[] = ["tiktok"];
  readonly connectMethod = "oauth" as const;
  media?: MediaFetcher;

  private readonly oauth: OAuth2Client;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxPolls: number;
  private readonly pollIntervalMs: number;
  private readonly maxPages: number;
  private readonly videoSource: TikTokVideoSource;
  private readonly webhookSecret: string | undefined;
  private readonly webhookTolerance: number;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  /** idempotencyKey → publish_id already initiated and uploaded, so a retry resumes polling instead of re-posting. */
  private readonly progress = new Map<string, { publishId: string; username: string | undefined; creator: TikTokCreatorInfo }>();

  constructor(opts: TikTokConnectorOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://open.tiktokapis.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxPolls = opts.maxPolls ?? 20;
    this.pollIntervalMs = opts.pollIntervalMs ?? 3000;
    this.maxPages = opts.maxPages ?? 5;
    this.videoSource = opts.videoSource ?? "FILE_UPLOAD";
    this.webhookSecret = opts.webhookSecret ?? opts.clientSecret;
    this.webhookTolerance = opts.webhookToleranceSeconds ?? 300;
    this.oauth = new OAuth2Client(
      {
        name: "tiktok",
        authorizeUrl: opts.authorizeUrl ?? "https://www.tiktok.com/v2/auth/authorize/",
        tokenUrl: opts.tokenUrl ?? `${this.baseUrl}/v2/oauth/token/`,
        scopes: TIKTOK_SCOPES,
        scopeSeparator: ",",
        clientIdParam: "client_key",
        // TODO(verify): TikTok documents PKCE as required for mobile/desktop only, and its desktop flow hex-encodes the
        // SHA-256 challenge (not base64url). Web apps authenticate with client_secret, so PKCE stays off here.
        pkce: false,
        clientAuth: "body",
        ...(opts.clientKey ? { clientId: opts.clientKey } : {}),
        ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
      },
      (i, init) => resolveFetch(this.fetchImpl)(i, init),
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
      reply: false,
      moderate: false,
      accountMetrics: true,
      webhooks: true,
      video: true,
      kinds: ["video", "post", "carousel"],
    };
  }

  // ---- connect ----------------------------------------------------------------------------

  oauthAuthorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    return this.oauth.authorizeUrl({ state: p.state, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge });
  }

  async oauthConnect(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<ConnectedAccount[]> {
    const token = await this.oauth.exchange({ code: p.code, redirectUri: p.redirectUri, codeVerifier: p.codeVerifier });
    const openId = typeof token.raw.open_id === "string" ? token.raw.open_id : undefined;
    const auth = this.toAuth(token, openId ?? "pending");
    const identity = await this.describeAccount(auth);
    // A TikTok login is exactly one creator account; TikTok has no business-manager style multi-account login here.
    return [{ network: "tiktok", identity, auth: { ...auth, openId: identity.externalId } }];
  }

  async describeAccount(raw: Record<string, unknown>): Promise<AccountIdentity> {
    const token = typeof raw.accessToken === "string" ? raw.accessToken : null;
    if (!token) throw new ConnectorError("tiktok: accessToken is required", "auth", false);
    const data = await this.api<{ user?: { open_id?: string; username?: string; display_name?: string } }>(token, "GET", "/v2/user/info/", {
      what: "user/info",
      query: { fields: "open_id,union_id,avatar_url,display_name,username" },
    });
    const u = data.user;
    if (!u?.open_id) throw new ConnectorError("tiktok user/info: response had no open_id", "unknown", false, data);
    return { externalId: u.open_id, handle: u.username ?? u.display_name ?? u.open_id, displayName: u.display_name ?? null };
  }

  async refreshAuth(account: AccountRef): Promise<AuthRefresh | null> {
    const auth = parseAuth(account);
    if (!auth.refreshToken) return null;
    if (auth.refreshExpiresAt && Date.parse(auth.refreshExpiresAt) <= this.now().getTime()) return null; // dead; person must reconnect
    const token = await this.oauth.refresh(auth.refreshToken);
    return { auth: this.toAuth(token, auth.openId) };
  }

  private toAuth(token: OAuth2Token, openId: string): TikTokAuth {
    return {
      accessToken: token.accessToken,
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
      ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
      ...(token.refreshExpiresAt ? { refreshExpiresAt: token.refreshExpiresAt } : {}),
      openId: typeof token.raw.open_id === "string" ? token.raw.open_id : openId,
      ...(token.scope ? { scope: token.scope } : {}),
    };
  }

  // ---- validation -------------------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const o = input.options ?? {};
    const videos = input.media.filter((m) => m.kind === "video");
    const images = input.media.filter((m) => m.kind === "image");
    for (const m of input.media) {
      if (m.kind === "gif") issues.push({ code: "unsupported_media", message: "tiktok does not accept GIFs; convert to MP4 video or JPEG/WebP photos" });
      if (m.kind === "document") issues.push({ code: "unsupported_media", message: "tiktok has no document posts" });
    }
    if (input.media.length === 0) issues.push({ code: "media_required", message: "tiktok posts need a video or 1–35 photos" });
    if (videos.length > 1) issues.push({ code: "too_many_media", message: "tiktok takes one video per post" });
    if (videos.length > 0 && images.length > 0) issues.push({ code: "unsupported_media", message: "tiktok cannot mix a video and photos in one post" });
    if (images.length > TIKTOK_LIMITS.maxPhotos) issues.push({ code: "too_many_media", message: `tiktok photo posts take at most ${TIKTOK_LIMITS.maxPhotos} photos` });
    for (const m of images) if (!isPhotoMime(m)) issues.push({ code: "unsupported_media", message: `tiktok photo posts accept JPEG or WebP only (${m.mime ?? m.url})` });
    for (const m of videos) {
      if (m.bytes && m.bytes > TIKTOK_LIMITS.maxVideoBytes) issues.push({ code: "unsupported_media", message: "tiktok videos are limited to 4 GB" });
      if (m.durationSeconds !== undefined && m.durationSeconds < 3) issues.push({ code: "unsupported_media", message: "tiktok videos must be at least 3 seconds" });
    }
    if (videos.length > 0 && input.text.length > TIKTOK_LIMITS.videoCaption) issues.push({ code: "too_long", message: `tiktok video captions are limited to ${TIKTOK_LIMITS.videoCaption} characters`, segment: 0 });
    if (images.length > 0 && videos.length === 0) {
      if (input.text.length > TIKTOK_LIMITS.photoDescription) issues.push({ code: "too_long", message: `tiktok photo descriptions are limited to ${TIKTOK_LIMITS.photoDescription} characters`, segment: 0 });
      if (o.title && o.title.length > TIKTOK_LIMITS.photoTitle) issues.push({ code: "too_long", message: `tiktok photo titles are limited to ${TIKTOK_LIMITS.photoTitle} characters` });
    }
    // TikTok's UX rules: the creator picks privacy every time; there is no default.
    if (!o.privacy) issues.push({ code: "empty", message: "tiktok requires choosing a privacy level for every post (no default); the options come from the creator's settings" });
    else if (TIKTOK_PRIVACY[o.privacy] === null) issues.push({ code: "empty", message: "tiktok has no 'unlisted' privacy; choose public, friends, followers or self" });
    if (o.brandedContent && (o.privacy === "self" || o.privacy === "private")) issues.push({ code: "empty", message: "tiktok does not allow branded content to be private (SELF_ONLY)" });
    return issues;
  }

  // ---- publishing -------------------------------------------------------------------------

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, () => this.publishOnce(account, parseAuth(account), input));
  }

  /** creator_info/query: must be called right before every Direct Post (TikTok's rule), and drives validation. */
  async creatorInfo(account: AccountRef): Promise<TikTokCreatorInfo> {
    return this.api<TikTokCreatorInfo>(parseAuth(account).accessToken, "POST", "/v2/post/publish/creator_info/query/", { what: "creator_info/query", json: {} });
  }

  private async publishOnce(account: AccountRef, auth: TikTokAuth, input: PublishInput): Promise<PublishResult> {
    const key = input.idempotencyKey;
    let state = this.progress.get(key);
    if (!state) {
      const creator = await this.creatorInfo(account);
      const isPhoto = input.media.length > 0 && input.media.every((m) => m.kind === "image");
      const plan = planPost(creator, input, isPhoto);
      const publishId = isPhoto ? await this.initPhoto(auth, input, plan) : await this.initVideo(account, auth, input, plan, creator);
      state = { publishId, username: creator.creator_username, creator };
      this.progress.set(key, state);
    }
    const status = await this.waitForPublish(auth, state.publishId, key);
    this.progress.delete(key);
    const postId = status.postId;
    const username = state.username ?? account.handle;
    return {
      externalId: postId ?? state.publishId,
      url: postId ? `https://www.tiktok.com/@${username}/video/${postId}` : null,
      raw: { publishId: state.publishId, status: status.raw, creatorNickname: state.creator.creator_nickname ?? null, creatorUsername: state.creator.creator_username ?? null },
    };
  }

  private async initVideo(account: AccountRef, auth: TikTokAuth, input: PublishInput, plan: PostPlan, creator: TikTokCreatorInfo): Promise<string> {
    const video = input.media[0];
    if (!video || video.kind !== "video") throw new ConnectorError("tiktok publish: a video post needs one video", "rejected", false);
    if (creator.max_video_post_duration_sec && video.durationSeconds && video.durationSeconds > creator.max_video_post_duration_sec) {
      throw new ConnectorError(`tiktok publish: video is ${video.durationSeconds}s but this creator can post at most ${creator.max_video_post_duration_sec}s`, "rejected", false);
    }
    const post_info: Record<string, unknown> = {
      title: input.text,
      privacy_level: plan.privacy,
      disable_comment: plan.disableComment,
      disable_duet: plan.disableDuet,
      disable_stitch: plan.disableStitch,
      brand_content_toggle: plan.brandContent,
      brand_organic_toggle: plan.brandOrganic,
    };
    const source = (account.config.videoSource as TikTokVideoSource | undefined) ?? this.videoSource;
    if (source === "PULL_FROM_URL") {
      const data = await this.api<{ publish_id?: string }>(auth.accessToken, "POST", "/v2/post/publish/video/init/", {
        what: "video/init",
        json: { post_info, source_info: { source: "PULL_FROM_URL", video_url: video.url } },
      });
      if (!data.publish_id) throw new ConnectorError("tiktok video/init: no publish_id", "unknown", false, data);
      return data.publish_id;
    }
    // Each chunk (up to 64 MB, the last up to ~2x chunk_size) is sent as a streamed body read piece by piece, so
    // neither the file nor a whole chunk is held in memory.
    return withMedia(mediaSource(this.media, this.fetchImpl), video, async (file) => {
      const mime = file.mime;
      if (file.size > TIKTOK_LIMITS.maxVideoBytes) throw new ConnectorError("tiktok publish: video exceeds 4 GB", "rejected", false);
      const chunks = tiktokChunkPlan(file.size);
      const data = await this.api<{ publish_id?: string; upload_url?: string }>(auth.accessToken, "POST", "/v2/post/publish/video/init/", {
        what: "video/init",
        json: { post_info, source_info: { source: "FILE_UPLOAD", video_size: file.size, chunk_size: chunks.chunkSize, total_chunk_count: chunks.totalChunks } },
      });
      if (!data.publish_id || !data.upload_url) throw new ConnectorError("tiktok video/init: no publish_id/upload_url", "unknown", false, data);
      for (const r of chunks.ranges) {
        let res: Response;
        try {
          res = await sendBody(
            resolveFetch(this.fetchImpl),
            data.upload_url,
            { method: "PUT", headers: { "content-type": mime || "video/mp4", "content-range": `bytes ${r.start}-${r.end}/${file.size}` } },
            rangeBody(file, r.start, r.end + 1 - r.start, mime || "video/mp4"),
          );
        } catch (err) {
          throw asNetworkError(err, "tiktok video upload");
        }
        if (!res.ok) throw mapTikTokError(res.status, await readJson(res), `video upload bytes ${r.start}-${r.end}`);
      }
      return data.publish_id;
    });
  }

  /** Photo posts are PULL_FROM_URL only: every image URL must be on a domain verified in the developer portal. */
  private async initPhoto(auth: TikTokAuth, input: PublishInput, plan: PostPlan): Promise<string> {
    const o = input.options ?? {};
    const data = await this.api<{ publish_id?: string }>(auth.accessToken, "POST", "/v2/post/publish/content/init/", {
      what: "content/init (photo)",
      json: {
        post_info: {
          ...(o.title ? { title: o.title } : {}),
          description: input.text,
          privacy_level: plan.privacy,
          disable_comment: plan.disableComment,
          // Starsign does not pick music for the creator; the room asks for music-usage consent (see docs).
          auto_add_music: false,
          brand_content_toggle: plan.brandContent,
          brand_organic_toggle: plan.brandOrganic,
        },
        source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: input.media.map((m) => m.url) },
        post_mode: "DIRECT_POST",
        media_type: "PHOTO",
      },
    });
    if (!data.publish_id) throw new ConnectorError("tiktok content/init: no publish_id", "unknown", false, data);
    return data.publish_id;
  }

  private async fetchStatus(auth: TikTokAuth, publishId: string): Promise<TikTokStatus> {
    return this.api<TikTokStatus>(auth.accessToken, "POST", "/v2/post/publish/status/fetch/", { what: "status/fetch", json: { publish_id: publishId } });
  }

  /** Poll post/publish/status/fetch until PUBLISH_COMPLETE or FAILED, bounded by maxPolls. */
  private async waitForPublish(auth: TikTokAuth, publishId: string, key: string): Promise<{ postId: string | undefined; raw: TikTokStatus }> {
    for (let i = 0; i < this.maxPolls; i++) {
      if (i > 0) await this.sleep(this.pollIntervalMs);
      const s = await this.fetchStatus(auth, publishId);
      if (s.status === "PUBLISH_COMPLETE") {
        const ids = s.publicaly_available_post_id ?? s.publicly_available_post_id ?? [];
        // No post id yet when the post is not public (SELF_ONLY, followers) or moderation is still running.
        return { postId: ids[0] !== undefined ? String(ids[0]) : undefined, raw: s };
      }
      if (s.status === "FAILED") {
        this.progress.delete(key);
        const reason = s.fail_reason ?? "unknown";
        if (reason === "internal") throw new ConnectorError(`tiktok publish ${publishId} failed: internal error at TikTok`, "network", true, s);
        if (reason === "spam_risk_too_many_posts") throw new ConnectorError(`tiktok publish ${publishId} failed: daily post cap reached`, "rate_limit", true, s);
        const hint = reason.includes("pull") ? " (TikTok could not download the media: is the domain verified and the URL public?)" : "";
        throw new ConnectorError(`tiktok publish ${publishId} failed: ${reason}${hint}`, "rejected", false, s);
      }
    }
    throw new ConnectorError(`tiktok publish ${publishId}: TikTok is still processing after ${this.maxPolls} checks; retry to keep waiting (no second post is made)`, "network", true, { publishId });
  }

  // ---- reading ----------------------------------------------------------------------------

  /** TikTok exposes no comments or DMs publicly; the inbox gets the account's own videos so they appear in the feed. */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const out: ActivityInput[] = [];
    let cursor: number | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const data = await this.api<{ videos?: TikTokVideo[]; cursor?: number; has_more?: boolean }>(auth.accessToken, "POST", "/v2/video/list/", {
        what: "video/list",
        query: { fields: "id,title,video_description,create_time,share_url,duration" },
        json: { max_count: 20, ...(cursor !== undefined ? { cursor } : {}) },
      });
      let older = false;
      for (const v of data.videos ?? []) {
        const at = v.create_time ? new Date(v.create_time * 1000).toISOString() : this.now().toISOString();
        if (!isAfter(at, since)) {
          older = true;
          continue;
        }
        out.push({
          network: "tiktok",
          kind: "own_post",
          externalId: v.id,
          authorHandle: account.handle,
          authorName: null,
          text: v.video_description ?? v.title ?? null,
          url: v.share_url ?? `https://www.tiktok.com/@${account.handle}/video/${v.id}`,
          parentExternalId: null,
          occurredAt: at,
          raw: v,
        });
      }
      if (older || !data.has_more || data.cursor === undefined) break;
      cursor = data.cursor;
    }
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    if (externalIds.length === 0) return [];
    const auth = parseAuth(account);
    // Posts saved before TikTok assigned a video id carry the publish_id; resolve it now if the post went public since.
    const videoIdFor = new Map<string, string>();
    for (const id of externalIds) {
      if (!isPublishId(id)) {
        videoIdFor.set(id, id);
        continue;
      }
      const s = await this.fetchStatus(auth, id);
      const resolved = (s.publicaly_available_post_id ?? s.publicly_available_post_id ?? [])[0];
      if (resolved !== undefined) videoIdFor.set(id, String(resolved));
    }
    const byVideo = new Map<string, string[]>();
    for (const [ext, vid] of videoIdFor) byVideo.set(vid, [...(byVideo.get(vid) ?? []), ext]);
    const videoIds = [...byVideo.keys()];
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    for (let i = 0; i < videoIds.length; i += 20) {
      const data = await this.api<{ videos?: TikTokVideo[] }>(auth.accessToken, "POST", "/v2/video/query/", {
        what: "video/query",
        query: { fields: "id,view_count,like_count,comment_count,share_count" },
        json: { filters: { video_ids: videoIds.slice(i, i + 20) } },
      });
      for (const v of data.videos ?? []) for (const ext of byVideo.get(v.id) ?? []) out.push(...videoMetrics(ext, v, observedAt));
    }
    return out;
  }

  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const data = await this.api<{ user?: { follower_count?: number; following_count?: number; likes_count?: number; video_count?: number } }>(auth.accessToken, "GET", "/v2/user/info/", {
      what: "user/info (stats)",
      query: { fields: "open_id,follower_count,following_count,likes_count,video_count" },
    });
    const u = data.user ?? {};
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    if (typeof u.follower_count === "number") out.push({ entityType: "social_account", entityId: account.id, metric: "followers_total", value: u.follower_count, observedAt, source: "tiktok" });
    if (typeof u.likes_count === "number") out.push({ entityType: "social_account", entityId: account.id, metric: "likes", value: u.likes_count, observedAt, source: "tiktok" });
    return out;
  }

  // ---- webhooks ---------------------------------------------------------------------------

  /**
   * TikTok signs deliveries with `TikTok-Signature: t=<unix>,s=<hex>` where s = HMAC-SHA256(client_secret, `${t}.${rawBody}`).
   * There is no subscription handshake.
   */
  readonly webhook: WebhookHandler = {
    verify: (headers, rawBody) => {
      const secret = this.webhookSecret;
      const sig = header(headers, "tiktok-signature");
      if (!secret || !sig) return false;
      const parts = Object.fromEntries(sig.split(",").map((kv) => kv.trim().split("=", 2) as [string, string]));
      const t = Number(parts.t);
      const s = parts.s ?? "";
      if (!Number.isFinite(t) || !/^[0-9a-f]+$/i.test(s)) return false;
      if (Math.abs(this.now().getTime() / 1000 - t) > this.webhookTolerance) return false;
      const want = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest();
      const got = Buffer.from(s, "hex");
      return got.length === want.length && timingSafeEqual(got, want);
    },
    parse: (body) => parseTikTokWebhook(body),
  };

  // ---- transport --------------------------------------------------------------------------

  private async api<T>(token: string, method: "GET" | "POST", path: string, opts: { what: string; query?: Record<string, string>; json?: unknown }): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json; charset=UTF-8";
      body = JSON.stringify(opts.json);
    }
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(url.toString(), { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch (err) {
      throw asNetworkError(err, `tiktok ${opts.what}`);
    }
    const parsed = parseTikTokJson(await res.text().catch(() => ""));
    const envelope = (parsed && typeof parsed === "object" ? parsed : {}) as { data?: unknown; error?: { code?: string } };
    // TikTok always returns an error object; "ok" means success. Some failures arrive with HTTP 200.
    if (!res.ok || (envelope.error?.code && envelope.error.code !== "ok")) throw mapTikTokError(res.status, parsed, opts.what);
    return (envelope.data ?? {}) as T;
  }
}

interface PostPlan {
  privacy: string;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  brandContent: boolean;
  brandOrganic: boolean;
}

/** Check the requested options against creator_info and produce post_info values. Throws ConnectorError("rejected"). */
export function planPost(creator: TikTokCreatorInfo, input: PublishInput, isPhoto: boolean): PostPlan {
  const o = input.options ?? {};
  if (!o.privacy) throw new ConnectorError("tiktok publish: choose a privacy level (TikTok forbids a default)", "rejected", false);
  const privacy = TIKTOK_PRIVACY[o.privacy];
  if (!privacy) throw new ConnectorError(`tiktok publish: privacy '${o.privacy}' has no TikTok equivalent`, "rejected", false);
  const allowed = creator.privacy_level_options ?? [];
  if (!allowed.includes(privacy)) {
    const audit = privacy !== "SELF_ONLY" && allowed.length === 1 && allowed[0] === "SELF_ONLY" ? ` ${AUDIT_HINT}` : "";
    throw new ConnectorError(`tiktok publish: privacy ${privacy} is not available to @${creator.creator_username ?? "this creator"}; allowed: ${allowed.join(", ") || "none"}.${audit}`, "rejected", false, creator);
  }
  if (o.brandedContent && privacy === "SELF_ONLY") throw new ConnectorError("tiktok publish: branded content cannot be private (SELF_ONLY)", "rejected", false);
  // TikTok's UX rule: interactions are off unless the person turns them on, and never on when the creator disabled them.
  const interaction = (allow: boolean | undefined, disabledByCreator: boolean | undefined, what: string): boolean => {
    if (allow === true && disabledByCreator) throw new ConnectorError(`tiktok publish: ${what} are turned off in @${creator.creator_username ?? "creator"}'s TikTok settings`, "rejected", false, creator);
    return allow !== true;
  };
  return {
    privacy,
    disableComment: interaction(o.allowComments, creator.comment_disabled, "comments"),
    disableDuet: isPhoto ? true : interaction(o.allowDuet, creator.duet_disabled, "duets"),
    disableStitch: isPhoto ? true : interaction(o.allowStitch, creator.stitch_disabled, "stitches"),
    // brandedContent = "Branded content" (paid partnership for a third party). "Your brand" (brand_organic_toggle) has no
    // Starsign option yet; see docs/integrations/tiktok.md.
    brandContent: o.brandedContent === true,
    brandOrganic: false,
  };
}

function videoMetrics(entityId: string, v: TikTokVideo, observedAt: string): MetricInput[] {
  const row = (metric: MetricName, value: number | undefined): MetricInput[] => (typeof value === "number" ? [{ entityType: "post_variant", entityId, metric, value, observedAt, source: "tiktok" }] : []);
  const total = (v.like_count ?? 0) + (v.comment_count ?? 0) + (v.share_count ?? 0);
  return [...row("video_views", v.view_count), ...row("likes", v.like_count), ...row("replies", v.comment_count), ...row("shares", v.share_count), ...row("engagements", total)];
}

/**
 * TikTok webhook body: { client_key, event, create_time, user_openid, content: "<JSON string>" }.
 * Only `post.publish.publicly_available` carries something for the inbox (the public video id); the rest are kept
 * raw by core and produce no items.
 */
export function parseTikTokWebhook(body: unknown): WebhookBatch[] {
  const b = (body && typeof body === "object" ? body : {}) as { event?: unknown; user_openid?: unknown; create_time?: unknown; content?: unknown };
  if (typeof b.user_openid !== "string" || typeof b.event !== "string") return [];
  let content: Record<string, unknown> = {};
  if (typeof b.content === "string") {
    const parsed = parseTikTokJson(b.content);
    content = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } else if (b.content && typeof b.content === "object") content = b.content as Record<string, unknown>;
  if (b.event !== "post.publish.publicly_available") return [];
  const postId = content.post_id !== undefined ? String(content.post_id) : undefined;
  if (!postId) return [];
  const at = typeof b.create_time === "number" ? new Date(b.create_time * 1000).toISOString() : new Date().toISOString();
  return [
    {
      network: "tiktok",
      accountExternalId: b.user_openid,
      items: [
        {
          network: "tiktok",
          kind: "own_post",
          externalId: postId,
          authorHandle: null,
          authorName: null,
          text: null,
          url: null,
          parentExternalId: typeof content.publish_id === "string" ? content.publish_id : null,
          occurredAt: at,
          raw: body,
        },
      ],
    },
  ];
}

function parseAuth(account: AccountRef): TikTokAuth {
  const parsed = TikTokAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`tiktok account ${account.handle}: auth blob needs accessToken and openId`, "auth", false, parsed.error);
  return parsed.data;
}

export function createTikTokConnectors(env: NodeJS.ProcessEnv): Connector[] {
  const source = env.TIKTOK_VIDEO_SOURCE === "PULL_FROM_URL" ? "PULL_FROM_URL" : "FILE_UPLOAD";
  return [
    new TikTokConnector({
      ...(env.TIKTOK_CLIENT_KEY ? { clientKey: env.TIKTOK_CLIENT_KEY } : {}),
      ...(env.TIKTOK_CLIENT_SECRET ? { clientSecret: env.TIKTOK_CLIENT_SECRET } : {}),
      ...(env.TIKTOK_WEBHOOK_SECRET ? { webhookSecret: env.TIKTOK_WEBHOOK_SECRET } : {}),
      videoSource: source,
    }),
  ];
}
