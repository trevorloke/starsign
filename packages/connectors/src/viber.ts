import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActivityInput, Media, MetricInput, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, ModerationInput, PublishInput, PublishResult, ValidationIssue, WebhookBatch, WebhookHandler } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Viber through its official REST APIs at https://chatapi.viber.com/pa. Two kinds of account, chosen at connect:
 *
 * - **Channel** (Channels Post API): the channel's auth token from Channel settings → Developer tools (superadmins
 *   only). Starsign posts to the channel as its superadmin (`from`). Channels have no inbox: posts by the channel
 *   and members' reactions produce no callbacks, so nothing is read back.
 * - **Bot** (REST Bot API): the bot's auth token. Since February 2024 new bots are only for businesses with a
 *   commercial agreement with Viber, and messages a bot starts are charged. People's messages and subscriptions
 *   arrive on `${STARSIGN_PUBLIC_URL}/webhooks/viber?account=<id>`; replies are send_message.
 *
 * Both need a webhook set with set_webhook (the Channels Post API refuses posts until one is set). Viber checks the
 * URL by calling it at once, which Starsign can only answer once the account is saved, so connect tries and the
 * first poll (fetchActivity) or a publish refused with "webhook not set" sets it again.
 *
 * Every callback is signed with the account's own token (X-Viber-Content-Signature = hex HMAC-SHA256 of the raw
 * body), so the handler uses `route` (the `account` query parameter) + `verifyAccount`.
 *
 * Responses are `{ status, status_message, ... }`; status 0 is success. developers.viber.com was not reachable from
 * the build sandbox; shapes follow Viber's reference as quoted in search results. Unconfirmed details: TODO(verify).
 */

const API = "https://chatapi.viber.com/pa";

export const ViberAuth = z.object({ authToken: z.string().min(20, "not a Viber auth token") });
export type ViberAuth = z.infer<typeof ViberAuth>;

export interface ViberConnectorOptions {
  apiBase?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** STARSIGN_PUBLIC_URL: the webhook Starsign sets is `${publicUrl}/webhooks/viber?account=<id>`. */
  publicUrl?: string;
}

export interface ViberAccountConfig {
  kind: "channel" | "bot";
  accountId: string;
  name: string | null;
  uri: string | null;
  /** Channel: the superadmin member id posts are sent `from`. */
  from: string | null;
  subscribersCount: number | null;
  webhookUrl: string | null;
  webhookSet: boolean;
}

export interface ViberFailure {
  status: number;
  code?: number;
  body: unknown;
}

interface AccountInfo {
  id: string;
  name?: string;
  uri?: string;
  icon?: string;
  webhook?: string;
  subscribers_count?: number;
  members?: { id: string; name?: string; role?: string }[];
}

export interface ViberCallback {
  event: string;
  timestamp?: number;
  message_token?: string | number;
  sender?: { id: string; name?: string; avatar?: string; language?: string; country?: string };
  user?: { id: string; name?: string };
  message?: {
    type: string;
    text?: string;
    media?: string;
    file_name?: string;
    size?: number;
    duration?: number;
    sticker_id?: number;
    location?: { lat?: number; lon?: number };
    contact?: { name?: string; phone_number?: string };
  };
}

// TODO(verify): limits. Text 7000 characters; picture caption 768 (bot docs: 120 on some clients); video MP4 ≤ 50 MB and
// ≤ 180 s (Channels Post API); files ≤ 50 MB; sender name ≤ 28 characters.
const LIMITS = { text: 7000, caption: 768, videoBytes: 50_000_000, videoSeconds: 180, fileBytes: 50_000_000, senderName: 28 } as const;

// ---- pure helpers -----------------------------------------------------------------------

/** hex(HMAC-SHA256(auth token, raw body)) compared in constant time. */
export function viberSignatureValid(authToken: string, rawBody: string, signature: string | undefined): boolean {
  if (!signature || !authToken) return false;
  const want = Buffer.from(createHmac("sha256", authToken).update(rawBody, "utf8").digest("hex"), "utf8");
  const got = Buffer.from(signature.trim().toLowerCase(), "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** message_token is a 64-bit integer: quote it before JSON.parse so it keeps every digit. */
export function viberParse(rawBody: string): unknown {
  return JSON.parse(rawBody.replace(/("message_token"\s*:\s*)(-?\d+)/g, '$1"$2"'));
}

/** Text of a message, or a short summary of non-text content (nothing is downloaded). */
export function viberMessageText(m: NonNullable<ViberCallback["message"]>): string {
  const caption = m.text ? ` ${m.text}` : "";
  switch (m.type) {
    case "text":
      return m.text ?? "";
    case "picture":
      return `[Picture]${caption}`;
    case "video":
      return `[Video${m.duration ? ` ${m.duration}s` : ""}]${caption}`;
    case "file":
      return `[File: ${m.file_name ?? "file"}]`;
    case "location":
      return `[Location: ${m.location?.lat ?? "?"}, ${m.location?.lon ?? "?"}]`;
    // Never put the contact's phone number in the feed.
    case "contact":
      return `[Contact: ${m.contact?.name ?? "shared contact"}]`;
    case "sticker":
      return "[Sticker]";
    case "url":
      return `[Link: ${m.media ?? "?"}]`;
    default:
      return `[${m.type}]${caption}`;
  }
}

/** One callback → activity: message → dm, subscribed → follow. conversation_started, delivered, seen… are ignored. */
export function viberCallbackToActivity(e: ViberCallback): ActivityInput | null {
  const occurredAt = typeof e.timestamp === "number" && Number.isFinite(e.timestamp) ? new Date(e.timestamp).toISOString() : null;
  if (!occurredAt) return null;
  if (e.event === "message" && e.sender?.id && e.message) {
    const name = e.sender.name ?? null;
    return { network: "viber", kind: "dm", externalId: `${e.sender.id}:${e.message_token ?? e.timestamp}`, authorHandle: e.sender.id, authorName: name, text: viberMessageText(e.message), url: null, parentExternalId: null, occurredAt, raw: e, conversation: { id: e.sender.id, name, type: "direct" } };
  }
  if (e.event === "subscribed" && e.user?.id) {
    const name = e.user.name ?? null;
    return { network: "viber", kind: "follow", externalId: `${e.user.id}:subscribed:${e.message_token ?? e.timestamp}`, authorHandle: e.user.id, authorName: name, text: "[Subscribed]", url: null, parentExternalId: null, occurredAt, raw: e, conversation: { id: e.user.id, name, type: "direct" } };
  }
  return null;
}

// Viber status codes (REST Bot API / Channels Post API).
const STATUS_NAMES: Record<number, string> = {
  1: "invalid URL",
  2: "invalid auth token",
  3: "bad data",
  4: "missing data",
  5: "receiver not registered",
  6: "receiver not subscribed",
  7: "account blocked",
  8: "account not found",
  9: "account suspended",
  10: "webhook not set",
  11: "receiver has no suitable device",
  12: "too many requests",
  13: "API version not supported by the receiver",
  14: "incompatible with version",
  15: "account not authorized",
  16: "in-chat reply not allowed",
  17: "account is not inline",
  18: "no public chat",
  19: "cannot send broadcast",
  20: "broadcast not allowed",
  21: "unsupported country",
  22: "payment unsupported",
  23: "free messages exceeded",
  24: "no balance",
};

/** Viber `status` → ConnectorError. */
export function mapViberError(code: number | undefined, message: string | undefined, what: string, httpStatus = 200, body: unknown = undefined): ConnectorError {
  const name = code !== undefined ? STATUS_NAMES[code] : undefined;
  const msg = `viber ${what}: ${code !== undefined ? `status ${code}` : `HTTP ${httpStatus}`}${message ? ` ${message}` : name ? ` ${name}` : ""}`;
  const cause: ViberFailure = { status: httpStatus, ...(code !== undefined ? { code } : {}), body };
  if (code !== undefined) {
    if (code === 2) return new ConnectorError(`${msg} (the auth token was rejected; paste a new one)`, "auth", false, cause);
    if (code === 7 || code === 8 || code === 9 || code === 15) return new ConnectorError(`${msg} (Viber has blocked, suspended or not authorised this account)`, "auth", false, cause);
    if (code === 12) return new ConnectorError(`${msg} (rate limited; try again shortly)`, "rate_limit", true, cause);
    if (code === 5 || code === 6 || code === 11) return new ConnectorError(`${msg} (this person cannot receive messages from the account: not subscribed or no suitable device)`, "rejected", false, cause);
    if (code === 23 || code === 24) return new ConnectorError(`${msg} (the bot's message allowance or balance is used up)`, "rejected", false, cause);
    if (code === 10) return new ConnectorError(`${msg} (Viber needs a webhook set before it accepts posts; check STARSIGN_PUBLIC_URL)`, "rejected", false, cause);
    return new ConnectorError(msg, "rejected", false, cause);
  }
  const { kind, retryable } = classifyHttpStatus(httpStatus);
  return new ConnectorError(msg, kind, retryable, cause);
}

function parseAuth(account: AccountRef): ViberAuth {
  const p = ViberAuth.safeParse(account.auth ?? {});
  if (!p.success) throw new ConnectorError(`viber account ${account.handle}: auth blob needs authToken`, "auth", false);
  return p.data;
}

function configOf(account: AccountRef): Partial<ViberAccountConfig> {
  return account.config as Partial<ViberAccountConfig>;
}

// ---- connector --------------------------------------------------------------------------

export class ViberConnector implements Connector {
  readonly name = "viber";
  readonly networks: readonly Network[] = ["viber"];
  readonly connectMethod = "bot_token" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [
    { key: "authToken", label: "Auth token (Channel: Settings → Developer tools; Bot: the bot's token)", placeholder: "4f0a1b2c3d4e5f60-…", secret: true },
    { key: "kind", label: "Account type: channel or bot (default channel)", placeholder: "channel", optional: true },
  ] as const;
  media?: Connector["media"];
  readonly webhook: WebhookHandler;

  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly publicUrl: string | undefined;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  /** Accounts whose webhook this process has set. */
  private readonly webhookOk = new Set<string>();

  constructor(opts: ViberConnectorOptions = {}) {
    this.apiBase = (opts.apiBase ?? API).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.publicUrl = opts.publicUrl?.replace(/\/+$/, "");
    this.webhook = {
      // Never used: every account signs with its own token, so route + verifyAccount take over.
      verify: () => false,
      route: (_raw, query) => (query.account ? { network: "viber", accountExternalId: query.account } : null),
      verifyAccount: (account, headers, rawBody, query) => {
        const token = typeof account.auth?.authToken === "string" ? account.auth.authToken : "";
        const sig = Object.entries(headers).find(([k]) => k.toLowerCase() === "x-viber-content-signature")?.[1] ?? query.sig;
        return viberSignatureValid(token, rawBody, sig);
      },
      // The body does not name the account; carry it from the verified route into parse.
      decodeAccount: (account, rawBody) => ({ account: account.externalId, payload: viberParse(rawBody) }),
      parse: (body) => this.parseCallback(body),
    };
  }

  capabilities(): ConnectorCapabilities {
    // fetchActivity reads nothing (the inbox is webhook-only); polling keeps the webhook set.
    return { publish: true, fetchActivity: true, fetchMetrics: false, meteredReads: false, reply: true, moderate: false, accountMetrics: true, webhooks: true, video: true, kinds: ["post", "link", "video"] };
  }

  // ---- connect ---------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const parsed = ViberAuth.safeParse({ authToken: (p.inputs.authToken ?? "").trim() });
    if (!parsed.success) throw new ConnectorError("viber: paste the auth token from the channel's Developer tools or from the bot's settings", "auth", false);
    const kind = (p.inputs.kind ?? "").trim().toLowerCase() || "channel";
    if (kind !== "channel" && kind !== "bot") throw new ConnectorError('viber: account type must be "channel" or "bot"', "rejected", false);
    const token = parsed.data.authToken;
    const info = await this.accountInfo(token);
    let from: string | null = null;
    if (kind === "channel") {
      // Only a superadmin may be the sender of channel posts.
      from = info.members?.find((m) => m.role === "superadmin")?.id ?? null;
      if (!from) throw new ConnectorError("viber: this token's account lists no channel superadmin; use the token of a Viber Channel you are superadmin of (or choose bot)", "rejected", false);
    }
    const webhookUrl = this.webhookUrlFor(info.id);
    let webhookSet = false;
    if (webhookUrl) {
      try {
        await this.setWebhook(token, webhookUrl, kind);
        webhookSet = true;
      } catch (err) {
        if (err instanceof ConnectorError && err.kind === "auth") throw err;
        // Expected on first connect: Viber checks the URL before Starsign has saved the account. Set again later.
      }
    }
    const config: ViberAccountConfig = { kind, accountId: info.id, name: info.name ?? null, uri: info.uri ?? null, from, subscribersCount: typeof info.subscribers_count === "number" ? info.subscribers_count : null, webhookUrl, webhookSet };
    return [{ network: "viber", identity: identityOf(info), auth: { authToken: token }, config: { ...config } }];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const token = typeof auth.authToken === "string" ? auth.authToken : "";
    if (!token) throw new ConnectorError("viber: authToken is required", "auth", false);
    return identityOf(await this.accountInfo(token));
  }

  private accountInfo(token: string): Promise<AccountInfo> {
    return this.call<AccountInfo>(token, "/get_account_info", {}, "get_account_info");
  }

  private webhookUrlFor(accountId: string): string | null {
    return this.publicUrl ? `${this.publicUrl}/webhooks/viber?account=${encodeURIComponent(accountId)}` : null;
  }

  // TODO(verify): which event_types a channel webhook accepts (we send none for channels).
  private setWebhook(token: string, url: string, kind: "channel" | "bot") {
    return this.call(token, "/set_webhook", { url, ...(kind === "bot" ? { event_types: ["subscribed", "unsubscribed", "conversation_started", "delivered", "seen", "failed"] } : {}), send_name: true, send_photo: false }, "set_webhook");
  }

  /** Set the account's webhook once per process (needs STARSIGN_PUBLIC_URL). Returns whether it is set. */
  async ensureWebhook(account: AccountRef): Promise<boolean> {
    const url = this.webhookUrlFor(account.externalId);
    if (!url) return false;
    if (this.webhookOk.has(account.externalId)) return true;
    await this.setWebhook(parseAuth(account).authToken, url, configOf(account).kind === "bot" ? "bot" : "channel");
    this.webhookOk.add(account.externalId);
    return true;
  }

  // ---- webhooks -------------------------------------------------------------------------

  private parseCallback(body: unknown): WebhookBatch[] {
    const b = body as { account?: unknown; payload?: unknown } | null;
    if (!b || typeof b.account !== "string" || !b.payload || typeof b.payload !== "object") return [];
    const item = viberCallbackToActivity(b.payload as ViberCallback);
    return item ? [{ network: "viber", accountExternalId: b.account, items: [item] }] : [];
  }

  // ---- publish --------------------------------------------------------------------------

  validate(account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (configOf(account).kind === "bot") issues.push({ code: "unsupported_media", message: "Viber bots only answer people; connect a Viber Channel to publish" });
    const text = this.textOf(input);
    if (!text.trim() && input.media.length === 0) issues.push({ code: "empty", message: "a Viber post needs text, a link or media" });
    if ([...text].length > LIMITS.text) issues.push({ code: "too_long", message: `Viber messages are at most ${LIMITS.text} characters` });
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "Viber channels have no threads" });
    if (input.media.length > 1) issues.push({ code: "too_many_media", message: "one picture, video or file per Viber post" });
    const m = input.media[0];
    if (m) {
      if (!/^https:\/\//i.test(m.url)) issues.push({ code: "unsupported_media", message: "Viber fetches media itself: the URL must be public HTTPS" });
      if (m.kind === "video") {
        if (m.mime && m.mime !== "video/mp4") issues.push({ code: "unsupported_media", message: "Viber videos must be MP4 (H.264)" });
        if (m.bytes !== undefined && m.bytes > LIMITS.videoBytes) issues.push({ code: "unsupported_media", message: "Viber videos are at most 50 MB" });
        if (m.durationSeconds !== undefined && m.durationSeconds > LIMITS.videoSeconds) issues.push({ code: "unsupported_media", message: "Viber channel videos are at most 180 seconds" });
      }
      if (m.kind === "document" && m.bytes !== undefined && m.bytes > LIMITS.fileBytes) issues.push({ code: "unsupported_media", message: "Viber files are at most 50 MB" });
    }
    return issues;
  }

  /**
   * Channel post(s): text (with the link), or a picture with the text as its caption when it fits, or a video/file
   * after a text message. The first message's token is the post id; the rest are thread ids.
   */
  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    if (input.replyToExternalId) return this.reply(account, { parentExternalId: input.replyToExternalId, text: input.text, idempotencyKey: input.idempotencyKey });
    return this.idempotency.run(input.idempotencyKey, async () => {
      const issues = this.validate(account, input);
      if (issues.length) throw new ConnectorError(`viber publish: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
      const cfg = configOf(account);
      if (!cfg.from) throw new ConnectorError("viber publish: the account has no superadmin sender id; reconnect the channel", "auth", false);
      const token = parseAuth(account).authToken;
      const messages = await this.messagesFor(input);
      const tokens: string[] = [];
      for (const msg of messages) {
        const r = await this.postToChannel(account, token, { from: cfg.from, ...msg });
        tokens.push(`${account.externalId}:${String(r.message_token ?? `req-${input.idempotencyKey}-${tokens.length}`)}`);
      }
      return { externalId: tokens[0]!, url: null, ...(tokens.length > 1 ? { threadExternalIds: tokens.slice(1) } : {}), raw: { messages: tokens } };
    });
  }

  private textOf(input: PublishInput): string {
    const link = input.options?.link;
    return link && !input.text.includes(link) ? `${input.text}${input.text ? "\n\n" : ""}${link}` : input.text;
  }

  private async messagesFor(input: PublishInput): Promise<Record<string, unknown>[]> {
    const text = this.textOf(input);
    const m = input.media[0];
    const thumb = input.options?.thumbnailUrl;
    if (!m) {
      // A bare link goes out as a URL message; anything else as text.
      if (!input.text.trim() && input.options?.link) return [{ type: "url", media: input.options.link }];
      return [{ type: "text", text }];
    }
    const out: Record<string, unknown>[] = [];
    if (m.kind === "image" || m.kind === "gif") {
      const fits = [...text].length <= LIMITS.caption;
      if (text.trim() && !fits) out.push({ type: "text", text });
      out.push({ type: "picture", media: m.url, text: fits ? text : "", ...(thumb ? { thumbnail: thumb } : {}) });
      return out;
    }
    if (text.trim()) out.push({ type: "text", text });
    const size = await this.sizeOf(m);
    if (m.kind === "video") out.push({ type: "video", media: m.url, size, ...(m.durationSeconds ? { duration: Math.round(m.durationSeconds) } : {}), ...(thumb ? { thumbnail: thumb } : {}) });
    else out.push({ type: "file", media: m.url, size, file_name: fileName(m) });
    return out;
  }

  /** Viber needs the byte size of videos and files up front: from the media record, else from the fetcher. */
  private async sizeOf(m: Media): Promise<number> {
    const n = m.bytes ?? (await this.media?.size?.(m)) ?? null;
    if (typeof n !== "number" || n <= 0) throw new ConnectorError("viber publish: the video or file size is unknown; Viber needs it in the request", "rejected", false);
    if (n > (m.kind === "video" ? LIMITS.videoBytes : LIMITS.fileBytes)) throw new ConnectorError("viber publish: videos and files are at most 50 MB", "rejected", false);
    return n;
  }

  /** POST /pa/post; when Viber says no webhook is set, set it and try once more. */
  private async postToChannel(account: AccountRef, token: string, body: Record<string, unknown>): Promise<{ message_token?: string | number }> {
    try {
      return await this.call(token, "/post", body, "post");
    } catch (err) {
      if (!(err instanceof ConnectorError) || (err.cause as ViberFailure | undefined)?.code !== 10 || !this.publicUrl) throw err;
      this.webhookOk.delete(account.externalId);
      await this.ensureWebhook(account);
      return this.call(token, "/post", body, "post");
    }
  }

  // ---- engage ---------------------------------------------------------------------------

  /** Bots: a text message to the person ("<user id>:<message token>" or a bare user id). Channels have no inbox. */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.idempotency.run(`reply:${input.idempotencyKey}`, async () => {
      const cfg = configOf(account);
      if (cfg.kind !== "bot") throw new ConnectorError("viber reply: Viber Channels have no inbox to reply to; only bots answer people", "rejected", false);
      const i = input.parentExternalId.lastIndexOf(":");
      const receiver = i > 0 ? input.parentExternalId.slice(0, i) : input.parentExternalId;
      if (!receiver) throw new ConnectorError(`viber reply: "${input.parentExternalId}" does not name a Viber user`, "rejected", false);
      if (!input.text.trim()) throw new ConnectorError("viber reply: text is empty", "rejected", false);
      if ([...input.text].length > LIMITS.text) throw new ConnectorError(`viber reply: messages are at most ${LIMITS.text} characters`, "rejected", false);
      const token = parseAuth(account).authToken;
      const sender = (cfg.name ?? account.handle ?? "Starsign").slice(0, LIMITS.senderName);
      const r = await this.call<{ message_token?: string | number }>(token, "/send_message", { receiver, min_api_version: 1, sender: { name: sender }, type: "text", text: input.text }, "send_message");
      return { externalId: `${receiver}:${String(r.message_token ?? `sent-${input.idempotencyKey}`)}`, url: null, raw: r };
    });
  }

  async moderate(_account: AccountRef, input: ModerationInput): Promise<void> {
    throw new ConnectorError(`viber: ${input.action} is not available through the Viber APIs`, "rejected", false);
  }

  // ---- listen / measure -----------------------------------------------------------------

  /** Webhook-only inbox. Each poll makes sure the account's webhook is set (once per process). */
  async fetchActivity(account: AccountRef): Promise<ActivityInput[]> {
    try {
      await this.ensureWebhook(account);
    } catch (err) {
      if (err instanceof ConnectorError && err.kind === "auth") throw err;
    }
    return [];
  }

  /** Viber reports no per-post statistics through the API. */
  async fetchMetrics(): Promise<MetricInput[]> {
    return [];
  }

  /** followers_total = subscribers_count from get_account_info. */
  // TODO(verify): channels report their audience in subscribers_count (bots certainly do).
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const info = await this.accountInfo(parseAuth(account).authToken);
    if (typeof info.subscribers_count !== "number") return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: info.subscribers_count, observedAt: this.now().toISOString(), source: "viber" }];
  }

  // ---- transport ------------------------------------------------------------------------

  private async call<T>(token: string, path: string, body: unknown, what: string): Promise<T> {
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(`${this.apiBase}${path}`, { method: "POST", headers: { "x-viber-auth-token": token, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
    } catch (err) {
      throw asNetworkError(err instanceof Error ? new Error(err.message.replaceAll(token, "<token>")) : err, `viber ${what}`);
    }
    const text = await res.text().catch(() => "");
    let data: unknown = undefined;
    try {
      data = text ? viberParse(text) : undefined;
    } catch {
      data = text;
    }
    const b = data && typeof data === "object" ? (data as { status?: number; status_message?: string }) : undefined;
    if (b && typeof b.status === "number" && b.status !== 0) throw mapViberError(b.status, b.status_message, what, res.status, data);
    if (!res.ok) throw mapViberError(undefined, undefined, what, res.status, data);
    if (!b) throw new ConnectorError(`viber ${what}: unexpected response`, "unknown", false, data);
    return b as T;
  }
}

function identityOf(info: AccountInfo): AccountIdentity {
  return { externalId: info.id, handle: info.uri ?? info.name ?? info.id, displayName: info.name ?? null };
}

function fileName(m: Media): string {
  try {
    const last = new URL(m.url).pathname.split("/").pop();
    if (last && /\.[A-Za-z0-9]{1,8}$/.test(last)) return decodeURIComponent(last).slice(0, 256);
  } catch {
    /* not a URL */
  }
  return "file.pdf";
}

/** Registry entry for Viber. No env is required; STARSIGN_PUBLIC_URL lets Starsign set each account's webhook. */
export function createViberConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [new ViberConnector({ ...(env.VIBER_API_BASE ? { apiBase: env.VIBER_API_BASE } : {}), ...(env.STARSIGN_PUBLIC_URL ? { publicUrl: env.STARSIGN_PUBLIC_URL } : {}) })];
}
