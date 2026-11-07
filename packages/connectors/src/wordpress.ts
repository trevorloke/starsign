import type { ActivityInput, Media, MetricInput, Network, VariantOptions } from "@starsign/schema";
import { z } from "zod";
import { firstParagraph, htmlToText, httpFailure, normalizeSiteUrl, siteKey, textToHtml, uploadFileName, escapeHtml, safeUrl } from "./html.ts";
import { asNetworkError, isoSeconds, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { mediaSource, rawBody, sendBody, withUpload, type StreamBody } from "./media-io.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, ModerationInput, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * WordPress through the core REST API (`/wp-json/wp/v2`), authenticated with an Application Password (WordPress 5.6+,
 * self-hosted, or WordPress.com Business/Commerce sites with plugins enabled). One account = one site + one user.
 *
 * External ids: a published post is its numeric post id ("123"); a comment is "<site key>#comment-<id>" (the site key
 * is "host[/path]", WordPress's own comment anchor), so comments from two sites never collide.
 *
 * WordPress.com OAuth (public-api.wordpress.com) is a later step; see docs/integrations/wordpress.md.
 */

export const WordPressAuth = z.object({
  siteUrl: z.string().url(),
  username: z.string().min(1),
  applicationPassword: z.string().min(1),
  /** "pretty": /wp-json/...; "plain": /?rest_route=... for sites without pretty permalinks. */
  restMode: z.enum(["pretty", "plain"]).default("pretty"),
});
export type WordPressAuth = z.infer<typeof WordPressAuth>;

export interface WordPressConnectorOptions {
  fetch?: FetchLike;
  now?: () => Date;
  /** Comment pages (100 each) read per status per poll. */
  maxCommentPages?: number;
}

/** Fields of a wp/v2 comment we read. */
export interface WordPressComment {
  id: number;
  post: number;
  parent: number;
  author: number;
  author_name?: string;
  author_url?: string;
  date_gmt: string;
  content?: { rendered?: string };
  link?: string;
  status?: string;
}

interface WordPressUser {
  id: number;
  name?: string;
  slug?: string;
  username?: string;
  roles?: string[];
  capabilities?: Record<string, boolean>;
}

/** Starsign visibility → WordPress post status. public (default) publishes; private is WordPress's native private post; unlisted/direct save a draft. */
export function wordpressStatus(o: VariantOptions): "publish" | "private" | "draft" {
  const v = o.visibility ?? (o.privacy === "private" || o.privacy === "self" ? "private" : o.privacy === "unlisted" ? "unlisted" : undefined);
  if (v === "private") return "private";
  if (v === "unlisted" || v === "direct") return "draft";
  return "publish";
}

/** "<site>#comment-12", "comment-12" or "12" → 12. */
export function wordpressCommentId(externalId: string): number | null {
  const m = externalId.match(/(?:^|#)comment-(\d+)$/) ?? externalId.match(/^(\d+)$/);
  return m?.[1] ? Number(m[1]) : null;
}

function wpError(prefix: string, status: number, body: unknown, headers: Headers, now: Date): ConnectorError {
  const b = (typeof body === "object" && body !== null ? body : {}) as { code?: unknown; message?: unknown };
  const detail = typeof b.code === "string" || typeof b.message === "string" ? [b.code, b.message].filter((x) => typeof x === "string").join(": ") : typeof body === "string" ? body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "";
  const err = httpFailure(prefix, status, detail, headers, body, { now });
  if (status === 401) return new ConnectorError(`${err.message} (check the username and Application Password)`, "auth", false, err.cause);
  return err;
}

type Query = Record<string, string | number | undefined>;

export class WordPressConnector implements Connector {
  readonly name = "wordpress";
  readonly networks: readonly Network[] = ["wordpress"];
  readonly connectMethod = "app_password" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [
    { key: "siteUrl", label: "Site URL", placeholder: "https://blog.example.com" },
    { key: "username", label: "WordPress username", placeholder: "editor" },
    { key: "applicationPassword", label: "Application password (Users → Profile → Application Passwords)", placeholder: "abcd efgh ijkl mnop qrst uvwx", secret: true },
  ] as const;
  media?: MediaFetcher;

  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly maxCommentPages: number;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  /** Media already uploaded for an idempotency key, so a retry after a failed post creation does not upload again. */
  private readonly uploads = new Map<string, Promise<Uploaded[]>>();
  /** "<site>|<lowercase tag>" → term id. */
  private readonly tagIds = new Map<string, number>();

  constructor(opts: WordPressConnectorOptions = {}) {
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.maxCommentPages = opts.maxCommentPages ?? 5;
  }

  capabilities(): ConnectorCapabilities {
    // Core REST has no per-post statistics (Jetpack Stats is a later step), so no metrics.
    return { publish: true, fetchActivity: true, fetchMetrics: false, meteredReads: false, reply: true, moderate: true, accountMetrics: false, webhooks: false, video: true, kinds: ["post", "link"] };
  }

  // ---- connect --------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const siteUrl = normalizeSiteUrl(p.inputs.siteUrl ?? "");
    if (!siteUrl) throw new ConnectorError("wordpress: enter the site's address, e.g. https://blog.example.com", "rejected", false);
    const auth: WordPressAuth = {
      siteUrl,
      username: (p.inputs.username ?? "").trim(),
      // WordPress shows the password in groups of four and ignores the spaces.
      applicationPassword: (p.inputs.applicationPassword ?? "").replace(/\s+/g, ""),
      restMode: "pretty",
    };
    if (!auth.username || !auth.applicationPassword) throw new ConnectorError("wordpress: username and Application Password are required", "auth", false);
    const { auth: verified, user, siteName, home } = await this.verify(auth);
    const key = siteKey(home ?? siteUrl);
    const identity: AccountIdentity = { externalId: key, handle: key, displayName: siteName ?? user.name ?? null };
    return [{ network: "wordpress", identity, auth: { ...verified }, config: { siteUrl, userId: user.id, userName: user.name ?? null, siteName: siteName ?? null, roles: user.roles ?? [] } }];
  }

  async describeAccount(raw: Record<string, unknown>): Promise<AccountIdentity> {
    const parsed = WordPressAuth.safeParse(raw);
    if (!parsed.success) throw new ConnectorError("wordpress: siteUrl, username and applicationPassword are required", "auth", false, parsed.error);
    const { user, siteName, home } = await this.verify(parsed.data);
    const key = siteKey(home ?? parsed.data.siteUrl);
    return { externalId: key, handle: key, displayName: siteName ?? user.name ?? null };
  }

  /** GET /wp/v2/users/me?context=edit (falls back to ?rest_route= when /wp-json is not routed), then the site index for its name. */
  private async verify(auth: WordPressAuth): Promise<{ auth: WordPressAuth; user: WordPressUser; siteName: string | undefined; home: string | undefined }> {
    const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(auth.siteUrl);
    if (auth.siteUrl.startsWith("http:") && !local) throw new ConnectorError("wordpress: Application Passwords only work over HTTPS; use the https:// address", "rejected", false);
    let current = auth;
    let user: WordPressUser;
    try {
      user = await this.request<WordPressUser>(current, "GET", "/wp/v2/users/me", { query: { context: "edit" } }, "verify");
    } catch (err) {
      if (!(err instanceof ConnectorError) || (err.cause as { status?: number } | undefined)?.status !== 404) throw err;
      current = { ...auth, restMode: "plain" };
      user = await this.request<WordPressUser>(current, "GET", "/wp/v2/users/me", { query: { context: "edit" } }, "verify");
    }
    if (user.capabilities && user.capabilities.publish_posts === false) {
      throw new ConnectorError(`wordpress: ${user.name ?? auth.username} cannot publish posts on this site (role: ${(user.roles ?? []).join(", ") || "unknown"}); use an Author, Editor or Administrator`, "rejected", false);
    }
    let siteName: string | undefined;
    let home: string | undefined;
    try {
      const index = await this.request<{ name?: string; home?: string; url?: string }>(current, "GET", "/", {}, "site index");
      siteName = index.name ? htmlToText(index.name) : undefined;
      home = index.home ? (normalizeSiteUrl(index.home) ?? undefined) : undefined;
    } catch {
      // The index is cosmetic (site name); a locked-down index must not block connecting.
    }
    return { auth: current, user, siteName, home };
  }

  // ---- publish --------------------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.options?.title?.trim()) issues.push({ code: "empty", message: "wordpress posts need a title (options.title)" });
    for (const m of input.media) if (m.kind === "document") issues.push({ code: "unsupported_media", message: "wordpress: attach documents as links in the text" });
    if (input.options?.poll) issues.push({ code: "unsupported_media", message: "wordpress has no native polls" });
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const o = input.options ?? {};
      const title = o.title?.trim();
      if (!title) throw new ConnectorError("wordpress publish: a title is required (options.title)", "rejected", false);

      const uploads = await this.uploadsFor(auth, input);
      const firstImage = uploads.find((u) => u.kind === "image");
      let featured = firstImage?.id;
      if (featured === undefined && o.thumbnailUrl) featured = (await this.uploadThumbnail(auth, o.thumbnailUrl)).id;

      // The featured image is shown by the theme; every other upload goes inline after the text.
      const inline = uploads.filter((u) => u !== firstImage).map(mediaBlock).filter(Boolean);
      const content = [textToHtml(input.text, { link: o.link }), ...inline].filter(Boolean).join("\n");
      const tags = await this.resolveTags(auth, o.tags ?? []);
      const paragraphs = input.text.trim().split(/\n\s*\n/).length;
      const body = {
        title,
        content,
        status: wordpressStatus(o),
        ...(paragraphs > 1 ? { excerpt: firstParagraph(input.text) } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(featured !== undefined ? { featured_media: featured } : {}),
      };
      const post = await this.request<{ id: number; link?: string; status?: string }>(auth, "POST", "/wp/v2/posts", { json: body }, "create post");
      this.uploads.delete(input.idempotencyKey);

      let firstComment: unknown;
      if (o.firstComment?.trim() && body.status === "publish") {
        // Best effort: the post is live, so a failed first comment is reported in raw, not as a failed publish.
        firstComment = await this.request(auth, "POST", "/wp/v2/comments", { json: { post: post.id, content: textToHtml(o.firstComment) } }, "first comment").catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
      }
      return { externalId: String(post.id), url: post.link ?? null, raw: { post, ...(firstComment ? { firstComment } : {}) } };
    });
  }

  private uploadsFor(auth: WordPressAuth, input: PublishInput): Promise<Uploaded[]> {
    let pending = this.uploads.get(input.idempotencyKey);
    if (!pending) {
      pending = (async () => {
        const out: Uploaded[] = [];
        let i = 0;
        for (const m of input.media) {
          if (m.kind === "document") continue;
          out.push(await this.uploadMedia(auth, m, i++));
        }
        return out;
      })();
      this.uploads.set(input.idempotencyKey, pending);
      pending.catch(() => this.uploads.delete(input.idempotencyKey));
    }
    return pending;
  }

  /** POST /wp/v2/media with the raw bytes and a Content-Disposition filename. alt_text rides along as a query parameter. */
  private async uploadMedia(auth: WordPressAuth, m: Media, i: number): Promise<Uploaded> {
    // Videos are sent as a streamed body with an exact Content-Length; images are read whole as before.
    return withUpload(mediaSource(this.media, this.fetchImpl), m, async (file) => {
      const mime = file.mime;
      const filename = uploadFileName(m.url, mime, `starsign-${i + 1}`);
      // TODO(verify): alt_text as a query parameter on the binary upload is applied by WP_REST_Attachments_Controller::create_item.
      const res = await this.request<{ id: number; source_url?: string }>(
        auth,
        "POST",
        "/wp/v2/media",
        { query: m.alt ? { alt_text: m.alt } : {}, body: rawBody(file), headers: { "content-type": mime, "content-disposition": `attachment; filename="${filename}"` } },
        "upload media",
      );
      return { id: res.id, url: res.source_url ?? m.url, kind: m.kind === "video" ? "video" : "image", alt: m.alt ?? null };
    });
  }

  private async uploadThumbnail(auth: WordPressAuth, url: string): Promise<Uploaded> {
    return this.uploadMedia(auth, { kind: "image", url }, 0);
  }

  /** Tag names → term ids: exact (case-insensitive) match from /wp/v2/tags?search=, else create; term_exists returns the id. */
  private async resolveTags(auth: WordPressAuth, names: string[]): Promise<number[]> {
    const ids: number[] = [];
    const seen = new Set<string>();
    for (const rawName of names) {
      const name = rawName.trim().replace(/^#/, "");
      const lower = name.toLowerCase();
      if (!name || seen.has(lower)) continue;
      seen.add(lower);
      const cacheKey = `${auth.siteUrl}|${lower}`;
      const cached = this.tagIds.get(cacheKey);
      if (cached !== undefined) {
        ids.push(cached);
        continue;
      }
      const found = await this.request<{ id: number; name: string }[]>(auth, "GET", "/wp/v2/tags", { query: { search: name, per_page: 100, _fields: "id,name" } }, "find tag");
      let id = (Array.isArray(found) ? found : []).find((t) => htmlToText(t.name).toLowerCase() === lower)?.id;
      if (id === undefined) {
        try {
          id = (await this.request<{ id: number }>(auth, "POST", "/wp/v2/tags", { json: { name } }, "create tag")).id;
        } catch (err) {
          const body = (err instanceof ConnectorError ? (err.cause as { body?: { code?: string; data?: { term_id?: number } } } | undefined)?.body : undefined) ?? {};
          if (body.code !== "term_exists" || typeof body.data?.term_id !== "number") throw err;
          id = body.data.term_id;
        }
      }
      this.tagIds.set(cacheKey, id);
      ids.push(id);
    }
    return ids;
  }

  // ---- inbox ----------------------------------------------------------------------------

  /** Approved comments, plus comments held for moderation when the user may moderate (a 401/403 there is skipped). */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const ownUserId = typeof account.config.userId === "number" ? account.config.userId : null;
    const out: ActivityInput[] = [];
    for (const status of ["approve", "hold"] as const) {
      let comments: WordPressComment[];
      try {
        comments = await this.commentPages(auth, status, since);
      } catch (err) {
        if (status === "hold" && err instanceof ConnectorError && err.kind === "auth") continue;
        throw err;
      }
      for (const c of comments) {
        // Our own replies come back here too; they are not inbox items.
        if (ownUserId !== null && c.author === ownUserId) continue;
        out.push(this.commentToActivity(account, c));
      }
    }
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  private async commentPages(auth: WordPressAuth, status: "approve" | "hold", since: Date | null): Promise<WordPressComment[]> {
    const out: WordPressComment[] = [];
    for (let page = 1; page <= this.maxCommentPages; page++) {
      // TODO(verify): `after` is compared against comment_date_gmt, so a UTC timestamp is right.
      const items = await this.request<WordPressComment[]>(auth, "GET", "/wp/v2/comments", { query: { status, per_page: 100, page, orderby: "date_gmt", order: "asc", ...(since ? { after: isoSeconds(since) } : {}) } }, "list comments");
      const list = Array.isArray(items) ? items : [];
      out.push(...list);
      if (list.length < 100) break;
    }
    return out;
  }

  private commentToActivity(account: AccountRef, c: WordPressComment): ActivityInput {
    return {
      network: "wordpress",
      kind: "comment",
      externalId: `${account.externalId}#comment-${c.id}`,
      authorHandle: c.author_url ? (safeUrl(c.author_url) ?? null) : null,
      authorName: c.author_name ? htmlToText(c.author_name) : null,
      text: c.content?.rendered ? htmlToText(c.content.rendered) : null,
      url: c.link ?? null,
      parentExternalId: String(c.post),
      occurredAt: new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(c.date_gmt) ? c.date_gmt : `${c.date_gmt}Z`).toISOString(),
      raw: c,
    };
  }

  /** Reply to a comment ("…#comment-<id>": threaded under it) or comment on a post (numeric post id). */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const isComment = /(?:^|#)comment-\d+$/.test(input.parentExternalId);
      let post: number;
      let parent = 0;
      if (isComment) {
        parent = wordpressCommentId(input.parentExternalId) ?? 0;
        post = (await this.request<WordPressComment>(auth, "GET", `/wp/v2/comments/${parent}`, {}, "read comment")).post;
      } else if (/^\d+$/.test(input.parentExternalId)) {
        post = Number(input.parentExternalId);
      } else {
        throw new ConnectorError(`wordpress reply: "${input.parentExternalId}" is neither a post id nor a comment id`, "rejected", false);
      }
      const c = await this.request<WordPressComment>(auth, "POST", "/wp/v2/comments", { json: { post, parent, content: textToHtml(input.text) } }, "reply");
      return { externalId: `${account.externalId}#comment-${c.id}`, url: c.link ?? null, raw: c };
    });
  }

  /** hide → status "hold" (back to moderation), unhide → "approve", delete → trash. Likes do not exist in core. */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    const auth = parseAuth(account);
    const id = wordpressCommentId(input.externalId);
    if (id === null) throw new ConnectorError(`wordpress moderate: "${input.externalId}" is not a comment id`, "rejected", false);
    if (input.action === "hide" || input.action === "unhide") {
      await this.request(auth, "POST", `/wp/v2/comments/${id}`, { json: { status: input.action === "hide" ? "hold" : "approve" } }, input.action);
      return;
    }
    if (input.action === "delete") {
      // Without force=true WordPress moves the comment to the trash (recoverable for 30 days).
      await this.request(auth, "DELETE", `/wp/v2/comments/${id}`, {}, "delete");
      return;
    }
    throw new ConnectorError(`wordpress moderate: ${input.action} is not supported`, "rejected", false);
  }

  async fetchMetrics(): Promise<MetricInput[]> {
    return [];
  }

  // ---- transport ------------------------------------------------------------------------

  private url(auth: WordPressAuth, path: string, query: Query = {}): string {
    const params = Object.entries(query).filter((e): e is [string, string | number] => e[1] !== undefined);
    if (auth.restMode === "plain") {
      const u = new URL(`${auth.siteUrl}/`);
      u.searchParams.set("rest_route", path);
      for (const [k, v] of params) u.searchParams.set(k, String(v));
      return u.toString();
    }
    const qs = new URLSearchParams(params.map(([k, v]): [string, string] => [k, String(v)])).toString();
    return `${auth.siteUrl}/wp-json${path}${qs ? `?${qs}` : ""}`;
  }

  private async request<T>(auth: WordPressAuth, method: string, path: string, opts: { query?: Query; json?: unknown; body?: Uint8Array | StreamBody; headers?: Record<string, string> }, what: string): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`${auth.username}:${auth.applicationPassword}`).toString("base64")}`,
      accept: "application/json",
      ...(opts.json !== undefined ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    };
    const payload = opts.json !== undefined ? JSON.stringify(opts.json) : opts.body;
    let res: Response;
    try {
      res = await sendBody(resolveFetch(this.fetchImpl), this.url(auth, path, opts.query), { method, headers }, payload);
    } catch (err) {
      throw asNetworkError(err, `wordpress ${what}`);
    }
    const body = await readJson(res);
    if (!res.ok) throw wpError(`wordpress ${what}`, res.status, body, res.headers, this.now());
    return body as T;
  }
}

interface Uploaded {
  id: number;
  url: string;
  kind: "image" | "video";
  alt: string | null;
}

function mediaBlock(u: Uploaded): string {
  const src = safeUrl(u.url);
  if (!src) return "";
  if (u.kind === "video") return `<figure class="wp-block-video"><video controls src="${escapeHtml(src)}"></video></figure>`;
  return `<figure class="wp-block-image"><img src="${escapeHtml(src)}" alt="${escapeHtml(u.alt ?? "")}" class="wp-image-${u.id}"></figure>`;
}

function parseAuth(account: AccountRef): WordPressAuth {
  const parsed = WordPressAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`wordpress account ${account.handle}: auth blob needs siteUrl, username and applicationPassword`, "auth", false, parsed.error);
  return parsed.data;
}

export function createWordPressConnectors(_env: NodeJS.ProcessEnv): Connector[] {
  return [new WordPressConnector()];
}
