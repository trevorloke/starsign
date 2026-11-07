import { createHash } from "node:crypto";
import type { ActivityInput, ActivityKind, Media, MetricInput, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { isStreamBody, mediaSource, rawBody, sendBody, withUpload, type StreamBody } from "./media-io.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, ModerationInput, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Matrix rooms through the Client-Server API (v3) of any homeserver. A person connects a (preferably dedicated)
 * Matrix account with an access token, or with user + password once (the password is used for /login and never
 * stored). One Starsign account = one Matrix user (externalId = the MXID, "@starsign:example.org", which already
 * names the homeserver).
 *
 * Listening is polling /sync with the `next_batch` token kept in memory per account and a filter limited to the
 * watched rooms and message events. End-to-end encrypted rooms cannot be read without an E2EE device (Olm/Megolm
 * keys): their m.room.encrypted events are counted and skipped.
 *
 * External ids are "<room id>:<event id>" ("!abc:example.org:$evt"): the split point is the last ":$".
 */

const CLIENT = "/_matrix/client/v3";
/** Events are capped at 65,536 bytes as JSON; leave room for the envelope. NETWORK_LIMITS says 30,000 characters. */
const LIMITS = { text: 30_000, eventBytes: 60_000, media: 1 } as const;
const CACHE_MAX = 5000;

export const MatrixAuth = z.object({
  homeserver: z.string().url(),
  accessToken: z.string().min(8),
  userId: z.string().regex(/^@[^:\s]+:.+$/),
  deviceId: z.string().optional(),
});
export type MatrixAuth = z.infer<typeof MatrixAuth>;

export interface MatrixRoomRef {
  id: string;
  alias: string | null;
  name: string | null;
  encrypted: boolean;
}

export interface MatrixAccountConfig {
  homeserver: string;
  userId: string;
  displayName: string | null;
  rooms: MatrixRoomRef[];
  defaultRoomId: string | null;
}

/** Fields of a room event we read. */
export interface MatrixEvent {
  type: string;
  event_id: string;
  sender: string;
  origin_server_ts: number;
  state_key?: string;
  content: {
    msgtype?: string;
    body?: string;
    format?: string;
    formatted_body?: string;
    name?: string;
    displayname?: string;
    membership?: string;
    url?: string;
    "m.mentions"?: { user_ids?: string[]; room?: boolean };
    "m.relates_to"?: { rel_type?: string; event_id?: string; key?: string; "m.in_reply_to"?: { event_id?: string } };
    "m.new_content"?: unknown;
    [k: string]: unknown;
  };
  unsigned?: { redacted_because?: unknown; transaction_id?: string };
}

interface JoinedRoom {
  timeline?: { events?: MatrixEvent[]; limited?: boolean; prev_batch?: string };
  state?: { events?: MatrixEvent[] };
  summary?: { "m.joined_member_count"?: number; "m.heroes"?: string[] };
}

export interface MatrixSyncResponse {
  next_batch: string;
  rooms?: { join?: Record<string, JoinedRoom> };
  account_data?: { events?: { type: string; content: Record<string, unknown> }[] };
}

export interface MatrixParseContext {
  userId: string;
  displayName?: string | null;
  roomName?(roomId: string): string | null | undefined;
  memberName?(roomId: string, userId: string): string | null | undefined;
  isDirect?(roomId: string): boolean;
  isOwnEvent?(externalId: string): boolean;
}

// ---- pure helpers -----------------------------------------------------------------------

/** Transaction id derived from Starsign's idempotency key: the homeserver dedupes sends with the same txnId per device. */
export function matrixTxnId(idempotencyKey: string): string {
  return `starsign-${createHash("sha256").update(`starsign:matrix:${idempotencyKey}`).digest("hex").slice(0, 32)}`;
}

export function matrixExternalId(roomId: string, eventId: string): string {
  return `${roomId}:${eventId}`;
}

export function parseMatrixExternalId(id: string): { roomId: string; eventId: string } {
  const i = id.lastIndexOf(":$");
  const roomId = i > 0 ? id.slice(0, i) : "";
  const eventId = i > 0 ? id.slice(i + 1) : "";
  if (!roomId.startsWith("!") || !eventId.startsWith("$")) throw new ConnectorError(`matrix: "${id}" is not a "<room id>:<event id>"`, "rejected", false);
  return { roomId, eventId };
}

/** Old clients prefix replies with "> <@user> quoted…" lines and a blank line (removed from the spec in v1.13): drop them. */
export function stripReplyFallback(body: string): string {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith(">")) i++;
  if (i === 0) return body;
  if (lines[i] === "") i++;
  return lines.slice(i).join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Markdown-lite → Matrix HTML (org.matrix.custom.html): **bold**, *italic* / _italic_, `code`, [text](url), bare
 * URLs and line breaks. Returns null when the text has no formatting (then only `body` is sent).
 */
export function markdownLiteToHtml(text: string): string | null {
  if (!/(\*\*[^*]+\*\*|(^|\W)[*_][^*_\n]+[*_](\W|$)|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/.test(text)) return null;
  let html = escapeHtml(text);
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => `<a href="${u}">${t}</a>`);
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, "$1<em>$2</em>");
  html = html.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, "$1<em>$2</em>");
  return html.replace(/\n/g, "<br>");
}

/** Plain body for the markdown-lite text: links as "text (url)", markers removed. */
export function markdownLiteToPlain(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}

function messageText(e: MatrixEvent): string {
  const c = e.content;
  const body = typeof c.body === "string" ? c.body : "";
  switch (c.msgtype) {
    case "m.image":
      return `[Image${body ? `: ${body}` : ""}]`;
    case "m.video":
      return `[Video${body ? `: ${body}` : ""}]`;
    case "m.audio":
      return `[Audio${body ? `: ${body}` : ""}]`;
    case "m.file":
      return `[File${body ? `: ${body}` : ""}]`;
    case "m.location":
      return `[Location${body ? `: ${body}` : ""}]`;
    default:
      return c["m.relates_to"]?.["m.in_reply_to"] ? stripReplyFallback(body) : body;
  }
}

/** True when the message mentions the user: m.mentions (Matrix 1.7+), else the MXID or display name in the body. */
export function mentionsUser(e: MatrixEvent, userId: string, displayName?: string | null): boolean {
  const m = e.content["m.mentions"];
  if (m && typeof m === "object") return Array.isArray(m.user_ids) && m.user_ids.includes(userId);
  const body = typeof e.content.body === "string" ? e.content.body : "";
  if (body.includes(userId)) return true;
  if (displayName && displayName.length >= 2) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "iu");
    return re.test(body);
  }
  return false;
}

/**
 * One timeline event → activity, or null. Kept: m.room.message from other users that is not an edit (m.replace),
 * not redacted and not an m.notice (the msgtype bots use). Kinds: "reply" for a reply (m.in_reply_to) to this
 * account's message (known from this process's sends, or because the reply mentions the account, as Matrix replies
 * do), "mention" when it mentions the account, "dm" in a direct room, else "message".
 */
export function matrixEventToActivity(roomId: string, e: MatrixEvent, ctx: MatrixParseContext): ActivityInput | null {
  if (e.type !== "m.room.message" || e.sender === ctx.userId) return null;
  const c = e.content ?? {};
  if (typeof c.body !== "string" || e.unsigned?.redacted_because) return null;
  if (c["m.relates_to"]?.rel_type === "m.replace" || c.msgtype === "m.notice") return null;
  const replyTo = c["m.relates_to"]?.["m.in_reply_to"]?.event_id;
  const parentExternalId = replyTo ? matrixExternalId(roomId, replyTo) : null;
  const direct = ctx.isDirect?.(roomId) === true;
  const mentioned = mentionsUser(e, ctx.userId, ctx.displayName);
  let kind: ActivityKind = direct ? "dm" : "message";
  if (parentExternalId && (ctx.isOwnEvent?.(parentExternalId) === true || mentioned)) kind = "reply";
  else if (mentioned && !direct) kind = "mention";
  const authorName = ctx.memberName?.(roomId, e.sender) ?? null;
  const roomName = ctx.roomName?.(roomId) ?? null;
  return {
    network: "matrix",
    kind,
    externalId: matrixExternalId(roomId, e.event_id),
    authorHandle: e.sender,
    authorName,
    text: messageText(e),
    url: `https://matrix.to/#/${encodeURIComponent(roomId)}/${encodeURIComponent(e.event_id)}`,
    parentExternalId,
    occurredAt: new Date(Number.isFinite(e.origin_server_ts) ? e.origin_server_ts : 0).toISOString(),
    raw: e,
    conversation: { id: roomId, name: direct ? (roomName ?? authorName) : roomName, type: direct ? "direct" : "group" },
  };
}

/** The /sync filter: only the watched rooms, only message (and encrypted, to count them) events, no presence/receipts. */
export function matrixSyncFilter(roomIds: string[], timelineLimit = 50): Record<string, unknown> {
  return {
    presence: { not_types: ["*"] },
    account_data: { types: ["m.direct"] },
    room: {
      rooms: roomIds,
      timeline: { types: ["m.room.message", "m.room.encrypted"], limit: timelineLimit },
      state: { types: ["m.room.name", "m.room.member"], lazy_load_members: true },
      ephemeral: { not_types: ["*"] },
      account_data: { not_types: ["*"] },
    },
  };
}

// ---- errors -----------------------------------------------------------------------------

interface MatrixFailure {
  status: number;
  errcode?: string;
  retryAfterMs?: number;
}

/** HTTP + Matrix errcode → ConnectorError. Built from the response only (the token never appears). */
export function mapMatrixError(status: number, headers: Headers, body: unknown, what: string): ConnectorError {
  const b = (body && typeof body === "object" ? body : {}) as { errcode?: string; error?: string; retry_after_ms?: number; soft_logout?: boolean };
  const msg = `matrix ${what}: ${[b.errcode, b.error].filter(Boolean).join(" ") || `HTTP ${status}`}`;
  const cause: MatrixFailure = { status, ...(b.errcode ? { errcode: b.errcode } : {}) };
  if (status === 429 || b.errcode === "M_LIMIT_EXCEEDED") {
    const header = Number(headers.get("retry-after") ?? NaN);
    const ms = typeof b.retry_after_ms === "number" ? b.retry_after_ms : Number.isFinite(header) ? header * 1000 : undefined;
    return new ConnectorError(`${msg} (rate limited${ms !== undefined ? `; retry after ${Math.ceil(ms / 1000)}s` : ""})`, "rate_limit", true, { ...cause, ...(ms !== undefined ? { retryAfterMs: ms } : {}) });
  }
  if (status === 401 || b.errcode === "M_UNKNOWN_TOKEN" || b.errcode === "M_MISSING_TOKEN") return new ConnectorError(`${msg} (the access token no longer works; reconnect the account)`, "auth", false, cause);
  if (b.errcode === "M_USER_DEACTIVATED") return new ConnectorError(msg, "auth", false, cause);
  // M_FORBIDDEN on a room action means "not allowed here" (power level, not joined), not a bad token.
  if (status === 403) return new ConnectorError(msg, "rejected", false, cause);
  if (status >= 500) return new ConnectorError(msg, "network", true, cause);
  if (status >= 400) return new ConnectorError(msg, "rejected", false, cause);
  return new ConnectorError(msg, "unknown", false, cause);
}

function failureOf(err: unknown): MatrixFailure | undefined {
  return err instanceof ConnectorError ? (err.cause as MatrixFailure | undefined) : undefined;
}

// ---- connector --------------------------------------------------------------------------

export interface MatrixConnectorOptions {
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Timeline events per room per sync. */
  timelineLimit?: number;
  maxRetryWaitMs?: number;
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

export interface MatrixSyncStats {
  messages: number;
  encryptedSkipped: number;
  limitedRooms: string[];
}

export class MatrixConnector implements Connector {
  readonly name = "matrix";
  readonly networks: readonly Network[] = ["matrix"];
  readonly connectMethod = "api_key" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [
    { key: "homeserver", label: "Homeserver URL (or your server name)", placeholder: "https://matrix.example.org" },
    { key: "accessToken", label: "Access token (Element: Settings → Help & About → Access token)", placeholder: "syt_…", secret: true, optional: true },
    { key: "user", label: "Or: user name / MXID (logs in once; the password is not stored)", placeholder: "@starsign:example.org", optional: true },
    { key: "password", label: "Password (only with a user name)", secret: true, optional: true },
    { key: "rooms", label: "Rooms to watch: room IDs or aliases, comma-separated; the first is where posts go (default: every joined room)", placeholder: "#community:example.org, !abcdef:example.org", optional: true },
  ] as const;
  media?: MediaFetcher;

  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timelineLimit: number;
  private readonly maxRetryWaitMs: number;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  /** account id → /sync next_batch (process-local; a restart falls back to `since`). */
  private readonly nextBatch = new Map<string, string>();
  /** account id → room ids marked direct in m.direct. */
  private readonly directRooms = new Map<string, Set<string>>();
  /** "<room>" → name, "<room>|<user>" → display name, from sync state. */
  private readonly roomNames = new Bounded<string, string>();
  private readonly memberNames = new Bounded<string, string>();
  /** externalIds this process sent, and sender of events seen (for reply mentions). */
  private readonly ownEvents = new Bounded<string, true>();
  private readonly senders = new Bounded<string, string>();
  /** account id → numbers from the latest sync (encrypted events skipped, rooms with a gap). */
  readonly lastSync = new Map<string, MatrixSyncStats>();

  constructor(opts: MatrixConnectorOptions = {}) {
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timelineLimit = opts.timelineLimit ?? 50;
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? 5000;
  }

  capabilities(): ConnectorCapabilities {
    return { publish: true, fetchActivity: true, fetchMetrics: false, meteredReads: false, reply: true, moderate: true, accountMetrics: true, webhooks: false, video: true, kinds: ["post", "link"] };
  }

  // ---- connect --------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const homeserver = await this.resolveHomeserver((p.inputs.homeserver ?? "").trim());
    let accessToken = (p.inputs.accessToken ?? "").trim();
    let deviceId: string | undefined;
    if (!accessToken) {
      const user = (p.inputs.user ?? "").trim();
      const password = p.inputs.password ?? "";
      if (!user || !password) throw new ConnectorError("matrix: paste an access token, or a user name and password", "auth", false);
      const login = await this.call<{ access_token: string; user_id: string; device_id?: string }>(homeserver, null, "POST", `${CLIENT}/login`, "log in", {
        type: "m.login.password",
        identifier: { type: "m.id.user", user },
        password,
        initial_device_display_name: "Starsign",
      }).catch((err) => {
        // 403 M_FORBIDDEN on /login is a wrong user or password.
        if (failureOf(err)?.status === 403) throw new ConnectorError("matrix: the homeserver refused that user name and password", "auth", false, failureOf(err));
        throw err;
      });
      accessToken = login.access_token;
      deviceId = login.device_id;
    }
    const who = await this.call<{ user_id: string; device_id?: string; is_guest?: boolean }>(homeserver, accessToken, "GET", `${CLIENT}/account/whoami`, "check token");
    if (who.is_guest) throw new ConnectorError("matrix: guest accounts cannot be connected", "auth", false);
    deviceId = deviceId ?? who.device_id;
    const displayName = await this.call<{ displayname?: string }>(homeserver, accessToken, "GET", `${CLIENT}/profile/${encodeURIComponent(who.user_id)}/displayname`, "read profile")
      .then((r) => r.displayname ?? null)
      .catch(() => null);

    const joined = new Set((await this.call<{ joined_rooms: string[] }>(homeserver, accessToken, "GET", `${CLIENT}/joined_rooms`, "list rooms")).joined_rooms ?? []);
    const wanted = (p.inputs.rooms ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const rooms: MatrixRoomRef[] = [];
    if (wanted.length) {
      for (const w of wanted) {
        let roomId = w;
        let alias: string | null = null;
        if (w.startsWith("#")) {
          alias = w;
          const d = await this.call<{ room_id: string }>(homeserver, accessToken, "GET", `${CLIENT}/directory/room/${encodeURIComponent(w)}`, "resolve alias").catch((err) => {
            if (failureOf(err)?.status === 404) throw new ConnectorError(`matrix: no room has the alias ${w}`, "rejected", false, failureOf(err));
            throw err;
          });
          roomId = d.room_id;
        } else if (!w.startsWith("!")) {
          throw new ConnectorError(`matrix: "${w}" is neither a room ID (!…) nor an alias (#…)`, "rejected", false);
        }
        if (!joined.has(roomId)) {
          // The person named this room: accept a pending invite / join a public room. Anything else is refused.
          await this.call(homeserver, accessToken, "POST", `${CLIENT}/join/${encodeURIComponent(alias ?? roomId)}`, "join room", {}).catch((err) => {
            throw new ConnectorError(`matrix: ${who.user_id} is not in ${w} and could not join it; invite the account first (${err instanceof Error ? err.message : String(err)})`, "rejected", false, failureOf(err));
          });
          joined.add(roomId);
        }
        rooms.push({ id: roomId, alias, name: null, encrypted: false });
      }
    } else {
      for (const id of [...joined].slice(0, 50)) rooms.push({ id, alias: null, name: null, encrypted: false });
    }
    if (rooms.length === 0) throw new ConnectorError(`matrix: ${who.user_id} is in no rooms; invite it to the rooms to watch, or list them`, "rejected", false);
    for (const r of rooms) {
      r.name = await this.call<{ name?: string }>(homeserver, accessToken, "GET", `${CLIENT}/rooms/${encodeURIComponent(r.id)}/state/m.room.name/`, "read room name")
        .then((x) => x.name ?? null)
        .catch(() => null);
      r.encrypted = await this.call(homeserver, accessToken, "GET", `${CLIENT}/rooms/${encodeURIComponent(r.id)}/state/m.room.encryption/`, "read room encryption")
        .then(() => true)
        .catch(() => false);
      if (r.name) this.roomNames.set(r.id, r.name);
    }
    const config: MatrixAccountConfig = { homeserver, userId: who.user_id, displayName, rooms, defaultRoomId: rooms.find((r) => !r.encrypted)?.id ?? null };
    return [{ network: "matrix", identity: { externalId: who.user_id, handle: who.user_id, displayName }, auth: { homeserver, accessToken, userId: who.user_id, ...(deviceId ? { deviceId } : {}) }, config: { ...config } }];
  }

  /** "example.org" or "https://example.org": try /.well-known/matrix/client, else use the URL as given. */
  private async resolveHomeserver(input: string): Promise<string> {
    if (!input) throw new ConnectorError("matrix: the homeserver URL is required", "rejected", false);
    const url = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ConnectorError(`matrix: "${input}" is not a homeserver URL`, "rejected", false);
    }
    if (parsed.protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)) throw new ConnectorError("matrix: the homeserver must use https", "rejected", false);
    const origin = parsed.origin;
    try {
      const res = await resolveFetch(this.fetchImpl)(`${origin}/.well-known/matrix/client`, { method: "GET" });
      if (res.ok) {
        const wk = (await readJson(res)) as { "m.homeserver"?: { base_url?: string } } | undefined;
        const base = wk?.["m.homeserver"]?.base_url;
        if (typeof base === "string" && /^https:\/\//i.test(base)) return base.replace(/\/+$/, "");
      }
    } catch {
      // no well-known: use what was typed
    }
    return `${origin}${parsed.pathname.replace(/\/+$/, "")}`;
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const parsed = MatrixAuth.safeParse(auth);
    if (!parsed.success) throw new ConnectorError("matrix: auth needs homeserver, accessToken and userId", "auth", false);
    const who = await this.call<{ user_id: string }>(parsed.data.homeserver, parsed.data.accessToken, "GET", `${CLIENT}/account/whoami`, "check token");
    return { externalId: who.user_id, handle: who.user_id, displayName: null };
  }

  // ---- listen ---------------------------------------------------------------------------

  /**
   * One /sync (timeout=0) from the account's stored next_batch. Without one (first poll, or after a restart) the
   * filter's timeline limit gives the latest events per room and `since` drops the older ones. Rooms with a gap
   * (`limited`) are recorded in `lastSync`; their missed events are not back-filled.
   */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const cfg = configOf(account);
    for (const r of cfg.rooms) if (r.name && !this.roomNames.has(r.id)) this.roomNames.set(r.id, r.name);
    const roomIds = cfg.rooms.map((r) => r.id);
    if (roomIds.length === 0) return [];
    const token = this.nextBatch.get(account.id);
    const q = new URLSearchParams({ timeout: "0", filter: JSON.stringify(matrixSyncFilter(roomIds, this.timelineLimit)) });
    if (token) q.set("since", token);
    const sync = await this.call<MatrixSyncResponse>(auth.homeserver, auth.accessToken, "GET", `${CLIENT}/sync?${q.toString()}`, "sync");
    const direct = this.directRooms.get(account.id) ?? new Set<string>();
    for (const ev of sync.account_data?.events ?? []) {
      if (ev.type !== "m.direct") continue;
      direct.clear();
      for (const ids of Object.values(ev.content)) if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") direct.add(id);
    }
    this.directRooms.set(account.id, direct);

    const stats: MatrixSyncStats = { messages: 0, encryptedSkipped: 0, limitedRooms: [] };
    const out: ActivityInput[] = [];
    const watched = new Set(roomIds);
    for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
      if (!watched.has(roomId)) continue;
      const events = [...(room.state?.events ?? []), ...(room.timeline?.events ?? [])];
      for (const ev of events) this.learnState(roomId, ev);
      if (room.timeline?.limited && token) stats.limitedRooms.push(roomId);
      for (const ev of room.timeline?.events ?? []) {
        this.senders.set(matrixExternalId(roomId, ev.event_id), ev.sender);
        if (ev.type === "m.room.encrypted") {
          stats.encryptedSkipped++;
          continue;
        }
        if (!token && since && ev.origin_server_ts <= since.getTime()) continue;
        const item = matrixEventToActivity(roomId, ev, {
          userId: auth.userId,
          displayName: cfg.displayName,
          roomName: (id) => this.roomNames.get(id),
          memberName: (id, user) => this.memberNames.get(`${id}|${user}`),
          isDirect: (id) => direct.has(id),
          isOwnEvent: (id) => this.ownEvents.has(id),
        });
        if (item) {
          stats.messages++;
          out.push(item);
        }
      }
    }
    if (sync.next_batch) this.nextBatch.set(account.id, sync.next_batch);
    this.lastSync.set(account.id, stats);
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  private learnState(roomId: string, ev: MatrixEvent): void {
    if (ev.type === "m.room.name" && typeof ev.content?.name === "string" && ev.content.name) this.roomNames.set(roomId, ev.content.name);
    if (ev.type === "m.room.member" && ev.state_key && typeof ev.content?.displayname === "string" && ev.content.displayname) this.memberNames.set(`${roomId}|${ev.state_key}`, ev.content.displayname);
  }

  // ---- publish --------------------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if ([...input.text].length > LIMITS.text || Buffer.byteLength(input.text, "utf8") * 2 > LIMITS.eventBytes) issues.push({ code: "too_long", message: `matrix messages are at most ${LIMITS.text} characters (events are capped at 64 KB)`, segment: 0 });
    if (input.media.length > LIMITS.media) issues.push({ code: "too_many_media", message: "the matrix connector sends text plus one file" });
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "matrix posts are single messages; put the whole text in one post" });
    if (!input.text.trim() && input.media.length === 0 && !input.options?.link) issues.push({ code: "empty", message: "matrix messages need text or a file" });
    return issues;
  }

  /** m.text (with an HTML formatted_body when the text has markdown-lite) and then one m.image / m.video / m.file. */
  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    if (input.replyToExternalId) return this.reply(account, { parentExternalId: input.replyToExternalId, text: input.text, idempotencyKey: input.idempotencyKey });
    return this.idempotency.run(input.idempotencyKey, async () => {
      const issues = this.validate(account, input);
      if (issues.length) throw new ConnectorError(`matrix publish: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
      const auth = parseAuth(account);
      const roomId = configOf(account).defaultRoomId;
      if (!roomId) throw new ConnectorError(`matrix account ${account.handle}: no unencrypted room to post in; reconnect with a room`, "rejected", false);
      const link = input.options?.link;
      const text = link && !input.text.includes(link) ? `${input.text}${input.text ? "\n\n" : ""}${link}` : input.text;
      const ids: string[] = [];
      if (text.trim()) {
        const html = markdownLiteToHtml(text);
        // Empty m.mentions: a scheduled post never pings anyone by accident.
        const content: Record<string, unknown> = { msgtype: "m.text", body: html ? markdownLiteToPlain(text) : text, "m.mentions": {} };
        if (html) Object.assign(content, { format: "org.matrix.custom.html", formatted_body: html });
        ids.push(await this.send(auth, roomId, "m.room.message", content, matrixTxnId(`${input.idempotencyKey}:text`), "send message"));
      }
      for (const [i, m] of input.media.slice(0, LIMITS.media).entries()) {
        const content = await this.uploadContent(auth, m, i);
        ids.push(await this.send(auth, roomId, "m.room.message", content, matrixTxnId(`${input.idempotencyKey}:media:${i}`), "send file"));
      }
      const [first, ...rest] = ids.map((id) => matrixExternalId(roomId, id));
      for (const id of [first, ...rest]) if (id) this.ownEvents.set(id, true);
      return { externalId: first!, url: `https://matrix.to/#/${encodeURIComponent(roomId)}/${encodeURIComponent(ids[0]!)}`, ...(rest.length ? { threadExternalIds: rest } : {}), raw: { roomId, eventIds: ids } };
    });
  }

  /** POST /_matrix/media/v3/upload, then the m.image / m.video / m.audio / m.file content pointing at the mxc:// URI. */
  private async uploadContent(auth: MatrixAuth, m: Media, i: number): Promise<Record<string, unknown>> {
    // Videos and documents are sent as a streamed body with an exact Content-Length; images are read whole.
    const { up, mime, size, filename } = await withUpload(mediaSource(this.media, this.fetchImpl), m, async (file) => {
      const filename = fileName(m, file.mime, i);
      // TODO(verify): authenticated media (Matrix 1.11, MSC3916) moved download/thumbnail to /_matrix/client/v1/media/*;
      // upload is still /_matrix/media/v3/upload on current homeservers.
      const up = await this.call<{ content_uri: string }>(auth.homeserver, auth.accessToken, "POST", `/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`, "upload media", rawBody(file), file.mime);
      return { up, mime: file.mime, size: file.size, filename };
    });
    if (!up.content_uri?.startsWith("mxc://")) throw new ConnectorError("matrix upload media: no content_uri in the response", "unknown", false, up);
    const msgtype = m.kind === "video" ? "m.video" : mime.startsWith("image/") ? "m.image" : mime.startsWith("audio/") ? "m.audio" : "m.file";
    const info: Record<string, unknown> = { mimetype: mime, size };
    if (m.width) info.w = m.width;
    if (m.height) info.h = m.height;
    if (m.durationSeconds) info.duration = Math.round(m.durationSeconds * 1000);
    return { msgtype, body: m.alt?.trim() || filename, filename, url: up.content_uri, info, "m.mentions": {} };
  }

  // ---- engage ---------------------------------------------------------------------------

  /** m.text in the parent's room with m.relates_to.m.in_reply_to, mentioning the parent's sender (as Matrix replies do). */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.idempotency.run(`reply:${input.idempotencyKey}`, async () => {
      const { roomId, eventId } = parseMatrixExternalId(input.parentExternalId);
      if (!input.text.trim()) throw new ConnectorError("matrix reply: text is empty", "rejected", false);
      const auth = parseAuth(account);
      const sender = this.senders.get(input.parentExternalId);
      const html = markdownLiteToHtml(input.text);
      const content: Record<string, unknown> = {
        msgtype: "m.text",
        body: html ? markdownLiteToPlain(input.text) : input.text,
        "m.relates_to": { "m.in_reply_to": { event_id: eventId } },
        "m.mentions": sender && sender !== auth.userId ? { user_ids: [sender] } : {},
      };
      if (html) Object.assign(content, { format: "org.matrix.custom.html", formatted_body: html });
      const id = await this.send(auth, roomId, "m.room.message", content, matrixTxnId(`reply:${input.idempotencyKey}`), "reply");
      const externalId = matrixExternalId(roomId, id);
      this.ownEvents.set(externalId, true);
      return { externalId, url: `https://matrix.to/#/${encodeURIComponent(roomId)}/${encodeURIComponent(id)}`, raw: { roomId, eventId: id } };
    });
  }

  /**
   * like = m.reaction 👍 (m.annotation); unlike = redact this account's 👍 found through /relations; delete = redact
   * (other people's messages need a power level high enough to redact). No hide in Matrix.
   */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    const auth = parseAuth(account);
    const { roomId, eventId } = parseMatrixExternalId(input.externalId);
    if (input.action === "like") {
      await this.send(auth, roomId, "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key: "👍" } }, matrixTxnId(`like:${input.externalId}`), "react");
      return;
    }
    if (input.action === "unlike") {
      const rel = await this.call<{ chunk?: MatrixEvent[] }>(auth.homeserver, auth.accessToken, "GET", `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(eventId)}/m.annotation/m.reaction`, "read reactions");
      const mine = (rel.chunk ?? []).filter((e) => e.sender === auth.userId && e.content?.["m.relates_to"]?.key === "👍" && !e.unsigned?.redacted_because);
      for (const r of mine) await this.redact(auth, roomId, r.event_id, `unlike:${input.externalId}:${r.event_id}`);
      return;
    }
    if (input.action === "delete") {
      try {
        await this.redact(auth, roomId, eventId, `delete:${input.externalId}`);
      } catch (err) {
        if (failureOf(err)?.status === 403) throw new ConnectorError("matrix redact: this account may only redact its own messages here (raise its power level to moderate others)", "rejected", false, failureOf(err));
        throw err;
      }
      return;
    }
    throw new ConnectorError(`matrix moderate: ${input.action} is not possible in Matrix (redact the message instead)`, "rejected", false);
  }

  private async redact(auth: MatrixAuth, roomId: string, eventId: string, key: string): Promise<void> {
    await this.call(auth.homeserver, auth.accessToken, "PUT", `${CLIENT}/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${matrixTxnId(key)}`, "redact", {});
  }

  // ---- measure --------------------------------------------------------------------------

  async fetchMetrics(): Promise<MetricInput[]> {
    return [];
  }

  /** followers_total = joined members of the default room. */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const roomId = configOf(account).defaultRoomId ?? configOf(account).rooms[0]?.id;
    if (!roomId) return [];
    const r = await this.call<{ joined?: Record<string, unknown> }>(auth.homeserver, auth.accessToken, "GET", `${CLIENT}/rooms/${encodeURIComponent(roomId)}/joined_members`, "read members");
    if (!r.joined) return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: Object.keys(r.joined).length, observedAt: this.now().toISOString(), source: "matrix" }];
  }

  // ---- transport ------------------------------------------------------------------------

  private async send(auth: MatrixAuth, roomId: string, type: string, content: Record<string, unknown>, txnId: string, what: string): Promise<string> {
    const r = await this.call<{ event_id: string }>(auth.homeserver, auth.accessToken, "PUT", `${CLIENT}/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/${encodeURIComponent(txnId)}`, what, content);
    if (!r.event_id) throw new ConnectorError(`matrix ${what}: no event_id in the response`, "unknown", false, r);
    return r.event_id;
  }

  private async call<T>(homeserver: string, token: string | null, method: string, path: string, what: string, body?: unknown, contentType?: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let payload: string | Uint8Array | StreamBody | undefined;
    if (body instanceof Uint8Array || isStreamBody(body)) {
      headers["content-type"] = contentType ?? "application/octet-stream";
      payload = body;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const scrub = (s: string) => (token ? s.replaceAll(token, "<token>") : s);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        // A StreamBody opens a fresh stream for each attempt.
        res = await sendBody(resolveFetch(this.fetchImpl), `${homeserver}${path}`, { method, headers }, payload);
      } catch (err) {
        throw asNetworkError(new Error(scrub(err instanceof Error ? err.message : String(err))), `matrix ${what}`);
      }
      const json = await readJson(res);
      if (res.ok) return (json ?? {}) as T;
      if (res.status === 429 && attempt === 0) {
        const e = mapMatrixError(res.status, res.headers, json, what);
        const ms = (e.cause as MatrixFailure).retryAfterMs;
        if (ms !== undefined && ms <= this.maxRetryWaitMs) {
          await this.sleep(ms);
          continue;
        }
        throw e;
      }
      throw mapMatrixError(res.status, res.headers, json, what);
    }
  }
}

function fileName(m: Media, mime: string, i: number): string {
  const fromUrl = m.url.split("?")[0]?.split("/").pop();
  return fromUrl && /^[\w.-]+\.[a-z0-9]{2,5}$/i.test(fromUrl) ? fromUrl : `file${i}.${mime.split("/")[1] ?? "bin"}`;
}

function parseAuth(account: AccountRef): MatrixAuth {
  const parsed = MatrixAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`matrix account ${account.handle}: auth blob needs homeserver, accessToken and userId`, "auth", false);
  return parsed.data;
}

function configOf(account: AccountRef): MatrixAccountConfig {
  const c = account.config as Partial<MatrixAccountConfig>;
  const rooms = Array.isArray(c.rooms) ? c.rooms.filter((r): r is MatrixRoomRef => !!r && typeof r.id === "string").map((r) => ({ id: r.id, alias: typeof r.alias === "string" ? r.alias : null, name: typeof r.name === "string" ? r.name : null, encrypted: r.encrypted === true })) : [];
  return {
    homeserver: typeof c.homeserver === "string" ? c.homeserver : "",
    userId: typeof c.userId === "string" ? c.userId : account.externalId,
    displayName: typeof c.displayName === "string" ? c.displayName : null,
    rooms,
    defaultRoomId: typeof c.defaultRoomId === "string" ? c.defaultRoomId : null,
  };
}

export function createMatrixConnectors(_env: NodeJS.ProcessEnv): Connector[] {
  return [new MatrixConnector()];
}
