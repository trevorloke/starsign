import type { ActivityInput, Media, MetricInput, MetricName, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, isAfter, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource } from "./media-io.ts";
import { OAuth2Client, clientFromEnv, type OAuth2Token } from "./oauth.ts";
import type {
  AccountIdentity,
  AccountRef,
  AuthRefresh,
  ConnectedAccount,
  Connector,
  ConnectorCapabilities,
  MediaFetcher,
  ModerationInput,
  PublishInput,
  PublishResult,
  ValidationIssue,
} from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Weibo (微博) adapter: OAuth 2.0 on api.weibo.com + the v2 REST API (`https://api.weibo.com/2/*.json`).
 *
 * Publishing goes through `statuses/share`, the only status-creating endpoint Weibo still opens to third-party apps.
 * Its rule: the text must contain at least one URL under the app's registered **security domain** (安全域名, set in the
 * app's settings on open.weibo.com). Without it Weibo answers 10017 "text not find domain". Starsign checks for a link
 * before calling Weibo, and checks the domain too when `WEIBO_SECURITY_DOMAIN` (or the account's `securityDomain`
 * config) is set.
 *
 * Tokens: Weibo issues long-lived access tokens with no refresh token for web apps. The expiry is stored as
 * `expiresAt`; once it passes every call fails with ConnectorError("auth") so core marks the account for
 * reconnection. `refreshAuth` cannot renew anything and returns null.
 */

export const WeiboAuth = z.object({
  accessToken: z.string().min(1),
  /** The Weibo user id (uid) of the person who logged in: the account's externalId. */
  uid: z.string().min(1),
  /** ISO time the token expires (from expires_in / get_token_info expire_in). Absent when Weibo did not say. */
  expiresAt: z.string().optional(),
  scope: z.string().optional(),
});
export type WeiboAuth = z.infer<typeof WeiboAuth>;

export interface WeiboConnectorOptions {
  appKey?: string;
  appSecret?: string;
  /** The app's security domain (e.g. "acme.com"). When set, published text must link to it or a subdomain. */
  securityDomain?: string;
  /** OAuth scopes. Default none: the basic scope covers every endpoint used here. */
  scopes?: string[];
  baseUrl?: string;
  oauthBaseUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** Pages (of `pageSize`) walked per timeline in fetchActivity (default 3). */
  maxPages?: number;
  pageSize?: number;
}

/** Weibo user object (subset). */
export interface WeiboUser {
  id?: number | string;
  idstr?: string;
  screen_name?: string;
  name?: string;
  followers_count?: number;
  friends_count?: number;
  statuses_count?: number;
}

/** Weibo status object (subset). */
export interface WeiboStatus {
  id?: number | string;
  idstr?: string;
  mid?: string;
  text?: string;
  created_at?: string;
  user?: WeiboUser;
  reposts_count?: number;
  comments_count?: number;
  attitudes_count?: number;
}

/** Weibo comment object (subset). */
export interface WeiboComment {
  id?: number | string;
  idstr?: string;
  mid?: string;
  text?: string;
  created_at?: string;
  user?: WeiboUser;
  status?: WeiboStatus;
  reply_comment?: WeiboComment;
}

export const WEIBO_LIMITS = {
  /** statuses/share accepts one picture (`pic`). TODO(verify): 5 MB limit; JPEG, GIF and PNG. */
  maxImageBytes: 5 * 1024 * 1024,
  /** statuses/count takes up to 100 ids. */
  countBatch: 100,
} as const;

export const SECURITY_DOMAIN_RULE =
  "Weibo's statuses/share (the only posting endpoint open to third-party apps) only accepts text that contains a link to the app's registered security domain (安全域名, set under the app's settings on open.weibo.com). Add a link to that domain to the text or set the variant's link.";

/** Weibo error codes whose meaning beats the HTTP status. */
const AUTH_CODES = new Set([21301, 21314, 21315, 21316, 21317, 21319, 21327, 21332, 21501]);
const RATE_CODES = new Set([10022, 10023, 10024, 20016]);
const RETRY_CODES = new Set([10001, 10002, 10003, 10009, 10011]);
const REJECTED_HINTS: Record<number, string> = {
  10014: "the app lacks permission for this API (advanced interfaces need approval on open.weibo.com)",
  // TODO(verify): 21321 is "unaudited app: user count over the limit" (test apps can only be used by their test users).
  21321: "the app is not audited yet; only its test users can authorize it (add the account under the app's test users, or finish app review)",
  20003: "user does not exist",
  20012: "text too long",
  20017: "Weibo rejected the post as duplicate or very similar content",
  20018: "the text contains a link Weibo does not allow",
  20019: "Weibo rejected the post as duplicate content (the same text was posted recently)",
  20020: "the text looks like advertising",
  20021: "the text contains content Weibo does not allow",
  20101: "the target post does not exist (deleted?)",
  20111: "Weibo rejected the post as duplicate content",
  20206: "the author only allows comments from people they follow",
};

export interface WeiboFailure {
  status: number;
  code?: number;
  body: unknown;
}

/** Map a Weibo `{ error_code, error }` (or a bare HTTP failure) to a ConnectorError. */
export function mapWeiboError(status: number, body: unknown, what: string): ConnectorError {
  const b = (body && typeof body === "object" ? body : {}) as { error_code?: unknown; error?: unknown };
  const code = typeof b.error_code === "number" ? b.error_code : typeof b.error_code === "string" && /^\d+$/.test(b.error_code) ? Number(b.error_code) : undefined;
  const text = typeof b.error === "string" ? b.error : typeof body === "string" ? body.slice(0, 200) : "";
  const msg = `weibo ${what}: ${code !== undefined ? `error ${code}` : `HTTP ${status}`}${text ? `: ${text}` : ""}`;
  const cause: WeiboFailure = { status, ...(code !== undefined ? { code } : {}), body };
  if (code !== undefined) {
    if (AUTH_CODES.has(code)) return new ConnectorError(`${msg} — the Weibo token is expired or revoked; reconnect the account (Weibo issues no refresh tokens)`, "auth", false, cause);
    if (RATE_CODES.has(code)) return new ConnectorError(`${msg} — Weibo rate limit (per user and per app, hourly); retry later`, "rate_limit", true, cause);
    if (RETRY_CODES.has(code)) return new ConnectorError(msg, "network", true, cause);
    // 10017 is "invalid parameter"; on statuses/share Weibo uses it for "text not find domain".
    if (code === 10017 && /domain/i.test(text)) return new ConnectorError(`${msg} — ${SECURITY_DOMAIN_RULE}`, "rejected", false, cause);
    if (REJECTED_HINTS[code]) return new ConnectorError(`${msg} — ${REJECTED_HINTS[code]}`, "rejected", false, cause);
    if (code >= 10000 && status >= 500) return new ConnectorError(msg, "network", true, cause);
    if (code >= 10000) return new ConnectorError(msg, status === 429 ? "rate_limit" : "rejected", status === 429, cause);
  }
  const { kind, retryable } = classifyHttpStatus(status >= 400 ? status : 400);
  return new ConnectorError(msg, kind, retryable, cause);
}

/**
 * Weibo ids are 64-bit integers that JSON.parse rounds (statuses/count returns `id` only as a number). Quote every
 * integer of 16+ digits before parsing; fall back to a plain parse if that ever breaks the text.
 */
export function parseWeiboJson(text: string): unknown {
  if (!text) return undefined;
  const safe = text.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  try {
    return JSON.parse(safe) as unknown;
  } catch {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}

const URL_RE = /https?:\/\/[^\s<>"'，。！？、）)]+/gi;

/** URLs in a text. */
export function linksIn(text: string): string[] {
  return text.match(URL_RE) ?? [];
}

function hostMatches(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const d = domain.toLowerCase().replace(/^\.+/, "");
    return host === d || host.endsWith(`.${d}`);
  } catch {
    return false;
  }
}

/** The text to send: the variant text, with `options.link` appended when it is not already in it. */
export function weiboShareText(input: PublishInput): string {
  const link = input.options?.link;
  const text = input.text.trim();
  if (!link || text.includes(link)) return text;
  return text ? `${text} ${link}` : link;
}

/** Security-domain check for statuses/share. Null when fine, else the reason. */
export function checkSecurityDomain(text: string, domain: string | undefined): string | null {
  const links = linksIn(text);
  if (links.length === 0) return `the text has no link. ${SECURITY_DOMAIN_RULE}`;
  if (domain && !links.some((l) => hostMatches(l, domain))) return `no link points to the security domain ${domain} (found ${links.join(", ")}). ${SECURITY_DOMAIN_RULE}`;
  return null;
}

const idOf = (x: { idstr?: string; id?: number | string } | undefined): string | undefined => (x?.idstr ? x.idstr : x?.id !== undefined ? String(x.id) : undefined);

/** Compare two decimal id strings numerically (ids exceed 2^53). */
function idGreater(a: string, b: string): boolean {
  return a.length !== b.length ? a.length > b.length : a > b;
}

function isoOf(createdAt: string | undefined, fallback: Date): string {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback.toISOString();
}

export function weiboStatusUrl(status: WeiboStatus | undefined, fallbackUid: string | undefined): string | null {
  const uid = idOf(status?.user) ?? fallbackUid;
  const mid = status?.mid ?? idOf(status);
  return uid && mid ? `https://weibo.com/${uid}/${mid}` : null;
}

export class WeiboConnector implements Connector {
  readonly name = "weibo";
  readonly networks: readonly Network[] = ["weibo"];
  readonly connectMethod = "oauth" as const;
  media?: MediaFetcher;

  private readonly oauth: OAuth2Client;
  private readonly baseUrl: string;
  private readonly oauthBase: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly securityDomain: string | undefined;
  private readonly maxPages: number;
  private readonly pageSize: number;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  /** `${accountId}:${timeline}` → highest id seen, used as since_id on the next poll. */
  private readonly cursors = new Map<string, string>();
  /** comment id → status id, learned from fetchActivity so a reply needs no lookup. */
  private readonly commentStatus = new Map<string, string>();

  constructor(opts: WeiboConnectorOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.weibo.com/2").replace(/\/+$/, "");
    this.oauthBase = (opts.oauthBaseUrl ?? "https://api.weibo.com/oauth2").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.securityDomain = opts.securityDomain?.trim() || undefined;
    this.maxPages = opts.maxPages ?? 3;
    this.pageSize = opts.pageSize ?? 50;
    this.oauth = new OAuth2Client(
      {
        name: "weibo",
        authorizeUrl: `${this.oauthBase}/authorize`,
        tokenUrl: `${this.oauthBase}/access_token`,
        scopes: opts.scopes ?? [],
        scopeSeparator: ",",
        pkce: false,
        // TODO(verify): Weibo documents the parameters on the URL of the POST; SDKs send them as a form body, as here.
        clientAuth: "body",
        ...(opts.appKey ? { clientId: opts.appKey } : {}),
        ...(opts.appSecret ? { clientSecret: opts.appSecret } : {}),
      },
      (i, init) => resolveFetch(this.fetchImpl)(i, init),
      this.now,
    );
  }

  get connectConfigured(): boolean {
    return this.oauth.configured;
  }

  capabilities(): ConnectorCapabilities {
    return {
      publish: true,
      fetchActivity: true,
      fetchMetrics: true,
      meteredReads: false,
      reply: true,
      moderate: true,
      accountMetrics: true,
      webhooks: false,
      video: false,
      kinds: ["post", "link"],
    };
  }

  // ---- connect ----------------------------------------------------------------------------

  oauthAuthorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    const u = new URL(this.oauth.authorizeUrl({ state: p.state, redirectUri: p.redirectUri }));
    if (!u.searchParams.get("scope")) u.searchParams.delete("scope");
    u.searchParams.delete("response_type"); // Weibo's authorize takes client_id, redirect_uri, scope, state (code is the default)
    return u.toString();
  }

  async oauthConnect(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<ConnectedAccount[]> {
    const token = await this.oauth.exchange({ code: p.code, redirectUri: p.redirectUri });
    const info = await this.tokenInfo(token.accessToken);
    const auth = this.toAuth(token, info);
    const identity = await this.describeAccount(auth);
    // A Weibo login is one user. Enterprise (蓝V) accounts are ordinary users too; there is no page/sub-account login.
    return [{ network: "weibo", identity, auth: { ...auth, uid: identity.externalId }, config: { uid: identity.externalId, ...(this.securityDomain ? { securityDomain: this.securityDomain } : {}) } }];
  }

  /** `oauth2/get_token_info`: uid, appkey, scope, create_at and expire_in (seconds left) for a token. */
  async tokenInfo(accessToken: string): Promise<{ uid?: string; appkey?: string; scope?: string; expireIn?: number; createAt?: number }> {
    const body = await this.send("POST", `${this.oauthBase}/get_token_info`, new URLSearchParams({ access_token: accessToken }), "get_token_info");
    const b = (body ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
    const expireIn = num(b.expire_in);
    const createAt = num(b.create_at);
    return {
      ...(b.uid !== undefined && b.uid !== null ? { uid: String(b.uid) } : {}),
      ...(typeof b.appkey === "string" ? { appkey: b.appkey } : {}),
      ...(typeof b.scope === "string" ? { scope: b.scope } : {}),
      ...(expireIn !== undefined ? { expireIn } : {}),
      ...(createAt !== undefined ? { createAt } : {}),
    };
  }

  private toAuth(token: OAuth2Token, info: { uid?: string; expireIn?: number; scope?: string }): WeiboAuth {
    const uid = info.uid ?? (token.raw.uid !== undefined ? String(token.raw.uid) : "");
    if (!uid) throw new ConnectorError("weibo oauth: neither the token response nor get_token_info returned a uid", "auth", false);
    const expiresAt = info.expireIn !== undefined ? new Date(this.now().getTime() + info.expireIn * 1000).toISOString() : token.expiresAt;
    const scope = info.scope ?? token.scope;
    return { accessToken: token.accessToken, uid, ...(expiresAt ? { expiresAt } : {}), ...(scope ? { scope } : {}) };
  }

  async describeAccount(raw: Record<string, unknown>): Promise<AccountIdentity> {
    const parsed = WeiboAuth.safeParse(raw);
    if (!parsed.success) throw new ConnectorError("weibo: auth needs accessToken and uid", "auth", false);
    const u = await this.get<WeiboUser>(parsed.data, "/users/show.json", { uid: parsed.data.uid }, "users/show");
    const uid = idOf(u) ?? parsed.data.uid;
    return { externalId: uid, handle: u.screen_name ?? uid, displayName: u.name ?? u.screen_name ?? null };
  }

  /** Weibo has no refresh token for web apps: nothing to renew. Expired tokens surface as auth errors → reconnect. */
  async refreshAuth(_account: AccountRef): Promise<AuthRefresh | null> {
    return null;
  }

  // ---- validation -------------------------------------------------------------------------

  validate(account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "weibo has no threads; post one status" });
    const images = input.media.filter((m) => m.kind === "image" || m.kind === "gif");
    if (input.media.some((m) => m.kind === "video" || m.kind === "document")) issues.push({ code: "unsupported_media", message: "weibo's third-party share API takes one picture only; video is not available to outside apps" });
    if (images.length > 1) issues.push({ code: "too_many_media", message: "weibo's share API takes one picture per post" });
    for (const m of images) if (m.bytes && m.bytes > WEIBO_LIMITS.maxImageBytes) issues.push({ code: "unsupported_media", message: "weibo pictures must be under 5 MB" });
    const problem = checkSecurityDomain(weiboShareText(input), this.domainFor(account));
    if (problem) issues.push({ code: "empty", message: `weibo: ${problem}`, segment: 0 });
    return issues;
  }

  private domainFor(account: AccountRef): string | undefined {
    const c = account.config.securityDomain;
    return (typeof c === "string" && c.trim()) || this.securityDomain;
  }

  // ---- publishing -------------------------------------------------------------------------

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      if (input.replyToExternalId) return this.replyOnce(account, input.replyToExternalId, input.text);
      return this.share(account, input);
    });
  }

  private async share(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    const auth = this.auth(account);
    const text = weiboShareText(input);
    const problem = checkSecurityDomain(text, this.domainFor(account));
    if (problem) throw new ConnectorError(`weibo publish: ${problem}`, "rejected", false);
    if (input.thread.length > 0) throw new ConnectorError("weibo publish: weibo has no threads", "rejected", false);
    const images = input.media.filter((m) => m.kind === "image" || m.kind === "gif");
    if (input.media.length > images.length || images.length > 1) throw new ConnectorError("weibo publish: the share API takes text plus at most one picture", "rejected", false);
    let body: URLSearchParams | FormData;
    const pic = images[0];
    if (pic) {
      const { bytes, mime } = await this.readImage(pic);
      if (bytes.byteLength > WEIBO_LIMITS.maxImageBytes) throw new ConnectorError("weibo publish: the picture is over 5 MB", "rejected", false);
      const form = new FormData();
      form.set("access_token", auth.accessToken);
      form.set("status", text);
      form.set("pic", new Blob([bytes], { type: mime }), `pic.${extFor(mime)}`);
      body = form;
    } else {
      body = new URLSearchParams({ access_token: auth.accessToken, status: text });
    }
    // TODO(verify): statuses/share also accepts `rip` (the end user's IP) — Weibo asks for it on some apps; not sent.
    const status = (await this.send("POST", `${this.baseUrl}/statuses/share.json`, body, "statuses/share")) as WeiboStatus;
    const id = idOf(status);
    if (!id) throw new ConnectorError("weibo statuses/share: response had no id", "unknown", false, status);
    return { externalId: id, url: weiboStatusUrl(status, auth.uid), raw: status };
  }

  private async readImage(m: Media): Promise<{ bytes: Uint8Array; mime: string }> {
    return mediaSource(this.media, this.fetchImpl).fetch(m);
  }

  // ---- inbox ------------------------------------------------------------------------------

  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = this.auth(account);
    const out = new Map<string, ActivityInput>();
    const add = (a: ActivityInput) => {
      if (!out.has(a.externalId)) out.set(a.externalId, a);
    };
    // Comments on my posts.
    for (const c of await this.timeline<WeiboComment>(account, auth, "/comments/to_me.json", "comments", "comments/to_me", since)) {
      const a = this.commentActivity(c, "comment", auth);
      if (a) add(a);
    }
    // @mentions in posts and in comments. TODO(verify): both are "advanced" interfaces on many apps (10014 without approval).
    for (const s of await this.timeline<WeiboStatus>(account, auth, "/statuses/mentions.json", "statuses", "statuses/mentions", since)) {
      const id = idOf(s);
      if (!id || idOf(s.user) === auth.uid) continue;
      add({
        network: "weibo",
        kind: "mention",
        externalId: id,
        authorHandle: s.user?.screen_name ?? idOf(s.user) ?? null,
        authorName: s.user?.name ?? s.user?.screen_name ?? null,
        text: s.text ?? null,
        url: weiboStatusUrl(s, undefined),
        parentExternalId: null,
        occurredAt: isoOf(s.created_at, this.now()),
        raw: s,
      });
    }
    for (const c of await this.timeline<WeiboComment>(account, auth, "/comments/mentions.json", "comments", "comments/mentions", since)) {
      const a = this.commentActivity(c, "mention", auth);
      if (a) add(a);
    }
    return [...out.values()].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  private commentActivity(c: WeiboComment, kind: "comment" | "mention", auth: WeiboAuth): ActivityInput | null {
    const id = idOf(c);
    if (!id || idOf(c.user) === auth.uid) return null;
    const statusId = idOf(c.status);
    if (statusId) this.commentStatus.set(id, statusId);
    return {
      network: "weibo",
      kind,
      externalId: id,
      authorHandle: c.user?.screen_name ?? idOf(c.user) ?? null,
      authorName: c.user?.name ?? c.user?.screen_name ?? null,
      text: c.text ?? null,
      url: weiboStatusUrl(c.status, auth.uid),
      parentExternalId: idOf(c.reply_comment) ?? statusId ?? null,
      occurredAt: isoOf(c.created_at, this.now()),
      raw: c,
    };
  }

  /** One Weibo timeline since the last id seen (or, the first time, back to `since`), at most maxPages pages. */
  private async timeline<T extends { id?: number | string; idstr?: string; created_at?: string }>(account: AccountRef, auth: WeiboAuth, path: string, field: string, what: string, since: Date | null): Promise<T[]> {
    const key = `${account.id}:${path}`;
    const sinceId = this.cursors.get(key);
    const items: T[] = [];
    let top = sinceId;
    for (let page = 1; page <= this.maxPages; page++) {
      const body = await this.get<Record<string, unknown>>(auth, path, { count: String(this.pageSize), page: String(page), ...(sinceId ? { since_id: sinceId } : {}) }, what);
      const list = (Array.isArray(body[field]) ? body[field] : []) as T[];
      let older = false;
      for (const it of list) {
        const id = idOf(it);
        if (!id) continue;
        if (!top || idGreater(id, top)) top = id;
        if (!isAfter(isoOf(it.created_at, this.now()), since)) {
          older = true;
          continue;
        }
        items.push(it);
      }
      if (older || list.length < this.pageSize) break;
    }
    if (top) this.cursors.set(key, top);
    return items;
  }

  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, () => this.replyOnce(account, input.parentExternalId, input.text));
  }

  /**
   * Parent is a comment → comments/reply (cid + the status id); parent is a status → comments/create. Accepts
   * "<statusId>:<commentId>" too. A comment's status comes from fetchActivity, else comments/show_batch.
   */
  private async replyOnce(account: AccountRef, parent: string, text: string): Promise<PublishResult> {
    const auth = this.auth(account);
    if (!text.trim()) throw new ConnectorError("weibo reply: empty text", "rejected", false);
    let statusId: string | undefined;
    let commentId: string | undefined;
    if (parent.includes(":")) [statusId, commentId] = parent.split(":", 2) as [string, string];
    else if (this.commentStatus.has(parent)) {
      commentId = parent;
      statusId = this.commentStatus.get(parent);
    } else {
      const found = await this.get<unknown>(auth, "/comments/show_batch.json", { cids: parent }, "comments/show_batch").catch((e: unknown) => {
        if (e instanceof ConnectorError && e.kind === "rejected") return [];
        throw e;
      });
      const c = (Array.isArray(found) ? found : ((found as { comments?: unknown[] } | undefined)?.comments ?? []))[0] as WeiboComment | undefined;
      if (c && idOf(c) === parent && idOf(c.status)) {
        commentId = parent;
        statusId = idOf(c.status);
      } else statusId = parent;
    }
    const form = new URLSearchParams({ access_token: auth.accessToken, comment: text, id: statusId! });
    let created: WeiboComment;
    if (commentId) {
      form.set("cid", commentId);
      created = (await this.send("POST", `${this.baseUrl}/comments/reply.json`, form, "comments/reply")) as WeiboComment;
    } else {
      created = (await this.send("POST", `${this.baseUrl}/comments/create.json`, form, "comments/create")) as WeiboComment;
    }
    const id = idOf(created);
    if (!id) throw new ConnectorError("weibo reply: response had no comment id", "unknown", false, created);
    if (statusId) this.commentStatus.set(id, statusId);
    return { externalId: id, url: weiboStatusUrl(created.status, auth.uid), raw: created };
  }

  /** Only `delete` exists: comments/destroy removes a comment you wrote or one on your own post. */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    if (input.action !== "delete") throw new ConnectorError(`weibo: '${input.action}' is not available through Weibo's API; only deleting a comment is`, "rejected", false);
    const auth = this.auth(account);
    const cid = input.externalId.includes(":") ? input.externalId.split(":", 2)[1]! : input.externalId;
    await this.send("POST", `${this.baseUrl}/comments/destroy.json`, new URLSearchParams({ access_token: auth.accessToken, cid }), "comments/destroy");
    this.commentStatus.delete(cid);
  }

  // ---- metrics ----------------------------------------------------------------------------

  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    if (externalIds.length === 0) return [];
    const auth = this.auth(account);
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    for (let i = 0; i < externalIds.length; i += WEIBO_LIMITS.countBatch) {
      const batch = externalIds.slice(i, i + WEIBO_LIMITS.countBatch);
      const rows = await this.get<unknown>(auth, "/statuses/count.json", { ids: batch.join(",") }, "statuses/count");
      for (const r of (Array.isArray(rows) ? rows : []) as { id?: number | string; idstr?: string; reposts?: number; comments?: number; attitudes?: number }[]) {
        const id = idOf(r);
        if (!id || !batch.includes(id)) continue;
        const row = (metric: MetricName, value: number | undefined): MetricInput[] => (typeof value === "number" ? [{ entityType: "post_variant", entityId: id, metric, value, observedAt, source: "weibo" }] : []);
        out.push(...row("reposts", r.reposts), ...row("replies", r.comments), ...row("likes", r.attitudes), ...row("engagements", (r.reposts ?? 0) + (r.comments ?? 0) + (r.attitudes ?? 0)));
      }
    }
    return out;
  }

  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = this.auth(account);
    const u = await this.get<WeiboUser>(auth, "/users/show.json", { uid: auth.uid }, "users/show");
    if (typeof u.followers_count !== "number") return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: u.followers_count, observedAt: this.now().toISOString(), source: "weibo" }];
  }

  // ---- transport --------------------------------------------------------------------------

  private auth(account: AccountRef): WeiboAuth {
    const parsed = WeiboAuth.safeParse(account.auth ?? {});
    if (!parsed.success) throw new ConnectorError(`weibo account ${account.handle}: auth needs accessToken and uid`, "auth", false);
    const exp = parsed.data.expiresAt ? Date.parse(parsed.data.expiresAt) : NaN;
    if (Number.isFinite(exp) && exp <= this.now().getTime()) {
      throw new ConnectorError(`weibo account ${account.handle}: the token expired on ${parsed.data.expiresAt}; reconnect the account (Weibo issues no refresh tokens)`, "auth", false);
    }
    return parsed.data;
  }

  private async get<T>(auth: WeiboAuth, path: string, query: Record<string, string>, what: string): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("access_token", auth.accessToken);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return (await this.send("GET", url.toString(), undefined, what)) as T;
  }

  /** One request. Error messages never include the URL (it carries the access token). */
  private async send(method: "GET" | "POST", url: string, body: URLSearchParams | FormData | undefined, what: string): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body instanceof URLSearchParams) headers["content-type"] = "application/x-www-form-urlencoded";
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(url, { method, headers, ...(body !== undefined ? { body: body instanceof URLSearchParams ? body.toString() : body } : {}) });
    } catch (err) {
      throw asNetworkError(err instanceof Error ? new Error(err.message.replace(/access_token=[^&\s]+/g, "access_token=***")) : err, `weibo ${what}`);
    }
    const parsed = parseWeiboJson(await res.text().catch(() => ""));
    const err = parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error_code" in parsed;
    if (!res.ok || err) throw mapWeiboError(res.status, parsed, what);
    return parsed ?? {};
  }
}

function extFor(mime: string): string {
  return mime === "image/png" ? "png" : mime === "image/gif" ? "gif" : "jpg";
}

export function createWeiboConnectors(env: NodeJS.ProcessEnv): Connector[] {
  const fallback = clientFromEnv(env, "WEIBO");
  const appKey = env.WEIBO_APP_KEY || fallback.clientId;
  const appSecret = env.WEIBO_APP_SECRET || fallback.clientSecret;
  const scopes = env.WEIBO_SCOPES?.split(/[\s,]+/).filter(Boolean);
  return [
    new WeiboConnector({
      ...(appKey ? { appKey } : {}),
      ...(appSecret ? { appSecret } : {}),
      ...(env.WEIBO_SECURITY_DOMAIN ? { securityDomain: env.WEIBO_SECURITY_DOMAIN } : {}),
      ...(scopes && scopes.length > 0 ? { scopes } : {}),
      ...(env.WEIBO_API_BASE ? { baseUrl: env.WEIBO_API_BASE } : {}),
    }),
  ];
}
