import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActivityInput, ActivityKind, Media, MetricInput, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource, rawBody, sendBody, withUpload } from "./media-io.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, ModerationInput, PublishInput, PublishResult, ValidationIssue, WebhookBatch, WebhookHandler } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Slack workspaces through an internal Slack app (Web API + Events API). The workspace admin creates an app at
 * api.slack.com/apps, installs it to the workspace only (no Slack Marketplace review), and pastes the Bot User OAuth
 * Token (xoxb-…) and the app's Signing Secret. One Starsign account = one workspace (externalId = team id).
 *
 * Listening, two ways:
 * - Events API: Slack POSTs to `${STARSIGN_PUBLIC_URL}/webhooks/slack?team=<team id>`, signed with the app's signing
 *   secret (`X-Slack-Signature: v0=hex(HMAC-SHA256(secret, "v0:{timestamp}:{raw body}"))`). The secret is per app,
 *   and every workspace has its own app, so the handler uses `route` + `verifyAccount`.
 *   The `url_verification` handshake has no team id in its body, hence `?team=` in the Request URL; its `challenge`
 *   is echoed back through `ack` (see `SlackConnector.webhook`).
 * - Polling fallback: `conversations.history` per watched channel with a per-channel cursor.
 *
 * External ids are "<channel id>:<message ts>" (a ts is unique only inside its channel).
 * Web API calls are form-encoded POSTs with the token in the Authorization header; Slack answers HTTP 200 with
 * `ok: false` and an `error` code for most failures.
 */

const API = "https://slack.com/api";

/** chat.postMessage truncates text past 40,000 characters; Slack recommends staying under 4,000. Up to 10 files per message. */
const LIMITS = { text: 40_000, files: 10, maxSkewSeconds: 300 } as const;

/** Message subtypes that are still a person speaking. Everything else (joins, topic changes, bot_message, edits, deletes) is skipped. */
const PERSON_SUBTYPES = new Set(["thread_broadcast", "file_share"]);

const CACHE_MAX = 5000;

export const SlackAuth = z.object({
  botToken: z.string().regex(/^xoxb-[A-Za-z0-9-]{10,}$/, "not a Slack bot token (xoxb-…)"),
  // TODO(verify): signing secrets are 32 hex characters today; only a minimum length is enforced.
  signingSecret: z.string().min(16).optional(),
});
export type SlackAuth = z.infer<typeof SlackAuth>;

export interface SlackChannelRef {
  id: string;
  name: string;
  isPrivate: boolean;
}

export interface SlackAccountConfig {
  teamId: string;
  teamName: string;
  /** "https://acme.slack.com/" from auth.test; used for permalinks. */
  teamUrl: string | null;
  botUserId: string;
  botId: string | null;
  /** Channels the bot is a member of at connect time. */
  channels: SlackChannelRef[];
  /** Channels polled; empty = every channel in `channels`. */
  watchChannelIds: string[];
  /** Where publish posts. */
  defaultChannelId: string | null;
  /** The Request URL to paste into Event Subscriptions (null when STARSIGN_PUBLIC_URL is unset). */
  eventsRequestUrl: string | null;
}

/** Fields of a Slack message (history item or `message` event) that we read. */
export interface SlackMessage {
  type?: string;
  subtype?: string;
  ts: string;
  thread_ts?: string;
  parent_user_id?: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  text?: string;
  channel?: string;
  channel_type?: "channel" | "group" | "im" | "mpim" | "app_home" | string;
  files?: { id?: string; name?: string; title?: string }[];
  user_profile?: { display_name?: string; real_name?: string };
  reply_count?: number;
  reactions?: { name: string; count: number }[];
}

export interface SlackEventEnvelope {
  type: "event_callback" | "url_verification" | "app_rate_limited" | string;
  token?: string;
  challenge?: string;
  team_id?: string;
  api_app_id?: string;
  event?: SlackMessage & { type: string; event_ts?: string };
  event_id?: string;
  event_time?: number;
  authorizations?: { team_id?: string; user_id?: string; is_bot?: boolean; enterprise_id?: string | null }[];
}

export interface SlackParseContext {
  botUserId: string | null;
  teamUrl?: string | null;
  channelName?(channelId: string): string | undefined;
  userName?(userId: string): string | undefined;
  /** True when "<channel>:<ts>" is a message this connector posted. */
  isOwnMessage?(externalId: string): boolean;
}

// ---- pure helpers -----------------------------------------------------------------------

function header(headers: Record<string, string>, name: string): string | undefined {
  const n = name.toLowerCase();
  return Object.entries(headers).find(([k]) => k.toLowerCase() === n)?.[1];
}

/**
 * Slack request signing (v0): hex HMAC-SHA256 of "v0:{X-Slack-Request-Timestamp}:{raw body}" with the signing secret,
 * compared in constant time with X-Slack-Signature. Requests older (or newer) than five minutes are refused.
 */
export function slackSignatureValid(signingSecret: string, headers: Record<string, string>, rawBody: string, nowMs: number): boolean {
  if (!signingSecret) return false;
  const ts = header(headers, "x-slack-request-timestamp");
  const sig = header(headers, "x-slack-signature");
  if (!ts || !sig || !/^\d+$/.test(ts) || !sig.startsWith("v0=")) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > LIMITS.maxSkewSeconds) return false;
  const want = Buffer.from(`v0=${createHmac("sha256", signingSecret).update(`v0:${ts}:${rawBody}`, "utf8").digest("hex")}`, "utf8");
  const got = Buffer.from(sig, "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** "1730881234.000200" → ISO time. */
export function slackTsToIso(ts: string): string {
  const n = Number(ts);
  return new Date(Number.isFinite(n) ? Math.round(n * 1000) : 0).toISOString();
}

/** Permalink built from the workspace URL (no API call): https://acme.slack.com/archives/C123/p1730881234000200. */
export function slackPermalink(teamUrl: string | null | undefined, channel: string, ts: string, threadTs?: string): string | null {
  if (!teamUrl) return null;
  const base = `${teamUrl.replace(/\/+$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
}

/** Escape &, <, > as Slack requires, then turn markdown-lite (**bold**, ~~strike~~, [text](url)) into mrkdwn. */
export function toMrkdwn(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t: string, u: string) => `<${u}|${t.replace(/\|/g, "¦")}>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/~~([^~\n]+)~~/g, "~$1~");
}

/** Readable text of a Slack message: user mentions/channel links kept as Slack sends them, files summarized. */
function messageText(m: SlackMessage): string | null {
  const files = (m.files ?? []).map((f) => `[file: ${f.name ?? f.title ?? f.id ?? "file"}]`);
  const text = (m.text ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const parts = [text, ...files].filter((s) => s.length > 0);
  return parts.length ? parts.join(" ") : null;
}

/** True for messages a person wrote (not bots, not system subtypes, not our own bot). */
export function isPersonMessage(m: SlackMessage, botUserId: string | null): boolean {
  if (m.subtype && !PERSON_SUBTYPES.has(m.subtype)) return false;
  if (m.bot_id || !m.user) return false;
  if (botUserId && m.user === botUserId) return false;
  return true;
}

/**
 * One Slack message → activity, or null when it is not a person's message. Kinds: "dm" in an im, "reply" when it
 * answers (in a thread) a message the bot posted, "mention" when it mentions the bot (or came as app_mention),
 * else "message". Conversation: channel for public/private channels, group for group DMs (mpim), direct for ims.
 */
export function slackMessageToActivity(m: SlackMessage, channel: string, channelType: string | undefined, ctx: SlackParseContext, opts: { isAppMention?: boolean; raw?: unknown } = {}): ActivityInput | null {
  if (!isPersonMessage(m, ctx.botUserId)) return null;
  const externalId = `${channel}:${m.ts}`;
  const inThread = !!m.thread_ts && m.thread_ts !== m.ts;
  const parentExternalId = inThread ? `${channel}:${m.thread_ts}` : null;
  const authorName = m.user ? (ctx.userName?.(m.user) ?? m.user_profile?.display_name ?? m.user_profile?.real_name ?? null) : null;
  const mentionsBot = opts.isAppMention === true || (!!ctx.botUserId && (m.text ?? "").includes(`<@${ctx.botUserId}`));
  const repliesToBot = inThread && ((!!ctx.botUserId && m.parent_user_id === ctx.botUserId) || ctx.isOwnMessage?.(parentExternalId!) === true);
  const isIm = channelType === "im" || (!channelType && channel.startsWith("D"));
  let kind: ActivityKind = isIm ? "dm" : "message";
  if (repliesToBot) kind = "reply";
  else if (mentionsBot && !isIm) kind = "mention";
  const conversationType = isIm ? "direct" : channelType === "mpim" ? "group" : "channel";
  const chName = ctx.channelName?.(channel);
  const conversationName = isIm ? authorName : chName ? (conversationType === "channel" ? `#${chName}` : chName) : null;
  return {
    network: "slack",
    kind,
    externalId,
    authorHandle: m.user ?? null,
    authorName,
    text: messageText(m),
    url: slackPermalink(ctx.teamUrl, channel, m.ts, m.thread_ts),
    parentExternalId,
    occurredAt: slackTsToIso(m.ts),
    raw: opts.raw ?? m,
    conversation: { id: channel, name: conversationName, type: conversationType },
  };
}

/** One Events API delivery → activities. message and app_mention events only. */
export function slackEnvelopeToActivities(env: SlackEventEnvelope, ctx: SlackParseContext): ActivityInput[] {
  if (env.type !== "event_callback" || !env.event) return [];
  const e = env.event;
  const botUserId = ctx.botUserId ?? env.authorizations?.find((a) => a.is_bot)?.user_id ?? null;
  const c = { ...ctx, botUserId };
  if (!e.channel || !e.ts) return [];
  if (e.type === "message") {
    const item = slackMessageToActivity(e, e.channel, e.channel_type, c, { raw: env });
    return item ? [item] : [];
  }
  if (e.type === "app_mention") {
    const item = slackMessageToActivity(e, e.channel, e.channel_type ?? (e.channel.startsWith("G") ? "group" : "channel"), c, { isAppMention: true, raw: env });
    return item ? [item] : [];
  }
  return [];
}

/** Which workspace a delivery claims to be for (unverified): `?team=` first, then the body. */
export function slackRouteTeam(rawBody: string, query: Record<string, string>): string | null {
  const q = query.team ?? query.team_id;
  if (q && /^[TE][A-Z0-9]{4,}$/.test(q)) return q;
  if (!rawBody) return null;
  try {
    const b = JSON.parse(rawBody) as SlackEventEnvelope & { team?: { id?: string } };
    const t = b.team_id ?? b.authorizations?.[0]?.team_id ?? b.team?.id;
    return typeof t === "string" && t ? t : null;
  } catch {
    return null;
  }
}

export function parseSlackMessageId(id: string, defaultChannel?: string | null): { channel: string; ts: string } {
  const i = id.lastIndexOf(":");
  const channel = i > 0 ? id.slice(0, i) : (defaultChannel ?? "");
  const ts = i > 0 ? id.slice(i + 1) : id;
  if (!/^[CDG][A-Z0-9]{4,}$/.test(channel) || !/^\d+\.\d+$/.test(ts)) throw new ConnectorError(`slack: "${id}" is not a "<channel id>:<message ts>"`, "rejected", false);
  return { channel, ts };
}

// ---- errors -----------------------------------------------------------------------------

const AUTH_ERRORS = new Set(["not_authed", "invalid_auth", "account_inactive", "token_revoked", "token_expired", "no_permission", "missing_scope", "not_allowed_token_type", "ekm_access_denied", "team_access_not_granted"]);
const RETRYABLE_ERRORS = new Set(["internal_error", "fatal_error", "service_unavailable", "request_timeout", "ratelimited"]);

interface SlackFailure {
  status: number;
  error?: string;
  needed?: string;
  retryAfter?: number;
}

/** HTTP status / Slack error code → ConnectorError. Built from the response only, never the request (the token stays out). */
export function mapSlackError(status: number, headers: Headers, body: unknown, what: string): ConnectorError {
  const b = (body && typeof body === "object" ? body : {}) as { error?: string; needed?: string; provided?: string; response_metadata?: { messages?: string[] } };
  const code = b.error;
  const detail = [code, b.needed ? `(needs scope ${b.needed})` : null, b.response_metadata?.messages?.slice(0, 2).join("; ")].filter(Boolean).join(" ");
  const msg = `slack ${what}: ${detail || `HTTP ${status}`}`;
  const cause: SlackFailure = { status, ...(code ? { error: code } : {}), ...(b.needed ? { needed: b.needed } : {}) };
  if (status === 429 || code === "ratelimited") {
    const after = Number(headers.get("retry-after") ?? NaN);
    return new ConnectorError(`${msg} (rate limited; retry after ${Number.isFinite(after) ? after : "?"}s)`, "rate_limit", true, { ...cause, ...(Number.isFinite(after) ? { retryAfter: after } : {}) });
  }
  if (code === "missing_scope") return new ConnectorError(`${msg}; add the scope under OAuth & Permissions, reinstall the app and reconnect`, "auth", false, cause);
  if (code && AUTH_ERRORS.has(code)) return new ConnectorError(`${msg} (the bot token no longer works; reinstall the app and reconnect)`, "auth", false, cause);
  if (status === 401 || status === 403) return new ConnectorError(msg, "auth", false, cause);
  if (status >= 500 || (code && RETRYABLE_ERRORS.has(code))) return new ConnectorError(msg, "network", true, cause);
  if (code === "not_in_channel") return new ConnectorError(`${msg} (invite the app to the channel: /invite @your-app)`, "rejected", false, cause);
  if (status >= 400 || code) return new ConnectorError(msg, "rejected", false, cause);
  return new ConnectorError(msg, "unknown", false, cause);
}

function failureOf(err: unknown): SlackFailure | undefined {
  return err instanceof ConnectorError ? (err.cause as SlackFailure | undefined) : undefined;
}

// ---- connector --------------------------------------------------------------------------

export interface SlackConnectorOptions {
  apiBase?: string;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** STARSIGN_PUBLIC_URL, to tell the person the Events API Request URL at connect. */
  publicUrl?: string;
  /** Pages of history read per channel per poll (200 messages each). */
  maxPages?: number;
  /** Channels polled per poll. */
  maxChannels?: number;
  /** Longest Retry-After honored inside a call (once) before giving up with a rate_limit error. */
  maxRetryWaitMs?: number;
  /** users.info lookups per poll for author names. */
  maxNameLookups?: number;
  /** files.info polls after an upload to learn the message ts of the shared file. */
  fileSharePolls?: number;
}

class Bounded<K, V> extends Map<K, V> {
  constructor(private readonly cap = CACHE_MAX) {
    super();
  }
  override set(k: K, v: V): this {
    if (!this.has(k) && this.size >= this.cap) {
      const oldest = this.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    return super.set(k, v);
  }
}

interface TeamContext {
  botUserId: string;
  teamUrl: string | null;
  channels: Map<string, string>;
}

interface SlackFile {
  id: string;
  shares?: { public?: Record<string, { ts: string }[]>; private?: Record<string, { ts: string }[]> };
}

export class SlackConnector implements Connector {
  readonly name = "slack";
  readonly networks: readonly Network[] = ["slack"];
  readonly connectMethod = "bot_token" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [
    { key: "botToken", label: "Bot User OAuth Token (OAuth & Permissions)", placeholder: "xoxb-…", secret: true },
    { key: "signingSecret", label: "Signing Secret (Basic Information → App Credentials), for real-time events", placeholder: "32 hex characters", secret: true, optional: true },
    { key: "channelIds", label: "Channel IDs to watch, comma-separated; the first is where posts go (default: every channel the app is in)", placeholder: "C0123ABCD, C0456EFGH", optional: true },
  ] as const;
  media?: MediaFetcher;
  readonly webhook: WebhookHandler;

  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly publicUrl: string | undefined;
  private readonly maxPages: number;
  private readonly maxChannels: number;
  private readonly maxRetryWaitMs: number;
  private readonly maxNameLookups: number;
  private readonly fileSharePolls: number;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  /** "<account id>:<channel>" → newest ts seen (process-local). */
  private readonly cursors = new Map<string, string>();
  /** team id → what parse needs (bot user id, channel names), learned from accounts as they verify or poll. */
  private readonly teams = new Map<string, TeamContext>();
  /** "<team>|<user id>" → display name. */
  private readonly userNames = new Bounded<string, string>();
  /** "<channel>:<ts>" this process posted. */
  private readonly ownMessages = new Bounded<string, true>();
  /** "<channel>:<ts>" → thread root ts, so a reply to a thread reply lands in the right thread. */
  private readonly threadRoots = new Bounded<string, string>();
  constructor(opts: SlackConnectorOptions = {}) {
    this.apiBase = (opts.apiBase ?? API).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.publicUrl = opts.publicUrl?.replace(/\/+$/, "");
    this.maxPages = opts.maxPages ?? 3;
    this.maxChannels = opts.maxChannels ?? 50;
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? 5000;
    this.maxNameLookups = opts.maxNameLookups ?? 20;
    this.fileSharePolls = opts.fileSharePolls ?? 3;
    this.webhook = {
      // Never used: each workspace's app has its own signing secret, so route + verifyAccount take over.
      verify: () => false,
      route: (rawBody, query) => {
        const team = slackRouteTeam(rawBody, query);
        return team ? { network: "slack", accountExternalId: team } : null;
      },
      verifyAccount: (account, headers, rawBody) => this.verifyDelivery(account, headers, rawBody),
      parse: (body) => this.parseDelivery(body),
      /** Slack's url_verification: echo the `challenge` from the signed body. Events get core's default reply. */
      respond: (body) => {
        const b = body as { type?: unknown; challenge?: unknown } | null;
        return b && b.type === "url_verification" && typeof b.challenge === "string" ? { body: b.challenge, contentType: "text/plain" } : null;
      },
    };
  }

  capabilities(): ConnectorCapabilities {
    return { publish: true, fetchActivity: true, fetchMetrics: true, meteredReads: false, reply: true, moderate: true, accountMetrics: true, webhooks: true, video: true, kinds: ["post", "link", "carousel", "video"] };
  }

  // ---- connect --------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const signing = (p.inputs.signingSecret ?? "").trim();
    const parsed = SlackAuth.safeParse({ botToken: (p.inputs.botToken ?? "").trim(), ...(signing ? { signingSecret: signing } : {}) });
    if (!parsed.success) {
      const tokenBad = parsed.error.issues.some((i) => i.path[0] === "botToken");
      throw new ConnectorError(tokenBad ? "slack: paste the Bot User OAuth Token (starts with xoxb-) from your app's OAuth & Permissions page" : "slack: the signing secret looks too short (Basic Information → App Credentials → Signing Secret)", "auth", false);
    }
    const auth = parsed.data;
    const who = await this.api<{ url?: string; team?: string; team_id: string; user_id: string; bot_id?: string; enterprise_id?: string }>(auth.botToken, "auth.test", {}, "check token");
    if (!who.bot_id) throw new ConnectorError("slack: that token is not a bot token; use the Bot User OAuth Token (xoxb-…)", "auth", false);

    const channels = await this.listMemberChannels(auth.botToken);
    const wanted = (p.inputs.channelIds ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim().replace(/^#/, ""))
      .filter(Boolean);
    for (const id of wanted) {
      if (!channels.some((c) => c.id === id)) throw new ConnectorError(`slack: the app is not a member of channel ${id}; open the channel and run /invite @<your app name> (or check the ID: Channel details → bottom of the About tab)`, "rejected", false);
    }
    const defaultChannelId = wanted[0] ?? channels.find((c) => !c.isPrivate)?.id ?? channels[0]?.id ?? null;
    const teamName = who.team ?? who.team_id;
    const config: SlackAccountConfig = {
      teamId: who.team_id,
      teamName,
      teamUrl: who.url ?? null,
      botUserId: who.user_id,
      botId: who.bot_id ?? null,
      channels,
      watchChannelIds: wanted,
      defaultChannelId,
      eventsRequestUrl: this.publicUrl ? `${this.publicUrl}/webhooks/slack?team=${who.team_id}` : null,
    };
    this.remember(config);
    return [{ network: "slack", identity: { externalId: who.team_id, handle: teamName, displayName: teamName }, auth: { botToken: auth.botToken, ...(auth.signingSecret ? { signingSecret: auth.signingSecret } : {}) }, config: { ...config } }];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const token = typeof auth.botToken === "string" ? auth.botToken : "";
    if (!token) throw new ConnectorError("slack: botToken is required", "auth", false);
    const who = await this.api<{ team?: string; team_id: string }>(token, "auth.test", {}, "check token");
    return { externalId: who.team_id, handle: who.team ?? who.team_id, displayName: who.team ?? null };
  }

  /** Public and private channels the bot is a member of (conversations.list has no member filter: filter on is_member). */
  private async listMemberChannels(token: string): Promise<SlackChannelRef[]> {
    const out: SlackChannelRef[] = [];
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const r = await this.api<{ channels?: { id: string; name?: string; is_private?: boolean; is_member?: boolean; is_archived?: boolean }[]; response_metadata?: { next_cursor?: string } }>(
        token,
        "conversations.list",
        { types: "public_channel,private_channel", exclude_archived: "true", limit: "200", ...(cursor ? { cursor } : {}) },
        "list channels",
      );
      for (const c of r.channels ?? []) if (c.is_member && !c.is_archived) out.push({ id: c.id, name: c.name ?? c.id, isPrivate: c.is_private === true });
      cursor = r.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }
    return out;
  }

  private remember(cfg: Pick<SlackAccountConfig, "teamId" | "botUserId" | "teamUrl" | "channels">): void {
    if (!cfg.teamId || !cfg.botUserId) return;
    this.teams.set(cfg.teamId, { botUserId: cfg.botUserId, teamUrl: cfg.teamUrl, channels: new Map(cfg.channels.map((c) => [c.id, c.name])) });
  }

  private context(teamId: string | undefined): SlackParseContext {
    const t = teamId ? this.teams.get(teamId) : undefined;
    return {
      botUserId: t?.botUserId ?? null,
      teamUrl: t?.teamUrl ?? null,
      channelName: (id) => t?.channels.get(id),
      userName: (id) => (teamId ? this.userNames.get(`${teamId}|${id}`) : undefined),
      isOwnMessage: (id) => this.ownMessages.has(id),
    };
  }

  // ---- webhooks -------------------------------------------------------------------------

  private verifyDelivery(account: AccountRef, headers: Record<string, string>, rawBody: string): boolean {
    const secret = typeof account.auth?.signingSecret === "string" ? account.auth.signingSecret : "";
    const ok = slackSignatureValid(secret, headers, rawBody, this.now().getTime());
    if (ok) this.remember(configOf(account)); // gives the synchronous parse the bot id and channel names
    return ok;
  }

  private parseDelivery(body: unknown): WebhookBatch[] {
    const b = body as SlackEventEnvelope | null;
    if (!b || typeof b !== "object") return [];
    if (b.type === "url_verification") return []; // answered by respond()
    if (b.type !== "event_callback" || !b.team_id) return [];
    const items = slackEnvelopeToActivities(b, this.context(b.team_id));
    for (const i of items) this.rememberThread(i);
    return items.length ? [{ network: "slack", accountExternalId: b.team_id, items }] : [];
  }

  private rememberThread(item: ActivityInput): void {
    if (item.parentExternalId) this.threadRoots.set(item.externalId, item.parentExternalId.slice(item.parentExternalId.lastIndexOf(":") + 1));
  }

  // ---- publish --------------------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if ([...input.text].length > LIMITS.text) issues.push({ code: "too_long", message: `slack messages are at most ${LIMITS.text} characters`, segment: 0 });
    if (input.media.length > LIMITS.files) issues.push({ code: "too_many_media", message: `slack messages carry at most ${LIMITS.files} files` });
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "slack posts are single messages; put the whole text in one post" });
    if (!input.text.trim() && input.media.length === 0 && !input.options?.link) issues.push({ code: "empty", message: "slack messages need text or a file" });
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    if (input.replyToExternalId) return this.reply(account, { parentExternalId: input.replyToExternalId, text: input.text, idempotencyKey: input.idempotencyKey });
    return this.idempotency.run(input.idempotencyKey, async () => {
      const issues = this.validate(account, input);
      if (issues.length) throw new ConnectorError(`slack publish: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
      const { botToken } = parseAuth(account);
      const cfg = configOf(account);
      if (!cfg.defaultChannelId) throw new ConnectorError(`slack account ${account.handle}: no channel to post in; reconnect with a channel ID`, "rejected", false);
      const link = input.options?.link;
      const text = toMrkdwn(link && !input.text.includes(link) ? `${input.text}${input.text ? "\n" : ""}${link}` : input.text);
      if (input.media.length > 0) return this.publishFiles(botToken, cfg, cfg.defaultChannelId, text, input.media);
      return this.postMessage(botToken, cfg, cfg.defaultChannelId, text, null, "post message");
    });
  }

  private async postMessage(token: string, cfg: SlackAccountConfig, channel: string, text: string, threadTs: string | null, what: string): Promise<PublishResult> {
    const r = await this.api<{ channel: string; ts: string; message?: unknown }>(token, "chat.postMessage", { channel, text, mrkdwn: "true", unfurl_links: "true", unfurl_media: "true", ...(threadTs ? { thread_ts: threadTs } : {}) }, what);
    const ch = r.channel ?? channel;
    const externalId = `${ch}:${r.ts}`;
    this.ownMessages.set(externalId, true);
    if (threadTs) this.threadRoots.set(externalId, threadTs);
    return { externalId, url: slackPermalink(cfg.teamUrl, ch, r.ts, threadTs ?? undefined), raw: r };
  }

  /**
   * Current upload flow (files.upload was retired in 2025): files.getUploadURLExternal per file, POST the bytes to
   * the returned URL, then one files.completeUploadExternal that shares every file into the channel with the text as
   * initial_comment. The message ts arrives with the file's `shares`, sometimes only after a moment, so files.info is
   * polled a few times; when it is still unknown the externalId names the file instead ("<channel>:file:<id>").
   */
  private async publishFiles(token: string, cfg: SlackAccountConfig, channel: string, text: string, media: Media[], threadTs?: string): Promise<PublishResult> {
    const uploaded: { id: string; title: string }[] = [];
    for (const [i, m] of media.slice(0, LIMITS.files).entries()) {
      // Videos and documents are sent as a streamed body with an exact Content-Length; images are read whole.
      await withUpload(mediaSource(this.media, this.fetchImpl), m, async (file) => {
        const mime = file.mime;
        const filename = fileName(m, mime, i);
        const u = await this.api<{ upload_url: string; file_id: string }>(token, "files.getUploadURLExternal", { filename, length: String(file.size), ...(m.alt ? { alt_txt: m.alt.slice(0, 1000) } : {}) }, "get upload URL");
        // TODO(verify): the upload URL takes the raw bytes (or multipart) in a POST and needs no Authorization header.
        let res: Response;
        try {
          res = await sendBody(resolveFetch(this.fetchImpl), u.upload_url, { method: "POST", headers: { "content-type": mime } }, rawBody(file));
        } catch (err) {
          throw asNetworkError(err, "slack upload file");
        }
        if (!res.ok) throw mapSlackError(res.status, res.headers, await readJson(res), "upload file");
        uploaded.push({ id: u.file_id, title: m.alt?.slice(0, 250) || filename });
      });
    }
    const done = await this.api<{ files?: SlackFile[] }>(
      token,
      "files.completeUploadExternal",
      { files: JSON.stringify(uploaded), channel_id: channel, ...(text ? { initial_comment: text } : {}), ...(threadTs ? { thread_ts: threadTs } : {}) },
      "complete upload",
    );
    const first = uploaded[0]!.id;
    let ts = shareTs(done.files?.find((f) => f.id === first), channel);
    for (let i = 0; !ts && i < this.fileSharePolls; i++) {
      await this.sleep(1000);
      const info = await this.api<{ file?: SlackFile }>(token, "files.info", { file: first }, "read file").catch(() => null);
      ts = shareTs(info?.file, channel);
    }
    const fileIds = uploaded.map((f) => f.id);
    if (!ts) return { externalId: `${channel}:file:${first}`, url: null, raw: { files: done.files, fileIds, shareTsUnknown: true } };
    const externalId = `${channel}:${ts}`;
    this.ownMessages.set(externalId, true);
    return { externalId, url: slackPermalink(cfg.teamUrl, channel, ts, threadTs), raw: { files: done.files, fileIds } };
  }

  // ---- engage ---------------------------------------------------------------------------

  /** chat.postMessage into the parent's thread (thread_ts = the thread's root, even when the parent is itself a reply). */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.idempotency.run(`reply:${input.idempotencyKey}`, async () => {
      const { channel, ts } = parseSlackMessageId(input.parentExternalId);
      if (!input.text.trim()) throw new ConnectorError("slack reply: text is empty", "rejected", false);
      if ([...input.text].length > LIMITS.text) throw new ConnectorError(`slack reply: messages are at most ${LIMITS.text} characters`, "rejected", false);
      const { botToken } = parseAuth(account);
      const root = this.threadRoots.get(input.parentExternalId) ?? ts;
      return this.postMessage(botToken, configOf(account), channel, toMrkdwn(input.text), root, "reply");
    });
  }

  /** like/unlike = 👍 (thumbsup) reaction; delete = chat.delete (a bot token deletes only the app's own messages). No hide. */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    const { botToken } = parseAuth(account);
    const { channel, ts } = parseSlackMessageId(input.externalId);
    if (input.action === "like" || input.action === "unlike") {
      try {
        await this.api(botToken, input.action === "like" ? "reactions.add" : "reactions.remove", { channel, timestamp: ts, name: "thumbsup" }, input.action === "like" ? "add reaction" : "remove reaction");
      } catch (err) {
        const code = failureOf(err)?.error;
        if ((input.action === "like" && code === "already_reacted") || (input.action === "unlike" && code === "no_reaction")) return;
        throw err;
      }
      return;
    }
    if (input.action === "delete") {
      try {
        await this.api(botToken, "chat.delete", { channel, ts }, "delete message");
      } catch (err) {
        const code = failureOf(err)?.error;
        if (code === "message_not_found") return; // already gone
        if (code === "cant_delete_message") throw new ConnectorError("slack delete message: a bot can only delete messages the app posted", "rejected", false, failureOf(err));
        throw err;
      }
      return;
    }
    throw new ConnectorError(`slack moderate: ${input.action} is not possible through the Slack API`, "rejected", false);
  }

  // ---- listen ---------------------------------------------------------------------------

  /**
   * Polling fallback: conversations.history for each watched channel since its cursor (or `since`), newest page
   * first and following `response_metadata.next_cursor`, at most `maxPages` pages of 200. Top-level messages and
   * thread broadcasts only (thread replies come through the Events API). A channel the bot left is skipped. A rate
   * limit that outlasts the one bounded wait returns what was read so far (cursors advanced only for finished channels).
   */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const { botToken } = parseAuth(account);
    const cfg = configOf(account);
    this.remember(cfg);
    const ctx = this.context(cfg.teamId);
    const ids = (cfg.watchChannelIds.length ? cfg.watchChannelIds : cfg.channels.map((c) => c.id)).slice(0, this.maxChannels);
    const out: ActivityInput[] = [];
    for (const channel of ids) {
      let messages: SlackMessage[];
      try {
        messages = await this.readChannel(botToken, account.id, channel, since);
      } catch (err) {
        const code = failureOf(err)?.error;
        if (code === "not_in_channel" || code === "channel_not_found" || code === "is_archived") continue;
        if (err instanceof ConnectorError && err.kind === "rate_limit" && out.length > 0) break;
        throw err;
      }
      const type = channel.startsWith("D") ? "im" : cfg.channels.find((c) => c.id === channel)?.isPrivate ? "group" : "channel";
      for (const m of messages) {
        const item = slackMessageToActivity(m, channel, type, ctx);
        if (item) out.push(item);
      }
    }
    await this.resolveNames(botToken, cfg.teamId, out);
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  private async readChannel(token: string, accountId: string, channel: string, since: Date | null): Promise<SlackMessage[]> {
    const key = `${accountId}:${channel}`;
    const sinceTs = since ? (since.getTime() / 1000).toFixed(6) : null;
    const cur = this.cursors.get(key) ?? null;
    const oldest = maxTs(cur, sinceTs);
    const seen: SlackMessage[] = [];
    let cursor = "";
    for (let page = 0; page < this.maxPages; page++) {
      const r = await this.api<{ messages?: SlackMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(
        token,
        "conversations.history",
        { channel, limit: "200", inclusive: "false", ...(oldest ? { oldest } : {}), ...(cursor ? { cursor } : {}) },
        "read history",
      );
      seen.push(...(r.messages ?? []));
      cursor = r.response_metadata?.next_cursor ?? "";
      if (!oldest || !r.has_more || !cursor) break; // without a lower bound only the newest page is read
    }
    let top = cur;
    for (const m of seen) top = maxTs(top, m.ts);
    if (top) this.cursors.set(key, top);
    return seen.filter((m) => !oldest || Number(m.ts) > Number(oldest));
  }

  /** users.info for authors without a cached name, bounded per poll; failures (missing users:read) leave names null. */
  private async resolveNames(token: string, teamId: string, items: ActivityInput[]): Promise<void> {
    const missing = [...new Set(items.filter((i) => i.authorHandle && !i.authorName).map((i) => i.authorHandle!))].filter((u) => !this.userNames.has(`${teamId}|${u}`));
    for (const user of missing.slice(0, this.maxNameLookups)) {
      const r = await this.api<{ user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } }>(token, "users.info", { user }, "read user").catch(() => null);
      if (!r) break;
      const name = r.user?.profile?.display_name || r.user?.profile?.real_name || r.user?.real_name || r.user?.name;
      if (name) this.userNames.set(`${teamId}|${user}`, name);
    }
    for (const i of items) {
      if (i.authorHandle && !i.authorName) {
        const n = this.userNames.get(`${teamId}|${i.authorHandle}`) ?? null;
        i.authorName = n;
        if (i.kind === "dm" && i.conversation) i.conversation.name = n;
      }
    }
  }

  // ---- measure --------------------------------------------------------------------------

  /** Reactions (→ likes) and thread replies (→ replies) on the app's own messages, via reactions.get. Slack has no views. */
  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    const { botToken } = parseAuth(account);
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    for (const id of externalIds) {
      let ref: { channel: string; ts: string };
      try {
        ref = parseSlackMessageId(id);
      } catch {
        continue; // e.g. "<channel>:file:<id>" whose ts never became known
      }
      const r = await this.api<{ message?: SlackMessage }>(botToken, "reactions.get", { channel: ref.channel, timestamp: ref.ts, full: "true" }, "read reactions").catch((err) => {
        if (err instanceof ConnectorError && (err.kind === "auth" || err.kind === "rate_limit")) throw err;
        return null;
      });
      if (!r?.message) continue;
      const likes = (r.message.reactions ?? []).reduce((n, x) => n + (x.count ?? 0), 0);
      out.push({ entityType: "post_variant", entityId: id, metric: "likes", value: likes, observedAt, source: "slack" });
      out.push({ entityType: "post_variant", entityId: id, metric: "replies", value: r.message.reply_count ?? 0, observedAt, source: "slack" });
    }
    return out;
  }

  /** followers_total = members of the default channel (conversations.info include_num_members). */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const { botToken } = parseAuth(account);
    const channel = configOf(account).defaultChannelId;
    if (!channel) return [];
    const r = await this.api<{ channel?: { num_members?: number } }>(botToken, "conversations.info", { channel, include_num_members: "true" }, "read channel");
    const n = r.channel?.num_members;
    if (typeof n !== "number") return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: n, observedAt: this.now().toISOString(), source: "slack" }];
  }

  // ---- transport ------------------------------------------------------------------------

  /** Form-encoded POST to a Web API method. 429: wait once when Retry-After is short, otherwise a rate_limit error. */
  private async api<T>(token: string, method: string, params: Record<string, string>, what: string): Promise<T> {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded; charset=utf-8" };
    const body = new URLSearchParams(params).toString();
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await resolveFetch(this.fetchImpl)(`${this.apiBase}/${method}`, { method: "POST", headers, body });
      } catch (err) {
        throw asNetworkError(err instanceof Error ? new Error(err.message.replaceAll(token, "<token>")) : new Error(String(err).replaceAll(token, "<token>")), `slack ${what}`);
      }
      const json = (await readJson(res)) as { ok?: boolean } | undefined;
      if (res.status === 429 && attempt === 0) {
        const after = Number(res.headers.get("retry-after") ?? NaN);
        if (Number.isFinite(after) && after * 1000 <= this.maxRetryWaitMs) {
          await this.sleep(Math.ceil(after * 1000));
          continue;
        }
      }
      if (res.ok && json && typeof json === "object" && json.ok === true) return json as T;
      throw mapSlackError(res.status, res.headers, json, what);
    }
  }
}

function maxTs(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Number(a) >= Number(b) ? a : b;
}

function shareTs(file: SlackFile | undefined, channel: string): string | null {
  const s = file?.shares;
  return s?.public?.[channel]?.[0]?.ts ?? s?.private?.[channel]?.[0]?.ts ?? null;
}

function fileName(m: Media, mime: string, i: number): string {
  const fromUrl = m.url.split("?")[0]?.split("/").pop();
  return fromUrl && /^[\w.-]+\.[a-z0-9]{2,5}$/i.test(fromUrl) ? fromUrl : `file${i}.${mime.split("/")[1] ?? "bin"}`;
}

function parseAuth(account: AccountRef): SlackAuth {
  const parsed = SlackAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`slack account ${account.handle}: auth blob needs botToken`, "auth", false);
  return parsed.data;
}

function configOf(account: AccountRef): SlackAccountConfig {
  const c = account.config as Partial<SlackAccountConfig>;
  const channels = Array.isArray(c.channels) ? c.channels.filter((x): x is SlackChannelRef => !!x && typeof x.id === "string").map((x) => ({ id: x.id, name: typeof x.name === "string" ? x.name : x.id, isPrivate: x.isPrivate === true })) : [];
  return {
    teamId: typeof c.teamId === "string" ? c.teamId : account.externalId,
    teamName: typeof c.teamName === "string" ? c.teamName : account.handle,
    teamUrl: typeof c.teamUrl === "string" ? c.teamUrl : null,
    botUserId: typeof c.botUserId === "string" ? c.botUserId : "",
    botId: typeof c.botId === "string" ? c.botId : null,
    channels,
    watchChannelIds: Array.isArray(c.watchChannelIds) ? c.watchChannelIds.filter((x): x is string => typeof x === "string") : [],
    defaultChannelId: typeof c.defaultChannelId === "string" ? c.defaultChannelId : null,
    eventsRequestUrl: typeof c.eventsRequestUrl === "string" ? c.eventsRequestUrl : null,
  };
}

export function createSlackConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [new SlackConnector({ ...(env.SLACK_API_BASE ? { apiBase: env.SLACK_API_BASE } : {}), ...(env.STARSIGN_PUBLIC_URL ? { publicUrl: env.STARSIGN_PUBLIC_URL } : {}) })];
}
