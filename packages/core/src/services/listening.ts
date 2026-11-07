import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { activities, socialAccounts, streams } from "@starsign/db";
import { newId } from "@starsign/ledger";
import { findPhrases } from "@starsign/policy";
import { ActivityInput, StreamQuery, type ActivityKind, type Network } from "@starsign/schema";
import { SYSTEM, type CoreContext, type Principal } from "../context.ts";
import { CoreError } from "../errors.ts";
import { detectLanguage, primaryLanguage } from "../lang.ts";
import type { AccountService } from "./accounts.ts";
import type { WebhookHandler } from "@starsign/connectors";

export type StreamRow = typeof streams.$inferSelect;

/** The live feed: every inbound item from every connected account, raw first, normalized second, matched to streams third. */
export class ListeningService {
  /** Called with the ids of newly stored items (the tracker scans them). Failures are logged, never lost items. */
  readonly afterIngest: ((workspaceId: string, activityIds: string[]) => Promise<unknown>)[] = [];

  constructor(
    private readonly ctx: CoreContext,
    private readonly accounts: AccountService,
  ) {}

  async createStream(p: Principal, input: { name: string; query: unknown }): Promise<StreamRow> {
    const query = StreamQuery.parse(input.query);
    const [row] = await this.ctx.db.insert(streams).values({ id: newId("str"), workspaceId: p.workspaceId, name: input.name, query }).returning();
    return row!;
  }

  async listStreams(workspaceId: string): Promise<StreamRow[]> {
    return this.ctx.db.select().from(streams).where(eq(streams.workspaceId, workspaceId));
  }

  async deleteStream(p: Principal, streamId: string) {
    await this.ctx.db.delete(streams).where(and(eq(streams.id, streamId), eq(streams.workspaceId, p.workspaceId)));
  }

  /** Pull new activity for one account. Returns how many new items landed. */
  async ingestAccount(accountId: string): Promise<{ ingested: number; duplicates: number }> {
    const [account] = await this.ctx.db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId)).limit(1);
    if (!account) throw new CoreError("not_found", `account ${accountId}`);
    if (account.status !== "active") return { ingested: 0, duplicates: 0 };
    const connector = this.ctx.connectors.resolve(account.connector, account.network as Network);
    if (!connector.capabilities(account.network as Network).fetchActivity) return { ingested: 0, duplicates: 0 };
    // Watermark is taken before the fetch, with a 5-minute overlap: items indexed late are picked up next time,
    // and the hash/unique-index dedupe absorbs anything fetched twice.
    const watermark = this.ctx.now();
    const since = account.lastIngestAt ? new Date(account.lastIngestAt.getTime() - 5 * 60_000) : null;
    const items = await this.accounts.withFreshAuth(account, connector, (ref) => connector.fetchActivity(ref, since));
    const result = await this.ingestItems(account.workspaceId, account.id, items);
    await this.ctx.db.update(socialAccounts).set({ lastIngestAt: watermark }).where(eq(socialAccounts.id, accountId));
    return result;
  }

  /** Store items from any source (connector poll, webhook, historical import). */
  async ingestItems(workspaceId: string, socialAccountId: string | null, rawItems: unknown[]): Promise<{ ingested: number; duplicates: number }> {
    const wsStreams = await this.listStreams(workspaceId);
    let ingested = 0;
    let duplicates = 0;
    const ids: string[] = [];
    for (const raw of rawItems) {
      const item = ActivityInput.parse(raw);
      const rawEvent = await this.ctx.events.appendRaw({
        source: `connector:${item.network}`,
        kind: `activity.${item.kind}`,
        workspaceId,
        externalId: item.externalId,
        payload: item.raw ?? item,
      });
      const lang = item.lang ? primaryLanguage(item.lang) : (detectLanguage(item.text)?.lang ?? null);
      const matched = wsStreams.filter((s) => matchesStream(StreamQuery.parse(s.query), item, { lang })).map((s) => s.id);
      const id = newId("act");
      const inserted = await this.ctx.db
        .insert(activities)
        .values({
          id,
          workspaceId,
          socialAccountId,
          network: item.network,
          kind: item.kind,
          externalId: item.externalId,
          authorHandle: item.authorHandle,
          authorName: item.authorName,
          text: item.text,
          url: item.url,
          parentExternalId: item.parentExternalId,
          occurredAt: new Date(item.occurredAt),
          ingestedAt: this.ctx.now(),
          matchedStreams: matched,
          rawEventId: rawEvent.id,
          lang,
          conversationId: item.conversation?.id ?? null,
          conversationName: item.conversation?.name ?? null,
          conversationType: item.conversation?.type ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: activities.id });
      if (inserted.length === 0) {
        duplicates++;
        continue;
      }
      ingested++;
      ids.push(id);
      this.ctx.emitter.emit("activity", { workspaceId, id, network: item.network, kind: item.kind, matchedStreams: matched, lang });
    }
    for (const hook of this.afterIngest) {
      if (ids.length) await hook(workspaceId, ids).catch((e) => console.error("[listening] after-ingest hook failed:", (e as Error).message));
    }
    if (ingested > 0) {
      await this.ctx.events.append({
        workspaceId,
        type: "activity.ingested",
        subjectType: "social_account",
        subjectId: socialAccountId ?? "import",
        actor: SYSTEM,
        data: { count: ingested, duplicates, ids: ids.slice(0, 50) },
      });
    }
    return { ingested, duplicates };
  }

  async feed(
    workspaceId: string,
    opts: { streamId?: string; networks?: Network[]; kinds?: ActivityKind[]; accountId?: string; since?: Date; before?: Date; limit?: number; q?: string; languages?: string[]; conversationId?: string; ids?: string[] } = {},
  ) {
    const conds = [eq(activities.workspaceId, workspaceId)];
    if (opts.ids) {
      if (opts.ids.length === 0) return [];
      conds.push(inArray(activities.id, opts.ids));
    }
    if (opts.languages?.length) conds.push(inArray(activities.lang, opts.languages.map(primaryLanguage)));
    if (opts.conversationId) conds.push(eq(activities.conversationId, opts.conversationId));
    if (opts.streamId) conds.push(sql`${activities.matchedStreams} @> ${JSON.stringify([opts.streamId])}::jsonb`);
    if (opts.networks?.length) conds.push(inArray(activities.network, opts.networks));
    if (opts.kinds?.length) conds.push(inArray(activities.kind, opts.kinds));
    if (opts.accountId) conds.push(eq(activities.socialAccountId, opts.accountId));
    if (opts.since) conds.push(gt(activities.occurredAt, opts.since));
    if (opts.before) conds.push(lt(activities.occurredAt, opts.before));
    // Search finds a message by its words or by its translation.
    if (opts.q) conds.push(sql`(${activities.text} ILIKE ${"%" + opts.q + "%"} OR ${activities.translation} ILIKE ${"%" + opts.q + "%"})`);
    return this.ctx.db
      .select()
      .from(activities)
      .where(and(...conds))
      .orderBy(desc(activities.occurredAt))
      .limit(Math.min(opts.limit ?? 100, 500));
  }

  async counts(workspaceId: string, since: Date) {
    const rows = await this.ctx.db
      .select({ network: activities.network, kind: activities.kind, n: sql<number>`count(*)` })
      .from(activities)
      .where(and(eq(activities.workspaceId, workspaceId), gt(activities.occurredAt, since)))
      .groupBy(activities.network, activities.kind);
    return rows.map((r) => ({ ...r, n: Number(r.n) }));
  }
}

/**
 * Whether an item belongs in a stream. Keywords match the original text in the stream's own words or in any of its
 * translated keyword lists, and, once a translation exists, the translation too (so an English keyword finds a
 * Japanese message about the same thing).
 */
export function matchesStream(q: StreamQuery, item: ActivityInput, extra: { lang?: string | null; translation?: string | null } = {}): boolean {
  if (q.networks.length && !q.networks.includes(item.network)) return false;
  if (q.kinds.length && !q.kinds.includes(item.kind)) return false;
  const lang = extra.lang ?? (item.lang ? primaryLanguage(item.lang) : null);
  if (q.languages.length && (!lang || !q.languages.includes(lang))) return false;
  const authorOk = q.authors.length === 0 || (item.authorHandle ? q.authors.some((a) => a.replace(/^@/, "").toLowerCase() === item.authorHandle!.replace(/^@/, "").toLowerCase()) : false);
  const allKeywords = [...q.keywords, ...Object.values(q.translations).flat()];
  const keywordOk =
    q.keywords.length === 0 ||
    (item.text ? findPhrases(item.text, allKeywords).length > 0 : false) ||
    (extra.translation ? findPhrases(extra.translation, q.keywords).length > 0 : false);
  if (q.authors.length && q.keywords.length) return authorOk || keywordOk;
  return authorOk && keywordOk;
}

/**
 * Engagement from the inbox. Replies are posts: they pass the same gate (red lines + the reply autonomy dial),
 * land in the approval queue when the dial says so, and publish through the connector's reply method.
 */
export class EngagementService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly posts: { create(p: Principal, input: unknown): Promise<{ post: { id: string; status: string } }> },
    private readonly accounts: AccountService,
  ) {}

  private async activity(workspaceId: string, activityId: string) {
    const [row] = await this.ctx.db.select().from(activities).where(and(eq(activities.id, activityId), eq(activities.workspaceId, workspaceId))).limit(1);
    if (!row) throw new CoreError("not_found", `activity ${activityId}`);
    return row;
  }

  async reply(p: Principal, activityId: string, text: string, opts: { aiAssisted?: boolean } = {}) {
    const a = await this.activity(p.workspaceId, activityId);
    if (!a.socialAccountId) throw new CoreError("invalid", "this item did not arrive through a connected account, so there is nothing to reply from");
    const account = await this.accounts.get(p.workspaceId, a.socialAccountId);
    const connector = this.ctx.connectors.resolve(account.connector, account.network as Network);
    if (!connector.reply || !connector.capabilities(account.network as Network).reply) throw new CoreError("invalid", `${account.network} replies are not supported by this connection`);
    return this.posts.create(p, {
      body: text,
      actionClass: "reply",
      variants: [{ socialAccountId: account.id, text, replyToExternalId: a.externalId }],
      scheduledAt: this.ctx.now().toISOString(),
      evidence: [{ kind: "activity", ref: a.id, note: `${a.kind} from @${a.authorHandle ?? "unknown"}` }],
      ...(opts.aiAssisted ? { disclosure: { aiAssisted: true, aiContributions: ["text_drafted"], humanReviewed: p.actor.type === "human" } } : {}),
    });
  }

  /** Hide, delete or like an item on the network. People only: moderation is never delegated to an agent. */
  async moderate(p: Principal, activityId: string, action: "hide" | "unhide" | "delete" | "like" | "unlike") {
    if (p.actor.type !== "human" || !p.role || p.role === "viewer") throw new CoreError("forbidden", "a person moderates comments");
    if (action === "delete" && !["owner", "approver"].includes(p.role)) throw new CoreError("forbidden", "deleting needs an owner or approver");
    const a = await this.activity(p.workspaceId, activityId);
    if (!a.socialAccountId) throw new CoreError("invalid", "not from a connected account");
    const account = await this.accounts.get(p.workspaceId, a.socialAccountId);
    const connector = this.ctx.connectors.resolve(account.connector, account.network as Network);
    if (!connector.moderate || !connector.capabilities(account.network as Network).moderate) throw new CoreError("invalid", `${account.network} does not support ${action} through this connection`);
    await this.accounts.withFreshAuth(account, connector, (ref) => connector.moderate!(ref, { externalId: a.externalId, action }));
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "activity.moderated", subjectType: "activity", subjectId: a.id, actor: p.actor, data: { action, network: a.network, externalId: a.externalId } });
    return { ok: true, action };
  }
}

/** Inbound webhooks: verify, store raw, route items to every workspace that has the target account connected. */
export class WebhookService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly listening: ListeningService,
    private readonly accounts: AccountService,
  ) {}

  async challenge(connectorName: string, query: Record<string, string>): Promise<string | null> {
    const handler = this.ctx.connectors.get(connectorName)?.webhook;
    if (!handler) return null;
    if (handler.route && handler.challengeAccount) {
      const target = handler.route("", query, {});
      if (!target) return null;
      for (const acc of await this.targets(target.network, target.accountExternalId)) {
        const answer = handler.challengeAccount(this.accounts.toRef(acc), query);
        if (answer !== null) return answer;
      }
      return null;
    }
    return handler.challenge?.(query) ?? null;
  }

  private targets(network: string, externalId: string) {
    return this.ctx.db
      .select()
      .from(socialAccounts)
      .where(and(eq(socialAccounts.network, network), eq(socialAccounts.externalId, externalId), eq(socialAccounts.status, "active")));
  }

  /** Deliveries signed with each account's own secret: find the claimed account, verify with its credentials. */
  private async receiveRouted(connectorName: string, handler: WebhookHandler, headers: Record<string, string>, rawBody: string, query: Record<string, string>) {
    const target = handler.route!(rawBody, query, headers);
    if (!target) throw new CoreError("invalid", "webhook delivery names no account");
    const verified = (await this.targets(target.network, target.accountExternalId)).filter((acc) => handler.verifyAccount!(this.accounts.toRef(acc), headers, rawBody, query));
    if (verified.length === 0) throw new CoreError("forbidden", "bad webhook signature");
    let items = 0;
    let logged = false;
    let reply: { body: string; contentType: string } | null = null;
    for (const acc of verified) {
      let body: unknown;
      try {
        body = handler.decodeAccount ? handler.decodeAccount(this.accounts.toRef(acc), rawBody, query) : handler.decode ? handler.decode(rawBody, query) : JSON.parse(rawBody);
      } catch {
        throw new CoreError("invalid", "webhook body could not be read");
      }
      if (!logged) {
        await this.ctx.events.appendRaw({ source: `webhook:${connectorName}`, kind: "delivery", workspaceId: null, externalId: null, payload: body });
        logged = true;
      }
      reply ??= handler.respond?.(body, headers) ?? null;
      for (const batch of handler.parse(body)) {
        if (batch.network !== acc.network || batch.accountExternalId !== acc.externalId) continue;
        items += (await this.listening.ingestItems(acc.workspaceId, acc.id, batch.items)).ingested;
      }
      if (handler.pullNow?.(body)) this.pullSoon(acc.id);
    }
    const ack = reply ?? handler.ack;
    return { accepted: true, items, ...(ack ? { ack } : {}) };
  }

  /** Accounts being pulled because a delivery said "new items waiting", and those asked again meanwhile. */
  private readonly pulling = new Set<string>();
  private readonly pullAgain = new Set<string>();

  /**
   * Pull one account in the background, so the webhook answers within the platform's deadline. Bursts of
   * announcements collapse: while a pull runs, further requests for the account queue a single follow-up pull.
   * Returns the running pull (tests await it; the webhook route does not).
   */
  pullSoon(accountId: string): Promise<void> {
    if (this.pulling.has(accountId)) {
      this.pullAgain.add(accountId);
      return Promise.resolve();
    }
    this.pulling.add(accountId);
    const run = async (): Promise<void> => {
      try {
        do {
          this.pullAgain.delete(accountId);
          await this.listening.ingestAccount(accountId).catch((e) => console.error(`[webhook] pull after announcement failed for ${accountId}:`, e instanceof Error ? e.message : e));
        } while (this.pullAgain.has(accountId));
      } finally {
        this.pulling.delete(accountId);
      }
    };
    this.lastPull = run();
    return this.lastPull;
  }

  /** The most recent background pull (for tests). */
  lastPull: Promise<void> = Promise.resolve();

  async receive(connectorName: string, headers: Record<string, string>, rawBody: string, query: Record<string, string> = {}): Promise<{ accepted: boolean; items: number; ack?: { body: string; contentType: string } }> {
    const handler = this.ctx.connectors.get(connectorName)?.webhook;
    if (!handler) throw new CoreError("not_found", `no webhooks for ${connectorName}`);
    if (handler.route && handler.verifyAccount) return this.receiveRouted(connectorName, handler, headers, rawBody, query);
    if (!handler.verify(headers, rawBody, query)) throw new CoreError("forbidden", "bad webhook signature");
    let body: unknown;
    try {
      body = handler.decode ? handler.decode(rawBody, query) : JSON.parse(rawBody);
    } catch {
      throw new CoreError("invalid", "webhook body could not be read");
    }
    await this.ctx.events.appendRaw({ source: `webhook:${connectorName}`, kind: "delivery", workspaceId: null, externalId: null, payload: body });
    let items = 0;
    for (const batch of handler.parse(body)) {
      const targets = await this.ctx.db
        .select()
        .from(socialAccounts)
        .where(and(eq(socialAccounts.network, batch.network), eq(socialAccounts.externalId, batch.accountExternalId), eq(socialAccounts.status, "active")));
      for (const acc of targets) {
        const r = await this.listening.ingestItems(acc.workspaceId, acc.id, batch.items);
        items += r.ingested;
      }
    }
    const ack = handler.respond?.(body, headers) ?? handler.ack;
    return { accepted: true, items, ...(ack ? { ack } : {}) };
  }
}
