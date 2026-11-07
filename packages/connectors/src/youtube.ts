import type { ActivityInput, Media, MetricInput, MetricName, Network, VariantOptions } from "@starsign/schema";
import { z } from "zod";
import { GoogleAuth, googleClientFromEnv, googleOAuthClient, googleRequest, googleStatusOf, googleTokenToAuth, mapGoogleError, refreshGoogleAuth, type GoogleRequestOptions } from "./google-oauth.ts";
import { asNetworkError, downloadMedia, isAfter, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource, withMedia, type MediaReader } from "./media-io.ts";
import type { OAuth2Client } from "./oauth.ts";
import type { AccountIdentity, AccountRef, AuthRefresh, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, ModerationInput, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Native YouTube adapter: YouTube Data API v3 (uploads, comments, statistics) and YouTube Analytics API v2
 * (watch time, shares, subscribers gained). One Google login connects the channel(s) `channels?mine=true` returns.
 */

/** Scopes: upload videos, manage comments (force-ssl), read channel data, read analytics. */
export const YOUTUBE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

export const YouTubeAuth = GoogleAuth.extend({ channelId: z.string().min(1) });
export type YouTubeAuth = z.infer<typeof YouTubeAuth>;

/** Shorts: up to 3 minutes, vertical or square (YouTube classifies automatically; there is no API flag). */
export const YOUTUBE_SHORT_MAX_SECONDS = 180;
const TITLE_MAX = 100;
const TAGS_MAX_CHARS = 500;
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Quota units per call, from the Data API quota table.
 * TODO(verify): costs below are from the long-standing quota table (list = 1, write = 50, thumbnails.set = 50).
 */
export const YOUTUBE_QUOTA_COST = {
  list: 1,
  write: 50,
  thumbnail: 50,
} as const;

export interface YouTubeQuotaOptions {
  /** Default pool per Google Cloud project per day (resets at midnight Pacific). Default 10,000. */
  dailyUnits?: number;
  /**
   * Separate daily bucket for videos.insert, in calls. Since June 2026 Google bills uploads to their own
   * "Video Uploads" bucket (100 calls/day, 1 unit each). Set null for the legacy model where an upload costs
   * `uploadUnits` (~1,600) from the default pool. TODO(verify): confirm in the Cloud console quota page per project.
   */
  dailyUploads?: number | null;
  /** Legacy model only: units one upload takes from the default pool. Default 1600. */
  uploadUnits?: number;
  /** Refuse calls locally once the estimate is spent (default true). The API's own quota error is still mapped. */
  enforce?: boolean;
}

/**
 * Process-local estimate of today's quota use. Google counts per project across every process, so this is a floor:
 * it stops one worker from burning the day's quota (an upload loop, a polling bug) and makes the error readable.
 */
export class YouTubeQuota {
  private day = "";
  private units = 0;
  private uploads = 0;
  readonly dailyUnits: number;
  readonly dailyUploads: number | null;
  readonly uploadUnits: number;
  private readonly enforce: boolean;

  constructor(opts: YouTubeQuotaOptions = {}, private readonly now: () => Date = () => new Date()) {
    this.dailyUnits = opts.dailyUnits ?? 10_000;
    this.dailyUploads = opts.dailyUploads === undefined ? 100 : opts.dailyUploads;
    this.uploadUnits = opts.uploadUnits ?? 1600;
    this.enforce = opts.enforce ?? true;
  }

  usage(): { day: string; units: number; dailyUnits: number; uploads: number; dailyUploads: number | null } {
    this.roll();
    return { day: this.day, units: this.units, dailyUnits: this.dailyUnits, uploads: this.uploads, dailyUploads: this.dailyUploads };
  }

  /** Charge a call to the default pool, or throw rate_limit when the estimate says it would not fit. */
  charge(units: number, what: string): void {
    this.roll();
    if (this.enforce && this.units + units > this.dailyUnits) {
      throw new ConnectorError(
        `youtube quota: ${what} needs ${units} units but about ${this.dailyUnits - this.units} of ${this.dailyUnits} remain today; quota resets at midnight Pacific (${resetIn(this.now())})`,
        "rate_limit",
        true,
      );
    }
    this.units += units;
  }

  /** Charge one videos.insert. */
  chargeUpload(): void {
    if (this.dailyUploads === null) return this.charge(this.uploadUnits, "a video upload");
    this.roll();
    if (this.enforce && this.uploads + 1 > this.dailyUploads) {
      throw new ConnectorError(
        `youtube quota: the project's ${this.dailyUploads} video uploads for today are used; uploads reset at midnight Pacific (${resetIn(this.now())}). Request more through the YouTube API audit and quota extension form.`,
        "rate_limit",
        true,
      );
    }
    this.uploads += 1;
  }

  /** The API said the quota is gone: mark the estimate spent so later calls fail fast until the day rolls over. */
  exhaust(bucket: "units" | "uploads"): void {
    this.roll();
    if (bucket === "uploads" && this.dailyUploads !== null) this.uploads = this.dailyUploads;
    else this.units = this.dailyUnits;
  }

  private roll(): void {
    const d = pacificDay(this.now());
    if (d !== this.day) {
      this.day = d;
      this.units = 0;
      this.uploads = 0;
    }
  }
}

const pacificFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function pacificParts(d: Date): { day: string; hour: number; minute: number } {
  const parts = Object.fromEntries(pacificFmt.formatToParts(d).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** The YouTube quota day (Pacific time), YYYY-MM-DD. */
export function pacificDay(d: Date): string {
  return pacificParts(d).day;
}

function resetIn(d: Date): string {
  const { hour, minute } = pacificParts(d);
  const mins = 24 * 60 - (hour * 60 + minute);
  return `in about ${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
}

const QUOTA_HINT = "YouTube quota resets at midnight Pacific; the default is 10,000 units/day per Google Cloud project plus a separate daily video-upload bucket";

// ---- MP4 probe ------------------------------------------------------------------------------

/**
 * probeMp4 without reading the whole file: walk the top-level boxes with 16-byte header reads and probe only the moov
 * box (phones write it after the media data). Gives up (returns {}) when moov is missing or unreasonably large.
 */
export async function probeMp4Ranged(file: MediaReader, maxMoovBytes = 16 * 1024 * 1024): Promise<{ durationSeconds?: number; width?: number; height?: number }> {
  if (file.bytes) return probeMp4(file.bytes);
  let p = 0;
  for (let n = 0; n < 256 && p + 8 <= file.size; n++) {
    const h = await file.read(p, Math.min(16, file.size - p));
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let size = dv.getUint32(0);
    const type = String.fromCharCode(h[4]!, h[5]!, h[6]!, h[7]!);
    if (size === 1) {
      if (h.byteLength < 16) return {};
      size = Number(dv.getBigUint64(8));
    } else if (size === 0) size = file.size - p;
    if (size < 8 || p + size > file.size) return {};
    if (type === "moov") return size <= maxMoovBytes ? probeMp4(await file.read(p, size)) : {};
    p += size;
  }
  return {};
}

/** Duration and display dimensions from an MP4/MOV header (moov/mvhd + first video tkhd, rotation applied). */
export function probeMp4(bytes: Uint8Array): { durationSeconds?: number; width?: number; height?: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: { durationSeconds?: number; width?: number; height?: number } = {};
  const boxes = (start: number, end: number, visit: (type: string, body: number, bodyEnd: number) => void) => {
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      const type = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
      let header = 8;
      if (size === 1) {
        if (p + 16 > end) return;
        size = Number(dv.getBigUint64(p + 8));
        header = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < header || p + size > end) return;
      visit(type, p + header, p + size);
      p += size;
    }
  };
  boxes(0, bytes.length, (type, body, bodyEnd) => {
    if (type !== "moov") return;
    boxes(body, bodyEnd, (t, b, be) => {
      if (t === "mvhd" && be - b >= 32) {
        const v = bytes[b];
        const timescale = v === 1 ? dv.getUint32(b + 20) : dv.getUint32(b + 12);
        const duration = v === 1 ? Number(dv.getBigUint64(b + 24)) : dv.getUint32(b + 16);
        if (timescale > 0) out.durationSeconds = duration / timescale;
      }
      if (t === "trak" && out.width === undefined) {
        boxes(b, be, (tt, tb, tbe) => {
          if (tt !== "tkhd") return;
          const v = bytes[tb];
          const matrix = v === 1 ? tb + 52 : tb + 40;
          const dims = v === 1 ? tb + 88 : tb + 76;
          if (dims + 8 > tbe) return;
          const w = dv.getUint32(dims) / 65536;
          const h = dv.getUint32(dims + 4) / 65536;
          if (w <= 0 || h <= 0) return; // audio track
          const a = dv.getInt32(matrix);
          const d = dv.getInt32(matrix + 16);
          const rotated = a === 0 && d === 0; // 90 or 270 degrees: phones store portrait video as rotated landscape
          out.width = Math.round(rotated ? h : w);
          out.height = Math.round(rotated ? w : h);
        });
      }
    });
  });
  return out;
}

// ---- types ------------------------------------------------------------------------------------

export interface YouTubeConnectorOptions {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  fetch?: FetchLike;
  now?: () => Date;
  /** Waits between retries and processing polls; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Resumable upload chunk size in bytes; must be a multiple of 256 KiB. Default 8 MiB. */
  chunkSize?: number;
  /** Consecutive failures tolerated per upload before giving up (each followed by a status query). Default 5. */
  maxChunkRetries?: number;
  /** Processing status polls after upload, and the wait between them. Default 6 × 5 s. */
  processingPolls?: number;
  processingIntervalMs?: number;
  /** Comment pages (100 threads each) walked per moderation status per fetch. Default 3. */
  maxCommentPages?: number;
  quota?: YouTubeQuotaOptions;
  apiBase?: string;
  uploadBase?: string;
  analyticsBase?: string;
}

interface YtChannel {
  id: string;
  snippet?: { title?: string; customUrl?: string; description?: string; thumbnails?: unknown };
  statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean; viewCount?: string; videoCount?: string };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

interface YtVideo {
  id: string;
  snippet?: { publishedAt?: string; title?: string; channelId?: string };
  status?: { uploadStatus?: string; privacyStatus?: string; failureReason?: string; rejectionReason?: string };
  processingDetails?: { processingStatus?: string; processingFailureReason?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string; favoriteCount?: string };
}

interface YtComment {
  id: string;
  snippet?: {
    videoId?: string;
    channelId?: string;
    textDisplay?: string;
    textOriginal?: string;
    authorDisplayName?: string;
    authorChannelId?: { value?: string };
    parentId?: string;
    likeCount?: number;
    moderationStatus?: string;
    publishedAt?: string;
    updatedAt?: string;
  };
}

interface YtCommentThread {
  id: string;
  snippet?: { videoId?: string; channelId?: string; topLevelComment?: YtComment; totalReplyCount?: number; canReply?: boolean };
  replies?: { comments?: YtComment[] };
}

interface YtList<T> {
  items?: T[];
  nextPageToken?: string;
}

/** Map VariantOptions.privacy onto YouTube's three values; anything else is not a YouTube setting. */
function youtubePrivacy(p: VariantOptions["privacy"]): "public" | "unlisted" | "private" | null {
  if (p === undefined || p === "public") return "public";
  if (p === "unlisted" || p === "private") return p;
  return null;
}

export function youtubeWatchUrl(videoId: string, kind?: string): string {
  return kind === "short" ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`;
}

function commentUrl(videoId: string | undefined, commentId: string): string | null {
  return videoId ? `https://www.youtube.com/watch?v=${videoId}&lc=${commentId}` : null;
}

const num = (v: string | number | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** YouTube-specific publish knobs that VariantOptions does not carry. */
export interface YouTubeConfig {
  /** Default true. */
  notifySubscribers?: boolean;
  /** Default false (COPPA declaration). */
  madeForKids?: boolean;
  /** Video category id (default 22, People & Blogs). */
  categoryId?: string;
}

export class YouTubeConnector implements Connector {
  readonly name = "youtube";
  readonly networks: readonly Network[] = ["youtube"];
  readonly connectMethod = "oauth" as const;
  /** Set by core at boot; falls back to fetching media.url. */
  media?: MediaFetcher;

  readonly quota: YouTubeQuota;
  private readonly oauth: OAuth2Client;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly chunkSize: number;
  private readonly maxChunkRetries: number;
  private readonly processingPolls: number;
  private readonly processingIntervalMs: number;
  private readonly maxCommentPages: number;
  private readonly apiBase: string;
  private readonly uploadBase: string;
  private readonly analyticsBase: string;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  private readonly replies = new IdempotencyCache<PublishResult>();
  /** Resumable sessions by idempotency key, so a retried publish resumes instead of re-uploading. */
  private readonly sessions = new Map<string, { uploadUrl: string; total: number }>();
  /** Videos already uploaded by an attempt that failed later (thumbnail, polling), by idempotency key. */
  private readonly uploaded = new Map<string, YtVideo>();

  constructor(opts: YouTubeConnectorOptions = {}) {
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.oauth = googleOAuthClient("youtube", YOUTUBE_OAUTH_SCOPES, { clientId: opts.clientId, clientSecret: opts.clientSecret, fetch: opts.fetch, now: this.now });
    const chunk = opts.chunkSize ?? 8 * 1024 * 1024;
    if (chunk <= 0 || chunk % (256 * 1024) !== 0) throw new Error("youtube: chunkSize must be a positive multiple of 256 KiB");
    this.chunkSize = chunk;
    this.maxChunkRetries = opts.maxChunkRetries ?? 5;
    this.processingPolls = opts.processingPolls ?? 6;
    this.processingIntervalMs = opts.processingIntervalMs ?? 5000;
    this.maxCommentPages = opts.maxCommentPages ?? 3;
    this.quota = new YouTubeQuota(opts.quota, this.now);
    this.apiBase = (opts.apiBase ?? "https://www.googleapis.com/youtube/v3").replace(/\/+$/, "");
    this.uploadBase = (opts.uploadBase ?? "https://www.googleapis.com/upload/youtube/v3").replace(/\/+$/, "");
    this.analyticsBase = (opts.analyticsBase ?? "https://youtubeanalytics.googleapis.com/v2").replace(/\/+$/, "");
  }

  get connectConfigured(): boolean {
    return !!this.oauth.config.clientId && !!this.oauth.config.clientSecret;
  }

  capabilities(): ConnectorCapabilities {
    return { publish: true, fetchActivity: true, fetchMetrics: true, meteredReads: false, reply: true, moderate: true, accountMetrics: true, webhooks: false, video: true, kinds: ["video", "short"] };
  }

  // ---- connect -----------------------------------------------------------------------------

  oauthAuthorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    return this.oauth.authorizeUrl(p);
  }

  /** Exchange the code and return every channel the login manages (`channels?mine=true`). */
  async oauthConnect(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<ConnectedAccount[]> {
    const token = googleTokenToAuth(await this.oauth.exchange(p));
    const channels = await this.listChannels(token.accessToken, { mine: "true" });
    // TODO(verify): a Google login that owns several Brand Account channels picks ONE at the consent screen;
    // `mine=true` then returns that channel. Connecting another Brand channel means connecting again and choosing it.
    return channels.map((c) => ({
      network: "youtube" as const,
      identity: channelIdentity(c),
      auth: { ...token, channelId: c.id } satisfies YouTubeAuth,
      config: { channelId: c.id, ...(c.contentDetails?.relatedPlaylists?.uploads ? { uploadsPlaylistId: c.contentDetails.relatedPlaylists.uploads } : {}) },
    }));
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const a = GoogleAuth.extend({ channelId: z.string().optional() }).safeParse(auth);
    if (!a.success) throw new ConnectorError("youtube: auth blob needs accessToken", "auth", false, a.error);
    const [c] = await this.listChannels(a.data.accessToken, a.data.channelId ? { id: a.data.channelId } : { mine: "true" });
    if (!c) throw new ConnectorError("youtube: this Google account has no YouTube channel", "rejected", false);
    return channelIdentity(c);
  }

  async refreshAuth(account: AccountRef): Promise<AuthRefresh | null> {
    const next = await refreshGoogleAuth(this.oauth, parseAuth(account));
    return next ? { auth: next } : null;
  }

  // ---- validate ----------------------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const o = input.options ?? {};
    const kind = o.kind ?? "video";
    if (kind !== "video" && kind !== "short" && kind !== "post") issues.push({ code: "unsupported_media", message: `youtube cannot publish a "${kind}"; use kind "video" or "short"` });
    const title = o.title?.trim() ?? "";
    if (!title) issues.push({ code: "empty", message: "youtube needs a video title (options.title)" });
    else if ([...title].length > TITLE_MAX) issues.push({ code: "too_long", message: `youtube title is ${[...title].length} characters; the limit is ${TITLE_MAX}` });
    if (/[<>]/.test(title) || /[<>]/.test(input.text)) issues.push({ code: "unsupported_media", message: "youtube rejects < and > in titles and descriptions" });
    if (Buffer.byteLength(input.text, "utf8") > 5000) issues.push({ code: "too_long", message: "youtube descriptions are limited to 5000 bytes" });
    const tagChars = (o.tags ?? []).reduce((n, t) => n + t.length + (t.includes(" ") ? 2 : 0), 0) + Math.max(0, (o.tags?.length ?? 0) - 1);
    if (tagChars > TAGS_MAX_CHARS) issues.push({ code: "too_long", message: `youtube tags total ${tagChars} characters; the limit is ${TAGS_MAX_CHARS}` });
    if (youtubePrivacy(o.privacy) === null) issues.push({ code: "unsupported_media", message: `youtube privacy must be public, unlisted or private (got "${o.privacy}")` });
    const videos = input.media.filter((m) => m.kind === "video");
    if (input.media.length === 0) issues.push({ code: "media_required", message: "youtube needs one video file" });
    else if (videos.length !== 1 || input.media.length !== 1) issues.push({ code: "unsupported_media", message: "youtube publishes exactly one video per post (images are not supported; use options.thumbnailUrl for a custom thumbnail)" });
    const v = videos[0];
    if (v && kind === "short") issues.push(...shortIssues(v));
    return issues;
  }

  // ---- publish -----------------------------------------------------------------------------

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, () => this.publishVideo(account, parseAuth(account), input));
  }

  private async publishVideo(account: AccountRef, auth: YouTubeAuth, input: PublishInput): Promise<PublishResult> {
    const issues = this.validate(account, input);
    if (issues.length) throw new ConnectorError(`youtube publish: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
    const o = input.options ?? {};
    const kind = o.kind === "short" ? "short" : "video";
    const cfg = (account.config ?? {}) as YouTubeConfig;
    const privacy = youtubePrivacy(o.privacy) ?? "public";
    const key = input.idempotencyKey;

    let video = this.uploaded.get(key);
    if (!video) {
      const media = input.media[0]!;
      // Opened for ranged reads: the resumable upload reads one chunk at a time, so the video is never held whole.
      video = await withMedia(mediaSource(this.media, this.fetchImpl), media, async (file) => {
        const mime = file.mime || media.mime || "video/mp4";
        if (kind === "short") {
          const probed = await probeMp4Ranged(file);
          const problems = shortIssues({ ...media, durationSeconds: media.durationSeconds ?? probed.durationSeconds, width: media.width ?? probed.width, height: media.height ?? probed.height });
          if (problems.length) throw new ConnectorError(`youtube short: ${problems.map((i) => i.message).join("; ")}`, "rejected", false);
        }
        const resource: Record<string, unknown> = {
          snippet: { title: o.title!.trim(), description: input.text, ...(o.tags?.length ? { tags: o.tags } : {}), categoryId: cfg.categoryId ?? "22" },
          status: { privacyStatus: privacy, selfDeclaredMadeForKids: cfg.madeForKids ?? false, embeddable: true },
        };
        const parts = ["snippet", "status"];
        if (o.brandedContent) {
          // TODO(verify): paidProductPlacementDetails.hasPaidProductPlacement is settable on insert with this part.
          resource.paidProductPlacementDetails = { hasPaidProductPlacement: true };
          parts.push("paidProductPlacementDetails");
        }
        return this.resumableUpload(account, auth, key, file, mime, resource, parts, cfg.notifySubscribers ?? true);
      });
      this.uploaded.set(key, video);
    }
    const videoId = video.id;
    const url = youtubeWatchUrl(videoId, kind);
    const raw: Record<string, unknown> = { video };

    try {
      if (o.thumbnailUrl) raw.thumbnail = await this.setThumbnail(auth, videoId, o.thumbnailUrl);
      const processed = await this.waitForProcessing(auth, videoId);
      raw.processing = processed.processingDetails?.processingStatus ?? "unknown";
      raw.status = processed.status;
      if (privacy !== "private" && processed.status?.privacyStatus === "private") {
        raw.warning = "YouTube set this video to private: uploads from API projects that have not passed the YouTube API compliance audit are locked private";
      }
    } catch (err) {
      // The video exists on YouTube: tell core its id so the variant is never an orphan, and keep it in `uploaded`
      // so a retry (same idempotency key) does not upload it again.
      const ce = err instanceof ConnectorError ? err : new ConnectorError(err instanceof Error ? err.message : String(err), "unknown", true, err);
      ce.partial = { externalId: videoId, url, threadExternalIds: [] };
      throw ce;
    }
    this.uploaded.delete(key);
    return { externalId: videoId, url, raw };
  }

  private async readMedia(m: Media): Promise<{ bytes: Uint8Array; mime: string }> {
    const got = this.media ? await this.media.fetch(m) : await downloadMedia(resolveFetch(this.fetchImpl), m);
    return { bytes: got.bytes, mime: got.mime || m.mime || "video/mp4" };
  }

  /**
   * Resumable upload protocol: POST the metadata to open a session (Location header = session URI), PUT the bytes
   * in chunks with Content-Range, follow 308 Resume Incomplete + Range, and after a 5xx or a dropped connection ask
   * the session where it stands (`Content-Range: bytes * /total`) and continue from there.
   */
  private async resumableUpload(account: AccountRef, auth: YouTubeAuth, key: string, file: MediaReader, mime: string, resource: Record<string, unknown>, parts: string[], notify: boolean): Promise<YtVideo> {
    const total = file.size;
    let session = this.sessions.get(key);
    let offset = 0;
    if (session && session.total === total) {
      const st = await this.queryUpload(session.uploadUrl, total);
      if (st.done) return this.finishUpload(key, st.done);
      if (st.expired) session = undefined;
      else offset = st.offset ?? 0;
    }
    if (!session) {
      this.quota.chargeUpload();
      const url = new URL(`${this.uploadBase}/videos`);
      url.searchParams.set("uploadType", "resumable");
      url.searchParams.set("part", parts.join(","));
      url.searchParams.set("notifySubscribers", String(notify));
      let res: Response;
      try {
        res = await resolveFetch(this.fetchImpl)(url.toString(), {
          method: "POST",
          headers: {
            authorization: `Bearer ${auth.accessToken}`,
            "content-type": "application/json; charset=UTF-8",
            "x-upload-content-length": String(total),
            "x-upload-content-type": mime,
          },
          body: JSON.stringify(resource),
        });
      } catch (err) {
        throw asNetworkError(err, `youtube videos.insert (${account.handle})`);
      }
      if (!res.ok) throw this.quotaAware(mapGoogleError(res.status, res.headers, await readJson(res), { what: "youtube videos.insert", creating: true, rateHint: QUOTA_HINT }), "uploads");
      const location = res.headers.get("location");
      if (!location) throw new ConnectorError("youtube videos.insert: no upload session URI (Location header) in the response", "unknown", true);
      session = { uploadUrl: location, total };
      this.sessions.set(key, session);
      offset = 0;
    }

    let failures = 0;
    while (true) {
      const end = Math.min(offset + this.chunkSize, total) - 1;
      let res: Response | null = null;
      // One chunk (a multiple of 256 KiB, except the last) is read for each PUT and dropped after it.
      const chunk = await file.read(offset, end + 1 - offset);
      try {
        res = await resolveFetch(this.fetchImpl)(session.uploadUrl, {
          method: "PUT",
          headers: { authorization: `Bearer ${auth.accessToken}`, "content-type": mime, "content-range": `bytes ${offset}-${end}/${total}` },
          body: chunk as unknown as RequestInit["body"],
        });
      } catch {
        res = null; // dropped connection: treat like a 5xx and ask the session where it stands
      }
      if (res && (res.status === 200 || res.status === 201)) return this.finishUpload(key, (await readJson(res)) as YtVideo);
      if (res && res.status === 308) {
        await res.body?.cancel().catch(() => undefined);
        offset = nextOffset(res.headers.get("range"));
        failures = 0;
        continue;
      }
      if (res && (res.status === 404 || res.status === 410)) {
        this.sessions.delete(key);
        throw new ConnectorError(`youtube upload: session expired (HTTP ${res.status}); a retry starts a new upload`, "network", true);
      }
      if (res && res.status < 500) throw this.quotaAware(mapGoogleError(res.status, res.headers, await readJson(res), { what: "youtube upload", creating: true, rateHint: QUOTA_HINT }), "uploads");
      // 5xx or network: exponential backoff, then a status query.
      failures++;
      if (failures > this.maxChunkRetries) {
        throw new ConnectorError(`youtube upload: interrupted at byte ${offset} of ${total} after ${this.maxChunkRetries} retries (${res ? `HTTP ${res.status}` : "network error"}); a retry resumes the same session`, "network", true);
      }
      await this.sleep(Math.min(1000 * 2 ** (failures - 1), 32_000));
      const st = await this.queryUpload(session.uploadUrl, total);
      if (st.done) return this.finishUpload(key, st.done);
      if (st.expired) {
        this.sessions.delete(key);
        throw new ConnectorError("youtube upload: session expired; a retry starts a new upload", "network", true);
      }
      if (st.offset !== undefined) offset = st.offset;
    }
  }

  private finishUpload(key: string, video: YtVideo): YtVideo {
    this.sessions.delete(key);
    if (!video?.id) throw new ConnectorError("youtube upload: completed but the response had no video id", "unknown", false, video);
    return video;
  }

  /** Ask an upload session how many bytes it holds. Transient failures report `offset: undefined` (keep going). */
  private async queryUpload(uploadUrl: string, total: number): Promise<{ done?: YtVideo; expired?: boolean; offset?: number }> {
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(uploadUrl, { method: "PUT", headers: { "content-range": `bytes */${total}` } });
    } catch {
      return {};
    }
    if (res.status === 200 || res.status === 201) return { done: (await readJson(res)) as YtVideo, offset: total };
    if (res.status === 308) return { offset: nextOffset(res.headers.get("range")) };
    if (res.status === 404 || res.status === 410) return { expired: true };
    await res.body?.cancel().catch(() => undefined);
    return {};
  }

  /** Custom thumbnail. Best-effort: the video is already live, so a refused thumbnail is reported, not thrown. */
  private async setThumbnail(auth: YouTubeAuth, videoId: string, thumbnailUrl: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const { bytes, mime } = await this.readMedia({ kind: "image", url: thumbnailUrl });
      if (bytes.length > THUMBNAIL_MAX_BYTES) return { ok: false, error: `thumbnail is ${bytes.length} bytes; YouTube's limit is 2 MB` };
      this.quota.charge(YOUTUBE_QUOTA_COST.thumbnail, "thumbnails.set");
      await googleRequest(this.fetchImpl, auth.accessToken, `${this.uploadBase}/thumbnails/set`, {
        method: "POST",
        query: { videoId, uploadType: "media" },
        body: bytes,
        headers: { "content-type": mime },
        ctx: { what: "youtube thumbnails.set", creating: true, rateHint: QUOTA_HINT },
      });
      return { ok: true };
    } catch (err) {
      // TODO(verify): custom thumbnails need a phone-verified channel (403); Shorts may ignore custom thumbnails.
      if (err instanceof ConnectorError && (err.kind === "rejected" || err.kind === "auth")) return { ok: false, error: err.message };
      throw err;
    }
  }

  /** Poll processing with a bounded wait. Failure/rejection throws; still processing returns the latest state. */
  private async waitForProcessing(auth: YouTubeAuth, videoId: string): Promise<YtVideo> {
    let last: YtVideo = { id: videoId };
    for (let i = 0; i < this.processingPolls; i++) {
      if (i > 0) await this.sleep(this.processingIntervalMs);
      const res = await this.api<YtList<YtVideo>>(auth, "videos", { query: { part: "status,processingDetails", id: videoId }, ctx: { what: "youtube videos.list" } }, YOUTUBE_QUOTA_COST.list);
      const v = res.items?.[0];
      if (!v) continue; // not visible yet
      last = v;
      const ps = v.processingDetails?.processingStatus;
      const us = v.status?.uploadStatus;
      if (us === "rejected" || us === "failed" || us === "deleted" || ps === "failed" || ps === "terminated") {
        const why = v.status?.rejectionReason ?? v.status?.failureReason ?? v.processingDetails?.processingFailureReason ?? us ?? ps;
        throw new ConnectorError(`youtube processing: video ${videoId} ${us === "rejected" ? "was rejected" : "failed"} (${why})`, "rejected", false, v);
      }
      if (ps === "succeeded" || us === "processed") return v;
    }
    // Long videos can process for an hour or more. The upload itself is complete and the video exists, so this is a
    // success with processing still running (raw.processing = "processing"), not an error that would re-upload.
    return last;
  }

  // ---- comments ----------------------------------------------------------------------------

  /**
   * Reply to a video (new top-level comment thread: this is also how core posts options.firstComment) or to a
   * comment (comments.insert; YouTube has one reply level, so replies to replies attach to the thread).
   */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.replies.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const parent = input.parentExternalId;
      if (VIDEO_ID_RE.test(parent)) {
        const t = await this.api<YtCommentThread>(
          auth,
          "commentThreads",
          { method: "POST", query: { part: "snippet" }, json: { snippet: { videoId: parent, topLevelComment: { snippet: { textOriginal: input.text } } } }, ctx: { what: "youtube commentThreads.insert", creating: true } },
          YOUTUBE_QUOTA_COST.write,
        );
        return { externalId: t.id, url: commentUrl(parent, t.id), raw: t };
      }
      const parentId = parent.split(".")[0]!;
      const c = await this.api<YtComment>(
        auth,
        "comments",
        { method: "POST", query: { part: "snippet" }, json: { snippet: { parentId, textOriginal: input.text } }, ctx: { what: "youtube comments.insert", creating: true } },
        YOUTUBE_QUOTA_COST.write,
      );
      return { externalId: c.id, url: commentUrl(c.snippet?.videoId, c.id), raw: c };
    });
  }

  /**
   * hide → heldForReview (reversible, appears under "Held for review" in Studio), unhide → published,
   * delete → comments.delete for the channel's own comments, else setModerationStatus=rejected (removes it).
   * YouTube's API has no comment likes.
   */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    const auth = parseAuth(account);
    if (input.action === "like" || input.action === "unlike") throw new ConnectorError("youtube: the API cannot like comments", "rejected", false);
    if (input.action === "hide") return this.setModerationStatus(account, [input.externalId], "heldForReview");
    if (input.action === "unhide") return this.setModerationStatus(account, [input.externalId], "published");
    try {
      await this.api(auth, "comments", { method: "DELETE", query: { id: input.externalId }, ctx: { what: "youtube comments.delete", creating: true } }, YOUTUBE_QUOTA_COST.write);
    } catch (err) {
      // Only the author can delete; a channel owner removes other people's comments by rejecting them.
      if (googleStatusOf(err) !== 403) throw err;
      await this.setModerationStatus(account, [input.externalId], "rejected");
    }
  }

  /** comments.setModerationStatus for up to 50 comment ids. `banAuthor` only applies with "rejected". */
  async setModerationStatus(account: AccountRef, ids: string[], status: "heldForReview" | "published" | "rejected", banAuthor = false): Promise<void> {
    const auth = parseAuth(account);
    for (let i = 0; i < ids.length; i += 50) {
      await this.api(
        auth,
        "comments/setModerationStatus",
        { method: "POST", query: { id: ids.slice(i, i + 50).join(","), moderationStatus: status, ...(banAuthor && status === "rejected" ? { banAuthor: "true" } : {}) }, ctx: { what: "youtube comments.setModerationStatus", creating: true } },
        YOUTUBE_QUOTA_COST.write,
      );
    }
  }

  /** Comment threads on the channel's videos, published and held for review, newest first. */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const channelId = auth.channelId;
    const out = new Map<string, ActivityInput>();
    for (const moderationStatus of ["published", "heldForReview"] as const) {
      let pageToken: string | undefined;
      for (let page = 0; page < this.maxCommentPages; page++) {
        const res = await this.api<YtList<YtCommentThread>>(
          auth,
          "commentThreads",
          {
            query: { part: "snippet,replies", allThreadsRelatedToChannelId: channelId, maxResults: "100", order: "time", textFormat: "plainText", moderationStatus, ...(pageToken ? { pageToken } : {}) },
            ctx: { what: "youtube commentThreads.list" },
          },
          YOUTUBE_QUOTA_COST.list,
        );
        const threads = res.items ?? [];
        let older = false;
        for (const t of threads) {
          const top = t.snippet?.topLevelComment;
          if (!top) continue;
          const videoId = t.snippet?.videoId ?? top.snippet?.videoId;
          const topAt = top.snippet?.publishedAt ?? "";
          if (top.snippet?.authorChannelId?.value !== channelId && isAfter(topAt, since)) {
            out.set(top.id, this.commentToActivity(top, "comment", videoId ?? null, videoId, moderationStatus));
          }
          if (topAt && !isAfter(topAt, since) && !isAfter(top.snippet?.updatedAt ?? topAt, since)) older = true;
          // TODO(verify): `replies` carries at most a few replies per thread; long threads need comments.list?parentId.
          for (const r of t.replies?.comments ?? []) {
            if (r.snippet?.authorChannelId?.value === channelId) continue; // the channel's own replies are not inbox items
            if (!isAfter(r.snippet?.publishedAt ?? "", since)) continue;
            out.set(r.id, this.commentToActivity(r, "reply", t.id, videoId, moderationStatus));
          }
        }
        pageToken = res.nextPageToken;
        if (!pageToken || older || threads.length === 0) break;
      }
    }
    return [...out.values()].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  private commentToActivity(c: YtComment, kind: "comment" | "reply", parent: string | null, videoId: string | undefined, moderationStatus: string): ActivityInput {
    const name = c.snippet?.authorDisplayName ?? null;
    return {
      network: "youtube",
      kind,
      externalId: c.id,
      authorHandle: name?.startsWith("@") ? name.slice(1) : null,
      authorName: name,
      text: c.snippet?.textOriginal ?? c.snippet?.textDisplay ?? null,
      url: commentUrl(videoId, c.id),
      parentExternalId: parent,
      occurredAt: c.snippet?.publishedAt ?? this.now().toISOString(),
      raw: { ...c, videoId, moderationStatus: c.snippet?.moderationStatus ?? moderationStatus },
    };
  }

  // ---- metrics -----------------------------------------------------------------------------

  /** videos.list statistics (fresh) + Analytics API per-video totals (watch time, shares, subscribers; ~2 day lag). */
  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    const ids = externalIds.filter((id) => VIDEO_ID_RE.test(id));
    if (ids.length === 0) return [];
    const auth = parseAuth(account);
    const observedAt = this.now().toISOString();
    const rows: MetricInput[] = [];
    const row = (id: string, metric: MetricName, value: number | undefined) => {
      if (value !== undefined) rows.push({ entityType: "post_variant", entityId: id, metric, value, observedAt, source: "youtube" });
    };
    const videos: YtVideo[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const res = await this.api<YtList<YtVideo>>(auth, "videos", { query: { part: "statistics,snippet", id: ids.slice(i, i + 50).join(","), maxResults: "50" }, ctx: { what: "youtube videos.list" } }, YOUTUBE_QUOTA_COST.list);
      videos.push(...(res.items ?? []));
    }
    const analytics = await this.videoAnalytics(auth, videos);
    for (const v of videos) {
      const s = v.statistics ?? {};
      const a = analytics.get(v.id);
      const likes = num(s.likeCount);
      const comments = num(s.commentCount);
      row(v.id, "video_views", num(s.viewCount));
      row(v.id, "likes", likes);
      row(v.id, "replies", comments);
      if (a) {
        row(v.id, "watch_time_seconds", a.estimatedMinutesWatched !== undefined ? Math.round(a.estimatedMinutesWatched * 60) : undefined);
        row(v.id, "shares", a.shares);
        row(v.id, "follows", a.subscribersGained);
      }
      if (likes !== undefined || comments !== undefined || a?.shares !== undefined) row(v.id, "engagements", (likes ?? 0) + (comments ?? 0) + (a?.shares ?? 0));
    }
    return rows;
  }

  private async videoAnalytics(auth: YouTubeAuth, videos: YtVideo[]): Promise<Map<string, Record<string, number>>> {
    const out = new Map<string, Record<string, number>>();
    if (videos.length === 0) return out;
    const earliest = videos.map((v) => v.snippet?.publishedAt).filter((d): d is string => !!d).sort()[0];
    const startDate = earliest ? pacificDay(new Date(earliest)) : "2005-04-23";
    const endDate = pacificDay(this.now());
    // TODO(verify): v2 accepts up to 500 ids in the video filter (documented for v1); we send 200 per query.
    for (let i = 0; i < videos.length; i += 200) {
      const chunk = videos.slice(i, i + 200).map((v) => v.id);
      let res: { columnHeaders?: { name: string }[]; rows?: (string | number)[][] };
      try {
        res = await googleRequest(this.fetchImpl, auth.accessToken, `${this.analyticsBase}/reports`, {
          query: { ids: "channel==MINE", startDate, endDate, metrics: "views,estimatedMinutesWatched,likes,comments,shares,subscribersGained", dimensions: "video", filters: `video==${chunk.join(",")}`, maxResults: "200" },
          ctx: { what: "youtube analytics reports.query" },
        });
      } catch (err) {
        // Missing yt-analytics scope or analytics unavailable for the channel: keep the Data API numbers.
        if (googleStatusOf(err) === 403 || googleStatusOf(err) === 400) continue;
        throw err;
      }
      const cols = (res.columnHeaders ?? []).map((c) => c.name);
      for (const r of res.rows ?? []) {
        const rec: Record<string, number> = {};
        let id = "";
        cols.forEach((name, j) => {
          if (name === "video") id = String(r[j]);
          else if (typeof r[j] === "number") rec[name] = r[j] as number;
        });
        if (id) out.set(id, rec);
      }
    }
    return out;
  }

  /** followers_total = subscriberCount (absent when the channel hides it), video_views = lifetime channel views. */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const [c] = await this.listChannels(auth.accessToken, { id: auth.channelId });
    if (!c) throw new ConnectorError(`youtube: channel ${auth.channelId} not found`, "rejected", false);
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    const subs = c.statistics?.hiddenSubscriberCount ? undefined : num(c.statistics?.subscriberCount);
    if (subs !== undefined) out.push({ entityType: "social_account", entityId: account.id, metric: "followers_total", value: subs, observedAt, source: "youtube" });
    const views = num(c.statistics?.viewCount);
    if (views !== undefined) out.push({ entityType: "social_account", entityId: account.id, metric: "video_views", value: views, observedAt, source: "youtube" });
    return out;
  }

  /** Processing state of one video (public for status checks after a publish returned raw.processing="processing"). */
  async processingStatus(account: AccountRef, videoId: string): Promise<{ processingStatus?: string; uploadStatus?: string; privacyStatus?: string }> {
    const res = await this.api<YtList<YtVideo>>(parseAuth(account), "videos", { query: { part: "status,processingDetails", id: videoId }, ctx: { what: "youtube videos.list" } }, YOUTUBE_QUOTA_COST.list);
    const v = res.items?.[0];
    return {
      ...(v?.processingDetails?.processingStatus ? { processingStatus: v.processingDetails.processingStatus } : {}),
      ...(v?.status?.uploadStatus ? { uploadStatus: v.status.uploadStatus } : {}),
      ...(v?.status?.privacyStatus ? { privacyStatus: v.status.privacyStatus } : {}),
    };
  }

  // ---- transport ---------------------------------------------------------------------------

  private async listChannels(accessToken: string, filter: { mine: "true" } | { id: string }): Promise<YtChannel[]> {
    this.quota.charge(YOUTUBE_QUOTA_COST.list, "channels.list");
    const res = await googleRequest<YtList<YtChannel>>(this.fetchImpl, accessToken, `${this.apiBase}/channels`, {
      query: { part: "snippet,statistics,contentDetails", maxResults: "50", ...filter },
      ctx: { what: "youtube channels.list", rateHint: QUOTA_HINT },
    }).catch((e: unknown) => {
      throw e instanceof ConnectorError ? this.quotaAware(e, "units") : e;
    });
    return res.items ?? [];
  }

  private async api<T>(auth: YouTubeAuth, path: string, opts: GoogleRequestOptions, cost: number): Promise<T> {
    this.quota.charge(cost, opts.ctx.what.replace(/^youtube /, ""));
    try {
      return await googleRequest<T>(this.fetchImpl, auth.accessToken, `${this.apiBase}/${path}`, { ...opts, ctx: { rateHint: QUOTA_HINT, ...opts.ctx } });
    } catch (err) {
      throw err instanceof ConnectorError ? this.quotaAware(err, "units") : err;
    }
  }

  /** When Google says the daily quota is gone, make the local estimate agree so later calls fail fast with the same message. */
  private quotaAware(err: ConnectorError, bucket: "units" | "uploads"): ConnectorError {
    const reason = (err.cause as { reason?: string } | undefined)?.reason;
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") this.quota.exhaust(bucket);
    if (reason === "uploadLimitExceeded") {
      return new ConnectorError(`${err.message} (this channel hit YouTube's per-channel daily upload limit; try again tomorrow)`, "rate_limit", true, err.cause);
    }
    return err;
  }
}

function nextOffset(range: string | null): number {
  const m = range?.match(/bytes=\d+-(\d+)/);
  return m ? Number(m[1]) + 1 : 0;
}

function shortIssues(v: Pick<Media, "durationSeconds" | "width" | "height">): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (v.durationSeconds !== undefined && v.durationSeconds > YOUTUBE_SHORT_MAX_SECONDS) {
    issues.push({ code: "unsupported_media", message: `a YouTube Short is at most ${YOUTUBE_SHORT_MAX_SECONDS} s; this video is ${Math.round(v.durationSeconds)} s (publish it as kind "video")` });
  }
  if (v.width !== undefined && v.height !== undefined && v.width > v.height) {
    issues.push({ code: "unsupported_media", message: `a YouTube Short must be vertical or square; this video is ${v.width}x${v.height}` });
  }
  return issues;
}

function channelIdentity(c: YtChannel): AccountIdentity {
  const custom = c.snippet?.customUrl;
  return { externalId: c.id, handle: custom ? custom.replace(/^@/, "") : (c.snippet?.title ?? c.id), displayName: c.snippet?.title ?? null };
}

function parseAuth(account: AccountRef): YouTubeAuth {
  const raw = { ...(account.auth ?? {}) } as Record<string, unknown>;
  if (typeof raw.channelId !== "string" || !raw.channelId) raw.channelId = account.externalId;
  const parsed = YouTubeAuth.safeParse(raw);
  if (!parsed.success) throw new ConnectorError(`youtube account ${account.handle}: auth blob needs accessToken and channelId`, "auth", false, parsed.error);
  return parsed.data;
}

/** Factory: one YouTube connector on the shared Google OAuth client (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). */
export function createYouTubeConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [new YouTubeConnector({ ...googleClientFromEnv(env) })];
}
