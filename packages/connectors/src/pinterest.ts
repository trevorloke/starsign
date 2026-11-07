import type { ActivityInput, Media, MetricInput, MetricName, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, isAfter, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource, sendBody, setMediaFile, uploadForm, withMedia } from "./media-io.ts";
import { OAuth2Client, clientFromEnv, type OAuth2Token } from "./oauth.ts";
import type { AccountIdentity, AccountRef, AuthRefresh, ConnectedAccount, Connector, ConnectorCapabilities, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Pinterest adapter over API v5 (https://api.pinterest.com/v5).
 *
 * Pins are pull-style for images (Pinterest fetches `media.url`) and push-style for video (register an upload,
 * POST the file to the returned S3 URL, poll until it succeeds). Every Pin needs a board: `options.boardId`,
 * chosen from `listBoards(account)`. API v5 has no comment endpoints, so there is no reply, moderation or
 * comment inbox; `fetchActivity` reports the account's own Pins.
 *
 * Trial access apps cannot create production Pins (Pinterest answers 403); point PINTEREST_API_BASE_URL at the
 * sandbox (https://api-sandbox.pinterest.com/v5) until Standard access is granted.
 * TODO(verify): whether the sandbox accepts the OAuth user token or only the sandbox token from the developer portal.
 */

/** boards:read/write to list and pick boards, pins:read/write to publish and read Pin analytics, user_accounts:read for the profile and account analytics. Organic analytics need no ads scope. */
export const PINTEREST_OAUTH_SCOPES = ["boards:read", "boards:write", "pins:read", "pins:write", "user_accounts:read"];

export const PinterestAuth = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.string().optional(),
  refreshExpiresAt: z.string().optional(),
  scope: z.string().optional(),
  username: z.string().optional(),
});
export type PinterestAuth = z.infer<typeof PinterestAuth>;

export interface PinterestConnectorOptions {
  clientId?: string;
  clientSecret?: string;
  /** https://api.pinterest.com/v5, or https://api-sandbox.pinterest.com/v5 for Trial access testing. */
  baseUrl?: string;
  /** Token endpoint; defaults to the production API even when baseUrl is the sandbox. */
  tokenUrl?: string;
  authorizeUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
  /** Pages (25 Pins each) fetchActivity walks. */
  maxPages?: number;
}

export interface PinterestBoard {
  id: string;
  name: string;
  description: string | null;
  privacy: string | null;
}

export interface PinterestHttpFailure {
  status: number;
  body: unknown;
}

interface PinterestPin {
  id?: string;
  title?: string | null;
  description?: string | null;
  link?: string | null;
  created_at?: string;
  board_id?: string;
  media?: { media_type?: string };
}

interface PinterestUserAccount {
  id?: string;
  username?: string;
  business_name?: string | null;
  account_type?: string;
  follower_count?: number;
  following_count?: number;
  pin_count?: number;
  monthly_views?: number;
}

const PIN_METRICS = ["IMPRESSION", "SAVE", "PIN_CLICK", "OUTBOUND_CLICK"];
// TODO(verify): which video / reaction / comment metric types pin analytics accepts for organic Pins.
const PIN_EXTRA_METRICS = ["VIDEO_MRC_VIEW", "VIDEO_V50_WATCH_TIME", "TOTAL_COMMENTS", "TOTAL_REACTIONS"];

export function pinterestPinUrl(id: string): string {
  return `https://www.pinterest.com/pin/${id}/`;
}

function errorDetail(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 200);
  if (!body || typeof body !== "object") return "";
  const b = body as { code?: unknown; message?: unknown };
  return [b.code !== undefined ? `code ${String(b.code)}` : undefined, typeof b.message === "string" ? b.message : undefined].filter(Boolean).join(": ");
}

/** HTTP status → ConnectorError. A 403 on create is usually Trial access or a board the user cannot pin to. */
export function mapPinterestError(status: number, headers: Headers, body: unknown, ctx: { what: string; creating?: boolean }): ConnectorError {
  const detail = errorDetail(body);
  const msg = `pinterest ${ctx.what}: HTTP ${status}${detail ? ` ${detail}` : ""}`;
  const cause: PinterestHttpFailure = { status, body };
  if (status === 401) return new ConnectorError(`${msg} (token expired or revoked)`, "auth", false, cause);
  if (status === 403) {
    if (/trial/i.test(detail)) return new ConnectorError(`${msg} (this app has Trial access: production Pins need Standard access; use the sandbox API meanwhile)`, "rejected", false, cause);
    return new ConnectorError(msg, ctx.creating ? "rejected" : "auth", false, cause);
  }
  if (status === 429) {
    const retryAfter = headers.get("retry-after");
    const reset = headers.get("x-ratelimit-reset");
    return new ConnectorError(`${msg}; ${retryAfter ? `retry after ${retryAfter}s` : reset ? `limit resets in ${reset}s` : "rate limited"}`, "rate_limit", true, cause);
  }
  const { kind, retryable } = classifyHttpStatus(status);
  return new ConnectorError(msg, kind, retryable, cause);
}

function statusOf(err: unknown): number | undefined {
  const c = err instanceof ConnectorError ? (err.cause as Partial<PinterestHttpFailure> | undefined) : undefined;
  return typeof c?.status === "number" ? c.status : undefined;
}

function parseAuth(account: AccountRef): PinterestAuth {
  const p = PinterestAuth.safeParse(account.auth ?? {});
  if (!p.success) throw new ConnectorError(`pinterest account ${account.handle}: auth blob needs accessToken`, "auth", false, p.error);
  return p.data;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export class PinterestConnector implements Connector {
  readonly name = "pinterest";
  readonly networks: readonly Network[] = ["pinterest"];
  readonly connectMethod = "oauth" as const;
  media?: Connector["media"];

  readonly oauth: OAuth2Client;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly maxPages: number;
  private readonly published = new IdempotencyCache<PublishResult>();
  /** Registered video media ids per idempotency key, so a retry after a processing timeout keeps polling. */
  private readonly uploads = new Map<string, string>();

  constructor(opts: PinterestConnectorOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.pinterest.com/v5").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollIntervalMs = opts.pollIntervalMs ?? 3000;
    this.maxPolls = opts.maxPolls ?? 40;
    this.maxPages = opts.maxPages ?? 2;
    this.oauth = new OAuth2Client(
      {
        name: "pinterest",
        authorizeUrl: opts.authorizeUrl ?? "https://www.pinterest.com/oauth/",
        tokenUrl: opts.tokenUrl ?? "https://api.pinterest.com/v5/oauth/token",
        scopes: PINTEREST_OAUTH_SCOPES,
        scopeSeparator: ",",
        pkce: false,
        clientAuth: "basic",
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
      // Own Pins only: API v5 exposes no comments, so there is nothing to reply to or moderate.
      fetchActivity: true,
      fetchMetrics: true,
      meteredReads: false,
      reply: false,
      moderate: false,
      accountMetrics: true,
      webhooks: false,
      video: true,
      kinds: ["pin", "carousel", "video"],
    };
  }

  // ---- connect ---------------------------------------------------------------------------

  oauthAuthorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    return this.oauth.authorizeUrl({ state: p.state, redirectUri: p.redirectUri });
  }

  async oauthConnect(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<ConnectedAccount[]> {
    const token = await this.oauth.exchange({ code: p.code, redirectUri: p.redirectUri });
    const me = await this.userAccount(token.accessToken);
    const identity = identityOf(me);
    return [{ network: "pinterest", identity, auth: authFromToken(token, me.username) }];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const token = typeof auth.accessToken === "string" ? auth.accessToken : null;
    if (!token) throw new ConnectorError("pinterest: accessToken is required", "auth", false);
    return identityOf(await this.userAccount(token));
  }

  /**
   * Access tokens last 30 days. Apps created on or after 2025-09-25 get continuous refresh tokens (60 days,
   * renewed on every refresh); the new refresh token returned here must be persisted.
   */
  async refreshAuth(account: AccountRef): Promise<AuthRefresh | null> {
    const auth = parseAuth(account);
    if (!auth.refreshToken) return null;
    if (auth.refreshExpiresAt && Date.parse(auth.refreshExpiresAt) <= this.now().getTime()) return null;
    // TODO(verify): apps created before 2025-09-25 must send continuous_refresh=true to get continuous tokens;
    // OAuth2Client does not send it, so those apps keep the legacy 365-day refresh token.
    const t = await this.oauth.refresh(auth.refreshToken);
    const next = authFromToken(t, auth.username);
    if (!next.refreshExpiresAt && auth.refreshExpiresAt && next.refreshToken === auth.refreshToken) next.refreshExpiresAt = auth.refreshExpiresAt;
    return { auth: next };
  }

  private async userAccount(token: string): Promise<PinterestUserAccount> {
    const r = await this.request<PinterestUserAccount>(token, "GET", "/user_account", { what: "user_account" });
    if (!r.username) throw new ConnectorError("pinterest user_account: response had no username", "unknown", false, r);
    return r;
  }

  // ---- boards ----------------------------------------------------------------------------

  /** Boards the account can pin to, for the room's board picker (options.boardId). */
  async listBoards(account: AccountRef): Promise<PinterestBoard[]> {
    const auth = parseAuth(account);
    const out: PinterestBoard[] = [];
    let bookmark: string | undefined;
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ page_size: "100", ...(bookmark ? { bookmark } : {}) });
      const r = await this.request<{ items?: { id?: string; name?: string; description?: string | null; privacy?: string | null }[]; bookmark?: string | null }>(
        auth.accessToken,
        "GET",
        `/boards?${q}`,
        { what: "list boards" },
      );
      for (const b of r.items ?? []) if (b.id) out.push({ id: b.id, name: b.name ?? b.id, description: b.description ?? null, privacy: b.privacy ?? null });
      bookmark = r.bookmark ?? undefined;
      if (!bookmark) break;
    }
    return out;
  }

  // ---- validate & publish ---------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const o = input.options ?? {};
    // ValidationIssue has no dedicated code for a missing option; "empty" is the closest honest one.
    if (!o.boardId) issues.push({ code: "empty", message: "pinterest needs a board: set options.boardId (pick one from listBoards)" });
    const media = input.media;
    if (media.length === 0) issues.push({ code: "media_required", message: "a Pin needs an image or a video" });
    const videos = media.filter((m) => m.kind === "video");
    const images = media.filter((m) => m.kind === "image" || m.kind === "gif");
    if (media.some((m) => m.kind === "document")) issues.push({ code: "unsupported_media", message: "pinterest does not accept documents" });
    if (videos.length > 0 && media.length > 1) issues.push({ code: "unsupported_media", message: "a video Pin carries exactly one video" });
    // TODO(verify): carousel Pins take 2 to 5 images.
    if (images.length > 5) issues.push({ code: "too_many_media", message: `${images.length} > 5 images in a Pinterest carousel` });
    for (const v of videos) {
      // TODO(verify): organic video Pin limits (4 seconds to 15 minutes, up to 2 GB).
      if (v.durationSeconds !== undefined && (v.durationSeconds < 4 || v.durationSeconds > 900)) issues.push({ code: "unsupported_media", message: `pinterest video must be 4 seconds to 15 minutes (got ${v.durationSeconds}s)` });
      if (v.bytes !== undefined && v.bytes > 2 * 1024 ** 3) issues.push({ code: "unsupported_media", message: "pinterest video must be 2 GB or smaller" });
    }
    if (o.title && o.title.length > 100) issues.push({ code: "too_long", message: `Pin title is ${o.title.length} > 100 characters` });
    if ([...input.text].length > 800) issues.push({ code: "too_long", message: "Pin description is limited to 800 characters" });
    const alt = media[0]?.alt;
    if (alt && alt.length > 500) issues.push({ code: "too_long", message: "Pin alt text is limited to 500 characters" });
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.published.run(input.idempotencyKey, () => this.createPin(account, parseAuth(account), input));
  }

  private async createPin(account: AccountRef, auth: PinterestAuth, input: PublishInput): Promise<PublishResult> {
    const issues = this.validate(account, input);
    if (issues.length) throw new ConnectorError(`pinterest publish: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
    const o = input.options ?? {};
    const media = input.media;
    const first = media[0]!;
    let source: Record<string, unknown>;
    if (first.kind === "video") {
      const mediaId = await this.uploadVideo(auth, first, input.idempotencyKey);
      // TODO(verify): cover_image_key_frame_time as the fallback when no cover image URL is given.
      source = { source_type: "video_id", media_id: mediaId, ...(o.thumbnailUrl ? { cover_image_url: o.thumbnailUrl } : { cover_image_key_frame_time: 0 }) };
    } else if (media.length === 1) {
      source = { source_type: "image_url", url: first.url };
    } else {
      source = {
        source_type: "multiple_image_urls",
        items: media.map((m) => ({ url: m.url, ...(o.title ? { title: o.title } : {}), ...(m.alt ? { description: m.alt } : {}), ...(o.link ? { link: o.link } : {}) })),
      };
    }
    const body: Record<string, unknown> = {
      board_id: o.boardId,
      ...(o.title ? { title: o.title } : {}),
      ...(input.text ? { description: input.text } : {}),
      ...(o.link ? { link: o.link } : {}),
      ...(first.alt ? { alt_text: first.alt } : {}),
      media_source: source,
    };
    const pin = await this.request<PinterestPin>(auth.accessToken, "POST", "/pins", { json: body, what: "create pin", creating: true });
    if (!pin.id) throw new ConnectorError("pinterest create pin: response had no id", "unknown", false, pin);
    this.uploads.delete(input.idempotencyKey);
    return { externalId: pin.id, url: pinterestPinUrl(pin.id), raw: pin };
  }

  /** Register a video upload, POST the file to S3 with the returned fields, poll until it succeeds. */
  private async uploadVideo(auth: PinterestAuth, m: Media, key: string): Promise<string> {
    let mediaId = this.uploads.get(key);
    if (!mediaId) {
      const reg = await this.request<{ media_id?: string; upload_url?: string; upload_parameters?: Record<string, string> }>(auth.accessToken, "POST", "/media", {
        json: { media_type: "video" },
        what: "register media",
        creating: true,
      });
      if (!reg.media_id || !reg.upload_url) throw new ConnectorError("pinterest register media: no media_id/upload_url", "unknown", false, reg);
      // The S3 form POST is streamed (exact Content-Length), so the video is never held whole.
      const res = await withMedia(mediaSource(this.media, this.fetchImpl), m, async (file) => {
        const form = uploadForm([file]);
        for (const [k, v] of Object.entries(reg.upload_parameters ?? {})) form.set(k, v);
        setMediaFile(form, "file", file, "video.mp4"); // S3 wants the file last
        try {
          return await sendBody(resolveFetch(this.fetchImpl), reg.upload_url!, { method: "POST" }, form);
        } catch (err) {
          throw asNetworkError(err, "pinterest video upload");
        }
      });
      if (!res.ok) {
        const { kind, retryable } = classifyHttpStatus(res.status);
        throw new ConnectorError(`pinterest video upload: HTTP ${res.status}`, kind === "auth" ? "rejected" : kind, retryable, { status: res.status, body: await readJson(res) });
      }
      mediaId = reg.media_id;
      this.uploads.set(key, mediaId);
    }
    for (let i = 0; i < this.maxPolls; i++) {
      const s = await this.request<{ status?: string }>(auth.accessToken, "GET", `/media/${encodeURIComponent(mediaId)}`, { what: "media status" });
      if (s.status === "succeeded") return mediaId;
      if (s.status === "failed") {
        this.uploads.delete(key);
        throw new ConnectorError(`pinterest video ${mediaId} failed processing`, "rejected", false, s);
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw new ConnectorError(`pinterest video ${mediaId} is still processing; retry later`, "unknown", true);
  }

  // ---- inbox ----------------------------------------------------------------------------

  /** The account's own Pins. Pinterest API v5 has no comment, mention or message endpoints. */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const out: ActivityInput[] = [];
    let bookmark: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const q = new URLSearchParams({ page_size: "25", ...(bookmark ? { bookmark } : {}) });
      const r = await this.request<{ items?: PinterestPin[]; bookmark?: string | null }>(auth.accessToken, "GET", `/pins?${q}`, { what: "list pins" });
      let older = false;
      for (const p of r.items ?? []) {
        if (!p.id) continue;
        const at = p.created_at ? new Date(p.created_at.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(p.created_at) ? p.created_at : `${p.created_at}Z`).toISOString() : this.now().toISOString();
        if (!isAfter(at, since)) {
          older = true;
          continue;
        }
        out.push({
          network: "pinterest",
          kind: "own_post",
          externalId: p.id,
          authorHandle: auth.username ?? account.handle,
          authorName: null,
          text: [p.title, p.description].filter(Boolean).join("\n") || null,
          url: pinterestPinUrl(p.id),
          parentExternalId: null,
          occurredAt: at,
          raw: p,
        });
      }
      bookmark = r.bookmark ?? undefined;
      if (!bookmark || older) break;
    }
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  // ---- metrics --------------------------------------------------------------------------

  /**
   * Pin analytics summed over the last 90 days.
   * TODO(verify): 90 days is the longest window pin analytics serves; older Pins then under-report lifetime totals.
   */
  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const now = this.now();
    const observedAt = now.toISOString();
    const end = day(now);
    const start = day(new Date(now.getTime() - 89 * 86_400_000));
    const out: MetricInput[] = [];
    for (const id of externalIds) {
      const get = (types: string[]) =>
        this.request<Record<string, { summary_metrics?: Record<string, number>; lifetime_metrics?: Record<string, number> }>>(
          auth.accessToken,
          "GET",
          `/pins/${encodeURIComponent(id)}/analytics?${new URLSearchParams({ start_date: start, end_date: end, metric_types: types.join(","), app_types: "ALL", split_field: "NO_SPLIT" })}`,
          { what: "pin analytics" },
        );
      let r: Awaited<ReturnType<typeof get>>;
      try {
        r = await get([...PIN_METRICS, ...PIN_EXTRA_METRICS]);
      } catch (err) {
        // Image Pins can refuse video metric types; fall back to the metrics every Pin has.
        if (statusOf(err) !== 400) throw err;
        r = await get(PIN_METRICS);
      }
      const all = r.all ?? Object.values(r)[0];
      const m = { ...(all?.summary_metrics ?? {}), ...(all?.lifetime_metrics ?? {}) };
      out.push(...pinMetrics(id, m, observedAt));
    }
    return out;
  }

  /** followers_total from the profile; impressions/engagements are trailing 30-day sums from account analytics. */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const now = this.now();
    const observedAt = now.toISOString();
    const row = (metric: MetricName, value: unknown): MetricInput[] => (typeof value === "number" ? [{ entityType: "social_account", entityId: account.id, metric, value, observedAt, source: "pinterest" }] : []);
    const me = await this.userAccount(auth.accessToken);
    const out = [...row("followers_total", me.follower_count)];
    try {
      const q = new URLSearchParams({ start_date: day(new Date(now.getTime() - 29 * 86_400_000)), end_date: day(now) });
      const r = await this.request<Record<string, { summary_metrics?: Record<string, number> }>>(auth.accessToken, "GET", `/user_account/analytics?${q}`, { what: "user_account analytics" });
      const s = (r.all ?? Object.values(r)[0])?.summary_metrics ?? {};
      out.push(...row("impressions", s.IMPRESSION), ...row("engagements", s.ENGAGEMENT), ...row("saves", s.SAVE), ...row("clicks", s.PIN_CLICK), ...row("link_clicks", s.OUTBOUND_CLICK));
    } catch (err) {
      // Personal (non-business) accounts have no analytics; followers still count.
      if (statusOf(err) !== 403 && statusOf(err) !== 400) throw err;
    }
    return out;
  }

  // ---- transport ------------------------------------------------------------------------

  private async request<T>(token: string, method: string, path: string, opts: { json?: unknown; what: string; creating?: boolean }): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(`${this.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch (err) {
      throw asNetworkError(err, `pinterest ${opts.what}`);
    }
    const data = await readJson(res);
    if (!res.ok) throw mapPinterestError(res.status, res.headers, data, { what: opts.what, creating: opts.creating ?? false });
    return (data ?? {}) as T;
  }
}

function identityOf(me: PinterestUserAccount): AccountIdentity {
  // TODO(verify): user_account returns a stable `id`; older responses carried only `username`.
  return { externalId: me.id ?? me.username ?? "", handle: me.username ?? "", displayName: me.business_name ?? me.username ?? null };
}

function authFromToken(t: OAuth2Token, username: string | undefined): PinterestAuth {
  return {
    accessToken: t.accessToken,
    ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
    ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
    ...(t.refreshExpiresAt ? { refreshExpiresAt: t.refreshExpiresAt } : {}),
    ...(t.scope ? { scope: t.scope } : {}),
    ...(username ? { username } : {}),
  };
}

function pinMetrics(id: string, m: Record<string, number>, observedAt: string): MetricInput[] {
  const row = (metric: MetricName, value: number | undefined): MetricInput[] => (typeof value === "number" ? [{ entityType: "post_variant", entityId: id, metric, value, observedAt, source: "pinterest" }] : []);
  const has = Object.keys(m).length > 0;
  // TODO(verify): VIDEO_V50_WATCH_TIME is reported in milliseconds.
  const watchMs = m.VIDEO_V50_WATCH_TIME;
  return [
    ...row("impressions", m.IMPRESSION),
    ...row("saves", m.SAVE),
    ...row("clicks", m.PIN_CLICK),
    ...row("link_clicks", m.OUTBOUND_CLICK),
    ...row("video_views", m.VIDEO_MRC_VIEW),
    ...row("watch_time_seconds", typeof watchMs === "number" ? watchMs / 1000 : undefined),
    ...row("replies", m.TOTAL_COMMENTS),
    ...row("likes", m.TOTAL_REACTIONS),
    ...(has ? row("engagements", (m.SAVE ?? 0) + (m.PIN_CLICK ?? 0) + (m.OUTBOUND_CLICK ?? 0) + (m.TOTAL_REACTIONS ?? 0) + (m.TOTAL_COMMENTS ?? 0)) : []),
  ];
}

/** Boards for an account, for callers that hold an AccountRef but not the registry's connector instance. */
export async function listBoards(account: AccountRef, opts: PinterestConnectorOptions = {}): Promise<PinterestBoard[]> {
  return new PinterestConnector(opts).listBoards(account);
}

/** Registry entry for Pinterest. PINTEREST_API_BASE_URL switches to the sandbox for Trial access apps. */
export function createPinterestConnectors(env: NodeJS.ProcessEnv): Connector[] {
  const { clientId, clientSecret } = clientFromEnv(env, "PINTEREST");
  return [
    new PinterestConnector({
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(env.PINTEREST_API_BASE_URL ? { baseUrl: env.PINTEREST_API_BASE_URL } : {}),
    }),
  ];
}
