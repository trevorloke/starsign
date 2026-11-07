import { createHash, timingSafeEqual } from "node:crypto";
import type { ActivityInput, Media, MetricInput, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { OAuth2Client, type OAuth2Token } from "./oauth.ts";
import type { AccountIdentity, AccountRef, AuthRefresh, ConnectedAccount, Connector, ConnectorCapabilities, ModerationInput, PublishInput, PublishResult, ValidationIssue, WebhookBatch, WebhookHandler } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Zalo Official Accounts (OA) through the Zalo OA Open API (https://openapi.zalo.me). The OA's administrator grants
 * the Starsign app access with OAuth v4 for OA (oauth.zaloapp.com, PKCE; the app secret travels in a `secret_key`
 * header at the token endpoint). One login = one OA (externalId = oa_id). Access tokens last about 25 hours; refresh
 * tokens are single-use and rotate on every refresh.
 *
 * Inbox is webhook-only: Zalo pushes events for every OA authorised to the app to `${STARSIGN_PUBLIC_URL}/webhooks/zalo`,
 * signed app-wide (X-ZEvent-Signature). Messages people send the OA become "dm"; follows become "follow".
 * Replies are customer-service messages (/v3.0/oa/message/cs), allowed only for a while after the person last
 * wrote to the OA. Publishing creates OA articles (title, cover image, HTML body), optionally broadcast to followers.
 *
 * Responses are `{ error, message, data }`; error 0 is success, anything else is an error even with HTTP 200.
 * developers.zalo.me was not reachable from the build sandbox; shapes follow Zalo's reference as quoted by
 * third-party SDKs and integration guides. Unconfirmed details are marked TODO(verify).
 */

const API = "https://openapi.zalo.me";

export const ZaloAuth = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.string().optional(),
  refreshExpiresAt: z.string().optional(),
});
export type ZaloAuth = z.infer<typeof ZaloAuth>;

export interface ZaloConnectorOptions {
  appId?: string;
  appSecret?: string;
  /** The OA Secret Key shown in the app's Webhook settings; signs every webhook delivery. */
  oaSecretKey?: string;
  apiUrl?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Article verify polls before giving up with a retryable error. */
  verifyAttempts?: number;
}

export interface ZaloFailure {
  status: number;
  code?: number;
  body: unknown;
}

export interface ZaloAccountConfig {
  oaId: string;
  name: string | null;
  avatar: string | null;
  verified: boolean | null;
  /** Broadcast every new article to followers (uses the OA's broadcast quota). */
  broadcast: boolean;
}

export interface ZaloAttachment {
  type: string;
  payload?: { url?: string; thumbnail?: string; description?: string; name?: string; size?: string | number; id?: string; coordinates?: { latitude?: string | number; longitude?: string | number } };
}

export interface ZaloEvent {
  app_id?: string;
  oa_id?: string;
  event_name: string;
  timestamp?: string | number;
  user_id_by_app?: string;
  sender?: { id?: string };
  recipient?: { id?: string };
  follower?: { id?: string };
  message?: { msg_id?: string; text?: string; attachments?: ZaloAttachment[] };
}

// ---- pure helpers -----------------------------------------------------------------------

/**
 * X-ZEvent-Signature: "mac=" + sha256(app_id + raw body + timestamp + OA secret key), hex. The timestamp is the
 * delivery's own `timestamp` field.
 * TODO(verify): the exact formula and whether "data" means the raw body (our reading) or a field of it.
 */
export function zaloSignature(appId: string, rawBody: string, timestamp: string, oaSecretKey: string): string {
  return createHash("sha256").update(`${appId}${rawBody}${timestamp}${oaSecretKey}`, "utf8").digest("hex");
}

export function zaloSignatureValid(appId: string, oaSecretKey: string, rawBody: string, header: string | undefined): boolean {
  if (!header || !appId || !oaSecretKey || !rawBody) return false;
  let ts: string;
  try {
    const b = JSON.parse(rawBody) as { timestamp?: unknown; app_id?: unknown };
    if (b.app_id !== undefined && String(b.app_id) !== appId) return false;
    if (b.timestamp === undefined) return false;
    ts = String(b.timestamp);
  } catch {
    return false;
  }
  const got = Buffer.from(header.trim().replace(/^mac=/i, "").toLowerCase(), "utf8");
  const want = Buffer.from(zaloSignature(appId, rawBody, ts, oaSecretKey), "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Text of a message, or a short summary of an attachment (nothing is downloaded). */
export function zaloMessageText(e: ZaloEvent): string {
  const m = e.message ?? {};
  const a = m.attachments?.[0];
  const caption = m.text ? ` ${m.text}` : "";
  switch (e.event_name) {
    case "user_send_text":
      return m.text ?? "";
    case "user_send_image":
      return `[Image]${caption}`;
    case "user_send_gif":
      return `[GIF]${caption}`;
    case "user_send_sticker":
      return "[Sticker]";
    case "user_send_audio":
      return "[Voice message]";
    case "user_send_video":
      return `[Video]${caption}`;
    case "user_send_link":
      return `[Link: ${a?.payload?.url ?? a?.payload?.description ?? "?"}]${caption}`;
    case "user_send_file":
      return `[File: ${a?.payload?.name ?? "file"}]`;
    case "user_send_location": {
      const c = a?.payload?.coordinates;
      return `[Location: ${c?.latitude ?? "?"}, ${c?.longitude ?? "?"}]`;
    }
    case "user_send_business_card":
      return "[Business card]";
    default:
      return m.text ?? `[${e.event_name.replace(/^user_send_/, "")}]`;
  }
}

const tsIso = (t: string | number | undefined) => {
  const n = typeof t === "number" ? t : Number(t);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};

/** One webhook event → activity for the OA it was sent to. Events from the OA itself and the rest are ignored. */
export function zaloEventToActivity(e: ZaloEvent): { oaId: string; item: ActivityInput } | null {
  const occurredAt = tsIso(e.timestamp);
  if (!occurredAt) return null;
  if (e.event_name.startsWith("user_send_")) {
    const user = e.sender?.id;
    const oaId = e.recipient?.id ?? e.oa_id;
    if (!user || !oaId) return null;
    const msgId = e.message?.msg_id ?? String(e.timestamp);
    return {
      oaId,
      item: { network: "zalo", kind: "dm", externalId: `${user}:${msgId}`, authorHandle: user, authorName: null, text: zaloMessageText(e), url: null, parentExternalId: null, occurredAt, raw: e, conversation: { id: user, name: null, type: "direct" } },
    };
  }
  if (e.event_name === "follow") {
    const user = e.follower?.id;
    const oaId = e.oa_id ?? e.recipient?.id;
    if (!user || !oaId) return null;
    return {
      oaId,
      item: { network: "zalo", kind: "follow", externalId: `${user}:follow:${e.timestamp}`, authorHandle: user, authorName: null, text: "[Followed the Official Account]", url: null, parentExternalId: null, occurredAt, raw: e, conversation: { id: user, name: null, type: "direct" } },
    };
  }
  return null;
}

// TODO(verify): Zalo error codes. Our reading: -216 invalid access token, -124 expired access token, -14014/-14019
// invalid refresh token; -213 the user has not followed the OA / -230 the user has not interacted with the OA within
// the allowed window (customer-service messages); -32 rate limit. Messages are matched as a fallback.
const AUTH_CODES = new Set([-216, -124, -14014, -14019]);
const WINDOW_CODES = new Set([-213, -230]);
const RATE_CODES = new Set([-32]);

/** Zalo `error` code → ConnectorError. */
export function mapZaloError(code: number | undefined, message: string | undefined, what: string, status = 200, body: unknown = undefined): ConnectorError {
  const msg = `zalo ${what}: ${code !== undefined ? `error ${code}` : `HTTP ${status}`}${message ? ` ${message}` : ""}`;
  const cause: ZaloFailure = { status, ...(code !== undefined ? { code } : {}), body };
  const text = message ?? "";
  if (code !== undefined) {
    if (AUTH_CODES.has(code) || /access[_ ]?token.*(invalid|expired)/i.test(text)) return new ConnectorError(`${msg} (reconnect the Official Account)`, "auth", false, cause);
    if (WINDOW_CODES.has(code) || /interact|not follow/i.test(text))
      return new ConnectorError(`${msg} (Zalo only allows customer-service replies for a limited time after the person last wrote to the OA, and only to followers; the window has closed)`, "rejected", false, cause);
    if (RATE_CODES.has(code) || /rate limit|quota|exceed/i.test(text)) return new ConnectorError(`${msg} (Zalo quota or rate limit; try later)`, "rate_limit", true, cause);
    return new ConnectorError(msg, "rejected", false, cause);
  }
  const { kind, retryable } = classifyHttpStatus(status);
  return new ConnectorError(msg, kind, retryable, cause);
}

function parseAuth(account: AccountRef): ZaloAuth {
  const p = ZaloAuth.safeParse(account.auth ?? {});
  if (!p.success) throw new ConnectorError(`zalo account ${account.handle}: auth blob needs accessToken`, "auth", false, p.error);
  return p.data;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain text → article HTML: blank lines split paragraphs, single newlines become <br>. */
export function zaloArticleHtml(text: string, link?: string): string {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`);
  if (link) paras.push(`<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`);
  return paras.join("");
}

// TODO(verify): article limits (title 150 characters, description 300, author 50).
const LIMITS = { title: 150, description: 300, author: 50, text: 2000 } as const;

// ---- connector --------------------------------------------------------------------------

export class ZaloConnector implements Connector {
  readonly name = "zalo";
  readonly networks: readonly Network[] = ["zalo"];
  readonly connectMethod = "oauth" as const;
  readonly oauthInputs = [{ key: "broadcast", label: "Also broadcast each new article to all followers? Type yes or no (broadcasts use the OA's monthly quota)", placeholder: "no" }] as const;
  media?: Connector["media"];
  readonly webhook: WebhookHandler;

  readonly oauth: OAuth2Client;
  private readonly appId: string | undefined;
  private readonly appSecret: string | undefined;
  private readonly oaSecretKey: string | undefined;
  private readonly apiUrl: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly verifyAttempts: number;
  private readonly published = new IdempotencyCache<PublishResult>();
  private readonly replies = new IdempotencyCache<PublishResult>();
  /** idempotency key → article token still being processed, so a retry resumes instead of posting twice. */
  private readonly pendingArticles = new Map<string, string>();
  /** Refresh tokens are single-use: old → new, so a concurrent caller with the old one reuses the result. */
  private readonly rotated = new Map<string, Promise<OAuth2Token>>();

  constructor(opts: ZaloConnectorOptions = {}) {
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
    this.oaSecretKey = opts.oaSecretKey;
    this.apiUrl = (opts.apiUrl ?? API).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.verifyAttempts = opts.verifyAttempts ?? 5;
    const base = opts.fetch;
    const secret = opts.appSecret;
    // Zalo reads the app secret from a `secret_key` header, not from the form.
    const withSecretHeader: FetchLike = (input, init) => resolveFetch(base)(input, { ...init, headers: { ...((init?.headers as Record<string, string>) ?? {}), ...(secret ? { secret_key: secret } : {}) } });
    this.oauth = new OAuth2Client(
      {
        name: "zalo",
        authorizeUrl: opts.authorizeUrl ?? "https://oauth.zaloapp.com/v4/oa/permission",
        tokenUrl: opts.tokenUrl ?? "https://oauth.zaloapp.com/v4/oa/access_token",
        scopes: [],
        pkce: true,
        clientAuth: "body",
        clientIdParam: "app_id",
        ...(opts.appId ? { clientId: opts.appId } : {}),
      },
      withSecretHeader,
      this.now,
    );
    this.webhook = {
      verify: (headers, rawBody) => zaloSignatureValid(this.appId ?? "", this.oaSecretKey ?? "", rawBody, header(headers, "x-zevent-signature")),
      parse: (body) => this.parseEvents(body),
    };
  }

  get connectConfigured(): boolean {
    return !!this.appId && !!this.appSecret;
  }

  capabilities(): ConnectorCapabilities {
    return { publish: true, fetchActivity: false, fetchMetrics: false, meteredReads: false, reply: true, moderate: false, accountMetrics: true, webhooks: true, video: false, kinds: ["post", "link"] };
  }

  // ---- connect ---------------------------------------------------------------------------

  oauthAuthorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL(this.oauth.authorizeUrl({ state: p.state, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge }));
    url.searchParams.delete("scope");
    return url.toString();
  }

  /** Keeps the broadcast choice with the pending login. */
  async oauthPrepare(p: { inputs: Record<string, string>; redirectUri: string; state: string; codeChallenge: string }): Promise<{ authorizeUrl: string; config: Record<string, unknown> }> {
    const answer = (p.inputs.broadcast ?? "").trim().toLowerCase();
    if (answer && !["yes", "no", "y", "n", "có", "không"].includes(answer)) throw new ConnectorError("zalo: answer yes or no for broadcasting articles", "rejected", false);
    return { authorizeUrl: this.oauthAuthorizeUrl(p), config: { broadcast: ["yes", "y", "có"].includes(answer) } };
  }

  async oauthConnect(p: { code: string; codeVerifier: string; redirectUri: string; config?: Record<string, unknown>; callbackParams?: Record<string, string> }): Promise<ConnectedAccount[]> {
    if (!this.appSecret) throw new ConnectorError("zalo: ZALO_APP_SECRET is not configured", "auth", false);
    const token = await this.oauth.exchange({ code: p.code, codeVerifier: p.codeVerifier, redirectUri: p.redirectUri });
    const auth = authFromToken(token);
    const oa = await this.getOa(auth.accessToken);
    const expected = p.callbackParams?.oa_id;
    if (expected && expected !== oa.oa_id) throw new ConnectorError(`zalo: the token is for OA ${oa.oa_id}, not ${expected}`, "auth", false);
    const config: ZaloAccountConfig = { oaId: oa.oa_id, name: oa.name ?? null, avatar: oa.avatar ?? null, verified: typeof oa.is_verified === "boolean" ? oa.is_verified : null, broadcast: p.config?.broadcast === true };
    return [{ network: "zalo", identity: oaIdentity(oa), auth: { ...auth }, config: { ...config } }];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const token = typeof auth.accessToken === "string" ? auth.accessToken : null;
    if (!token) throw new ConnectorError("zalo: accessToken is required", "auth", false);
    return oaIdentity(await this.getOa(token));
  }

  /** Refresh tokens rotate and are single-use; the new pair replaces the old one. */
  async refreshAuth(account: AccountRef): Promise<AuthRefresh | null> {
    const auth = parseAuth(account);
    if (!auth.refreshToken) return null;
    let p = this.rotated.get(auth.refreshToken);
    if (!p) {
      p = this.oauth.refresh(auth.refreshToken);
      this.rotated.set(auth.refreshToken, p);
      p.catch(() => this.rotated.delete(auth.refreshToken!));
      if (this.rotated.size > 1000) this.rotated.delete(this.rotated.keys().next().value!);
    }
    return { auth: { ...authFromToken(await p) } };
  }

  private getOa(token: string) {
    return this.call<{ oa_id: string; name?: string; description?: string; avatar?: string; cover?: string; is_verified?: boolean; num_follower?: number }>(token, "GET", "/v2.0/oa/getoa", undefined, "getoa");
  }

  // ---- webhooks -------------------------------------------------------------------------

  private parseEvents(body: unknown): WebhookBatch[] {
    const events = Array.isArray(body) ? body : [body];
    const byOa = new Map<string, ActivityInput[]>();
    for (const e of events) {
      if (!e || typeof e !== "object" || typeof (e as ZaloEvent).event_name !== "string") continue;
      const r = zaloEventToActivity(e as ZaloEvent);
      if (!r) continue;
      byOa.set(r.oaId, [...(byOa.get(r.oaId) ?? []), r.item]);
    }
    return [...byOa].map(([accountExternalId, items]) => ({ network: "zalo" as const, accountExternalId, items }));
  }

  // ---- publish --------------------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const o = input.options ?? {};
    if (!input.text.trim()) issues.push({ code: "empty", message: "a Zalo article needs body text" });
    if (!o.title?.trim()) issues.push({ code: "empty", message: "a Zalo article needs a title (options.title)" });
    else if ([...o.title].length > LIMITS.title) issues.push({ code: "too_long", message: `Zalo article titles are at most ${LIMITS.title} characters` });
    if (!coverOf(input)) issues.push({ code: "media_required", message: "a Zalo article needs a cover image: add an image or a thumbnail URL" });
    if (input.media.some((m) => m.kind === "video" || m.kind === "document")) issues.push({ code: "unsupported_media", message: "Zalo articles from Starsign take images only" });
    if (input.media.some((m) => !/^https:\/\//i.test(m.url))) issues.push({ code: "unsupported_media", message: "Zalo fetches article images itself: image URLs must be public HTTPS" });
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "Zalo articles have no threads" });
    return issues;
  }

  /**
   * POST /v2.0/article/create → a token; /v2.0/article/verify turns it into the article id once Zalo has processed it
   * (polled a few times; a retry with the same idempotency key resumes polling). With `broadcast` on, the article is
   * then broadcast to followers; a failed broadcast is reported in `raw` and does not fail the publish.
   */
  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    if (input.replyToExternalId) return this.reply(account, { parentExternalId: input.replyToExternalId, text: input.text, idempotencyKey: input.idempotencyKey });
    return this.published.run(input.idempotencyKey, async () => {
      const issues = this.validate(account, input);
      if (issues.length) throw new ConnectorError(`zalo publish: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
      const token = parseAuth(account).accessToken;
      const cfg = account.config as Partial<ZaloAccountConfig>;
      let articleToken = this.pendingArticles.get(input.idempotencyKey);
      if (!articleToken) {
        const images = input.media.filter((m) => m.kind === "image" || m.kind === "gif");
        const body = [{ type: "text", content: zaloArticleHtml(input.text, input.options?.link) }, ...images.slice(input.options?.thumbnailUrl ? 0 : 1).map((m) => ({ type: "image", url: m.url, ...(m.alt ? { caption: m.alt } : {}) }))];
        const created = await this.call<{ token?: string }>(token, "POST", "/v2.0/article/create", {
          type: "normal",
          title: input.options!.title!.trim(),
          author: (cfg.name ?? account.handle ?? "").slice(0, LIMITS.author),
          cover: { cover_type: "photo", photo_url: coverOf(input), status: "show" },
          description: [...input.text.replace(/\s+/g, " ").trim()].slice(0, LIMITS.description).join(""),
          body,
          status: "show",
          comment: "show",
        }, "article create");
        if (!created.token) throw new ConnectorError("zalo article create: no token in the response", "unknown", false, created);
        articleToken = created.token;
        this.pendingArticles.set(input.idempotencyKey, articleToken);
      }
      const id = await this.verifyArticle(token, articleToken);
      this.pendingArticles.delete(input.idempotencyKey);
      let broadcast: unknown = undefined;
      if (cfg.broadcast === true) {
        try {
          broadcast = await this.broadcastArticle(token, id);
        } catch (err) {
          broadcast = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      // TODO(verify): a public URL for an OA article; the API returns only its id.
      return { externalId: `article:${id}`, url: null, raw: { id, token: articleToken, ...(broadcast !== undefined ? { broadcast } : {}) } };
    });
  }

  // TODO(verify): /v2.0/article/verify answers { data: { id } } once processed, and an error while still processing.
  private async verifyArticle(token: string, articleToken: string): Promise<string> {
    let last: unknown = null;
    for (let i = 0; i < this.verifyAttempts; i++) {
      if (i > 0) await this.sleep(Math.min(1000 * 2 ** (i - 1), 8000));
      try {
        const r = await this.call<{ id?: string | number }>(token, "POST", "/v2.0/article/verify", { token: articleToken }, "article verify");
        if (r.id !== undefined && r.id !== null && r.id !== "") return String(r.id);
        last = r;
      } catch (err) {
        if (err instanceof ConnectorError && (err.kind === "auth" || err.kind === "network")) throw err;
        last = err;
      }
    }
    throw new ConnectorError("zalo article: Zalo is still processing the article; retry to finish publishing it", "network", true, last);
  }

  // TODO(verify): broadcast endpoint and payload (v2.0 oa/message with a target and an article media template);
  // Zalo has been moving broadcasts to paid "promotion" messages.
  private broadcastArticle(token: string, articleId: string) {
    return this.call<{ message_id?: string }>(token, "POST", "/v2.0/oa/message", {
      recipient: { target: { gender: "0" } },
      message: { attachment: { type: "template", payload: { template_type: "media", elements: [{ media_type: "article", attachment_id: articleId }] } } },
    }, "broadcast");
  }

  // ---- engage ---------------------------------------------------------------------------

  /**
   * A customer-service text message to the person ("<user id>:<message id>" or a bare user id). Zalo allows these
   * only for a limited time after the person's last message and answers outside it with a clear error.
   * TODO(verify): the window (7 days after the last interaction per Zalo's 2023 policy; some sources say 48 hours).
   */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.replies.run(input.idempotencyKey, async () => {
      const userId = input.parentExternalId.split(":")[0] ?? "";
      if (!/^\d+$/.test(userId)) throw new ConnectorError(`zalo reply: "${input.parentExternalId}" does not name a Zalo user`, "rejected", false);
      if (!input.text.trim()) throw new ConnectorError("zalo reply: text is empty", "rejected", false);
      if ([...input.text].length > LIMITS.text) throw new ConnectorError(`zalo reply: messages are at most ${LIMITS.text} characters`, "rejected", false);
      const token = parseAuth(account).accessToken;
      const r = await this.call<{ message_id?: string; user_id?: string }>(token, "POST", "/v3.0/oa/message/cs", { recipient: { user_id: userId }, message: { text: input.text } }, "message cs");
      return { externalId: `${userId}:${r.message_id ?? `sent-${input.idempotencyKey}`}`, url: null, raw: r };
    });
  }

  async moderate(_account: AccountRef, input: ModerationInput): Promise<void> {
    throw new ConnectorError(`zalo: ${input.action} is not available for OA messages`, "rejected", false);
  }

  // ---- listen / measure -----------------------------------------------------------------

  /** Webhook-only. */
  async fetchActivity(): Promise<ActivityInput[]> {
    return [];
  }

  /** Article statistics are not wired yet. */
  async fetchMetrics(): Promise<MetricInput[]> {
    return [];
  }

  /** followers_total = getoa num_follower. */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const oa = await this.getOa(parseAuth(account).accessToken);
    if (typeof oa.num_follower !== "number") return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: oa.num_follower, observedAt: this.now().toISOString(), source: "zalo" }];
  }

  // ---- transport ------------------------------------------------------------------------

  private async call<T>(token: string, method: "GET" | "POST", path: string, body: unknown, what: string): Promise<T> {
    const headers: Record<string, string> = { access_token: token, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(`${this.apiUrl}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch (err) {
      throw asNetworkError(err instanceof Error ? new Error(err.message.replaceAll(token, "<token>")) : err, `zalo ${what}`);
    }
    const data = (await readJson(res)) as { error?: number; message?: string; data?: unknown } | string | undefined;
    const b = data && typeof data === "object" ? data : undefined;
    if (b && typeof b.error === "number" && b.error !== 0) throw mapZaloError(b.error, b.message, what, res.status, data);
    if (!res.ok) throw mapZaloError(undefined, typeof b?.message === "string" ? b.message : undefined, what, res.status, data);
    if (!b) throw new ConnectorError(`zalo ${what}: unexpected response`, "unknown", false, data);
    return (b.data ?? {}) as T;
  }
}

function header(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
}

function coverOf(input: PublishInput): string | undefined {
  return input.options?.thumbnailUrl ?? input.media.find((m: Media) => m.kind === "image")?.url;
}

function oaIdentity(oa: { oa_id: string; name?: string }): AccountIdentity {
  return { externalId: String(oa.oa_id), handle: oa.name ?? String(oa.oa_id), displayName: oa.name ?? null };
}

function authFromToken(t: OAuth2Token): ZaloAuth {
  return {
    accessToken: t.accessToken,
    ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
    ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
    ...(t.refreshExpiresAt ? { refreshExpiresAt: t.refreshExpiresAt } : {}),
  };
}

/** Registry entry for Zalo: ZALO_APP_ID, ZALO_APP_SECRET, ZALO_OA_SECRET_KEY (webhook signatures). */
export function createZaloConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [
    new ZaloConnector({
      ...(env.ZALO_APP_ID ? { appId: env.ZALO_APP_ID } : {}),
      ...(env.ZALO_APP_SECRET ? { appSecret: env.ZALO_APP_SECRET } : {}),
      ...(env.ZALO_OA_SECRET_KEY ? { oaSecretKey: env.ZALO_OA_SECRET_KEY } : {}),
    }),
  ];
}
