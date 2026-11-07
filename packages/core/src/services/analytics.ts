import { and, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { metrics, postOutcomes, posts, postVariants, rowsOf, socialAccounts } from "@starsign/db";
import type { CoreContext, Principal } from "../context.ts";
import { CoreError } from "../errors.ts";
import type { LinkService } from "./links.ts";
import type { MetricsService } from "./metrics.ts";
import type { PolicyService } from "./policy.ts";
import {
  MIN_PER_SIDE,
  TOTAL_KEYS,
  bestTimesFrom,
  compareGroups,
  engagementsOf,
  impressionsOf,
  localDays,
  localSlot,
  pctChange,
  previousWindow,
  type AccountRow,
  type AnalyticsPayload,
  type AnalyticsTotals,
  type BestTimes,
  type Comparison,
  type DailyPoint,
  type HeatCell,
  type MentionSummary,
  type NetworkRow,
  type OutcomeBasis,
  type TopPost,
  type TotalKey,
  type WhatWorked,
} from "./analytics-shared.ts";

/**
 * Analytics: one payload for the Analytics view and for client reports. Everything is read from what Starsign
 * already records: outcome snapshots (post_outcomes at 24h / 72h, falling back to the latest metrics), owned clicks
 * and conversions, account follower series and the feed. Deterministic given the database and the clock.
 */

export const LEARNING_DAYS = 90;
export const SHORT_TEXT_CHARS = 120;
export const MAX_WINDOW_DAYS = 366;
const MENTION_KINDS = ["mention", "reply", "comment", "quote"];
const DAY_MS = 86_400_000;

export interface AnalyticsFilters {
  networks?: string[];
  accounts?: string[];
}
export interface AnalyticsQuery extends AnalyticsFilters {
  from: Date;
  to: Date;
}

const KIND_LABEL: Record<string, string> = {
  post: "Plain posts",
  reply: "Replies",
  reel: "Reels",
  story: "Stories",
  carousel: "Carousels",
  video: "Videos",
  short: "Shorts",
  pin: "Pins",
  link: "Link posts",
  poll: "Polls",
};

// ---------------------------------------------------------------- the service

interface Acc {
  posts: number;
  impressions: number;
  engagements: number;
  erEng: number;
  erImp: number;
  linkClicks: number;
  conversions: number;
  conversionValue: number;
  followersGained: number | null;
  mentions: number;
}
const emptyAcc = (): Acc => ({ posts: 0, impressions: 0, engagements: 0, erEng: 0, erImp: 0, linkClicks: 0, conversions: 0, conversionValue: 0, followersGained: null, mentions: 0 });
const totalsOf = (a: Acc): AnalyticsTotals => ({
  posts: a.posts,
  impressions: a.impressions,
  engagements: a.engagements,
  engagementRate: a.erImp > 0 ? a.erEng / a.erImp : null,
  linkClicks: a.linkClicks,
  conversions: a.conversions,
  conversionValue: a.conversionValue,
  followersGained: a.followersGained,
  mentions: a.mentions,
});

interface VariantFacts {
  id: string;
  postId: string;
  accountId: string;
  network: string;
  text: string;
  body: string;
  externalUrl: string | null;
  publishedAt: Date;
  hasMedia: boolean;
  kind: string;
  rodeTrend: boolean;
  best: Record<string, number> | null;
  basis: OutcomeBasis;
  at24: Record<string, number> | null;
}

interface WindowResult {
  totals: AnalyticsTotals;
  byNetwork: NetworkRow[];
  byAccount: AccountRow[];
  series: DailyPoint[];
  variants: VariantFacts[];
  mentions: MentionSummary;
  currencies: string[];
}

type AccountLite = { id: string; network: string; handle: string; displayName: string | null };

function sqlList(values: string[]) {
  return sql`(${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )})`;
}

export class AnalyticsService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly policy: PolicyService,
    private readonly metricsService: MetricsService,
    private readonly links: LinkService,
  ) {}

  /** Anyone in the workspace may read analytics, viewers and agents included. */
  async get(p: Principal, q: AnalyticsQuery): Promise<AnalyticsPayload> {
    return this.forWorkspace(p.workspaceId, q);
  }

  async forWorkspace(workspaceId: string, q: AnalyticsQuery): Promise<AnalyticsPayload> {
    const { from, to } = q;
    if (!(from.getTime() < to.getTime())) throw new CoreError("invalid", "from must be before to");
    if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) throw new CoreError("invalid", `the window is at most ${MAX_WINDOW_DAYS} days`);
    const tz = (await this.policy.getActive(workspaceId)).timezone || "UTC";
    const filters = { networks: [...new Set(q.networks ?? [])].filter(Boolean), accounts: [...new Set(q.accounts ?? [])].filter(Boolean) };
    const all = await this.ctx.db
      .select({ id: socialAccounts.id, network: socialAccounts.network, handle: socialAccounts.handle, displayName: socialAccounts.displayName })
      .from(socialAccounts)
      .where(eq(socialAccounts.workspaceId, workspaceId));
    const scope = all.filter((a) => (!filters.networks.length || filters.networks.includes(a.network)) && (!filters.accounts.length || filters.accounts.includes(a.id)));

    const prev = previousWindow(from, to);
    const learnFrom = new Date(Math.min(from.getTime(), to.getTime() - LEARNING_DAYS * DAY_MS));
    const [cur, before, learning] = await Promise.all([
      this.window(workspaceId, tz, from, to, filters, scope),
      this.window(workspaceId, tz, prev.from, prev.to, filters, scope),
      this.variantFacts(workspaceId, learnFrom, to, filters),
    ]);

    const change = Object.fromEntries(TOTAL_KEYS.map((k) => [k, pctChange(cur.totals[k], before.totals[k])])) as Record<TotalKey, number | null>;
    const samples = learning.filter((v) => v.at24 && (impressionsOf(v.at24) ?? 0) > 0).map((v) => ({ at: v.publishedAt, rate: engagementsOf(v.at24) / impressionsOf(v.at24)! }));
    const bestTimes = bestTimesFrom(samples, tz, learnFrom, to);
    const whatWorked = await this.whatWorked(workspaceId, learning, learnFrom, to);

    const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS));
    return {
      window: { from: from.toISOString(), to: to.toISOString(), previousFrom: prev.from.toISOString(), previousTo: prev.to.toISOString(), days, timezone: tz },
      filters,
      totals: cur.totals,
      previous: before.totals,
      change,
      currency: cur.currencies.length === 1 ? cur.currencies[0]! : null,
      byNetwork: cur.byNetwork,
      byAccount: cur.byAccount,
      topPosts: await this.topPosts(cur.variants),
      bestTimes,
      whatWorked,
      series: cur.series,
      previousSeries: before.series,
      mentions: cur.mentions,
      measured: { posts: cur.variants.length, withNumbers: cur.variants.filter((v) => v.basis !== "none").length },
    };
  }

  // ------------------------------------------------------------ one window

  /** Published variants in a window with the numbers that describe them best. */
  private async variantFacts(workspaceId: string, from: Date, to: Date, f: Required<AnalyticsFilters>): Promise<VariantFacts[]> {
    const conds: SQL[] = [eq(posts.workspaceId, workspaceId), eq(postVariants.status, "published"), gte(postVariants.publishedAt, from), lte(postVariants.publishedAt, to)];
    if (f.networks.length) conds.push(inArray(postVariants.network, f.networks));
    if (f.accounts.length) conds.push(inArray(postVariants.socialAccountId, f.accounts));
    const rows = await this.ctx.db
      .select({
        id: postVariants.id,
        postId: postVariants.postId,
        accountId: postVariants.socialAccountId,
        network: postVariants.network,
        text: postVariants.text,
        media: postVariants.media,
        options: postVariants.options,
        externalId: postVariants.externalId,
        externalUrl: postVariants.externalUrl,
        publishedAt: postVariants.publishedAt,
        body: posts.body,
        postMedia: posts.media,
        trendTopicId: posts.trendTopicId,
        actionClass: posts.actionClass,
      })
      .from(postVariants)
      .innerJoin(posts, eq(posts.id, postVariants.postId))
      .where(and(...conds));
    if (!rows.length) return [];

    const ids = rows.map((r) => r.id);
    const outcomes = await this.ctx.db
      .select({ variantId: postOutcomes.variantId, offset: postOutcomes.offsetLabel, metrics: postOutcomes.metrics })
      .from(postOutcomes)
      .where(and(inArray(postOutcomes.variantId, ids), eq(postOutcomes.status, "captured"), inArray(postOutcomes.offsetLabel, ["24h", "72h"])));
    const at = new Map<string, Record<string, number>>();
    for (const o of outcomes) if (o.metrics) at.set(`${o.variantId}:${o.offset}`, o.metrics);

    // Latest metrics for variants that have no snapshot yet (a post from this morning, or a skipped capture).
    const missing = rows.filter((r) => !at.has(`${r.id}:24h`) && !at.has(`${r.id}:72h`) && r.externalId).map((r) => r.externalId!);
    const latest = new Map<string, Record<string, number>>();
    if (missing.length) {
      const ms = await this.ctx.db
        .select({ entityId: metrics.entityId, metric: metrics.metric, value: metrics.value })
        .from(metrics)
        .where(and(eq(metrics.entityType, "post_variant"), inArray(metrics.entityId, [...new Set(missing)])))
        .orderBy(desc(metrics.observedAt));
      for (const m of ms) {
        const bag = latest.get(m.entityId) ?? {};
        if (!(m.metric in bag)) bag[m.metric] = m.value;
        latest.set(m.entityId, bag);
      }
    }

    return rows.map((r) => {
      const o72 = at.get(`${r.id}:72h`) ?? null;
      const o24 = at.get(`${r.id}:24h`) ?? null;
      const lt = r.externalId ? (latest.get(r.externalId) ?? null) : null;
      const best = o72 ?? o24 ?? lt;
      const basis: OutcomeBasis = o72 ? "72h" : o24 ? "24h" : lt ? "latest" : "none";
      const kind = typeof r.options?.kind === "string" ? (r.options.kind as string) : r.actionClass === "reply" ? "reply" : "post";
      return {
        id: r.id,
        postId: r.postId,
        accountId: r.accountId,
        network: r.network,
        text: r.text,
        body: r.body,
        externalUrl: r.externalUrl,
        publishedAt: r.publishedAt!,
        hasMedia: (r.media?.length ?? 0) > 0 || (r.postMedia?.length ?? 0) > 0,
        kind,
        rodeTrend: !!r.trendTopicId,
        best,
        basis,
        at24: o24,
      };
    });
  }

  private async window(workspaceId: string, tz: string, from: Date, to: Date, f: Required<AnalyticsFilters>, scope: AccountLite[]): Promise<WindowResult> {
    const variants = await this.variantFacts(workspaceId, from, to, f);
    const days = localDays(from, to, tz);
    const series = new Map<string, DailyPoint>(days.map((d) => [d.day, { day: d.day, impressions: 0, engagements: 0, clicks: 0, followers: null }]));
    const total = emptyAcc();
    const byNet = new Map<string, Acc>();
    const byAcct = new Map<string, Acc>();
    const net = (k: string) => byNet.get(k) ?? (byNet.set(k, emptyAcc()), byNet.get(k)!);
    const acct = (k: string) => byAcct.get(k) ?? (byAcct.set(k, emptyAcc()), byAcct.get(k)!);

    for (const v of variants) {
      const imp = impressionsOf(v.best);
      const eng = engagementsOf(v.best);
      for (const a of [total, net(v.network), acct(v.accountId)]) {
        a.posts++;
        a.impressions += imp ?? 0;
        a.engagements += eng;
        if (imp && imp > 0) {
          a.erEng += eng;
          a.erImp += imp;
        }
      }
      const pt = series.get(localSlot(v.publishedAt, tz).day);
      if (pt) {
        pt.impressions += imp ?? 0;
        pt.engagements += eng;
      }
    }

    // Owned clicks: non-bot redirects in the window, by network, account (through the variant) and local day.
    const clickFilters: SQL[] = [];
    if (f.networks.length) clickFilters.push(sql`lc.network IN ${sqlList(f.networks)}`);
    if (f.accounts.length) clickFilters.push(sql`pv.social_account_id IN ${sqlList(f.accounts)}`);
    const extra = clickFilters.length ? sql` AND ${sql.join(clickFilters, sql` AND `)}` : sql``;
    const clicks = rowsOf<{ network: string | null; account: string | null; day: string; n: string | number }>(
      await this.ctx.db.execute(sql`
        SELECT lc.network AS network, pv.social_account_id AS account, to_char(lc.occurred_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, count(*) AS n
        FROM link_clicks lc LEFT JOIN post_variants pv ON pv.id = lc.variant_id
        WHERE lc.workspace_id = ${workspaceId} AND NOT lc.is_bot AND lc.occurred_at >= ${from} AND lc.occurred_at <= ${to}${extra}
        GROUP BY 1, 2, 3`),
    );
    for (const c of clicks) {
      const n = Number(c.n);
      total.linkClicks += n;
      if (c.network) net(c.network).linkClicks += n;
      if (c.account) acct(c.account).linkClicks += n;
      const pt = series.get(c.day);
      if (pt) pt.clicks += n;
    }

    const convFilters: SQL[] = [];
    if (f.networks.length) convFilters.push(sql`cv.network IN ${sqlList(f.networks)}`);
    if (f.accounts.length) convFilters.push(sql`pv.social_account_id IN ${sqlList(f.accounts)}`);
    const convExtra = convFilters.length ? sql` AND ${sql.join(convFilters, sql` AND `)}` : sql``;
    const convs = rowsOf<{ network: string | null; account: string | null; currency: string | null; n: string | number; v: string | number | null }>(
      await this.ctx.db.execute(sql`
        SELECT cv.network AS network, pv.social_account_id AS account, cv.currency AS currency, count(*) AS n, COALESCE(sum(cv.value), 0) AS v
        FROM conversions cv LEFT JOIN post_variants pv ON pv.id = cv.variant_id
        WHERE cv.workspace_id = ${workspaceId} AND cv.occurred_at >= ${from} AND cv.occurred_at <= ${to}${convExtra}
        GROUP BY 1, 2, 3`),
    );
    const currencies = new Set<string>();
    for (const c of convs) {
      const n = Number(c.n);
      const v = Number(c.v ?? 0);
      if (c.currency && v) currencies.add(c.currency);
      for (const a of [total, c.network ? net(c.network) : null, c.account ? acct(c.account) : null]) {
        if (!a) continue;
        a.conversions += n;
        a.conversionValue += v;
      }
    }

    // Mentions, replies, comments and quotes the accounts in scope received.
    const mentions: MentionSummary = { total: 0, byNetwork: [], positive: 0, neutral: 0, negative: 0, unscored: 0, averageSentiment: null };
    if (scope.length) {
      const rows = rowsOf<{ network: string; account: string; tone: string; n: string | number; s: string | number | null }>(
        await this.ctx.db.execute(sql`
          SELECT network, social_account_id AS account,
                 CASE WHEN sentiment IS NULL THEN 'unscored' WHEN sentiment >= 0.25 THEN 'positive' WHEN sentiment <= -0.25 THEN 'negative' ELSE 'neutral' END AS tone,
                 count(*) AS n, sum(sentiment) AS s
          FROM activities
          WHERE workspace_id = ${workspaceId} AND kind IN ${sqlList(MENTION_KINDS)} AND occurred_at >= ${from} AND occurred_at <= ${to}
            AND social_account_id IN ${sqlList(scope.map((a) => a.id))}
          GROUP BY 1, 2, 3`),
      );
      const netCount = new Map<string, number>();
      let sum = 0;
      for (const r of rows) {
        const n = Number(r.n);
        total.mentions += n;
        net(r.network).mentions += n;
        acct(r.account).mentions += n;
        netCount.set(r.network, (netCount.get(r.network) ?? 0) + n);
        mentions[r.tone as "positive" | "neutral" | "negative" | "unscored"] += n;
        if (r.s !== null) sum += Number(r.s);
      }
      mentions.total = total.mentions;
      const scored = mentions.positive + mentions.neutral + mentions.negative;
      mentions.averageSentiment = scored ? sum / scored : null;
      mentions.byNetwork = [...netCount.entries()].map(([network, n]) => ({ network, n })).sort((a, b) => b.n - a.n);
    }

    // Followers: each account's last known count at the end of each day; gained = end of window − start of window.
    if (scope.length) {
      const pts = await this.ctx.db
        .select({ entityId: metrics.entityId, value: metrics.value, observedAt: metrics.observedAt })
        .from(metrics)
        .where(and(eq(metrics.entityType, "social_account"), eq(metrics.metric, "followers_total"), inArray(metrics.entityId, scope.map((a) => a.id)), lte(metrics.observedAt, to), gte(metrics.observedAt, new Date(from.getTime() - 120 * DAY_MS))))
        .orderBy(metrics.observedAt);
      const byAccount = new Map<string, { t: number; v: number }[]>();
      for (const p of pts) byAccount.set(p.entityId, [...(byAccount.get(p.entityId) ?? []), { t: p.observedAt.getTime(), v: p.value }]);
      const valueAt = (series: { t: number; v: number }[], t: number): number | null => {
        let out: number | null = null;
        for (const p of series) {
          if (p.t > t) break;
          out = p.v;
        }
        return out;
      };
      for (const a of scope) {
        const s = byAccount.get(a.id);
        if (!s?.length) continue;
        const end = valueAt(s, to.getTime());
        if (end === null) continue;
        const start = valueAt(s, from.getTime()) ?? s.find((p) => p.t >= from.getTime())?.v ?? end;
        const gained = end - start;
        for (const x of [total, net(a.network), acct(a.id)]) x.followersGained = (x.followersGained ?? 0) + gained;
      }
      for (const d of days) {
        let sum: number | null = null;
        for (const s of byAccount.values()) {
          const v = valueAt(s, d.end.getTime());
          if (v !== null) sum = (sum ?? 0) + v;
        }
        series.get(d.day)!.followers = sum;
      }
    }

    const byId = new Map(scope.map((a) => [a.id, a]));
    const order = (a: AnalyticsTotals, b: AnalyticsTotals) => b.engagements - a.engagements || b.posts - a.posts || b.mentions - a.mentions;
    return {
      totals: totalsOf(total),
      byNetwork: [...byNet.entries()].map(([network, a]) => ({ network, ...totalsOf(a) })).sort(order),
      byAccount: [...byAcct.entries()]
        .flatMap(([id, a]) => {
          const ref = byId.get(id);
          return ref ? [{ accountId: id, network: ref.network, handle: ref.handle, displayName: ref.displayName, ...totalsOf(a) }] : [];
        })
        .sort(order),
      series: [...series.values()],
      variants,
      mentions,
      currencies: [...currencies],
    };
  }

  // ------------------------------------------------------------ top posts and what worked

  private async topPosts(variants: VariantFacts[]): Promise<TopPost[]> {
    const rank: Record<OutcomeBasis, number> = { "72h": 3, "24h": 2, latest: 1, none: 0 };
    const owned = await this.links.statsByVariant(variants.map((v) => v.id));
    const byPost = new Map<string, TopPost & { erEng: number; erImp: number }>();
    for (const v of variants) {
      const p =
        byPost.get(v.postId) ??
        (byPost.set(v.postId, { postId: v.postId, variantIds: [], text: v.body || v.text, networks: [], url: null, publishedAt: v.publishedAt.toISOString(), impressions: 0, engagements: 0, engagementRate: null, linkClicks: 0, conversions: 0, basis: "none", erEng: 0, erImp: 0 }),
        byPost.get(v.postId)!);
      p.variantIds.push(v.id);
      if (!p.networks.includes(v.network)) p.networks.push(v.network);
      p.url ??= v.externalUrl;
      if (v.publishedAt.toISOString() < p.publishedAt) p.publishedAt = v.publishedAt.toISOString();
      const imp = impressionsOf(v.best);
      const eng = engagementsOf(v.best);
      p.impressions += imp ?? 0;
      p.engagements += eng;
      if (imp && imp > 0) {
        p.erEng += eng;
        p.erImp += imp;
      }
      const s = owned.get(v.id);
      p.linkClicks += s?.clicks ?? 0;
      p.conversions += s?.conversions ?? 0;
      if (rank[v.basis] > rank[p.basis]) p.basis = v.basis;
    }
    return [...byPost.values()]
      .filter((p) => p.basis !== "none")
      .map(({ erEng, erImp, ...p }) => ({ ...p, engagementRate: erImp > 0 ? erEng / erImp : null }))
      .sort((a, b) => b.engagements - a.engagements || b.impressions - a.impressions || b.linkClicks - a.linkClicks)
      .slice(0, 10);
  }

  private async whatWorked(workspaceId: string, learning: VariantFacts[], from: Date, to: Date): Promise<WhatWorked> {
    const measured = learning.filter((v) => v.at24);
    const eng = (xs: VariantFacts[]) => xs.map((v) => engagementsOf(v.at24));
    const split = (pred: (v: VariantFacts) => boolean) => [eng(measured.filter(pred)), eng(measured.filter((v) => !pred(v)))] as const;
    const comparisons: Comparison[] = [
      compareGroups("trend", "Riding a trend", "Posts that rode a trend", "Posts that didn't", ...split((v) => v.rodeTrend)),
      compareGroups("media", "Images or video", "Posts with images or video", "Posts without", ...split((v) => v.hasMedia)),
      compareGroups("length", "Short text", `Short posts (under ${SHORT_TEXT_CHARS} characters)`, "Longer posts", ...split((v) => v.text.length < SHORT_TEXT_CHARS)),
    ];
    const kinds = new Map<string, number>();
    for (const v of measured) kinds.set(v.kind, (kinds.get(v.kind) ?? 0) + 1);
    if (kinds.size > 1) {
      for (const [kind] of [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
        const label = KIND_LABEL[kind] ?? `${kind.charAt(0).toUpperCase()}${kind.slice(1)} posts`;
        comparisons.push(compareGroups(`kind:${kind}`, label, label, "Other kinds of post", ...split((v) => v.kind === kind)));
      }
    }
    const stages = await this.metricsService.liftByStage(workspaceId, from, to);
    return { from: from.toISOString(), to: to.toISOString(), minPerSide: MIN_PER_SIDE, comparisons, stages };
  }
}
