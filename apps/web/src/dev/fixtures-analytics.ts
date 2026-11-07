// Fixture "server" for Analytics and client reports (VITE_USE_FIXTURES=1). Six months of plausible, deterministic
// history for Northwind, summarised with the same math the core uses (imported from the core's import-free
// analytics module), and reports rendered by the same renderer the API uses.

import type { Account, EntityReport, LinkReport, MediaAsset, PostSummary, Role } from "../types";
import type { AnalyticsQuery, Report, ReportInput, ReportSent, ReportShare } from "../types-analytics";
import { ApiError } from "../lib/errors";
import {
  DEFAULT_ACCENT,
  TOTAL_KEYS,
  bestTimesFrom,
  compareGroups,
  engagementsOf,
  localDays,
  localSlot,
  pctChange,
  previousWindow,
  renderReportHtml,
  scheduleSummary,
  type AccountRow,
  type AnalyticsPayload,
  type AnalyticsTotals,
  type DailyPoint,
  type MentionSummary,
  type NetworkRow,
  type ReportDocument,
  type ReportScheduleSpec,
  type ReportSection,
  type TopPost,
  type TotalKey,
} from "../../../../packages/core/src/services/analytics-shared";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const delay = <T,>(v: T, ms = 160) => new Promise<T>((resolve) => setTimeout(() => resolve(clone(v)), ms));

export interface AnalyticsFixtureDeps {
  accounts: () => Account[];
  posts: () => PostSummary[];
  media: () => MediaAsset[];
  role: () => Role;
  workspaceId: () => string;
  workspaceName: () => string;
  timezone: () => string;
  linkReport: (from?: string, to?: string) => Promise<LinkReport>;
  entityReport: (from?: string, to?: string) => Promise<EntityReport>;
  calendar: (from: string, to: string) => Promise<PostSummary[]>;
}

// ---------------------------------------------------------------- deterministic history

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface HistPost {
  id: string;
  accountId: string;
  network: string;
  at: number;
  impressions: number;
  engagements: number;
  hasMedia: boolean;
  kind: string;
  rodeTrend: boolean;
  textLength: number;
}

const NETWORK_RATE: Record<string, number> = { x: 0.028, bluesky: 0.046, instagram: 0.052, facebook: 0.019, youtube: 0.034, tiktok: 0.061, mastodon: 0.041, threads: 0.033, linkedin: 0.024 };
const NETWORK_REACH: Record<string, number> = { x: 4200, bluesky: 2600, instagram: 4800, facebook: 3000, youtube: 3600, tiktok: 5200, mastodon: 1400, threads: 1900, linkedin: 2200 };
const FOLLOWERS: Record<string, number> = { acc_x: 18_420, acc_bsky: 3_912, acc_ig: 41_300, acc_fb: 12_870, acc_yt: 6_240, acc_tt: 22_150, acc_masto: 1_184 };
const KINDS_BY_NETWORK: Record<string, string[]> = { instagram: ["post", "reel", "carousel"], tiktok: ["video"], youtube: ["short", "video"], facebook: ["post", "link"] };

/** Local hour weight: Tuesday and Thursday mornings carry Northwind's audience; weekends are quiet. */
function timeFactor(weekday: number, hour: number): number {
  let f = 1;
  if ((weekday === 1 || weekday === 3) && hour >= 9 && hour <= 10) f = 1.75;
  else if (weekday < 5 && hour >= 8 && hour <= 11) f = 1.2;
  else if (hour >= 18) f = 0.85;
  if (weekday >= 5) f *= 0.8;
  return f;
}

let historyCache: { tz: string; posts: HistPost[] } | null = null;
function history(accounts: Account[], tz: string): HistPost[] {
  if (historyCache && historyCache.tz === tz) return historyCache.posts;
  const r = rng(20261107);
  const active = accounts.filter((a) => a.status !== "disabled" && NETWORK_RATE[a.network] !== undefined);
  const out: HistPost[] = [];
  const hours = [7, 8, 9, 9, 10, 10, 11, 12, 13, 15, 17, 19];
  for (let d = 180; d >= 0; d--) {
    const perDay = 2 + Math.floor(r() * 3);
    for (let i = 0; i < perDay; i++) {
      const acct = active[Math.floor(r() * active.length)];
      if (!acct) continue;
      const hour = hours[Math.floor(r() * hours.length)]!;
      // Noon UTC of that day, moved to roughly the local hour; bucketing reads the real local hour back.
      const at = NOW - d * DAY - (NOW % DAY) + 12 * HOUR + (hour - 12 + 8) * HOUR + Math.floor(r() * 50) * 60_000;
      if (at > NOW - 2 * HOUR) continue;
      const { weekday, hour: h } = localSlot(new Date(at), tz);
      const hasMedia = (acct.network === "instagram" || acct.network === "tiktok" || acct.network === "youtube") ? r() < 0.9 : r() < 0.4;
      const rodeTrend = r() < 0.28;
      const kinds = KINDS_BY_NETWORK[acct.network] ?? ["post"];
      const kind = kinds[Math.floor(r() * kinds.length)]!;
      const textLength = Math.round(40 + r() * 260);
      const growth = 1 + (180 - d) / 300;
      const impressions = Math.round(NETWORK_REACH[acct.network]! * growth * (0.55 + r() * 0.9) * (hasMedia ? 1.1 : 1));
      const rate = NETWORK_RATE[acct.network]! * timeFactor(weekday, h) * (hasMedia ? 1.3 : 1) * (rodeTrend ? 1.7 : 1) * (textLength < 120 ? 1.15 : 1) * (0.7 + r() * 0.6);
      out.push({ id: `h${d}_${i}`, accountId: acct.id, network: acct.network, at, impressions, engagements: Math.round(impressions * rate), hasMedia, kind, rodeTrend, textLength });
    }
  }
  historyCache = { tz, posts: out };
  return out;
}

/** Steady daily signals for clicks, conversions, mentions and followers. */
function daily(day: number, salt: number): number {
  const r = rng(day * 131 + salt);
  return r();
}

// ---------------------------------------------------------------- the payload

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
const empty = (): Acc => ({ posts: 0, impressions: 0, engagements: 0, erEng: 0, erImp: 0, linkClicks: 0, conversions: 0, conversionValue: 0, followersGained: null, mentions: 0 });
const totals = (a: Acc): AnalyticsTotals => ({
  posts: a.posts,
  impressions: a.impressions,
  engagements: a.engagements,
  engagementRate: a.erImp ? a.erEng / a.erImp : null,
  linkClicks: a.linkClicks,
  conversions: a.conversions,
  conversionValue: Math.round(a.conversionValue * 100) / 100,
  followersGained: a.followersGained,
  mentions: a.mentions,
});

const CLICK_SHARE: Record<string, number> = { x: 0.31, bluesky: 0.18, facebook: 0.14, instagram: 0.05, mastodon: 0.06, tiktok: 0.04, youtube: 0.08, threads: 0.0, linkedin: 0.14 };
const MENTION_SHARE: Record<string, number> = { x: 0.34, instagram: 0.22, bluesky: 0.12, facebook: 0.12, tiktok: 0.1, youtube: 0.06, mastodon: 0.04 };

function followersAt(accountId: string, t: number): number | null {
  const base = FOLLOWERS[accountId];
  if (base === undefined) return null;
  const daysAgo = (NOW - t) / DAY;
  // About +0.12% a day, with a bump three weeks ago when a reel did well.
  return Math.round(base * (1 - daysAgo * 0.0012) + (daysAgo < 21 && accountId === "acc_ig" ? 380 : 0));
}

function windowOf(deps: AnalyticsFixtureDeps, from: number, to: number, q: AnalyticsQuery) {
  const tz = deps.timezone();
  const accounts = deps.accounts().filter((a) => (!q.networks?.length || q.networks.includes(a.network)) && (!q.accounts?.length || q.accounts.includes(a.id)));
  const inScope = new Set(accounts.map((a) => a.id));
  const posts = history(deps.accounts(), tz).filter((p) => p.at >= from && p.at <= to && inScope.has(p.accountId));
  const days = localDays(new Date(from), new Date(to), tz);
  const series = new Map<string, DailyPoint>(days.map((d) => [d.day, { day: d.day, impressions: 0, engagements: 0, clicks: 0, followers: null }]));
  const total = empty();
  const byNet = new Map<string, Acc>();
  const byAcct = new Map<string, Acc>();
  const net = (k: string) => byNet.get(k) ?? (byNet.set(k, empty()), byNet.get(k)!);
  const acct = (k: string) => byAcct.get(k) ?? (byAcct.set(k, empty()), byAcct.get(k)!);
  for (const p of posts) {
    for (const a of [total, net(p.network), acct(p.accountId)]) {
      a.posts++;
      a.impressions += p.impressions;
      a.engagements += p.engagements;
      a.erEng += p.engagements;
      a.erImp += p.impressions;
    }
    const pt = series.get(localSlot(new Date(p.at), tz).day);
    if (pt) {
      pt.impressions += p.impressions;
      pt.engagements += p.engagements;
    }
  }
  const mentions: MentionSummary = { total: 0, byNetwork: [], positive: 0, neutral: 0, negative: 0, unscored: 0, averageSentiment: 0.21 };
  const mentionNets = new Map<string, number>();
  for (const d of days) {
    const dayIndex = Math.floor((NOW - d.end.getTime()) / DAY);
    const recentLift = dayIndex < 30 ? 1.18 : 1;
    const clicks = Math.round((48 + daily(dayIndex, 1) * 46) * recentLift);
    const ments = Math.round((22 + daily(dayIndex, 2) * 18) * recentLift);
    for (const a of accounts) {
      const cShare = (CLICK_SHARE[a.network] ?? 0) / Math.max(1, deps.accounts().filter((x) => x.network === a.network).length);
      const c = Math.round(clicks * cShare);
      const conv = c ? Math.round(c * 0.031 + daily(dayIndex, 3 + a.id.length) * 0.6) : 0;
      const m = Math.round(ments * (MENTION_SHARE[a.network] ?? 0));
      for (const x of [total, net(a.network), acct(a.id)]) {
        x.linkClicks += c;
        x.conversions += conv;
        x.conversionValue += conv * 26.5;
        x.mentions += m;
      }
      series.get(d.day)!.clicks += c;
      mentionNets.set(a.network, (mentionNets.get(a.network) ?? 0) + m);
    }
    let f: number | null = null;
    for (const a of accounts) {
      const v = followersAt(a.id, d.end.getTime());
      if (v !== null) f = (f ?? 0) + v;
    }
    series.get(d.day)!.followers = f;
  }
  for (const a of accounts) {
    const start = followersAt(a.id, from);
    const end = followersAt(a.id, to);
    if (start === null || end === null) continue;
    for (const x of [total, net(a.network), acct(a.id)]) x.followersGained = (x.followersGained ?? 0) + end - start;
  }
  mentions.total = total.mentions;
  mentions.positive = Math.round(total.mentions * 0.52);
  mentions.negative = Math.round(total.mentions * 0.11);
  mentions.unscored = Math.round(total.mentions * 0.07);
  mentions.neutral = total.mentions - mentions.positive - mentions.negative - mentions.unscored;
  mentions.byNetwork = [...mentionNets.entries()].filter(([, n]) => n > 0).map(([network, n]) => ({ network, n })).sort((a, b) => b.n - a.n);
  const order = (a: AnalyticsTotals, b: AnalyticsTotals) => b.engagements - a.engagements || b.mentions - a.mentions;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return {
    posts,
    totals: totals(total),
    byNetwork: [...byNet.entries()].map(([network, a]): NetworkRow => ({ network, ...totals(a) })).sort(order),
    byAccount: [...byAcct.entries()]
      .flatMap(([id, a]): AccountRow[] => {
        const ref = byId.get(id);
        return ref ? [{ accountId: id, network: ref.network, handle: ref.handle, displayName: ref.displayName, ...totals(a) }] : [];
      })
      .sort(order),
    series: [...series.values()],
    mentions,
  };
}

/** Numbers for the fixture's own published posts, so "Top posts" opens real posts in the drawer. */
const KNOWN: Record<string, { impressions: number; engagements: number; basis: TopPost["basis"] }> = {
  p_ratio: { impressions: 18_400, engagements: 612, basis: "72h" },
  p_chai_iced: { impressions: 14_200, engagements: 540, basis: "72h" },
  p_chai_explained: { impressions: 9_100, engagements: 203, basis: "72h" },
  p_chai_ratio: { impressions: 3_900, engagements: 96, basis: "24h" },
  p_cal_open: { impressions: 2_100, engagements: 71, basis: "latest" },
};

function topPosts(deps: AnalyticsFixtureDeps, from: number, to: number, q: AnalyticsQuery): TopPost[] {
  const out: TopPost[] = [];
  for (const p of deps.posts()) {
    const published = p.variants.filter((v) => v.status === "published" && v.publishedAt && (!q.networks?.length || q.networks.includes(v.network)) && (!q.accounts?.length || q.accounts.includes(v.socialAccountId)));
    if (!published.length) continue;
    const at = Math.min(...published.map((v) => Date.parse(v.publishedAt!)));
    if (at < from || at > to) continue;
    const seed = [...p.post.id].reduce((n, c) => n + c.charCodeAt(0), 0);
    const k = KNOWN[p.post.id] ?? { impressions: 1200 + (seed % 9) * 310, engagements: 30 + (seed % 7) * 11, basis: "24h" as const };
    const share = published.length / Math.max(1, p.variants.length);
    const impressions = Math.round(k.impressions * share);
    const engagements = Math.round(k.engagements * share);
    out.push({
      postId: p.post.id,
      variantIds: published.map((v) => v.id),
      text: p.post.body,
      networks: [...new Set(published.map((v) => v.network))],
      url: published.find((v) => v.externalUrl)?.externalUrl ?? null,
      publishedAt: new Date(at).toISOString(),
      impressions,
      engagements,
      engagementRate: impressions ? engagements / impressions : null,
      linkClicks: p.post.id === "p_ratio" ? 233 : p.post.id === "p_chai_iced" ? 57 : 0,
      conversions: p.post.id === "p_ratio" ? 1 : 0,
      basis: k.basis,
    });
  }
  return out.sort((a, b) => b.engagements - a.engagements).slice(0, 10);
}

function buildPayload(deps: AnalyticsFixtureDeps, q: AnalyticsQuery): AnalyticsPayload {
  const from = Date.parse(q.from);
  const to = Date.parse(q.to);
  if (!(from < to)) throw new ApiError(400, "invalid", "from must be before to");
  const tz = deps.timezone();
  const prev = previousWindow(new Date(from), new Date(to));
  const cur = windowOf(deps, from, to, q);
  const before = windowOf(deps, prev.from.getTime(), prev.to.getTime(), q);
  const change = Object.fromEntries(TOTAL_KEYS.map((k) => [k, pctChange(cur.totals[k], before.totals[k])])) as Record<TotalKey, number | null>;
  const learnFrom = Math.min(from, to - 90 * DAY);
  const learning = windowOf(deps, learnFrom, to, q).posts;
  const bestTimes = bestTimesFrom(
    learning.filter((p) => p.impressions > 0).map((p) => ({ at: new Date(p.at), rate: p.engagements / p.impressions })),
    tz,
    new Date(learnFrom),
    new Date(to),
  );
  const eng = (xs: HistPost[]) => xs.map((p) => engagementsOf({ engagements: p.engagements }));
  const split = (pred: (p: HistPost) => boolean) => [eng(learning.filter(pred)), eng(learning.filter((p) => !pred(p)))] as const;
  const comparisons = [
    compareGroups("trend", "Riding a trend", "Posts that rode a trend", "Posts that didn't", ...split((p) => p.rodeTrend)),
    compareGroups("media", "Images or video", "Posts with images or video", "Posts without", ...split((p) => p.hasMedia)),
    compareGroups("length", "Short text", "Short posts (under 120 characters)", "Longer posts", ...split((p) => p.textLength < 120)),
    compareGroups("kind:reel", "Reels", "Reels", "Other kinds of post", ...split((p) => p.kind === "reel")),
    compareGroups("kind:poll", "Polls", "Polls", "Other kinds of post", [40, 52, 31], eng(learning.slice(0, 40))),
  ];
  const days = Math.max(1, Math.round((to - from) / DAY));
  return {
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), previousFrom: prev.from.toISOString(), previousTo: prev.to.toISOString(), days, timezone: tz },
    filters: { networks: q.networks ?? [], accounts: q.accounts ?? [] },
    totals: cur.totals,
    previous: before.totals,
    change,
    currency: "USD",
    byNetwork: cur.byNetwork,
    byAccount: cur.byAccount,
    topPosts: topPosts(deps, from, to, q),
    bestTimes,
    whatWorked: {
      from: new Date(learnFrom).toISOString(),
      to: new Date(to).toISOString(),
      minPerSide: 5,
      comparisons,
      stages: [
        { stage: "rising", posts: 14, avgEngagements: 212, lift: 2.3 },
        { stage: "peaking", posts: 9, avgEngagements: 128, lift: 1.4 },
        { stage: "plateau", posts: 6, avgEngagements: 88, lift: 0.96 },
        { stage: "fading", posts: 3, avgEngagements: 61, lift: 0.66 },
        { stage: "no_trend", posts: 61, avgEngagements: 84, lift: 0.91 },
      ],
    },
    series: cur.series,
    previousSeries: before.series,
    mentions: cur.mentions,
    measured: { posts: cur.totals.posts, withNumbers: Math.max(0, cur.totals.posts - (days <= 7 ? 3 : 2)) },
  };
}

// ---------------------------------------------------------------- reports

type FxReport = Report & { workspaceId: string };

function view(r: FxReport, deps: AnalyticsFixtureDeps): Report {
  const logo = r.branding.logoMediaId ? (deps.media().find((m) => m.id === r.branding.logoMediaId)?.url ?? null) : null;
  const { workspaceId: _ws, ...rest } = r;
  void _ws;
  return { ...rest, branding: { ...r.branding, logoUrl: logo }, scheduleSummary: scheduleSummary(r.schedule, r.recipients.length), nextSendAt: nextSend(r.schedule, deps.timezone()) };
}

function nextSend(s: ReportScheduleSpec, tz: string): string | null {
  if (s.kind === "none") return null;
  for (let h = 1; h <= 24 * 32; h++) {
    const t = Math.ceil(NOW / HOUR) * HOUR + (h - 1) * HOUR;
    const slot = localSlot(new Date(t), tz);
    const dom = Number(slot.day.slice(8));
    if (slot.hour === s.hour && (s.kind === "weekly" ? slot.weekday === s.weekday : dom === s.day)) return new Date(t).toISOString();
  }
  return null;
}

const DEFAULT_SECTIONS: ReportSection[] = ["summary", "by_network", "top_posts", "links", "what_worked", "upcoming"];

function seedReports(workspaceId: string): FxReport[] {
  const base = { workspaceId, filters: { networks: [] as string[], accounts: [] as string[] }, createdBy: { type: "human", id: "usr_maya" }, shares: { active: 0, lastCreatedAt: null as string | null }, lastSentPeriod: null };
  return [
    {
      ...base,
      id: "rpt_weekly",
      name: "Weekly for the owners",
      period: "last_7_days",
      sections: ["summary", "by_network", "top_posts", "best_times", "links", "mentions", "what_worked", "upcoming"],
      branding: { title: "Northwind social, week in review", clientName: "Northwind Coffee", logoMediaId: "med_logo", logoUrl: null, accent: "#b5541c" },
      recipients: ["ana@northwind.coffee", "luis@northwind.coffee", "ops@northwind.coffee"],
      schedule: { kind: "weekly", weekday: 0, hour: 8 },
      scheduleSummary: "",
      nextSendAt: null,
      intro: "Cold brew kept carrying the week. The Guji launch goes out Tuesday; numbers for it land in next week's report.",
      lastSentAt: new Date(NOW - 5 * DAY).toISOString(),
      shares: { active: 1, lastCreatedAt: new Date(NOW - 12 * DAY).toISOString() },
      createdAt: new Date(NOW - 40 * DAY).toISOString(),
      updatedAt: new Date(NOW - 5 * DAY).toISOString(),
    },
    {
      ...base,
      id: "rpt_monthly",
      name: "Monthly share of voice",
      period: "calendar_month",
      sections: ["summary", "tracker", "mentions", "best_times"],
      branding: { title: "Northwind: the month in public", clientName: "Northwind Coffee", logoMediaId: null, logoUrl: null, accent: DEFAULT_ACCENT },
      recipients: ["board@northwind.coffee"],
      schedule: { kind: "monthly", day: 1, hour: 9 },
      scheduleSummary: "",
      nextSendAt: null,
      intro: null,
      lastSentAt: null,
      createdAt: new Date(NOW - 9 * DAY).toISOString(),
      updatedAt: new Date(NOW - 9 * DAY).toISOString(),
    },
  ];
}

function periodOf(period: Report["period"], tz: string): { from: number; to: number; label: string } {
  const today = localSlot(new Date(NOW), tz);
  // Midnight local today, found by walking back to the hour where the local day starts.
  let midnight = Math.floor(NOW / HOUR) * HOUR;
  while (localSlot(new Date(midnight - HOUR), tz).day === today.day) midnight -= HOUR;
  const fmt = (t: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).format(new Date(t));
  if (period === "calendar_month") {
    let start = midnight;
    while (localSlot(new Date(start - HOUR), tz).day.slice(0, 7) === today.day.slice(0, 7)) start -= HOUR;
    let prevStart = start - HOUR;
    const prevMonth = localSlot(new Date(prevStart), tz).day.slice(0, 7);
    while (localSlot(new Date(prevStart - HOUR), tz).day.slice(0, 7) === prevMonth) prevStart -= HOUR;
    return { from: prevStart, to: start - 1, label: fmt(prevStart, { month: "long", year: "numeric" }) };
  }
  const days = period === "last_30_days" ? 30 : 7;
  const from = midnight - days * DAY;
  return { from, to: midnight - 1, label: `${fmt(from + HOUR, { month: "short", day: "numeric" })} – ${fmt(midnight - HOUR, { month: "short", day: "numeric", year: "numeric" })}` };
}

async function documentFor(deps: AnalyticsFixtureDeps, def: Pick<Report, "name" | "period" | "sections" | "intro"> & { branding: Partial<Report["branding"]>; filters?: { networks?: string[]; accounts?: string[] } }): Promise<ReportDocument> {
  const tz = deps.timezone();
  const p = periodOf(def.period, tz);
  const q: AnalyticsQuery = { from: new Date(p.from).toISOString(), to: new Date(p.to).toISOString(), networks: def.filters?.networks, accounts: def.filters?.accounts };
  const analytics = buildPayload(deps, q);
  let links: ReportDocument["links"] = null;
  if (def.sections.includes("links")) {
    const l = await deps.linkReport(q.from, q.to);
    links = {
      configured: l.configured,
      clicks: l.totals.clicks,
      uniqueVisitors: l.totals.uniqueVisitors,
      conversions: l.totals.conversions,
      conversionValue: l.totals.conversionValue,
      currency: l.totals.valueByCurrency[0]?.currency ?? "USD",
      top: l.topLinks.map((t) => ({ shortUrl: t.shortUrl, destination: t.destination, network: t.network, clicks: t.clicks, conversions: t.conversions })),
    };
  }
  let tracker: ReportDocument["tracker"] = null;
  if (def.sections.includes("tracker")) {
    const rep = await deps.entityReport(q.from, q.to);
    const ids = new Set(rep.entities.map((e) => e.id));
    const top = rep.entities.filter((e) => !e.parentId || !ids.has(e.parentId)).sort((a, b) => b.familyMentions - a.familyMentions);
    tracker = top.flatMap((e) => [
      { name: e.name, kind: e.kind, relation: e.relation, depth: 0, mentions: e.mentions, people: e.people, shareOfVoice: e.shareOfVoice, sentiment: e.sentiment },
      ...rep.entities.filter((k) => k.parentId === e.id).map((k) => ({ name: k.name, kind: k.kind, relation: k.relation, depth: 1, mentions: k.mentions, people: k.people, shareOfVoice: k.shareWithinParent, sentiment: k.sentiment })),
    ]);
  }
  let upcoming: ReportDocument["upcoming"] = null;
  if (def.sections.includes("upcoming")) {
    const cal = await deps.calendar(new Date(NOW).toISOString(), new Date(NOW + 14 * DAY).toISOString());
    upcoming = cal
      .filter((c) => ["scheduled", "approved", "pending_approval"].includes(c.post.status) && c.post.scheduledAt && Date.parse(c.post.scheduledAt) > NOW)
      .map((c) => ({ at: c.post.scheduledAt!, networks: [...new Set(c.variants.map((v) => v.network))], text: c.post.body, status: c.post.status }));
  }
  const logo = def.branding.logoMediaId ? (deps.media().find((m) => m.id === def.branding.logoMediaId)?.url ?? null) : null;
  return {
    title: def.branding.title || def.name,
    clientName: def.branding.clientName || null,
    workspaceName: deps.workspaceName(),
    logoUrl: logo,
    accent: def.branding.accent || DEFAULT_ACCENT,
    intro: def.intro,
    periodLabel: p.label,
    generatedAt: new Date().toISOString(),
    timezone: tz,
    sections: def.sections,
    analytics,
    links,
    tracker,
    upcoming,
    viewUrl: null,
  };
}

export function createAnalyticsFixtures(deps: AnalyticsFixtureDeps) {
  const byWs = new Map<string, FxReport[]>();
  const here = (): FxReport[] => {
    const ws = deps.workspaceId();
    if (!byWs.has(ws)) byWs.set(ws, ws === "ws_northwind" ? seedReports(ws) : []);
    return byWs.get(ws)!;
  };
  const find = (id: string) => {
    const r = here().find((x) => x.id === id);
    if (!r) throw new ApiError(404, "not_found", "No such report.");
    return r;
  };
  const manager = () => {
    if (!["owner", "approver", "editor"].includes(deps.role())) throw new ApiError(403, "forbidden", "Only owners, approvers and editors manage reports.");
  };
  let seq = 0;

  return {
    analytics: (q: AnalyticsQuery) => delay(buildPayload(deps, q), 260),
    reports: () => delay(here().map((r) => view(r, deps))),
    createReport: async (input: ReportInput): Promise<Report> => {
      manager();
      if (!input.name.trim()) throw new ApiError(400, "invalid", "Give the report a name.");
      const now = new Date().toISOString();
      const r: FxReport = {
        id: `rpt_fx${++seq}`,
        workspaceId: deps.workspaceId(),
        name: input.name.trim(),
        period: input.period ?? "last_7_days",
        sections: input.sections ?? DEFAULT_SECTIONS,
        branding: { title: input.branding?.title ?? null, clientName: input.branding?.clientName ?? null, logoMediaId: input.branding?.logoMediaId ?? null, logoUrl: null, accent: input.branding?.accent ?? DEFAULT_ACCENT },
        recipients: [...new Set(input.recipients ?? [])],
        schedule: input.schedule ?? { kind: "none" },
        scheduleSummary: "",
        nextSendAt: null,
        filters: { networks: input.filters?.networks ?? [], accounts: input.filters?.accounts ?? [] },
        intro: input.intro ?? null,
        lastSentAt: null,
        lastSentPeriod: null,
        shares: { active: 0, lastCreatedAt: null },
        createdBy: { type: "human", id: "usr_maya" },
        createdAt: now,
        updatedAt: now,
      };
      here().unshift(r);
      return delay(view(r, deps), 240);
    },
    updateReport: async (id: string, input: Partial<ReportInput>): Promise<Report> => {
      manager();
      const r = find(id);
      if (input.name !== undefined) r.name = input.name.trim() || r.name;
      if (input.period) r.period = input.period;
      if (input.sections) r.sections = input.sections;
      if (input.branding) r.branding = { ...r.branding, ...input.branding, title: input.branding.title ?? r.branding.title, clientName: input.branding.clientName ?? r.branding.clientName, logoMediaId: input.branding.logoMediaId === undefined ? r.branding.logoMediaId : input.branding.logoMediaId, accent: input.branding.accent ?? r.branding.accent };
      if (input.recipients) r.recipients = [...new Set(input.recipients)];
      if (input.schedule) r.schedule = input.schedule;
      if (input.filters) r.filters = { networks: input.filters.networks ?? [], accounts: input.filters.accounts ?? [] };
      if (input.intro !== undefined) r.intro = input.intro;
      r.updatedAt = new Date().toISOString();
      return delay(view(r, deps), 240);
    },
    deleteReport: async (id: string): Promise<void> => {
      manager();
      find(id);
      byWs.set(deps.workspaceId(), here().filter((r) => r.id !== id));
      await delay(null);
    },
    renderReport: async (id: string): Promise<string> => {
      const r = find(id);
      return renderReportHtml(await documentFor(deps, r));
    },
    previewReport: async (input: ReportInput): Promise<string> =>
      renderReportHtml(
        await documentFor(deps, {
          name: input.name || "Untitled report",
          period: input.period ?? "last_7_days",
          sections: input.sections ?? DEFAULT_SECTIONS,
          intro: input.intro ?? null,
          branding: input.branding ?? {},
          filters: input.filters,
        }),
      ),
    sendReport: async (id: string): Promise<ReportSent> => {
      const r = find(id);
      if (deps.role() === "viewer") throw new ApiError(403, "forbidden", "Viewers can't send reports.");
      if (!r.recipients.length) throw new ApiError(400, "invalid", "Add at least one recipient first.");
      r.lastSentAt = new Date().toISOString();
      r.shares.active += 1;
      const p = periodOf(r.period, deps.timezone());
      return delay({ sent: r.recipients.length, period: `${r.period}:sample`, periodLabel: p.label, viewUrl: `${window.location.origin}/r/sample-${r.id}` }, 600);
    },
    shareReport: async (id: string): Promise<ReportShare> => {
      manager();
      const r = find(id);
      r.shares = { active: r.shares.active + 1, lastCreatedAt: new Date().toISOString() };
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      return delay({ id: `rsh_fx${seq}`, url: `${window.location.origin}/r/${token}`, createdAt: new Date().toISOString() });
    },
    revokeReportShares: async (id: string): Promise<void> => {
      manager();
      const r = find(id);
      r.shares = { active: 0, lastCreatedAt: r.shares.lastCreatedAt };
      await delay(null);
    },
  };
}

/** A small wordmark for the sample report's logo, as a media library image. */
export function sampleLogoDataUrl(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120" viewBox="0 0 480 120"><rect width="480" height="120" rx="14" fill="#2b1a10"/><circle cx="62" cy="60" r="34" fill="#b5541c"/><path d="M50 74c10-22 20-30 30-30-6 8-10 18-12 30z" fill="#f3e4d0"/><text x="112" y="74" font-family="Georgia, serif" font-size="44" fill="#f3e4d0">Northwind</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
