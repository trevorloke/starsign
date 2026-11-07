import { AppBskyRichtextFacet, AtpAgent, AtUri, BlobRef, jsonToLex, RichText } from "@atproto/api";
import type { AppBskyActorDefs, AppBskyEmbedImages, AppBskyFeedDefs, AppBskyFeedPost, AppBskyNotificationListNotifications, AppBskyVideoDefs, Facet } from "@atproto/api";
import type { ActivityInput, ActivityKind, Media, MetricInput, MetricName, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, downloadMedia, isAfter, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource, rawBody, sendBody, withMedia, type StreamBody } from "./media-io.ts";
import type { AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, ModerationInput, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/** Decrypted credential blob for a Bluesky account: an app password, never the main password. */
export const BlueskyAuth = z.object({
  identifier: z.string().min(1),
  appPassword: z.string().min(1),
  service: z.string().url().default("https://bsky.social"),
});
export type BlueskyAuth = z.infer<typeof BlueskyAuth>;

export type BlueskyPostRecord = Parameters<AtpAgent["post"]>[0];

/**
 * The slice of `AtpAgent` this adapter actually uses. Narrowing it lets tests inject a fake that
 * never logs in, and keeps the adapter honest about which XRPC calls it depends on.
 */
export interface BlueskyAgentLike {
  login(opts: { identifier: string; password: string }): Promise<unknown>;
  readonly session?: { did: string; handle: string } | undefined;
  resolveHandle(params: { handle: string }): Promise<{ data: { did: string } }>;
  uploadBlob(data: Uint8Array, opts?: { encoding?: string }): Promise<{ data: { blob: BlobRef } }>;
  post(record: BlueskyPostRecord): Promise<{ uri: string; cid: string }>;
  getPosts(params: { uris: string[] }): Promise<{ data: { posts: AppBskyFeedDefs.PostView[] } }>;
  getAuthorFeed(params: { actor: string; limit?: number; cursor?: string; filter?: string }): Promise<{ data: { feed: AppBskyFeedDefs.FeedViewPost[]; cursor?: string } }>;
  listNotifications(params: { limit?: number; cursor?: string }): Promise<{ data: { notifications: AppBskyNotificationListNotifications.Notification[]; cursor?: string } }>;
  // Optional so narrow fakes stay small; the production wrapper around AtpAgent provides all of them.
  /** The account's PDS (resolved from its DID document after login); the video service token is minted for it. */
  readonly pdsUrl?: URL | string | undefined;
  getServiceAuth?(params: { aud: string; lxm?: string; exp?: number }): Promise<{ data: { token: string } }>;
  like?(uri: string, cid: string): Promise<{ uri: string; cid: string }>;
  deleteLike?(likeUri: string): Promise<void>;
  deletePost?(postUri: string): Promise<void>;
  getProfile?(params: { actor: string }): Promise<{ data: AppBskyActorDefs.ProfileViewDetailed }>;
}

/** Adapt a real AtpAgent to the narrow surface (service auth lives under com.atproto.server). */
export function atpAgentLike(agent: AtpAgent): BlueskyAgentLike {
  return {
    login: (o) => agent.login(o),
    get session() {
      return agent.session;
    },
    get pdsUrl() {
      return agent.pdsUrl ?? agent.serviceUrl;
    },
    resolveHandle: (p) => agent.resolveHandle(p),
    uploadBlob: (d, o) => agent.uploadBlob(d, o),
    post: (r) => agent.post(r),
    getPosts: (p) => agent.getPosts(p),
    getAuthorFeed: (p) => agent.getAuthorFeed(p),
    listNotifications: (p) => agent.listNotifications(p),
    getServiceAuth: (p) => agent.com.atproto.server.getServiceAuth(p),
    like: (uri, cid) => agent.like(uri, cid),
    deleteLike: (uri) => agent.deleteLike(uri),
    deletePost: (uri) => agent.deletePost(uri),
    getProfile: (p) => agent.getProfile(p),
  };
}

export interface BlueskyConnectorOptions {
  /** Builds the agent for a PDS/entryway URL. Tests inject a fake; production gets a real `AtpAgent`. */
  agentFactory?: (service: string) => BlueskyAgentLike;
  /** Used to download media before re-uploading it as a blob. Defaults to the global fetch. */
  fetch?: FetchLike;
  now?: () => Date;
  /** Upper bound on pages (100 items each) walked per feed when `since` is far back or null. */
  maxPages?: number;
  /** Bluesky's video service (default https://video.bsky.app). */
  videoService?: string;
  /** DID of the video service, used as the audience when polling job status (default did:web:video.bsky.app). */
  videoServiceDid?: string;
  /** Job status checks before giving up with a retryable error (default 60, about 2 minutes at 2s). */
  maxProcessingChecks?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Build app.bsky.embed.external link cards by reading the linked page's Open Graph tags (default true). */
  linkCards?: boolean;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/i;

/** First match of a meta tag's content, property= or name= in either attribute order. */
function metaContent(html: string, key: string): string | undefined {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["']`, "i");
  const v = html.match(re1)?.[1] ?? html.match(re2)?.[1];
  return v ? decodeEntities(v).trim() : undefined;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'");
}

/** The raw JSON blob from the video service, turned into a BlobRef the record serializer understands. */
function toBlobRef(raw: unknown): BlobRef {
  try {
    const lex = jsonToLex(raw);
    if (lex instanceof BlobRef) return lex;
    return BlobRef.asBlobRef(lex) ?? (raw as BlobRef);
  } catch {
    return raw as BlobRef;
  }
}

interface Session {
  identifier: string;
  service: string;
  agent: BlueskyAgentLike;
  did: string;
  handle: string;
}

type StrongRef = { uri: string; cid: string };

const NOTIFICATION_KINDS: Record<string, ActivityKind> = {
  mention: "mention",
  reply: "reply",
  quote: "quote",
  repost: "repost",
  "repost-via-repost": "repost",
  like: "like",
  "like-via-repost": "like",
  follow: "follow",
};

/** XRPC error names that mean the session is dead or the account cannot act, whatever the HTTP status. */
const AUTH_ERROR_NAMES = new Set(["AuthenticationRequired", "ExpiredToken", "InvalidToken", "AuthMissing", "AuthFactorTokenRequired", "AccountTakedown", "AccountSuspended", "AccountDeactivated"]);

/** Web URL for a post. Returns null for a malformed at-uri rather than fabricating a link. */
export function blueskyPostUrl(handle: string, atUri: string): string | null {
  try {
    return `https://bsky.app/profile/${handle}/post/${new AtUri(atUri).rkey}`;
  } catch {
    return null;
  }
}

/**
 * Normalize whatever the AT Protocol client throws. XRPCError carries a numeric `status`
 * (HTTP code, or 1 for "no response"), so we duck-type on that instead of `instanceof` to stay
 * robust to duplicated package copies and to fakes in tests.
 */
export function mapBlueskyError(err: unknown, phase: "login" | "call" = "call"): ConnectorError {
  if (err instanceof ConnectorError) return err;
  const e = (typeof err === "object" && err !== null ? err : {}) as { status?: unknown; error?: unknown; message?: unknown; headers?: Record<string, string | undefined> };
  const message = typeof e.message === "string" ? e.message : String(err);
  const name = typeof e.error === "string" ? e.error : "";
  const status = typeof e.status === "number" ? e.status : undefined;
  const wrap = (kind: ConnectorError["kind"], retryable: boolean, detail = message) => new ConnectorError(`bluesky ${phase}: ${detail}`, kind, retryable, err);

  // Not an XRPC error: fetch itself failed (DNS, reset, timeout) or something unexpected threw.
  if (status === undefined) return err instanceof TypeError ? wrap("network", true) : wrap("unknown", false);
  if (status === 429 || name === "RateLimitExceeded") {
    const reset = e.headers?.["ratelimit-reset"];
    return wrap("rate_limit", true, reset ? `${message} (ratelimit-reset=${reset})` : message);
  }
  if (status === 401 || status === 403 || AUTH_ERROR_NAMES.has(name)) return wrap("auth", false);
  // While logging in, every client error is a credential problem (bad app password, 2FA required).
  if (phase === "login" && status >= 400 && status < 500) return wrap("auth", false);
  if (status === 1 || status >= 500) return wrap("network", true);
  if (status >= 400) return wrap("rejected", false);
  return wrap("unknown", false);
}

/**
 * Native Bluesky adapter over the AT Protocol.
 *
 * Idempotency: Bluesky has no server-side idempotency key, so publish results are cached in memory
 * by idempotencyKey (see IdempotencyCache for the restart caveat), and a thread that fails part-way
 * resumes from the last segment that made it onto the network instead of re-posting the root.
 */
export class BlueskyConnector implements Connector {
  readonly connectMethod = "app_password" as const;
  readonly credentialInputs = [
    { key: "identifier", label: "Handle", placeholder: "you.bsky.social" },
    { key: "appPassword", label: "App password", placeholder: "xxxx-xxxx-xxxx-xxxx", secret: true },
  ] as const;

  /** Connect from the room's form: verify the app password and return the account. */
  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const auth = { identifier: (p.inputs.identifier ?? "").trim().replace(/^@/, ""), appPassword: (p.inputs.appPassword ?? "").trim(), ...(p.inputs.service ? { service: p.inputs.service } : {}) };
    const identity = await this.describeAccount(auth);
    return [{ network: "bluesky", identity, auth }];
  }

  /** Log in with the app password and read the account's DID and handle. Throws ConnectorError("auth") on bad credentials. */
  async describeAccount(rawAuth: Record<string, unknown>) {
    const parsed = BlueskyAuth.safeParse(rawAuth);
    if (!parsed.success) throw new ConnectorError("bluesky: identifier and appPassword are required", "auth", false, parsed.error);
    const agent = this.agentFactory(parsed.data.service);
    try {
      await agent.login({ identifier: parsed.data.identifier, password: parsed.data.appPassword });
    } catch (err) {
      throw mapBlueskyError(err, "login");
    }
    const session = agent.session;
    if (!session?.did) throw new ConnectorError("bluesky: login succeeded but no session was returned", "unknown", true);
    return { externalId: session.did, handle: session.handle, displayName: null };
  }

  readonly name = "bluesky";
  readonly networks: readonly Network[] = ["bluesky"];

  private readonly agentFactory: (service: string) => BlueskyAgentLike;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly maxPages: number;
  private readonly sessions = new Map<string, Session>();
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  private readonly progress = new Map<string, StrongRef[]>();
  /** Embeds already built for an idempotency key, so a retry after "video still processing" does not re-upload. */
  private readonly embeds = new Map<string, Promise<BlueskyPostRecord["embed"] | undefined>>();
  private readonly videoService: string;
  private readonly videoServiceDid: string;
  private readonly maxProcessingChecks: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly linkCards: boolean;
  /** Set by core at boot; falls back to downloading `media.url`. */
  media?: MediaFetcher;

  constructor(opts: BlueskyConnectorOptions = {}) {
    this.fetchImpl = opts.fetch;
    this.agentFactory = opts.agentFactory ?? ((service) => atpAgentLike(new AtpAgent({ service, ...(opts.fetch ? { fetch: opts.fetch } : {}) })));
    this.now = opts.now ?? (() => new Date());
    this.maxPages = opts.maxPages ?? 10;
    this.videoService = (opts.videoService ?? "https://video.bsky.app").replace(/\/+$/, "");
    this.videoServiceDid = opts.videoServiceDid ?? "did:web:video.bsky.app";
    this.maxProcessingChecks = opts.maxProcessingChecks ?? 60;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.linkCards = opts.linkCards ?? true;
  }

  capabilities(): ConnectorCapabilities {
    return { publish: true, fetchActivity: true, fetchMetrics: true, meteredReads: false, reply: true, moderate: true, accountMetrics: true, webhooks: false, video: true, kinds: ["post", "video", "link"] };
  }

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const videos = input.media.filter((m) => m.kind === "video");
    for (const m of input.media) {
      if (m.kind === "document") issues.push({ code: "unsupported_media", message: "bluesky has no document attachments" });
      if (m.kind === "video" && m.mime && m.mime !== "video/mp4") issues.push({ code: "unsupported_media", message: `bluesky video must be MP4 (got ${m.mime})` });
    }
    if (videos.length > 0 && input.media.length > 1) issues.push({ code: "too_many_media", message: "bluesky allows one video per post, and it cannot be mixed with images" });
    if (input.options?.poll) issues.push({ code: "unsupported_media", message: "bluesky has no native polls" });
    return issues;
  }

  /** Reply to a post: the parent's thread root is looked up so the reply lands in the right thread. */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.publish(account, { variantId: input.idempotencyKey, text: input.text, media: [], thread: [], replyToExternalId: input.parentExternalId, idempotencyKey: input.idempotencyKey, options: {} });
  }

  /**
   * like/unlike (app.bsky.feed.like records) and delete our own post. Bluesky has no per-reply hide in this
   * adapter (threadgate hiddenReplies is not wired), so hide/unhide are refused.
   */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    await this.call(account, async (s) => {
      const { agent } = s;
      if (input.action === "hide" || input.action === "unhide") throw new ConnectorError(`bluesky moderate: ${input.action} is not supported`, "rejected", false);
      if (input.action === "delete") {
        let repo: string;
        try {
          repo = new AtUri(input.externalId).hostname;
        } catch {
          throw new ConnectorError(`bluesky moderate: ${input.externalId} is not an at:// uri`, "rejected", false);
        }
        if (repo !== s.did) throw new ConnectorError("bluesky moderate: only the account's own posts can be deleted", "rejected", false);
        if (!agent.deletePost) throw new ConnectorError("bluesky moderate: agent cannot delete posts", "unknown", false);
        await agent.deletePost(input.externalId);
        return;
      }
      const res = await agent.getPosts({ uris: [input.externalId] });
      const post = res.data.posts[0];
      if (!post) throw new ConnectorError(`bluesky moderate: post ${input.externalId} not found`, "rejected", false);
      if (input.action === "like") {
        if (post.viewer?.like) return; // already liked
        if (!agent.like) throw new ConnectorError("bluesky moderate: agent cannot like", "unknown", false);
        await agent.like(post.uri, post.cid);
        return;
      }
      if (!post.viewer?.like) return; // nothing to unlike
      if (!agent.deleteLike) throw new ConnectorError("bluesky moderate: agent cannot unlike", "unknown", false);
      await agent.deleteLike(post.viewer.like);
    });
  }

  /** followers_total from app.bsky.actor.getProfile. */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    return this.call(account, async (s) => {
      if (!s.agent.getProfile) return [];
      const res = await s.agent.getProfile({ actor: s.did });
      const followers = res.data.followersCount;
      if (typeof followers !== "number") return [];
      return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: followers, observedAt: this.now().toISOString(), source: "bluesky" }];
    });
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, () => this.call(account, (s) => this.publishSegments(s, input)));
  }

  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    return this.call(account, async (s) => {
      const items = [...(await this.notifications(s, since)), ...(await this.ownPosts(s, since))];
      return items.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    });
  }

  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    if (externalIds.length === 0) return [];
    return this.call(account, async (s) => {
      const out: MetricInput[] = [];
      const observedAt = this.now().toISOString();
      // getPosts accepts at most 25 uris per call.
      for (let i = 0; i < externalIds.length; i += 25) {
        const res = await s.agent.getPosts({ uris: externalIds.slice(i, i + 25) });
        for (const p of res.data.posts) {
          const row = (metric: MetricName, value: number): MetricInput => ({ entityType: "post_variant", entityId: p.uri, metric, value, observedAt, source: "bluesky" });
          const likes = p.likeCount ?? 0;
          const reposts = p.repostCount ?? 0;
          const replies = p.replyCount ?? 0;
          const quotes = p.quoteCount ?? 0;
          out.push(row("likes", likes), row("reposts", reposts), row("replies", replies), row("quotes", quotes), row("engagements", likes + reposts + replies + quotes));
          if (typeof p.bookmarkCount === "number") out.push(row("saves", p.bookmarkCount));
        }
      }
      return out;
    });
  }

  // ---- publishing -------------------------------------------------------------------------

  private async publishSegments(s: Session, input: PublishInput): Promise<PublishResult> {
    const { agent } = s;
    const key = input.idempotencyKey;
    const segments = [input.text, ...input.thread];
    // Segments already on the network from an earlier, failed attempt are not posted again.
    const posted: StrongRef[] = this.progress.get(key) ?? [];
    const replyTo = input.replyToExternalId ? await this.replyRefs(agent, input.replyToExternalId) : undefined;
    // Media only rides on the root post, so there is nothing to upload when resuming past it.
    const embed = posted.length === 0 ? await this.rootEmbed(s, input) : undefined;

    try {
      for (let i = posted.length; i < segments.length; i++) {
        const rt = await this.richText(agent, segments[i] ?? "");
        const prev = posted[posted.length - 1];
        const root = replyTo?.root ?? posted[0];
        const reply: AppBskyFeedPost.ReplyRef | undefined = prev && root ? { root, parent: prev } : replyTo;
        const record: BlueskyPostRecord = {
          $type: "app.bsky.feed.post",
          text: rt.text,
          createdAt: this.now().toISOString(),
          ...(rt.facets ? { facets: rt.facets } : {}),
          ...(reply ? { reply } : {}),
          ...(i === 0 && embed ? { embed } : {}),
        };
        posted.push(await agent.post(record));
        this.progress.set(key, posted);
      }
    } catch (err) {
      // Part of the thread is live: tell core which posts exist so the variant is never an orphan on the network.
      const live = posted[0];
      if (live) {
        const ce = err instanceof ConnectorError ? err : mapBlueskyError(err, "call");
        ce.partial = { externalId: live.uri, url: blueskyPostUrl(s.handle, live.uri), threadExternalIds: posted.map((p) => p.uri) };
        throw ce;
      }
      throw err;
    }

    const rootPost = posted[0];
    if (!rootPost) throw new ConnectorError("bluesky publish: nothing to post", "rejected", false);
    this.progress.delete(key);
    this.embeds.delete(key);
    this.videoJobs.delete(key);
    return {
      externalId: rootPost.uri,
      url: blueskyPostUrl(s.handle, rootPost.uri),
      // Every post of the thread in order, root included, so metrics can follow each segment.
      ...(input.thread.length > 0 ? { threadExternalIds: posted.map((p) => p.uri) } : {}),
      raw: { posts: posted },
    };
  }

  /**
   * Facets make links clickable and mentions/hashtags real. `RichText.detectFacets()` wants a full
   * client for handle resolution; we resolve through our narrow agent surface instead so the fake in
   * tests stays small. A mention whose handle does not resolve is left as plain text rather than
   * shipping a facet the PDS would reject.
   */
  private async richText(agent: BlueskyAgentLike, text: string): Promise<{ text: string; facets: Facet[] | undefined }> {
    const rt = new RichText({ text });
    rt.detectFacetsWithoutResolution();
    const facets: Facet[] = [];
    for (const facet of rt.facets ?? []) {
      let keep = true;
      for (const feature of facet.features) {
        if (!AppBskyRichtextFacet.isMention(feature)) continue;
        const did = await agent
          .resolveHandle({ handle: feature.did })
          .then((r) => r.data.did)
          .catch(() => undefined);
        if (!did) {
          keep = false;
          break;
        }
        feature.did = did;
      }
      if (keep) facets.push(facet);
    }
    return { text: rt.text, facets: facets.length > 0 ? facets : undefined };
  }

  /**
   * The root post's embed: a video, else images, else a link card. Built once per idempotency key: a video
   * that is still processing when the bounded wait ends is polled again on retry, not uploaded twice.
   */
  private async rootEmbed(s: Session, input: PublishInput): Promise<BlueskyPostRecord["embed"] | undefined> {
    const key = input.idempotencyKey;
    const video = input.media.find((m) => m.kind === "video");
    if (video) {
      let job = this.videoJobs.get(key);
      if (!job) {
        job = await this.uploadVideo(s, video);
        this.videoJobs.set(key, job);
      }
      const blob = await this.waitForVideo(s, job);
      const embed: BlueskyPostRecord["embed"] = {
        $type: "app.bsky.embed.video",
        video: blob,
        ...(video.alt ? { alt: video.alt } : {}),
        ...(video.width && video.height ? { aspectRatio: { width: video.width, height: video.height } } : {}),
      };
      return embed;
    }
    let pending = this.embeds.get(key);
    if (!pending) {
      pending = this.uploadImages(s.agent, input.media).then((e) => e ?? this.linkCard(s.agent, input));
      this.embeds.set(key, pending);
      pending.catch(() => this.embeds.delete(key));
    }
    return pending;
  }

  private readonly videoJobs = new Map<string, string>();

  private async bytesOf(m: Media): Promise<{ bytes: Uint8Array; mime: string }> {
    return this.media ? this.media.fetch(m) : downloadMedia(resolveFetch(this.fetchImpl), m);
  }

  /**
   * Upload straight to the video service: a service token from the PDS (aud = did:web:<pds host>,
   * lxm = com.atproto.repo.uploadBlob), then POST app.bsky.video.uploadVideo?did=&name=. Returns the job id.
   * TODO(verify): 409 "already_exists" bodies carry the existing jobId at the top level.
   */
  private async uploadVideo(s: Session, m: Media): Promise<string> {
    const { agent } = s;
    if (!agent.getServiceAuth) throw new ConnectorError("bluesky video: agent cannot mint service auth", "unknown", false);
    const pds = new URL(String(agent.pdsUrl ?? s.service));
    const exp = Math.floor(this.now().getTime() / 1000) + 30 * 60;
    const token = (await agent.getServiceAuth({ aud: `did:web:${pds.hostname}`, lxm: "com.atproto.repo.uploadBlob", exp })).data.token;
    // The video service takes the whole file in one request: it is sent as a streamed body with an exact
    // Content-Length (read piece by piece), so the file is never held in memory.
    const body = await withMedia(mediaSource(this.media, this.fetchImpl), m, (file) => {
      const url = new URL(`${this.videoService}/xrpc/app.bsky.video.uploadVideo`);
      url.searchParams.set("did", s.did);
      url.searchParams.set("name", `${this.now().getTime().toString(36)}.mp4`);
      return this.videoRequest(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "video/mp4" } }, "uploadVideo", [409], rawBody(file, "video/mp4"));
    });
    const b = (body ?? {}) as { jobStatus?: AppBskyVideoDefs.JobStatus; jobId?: string };
    const jobId = b.jobStatus?.jobId ?? b.jobId;
    if (!jobId) throw new ConnectorError("bluesky video: uploadVideo returned no job id", "unknown", false, body);
    return jobId;
  }

  /** Poll app.bsky.video.getJobStatus until the blob is ready; bounded, then a retryable error. */
  private async waitForVideo(s: Session, jobId: string): Promise<BlobRef> {
    for (let i = 0; i < this.maxProcessingChecks; i++) {
      const url = new URL(`${this.videoService}/xrpc/app.bsky.video.getJobStatus`);
      url.searchParams.set("jobId", jobId);
      const body = (await this.videoRequest(url, { method: "GET" }, "getJobStatus")) as { jobStatus?: AppBskyVideoDefs.JobStatus } | undefined;
      const st = body?.jobStatus;
      if (st?.state === "JOB_STATE_FAILED") throw new ConnectorError(`bluesky video: processing failed (${st.failureCode ?? st.error ?? "unknown"}${st.message ? `: ${st.message}` : ""})`, "rejected", false, body);
      if (st?.blob) return toBlobRef(st.blob);
      await this.sleep(2000);
    }
    throw new ConnectorError(`bluesky video: job ${jobId} still processing after ${this.maxProcessingChecks} checks; retry later (the upload is kept)`, "unknown", true);
  }

  private async videoRequest(url: URL, init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> }, what: string, okStatuses: number[] = [], upload?: Uint8Array | StreamBody): Promise<unknown> {
    let res: Response;
    try {
      res = upload === undefined ? await resolveFetch(this.fetchImpl)(url.toString(), init) : await sendBody(resolveFetch(this.fetchImpl), url.toString(), init, upload);
    } catch (err) {
      throw asNetworkError(err, `bluesky video ${what}`);
    }
    const body = await readJson(res);
    if (!res.ok && !okStatuses.includes(res.status)) {
      const b = (body ?? {}) as { error?: unknown; message?: unknown };
      const detail = [b.error, b.message].filter((x) => typeof x === "string").join(": ");
      if (res.status === 429) throw new ConnectorError(`bluesky video ${what}: rate limited ${detail} (ratelimit-reset=${res.headers.get("ratelimit-reset") ?? "?"})`, "rate_limit", true, body);
      const { kind, retryable } = classifyHttpStatus(res.status);
      throw new ConnectorError(`bluesky video ${what}: HTTP ${res.status} ${detail}`.trim(), kind, retryable, body);
    }
    return body;
  }

  /**
   * An app.bsky.embed.external card for options.link, or the first link in the text. Title, description and
   * thumbnail come from the page's Open Graph tags (options.title / options.thumbnailUrl win). Best effort:
   * when the page cannot be read the post goes out without a card (the link facet still works).
   */
  private async linkCard(agent: BlueskyAgentLike, input: PublishInput): Promise<BlueskyPostRecord["embed"] | undefined> {
    if (!this.linkCards) return undefined;
    const uri = input.options?.link ?? input.text.match(URL_IN_TEXT)?.[0];
    if (!uri) return undefined;
    const fetchImpl = resolveFetch(this.fetchImpl);
    let html = "";
    try {
      const res = await fetchImpl(uri, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(5000) });
      if (res.ok && (res.headers.get("content-type") ?? "text/html").includes("html")) html = (await res.text()).slice(0, 500_000);
    } catch {
      // unreadable page: fall through with whatever options give us
    }
    const title = input.options?.title ?? metaContent(html, "og:title") ?? metaContent(html, "twitter:title") ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
    if (!title && !html) return undefined;
    const description = metaContent(html, "og:description") ?? metaContent(html, "description") ?? "";
    const imageUrl = input.options?.thumbnailUrl ?? metaContent(html, "og:image") ?? metaContent(html, "twitter:image");
    let thumb: BlobRef | undefined;
    if (imageUrl) {
      try {
        const { bytes, mime } = await downloadMedia(fetchImpl, { kind: "image", url: new URL(imageUrl, uri).toString() });
        // Bluesky caps link-card thumbnails at about 1 MB.
        if (bytes.byteLength <= 1_000_000 && mime.startsWith("image/")) thumb = (await agent.uploadBlob(bytes, { encoding: mime })).data.blob;
      } catch {
        thumb = undefined;
      }
    }
    return { $type: "app.bsky.embed.external", external: { uri, title: decodeEntities(title ?? uri), description, ...(thumb ? { thumb } : {}) } };
  }

  private async uploadImages(agent: BlueskyAgentLike, media: Media[]): Promise<BlueskyPostRecord["embed"] | undefined> {
    const images = media.filter((m) => m.kind === "image" || m.kind === "gif");
    if (images.length === 0) return undefined;
    const out: AppBskyEmbedImages.Image[] = [];
    for (const m of images) {
      const { bytes, mime } = await this.bytesOf(m);
      const res = await agent.uploadBlob(bytes, { encoding: mime });
      out.push({
        image: res.data.blob,
        alt: m.alt ?? "",
        ...(m.width && m.height ? { aspectRatio: { width: m.width, height: m.height } } : {}),
      });
    }
    return { $type: "app.bsky.embed.images", images: out };
  }

  /** A reply names both its direct parent and the thread root; if the parent is itself a reply, its record already knows the root. */
  private async replyRefs(agent: BlueskyAgentLike, parentUri: string): Promise<AppBskyFeedPost.ReplyRef> {
    const res = await agent.getPosts({ uris: [parentUri] });
    const parent = res.data.posts[0];
    if (!parent) throw new ConnectorError(`bluesky publish: reply target ${parentUri} not found`, "rejected", false);
    const parentRef: StrongRef = { uri: parent.uri, cid: parent.cid };
    const recordRoot = (parent.record as { reply?: { root?: { uri?: unknown; cid?: unknown } } }).reply?.root;
    const root: StrongRef = typeof recordRoot?.uri === "string" && typeof recordRoot.cid === "string" ? { uri: recordRoot.uri, cid: recordRoot.cid } : parentRef;
    return { root, parent: parentRef };
  }

  // ---- listening --------------------------------------------------------------------------

  private async notifications(s: Session, since: Date | null): Promise<ActivityInput[]> {
    const out: ActivityInput[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const res = await s.agent.listNotifications({ limit: 100, cursor });
      const items = res.data.notifications;
      for (const n of items) {
        if (!isAfter(n.indexedAt, since)) continue;
        const kind = NOTIFICATION_KINDS[n.reason];
        if (!kind) continue; // verified, starterpack-joined, etc. are not attention events
        out.push(notificationToActivity(n, kind));
      }
      cursor = res.data.cursor;
      // Pages are newest-first: once a page's oldest item predates `since`, nothing further back qualifies.
      const oldest = items[items.length - 1];
      if (!cursor || !oldest || !isAfter(oldest.indexedAt, since)) break;
    }
    return out;
  }

  private async ownPosts(s: Session, since: Date | null): Promise<ActivityInput[]> {
    const out: ActivityInput[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const res = await s.agent.getAuthorFeed({ actor: s.did, limit: 100, cursor, filter: "posts_with_replies" });
      let sawOlder = false;
      for (const item of res.data.feed) {
        // The author feed interleaves the account's reposts of others; only records it wrote are own posts.
        if (item.reason || item.post.author.did !== s.did) continue;
        if (!isAfter(item.post.indexedAt, since)) {
          sawOlder = true;
          continue;
        }
        out.push(feedItemToActivity(item));
      }
      cursor = res.data.cursor;
      if (!cursor || res.data.feed.length === 0 || sawOlder) break;
    }
    return out;
  }

  // ---- sessions ---------------------------------------------------------------------------

  private async call<T>(account: AccountRef, fn: (s: Session) => Promise<T>): Promise<T> {
    const s = await this.agentFor(account);
    try {
      return await fn(s);
    } catch (err) {
      const mapped = mapBlueskyError(err, "call");
      // A dead session (revoked app password, failed refresh) must not be reused; the next call logs in again.
      if (mapped.kind === "auth") this.sessions.delete(account.id);
      throw mapped;
    }
  }

  /** One logged-in agent per account, re-created when credentials change or the session is gone. */
  private async agentFor(account: AccountRef): Promise<Session> {
    const auth = parseAuth(account);
    const cached = this.sessions.get(account.id);
    if (cached && cached.identifier === auth.identifier && cached.service === auth.service && cached.agent.session) return cached;
    this.sessions.delete(account.id);
    const agent = this.agentFactory(auth.service);
    try {
      await agent.login({ identifier: auth.identifier, password: auth.appPassword });
    } catch (err) {
      throw mapBlueskyError(err, "login");
    }
    const session: Session = {
      identifier: auth.identifier,
      service: auth.service,
      agent,
      did: agent.session?.did ?? account.externalId,
      handle: agent.session?.handle ?? account.handle,
    };
    this.sessions.set(account.id, session);
    return session;
  }
}

function parseAuth(account: AccountRef): BlueskyAuth {
  const parsed = BlueskyAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`bluesky account ${account.handle}: auth blob needs identifier and appPassword`, "auth", false, parsed.error);
  return parsed.data;
}

type PostRecordShape = { text?: unknown; reply?: { parent?: { uri?: unknown } } };

function parentUriOf(record: PostRecordShape): string | null {
  const uri = record.reply?.parent?.uri;
  return typeof uri === "string" ? uri : null;
}

function notificationToActivity(n: AppBskyNotificationListNotifications.Notification, kind: ActivityKind): ActivityInput {
  const record = n.record as PostRecordShape;
  const isPost = kind === "mention" || kind === "reply" || kind === "quote";
  return {
    network: "bluesky",
    kind,
    externalId: n.uri,
    authorHandle: n.author.handle,
    authorName: n.author.displayName ?? null,
    text: isPost && typeof record.text === "string" ? record.text : null,
    url: isPost ? blueskyPostUrl(n.author.handle, n.uri) : kind === "follow" ? `https://bsky.app/profile/${n.author.handle}` : null,
    // reasonSubject is the post of ours this is about (liked, reposted, replied to, quoted).
    parentExternalId: n.reasonSubject ?? parentUriOf(record),
    occurredAt: n.indexedAt,
    raw: n,
  };
}

function feedItemToActivity(item: AppBskyFeedDefs.FeedViewPost): ActivityInput {
  const { post } = item;
  const record = post.record as PostRecordShape;
  return {
    network: "bluesky",
    kind: "own_post",
    externalId: post.uri,
    authorHandle: post.author.handle,
    authorName: post.author.displayName ?? null,
    text: typeof record.text === "string" ? record.text : null,
    url: blueskyPostUrl(post.author.handle, post.uri),
    parentExternalId: parentUriOf(record),
    occurredAt: post.indexedAt,
    raw: item,
  };
}
