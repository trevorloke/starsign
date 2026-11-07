import type { ActivityInput, ActivityKind, Media, MetricInput, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource, openForUpload, sendBody, setMediaFile, uploadForm, type MediaReader, type StreamingForm } from "./media-io.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, ModerationInput, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Discord servers through a bot user (REST API v10). A server admin creates an application in the Developer Portal,
 * turns on the Message Content intent, invites the bot with read/send permissions and pastes the bot token plus the
 * server (guild) id. One account = one server; the bot's readable text, announcement and forum channels are listed
 * at connect and polled with GET /channels/{id}/messages?after=<snowflake>.
 *
 * No Gateway: Starsign workers poll, so nothing arrives in real time. Real-time delivery needs a Gateway (WebSocket)
 * session and is a later step.
 *
 * External ids are "<channel id>:<message id>" so reply/moderate can find the channel again.
 */

const API = "https://discord.com/api/v10";
/** First second of 2015, the start of Discord snowflake time. */
export const DISCORD_EPOCH_MS = 1420070400000;

/** Channel types (API v9+). Forum/media channels hold only threads, so they are read through their active threads. */
export const CHANNEL_TYPES = { GUILD_TEXT: 0, GUILD_ANNOUNCEMENT: 5, ANNOUNCEMENT_THREAD: 10, PUBLIC_THREAD: 11, PRIVATE_THREAD: 12, GUILD_FORUM: 15, GUILD_MEDIA: 16 } as const;
const LISTED_TYPES = new Set<number>([CHANNEL_TYPES.GUILD_TEXT, CHANNEL_TYPES.GUILD_ANNOUNCEMENT, CHANNEL_TYPES.GUILD_FORUM, CHANNEL_TYPES.GUILD_MEDIA]);
const POLLED_TYPES = new Set<number>([CHANNEL_TYPES.GUILD_TEXT, CHANNEL_TYPES.GUILD_ANNOUNCEMENT]);

/** Message types people write: DEFAULT (0) and REPLY (19). Everything else (joins, pins, boosts, thread starters, command echoes) is system noise. */
const USER_MESSAGE_TYPES = new Set<number>([0, 19]);

/** Permission bits. */
const PERM = { ADMINISTRATOR: 1n << 3n, VIEW_CHANNEL: 1n << 10n, READ_MESSAGE_HISTORY: 1n << 16n } as const;

/** Application flags that say the Message Content intent is on (full, or "limited" for unverified apps under 100 servers). */
const APP_FLAG_MESSAGE_CONTENT = 1 << 18;
const APP_FLAG_MESSAGE_CONTENT_LIMITED = 1 << 19;

/** Message limits: 2000 characters, 10 files. */
const LIMITS = { text: 2000, files: 10, uploadBytes: 10 * 1024 * 1024 } as const;

const INTENT_HELP = "turn on the Message Content Intent (Developer Portal → your application → Bot → Privileged Gateway Intents) and connect again";

// TODO(verify): Discord does not document a token format; three dot-separated base64url parts is what tokens look like today.
export const DiscordBotAuth = z.object({
  botToken: z.string().regex(/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/, "not a Discord bot token"),
  guildId: z.string().regex(/^\d{15,25}$/).optional(),
});
export type DiscordBotAuth = z.infer<typeof DiscordBotAuth>;

export interface DiscordChannelRef {
  id: string;
  name: string;
  type: number;
}

export interface DiscordBotConfig {
  guildId: string;
  botId: string;
  botUsername: string;
  channels: DiscordChannelRef[];
  defaultChannelId: string | null;
}

/** Fields of Discord's Message we read. */
export interface DiscordApiMessage {
  id: string;
  channel_id: string;
  type: number;
  content: string;
  timestamp: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  webhook_id?: string;
  mentions?: { id: string }[];
  attachments?: { id: string; filename: string }[];
  embeds?: unknown[];
  sticker_items?: { name: string }[];
  /** type 0 = DEFAULT (reply), 1 = FORWARD. */
  message_reference?: { type?: number; message_id?: string; channel_id?: string; guild_id?: string };
  referenced_message?: DiscordApiMessage | null;
}

interface DiscordChannel {
  id: string;
  type: number;
  name?: string;
  position?: number;
  parent_id?: string | null;
  last_message_id?: string | null;
  permission_overwrites?: { id: string; type: number; allow: string; deny: string }[];
}

interface DiscordGuild {
  id: string;
  name: string;
  owner_id?: string;
  roles?: { id: string; permissions: string }[];
  approximate_member_count?: number;
  approximate_presence_count?: number;
}

interface DiscordFailure {
  status: number;
  code?: number;
  retryAfter?: number;
}

/** Snowflake whose timestamp part is `d`: every message created after `d` has a larger id. */
export function snowflakeFromDate(d: Date): string {
  const ms = Math.max(0, d.getTime() - DISCORD_EPOCH_MS);
  return (BigInt(ms) << 22n).toString();
}

function maxSnowflake(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return BigInt(a) >= BigInt(b) ? a : b;
}

export function discordMessageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** HTTP → ConnectorError. Built only from status and Discord's JSON body, never from the request: the token stays out. */
export function mapDiscordBotError(status: number, headers: Headers, body: unknown, what: string): ConnectorError {
  const b = (body ?? {}) as { message?: string; code?: number; retry_after?: number; global?: boolean; errors?: unknown };
  const detail = [b.message, b.code !== undefined ? `(code ${b.code})` : null, b.errors ? JSON.stringify(b.errors).slice(0, 300) : null].filter(Boolean).join(" ");
  const msg = `discord ${what}: HTTP ${status}${detail ? ` ${detail}` : ""}`;
  const cause: DiscordFailure = { status, ...(b.code !== undefined ? { code: b.code } : {}) };
  if (status === 429) {
    const after = retryAfterOf(headers, body);
    return new ConnectorError(`${msg}; retry after ${after ?? "?"}s${b.global ? " (global)" : ""}`, "rate_limit", true, { ...cause, ...(after !== null ? { retryAfter: after } : {}) });
  }
  if (status === 401) return new ConnectorError(`${msg} (bot token rejected; reset it under Developer Portal → Bot and reconnect)`, "auth", false, cause);
  if (status === 403) {
    // 50001 Missing Access: the bot cannot see the channel/server. 50013 Missing Permissions: it can see but lacks a permission.
    const hint = b.code === 50013 ? " (the bot lacks a permission for this; check its role)" : " (the bot cannot see this channel or server)";
    return new ConnectorError(`${msg}${hint}`, "auth", false, cause);
  }
  if (status >= 500) return new ConnectorError(msg, "network", true, cause);
  if (status >= 400) return new ConnectorError(msg, "rejected", false, cause);
  return new ConnectorError(msg, "unknown", false, cause);
}

function retryAfterOf(headers: Headers, body: unknown): number | null {
  const b = (body ?? {}) as { retry_after?: number };
  const after = typeof b.retry_after === "number" ? b.retry_after : Number(headers.get("x-ratelimit-reset-after") ?? headers.get("retry-after") ?? NaN);
  return Number.isFinite(after) ? after : null;
}

function failureOf(err: unknown): DiscordFailure | undefined {
  return err instanceof ConnectorError ? (err.cause as DiscordFailure | undefined) : undefined;
}

/** Effective permissions of the bot in a channel: base (roles) then @everyone, role and member overwrites. */
export function channelPermissions(p: { guild: DiscordGuild; botId: string; memberRoles: string[]; channel: DiscordChannel }): bigint {
  const all = (1n << 53n) - 1n;
  if (p.guild.owner_id === p.botId) return all;
  const roles = new Map((p.guild.roles ?? []).map((r) => [r.id, BigInt(r.permissions)]));
  let perms = roles.get(p.guild.id) ?? 0n;
  for (const r of p.memberRoles) perms |= roles.get(r) ?? 0n;
  if (perms & PERM.ADMINISTRATOR) return all;
  const ow = p.channel.permission_overwrites ?? [];
  const everyone = ow.find((o) => o.id === p.guild.id);
  if (everyone) perms = (perms & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of ow) {
    if (o.type === 0 && o.id !== p.guild.id && p.memberRoles.includes(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  }
  perms = (perms & ~deny) | allow;
  const member = ow.find((o) => o.type === 1 && o.id === p.botId);
  if (member) perms = (perms & ~BigInt(member.deny)) | BigInt(member.allow);
  return perms;
}

function textOf(m: DiscordApiMessage): string | null {
  if (m.content) return m.content;
  const files = (m.attachments ?? []).map((a) => `[attachment: ${a.filename}]`);
  const stickers = (m.sticker_items ?? []).map((s) => `[sticker: ${s.name}]`);
  const parts = [...files, ...stickers];
  return parts.length > 0 ? parts.join(" ") : null;
}

/** A user message whose content came back blank although it is not a sticker/file/embed: the Message Content intent is off. */
function looksIntentStripped(m: DiscordApiMessage, botId: string): boolean {
  if (!USER_MESSAGE_TYPES.has(m.type) || m.author.id === botId) return false;
  if ((m.mentions ?? []).some((u) => u.id === botId)) return false; // mentions of the bot keep their content
  return !m.content && (m.attachments ?? []).length === 0 && (m.embeds ?? []).length === 0 && (m.sticker_items ?? []).length === 0;
}

/**
 * One message → activity, or null for the bot's own messages and system messages. Kinds: "reply" when it answers a
 * message by the bot, "mention" when it mentions the bot, otherwise "message".
 */
export function discordMessageToActivity(m: DiscordApiMessage, ctx: { guildId: string; botId: string; conversationName: string }): ActivityInput | null {
  if (!USER_MESSAGE_TYPES.has(m.type)) return null;
  if (m.author.id === ctx.botId) return null;
  const ref = m.message_reference;
  const isReply = !!ref?.message_id && (ref.type ?? 0) === 0;
  let kind: ActivityKind = "message";
  if (isReply && m.referenced_message?.author.id === ctx.botId) kind = "reply";
  else if ((m.mentions ?? []).some((u) => u.id === ctx.botId) || new RegExp(`<@!?${ctx.botId}>`).test(m.content)) kind = "mention";
  return {
    network: "discord",
    kind,
    externalId: `${m.channel_id}:${m.id}`,
    authorHandle: m.author.username,
    authorName: m.author.global_name ?? null,
    text: textOf(m),
    url: discordMessageUrl(ctx.guildId, m.channel_id, m.id),
    parentExternalId: isReply ? `${ref.channel_id ?? m.channel_id}:${ref.message_id}` : null,
    occurredAt: new Date(m.timestamp).toISOString(),
    conversation: { id: m.channel_id, name: ctx.conversationName, type: "channel" },
    raw: m,
  };
}

export function parseDiscordMessageId(id: string, defaultChannel: string | null): { channelId: string; messageId: string } {
  const i = id.lastIndexOf(":");
  const channelId = i > 0 ? id.slice(0, i) : defaultChannel;
  const messageId = i > 0 ? id.slice(i + 1) : id;
  if (!channelId || !/^\d+$/.test(channelId) || !/^\d+$/.test(messageId)) throw new ConnectorError(`discord: "${id}" is not a <channel id>:<message id>`, "rejected", false);
  return { channelId, messageId };
}

export interface DiscordBotConnectorOptions {
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Pages of 100 messages read per channel per poll. */
  maxPages?: number;
  /** Active forum/channel threads polled per poll (most recently active first). */
  maxThreads?: number;
  /** Longest `retry_after` honored inside a call (once) before giving up with a rate_limit error. */
  maxRetryWaitMs?: number;
}

export class DiscordBotConnector implements Connector {
  readonly name = "discord_bot";
  readonly networks: readonly Network[] = ["discord"];
  readonly connectMethod = "bot_token" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [
    { key: "botToken", label: "Bot token (Developer Portal → Bot → Reset Token)", placeholder: "MTIz...abc.Gh1234.xyz...", secret: true },
    { key: "guildId", label: "Server ID (right-click the server → Copy Server ID)", placeholder: "123456789012345678" },
    { key: "defaultChannelId", label: "Channel ID for posts (optional; default: first text channel)", placeholder: "234567890123456789" },
  ] as const;
  media?: MediaFetcher;

  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxPages: number;
  private readonly maxThreads: number;
  private readonly maxRetryWaitMs: number;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  /** "<account id>:<channel id>" → newest message id seen (process-local). */
  private readonly cursors = new Map<string, string>();

  constructor(opts: DiscordBotConnectorOptions = {}) {
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxPages = opts.maxPages ?? 3;
    this.maxThreads = opts.maxThreads ?? 10;
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? 5000;
  }

  capabilities(): ConnectorCapabilities {
    // Per-message reach is not exposed to bots; reactions are not mapped to post metrics yet.
    return { publish: true, fetchActivity: true, fetchMetrics: false, meteredReads: false, reply: true, moderate: true, accountMetrics: true, webhooks: false, video: true, kinds: ["post", "video", "carousel", "link"] };
  }

  // ---- connect --------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const raw = (p.inputs.botToken ?? "").trim().replace(/^Bot\s+/i, "");
    const parsed = DiscordBotAuth.safeParse({ botToken: raw });
    if (!parsed.success) throw new ConnectorError("discord: that does not look like a bot token (copy it from Developer Portal → your application → Bot → Reset Token)", "auth", false);
    const token = parsed.data.botToken;
    const guildId = (p.inputs.guildId ?? "").trim();
    if (!/^\d{15,25}$/.test(guildId)) throw new ConnectorError("discord: the server ID is a number like 123456789012345678 (turn on Developer Mode, right-click the server → Copy Server ID)", "rejected", false);

    const bot = await this.api<{ id: string; username: string; bot?: boolean }>(token, "GET", "/users/@me", "check bot token");
    if (bot.bot === false) throw new ConnectorError("discord: that token belongs to a user account; Starsign only connects bot tokens", "auth", false);

    let guild: DiscordGuild;
    try {
      guild = await this.api<DiscordGuild>(token, "GET", `/guilds/${guildId}?with_counts=true`, "read server");
    } catch (err) {
      const f = failureOf(err);
      if (f && (f.status === 403 || f.status === 404)) throw new ConnectorError(`discord: the bot ${bot.username} is not in server ${guildId}; invite it with the OAuth2 URL Generator (scope "bot") and try again`, "rejected", false, f);
      throw err;
    }

    await this.checkIntent(token);

    const all = await this.api<DiscordChannel[]>(token, "GET", `/guilds/${guildId}/channels`, "list channels");
    const memberRoles = await this.api<{ roles: string[] }>(token, "GET", `/guilds/${guildId}/members/${bot.id}`, "read bot member")
      .then((m) => m.roles)
      .catch(() => null); // TODO(verify): Get Guild Member for the bot itself does not need the Server Members intent.
    const readable = (c: DiscordChannel) => {
      if (memberRoles === null) return true; // unknown: keep it, polling skips 403s
      const perms = channelPermissions({ guild, botId: bot.id, memberRoles, channel: c });
      return (perms & PERM.VIEW_CHANNEL) !== 0n && (perms & PERM.READ_MESSAGE_HISTORY) !== 0n;
    };
    const channels: DiscordChannelRef[] = all
      .filter((c) => LISTED_TYPES.has(c.type) && readable(c))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((c) => ({ id: c.id, name: c.name ?? c.id, type: c.type }));
    if (channels.length === 0) throw new ConnectorError(`discord: the bot can read no text channels in ${guild.name}; give its role View Channels and Read Message History`, "rejected", false);

    const wanted = (p.inputs.defaultChannelId ?? "").trim();
    let defaultChannelId = channels.find((c) => c.type === CHANNEL_TYPES.GUILD_TEXT)?.id ?? null;
    if (wanted) {
      const c = channels.find((x) => x.id === wanted);
      if (!c || !POLLED_TYPES.has(c.type)) throw new ConnectorError(`discord: channel ${wanted} is not a text or announcement channel the bot can read in ${guild.name}`, "rejected", false);
      defaultChannelId = c.id;
    }

    if (defaultChannelId) await this.checkSampleContent(token, defaultChannelId, bot.id);

    const config: DiscordBotConfig = { guildId: guild.id, botId: bot.id, botUsername: bot.username, channels, defaultChannelId };
    return [{ network: "discord", identity: { externalId: guild.id, handle: guild.name, displayName: guild.name }, auth: { botToken: token, guildId: guild.id }, config: { ...config } }];
  }

  /** The application's flags say whether the Message Content intent is on. A failed lookup is not fatal. */
  private async checkIntent(token: string): Promise<void> {
    // TODO(verify): bots may call GET /applications/@me, and flags 1<<18 / 1<<19 are GATEWAY_MESSAGE_CONTENT(_LIMITED).
    const app = await this.api<{ flags?: number }>(token, "GET", "/applications/@me", "read application").catch(() => null);
    if (app && typeof app.flags === "number" && (app.flags & (APP_FLAG_MESSAGE_CONTENT | APP_FLAG_MESSAGE_CONTENT_LIMITED)) === 0) {
      throw new ConnectorError(`discord: the Message Content privileged intent is off, so Discord would send every message blank; ${INTENT_HELP}`, "rejected", false);
    }
  }

  /** Read the newest messages of one channel: if every user message came back blank, message content is being withheld. */
  private async checkSampleContent(token: string, channelId: string, botId: string): Promise<void> {
    const sample = await this.api<DiscordApiMessage[]>(token, "GET", `/channels/${channelId}/messages?limit=20`, "sample messages").catch(() => [] as DiscordApiMessage[]);
    const users = sample.filter((m) => USER_MESSAGE_TYPES.has(m.type) && m.author.id !== botId && !(m.mentions ?? []).some((u) => u.id === botId));
    if (users.length > 0 && users.every((m) => looksIntentStripped(m, botId))) {
      throw new ConnectorError(`discord: messages come back with empty content, which means the Message Content privileged intent is off; ${INTENT_HELP}`, "rejected", false);
    }
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const parsed = DiscordBotAuth.safeParse(auth);
    if (!parsed.success) throw new ConnectorError("discord: botToken is required", "auth", false);
    const { botToken, guildId } = parsed.data;
    if (guildId) {
      const g = await this.api<DiscordGuild>(botToken, "GET", `/guilds/${guildId}`, "read server");
      return { externalId: g.id, handle: g.name, displayName: g.name };
    }
    const bot = await this.api<{ id: string; username: string; global_name?: string | null }>(botToken, "GET", "/users/@me", "check bot token");
    return { externalId: bot.id, handle: bot.username, displayName: bot.global_name ?? null };
  }

  // ---- publish --------------------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if ([...input.text].length > LIMITS.text) issues.push({ code: "too_long", message: `discord messages are at most ${LIMITS.text} characters`, segment: 0 });
    if (input.media.length > LIMITS.files) issues.push({ code: "too_many_media", message: `discord messages carry at most ${LIMITS.files} files` });
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "discord posts are single messages; put the whole text in one post" });
    if (!input.text.trim() && input.media.length === 0) issues.push({ code: "empty", message: "discord messages need text or a file" });
    for (const m of input.media) {
      // TODO(verify): 10 MiB is the default upload cap for servers without boosts; boosted servers allow more.
      if (m.bytes !== undefined && m.bytes > LIMITS.uploadBytes) issues.push({ code: "unsupported_media", message: `${m.url.split("/").pop()} is ${(m.bytes / 1048576).toFixed(1)} MiB; Discord accepts ${LIMITS.uploadBytes / 1048576} MiB per file on unboosted servers` });
    }
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const { botToken } = parseAuth(account);
      const cfg = configOf(account);
      const opts = input.options ?? {};
      let channelId: string;
      const payload: Record<string, unknown> = {
        content: input.text.slice(0, LIMITS.text),
        // Never ping @everyone/@here/roles/users from a scheduled post by accident.
        allowed_mentions: { parse: [] },
      };
      if (input.replyToExternalId) {
        const parent = parseDiscordMessageId(input.replyToExternalId, cfg.defaultChannelId);
        channelId = parent.channelId;
        payload.message_reference = { message_id: parent.messageId, channel_id: parent.channelId, guild_id: cfg.guildId, fail_if_not_exists: false };
        // Notify the person we answer (as Discord's own client does), but nobody else.
        payload.allowed_mentions = { parse: [], replied_user: true };
      } else {
        if (!cfg.defaultChannelId) throw new ConnectorError(`discord account ${account.handle}: no channel to post in; reconnect with a channel ID`, "rejected", false);
        channelId = cfg.defaultChannelId;
      }
      if (opts.link && !input.text.includes(opts.link)) {
        payload.embeds = [{ url: opts.link, title: (opts.title ?? opts.link).slice(0, 256), ...(opts.thumbnailUrl ? { thumbnail: { url: opts.thumbnailUrl } } : {}) }];
      }
      let body: string | FormData | StreamingForm;
      const media = input.media.slice(0, LIMITS.files);
      // Videos and documents are opened for streaming; when any is, the multipart body is streamed with an exact
      // Content-Length instead of being assembled in memory.
      const files: MediaReader[] = [];
      let msg: DiscordApiMessage;
      try {
        if (media.length > 0) {
          for (const m of media) files.push(await openForUpload(mediaSource(this.media, this.fetchImpl), m));
          payload.attachments = media.map((m, i) => ({ id: i, filename: fileName(m, files[i]!.mime, i), ...(m.alt ? { description: m.alt.slice(0, 1024) } : {}) }));
          const form = uploadForm(files);
          form.set("payload_json", JSON.stringify(payload));
          media.forEach((m, i) => setMediaFile(form, `files[${i}]`, files[i]!, fileName(m, files[i]!.mime, i)));
          body = form;
        } else {
          body = JSON.stringify(payload);
        }
        msg = await this.api<DiscordApiMessage>(botToken, "POST", `/channels/${channelId}/messages`, input.replyToExternalId ? "reply" : "create message", body);
      } finally {
        for (const f of files) await f.close();
      }
      if (!msg?.id) throw new ConnectorError("discord publish: response carried no message id", "unknown", false, msg);
      return { externalId: `${msg.channel_id ?? channelId}:${msg.id}`, url: discordMessageUrl(cfg.guildId, msg.channel_id ?? channelId, msg.id), raw: msg };
    });
  }

  // ---- engage ---------------------------------------------------------------------------

  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.publish(account, { variantId: input.idempotencyKey, text: input.text, media: [], thread: [], replyToExternalId: input.parentExternalId, idempotencyKey: input.idempotencyKey, options: {} });
  }

  /** delete (needs Manage Messages for other people's messages) and like/unlike as a 👍 reaction. Discord has no hide. */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    const { botToken } = parseAuth(account);
    const { channelId, messageId } = parseDiscordMessageId(input.externalId, configOf(account).defaultChannelId);
    if (input.action === "delete") {
      try {
        await this.api(botToken, "DELETE", `/channels/${channelId}/messages/${messageId}`, "delete message");
      } catch (err) {
        const f = failureOf(err);
        if (f?.status === 403) throw new ConnectorError("discord delete message: the bot needs the Manage Messages permission in this channel to delete other people's messages", "auth", false, f);
        throw err;
      }
      return;
    }
    if (input.action === "like" || input.action === "unlike") {
      await this.api(botToken, input.action === "like" ? "PUT" : "DELETE", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent("👍")}/@me`, input.action === "like" ? "add reaction" : "remove reaction");
      return;
    }
    throw new ConnectorError(`discord moderate: ${input.action} is not possible on Discord (delete the message instead)`, "rejected", false);
  }

  // ---- listen ---------------------------------------------------------------------------

  /**
   * Poll each text/announcement channel and the most recently active threads of the configured channels, at most
   * `maxPages` pages of 100 per channel. A channel the bot lost access to (403/404) is skipped. When a rate limit
   * outlasts the one bounded wait, the items read so far are returned (their cursors advanced) and the rest waits for
   * the next poll; if nothing was read yet the rate_limit error is thrown.
   */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const { botToken } = parseAuth(account);
    const cfg = configOf(account);
    const targets: { id: string; name: string }[] = cfg.channels.filter((c) => POLLED_TYPES.has(c.type)).map((c) => ({ id: c.id, name: `#${c.name}` }));
    const out: ActivityInput[] = [];
    try {
      targets.push(...(await this.activeThreads(botToken, cfg)));
    } catch (err) {
      if (failureOf(err)?.status === 401) throw err;
      // Threads are best-effort; channels still get polled.
    }
    for (const t of targets) {
      let messages: DiscordApiMessage[];
      try {
        messages = await this.readChannel(botToken, account.id, t.id, since);
      } catch (err) {
        const f = failureOf(err);
        if (f && (f.status === 403 || f.status === 404)) continue; // Missing Access / Unknown Channel: skip, keep going
        if (err instanceof ConnectorError && err.kind === "rate_limit" && out.length > 0) break;
        throw err;
      }
      for (const m of messages) {
        const item = discordMessageToActivity(m, { guildId: cfg.guildId, botId: cfg.botId, conversationName: t.name });
        if (item) out.push(item);
      }
    }
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  /** Active threads whose parent is a configured channel (forum posts live here), most recently active first. */
  private async activeThreads(token: string, cfg: DiscordBotConfig): Promise<{ id: string; name: string }[]> {
    if (this.maxThreads <= 0) return [];
    const parents = new Map(cfg.channels.map((c) => [c.id, c.name]));
    const res = await this.api<{ threads?: DiscordChannel[] }>(token, "GET", `/guilds/${cfg.guildId}/threads/active`, "list active threads");
    return (res.threads ?? [])
      .filter((t) => t.parent_id && parents.has(t.parent_id) && (t.type === CHANNEL_TYPES.PUBLIC_THREAD || t.type === CHANNEL_TYPES.ANNOUNCEMENT_THREAD))
      .sort((a, b) => (BigInt(b.last_message_id ?? b.id) > BigInt(a.last_message_id ?? a.id) ? 1 : -1))
      .slice(0, this.maxThreads)
      .map((t) => ({ id: t.id, name: `#${parents.get(t.parent_id!)} › ${t.name ?? t.id}` }));
  }

  /**
   * Messages newer than the channel's cursor (or than `since`), oldest first, paging forward with `after`. The order
   * inside a page does not matter: the next `after` is the largest id seen. Without cursor or `since`, only the newest page.
   */
  private async readChannel(token: string, accountId: string, channelId: string, since: Date | null): Promise<DiscordApiMessage[]> {
    const key = `${accountId}:${channelId}`;
    let after = maxSnowflake(this.cursors.get(key), since ? snowflakeFromDate(since) : null);
    const seen: DiscordApiMessage[] = [];
    for (let page = 0; page < this.maxPages; page++) {
      const q = after ? `after=${after}&limit=100` : "limit=100";
      // TODO(verify): with `after`, Discord returns the 100 messages right after it (sorted newest first); paging uses the max id, so order is not relied on.
      const batch = await this.api<DiscordApiMessage[]>(token, "GET", `/channels/${channelId}/messages?${q}`, "read messages");
      if (!Array.isArray(batch) || batch.length === 0) break;
      seen.push(...batch);
      let top: string | null = null;
      for (const m of batch) top = maxSnowflake(top, m.id);
      if (!top || (after && BigInt(top) <= BigInt(after))) break; // no progress: stop rather than loop
      after = top;
      if (batch.length < 100) break;
    }
    if (after) this.cursors.set(key, after);
    return seen.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
  }

  // ---- measure --------------------------------------------------------------------------

  /** Bots get no per-message views; reactions are not mapped to post metrics. */
  async fetchMetrics(): Promise<MetricInput[]> {
    return [];
  }

  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const { botToken } = parseAuth(account);
    const g = await this.api<DiscordGuild>(botToken, "GET", `/guilds/${configOf(account).guildId}?with_counts=true`, "read server");
    if (typeof g.approximate_member_count !== "number") return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: g.approximate_member_count, observedAt: this.now().toISOString(), source: "discord" }];
  }

  // ---- transport ------------------------------------------------------------------------

  private async api<T>(token: string, method: string, path: string, what: string, body?: string | FormData | StreamingForm): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bot ${token}`, "user-agent": "DiscordBot (https://starsign.app, 1)" };
    if (typeof body === "string") headers["content-type"] = "application/json";
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        // A StreamingForm opens a fresh stream for each attempt.
        res = await sendBody(resolveFetch(this.fetchImpl), `${API}${path}`, { method, headers }, body);
      } catch (err) {
        throw asNetworkError(err instanceof Error ? new Error(err.message.replaceAll(token, "<token>")) : new Error(String(err).replaceAll(token, "<token>")), `discord ${what}`);
      }
      const json = await readJson(res);
      if (res.ok) return json as T;
      // Route-level limit: wait once when Discord asks for a short pause, otherwise hand it to the scheduler.
      if (res.status === 429 && attempt === 0) {
        const after = retryAfterOf(res.headers, json);
        if (after !== null && after * 1000 <= this.maxRetryWaitMs) {
          await this.sleep(Math.ceil(after * 1000));
          continue;
        }
      }
      throw mapDiscordBotError(res.status, res.headers, json, what);
    }
  }
}

function fileName(m: Media, mime: string, i: number): string {
  const fromUrl = m.url.split("?")[0]?.split("/").pop();
  return fromUrl && /^[\w.-]+\.[a-z0-9]{2,5}$/i.test(fromUrl) ? fromUrl : `file${i}.${mime.split("/")[1] ?? "bin"}`;
}

function parseAuth(account: AccountRef): DiscordBotAuth {
  const parsed = DiscordBotAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`discord account ${account.handle}: auth blob needs botToken`, "auth", false);
  return parsed.data;
}

function configOf(account: AccountRef): DiscordBotConfig {
  const c = account.config as Partial<DiscordBotConfig>;
  const channels = Array.isArray(c.channels) ? c.channels.filter((x): x is DiscordChannelRef => !!x && typeof x.id === "string" && typeof x.type === "number").map((x) => ({ id: x.id, name: typeof x.name === "string" ? x.name : x.id, type: x.type })) : [];
  return {
    guildId: typeof c.guildId === "string" ? c.guildId : account.externalId,
    botId: typeof c.botId === "string" ? c.botId : "",
    botUsername: typeof c.botUsername === "string" ? c.botUsername : "",
    channels,
    defaultChannelId: typeof c.defaultChannelId === "string" ? c.defaultChannelId : null,
  };
}

export function createDiscordBotConnectors(_env: NodeJS.ProcessEnv): Connector[] {
  return [new DiscordBotConnector()];
}
