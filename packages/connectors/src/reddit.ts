import type { ActivityInput, ActivityKind, Media, MetricInput, MetricName, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, isAfter, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource, sendBody, setMediaFile, uploadForm, withUpload, type MediaReader } from "./media-io.ts";
import { OAuth2Client, type OAuth2Token } from "./oauth.ts";
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
 * Native Reddit adapter: OAuth 2.0 on www.reddit.com/api/v1, Data API on oauth.reddit.com.
 *
 * Every request carries the deployment's User-Agent (Reddit throttles or blocks generic ones). Reddit reports many
 * failures as HTTP 200 with `json.errors`; those are mapped like HTTP errors. No webhooks: the inbox is polled.
 *
 * Policy note (Nov 2026): Reddit closed new public Data API access requests on 2026-10-31 and plans to end remaining
 * public access in March 2027 in favour of its Developer Platform. Existing approved OAuth apps keep working for now.
 * See docs/integrations/reddit.md before relying on this connector.
 */

/**
 * identity: who is this; submit: post and comment; read: listings and /api/info; edit: delete own things;
 * history: the user's submitted listing; privatemessages: inbox + DM replies; mysubreddits: where the user can post;
 * flair: list/choose link flair; vote: like/unlike; modposts: remove/approve (only effective where the user moderates).
 */
export const REDDIT_SCOPES = ["identity", "submit", "read", "edit", "history", "privatemessages", "mysubreddits", "flair", "vote", "modposts"];

/** Placeholder the owner must replace: Reddit asks for `<platform>:<app id>:<version> (by /u/<username>)`. */
export const REDDIT_DEFAULT_USER_AGENT = "starsign/0.1 by <owner>";

export const RedditAuth = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.string().optional(),
  /** Fullname of the account, "t2_…". */
  userId: z.string().min(1),
  /** Bare username (no u/). */
  username: z.string().min(1),
  scope: z.string().optional(),
});
export type RedditAuth = z.infer<typeof RedditAuth>;

export interface RedditConnectorOptions {
  clientId?: string;
  clientSecret?: string;
  userAgent?: string;
  baseUrl?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Pages (100 items each) per listing in fetchActivity (default 3). */
  maxPages?: number;
  /** Looks at the user's newest submissions to find an image/video post after submit (default 10). */
  maxPolls?: number;
  pollIntervalMs?: number;
}

/** Reddit "thing" data for t1 (comment), t3 (link/self post) and t4 (message). */
export interface RedditThing {
  id: string;
  name: string;
  author?: string;
  body?: string;
  title?: string;
  selftext?: string;
  subject?: string;
  subreddit?: string;
  permalink?: string;
  context?: string;
  parent_id?: string | null;
  link_id?: string;
  created_utc?: number;
  was_comment?: boolean;
  type?: string;
  score?: number;
  ups?: number;
  num_comments?: number;
  num_crossposts?: number;
  upvote_ratio?: number;
  view_count?: number | null;
  url?: string;
}

interface Listing {
  kind?: string;
  data?: { after?: string | null; children?: { kind: string; data: RedditThing }[] };
}

export interface RedditHttpFailure {
  status: number;
  body: unknown;
  errors?: unknown[];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fullname(id: string, prefix: "t1" | "t3" | "t4" = "t3"): string {
  return /^t[1-6]_/.test(id) ? id : `${prefix}_${id}`;
}

function bareName(handle: string): string {
  return handle.replace(/^\/?u(ser)?\//i, "");
}

/** Reddit's rate-limit headers: X-Ratelimit-Used / -Remaining / -Reset (seconds until the window resets). */
function rateLimitInfo(headers: Headers, now: Date): string {
  const reset = headers.get("x-ratelimit-reset");
  const remaining = headers.get("x-ratelimit-remaining");
  const used = headers.get("x-ratelimit-used");
  const resetAt = reset && Number.isFinite(Number(reset)) ? new Date(now.getTime() + Number(reset) * 1000).toISOString() : "unknown";
  return `resets at ${resetAt} (x-ratelimit-reset=${reset ?? "?"}s, remaining=${remaining ?? "?"}, used=${used ?? "?"})`;
}

export function mapRedditError(status: number, headers: Headers, body: unknown, ctx: { what: string; acting: boolean; now: Date }): ConnectorError {
  const detail = typeof body === "string" ? body.slice(0, 200) : body && typeof body === "object" ? String((body as { message?: unknown; error?: unknown }).message ?? (body as { error?: unknown }).error ?? "") : "";
  const msg = `reddit ${ctx.what}: HTTP ${status}${detail ? ` ${detail}` : ""}`;
  const cause: RedditHttpFailure = { status, body };
  if (status === 429) return new ConnectorError(`${msg}; rate limit ${rateLimitInfo(headers, ctx.now)}`, "rate_limit", true, cause);
  if (status === 401) return new ConnectorError(`${msg} (token rejected or expired)`, "auth", false, cause);
  // 403 on an action usually means the subreddit refused it (banned, private, restricted, not a moderator).
  if (status === 403 && ctx.acting) return new ConnectorError(`${msg} (Reddit refused the action: banned, private/restricted subreddit, or moderator rights needed)`, "rejected", false, cause);
  const { kind, retryable } = classifyHttpStatus(status);
  return new ConnectorError(msg, kind, retryable, cause);
}

/** Map `json.errors` ([[CODE, message, field], ...]) from a 200 response. */
export function mapRedditApiErrors(errors: unknown[], what: string): ConnectorError {
  const list = errors.map((e) => (Array.isArray(e) ? e : [String(e)])) as unknown[][];
  const text = list.map((e) => `${String(e[0])}${e[1] ? `: ${String(e[1])}` : ""}${e[2] ? ` (${String(e[2])})` : ""}`).join("; ");
  const codes = list.map((e) => String(e[0]));
  const cause = { status: 200, body: errors, errors } satisfies RedditHttpFailure;
  if (codes.includes("RATELIMIT")) return new ConnectorError(`reddit ${what}: ${text}`, "rate_limit", true, cause);
  if (codes.some((c) => c === "USER_REQUIRED" || c === "INVALID_SCOPE" || c === "OAUTH2_INSUFFICIENT_SCOPE")) return new ConnectorError(`reddit ${what}: ${text}`, "auth", false, cause);
  return new ConnectorError(`reddit ${what}: ${text}`, "rejected", false, cause);
}

/** Resolve the post kind from options and media. */
export function redditPostKind(input: PublishInput): "self" | "link" | "image" | "video" | "gallery" {
  const o = input.options ?? {};
  if (o.kind === "link" || (o.link && input.media.length === 0)) return "link";
  const videos = input.media.filter((m) => m.kind === "video");
  if (videos.length > 0) return "video";
  const images = input.media.filter((m) => m.kind === "image" || m.kind === "gif");
  if (images.length > 1) return "gallery";
  if (images.length === 1) return "image";
  return "self";
}

interface PublishState {
  /** Set once Reddit accepted the submission; never submit again for this key. */
  submittedAtMs?: number;
  postName?: string;
  postUrl?: string | null;
  commentDone?: boolean;
}

export class RedditConnector implements Connector {
  readonly name = "reddit";
  readonly networks: readonly Network[] = ["reddit"];
  readonly connectMethod = "oauth" as const;
  media?: MediaFetcher;

  readonly userAgent: string;
  private readonly oauth: OAuth2Client;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxPages: number;
  private readonly maxPolls: number;
  private readonly pollIntervalMs: number;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  private readonly replies = new IdempotencyCache<PublishResult>();
  private readonly progress = new Map<string, PublishState>();

  constructor(opts: RedditConnectorOptions = {}) {
    this.userAgent = opts.userAgent || REDDIT_DEFAULT_USER_AGENT;
    this.baseUrl = (opts.baseUrl ?? "https://oauth.reddit.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxPages = opts.maxPages ?? 3;
    this.maxPolls = opts.maxPolls ?? 10;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.oauth = new OAuth2Client(
      {
        name: "reddit",
        authorizeUrl: opts.authorizeUrl ?? "https://www.reddit.com/api/v1/authorize",
        tokenUrl: opts.tokenUrl ?? "https://www.reddit.com/api/v1/access_token",
        scopes: REDDIT_SCOPES,
        scopeSeparator: " ",
        // Reddit does not support PKCE; web apps authenticate with Basic client_id:secret at the token endpoint.
        pkce: false,
        clientAuth: "basic",
        // permanent = issue a refresh token (access tokens last 1 hour).
        extraAuthorizeParams: { duration: "permanent" },
        ...(opts.clientId ? { clientId: opts.clientId } : {}),
        ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
      },
      // Reddit wants the User-Agent on the token endpoint too.
      (i, init) => resolveFetch(this.fetchImpl)(i, { ...init, headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}), "user-agent": this.userAgent } }),
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
      video: true,
      kinds: ["post", "link", "carousel", "video"],
    };
  }

  // ---- connect ----------------------------------------------------------------------------

  oauthAuthorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    return this.oauth.authorizeUrl({ state: p.state, redirectUri: p.redirectUri });
  }

  async oauthConnect(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<ConnectedAccount[]> {
    const token = await this.oauth.exchange({ code: p.code, redirectUri: p.redirectUri });
    const me = await this.me(token.accessToken);
    const auth = this.toAuth(token, me.userId, me.username);
    // A Reddit login is one user. Subreddits the user moderates are posting targets, not separate accounts.
    return [{ network: "reddit", identity: me.identity, auth }];
  }

  async describeAccount(raw: Record<string, unknown>): Promise<AccountIdentity> {
    const token = typeof raw.accessToken === "string" ? raw.accessToken : null;
    if (!token) throw new ConnectorError("reddit: accessToken is required", "auth", false);
    return (await this.me(token)).identity;
  }

  async refreshAuth(account: AccountRef): Promise<AuthRefresh | null> {
    const auth = parseAuth(account);
    if (!auth.refreshToken) return null;
    const token = await this.oauth.refresh(auth.refreshToken);
    return { auth: this.toAuth(token, auth.userId, auth.username) };
  }

  private toAuth(token: OAuth2Token, userId: string, username: string): RedditAuth {
    return {
      accessToken: token.accessToken,
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
      ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
      userId,
      username,
      ...(token.scope ? { scope: token.scope } : {}),
    };
  }

  private async me(token: string): Promise<{ identity: AccountIdentity; userId: string; username: string; raw: Record<string, unknown> }> {
    const data = await this.request<Record<string, unknown>>(token, "GET", "/api/v1/me", { what: "api/v1/me" });
    const id = typeof data.id === "string" ? data.id : undefined;
    const name = typeof data.name === "string" ? data.name : undefined;
    if (!id || !name) throw new ConnectorError("reddit api/v1/me: response had no id/name", "unknown", false, data);
    const sub = (data.subreddit ?? {}) as { title?: unknown };
    const userId = id.startsWith("t2_") ? id : `t2_${id}`;
    return { identity: { externalId: userId, handle: `u/${name}`, displayName: typeof sub.title === "string" && sub.title ? sub.title : null }, userId, username: name, raw: data };
  }

  // ---- validation -------------------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const o = input.options ?? {};
    if (!o.subreddit) issues.push({ code: "empty", message: "reddit needs a subreddit (without r/); use u_<username> to post to your profile" });
    if (!o.title?.trim()) issues.push({ code: "empty", message: "reddit posts need a title" });
    else if (o.title.length > 300) issues.push({ code: "too_long", message: "reddit titles are limited to 300 characters" });
    if (o.kind === "poll" || o.poll) issues.push({ code: "unsupported_media", message: "reddit polls are not available through the public API" });
    const kind = redditPostKind(input);
    if (kind === "link" && !o.link) issues.push({ code: "empty", message: "reddit link posts need options.link" });
    if (kind === "link" && input.media.length > 0) issues.push({ code: "unsupported_media", message: "reddit link posts cannot carry media; drop the media or the link" });
    const videos = input.media.filter((m) => m.kind === "video");
    if (videos.length > 1) issues.push({ code: "too_many_media", message: "reddit takes one video per post" });
    if (videos.length > 0 && input.media.length > videos.length) issues.push({ code: "unsupported_media", message: "reddit cannot mix video and images in one post" });
    if (videos.length > 0 && !o.thumbnailUrl) issues.push({ code: "media_required", message: "reddit video posts need a poster image (options.thumbnailUrl)" });
    for (const m of input.media) if (m.kind === "document") issues.push({ code: "unsupported_media", message: "reddit has no document posts" });
    if (input.media.filter((m) => m.kind === "image" || m.kind === "gif").length > 20) issues.push({ code: "too_many_media", message: "reddit galleries take at most 20 images" });
    return issues;
  }

  // ---- publishing -------------------------------------------------------------------------

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, () => this.publishOnce(account, parseAuth(account), input));
  }

  private async publishOnce(account: AccountRef, auth: RedditAuth, input: PublishInput): Promise<PublishResult> {
    const o = input.options ?? {};
    const sr = o.subreddit;
    const title = o.title?.trim();
    if (!sr) throw new ConnectorError("reddit publish: options.subreddit is required", "rejected", false);
    if (!title) throw new ConnectorError("reddit publish: options.title is required", "rejected", false);
    const kind = redditPostKind(input);
    const key = input.idempotencyKey;
    const state: PublishState = this.progress.get(key) ?? {};
    this.progress.set(key, state);

    if (!state.postName) {
      if (state.submittedAtMs === undefined) {
        const common: Record<string, string> = {
          sr,
          title,
          api_type: "json",
          sendreplies: "true",
          resubmit: "true",
          nsfw: String(o.nsfw === true || hasTag(o.tags, "nsfw")),
          spoiler: String(!!o.contentWarning || hasTag(o.tags, "spoiler")),
          ...(o.flairId ? { flair_id: o.flairId } : {}),
        };
        if (kind === "self" || kind === "link") {
          const form = kind === "self" ? { ...common, kind: "self", text: input.text } : { ...common, kind: "link", url: o.link ?? "" };
          const data = await this.call<{ id?: string; name?: string; url?: string }>(auth, "POST", "/api/submit", form, "submit");
          state.postName = data.name ?? (data.id ? fullname(data.id) : undefined);
          state.postUrl = data.url ?? null;
          if (!state.postName) throw new ConnectorError("reddit submit: response had no post id", "unknown", false, data);
        } else if (kind === "gallery") {
          const assets: { media_id: string; caption: string; outbound_url: string }[] = [];
          for (const m of input.media) assets.push({ media_id: (await this.uploadMedia(auth, m)).assetId, caption: (m.alt ?? "").slice(0, 180), outbound_url: "" });
          const data = await this.call<{ id?: string; name?: string; url?: string }>(auth, "POST", "/api/submit_gallery_post.json", {
            json: { sr, title, items: assets, api_type: "json", show_error_list: true, sendreplies: true, nsfw: common.nsfw === "true", spoiler: common.spoiler === "true", ...(o.flairId ? { flair_id: o.flairId } : {}) },
          }, "submit_gallery_post");
          const id = data.name ?? data.id ?? postIdFromUrl(data.url);
          if (!id) throw new ConnectorError("reddit submit_gallery_post: response had no post id or url", "unknown", false, data);
          state.postName = fullname(id);
          state.postUrl = data.url ?? null;
        } else {
          const first = input.media[0];
          if (!first) throw new ConnectorError("reddit publish: media missing", "rejected", false);
          const uploaded = await this.uploadMedia(auth, first);
          const form: Record<string, string> = { ...common, kind, url: uploaded.url };
          if (kind === "video") {
            if (!o.thumbnailUrl) throw new ConnectorError("reddit publish: video posts need options.thumbnailUrl (poster image)", "rejected", false);
            const poster = await this.uploadMedia(auth, { kind: "image", url: o.thumbnailUrl });
            form.video_poster_url = poster.url;
          }
          const startedAt = this.now().getTime();
          // TODO(verify): for kind=image/video Reddit answers with websocket_url + user_submitted_page and no post id; the id
          // arrives on the websocket. We find the post in the user's newest submissions instead (no websocket client).
          await this.call<unknown>(auth, "POST", "/api/submit", form, `submit (${kind})`);
          state.submittedAtMs = startedAt;
        }
      }
      if (!state.postName && state.submittedAtMs !== undefined) {
        const found = await this.findSubmission(auth, sr, title, state.submittedAtMs);
        if (!found) throw new ConnectorError(`reddit publish: submitted to r/${sr}, but Reddit is still processing the media; retry to keep waiting (no second post is made)`, "network", true);
        state.postName = found.name;
        state.postUrl = found.permalink ? `https://www.reddit.com${found.permalink}` : null;
      }
    }

    const postName = state.postName;
    if (!postName) throw new ConnectorError("reddit publish: no post id", "unknown", false);
    // Link/image/video/gallery posts have no body; their text is posted as the first comment, followed by options.firstComment.
    const commentText = [kind === "self" ? "" : input.text.trim(), o.firstComment?.trim() ?? ""].filter(Boolean).join("\n\n");
    if (commentText && !state.commentDone) {
      try {
        await this.comment(auth, postName, commentText);
        state.commentDone = true;
      } catch (err) {
        const ce = err instanceof ConnectorError ? err : new ConnectorError(String(err), "unknown", true, err);
        ce.partial = { externalId: postName, url: state.postUrl ?? redditPostUrl(sr, postName), threadExternalIds: [postName] };
        throw ce;
      }
    }
    this.progress.delete(key);
    return { externalId: postName, url: state.postUrl ?? redditPostUrl(sr, postName), raw: { kind, subreddit: sr } };
  }

  /** Media lease: POST /api/media/asset.json → S3 form upload → URL usable in submit (kind image/video) or asset id (gallery). */
  private async uploadMedia(auth: RedditAuth, m: Media): Promise<{ assetId: string; url: string }> {
    // Videos go to the S3 form as a streamed multipart body (exact Content-Length); images are read whole as before.
    return withUpload(mediaSource(this.media, this.fetchImpl), m, (file) => this.uploadFile(auth, m, file));
  }

  private async uploadFile(auth: RedditAuth, m: Media, file: MediaReader): Promise<{ assetId: string; url: string }> {
    const mime = file.mime;
    const filepath = (() => {
      try {
        const base = new URL(m.url).pathname.split("/").pop();
        if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base;
      } catch {
        /* fall through */
      }
      return `upload.${mime.split("/")[1] ?? "bin"}`;
    })();
    const lease = await this.call<{ args?: { action?: string; fields?: { name: string; value: string }[] }; asset?: { asset_id?: string; websocket_url?: string } }>(
      auth,
      "POST",
      "/api/media/asset.json",
      { filepath, mimetype: mime },
      "media/asset",
      { unwrap: false },
    );
    const action = lease.args?.action;
    const assetId = lease.asset?.asset_id;
    if (!action || !assetId) throw new ConnectorError("reddit media/asset: lease had no upload action or asset id", "unknown", false, lease);
    const uploadUrl = action.startsWith("//") ? `https:${action}` : action;
    const form = uploadForm([file]);
    let key = "";
    for (const f of lease.args?.fields ?? []) {
      form.set(f.name, f.value);
      if (f.name === "key") key = f.value;
    }
    setMediaFile(form, "file", file, filepath);
    let res: Response;
    try {
      res = await sendBody(resolveFetch(this.fetchImpl), uploadUrl, { method: "POST" }, form);
    } catch (err) {
      throw asNetworkError(err, "reddit media upload");
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const { kind, retryable } = classifyHttpStatus(res.status);
      throw new ConnectorError(`reddit media upload: HTTP ${res.status} ${text.slice(0, 200)}`, kind === "auth" ? "rejected" : kind, retryable, { status: res.status, body: text });
    }
    const location = /<Location>([^<]+)<\/Location>/i.exec(text)?.[1];
    const url = location ? decodeURIComponent(location) : `${uploadUrl.replace(/\/+$/, "")}/${key}`;
    return { assetId, url };
  }

  /** Find a just-submitted image/video post in the user's newest submissions (bounded polling). */
  private async findSubmission(auth: RedditAuth, sr: string, title: string, sinceMs: number): Promise<RedditThing | undefined> {
    for (let i = 0; i < this.maxPolls; i++) {
      if (i > 0) await this.sleep(this.pollIntervalMs);
      const listing = await this.request<Listing>(auth.accessToken, "GET", `/user/${auth.username}/submitted`, { what: "user/submitted", query: { sort: "new", limit: "10" } });
      const hit = (listing.data?.children ?? [])
        .map((c) => c.data)
        .find((t) => t.title === title && t.subreddit?.toLowerCase() === sr.toLowerCase() && (t.created_utc ?? 0) * 1000 >= sinceMs - 120_000);
      if (hit) return hit;
    }
    return undefined;
  }

  private async comment(auth: RedditAuth, parent: string, text: string): Promise<RedditThing> {
    const data = await this.call<{ things?: { kind: string; data: RedditThing }[] }>(auth, "POST", "/api/comment", { thing_id: parent, text }, "comment");
    const thing = data.things?.[0]?.data;
    if (!thing?.name) throw new ConnectorError("reddit comment: response had no comment id", "unknown", false, data);
    return thing;
  }

  // ---- inbox ------------------------------------------------------------------------------

  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.replies.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      if (!/^t[134]_/.test(input.parentExternalId)) throw new ConnectorError(`reddit reply: parent must be a fullname (t1_/t3_/t4_), got ${input.parentExternalId}`, "rejected", false);
      const t = await this.comment(auth, input.parentExternalId, input.text);
      return { externalId: t.name, url: t.permalink ? `https://www.reddit.com${t.permalink}` : null, raw: t };
    });
  }

  /**
   * delete → /api/del (own posts/comments only); like/unlike → /api/vote; hide/unhide → /api/remove and /api/approve,
   * which only work in subreddits the user moderates (Reddit answers 403 otherwise, mapped to "rejected").
   */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    const auth = parseAuth(account);
    const id = input.externalId;
    if (!/^t[134]_/.test(id)) throw new ConnectorError(`reddit moderate: externalId must be a fullname, got ${id}`, "rejected", false);
    switch (input.action) {
      case "delete":
        await this.call(auth, "POST", "/api/del", { id }, "del", { unwrap: false });
        return;
      case "like":
      case "unlike":
        await this.call(auth, "POST", "/api/vote", { id, dir: input.action === "like" ? "1" : "0" }, "vote", { unwrap: false });
        return;
      case "hide":
        await this.call(auth, "POST", "/api/remove", { id, spam: "false" }, "remove (moderator)", { unwrap: false });
        return;
      case "unhide":
        await this.call(auth, "POST", "/api/approve", { id }, "approve (moderator)", { unwrap: false });
        return;
    }
  }

  /** Inbox (comment replies, post replies, username mentions, DMs) + the user's own submissions. */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const inbox = await this.walk(auth, "/message/inbox", since, (kind, t) => this.inboxItem(kind, t));
    const own = await this.walk(auth, `/user/${auth.username}/submitted`, since, (_kind, t) => this.ownItem(t, auth), { sort: "new" });
    return [...inbox, ...own].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  private async walk(auth: RedditAuth, path: string, since: Date | null, map: (kind: string, t: RedditThing) => ActivityInput | null, extra: Record<string, string> = {}): Promise<ActivityInput[]> {
    const out: ActivityInput[] = [];
    let after: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const listing = await this.request<Listing>(auth.accessToken, "GET", path, { what: path, query: { limit: "100", ...extra, ...(after ? { after } : {}) } });
      const children = listing.data?.children ?? [];
      let older = false;
      for (const c of children) {
        const at = new Date((c.data.created_utc ?? 0) * 1000).toISOString();
        if (!isAfter(at, since)) {
          older = true;
          continue;
        }
        const item = map(c.kind, c.data);
        if (item) out.push(item);
      }
      after = listing.data?.after ?? undefined;
      if (older || !after || children.length === 0) break;
    }
    return out;
  }

  private inboxItem(kind: string, t: RedditThing): ActivityInput | null {
    const occurredAt = new Date((t.created_utc ?? 0) * 1000).toISOString();
    if (kind === "t4") {
      return { network: "reddit", kind: "dm", externalId: t.name, authorHandle: t.author ?? null, authorName: null, text: t.subject ? `${t.subject}\n\n${t.body ?? ""}` : (t.body ?? null), url: `https://www.reddit.com/message/messages/${t.id}`, parentExternalId: t.parent_id ?? null, occurredAt, raw: t };
    }
    if (kind !== "t1") return null;
    const k: ActivityKind = t.type === "username_mention" ? "mention" : t.type === "post_reply" ? "comment" : "reply";
    return { network: "reddit", kind: k, externalId: t.name, authorHandle: t.author ?? null, authorName: null, text: t.body ?? null, url: t.context ? `https://www.reddit.com${t.context}` : null, parentExternalId: t.parent_id ?? null, occurredAt, raw: t };
  }

  private ownItem(t: RedditThing, auth: RedditAuth): ActivityInput {
    return {
      network: "reddit",
      kind: "own_post",
      externalId: t.name,
      authorHandle: auth.username,
      authorName: null,
      text: [t.title, t.selftext].filter(Boolean).join("\n\n") || null,
      url: t.permalink ? `https://www.reddit.com${t.permalink}` : null,
      parentExternalId: null,
      occurredAt: new Date((t.created_utc ?? 0) * 1000).toISOString(),
      raw: t,
    };
  }

  // ---- metrics ----------------------------------------------------------------------------

  /** /api/info for up to 100 fullnames per call. Reddit exposes score (net votes), comments, crossposts, upvote_ratio. */
  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    if (externalIds.length === 0) return [];
    const auth = parseAuth(account);
    const back = new Map(externalIds.map((id) => [fullname(id), id] as const));
    const names = [...back.keys()];
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    for (let i = 0; i < names.length; i += 100) {
      const listing = await this.request<Listing>(auth.accessToken, "GET", "/api/info", { what: "api/info", query: { id: names.slice(i, i + 100).join(",") } });
      for (const c of listing.data?.children ?? []) {
        const t = c.data;
        const entityId = back.get(t.name) ?? t.name;
        const row = (metric: MetricName, value: number | null | undefined): MetricInput[] => (typeof value === "number" ? [{ entityType: "post_variant", entityId, metric, value, observedAt, source: "reddit" }] : []);
        out.push(...row("likes", t.score), ...row("replies", t.num_comments), ...row("reposts", t.num_crossposts), ...row("video_views", t.view_count));
        if (typeof t.score === "number" || typeof t.num_comments === "number") out.push(...row("engagements", (t.score ?? 0) + (t.num_comments ?? 0)));
        // TODO(verify): upvote_ratio has no canonical MetricName; it stays in the ledger's raw only (not emitted).
      }
    }
    return out;
  }

  /**
   * followers_total from the profile subreddit's subscriber count when Reddit returns it; total karma as
   * account-level "engagements" (Reddit has no follower count for most users, karma is the account's score).
   */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const { raw } = await this.me(auth.accessToken);
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    const sub = (raw.subreddit ?? {}) as { subscribers?: unknown };
    // TODO(verify): subreddit.subscribers on /api/v1/me is the profile's follower count.
    if (typeof sub.subscribers === "number") out.push({ entityType: "social_account", entityId: account.id, metric: "followers_total", value: sub.subscribers, observedAt, source: "reddit" });
    const karma = typeof raw.total_karma === "number" ? raw.total_karma : (Number(raw.link_karma) || 0) + (Number(raw.comment_karma) || 0);
    out.push({ entityType: "social_account", entityId: account.id, metric: "engagements", value: karma, observedAt, source: "reddit" });
    return out;
  }

  // ---- transport --------------------------------------------------------------------------

  /**
   * POST an action and unwrap `{ json: { errors, data } }`. Form bodies by default; `{ json: … }` sends JSON
   * (submit_gallery_post.json).
   */
  private async call<T>(auth: RedditAuth, method: "POST", path: string, body: Record<string, string> | { json: unknown }, what: string, opts: { unwrap?: boolean } = {}): Promise<T> {
    const res = await this.request<unknown>(auth.accessToken, method, path, { what, ...("json" in body ? { json: body.json } : { form: body }), acting: true });
    const envelope = (res && typeof res === "object" ? res : {}) as { json?: { errors?: unknown[]; data?: unknown } };
    const errors = envelope.json?.errors;
    if (Array.isArray(errors) && errors.length > 0) throw mapRedditApiErrors(errors, what);
    if (opts.unwrap === false) return res as T;
    return (envelope.json?.data ?? {}) as T;
  }

  private async request<T>(
    token: string,
    method: "GET" | "POST",
    path: string,
    opts: { what: string; query?: Record<string, string>; form?: Record<string, string>; json?: unknown; acting?: boolean },
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (method === "GET") url.searchParams.set("raw_json", "1"); // no HTML-entity escaping in bodies
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { authorization: `bearer ${token}`, "user-agent": this.userAgent, accept: "application/json" };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.form).toString();
    }
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(url.toString(), { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch (err) {
      throw asNetworkError(err, `reddit ${opts.what}`);
    }
    const data = await readJson(res);
    if (!res.ok) throw mapRedditError(res.status, res.headers, data, { what: opts.what, acting: opts.acting ?? false, now: this.now() });
    return data as T;
  }
}

function hasTag(tags: string[] | undefined, tag: string): boolean {
  return !!tags?.some((t) => t.replace(/^#/, "").toLowerCase() === tag);
}

function postIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return /\/(?:comments|gallery)\/([a-z0-9]+)/i.exec(url)?.[1];
}

export function redditPostUrl(subreddit: string, name: string): string {
  return `https://www.reddit.com/r/${subreddit}/comments/${name.replace(/^t3_/, "")}/`;
}

function parseAuth(account: AccountRef): RedditAuth {
  const raw = { ...(account.auth ?? {}) } as Record<string, unknown>;
  if (typeof raw.username !== "string" && account.handle) raw.username = bareName(account.handle);
  if (typeof raw.userId !== "string" && account.externalId) raw.userId = account.externalId;
  const parsed = RedditAuth.safeParse(raw);
  if (!parsed.success) throw new ConnectorError(`reddit account ${account.handle}: auth blob needs accessToken`, "auth", false, parsed.error);
  return parsed.data;
}

export function createRedditConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [
    new RedditConnector({
      ...(env.REDDIT_CLIENT_ID ? { clientId: env.REDDIT_CLIENT_ID } : {}),
      ...(env.REDDIT_CLIENT_SECRET ? { clientSecret: env.REDDIT_CLIENT_SECRET } : {}),
      ...(env.REDDIT_USER_AGENT ? { userAgent: env.REDDIT_USER_AGENT } : {}),
    }),
  ];
}
