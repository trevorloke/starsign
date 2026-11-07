import type { ActivityInput, ActivityKind, Media, MetricInput, MetricName, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, isAfter, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { StreamingForm, mediaSource, sendBody, setMediaFile, uploadForm, withUpload } from "./media-io.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, ModerationInput, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Misskey and Misskey-API servers (Sharkey, Firefish, Iceshrimp, Catodon, CherryPick...) over the HTTP API.
 *
 * Connect with a server host + an access token the person creates in Settings → API ("Generate access token")
 * with the permissions in MISSKEY_PERMISSIONS. Every endpoint is a POST with a JSON body; the token travels as the
 * `i` body field, which every Misskey generation and fork accepts (recent Misskey also takes a Bearer header).
 * Tokens do not expire. MiAuth (a browser consent flow that creates the token for the person) is a later step.
 */

export const MISSKEY_PERMISSIONS = ["read:account", "write:notes", "read:notifications", "write:reactions", "write:drive"] as const;

/** Misskey's default; the server's real value comes from /api/meta at connect. */
export const MISSKEY_DEFAULT_MAX_TEXT = 3000;

export const MisskeyAuth = z.object({
  token: z.string().min(1),
  /** Bare host, e.g. "misskey.io". */
  host: z.string().min(1),
  userId: z.string().min(1),
});
export type MisskeyAuth = z.infer<typeof MisskeyAuth>;

export interface MisskeyConnectorOptions {
  fetch?: FetchLike;
  now?: () => Date;
  /** Reaction used for "like" (default 👍; servers convert it to ❤ for notes that only accept likes). */
  likeReaction?: string;
  /** Notification pages (100 each) walked per fetchActivity. */
  maxPages?: number;
  allowPrivateHosts?: boolean;
}

export interface MisskeyUser {
  id: string;
  username: string;
  /** null for users on the same server. */
  host?: string | null;
  name?: string | null;
  followersCount?: number;
  followingCount?: number;
  notesCount?: number;
}

export interface MisskeyNote {
  id: string;
  createdAt: string;
  userId?: string;
  user: MisskeyUser;
  text?: string | null;
  cw?: string | null;
  visibility?: "public" | "home" | "followers" | "specified";
  replyId?: string | null;
  renoteId?: string | null;
  renote?: MisskeyNote | null;
  reply?: MisskeyNote | null;
  reactions?: Record<string, number>;
  reactionCount?: number;
  renoteCount?: number;
  repliesCount?: number;
  uri?: string | null;
  url?: string | null;
}

export interface MisskeyNotification {
  id: string;
  createdAt: string;
  type: string;
  userId?: string | null;
  user?: MisskeyUser | null;
  note?: MisskeyNote | null;
  reaction?: string | null;
}

interface MisskeyDriveFile {
  id: string;
  url?: string | null;
  type?: string;
}

const NOTIFICATION_TYPES = ["mention", "reply", "quote", "renote", "reaction", "follow"] as const;

/** Normalize a typed server ("https://Misskey.io/@me", "@me@misskey.io") to a bare host; refuses private hosts (SSRF). */
export function normalizeServerHost(input: string, label: string, allowPrivate = false): string {
  let s = input.trim();
  const handle = s.match(/^@?[^@\s/]+@([^@\s/]+)$/);
  if (handle?.[1]) s = handle[1];
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let host: string;
  try {
    host = new URL(s).host.toLowerCase();
  } catch {
    throw new ConnectorError(`${label}: "${input}" is not a server address`, "rejected", false);
  }
  const hostname = host.replace(/:\d+$/, "");
  if (!/^[a-z0-9.-]+$/.test(hostname) || !hostname.includes(".")) throw new ConnectorError(`${label}: "${input}" is not a server address`, "rejected", false);
  const privateHost = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  if (privateHost && !allowPrivate) throw new ConnectorError(`${label}: "${hostname}" is not a public server`, "rejected", false);
  return host;
}

/** Starsign visibility (Mastodon words) → Misskey visibility. */
export function misskeyVisibility(v: "public" | "unlisted" | "private" | "direct" | undefined): "public" | "home" | "followers" | "specified" {
  if (v === "unlisted") return "home";
  if (v === "private") return "followers";
  if (v === "direct") return "specified";
  return "public";
}

interface MisskeyErrorBody {
  error?: { message?: string; code?: string; id?: string; kind?: string; info?: unknown };
}

/** Misskey errors are `{ error: { code, message, id } }`. 401/403 are credential/permission problems, 429 carries Retry-After. */
export function mapMisskeyError(status: number, headers: Headers, body: unknown, what: string): ConnectorError {
  const e = typeof body === "object" && body ? ((body as MisskeyErrorBody).error ?? {}) : {};
  const code = e.code ?? "";
  const detail = [code, e.message].filter(Boolean).join(": ") || (typeof body === "string" ? body.slice(0, 200) : "");
  const msg = `misskey ${what}: HTTP ${status}${detail ? ` ${detail}` : ""}`;
  const cause = { status, code, body };
  if (status === 429 || code === "RATE_LIMIT_EXCEEDED") return new ConnectorError(`${msg}; retry after ${headers.get("retry-after") ?? "?"}s`, "rate_limit", true, cause);
  if (status === 401 || code === "AUTHENTICATION_FAILED" || code === "CREDENTIAL_REQUIRED") return new ConnectorError(`${msg} (token revoked or invalid; reconnect the account)`, "auth", false, cause);
  if (status === 403 || code === "PERMISSION_DENIED") return new ConnectorError(`${msg} (the token lacks a permission; create one with ${MISSKEY_PERMISSIONS.join(", ")})`, "auth", false, cause);
  const { kind, retryable } = classifyHttpStatus(status);
  return new ConnectorError(msg, kind, retryable, cause);
}

export class MisskeyConnector implements Connector {
  readonly name = "misskey";
  readonly networks: readonly Network[] = ["misskey"];
  readonly connectMethod = "api_key" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [
    { key: "host", label: "Your server", placeholder: "misskey.io" },
    { key: "token", label: "Access token (Settings → API)", placeholder: "token with read:account, write:notes, read:notifications, write:reactions, write:drive", secret: true },
  ] as const;
  media?: MediaFetcher;

  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly likeReaction: string;
  private readonly maxPages: number;
  private readonly allowPrivateHosts: boolean;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  private readonly progress = new Map<string, string[]>();
  private readonly uploaded = new Map<string, string[]>();

  constructor(opts: MisskeyConnectorOptions = {}) {
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.likeReaction = opts.likeReaction ?? "👍";
    this.maxPages = opts.maxPages ?? 5;
    this.allowPrivateHosts = opts.allowPrivateHosts ?? false;
  }

  capabilities(): ConnectorCapabilities {
    // Misskey has webhooks (Settings → Webhook) but they are per user and configured by hand; activity is polled.
    return { publish: true, fetchActivity: true, fetchMetrics: true, meteredReads: false, reply: true, moderate: true, accountMetrics: true, webhooks: false, video: true, kinds: ["post", "poll", "video", "carousel"] };
  }

  // ---- connect ------------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const host = normalizeServerHost(p.inputs.host ?? "", "misskey", this.allowPrivateHosts);
    const token = (p.inputs.token ?? "").trim();
    if (!token) throw new ConnectorError("misskey: an access token is required (Settings → API → Generate access token)", "auth", false);
    const me = await this.me(host, token);
    const meta = (await this.raw(host, null, "/api/meta", { detail: false }).catch(() => null)) as { maxNoteTextLength?: unknown; name?: unknown; version?: unknown } | null;
    const maxNoteTextLength = typeof meta?.maxNoteTextLength === "number" ? meta.maxNoteTextLength : MISSKEY_DEFAULT_MAX_TEXT;
    const auth: MisskeyAuth = { token, host, userId: me.id };
    return [{ network: "misskey", identity: identityOf(host, me), auth, config: { host, maxNoteTextLength, serverName: typeof meta?.name === "string" ? meta.name : null, serverVersion: typeof meta?.version === "string" ? meta.version : null } }];
  }

  async describeAccount(raw: Record<string, unknown>): Promise<AccountIdentity> {
    const host = typeof raw.host === "string" ? raw.host : null;
    const token = typeof raw.token === "string" ? raw.token : null;
    if (!host || !token) throw new ConnectorError("misskey: host and token are required", "auth", false);
    return identityOf(host, await this.me(host, token));
  }

  /** Access tokens do not expire; a 401 means the person revoked it and must reconnect. */
  async refreshAuth(): Promise<null> {
    return null;
  }

  private async me(host: string, token: string): Promise<MisskeyUser> {
    const me = (await this.raw(host, token, "/api/i", {})) as MisskeyUser | undefined;
    if (!me?.id || !me.username) throw new ConnectorError(`misskey ${host}: /api/i returned no account`, "unknown", false, me);
    return me;
  }

  // ---- publish ------------------------------------------------------------------------------

  validate(account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const max = typeof account.config.maxNoteTextLength === "number" ? account.config.maxNoteTextLength : MISSKEY_DEFAULT_MAX_TEXT;
    [input.text, ...input.thread].forEach((t, i) => {
      if ([...t].length > max) issues.push({ code: "too_long", message: `this server allows ${max} characters per note`, segment: i });
      if (!t.trim() && (i > 0 || (input.media.length === 0 && !input.options?.poll))) issues.push({ code: "empty", message: "misskey notes need text, files or a poll", segment: i });
    });
    if (input.media.length > 16) issues.push({ code: "too_many_media", message: "misskey notes take at most 16 files" });
    const poll = input.options?.poll;
    if (poll) {
      if (poll.options.length > 10) issues.push({ code: "too_many_media", message: "misskey polls take at most 10 choices" });
      for (const o of poll.options) if ([...o].length > 50) issues.push({ code: "too_long", message: `misskey poll choice "${o.slice(0, 30)}" is longer than 50 characters` });
    }
    if (input.options?.contentWarning && [...input.options.contentWarning].length > 100) issues.push({ code: "too_long", message: "misskey content warnings are at most 100 characters" });
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, () => this.publishSegments(account, parseAuth(account), input));
  }

  private async publishSegments(account: AccountRef, auth: MisskeyAuth, input: PublishInput): Promise<PublishResult> {
    const key = input.idempotencyKey;
    const segments = [input.text, ...input.thread];
    const posted = this.progress.get(key) ?? [];
    const opts = input.options ?? {};
    const fileIds = posted.length === 0 ? await this.uploadMedia(auth, key, input.media, opts.nsfw ?? false) : [];
    const visibility = misskeyVisibility(opts.visibility);
    try {
      for (let i = posted.length; i < segments.length; i++) {
        const parent = posted[posted.length - 1] ?? input.replyToExternalId ?? undefined;
        const text = segments[i] ?? "";
        // TODO(verify): with visibility "specified", Misskey adds users mentioned in the text to visibleUserIds.
        const body: Record<string, unknown> = { visibility };
        if (text.trim()) body.text = text;
        if (parent) body.replyId = parent;
        if (opts.contentWarning) body.cw = opts.contentWarning.slice(0, 100);
        if (i === 0 && fileIds.length > 0) body.fileIds = fileIds;
        if (i === 0 && opts.poll) body.poll = { choices: opts.poll.options, multiple: false, expiredAfter: opts.poll.durationMinutes * 60_000 };
        const res = (await this.call(auth, "/api/notes/create", body)) as { createdNote?: MisskeyNote } | undefined;
        const id = res?.createdNote?.id;
        if (!id) throw new ConnectorError("misskey publish: response carried no createdNote", "unknown", false, res);
        posted.push(id);
        this.progress.set(key, posted);
      }
    } catch (err) {
      const root = posted[0];
      if (root) {
        const ce = err instanceof ConnectorError ? err : new ConnectorError(err instanceof Error ? err.message : String(err), "unknown", true, err);
        ce.partial = { externalId: root, url: noteUrl(auth.host, root), threadExternalIds: [...posted] };
        throw ce;
      }
      throw err;
    }
    const root = posted[0];
    if (!root) throw new ConnectorError("misskey publish: nothing to post", "rejected", false);
    this.progress.delete(key);
    this.uploaded.delete(key);
    return { externalId: root, url: noteUrl(auth.host, root), ...(input.thread.length > 0 ? { threadExternalIds: [...posted] } : {}), raw: { ids: posted, fileIds } };
  }

  /** POST /api/drive/files/create (multipart) once per key; Misskey processes files synchronously. */
  private async uploadMedia(auth: MisskeyAuth, key: string, media: Media[], sensitive: boolean): Promise<string[]> {
    const done = this.uploaded.get(key);
    if (done) return done;
    const ids: string[] = [];
    for (const m of media) {
      // Videos go up as a streamed multipart body (exact Content-Length); images are read whole as before.
      const file = await withUpload(mediaSource(this.media, this.fetchImpl), m, async (r) => {
        const mime = r.mime;
        const form = uploadForm([r]);
        form.set("i", auth.token);
        setMediaFile(form, "file", r, `upload.${mime.split("/")[1]?.split("+")[0] ?? "bin"}`);
        if (m.alt) form.set("comment", m.alt.slice(0, 512));
        if (sensitive) form.set("isSensitive", "true");
        // Without force, Misskey returns an existing drive file with the same hash instead of a new one: what we want.
        return (await this.raw(auth.host, null, "/api/drive/files/create", form)) as MisskeyDriveFile | undefined;
      });
      if (!file?.id) throw new ConnectorError("misskey media: upload returned no file id", "unknown", false, file);
      ids.push(file.id);
    }
    this.uploaded.set(key, ids);
    return ids;
  }

  // ---- engage -------------------------------------------------------------------------------

  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      // Keep the parent's visibility so a reply never widens who can see a followers-only thread.
      const parent = (await this.call(auth, "/api/notes/show", { noteId: input.parentExternalId })) as MisskeyNote;
      const visibility = parent.visibility === "specified" ? "specified" : (parent.visibility ?? "public");
      const res = (await this.call(auth, "/api/notes/create", { text: input.text, replyId: input.parentExternalId, visibility })) as { createdNote?: MisskeyNote };
      const id = res?.createdNote?.id;
      if (!id) throw new ConnectorError("misskey reply: response carried no createdNote", "unknown", false, res);
      return { externalId: id, url: noteUrl(auth.host, id), raw: res };
    });
  }

  /** like = reaction, unlike = remove our reaction, delete = own note. Misskey has no per-reply hide. */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    const auth = parseAuth(account);
    const noteId = input.externalId;
    try {
      if (input.action === "like") await this.call(auth, "/api/notes/reactions/create", { noteId, reaction: this.likeReaction });
      else if (input.action === "unlike") await this.call(auth, "/api/notes/reactions/delete", { noteId });
      else if (input.action === "delete") await this.call(auth, "/api/notes/delete", { noteId });
      else throw new ConnectorError(`misskey moderate: ${input.action} is not supported (mute or block the user on the server instead)`, "rejected", false);
    } catch (err) {
      // Liking twice or unliking a note we never reacted to is already the requested state.
      const code = err instanceof ConnectorError ? (err.cause as { code?: string } | undefined)?.code : undefined;
      if ((input.action === "like" && code === "ALREADY_REACTED") || (input.action === "unlike" && code === "NOT_REACTED")) return;
      throw err;
    }
  }

  // ---- listen -------------------------------------------------------------------------------

  /** POST /api/i/notifications (newest first, untilId paging) filtered to `since`; does not mark them read. */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const out: ActivityInput[] = [];
    let untilId: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const items = ((await this.call(auth, "/api/i/notifications", { limit: 100, includeTypes: [...NOTIFICATION_TYPES], markAsRead: false, ...(untilId ? { untilId } : {}) })) as MisskeyNotification[] | undefined) ?? [];
      let older = false;
      for (const n of items) {
        if (!isAfter(n.createdAt, since)) {
          older = true;
          continue;
        }
        const item = misskeyNotificationToActivity(auth.host, n);
        if (item) out.push(item);
      }
      const last = items[items.length - 1];
      if (!last || older || items.length < 100) break;
      untilId = last.id;
    }
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  // ---- measure ------------------------------------------------------------------------------

  /** Reactions (all emoji, as likes), renotes and replies per note. Misskey exposes no impressions. */
  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    if (externalIds.length === 0) return [];
    const auth = parseAuth(account);
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    for (const id of externalIds) {
      let note: MisskeyNote;
      try {
        note = (await this.call(auth, "/api/notes/show", { noteId: id })) as MisskeyNote;
      } catch (err) {
        const cause = err instanceof ConnectorError ? (err.cause as { status?: number; code?: string } | undefined) : undefined;
        if (cause?.code === "NO_SUCH_NOTE" || cause?.status === 404) continue;
        throw err;
      }
      const reactions = typeof note.reactionCount === "number" ? note.reactionCount : Object.values(note.reactions ?? {}).reduce((a, b) => a + b, 0);
      const renotes = note.renoteCount ?? 0;
      const replies = note.repliesCount ?? 0;
      const row = (metric: MetricName, value: number): MetricInput => ({ entityType: "post_variant", entityId: id, metric, value, observedAt, source: "misskey" });
      out.push(row("likes", reactions), row("reposts", renotes), row("replies", replies), row("engagements", reactions + renotes + replies));
    }
    return out;
  }

  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const me = await this.me(auth.host, auth.token);
    if (typeof me.followersCount !== "number") return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: me.followersCount, observedAt: this.now().toISOString(), source: "misskey" }];
  }

  // ---- transport ----------------------------------------------------------------------------

  private call(auth: MisskeyAuth, path: string, body: Record<string, unknown>): Promise<unknown> {
    return this.raw(auth.host, auth.token, path, body);
  }

  private async raw(host: string, token: string | null, path: string, body: Record<string, unknown> | FormData | StreamingForm): Promise<unknown> {
    const init: RequestInit = { method: "POST", headers: { accept: "application/json" } };
    if (body instanceof FormData) init.body = body;
    else if (!(body instanceof StreamingForm)) {
      init.headers = { accept: "application/json", "content-type": "application/json" };
      init.body = JSON.stringify(token ? { ...body, i: token } : body);
    }
    let res: Response;
    try {
      res =
        body instanceof StreamingForm
          ? await sendBody(resolveFetch(this.fetchImpl), `https://${host}${path}`, { method: "POST", headers: { accept: "application/json" } }, body)
          : await resolveFetch(this.fetchImpl)(`https://${host}${path}`, init);
    } catch (err) {
      throw asNetworkError(err, `misskey ${path} (${host})`);
    }
    // 204 for endpoints without a response (reactions, delete).
    const data = res.status === 204 ? undefined : await readJson(res);
    if (!res.ok) throw mapMisskeyError(res.status, res.headers, data, path);
    return data;
  }
}

function parseAuth(account: AccountRef): MisskeyAuth {
  const host = account.config.host;
  const parsed = MisskeyAuth.safeParse({ ...(typeof host === "string" ? { host } : {}), ...(account.auth ?? {}) });
  if (!parsed.success) throw new ConnectorError(`misskey account ${account.handle}: auth blob needs token, host and userId`, "auth", false, parsed.error);
  return parsed.data;
}

function identityOf(host: string, me: MisskeyUser): AccountIdentity {
  return { externalId: `${me.id}@${host}`, handle: `@${me.username}@${host}`, displayName: me.name || null };
}

export function noteUrl(host: string, id: string): string {
  return `https://${host}/notes/${id}`;
}

function handleOf(localHost: string, u: MisskeyUser): string {
  return `@${u.username}@${u.host ?? localHost}`;
}

function noteActivity(host: string, note: MisskeyNote, kind: ActivityKind, raw: unknown): ActivityInput {
  return {
    network: "misskey",
    kind,
    externalId: note.id,
    authorHandle: handleOf(host, note.user),
    authorName: note.user.name || null,
    text: [note.cw ? `CW: ${note.cw}` : null, note.text ?? null].filter(Boolean).join("\n\n") || null,
    url: noteUrl(host, note.id),
    parentExternalId: kind === "quote" ? (note.renoteId ?? null) : (note.replyId ?? null),
    occurredAt: note.createdAt,
    raw,
  };
}

/** One notification → activity. Notes keep their own id (so reply/moderate can find them); the rest are notification ids. */
export function misskeyNotificationToActivity(host: string, n: MisskeyNotification): ActivityInput | null {
  if ((n.type === "mention" || n.type === "reply" || n.type === "quote") && n.note) return noteActivity(host, n.note, n.type, n);
  const kind: ActivityKind | undefined = n.type === "renote" ? "repost" : n.type === "reaction" ? "like" : n.type === "follow" ? "follow" : undefined;
  if (!kind || !n.user) return null;
  // For a renote the notification's note is the renote; the post that was renoted is note.renote.
  const target = n.type === "renote" ? (n.note?.renote ?? null) : (n.note ?? null);
  return {
    network: "misskey",
    kind,
    externalId: `notification:${n.id}@${host}`,
    authorHandle: handleOf(host, n.user),
    authorName: n.user.name || null,
    text: kind === "like" ? (n.reaction ?? null) : null,
    url: kind === "follow" ? `https://${host}/@${n.user.username}${n.user.host ? `@${n.user.host}` : ""}` : target ? noteUrl(host, target.id) : null,
    parentExternalId: target?.id ?? n.note?.renoteId ?? null,
    occurredAt: n.createdAt,
    raw: n,
  };
}

export function createMisskeyConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [new MisskeyConnector(env.MISSKEY_LIKE_REACTION ? { likeReaction: env.MISSKEY_LIKE_REACTION } : {})];
}
