import type { ActivityInput, ActivityKind, Media, MetricInput, MetricName, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, isAfter, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { OAuth2Client } from "./oauth.ts";
import { mediaSource, sendBody, setMediaFile, uploadForm, withUpload, type StreamingForm } from "./media-io.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, ModerationInput, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Mastodon (and Mastodon-API servers) over the REST API with per-instance OAuth apps.
 *
 * Every server is its own OAuth provider: the first time someone connects from a server, we register an app there
 * (POST /api/v1/apps) and keep its client id/secret in the pending OAuth state (encrypted by core) and then in the
 * account's auth blob. Mastodon access tokens do not expire and no refresh token is issued, so refreshAuth is null.
 */

export const MASTODON_SCOPES = ["read", "write", "push"];

export const MastodonAuth = z.object({
  accessToken: z.string().min(1),
  /** Bare host, e.g. "mastodon.social". */
  instance: z.string().min(1),
  /** Numeric account id on that instance. */
  accountId: z.string().min(1),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  scope: z.string().optional(),
});
export type MastodonAuth = z.infer<typeof MastodonAuth>;

export interface MastodonConnectorOptions {
  /** Shown on the instance's authorization page and on posts ("via Starsign"). */
  appName?: string;
  appWebsite?: string;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Media processing checks before giving up with a retryable error (default 30, 2s apart). */
  maxProcessingChecks?: number;
  /** Notification/status pages (40 items each) walked per fetchActivity. */
  maxPages?: number;
  /** Allow private/loopback hosts as instances (tests and self-hosted dev only). */
  allowPrivateHosts?: boolean;
}

/** The parts of a Mastodon Status we read. */
export interface MastodonStatus {
  id: string;
  uri?: string;
  url?: string | null;
  created_at: string;
  content?: string;
  text?: string | null;
  visibility?: "public" | "unlisted" | "private" | "direct";
  in_reply_to_id?: string | null;
  in_reply_to_account_id?: string | null;
  reblog?: MastodonStatus | null;
  account: MastodonAccount;
  favourites_count?: number;
  reblogs_count?: number;
  replies_count?: number;
  quotes_count?: number;
  favourited?: boolean;
}

export interface MastodonAccount {
  id: string;
  username: string;
  acct: string;
  display_name?: string;
  url?: string;
  followers_count?: number;
}

interface MastodonNotification {
  id: string;
  type: string;
  created_at: string;
  account: MastodonAccount;
  status?: MastodonStatus | null;
}

interface MastodonMedia {
  id: string;
  type?: string;
  url?: string | null;
}

const NOTIFICATION_TYPES = ["mention", "reblog", "favourite", "follow"] as const;

/** Normalize what a person typed ("https://Mastodon.Social/@me", "@me@mastodon.social") to a bare host. */
export function normalizeInstance(input: string, allowPrivate = false): string {
  let s = input.trim();
  const handle = s.match(/^@?[^@\s/]+@([^@\s/]+)$/);
  if (handle?.[1]) s = handle[1];
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let host: string;
  try {
    host = new URL(s).host.toLowerCase();
  } catch {
    throw new ConnectorError(`mastodon: "${input}" is not a server address`, "rejected", false);
  }
  const hostname = host.replace(/:\d+$/, "");
  if (!/^[a-z0-9.-]+$/.test(hostname) || !hostname.includes(".")) throw new ConnectorError(`mastodon: "${input}" is not a server address`, "rejected", false);
  // The host is fetched server-side, so refuse loopback/private targets (SSRF) unless explicitly allowed.
  const privateHost = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  if (privateHost && !allowPrivate) throw new ConnectorError(`mastodon: "${hostname}" is not a public server`, "rejected", false);
  return host;
}

/** Status HTML → plain text (Mastodon returns HTML content). */
export function mastodonHtmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function errorDetail(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 200);
  const b = (body ?? {}) as { error?: unknown; error_description?: unknown };
  return [b.error, b.error_description].filter((x): x is string => typeof x === "string").join(": ");
}

/** HTTP → ConnectorError. 403 on a write is a refusal (not your status); on a read it is a scope problem. */
export function mapMastodonError(status: number, headers: Headers, body: unknown, ctx: { what: string; writing: boolean }): ConnectorError {
  const detail = errorDetail(body);
  const msg = `mastodon ${ctx.what}: HTTP ${status}${detail ? ` ${detail}` : ""}`;
  const cause = { status, body };
  if (status === 401) return new ConnectorError(`${msg} (token revoked or expired; reconnect the account)`, "auth", false, cause);
  if (status === 403) return new ConnectorError(msg, ctx.writing ? "rejected" : "auth", false, cause);
  if (status === 429) {
    const reset = headers.get("x-ratelimit-reset");
    return new ConnectorError(`${msg}; rate limit resets at ${reset ?? "unknown"}`, "rate_limit", true, cause);
  }
  const { kind, retryable } = classifyHttpStatus(status);
  return new ConnectorError(msg, kind, retryable, cause);
}

export class MastodonConnector implements Connector {
  readonly name = "mastodon";
  readonly networks: readonly Network[] = ["mastodon"];
  readonly connectMethod = "oauth" as const;
  /** No deployment-wide client id is needed: apps are registered per instance. */
  readonly connectConfigured = true;
  readonly oauthInputs = [{ key: "instance", label: "Your Mastodon server", placeholder: "mastodon.social" }] as const;
  media?: MediaFetcher;

  private readonly appName: string;
  private readonly appWebsite: string | undefined;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxProcessingChecks: number;
  private readonly maxPages: number;
  private readonly allowPrivateHosts: boolean;
  /** Registered apps per instance + redirect URI (process-local; the secret also travels in the OAuth state). */
  private readonly apps = new Map<string, { clientId: string; clientSecret: string }>();
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  private readonly progress = new Map<string, string[]>();
  private readonly uploaded = new Map<string, MastodonMedia[]>();

  constructor(opts: MastodonConnectorOptions = {}) {
    this.appName = opts.appName ?? "Starsign";
    this.appWebsite = opts.appWebsite;
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxProcessingChecks = opts.maxProcessingChecks ?? 30;
    this.maxPages = opts.maxPages ?? 5;
    this.allowPrivateHosts = opts.allowPrivateHosts ?? false;
  }

  capabilities(): ConnectorCapabilities {
    // Streaming and Web Push exist but are not wired: activity is polled.
    return { publish: true, fetchActivity: true, fetchMetrics: true, meteredReads: false, reply: true, moderate: true, accountMetrics: true, webhooks: false, video: true, kinds: ["post", "poll", "video"] };
  }

  // ---- connect --------------------------------------------------------------------------

  private client(instance: string, clientId: string, clientSecret: string): OAuth2Client {
    return new OAuth2Client(
      {
        name: `mastodon (${instance})`,
        authorizeUrl: `https://${instance}/oauth/authorize`,
        tokenUrl: `https://${instance}/oauth/token`,
        scopes: MASTODON_SCOPES,
        // PKCE is supported from Mastodon 4.3; older servers ignore the extra parameters.
        pkce: true,
        clientAuth: "body",
        clientId,
        clientSecret,
      },
      this.fetchImpl,
      this.now,
    );
  }

  /** Register (or reuse) an app on the person's server and send them to its authorize page with PKCE. */
  async oauthPrepare(p: { inputs: Record<string, string>; redirectUri: string; state: string; codeChallenge: string }): Promise<{ authorizeUrl: string; config: Record<string, unknown> }> {
    const instance = normalizeInstance(p.inputs.instance ?? "", this.allowPrivateHosts);
    const cacheKey = `${instance} ${p.redirectUri}`;
    let app = this.apps.get(cacheKey);
    if (!app) {
      const res = await this.raw(instance, null, "POST", "/api/v1/apps", {
        json: { client_name: this.appName, redirect_uris: p.redirectUri, scopes: MASTODON_SCOPES.join(" "), ...(this.appWebsite ? { website: this.appWebsite } : {}) },
        writing: true,
      });
      const body = res as { client_id?: unknown; client_secret?: unknown };
      if (typeof body.client_id !== "string" || typeof body.client_secret !== "string") throw new ConnectorError(`mastodon ${instance}: app registration returned no client credentials`, "unknown", false, res);
      app = { clientId: body.client_id, clientSecret: body.client_secret };
      this.apps.set(cacheKey, app);
    }
    const authorizeUrl = this.client(instance, app.clientId, app.clientSecret).authorizeUrl({ state: p.state, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge });
    return { authorizeUrl, config: { instance, clientId: app.clientId, clientSecret: app.clientSecret } };
  }

  async oauthConnect(p: { code: string; codeVerifier: string; redirectUri: string; config?: Record<string, unknown> }): Promise<ConnectedAccount[]> {
    const cfg = p.config ?? {};
    const instance = typeof cfg.instance === "string" ? cfg.instance : null;
    const clientId = typeof cfg.clientId === "string" ? cfg.clientId : null;
    const clientSecret = typeof cfg.clientSecret === "string" ? cfg.clientSecret : null;
    if (!instance || !clientId || !clientSecret) throw new ConnectorError("mastodon oauth: pending state is missing the instance or its app credentials", "auth", false);
    const token = await this.client(instance, clientId, clientSecret).exchange({ code: p.code, redirectUri: p.redirectUri, codeVerifier: p.codeVerifier });
    const me = await this.verifyCredentials(instance, token.accessToken);
    const auth: MastodonAuth = { accessToken: token.accessToken, instance, accountId: me.id, clientId, clientSecret, ...(token.scope ? { scope: token.scope } : {}) };
    return [{ network: "mastodon", identity: identityOf(instance, me), auth, config: { instance, accountUrl: me.url ?? null } }];
  }

  async describeAccount(rawAuth: Record<string, unknown>): Promise<AccountIdentity> {
    const instance = typeof rawAuth.instance === "string" ? rawAuth.instance : null;
    const token = typeof rawAuth.accessToken === "string" ? rawAuth.accessToken : null;
    if (!instance || !token) throw new ConnectorError("mastodon: instance and accessToken are required", "auth", false);
    return identityOf(instance, await this.verifyCredentials(instance, token));
  }

  /** Mastodon tokens do not expire and no refresh token is issued; a 401 means the person must reconnect. */
  async refreshAuth(): Promise<null> {
    return null;
  }

  private async verifyCredentials(instance: string, token: string): Promise<MastodonAccount> {
    const me = (await this.raw(instance, token, "GET", "/api/v1/accounts/verify_credentials")) as MastodonAccount | undefined;
    if (!me?.id || !me.username) throw new ConnectorError(`mastodon ${instance}: verify_credentials returned no account`, "unknown", false, me);
    return me;
  }

  // ---- publish --------------------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const poll = input.options?.poll;
    if (poll && input.media.length > 0) issues.push({ code: "unsupported_media", message: "mastodon polls cannot carry media" });
    const motion = input.media.filter((m) => m.kind === "video" || m.kind === "gif");
    if (motion.length > 0 && input.media.length > 1) issues.push({ code: "too_many_media", message: "mastodon allows one video or GIF per post, not mixed with images" });
    for (const m of input.media) if (m.kind === "document") issues.push({ code: "unsupported_media", message: "mastodon has no document attachments" });
    // Mastodon's default poll limits (servers can change them): 4 options of 50 characters.
    // TODO(verify): read /api/v2/instance configuration.polls for the server's real limits.
    if (poll && poll.options.length > 4) issues.push({ code: "too_many_media", message: `mastodon polls take at most 4 options by default (got ${poll.options.length})` });
    if (poll) for (const o of poll.options) if ([...o].length > 50) issues.push({ code: "too_long", message: `mastodon poll option "${o.slice(0, 30)}" is longer than 50 characters` });
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, () => this.publishSegments(account, parseAuth(account), input));
  }

  private async publishSegments(account: AccountRef, auth: MastodonAuth, input: PublishInput): Promise<PublishResult> {
    const key = input.idempotencyKey;
    const segments = [input.text, ...input.thread];
    const posted = this.progress.get(key) ?? [];
    const mediaIds = posted.length === 0 ? await this.prepareMedia(account, auth, key, input.media) : [];
    const opts = input.options ?? {};
    const visibility = opts.visibility ?? "public";
    try {
      for (let i = posted.length; i < segments.length; i++) {
        const parent = posted[posted.length - 1] ?? input.replyToExternalId ?? undefined;
        const body: Record<string, unknown> = { status: segments[i] ?? "", visibility };
        if (parent) body.in_reply_to_id = parent;
        if (opts.contentWarning) {
          body.spoiler_text = opts.contentWarning;
          body.sensitive = true;
        }
        if (i === 0 && mediaIds.length > 0) body.media_ids = mediaIds;
        if (i === 0 && opts.poll && mediaIds.length === 0) body.poll = { options: opts.poll.options, expires_in: Math.max(300, opts.poll.durationMinutes * 60) };
        // Mastodon de-duplicates POST /statuses by Idempotency-Key for about an hour, on top of our own cache.
        const st = (await this.call(account, auth, "POST", "/api/v1/statuses", { json: body, writing: true, headers: { "idempotency-key": `${key}:${i}` } })) as MastodonStatus;
        if (!st?.id) throw new ConnectorError("mastodon publish: response carried no status id", "unknown", false, st);
        posted.push(st.id);
        this.progress.set(key, posted);
      }
    } catch (err) {
      const root = posted[0];
      if (root) {
        const ce = err instanceof ConnectorError ? err : new ConnectorError(err instanceof Error ? err.message : String(err), "unknown", true, err);
        ce.partial = { externalId: root, url: this.statusUrl(account, auth, root), threadExternalIds: [...posted] };
        throw ce;
      }
      throw err;
    }
    const root = posted[0];
    if (!root) throw new ConnectorError("mastodon publish: nothing to post", "rejected", false);
    this.progress.delete(key);
    this.uploaded.delete(key);
    return { externalId: root, url: this.statusUrl(account, auth, root), ...(input.thread.length > 0 ? { threadExternalIds: [...posted] } : {}), raw: { ids: posted } };
  }

  private statusUrl(account: AccountRef, auth: MastodonAuth, id: string): string {
    const user = account.handle.replace(/^@/, "").split("@")[0] ?? "";
    return user ? `https://${auth.instance}/@${user}/${id}` : `https://${auth.instance}/statuses/${id}`;
  }

  /** Upload each attachment once per key (POST /api/v2/media) and wait until the server has processed it. */
  private async prepareMedia(account: AccountRef, auth: MastodonAuth, key: string, media: Media[]): Promise<string[]> {
    let items = this.uploaded.get(key);
    if (!items) {
      items = [];
      for (const m of media) {
        if (m.kind === "document") continue;
        // Videos go up as a streamed multipart body (exact Content-Length), so the file is never held whole.
        const res = await withUpload(mediaSource(this.media, this.fetchImpl), m, async (file) => {
          const form = uploadForm([file]);
          setMediaFile(form, "file", file, `upload.${file.mime.split("/")[1] ?? "bin"}`);
          if (m.alt) form.set("description", m.alt.slice(0, 1500));
          return (await this.call(account, auth, "POST", "/api/v2/media", { form, writing: true })) as MastodonMedia;
        });
        if (!res?.id) throw new ConnectorError("mastodon media: upload returned no id", "unknown", false, res);
        items.push(res);
      }
      this.uploaded.set(key, items);
    }
    for (const it of items) if (!it.url) Object.assign(it, await this.waitForMedia(account, auth, it.id));
    return items.map((i) => i.id);
  }

  /** 202 from the upload means processing; GET /api/v1/media/:id answers 206 until the url is set. */
  private async waitForMedia(account: AccountRef, auth: MastodonAuth, id: string): Promise<MastodonMedia> {
    for (let i = 0; i < this.maxProcessingChecks; i++) {
      const res = (await this.call(account, auth, "GET", `/api/v1/media/${encodeURIComponent(id)}`)) as MastodonMedia | undefined;
      if (res?.url) return res;
      await this.sleep(2000);
    }
    throw new ConnectorError(`mastodon media ${id}: still processing after ${this.maxProcessingChecks} checks; retry later (the upload is kept)`, "unknown", true);
  }

  // ---- engage ---------------------------------------------------------------------------

  /**
   * Reply to a status. Mastodon does not notify the author unless they are mentioned, so the author's @acct is
   * prepended when missing, and the reply never widens the parent's visibility.
   */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const parent = (await this.call(account, auth, "GET", `/api/v1/statuses/${encodeURIComponent(input.parentExternalId)}`)) as MastodonStatus;
      const mention = parent.account && parent.account.id !== auth.accountId ? `@${parent.account.acct}` : null;
      const text = mention && !input.text.toLowerCase().includes(mention.toLowerCase()) ? `${mention} ${input.text}` : input.text;
      const st = (await this.call(account, auth, "POST", "/api/v1/statuses", {
        json: { status: text, in_reply_to_id: input.parentExternalId, visibility: parent.visibility ?? "public" },
        writing: true,
        headers: { "idempotency-key": input.idempotencyKey },
      })) as MastodonStatus;
      if (!st?.id) throw new ConnectorError("mastodon reply: response carried no status id", "unknown", false, st);
      return { externalId: st.id, url: st.url ?? this.statusUrl(account, auth, st.id), raw: st };
    });
  }

  /** delete own status, favourite/unfavourite. Mastodon has no per-reply hide. */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    const auth = parseAuth(account);
    const id = encodeURIComponent(input.externalId);
    if (input.action === "delete") await this.call(account, auth, "DELETE", `/api/v1/statuses/${id}`, { writing: true });
    else if (input.action === "like") await this.call(account, auth, "POST", `/api/v1/statuses/${id}/favourite`, { writing: true });
    else if (input.action === "unlike") await this.call(account, auth, "POST", `/api/v1/statuses/${id}/unfavourite`, { writing: true });
    else throw new ConnectorError(`mastodon moderate: ${input.action} is not supported (mute or block the account on the server instead)`, "rejected", false);
  }

  // ---- listen ---------------------------------------------------------------------------

  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const out: ActivityInput[] = [];
    for (const n of await this.pages<MastodonNotification>(account, auth, "/api/v1/notifications", { "types[]": [...NOTIFICATION_TYPES] }, since)) {
      const item = this.notificationToActivity(auth, n);
      if (item) out.push(item);
    }
    for (const st of await this.pages<MastodonStatus>(account, auth, `/api/v1/accounts/${encodeURIComponent(auth.accountId)}/statuses`, { exclude_reblogs: ["true"] }, since)) {
      out.push(statusActivity(st, "own_post", st.id, auth.instance));
    }
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  /** Newest-first pages walked with max_id until an item predates `since`. */
  private async pages<T extends { id: string; created_at: string }>(account: AccountRef, auth: MastodonAuth, path: string, query: Record<string, string[]>, since: Date | null): Promise<T[]> {
    const out: T[] = [];
    let maxId: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const items = ((await this.call(account, auth, "GET", path, { query: { ...query, limit: ["40"], ...(maxId ? { max_id: [maxId] } : {}) } })) as T[] | undefined) ?? [];
      let older = false;
      for (const it of items) {
        if (!isAfter(it.created_at, since)) {
          older = true;
          continue;
        }
        out.push(it);
      }
      const last = items[items.length - 1];
      if (!last || older || items.length < 40) break;
      maxId = last.id;
    }
    return out;
  }

  private notificationToActivity(auth: MastodonAuth, n: MastodonNotification): ActivityInput | null {
    const who = { authorHandle: `@${n.account.acct.includes("@") ? n.account.acct : `${n.account.acct}@${auth.instance}`}`, authorName: n.account.display_name || null };
    if (n.type === "mention" && n.status) {
      const kind: ActivityKind = n.status.in_reply_to_account_id === auth.accountId ? "reply" : "mention";
      return { ...statusActivity(n.status, kind, n.status.id, auth.instance), parentExternalId: n.status.in_reply_to_id ?? null, raw: n };
    }
    const kind: ActivityKind | undefined = n.type === "reblog" ? "repost" : n.type === "favourite" ? "like" : n.type === "follow" ? "follow" : undefined;
    if (!kind) return null;
    return {
      network: "mastodon",
      kind,
      externalId: `notification:${n.id}`,
      ...who,
      text: null,
      url: kind === "follow" ? (n.account.url ?? null) : (n.status?.url ?? null),
      parentExternalId: n.status?.id ?? null,
      occurredAt: n.created_at,
      raw: n,
    };
  }

  // ---- measure --------------------------------------------------------------------------

  /** favourites/reblogs/replies (and quotes on servers that count them) per status; Mastodon exposes no impressions. */
  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    if (externalIds.length === 0) return [];
    const auth = parseAuth(account);
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    for (const id of externalIds) {
      let st: MastodonStatus;
      try {
        st = (await this.call(account, auth, "GET", `/api/v1/statuses/${encodeURIComponent(id)}`)) as MastodonStatus;
      } catch (err) {
        // A deleted status should not sink the whole batch.
        if (err instanceof ConnectorError && (err.cause as { status?: number } | undefined)?.status === 404) continue;
        throw err;
      }
      const row = (metric: MetricName, value: number | undefined): MetricInput[] => (typeof value === "number" ? [{ entityType: "post_variant", entityId: id, metric, value, observedAt, source: "mastodon" }] : []);
      const likes = st.favourites_count ?? 0;
      const reposts = st.reblogs_count ?? 0;
      const replies = st.replies_count ?? 0;
      out.push(...row("likes", st.favourites_count), ...row("reposts", st.reblogs_count), ...row("replies", st.replies_count), ...row("quotes", st.quotes_count), ...row("engagements", likes + reposts + replies + (st.quotes_count ?? 0)));
    }
    return out;
  }

  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const me = await this.verifyCredentials(auth.instance, auth.accessToken);
    if (typeof me.followers_count !== "number") return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: me.followers_count, observedAt: this.now().toISOString(), source: "mastodon" }];
  }

  // ---- transport ------------------------------------------------------------------------

  private call(account: AccountRef, auth: MastodonAuth, method: string, path: string, opts: RequestOpts = {}): Promise<unknown> {
    return this.raw(auth.instance, auth.accessToken, method, path, opts, account.handle);
  }

  private async raw(instance: string, token: string | null, method: string, path: string, opts: RequestOpts = {}, who?: string): Promise<unknown> {
    const url = new URL(`https://${instance}${path}`);
    for (const [k, vs] of Object.entries(opts.query ?? {})) for (const v of vs) url.searchParams.append(k, v);
    const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
    if (token) headers.authorization = `Bearer ${token}`;
    let body: string | FormData | StreamingForm | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) body = opts.form;
    let res: Response;
    try {
      res = await sendBody(resolveFetch(this.fetchImpl), url.toString(), { method, headers }, body);
    } catch (err) {
      throw asNetworkError(err, `mastodon ${method} ${path} (${who ?? instance})`);
    }
    const data = await readJson(res);
    if (!res.ok) throw mapMastodonError(res.status, res.headers, data, { what: `${method} ${path}`, writing: opts.writing ?? false });
    return data;
  }
}

interface RequestOpts {
  query?: Record<string, string[]>;
  json?: unknown;
  form?: FormData | StreamingForm;
  headers?: Record<string, string>;
  writing?: boolean;
}

function parseAuth(account: AccountRef): MastodonAuth {
  const instance = account.config.instance;
  const parsed = MastodonAuth.safeParse({ ...(typeof instance === "string" ? { instance } : {}), ...(account.auth ?? {}) });
  if (!parsed.success) throw new ConnectorError(`mastodon account ${account.handle}: auth blob needs accessToken, instance and accountId`, "auth", false, parsed.error);
  return parsed.data;
}

/** Account ids are only unique per server, so the external id carries the host: "<id>@<instance>". */
function identityOf(instance: string, me: MastodonAccount): AccountIdentity {
  return { externalId: `${me.id}@${instance}`, handle: `@${me.username}@${instance}`, displayName: me.display_name || null };
}

function statusActivity(st: MastodonStatus, kind: ActivityKind, externalId: string, instance?: string): ActivityInput {
  const acct = st.account.acct.includes("@") || !instance ? st.account.acct : `${st.account.acct}@${instance}`;
  return {
    network: "mastodon",
    kind,
    externalId,
    authorHandle: `@${acct}`,
    authorName: st.account.display_name || null,
    text: st.text ?? (st.content ? mastodonHtmlToText(st.content) : null),
    url: st.url ?? st.uri ?? null,
    parentExternalId: st.in_reply_to_id ?? null,
    occurredAt: st.created_at,
    raw: st,
  };
}

export function createMastodonConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [new MastodonConnector({ appName: env.MASTODON_APP_NAME || "Starsign", ...(env.STARSIGN_PUBLIC_URL ? { appWebsite: env.STARSIGN_PUBLIC_URL } : {}) })];
}
