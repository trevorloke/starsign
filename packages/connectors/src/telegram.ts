import { timingSafeEqual } from "node:crypto";
import type { ActivityInput, ActivityKind, Media, MetricInput, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, isAfter, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { StreamingForm, mediaSource, openForUpload, sendBody, setMediaFile, uploadForm, withUpload, type MediaReader } from "./media-io.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, ModerationInput, PublishInput, PublishResult, ValidationIssue, WebhookBatch, WebhookHandler } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Telegram channels (and groups) through the Bot API. A person creates a bot with @BotFather, makes it an admin of
 * the channel, and pastes the bot token plus the channel's @username or chat id. One account = one bot + one chat.
 *
 * External ids are "<chat id>:<message id>" because comments live in the channel's linked discussion group, a
 * different chat. A bare message id is read as a message of the account's own chat.
 */

export const TelegramAuth = z.object({ botToken: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, "not a bot token") });
export type TelegramAuth = z.infer<typeof TelegramAuth>;

export interface TelegramConnectorOptions {
  apiBase?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** Deployment-wide secret sent by Telegram in X-Telegram-Bot-Api-Secret-Token (1-256 of A-Z a-z 0-9 _ -). */
  webhookSecret?: string;
  /** STARSIGN_PUBLIC_URL: with a secret, connecting registers ${publicUrl}/webhooks/telegram via setWebhook. */
  publicUrl?: string;
  /** getUpdates pages (100 updates each) per poll when no webhook is set. */
  maxPages?: number;
}

/** Fields of Telegram's Message we read. */
export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; is_bot?: boolean; username?: string; first_name?: string; last_name?: string };
  sender_chat?: { id: number; title?: string; username?: string };
  text?: string;
  caption?: string;
  is_automatic_forward?: boolean;
  forward_origin?: { type: string; chat?: { id: number }; message_id?: number };
  forward_from_message_id?: number;
  forward_from_chat?: { id: number };
  reply_to_message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

/** Telegram limits: captions 1024, polls 300-char questions, URL fetches 5 MB photos / 20 MB other, uploads 10 / 50 MB. */
const LIMITS = { caption: 1024, pollQuestion: 300, urlPhoto: 5_000_000, urlOther: 20_000_000, openPeriodMax: 600 } as const;

/** Escape for parse_mode=HTML: only &, < and > are special outside tags. */
export function telegramEscapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** https://t.me link for a message: public chats by username, private supergroups/channels by /c/<id without -100>. */
export function telegramMessageUrl(chat: { id: number | string; username?: string | null }, messageId: number | string): string | null {
  if (chat.username) return `https://t.me/${chat.username.replace(/^@/, "")}/${messageId}`;
  const id = String(chat.id);
  return id.startsWith("-100") ? `https://t.me/c/${id.slice(4)}/${messageId}` : null;
}

interface TelegramFailure {
  status: number;
  errorCode?: number;
  description?: string;
  retryAfter?: number;
}

/** Bot API error → ConnectorError. Never includes the URL: it carries the bot token. */
export function mapTelegramError(status: number, body: unknown, method: string): ConnectorError {
  const b = (body ?? {}) as { error_code?: number; description?: string; parameters?: { retry_after?: number; migrate_to_chat_id?: number } };
  const code = b.error_code ?? status;
  const description = b.description ?? `HTTP ${status}`;
  const cause: TelegramFailure = { status, errorCode: code, description, ...(b.parameters?.retry_after ? { retryAfter: b.parameters.retry_after } : {}) };
  const msg = `telegram ${method}: ${description}`;
  if (code === 429) return new ConnectorError(`${msg} (retry after ${b.parameters?.retry_after ?? "?"}s)`, "rate_limit", true, cause);
  if (code === 401 || code === 404) return new ConnectorError(`${msg} (bot token rejected; check it with @BotFather)`, "auth", false, cause);
  if (code === 403) return new ConnectorError(`${msg} (the bot was removed from the chat or lacks admin rights)`, "auth", false, cause);
  if (code === 409) return new ConnectorError(`${msg} (a webhook is set for this bot, so updates arrive by webhook)`, "rejected", false, cause);
  if (code >= 500) return new ConnectorError(msg, "network", true, cause);
  if (code >= 400) return new ConnectorError(msg, "rejected", false, cause);
  return new ConnectorError(msg, "unknown", false, cause);
}

function textOf(m: TelegramMessage): string | null {
  return m.text ?? m.caption ?? null;
}

function authorOf(m: TelegramMessage): { authorHandle: string | null; authorName: string | null } {
  if (m.sender_chat) return { authorHandle: m.sender_chat.username ? `@${m.sender_chat.username}` : null, authorName: m.sender_chat.title ?? null };
  if (m.from) return { authorHandle: m.from.username ? `@${m.from.username}` : null, authorName: [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || null };
  return { authorHandle: null, authorName: null };
}

/** The channel post an automatic-forward copy in the discussion group stands for. */
function forwardedFrom(m: TelegramMessage): { chatId: number; messageId: number } | null {
  const chatId = m.forward_origin?.chat?.id ?? m.forward_from_chat?.id ?? m.sender_chat?.id;
  const messageId = m.forward_origin?.message_id ?? m.forward_from_message_id;
  return chatId !== undefined && messageId !== undefined ? { chatId, messageId } : null;
}

/**
 * One update → the account it belongs to and the activity, or null. Channel posts are own posts; group messages
 * replying to an automatic forward are comments on that channel post (routed to the channel); other group messages
 * are replies (to the bot), mentions (of the bot) or comments of the group account.
 */
export function telegramUpdateToActivity(u: TelegramUpdate, ctx: { botId?: number; botUsername?: string; linkedToChannel?: Map<string, string> } = {}): { accountExternalId: string; item: ActivityInput } | null {
  const occurred = (m: TelegramMessage) => new Date(m.date * 1000).toISOString();
  if (u.channel_post) {
    const m = u.channel_post;
    return {
      accountExternalId: String(m.chat.id),
      item: { network: "telegram", kind: "own_post", externalId: `${m.chat.id}:${m.message_id}`, authorHandle: m.chat.username ? `@${m.chat.username}` : null, authorName: m.chat.title ?? null, text: textOf(m), url: telegramMessageUrl(m.chat, m.message_id), parentExternalId: null, occurredAt: occurred(m), raw: u },
    };
  }
  const m = u.message;
  if (!m || m.chat.type === "private" || m.is_automatic_forward) return null;
  if (ctx.botId !== undefined && m.from?.id === ctx.botId) return null; // our own replies
  const groupId = String(m.chat.id);
  const parent = m.reply_to_message;
  let kind: ActivityKind = "comment";
  let parentExternalId: string | null = null;
  let accountExternalId = ctx.linkedToChannel?.get(groupId) ?? groupId;
  if (parent?.is_automatic_forward) {
    const origin = forwardedFrom(parent);
    if (origin) {
      parentExternalId = `${origin.chatId}:${origin.messageId}`;
      accountExternalId = String(origin.chatId);
    }
  } else if (parent) {
    parentExternalId = `${groupId}:${parent.message_id}`;
    if (ctx.botId !== undefined && parent.from?.id === ctx.botId) kind = "reply";
  } else if (ctx.botUsername && (textOf(m) ?? "").toLowerCase().includes(`@${ctx.botUsername.toLowerCase()}`)) {
    kind = "mention";
  }
  return {
    accountExternalId,
    item: { network: "telegram", kind, externalId: `${groupId}:${m.message_id}`, ...authorOf(m), text: textOf(m), url: telegramMessageUrl(m.chat, m.message_id), parentExternalId, occurredAt: occurred(m), raw: u },
  };
}

interface ChatConfig {
  chatId: string;
  chatType: string;
  username: string | null;
  title: string | null;
  linkedChatId: string | null;
  botId: number;
  botUsername: string | null;
  webhook: boolean;
}

export class TelegramConnector implements Connector {
  readonly name = "telegram";
  readonly networks: readonly Network[] = ["telegram"];
  readonly connectMethod = "bot_token" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [
    { key: "botToken", label: "Bot token (from @BotFather)", placeholder: "123456789:AA...", secret: true },
    { key: "chat", label: "Channel username or chat id", placeholder: "@acmenews or -1001234567890" },
  ] as const;
  media?: MediaFetcher;
  readonly webhook?: WebhookHandler;

  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly webhookSecret: string | undefined;
  private readonly publicUrl: string | undefined;
  private readonly maxPages: number;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  /** Discussion group id → channel id, learned at connect (process-local). */
  private readonly linkedToChannel = new Map<string, string>();
  /** "<channel>:<post>" → "<group>:<copy>": the discussion-group copy of a channel post, learned from updates. */
  private readonly discussionCopy = new Map<string, string>();
  /** Per bot: next getUpdates offset and recent updates, so several chats on one bot share one update stream. */
  private readonly updates = new Map<string, { offset: number; recent: TelegramUpdate[] }>();

  constructor(opts: TelegramConnectorOptions = {}) {
    this.apiBase = (opts.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.webhookSecret = opts.webhookSecret && /^[A-Za-z0-9_-]{1,256}$/.test(opts.webhookSecret) ? opts.webhookSecret : undefined;
    this.publicUrl = opts.publicUrl?.replace(/\/+$/, "");
    this.maxPages = opts.maxPages ?? 5;
    if (this.webhookSecret) {
      const secret = this.webhookSecret;
      this.webhook = {
        verify: (headers) => {
          const got = Object.entries(headers).find(([k]) => k.toLowerCase() === "x-telegram-bot-api-secret-token")?.[1] ?? "";
          const a = Buffer.from(got);
          const b = Buffer.from(secret);
          return a.length === b.length && timingSafeEqual(a, b);
        },
        parse: (body) => this.parseUpdate(body),
      };
    }
  }

  capabilities(): ConnectorCapabilities {
    // Per-message views are not exposed by the Bot API, so there are no post metrics.
    return { publish: true, fetchActivity: true, fetchMetrics: false, meteredReads: false, reply: true, moderate: true, accountMetrics: true, webhooks: !!this.webhookSecret, video: true, kinds: ["post", "poll", "video", "carousel"] };
  }

  // ---- connect --------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const parsed = TelegramAuth.safeParse({ botToken: (p.inputs.botToken ?? "").trim() });
    if (!parsed.success) throw new ConnectorError("telegram: that does not look like a bot token (123456789:AA...)", "auth", false);
    const token = parsed.data.botToken;
    const chatInput = (p.inputs.chat ?? "").trim().replace(/^https?:\/\/t\.me\//i, "");
    const chatRef = /^-?\d+$/.test(chatInput) ? chatInput : `@${chatInput.replace(/^@/, "")}`;
    const bot = await this.api<{ id: number; username?: string }>(token, "getMe", {});
    const chat = await this.api<{ id: number; type: string; title?: string; username?: string; linked_chat_id?: number }>(token, "getChat", { chat_id: chatRef });
    const member = await this.api<{ status: string; can_post_messages?: boolean }>(token, "getChatMember", { chat_id: chat.id, user_id: bot.id });
    if (member.status !== "administrator" && member.status !== "creator") throw new ConnectorError(`telegram: the bot @${bot.username ?? bot.id} is not an admin of ${chat.title ?? chatRef}; add it as an administrator first`, "rejected", false);
    if (chat.type === "channel" && member.can_post_messages === false) throw new ConnectorError("telegram: the bot is an admin but may not post messages in this channel", "rejected", false);
    let webhook = false;
    if (this.webhookSecret && this.publicUrl) {
      await this.api(token, "setWebhook", { url: `${this.publicUrl}/webhooks/telegram`, secret_token: this.webhookSecret, allowed_updates: ["message", "channel_post"] });
      webhook = true;
    }
    if (chat.linked_chat_id) this.linkedToChannel.set(String(chat.linked_chat_id), String(chat.id));
    const config: ChatConfig = { chatId: String(chat.id), chatType: chat.type, username: chat.username ?? null, title: chat.title ?? null, linkedChatId: chat.linked_chat_id ? String(chat.linked_chat_id) : null, botId: bot.id, botUsername: bot.username ?? null, webhook };
    const identity: AccountIdentity = { externalId: String(chat.id), handle: chat.username ? `@${chat.username}` : (chat.title ?? String(chat.id)), displayName: chat.title ?? null };
    return [{ network: "telegram", identity, auth: { botToken: token }, config: { ...config } }];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const token = TelegramAuth.safeParse(auth);
    if (!token.success) throw new ConnectorError("telegram: botToken is required", "auth", false);
    const bot = await this.api<{ id: number; username?: string; first_name?: string }>(token.data.botToken, "getMe", {});
    return { externalId: String(bot.id), handle: bot.username ? `@${bot.username}` : String(bot.id), displayName: bot.first_name ?? null };
  }

  // ---- publish --------------------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const poll = input.options?.poll;
    if (poll && input.media.length > 0) issues.push({ code: "unsupported_media", message: "telegram polls cannot carry media" });
    if (poll && [...(input.options?.title ?? input.text)].length > LIMITS.pollQuestion) issues.push({ code: "too_long", message: `telegram poll questions are at most ${LIMITS.pollQuestion} characters (use the title for the question)` });
    if (input.media.length > 1) {
      const docs = input.media.filter((m) => m.kind === "document").length;
      if (input.media.some((m) => m.kind === "gif")) issues.push({ code: "unsupported_media", message: "telegram albums cannot contain GIFs; post the GIF on its own" });
      if (docs > 0 && docs < input.media.length) issues.push({ code: "unsupported_media", message: "telegram albums cannot mix documents with photos or videos" });
    }
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const cfg = configOf(account);
      const opts = input.options ?? {};
      let html = telegramEscapeHtml(input.text);
      if (opts.title && !opts.poll) html = `<b>${telegramEscapeHtml(opts.title)}</b>\n\n${html}`;
      if (opts.link && !input.text.includes(opts.link)) html = `${html}\n\n${telegramEscapeHtml(opts.link)}`;
      const target = input.replyToExternalId ? this.replyTarget(cfg, input.replyToExternalId) : { chatId: cfg.chatId, reply: undefined };
      const base = { chat_id: target.chatId, ...(target.reply ? { reply_parameters: { message_id: target.reply, allow_sending_without_reply: true } } : {}) };
      const sent: TelegramMessage[] = [];

      if (opts.poll) {
        const seconds = opts.poll.durationMinutes * 60;
        // Channel polls must be anonymous. open_period caps at 600s; longer polls stay open until stopped.
        sent.push(await this.api<TelegramMessage>(auth.botToken, "sendPoll", { ...base, question: (opts.title ?? input.text).slice(0, LIMITS.pollQuestion), options: opts.poll.options.map((text) => ({ text })), is_anonymous: true, ...(seconds <= LIMITS.openPeriodMax ? { open_period: seconds } : {}) }));
      } else if (input.media.length === 0) {
        sent.push(await this.api<TelegramMessage>(auth.botToken, "sendMessage", { ...base, text: html, parse_mode: "HTML" }));
      } else {
        // Captions are capped at 1024; a longer text follows the media as its own message.
        const captionFits = [...html].length <= LIMITS.caption;
        const caption = captionFits && html ? { caption: html, parse_mode: "HTML" } : {};
        if (input.media.length === 1) sent.push(await this.sendOne(auth.botToken, base, input.media[0]!, caption));
        else sent.push(...(await this.sendGroup(auth.botToken, base, input.media, caption)));
        if (!captionFits) sent.push(await this.api<TelegramMessage>(auth.botToken, "sendMessage", { chat_id: target.chatId, text: html, parse_mode: "HTML" }));
      }
      const root = sent[0];
      if (!root) throw new ConnectorError("telegram publish: nothing was sent", "unknown", false);
      return { externalId: `${root.chat.id}:${root.message_id}`, url: telegramMessageUrl({ id: root.chat.id, username: root.chat.username ?? (String(root.chat.id) === cfg.chatId ? cfg.username : null) }, root.message_id), raw: { messages: sent.map((m) => `${m.chat.id}:${m.message_id}`) } };
    });
  }

  private methodFor(m: Media): { method: string; field: string; type: string } {
    if (m.kind === "image") return { method: "sendPhoto", field: "photo", type: "photo" };
    if (m.kind === "video") return { method: "sendVideo", field: "video", type: "video" };
    if (m.kind === "gif") return { method: "sendAnimation", field: "animation", type: "animation" };
    return { method: "sendDocument", field: "document", type: "document" };
  }

  /** Telegram fetches URLs itself (5 MB photos, 20 MB other); bigger files, or URLs it cannot reach, are uploaded. */
  private urlFirst(m: Media): boolean {
    if (!/^https:\/\//i.test(m.url)) return false;
    return m.bytes === undefined || m.bytes <= (m.kind === "image" ? LIMITS.urlPhoto : LIMITS.urlOther);
  }

  private async sendOne(token: string, base: Record<string, unknown>, m: Media, caption: Record<string, unknown>): Promise<TelegramMessage> {
    const { method, field } = this.methodFor(m);
    const extra = m.kind === "video" ? { supports_streaming: true, ...(m.width && m.height ? { width: m.width, height: m.height } : {}), ...(m.durationSeconds ? { duration: Math.round(m.durationSeconds) } : {}) } : {};
    if (this.urlFirst(m)) {
      try {
        return await this.api<TelegramMessage>(token, method, { ...base, ...caption, ...extra, [field]: m.url });
      } catch (err) {
        if (!isUrlFetchFailure(err)) throw err;
      }
    }
    // Videos and documents go up as a streamed multipart body (exact Content-Length); photos are read whole as before.
    return withUpload(this.source(), m, async (file) => {
      const form = formOf({ ...base, ...caption, ...extra }, [file]);
      setMediaFile(form, field, file, fileName(m, file.mime, 0));
      return this.api<TelegramMessage>(token, method, form);
    });
  }

  private async sendGroup(token: string, base: Record<string, unknown>, media: Media[], caption: Record<string, unknown>): Promise<TelegramMessage[]> {
    const items = (ref: (m: Media, i: number) => string) =>
      media.map((m, i) => ({ type: this.methodFor(m).type, media: ref(m, i), ...(i === 0 ? caption : {}), ...(m.kind === "video" ? { supports_streaming: true } : {}) }));
    if (media.every((m) => this.urlFirst(m))) {
      try {
        return await this.api<TelegramMessage[]>(token, "sendMediaGroup", { ...base, media: items((m) => m.url) });
      } catch (err) {
        if (!isUrlFetchFailure(err)) throw err;
      }
    }
    const files: MediaReader[] = [];
    try {
      for (const m of media) files.push(await openForUpload(this.source(), m));
      const form = formOf({ ...base, media: items((_m, i) => `attach://file${i}`) }, files);
      for (const [i, m] of media.entries()) setMediaFile(form, `file${i}`, files[i]!, fileName(m, files[i]!.mime, i));
      return await this.api<TelegramMessage[]>(token, "sendMediaGroup", form);
    } finally {
      for (const f of files) await f.close();
    }
  }

  private source(): MediaFetcher {
    return mediaSource(this.media, this.fetchImpl);
  }

  /** Where a reply goes: comments on a channel post are answered in its discussion-group copy when we know it. */
  private replyTarget(cfg: ChatConfig, parentExternalId: string): { chatId: string; reply: number } {
    const parent = parseMessageId(parentExternalId, cfg.chatId);
    if (parent.chatId === cfg.chatId && cfg.linkedChatId) {
      const copy = this.discussionCopy.get(`${parent.chatId}:${parent.messageId}`);
      if (copy) return { chatId: cfg.linkedChatId, reply: parseMessageId(copy, cfg.linkedChatId).messageId };
    }
    return { chatId: parent.chatId, reply: parent.messageId };
  }

  // ---- engage ---------------------------------------------------------------------------

  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.publish(account, { variantId: input.idempotencyKey, text: input.text, media: [], thread: [], replyToExternalId: input.parentExternalId, idempotencyKey: input.idempotencyKey, options: {} });
  }

  /** delete (deleteMessage) and like/unlike as a 👍 reaction (setMessageReaction). Telegram has no hide. */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    const auth = parseAuth(account);
    const { chatId, messageId } = parseMessageId(input.externalId, configOf(account).chatId);
    if (input.action === "delete") await this.api(auth.botToken, "deleteMessage", { chat_id: chatId, message_id: messageId });
    else if (input.action === "like" || input.action === "unlike") await this.api(auth.botToken, "setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: input.action === "like" ? [{ type: "emoji", emoji: "👍" }] : [] });
    else throw new ConnectorError(`telegram moderate: ${input.action} is not supported (delete the message instead)`, "rejected", false);
  }

  // ---- listen ---------------------------------------------------------------------------

  /**
   * Without a webhook, read getUpdates (shared per bot, confirmed by offset) and keep this chat's items. With a
   * webhook set, Telegram refuses getUpdates and items arrive through webhook.parse instead.
   */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const cfg = configOf(account);
    if (cfg.webhook) return [];
    const auth = parseAuth(account);
    const stream = this.updates.get(auth.botToken) ?? { offset: 0, recent: [] };
    this.updates.set(auth.botToken, stream);
    for (let page = 0; page < this.maxPages; page++) {
      const batch = await this.api<TelegramUpdate[]>(auth.botToken, "getUpdates", { offset: stream.offset || undefined, limit: 100, timeout: 0, allowed_updates: ["message", "channel_post"] });
      for (const u of batch) {
        stream.offset = Math.max(stream.offset, u.update_id + 1);
        stream.recent.push(u);
        this.learn(u);
      }
      if (batch.length < 100) break;
    }
    if (stream.recent.length > 1000) stream.recent.splice(0, stream.recent.length - 1000);
    if (cfg.linkedChatId) this.linkedToChannel.set(cfg.linkedChatId, cfg.chatId);
    const out: ActivityInput[] = [];
    for (const u of stream.recent) {
      const r = telegramUpdateToActivity(u, { botId: cfg.botId, ...(cfg.botUsername ? { botUsername: cfg.botUsername } : {}), linkedToChannel: this.linkedToChannel });
      if (r && r.accountExternalId === cfg.chatId && isAfter(r.item.occurredAt, since)) out.push(r.item);
    }
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  private learn(u: TelegramUpdate): void {
    const m = u.message;
    if (m?.is_automatic_forward) {
      const origin = forwardedFrom(m);
      if (origin) {
        this.discussionCopy.set(`${origin.chatId}:${origin.messageId}`, `${m.chat.id}:${m.message_id}`);
        this.linkedToChannel.set(String(m.chat.id), String(origin.chatId));
      }
    }
  }

  private parseUpdate(body: unknown): WebhookBatch[] {
    const u = body as TelegramUpdate;
    if (!u || typeof u !== "object" || typeof u.update_id !== "number") return [];
    this.learn(u);
    const r = telegramUpdateToActivity(u, { linkedToChannel: this.linkedToChannel });
    return r ? [{ network: "telegram", accountExternalId: r.accountExternalId, items: [r.item] }] : [];
  }

  // ---- measure --------------------------------------------------------------------------

  /** Per-message views are not available through the Bot API. */
  async fetchMetrics(): Promise<MetricInput[]> {
    return [];
  }

  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const count = await this.api<number>(auth.botToken, "getChatMemberCount", { chat_id: configOf(account).chatId });
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: count, observedAt: this.now().toISOString(), source: "telegram" }];
  }

  // ---- transport ------------------------------------------------------------------------

  private async api<T>(token: string, method: string, params: Record<string, unknown> | FormData | StreamingForm): Promise<T> {
    const url = `${this.apiBase}/bot${token}/${method}`;
    let res: Response;
    try {
      if (params instanceof StreamingForm) res = await sendBody(resolveFetch(this.fetchImpl), url, { method: "POST" }, params);
      else {
        const init: RequestInit = params instanceof FormData ? { method: "POST", body: params } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) };
        res = await resolveFetch(this.fetchImpl)(url, init);
      }
    } catch (err) {
      // The URL holds the token; report only the method.
      throw asNetworkError(err instanceof Error ? new Error(err.message.replaceAll(token, "<token>")) : err, `telegram ${method}`);
    }
    const body = (await readJson(res)) as { ok?: boolean; result?: T } | undefined;
    if (!res.ok || !body?.ok) throw mapTelegramError(res.status, body, method);
    return body.result as T;
  }
}

function isUrlFetchFailure(err: unknown): boolean {
  const d = err instanceof ConnectorError ? ((err.cause as TelegramFailure | undefined)?.description ?? "") : "";
  return err instanceof ConnectorError && err.kind === "rejected" && /HTTP URL|wrong file|failed to get|wrong type of the web page/i.test(d);
}

/** The fields as a form: a FormData, or a StreamingForm when a file in `files` is to be streamed. */
function formOf(fields: Record<string, unknown>, files: MediaReader[] = []): FormData | StreamingForm {
  const form = uploadForm(files);
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  return form;
}

function fileName(m: Media, mime: string, i: number): string {
  const fromUrl = m.url.split("?")[0]?.split("/").pop();
  return fromUrl && /\.[a-z0-9]{2,5}$/i.test(fromUrl) ? fromUrl : `file${i}.${mime.split("/")[1] ?? "bin"}`;
}

export function parseMessageId(id: string, defaultChat: string): { chatId: string; messageId: number } {
  const i = id.lastIndexOf(":");
  const chatId = i > 0 ? id.slice(0, i) : defaultChat;
  const messageId = Number(i > 0 ? id.slice(i + 1) : id);
  if (!Number.isInteger(messageId)) throw new ConnectorError(`telegram: "${id}" is not a message id`, "rejected", false);
  return { chatId, messageId };
}

function parseAuth(account: AccountRef): TelegramAuth {
  const parsed = TelegramAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`telegram account ${account.handle}: auth blob needs botToken`, "auth", false, parsed.error);
  return parsed.data;
}

function configOf(account: AccountRef): ChatConfig {
  const c = account.config as Partial<ChatConfig>;
  return {
    chatId: typeof c.chatId === "string" ? c.chatId : account.externalId,
    chatType: c.chatType ?? "channel",
    username: c.username ?? null,
    title: c.title ?? null,
    linkedChatId: c.linkedChatId ?? null,
    botId: typeof c.botId === "number" ? c.botId : Number(String((account.auth as { botToken?: string } | null)?.botToken ?? "").split(":")[0]),
    botUsername: c.botUsername ?? null,
    webhook: c.webhook === true,
  };
}

export function createTelegramConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [new TelegramConnector({ ...(env.TELEGRAM_WEBHOOK_SECRET ? { webhookSecret: env.TELEGRAM_WEBHOOK_SECRET } : {}), ...(env.STARSIGN_PUBLIC_URL ? { publicUrl: env.STARSIGN_PUBLIC_URL } : {}), ...(env.TELEGRAM_API_BASE ? { apiBase: env.TELEGRAM_API_BASE } : {}) })];
}
