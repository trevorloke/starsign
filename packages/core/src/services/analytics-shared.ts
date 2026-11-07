// Analytics payload types, the pure analytics math (medians, best-time buckets, "X× the median" comparisons) and the
// client-report renderer. Import-free on purpose: the core uses it to answer /v1/analytics and render reports, and
// the web app imports the same file (types, schedule wording, and its fixtures), so a sample report in fixture mode
// is drawn by exactly the code that draws a real one.

// ---------------------------------------------------------------- the analytics payload

export interface AnalyticsTotals {
  /** Posts that went out, counting each network once. */
  posts: number;
  impressions: number;
  engagements: number;
  /** engagements / impressions over the posts that reported impressions; null when none did. */
  engagementRate: number | null;
  /** Non-bot clicks on Starsign's own short links. */
  linkClicks: number;
  conversions: number;
  conversionValue: number;
  /** Null when no account in scope reports followers. */
  followersGained: number | null;
  /** Mentions, replies, comments and quotes received by the accounts in scope. */
  mentions: number;
}

export const TOTAL_KEYS = ["posts", "impressions", "engagements", "engagementRate", "linkClicks", "conversions", "conversionValue", "followersGained", "mentions"] as const;
export type TotalKey = (typeof TOTAL_KEYS)[number];

export interface NetworkRow extends AnalyticsTotals {
  network: string;
}
export interface AccountRow extends AnalyticsTotals {
  accountId: string;
  network: string;
  handle: string;
  displayName: string | null;
}

/** Which numbers a post's figures come from: an outcome snapshot, or the latest metrics when none was captured. */
export type OutcomeBasis = "72h" | "24h" | "latest" | "none";

export interface TopPost {
  postId: string;
  variantIds: string[];
  text: string;
  networks: string[];
  url: string | null;
  publishedAt: string;
  impressions: number;
  engagements: number;
  engagementRate: number | null;
  linkClicks: number;
  conversions: number;
  basis: OutcomeBasis;
}

/** weekday 0 = Monday … 6 = Sunday, hour 0-23, both in the workspace's time zone. */
export interface HeatCell {
  weekday: number;
  hour: number;
  posts: number;
  medianRate: number | null;
  /** Fewer than `minPosts` posts: shown, never recommended. */
  thin: boolean;
}

export interface BestTimes {
  from: string;
  to: string;
  /** Posts with a 24-hour engagement rate in the window. */
  posts: number;
  minPosts: number;
  cells: HeatCell[];
  maxRate: number | null;
  best: { weekdays: number[]; fromHour: number; toHour: number; medianRate: number } | null;
  recommendation: string;
}

export interface ComparisonSide {
  label: string;
  posts: number;
  median: number | null;
}
export type ComparisonVerdict = "better" | "worse" | "similar" | "not_enough";
export interface Comparison {
  id: string;
  label: string;
  a: ComparisonSide;
  b: ComparisonSide;
  /** median(a) / median(b); null when either side has too few posts or b's median is zero. */
  ratio: number | null;
  verdict: ComparisonVerdict;
  sentence: string;
}
export interface StageLift {
  stage: string;
  posts: number;
  avgEngagements: number;
  lift: number | null;
}
export interface WhatWorked {
  from: string;
  to: string;
  minPerSide: number;
  comparisons: Comparison[];
  /** MetricsService.liftByStage over the same window (every network). */
  stages: StageLift[];
}

export interface DailyPoint {
  /** YYYY-MM-DD in the workspace's time zone. */
  day: string;
  /** Of posts published that day, at their best available snapshot. */
  impressions: number;
  engagements: number;
  /** Clicks on short links that day. */
  clicks: number;
  /** Followers across the accounts in scope at the end of the day; null when none report it. */
  followers: number | null;
}

export interface MentionSummary {
  total: number;
  byNetwork: { network: string; n: number }[];
  positive: number;
  neutral: number;
  negative: number;
  unscored: number;
  averageSentiment: number | null;
}

export interface AnalyticsPayload {
  window: { from: string; to: string; previousFrom: string; previousTo: string; days: number; timezone: string };
  filters: { networks: string[]; accounts: string[] };
  totals: AnalyticsTotals;
  previous: AnalyticsTotals;
  /** Fractional change against the previous equal period (0.12 = +12%); null when the previous value was 0 or unknown. */
  change: Record<TotalKey, number | null>;
  /** The conversion currency when there is exactly one. */
  currency: string | null;
  byNetwork: NetworkRow[];
  byAccount: AccountRow[];
  topPosts: TopPost[];
  bestTimes: BestTimes;
  whatWorked: WhatWorked;
  series: DailyPoint[];
  previousSeries: DailyPoint[];
  mentions: MentionSummary;
  /** How many posts went out in the period and how many have numbers yet. */
  measured: { posts: number; withNumbers: number };
}

/** A heatmap cell with fewer posts than this is shown but never recommended. */
export const MIN_CELL_POSTS = 3;
/** "What worked" never claims a difference with fewer posts than this on either side. */
export const MIN_PER_SIDE = 5;
/** Best times and what worked look back at least this far: a week holds too few posts to learn from. */

// ---------------------------------------------------------------- analytics math (pure; the core and the web fixtures share it)

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

type Bag = Record<string, number> | null | undefined;
/** Engagements as reported, else the sum of the interactions the network did report. */
export function engagementsOf(m: Bag): number {
  if (!m) return 0;
  if (typeof m.engagements === "number") return m.engagements;
  return (m.likes ?? 0) + (m.replies ?? 0) + (m.reposts ?? 0) + (m.quotes ?? 0) + (m.shares ?? 0) + (m.saves ?? 0);
}
/** Null when the network does not report impressions (engagement rate is then unknown, not zero). */
export function impressionsOf(m: Bag): number | null {
  if (!m) return null;
  const v = m.impressions ?? m.reach ?? m.video_views;
  return typeof v === "number" ? v : null;
}

/** Fractional change; null when there is nothing to compare against. 0 → 0 is no change. */
export function pctChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / Math.abs(previous);
}

/** The previous period of equal length, ending just before `from`. */
export function previousWindow(from: Date, to: Date): { from: Date; to: Date } {
  const len = to.getTime() - from.getTime();
  return { from: new Date(from.getTime() - len - 1), to: new Date(from.getTime() - 1) };
}

const slotFormatters = new Map<string, Intl.DateTimeFormat>();
function slotFormatter(tz: string): Intl.DateTimeFormat {
  let f = slotFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    slotFormatters.set(tz, f);
  }
  return f;
}
const WD: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Local weekday (0 = Monday), hour and YYYY-MM-DD of an instant in `tz`. DST is the zone's business, not ours. */
export function localSlot(at: Date, tz: string): { weekday: number; hour: number; day: string } {
  const p: Record<string, string> = {};
  for (const x of slotFormatter(tz).formatToParts(at)) p[x.type] = x.value;
  return { weekday: WD[p.weekday ?? "Mon"] ?? 0, hour: Number(p.hour ?? 0) % 24, day: `${p.year}-${p.month}-${p.day}` };
}

/** Every local day from `from` to `to`, with the instant each one ends (the last ends at `to`). */
export function localDays(from: Date, to: Date, tz: string): { day: string; end: Date }[] {
  const out: { day: string; end: Date }[] = [];
  let current = localSlot(from, tz).day;
  // Step by the hour from the top of the hour: day boundaries land on a whole hour in every zone with whole-hour
  // offsets; half-hour zones (India) get the boundary within the hour, which is fine for a day's closing count.
  for (let t = from.getTime() - (from.getTime() % 3_600_000) + 3_600_000; t <= to.getTime(); t += 3_600_000) {
    const d = localSlot(new Date(t), tz).day;
    if (d !== current) {
      out.push({ day: current, end: new Date(t - 1) });
      current = d;
    }
  }
  out.push({ day: current, end: to });
  return out;
}

/** The 7×24 grid of median engagement rate at 24h by local weekday and hour of publish, and a plain recommendation. */
export function bestTimesFrom(samples: { at: Date; rate: number }[], tz: string, from: Date, to: Date): BestTimes {
  const buckets = new Map<string, number[]>();
  for (const s of samples) {
    const { weekday, hour } = localSlot(s.at, tz);
    const k = `${weekday}:${hour}`;
    buckets.set(k, [...(buckets.get(k) ?? []), s.rate]);
  }
  const cells: HeatCell[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      const xs = buckets.get(`${weekday}:${hour}`) ?? [];
      cells.push({ weekday, hour, posts: xs.length, medianRate: median(xs), thin: xs.length < MIN_CELL_POSTS });
    }
  }
  const solid = cells.filter((c) => !c.thin && c.medianRate !== null);
  // The colour scale tops out at the best cell that counts, so one lucky thin hour cannot wash the rest out.
  const top = (cs: HeatCell[]) => cs.reduce<number | null>((m, c) => (c.medianRate !== null && (m === null || c.medianRate > m) ? c.medianRate : m), null);
  const maxRate = top(solid) ?? top(cells);
  const n = samples.length;
  const base = { from: from.toISOString(), to: to.toISOString(), posts: n, minPosts: MIN_CELL_POSTS, cells, maxRate };
  if (n === 0) return { ...base, best: null, recommendation: "No posts with 24-hour numbers yet. Best times show up once posts have been out for a day." };
  if (!solid.length) {
    return { ...base, best: null, recommendation: `Not enough posts yet to say when to post: an hour needs at least ${MIN_CELL_POSTS} posts with 24-hour numbers (${n} ${n === 1 ? "post" : "posts"} so far).` };
  }
  const lead = solid.reduce((b, c) => (c.medianRate! > b.medianRate! || (c.medianRate === b.medianRate && c.posts > b.posts) ? c : b));
  const near = solid.filter((c) => c.medianRate! >= lead.medianRate! * 0.85 && Math.abs(c.hour - lead.hour) <= 2);
  const weekdays = [...new Set(near.map((c) => c.weekday))].sort((a, b) => a - b);
  const fromHour = Math.min(...near.map((c) => c.hour));
  const toHour = Math.max(...near.map((c) => c.hour)) + 1;
  const days = weekdays.length >= 5 && weekdays.every((d) => d < 5) ? "Weekdays" : listWords(weekdays.map((d) => `${WEEKDAYS[d]}s`));
  return {
    ...base,
    best: { weekdays, fromHour, toHour, medianRate: lead.medianRate! },
    recommendation: `${days} ${hourRange(fromHour, toHour)} have done best; based on ${n} ${n === 1 ? "post" : "posts"}.`,
  };
}

/** "A got X× the median of B", only when both sides have enough posts. */
export function compareGroups(id: string, label: string, aLabel: string, bLabel: string, a: number[], b: number[]): Comparison {
  const ma = median(a);
  const mb = median(b);
  const sideA = { label: aLabel, posts: a.length, median: ma };
  const sideB = { label: bLabel, posts: b.length, median: mb };
  const counts = `${a.length} vs ${b.length} posts`;
  if (a.length < MIN_PER_SIDE || b.length < MIN_PER_SIDE) {
    return {
      id,
      label,
      a: sideA,
      b: sideB,
      ratio: null,
      verdict: "not_enough",
      sentence: `Not enough posts yet to compare ${lower(aLabel)} with ${lower(bLabel)} (${a.length} and ${b.length}; ${MIN_PER_SIDE} each needed).`,
    };
  }
  if (!mb) {
    const verdict = ma ? "better" : "similar";
    return { id, label, a: sideA, b: sideB, ratio: null, verdict, sentence: ma ? `${aLabel} got engagement where ${lower(bLabel)} got almost none (${counts}).` : `Neither ${lower(aLabel)} nor ${lower(bLabel)} got engagement yet (${counts}).` };
  }
  const ratio = (ma ?? 0) / mb;
  const verdict = ratio >= 1.1 ? "better" : ratio <= 0.9 ? "worse" : "similar";
  const sentence = verdict === "similar" ? `${aLabel} did about as well as ${lower(bLabel)} (${fmtRatio(ratio)} the median; ${counts}).` : `${aLabel} got ${fmtRatio(ratio)} the median engagements of ${lower(bLabel)} (${counts}).`;
  return { id, label, a: sideA, b: sideB, ratio, verdict, sentence };
}
function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}


// ---------------------------------------------------------------- report document

export const REPORT_SECTIONS = ["summary", "by_network", "top_posts", "best_times", "links", "tracker", "mentions", "what_worked", "upcoming"] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export const SECTION_LABEL: Record<ReportSection, string> = {
  summary: "Summary",
  by_network: "By network",
  top_posts: "Top posts",
  best_times: "Best times to post",
  links: "Links and conversions",
  tracker: "Share of voice",
  mentions: "Mentions and sentiment",
  what_worked: "What worked",
  upcoming: "Coming up",
};

export interface ReportLinks {
  configured: boolean;
  clicks: number;
  uniqueVisitors: number;
  conversions: number;
  conversionValue: number;
  currency: string | null;
  top: { shortUrl: string | null; destination: string; network: string | null; clicks: number; conversions: number }[];
}
export interface ReportTrackerRow {
  name: string;
  kind: string;
  relation: string;
  depth: number;
  mentions: number;
  people: number;
  shareOfVoice: number | null;
  sentiment: number | null;
}
export interface ReportUpcoming {
  at: string;
  networks: string[];
  text: string;
  status: string;
}

export interface ReportDocument {
  title: string;
  clientName: string | null;
  workspaceName: string;
  logoUrl: string | null;
  /** #rrggbb */
  accent: string;
  intro: string | null;
  periodLabel: string;
  generatedAt: string;
  timezone: string;
  sections: ReportSection[];
  analytics: AnalyticsPayload;
  links: ReportLinks | null;
  tracker: ReportTrackerRow[] | null;
  upcoming: ReportUpcoming[] | null;
  /** Where the latest version can be read (a share link), when there is one. */
  viewUrl: string | null;
}

// ---------------------------------------------------------------- words and numbers

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const DEFAULT_ACCENT = "#1f5eff";

/** 0 → "12am", 9 → "9am", 13 → "1pm", 24 → "12am". */
export function hourLabel(h: number): string {
  const x = ((h % 24) + 24) % 24;
  const n = x % 12 === 0 ? 12 : x % 12;
  return `${n}${x < 12 ? "am" : "pm"}`;
}

/** [9, 11) → "9–11am"; [11, 13) → "11am–1pm". */
export function hourRange(from: number, to: number): string {
  const a = hourLabel(from);
  const b = hourLabel(to);
  const sameHalf = from % 24 < 12 === to % 24 < 12 && to % 24 !== 0 && to - from < 12;
  return sameHalf ? `${a.replace(/[ap]m$/, "")}–${b}` : `${a}–${b}`;
}

/** ["Tuesdays", "Thursdays"] → "Tuesdays and Thursdays". */
export function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** 1234 → "1,234", 12345 → "12.3K", 4200000 → "4.2M". */
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a < 10_000) return fmtInt(n);
  if (a < 1_000_000) return `${(n / 1000).toFixed(a < 100_000 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** 0.0423 → "4.2%". */
export function fmtRate(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const p = x * 100;
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

/** 0.12 → "+12%", -0.08 → "−8%", null → "—". */
export function fmtChange(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const p = x * 100;
  const r = Math.abs(p) < 10 ? Math.round(p * 10) / 10 : Math.round(p);
  if (r === 0) return "0%";
  return `${r > 0 ? "+" : "−"}${Math.abs(r)}%`;
}

export function fmtMoney(value: number, currency: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);
    } catch {
      return `${fmtInt(value)} ${currency}`;
    }
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** 1.83 → "1.8×". */
export function fmtRatio(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${x < 10 ? x.toFixed(1) : Math.round(x)}×`;
}

const NETWORK_NAMES: Record<string, string> = {
  x: "X",
  bluesky: "Bluesky",
  instagram: "Instagram",
  threads: "Threads",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube",
  pinterest: "Pinterest",
  mastodon: "Mastodon",
  reddit: "Reddit",
  google_business: "Google Business",
  telegram: "Telegram",
  discord: "Discord",
  whatsapp: "WhatsApp",
  wechat: "WeChat",
  line: "LINE",
  news: "News",
};
export function networkName(n: string): string {
  return NETWORK_NAMES[n] ?? n.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** What a metric is called in tiles, tables and the report. */
export const TOTAL_LABEL: Record<TotalKey, string> = {
  posts: "Posts published",
  impressions: "Impressions",
  engagements: "Engagements",
  engagementRate: "Engagement rate",
  linkClicks: "Link clicks",
  conversions: "Conversions",
  conversionValue: "Conversion value",
  followersGained: "Followers gained",
  mentions: "Mentions received",
};

export function formatTotal(key: TotalKey, t: AnalyticsTotals, currency: string | null): string {
  const v = t[key];
  if (key === "engagementRate") return fmtRate(v);
  if (key === "conversionValue") return t.conversionValue ? fmtMoney(t.conversionValue, currency) : "—";
  if (v === null) return "—";
  if (key === "followersGained") return `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtCompact(Math.abs(v))}`;
  return fmtCompact(v);
}

// ---------------------------------------------------------------- HTML

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const esc = escapeHtml;

/** Only http(s) links are ever written into the report; anything else becomes plain text. */
export function safeHttpUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" ? x.toString() : null;
  } catch {
    return null;
  }
}

function safeAccent(c: string | null | undefined): string {
  return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : DEFAULT_ACCENT;
}

function excerpt(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
}

function dateIn(iso: string, tz: string, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(new Date(iso));
  }
}
/** "2026-11-03" → "Nov 3". */
function dayShort(day: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${day}T12:00:00Z`));
}

const KPI_KEYS: TotalKey[] = ["posts", "impressions", "engagements", "engagementRate", "linkClicks", "conversions", "followersGained", "mentions"];
/** For these a fall is good news, which none of ours are; kept explicit so a future metric can say so. */
const DOWN_IS_GOOD = new Set<TotalKey>();

function changeClass(key: TotalKey, x: number | null): string {
  if (x === null || Math.abs(x) < 0.005) return "flat";
  const up = x > 0;
  return up !== DOWN_IS_GOOD.has(key) ? "up" : "down";
}

function kpis(a: AnalyticsPayload): string {
  const tiles = KPI_KEYS.map((k) => {
    const ch = a.change[k];
    const prev = formatTotal(k, a.previous, a.currency);
    return `<div class="kpi"><div class="kpi-label">${esc(TOTAL_LABEL[k])}</div><div class="kpi-value">${esc(formatTotal(k, a.totals, a.currency))}</div><div class="kpi-change ${changeClass(k, ch)}">${esc(fmtChange(ch))} <span class="muted">vs ${esc(prev)} before</span></div></div>`;
  });
  return `<div class="kpis">${tiles.join("")}</div>`;
}

/** One series line (this period) with the previous period as a quiet gray line beneath. One axis. */
export function lineChartSvg(points: { label: string; value: number }[], previous: number[] | null, opts: { width?: number; height?: number; title: string }): string {
  const W = opts.width ?? 680;
  const H = opts.height ?? 180;
  const padL = 44;
  const padR = 12;
  const padT = 10;
  const padB = 24;
  if (points.length === 0) return "";
  const all = [...points.map((p) => p.value), ...(previous ?? [])];
  const max = niceMax(Math.max(1, ...all));
  const n = points.length;
  const x = (i: number) => padL + (n === 1 ? (W - padL - padR) / 2 : (i / (n - 1)) * (W - padL - padR));
  const y = (v: number) => padT + (1 - v / max) * (H - padT - padB);
  const path = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const ticks = max < 4 ? [0, max] : [0, max / 2, max];
  const grid = ticks.map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" class="grid"/><text x="${padL - 6}" y="${(y(t) + 4).toFixed(1)}" class="tick" text-anchor="end">${esc(fmtCompact(t))}</text>`).join("");
  const xl = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, arr) => arr.indexOf(v) === i);
  const xlabels = xl.map((i) => `<text x="${x(i).toFixed(1)}" y="${H - 6}" class="tick" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${esc(points[i]!.label)}</text>`).join("");
  const prev = previous && previous.length ? `<path d="${path(previous.slice(0, n))}" class="line-prev" fill="none"/>` : "";
  const last = points[n - 1]!;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(opts.title)}" class="chart"><title>${esc(opts.title)}</title>${grid}${xlabels}${prev}<path d="${path(points.map((p) => p.value))}" class="line" fill="none"/><circle cx="${x(n - 1).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="4" class="dot"/></svg>`;
}

function niceMax(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Sequential: one hue (the accent), light → dark by median engagement rate. Thin cells are hatched. */
export function heatmapSvg(bt: BestTimes, accent: string): string {
  const cw = 22;
  const ch = 20;
  const left = 36;
  const top = 18;
  const W = left + 24 * cw + 4;
  const H = top + 7 * ch + 4;
  const max = bt.maxRate ?? 0;
  const cells = bt.cells
    .map((c) => {
      const cx = left + c.hour * cw;
      const cy = top + c.weekday * ch;
      const label = `${WEEKDAYS[c.weekday]} ${hourLabel(c.hour)}: ${c.posts ? `${fmtRate(c.medianRate)} median engagement rate, ${c.posts} ${c.posts === 1 ? "post" : "posts"}` : "no posts"}${c.thin && c.posts ? " (too few to judge)" : ""}`;
      if (!c.posts) return `<rect x="${cx + 1}" y="${cy + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" class="cell-empty"><title>${esc(label)}</title></rect>`;
      if (c.thin) return `<rect x="${cx + 1}" y="${cy + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" fill="url(#thin)" class="cell-thin"><title>${esc(label)}</title></rect>`;
      const t = max > 0 && c.medianRate !== null ? Math.min(1, c.medianRate / max) : 0;
      const op = (0.15 + 0.85 * t).toFixed(2);
      return `<rect x="${cx + 1}" y="${cy + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" fill="${accent}" fill-opacity="${op}"><title>${esc(label)}</title></rect>`;
    })
    .join("");
  const days = WEEKDAYS_SHORT.map((d, i) => `<text x="${left - 6}" y="${top + i * ch + 14}" class="tick" text-anchor="end">${d}</text>`).join("");
  const hours = [0, 3, 6, 9, 12, 15, 18, 21].map((h) => `<text x="${left + h * cw + cw / 2}" y="12" class="tick" text-anchor="middle">${hourLabel(h)}</text>`).join("");
  const defs = `<defs><pattern id="thin" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="thin-bg"/><line x1="0" y1="0" x2="0" y2="6" class="thin-line"/></pattern></defs>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(`Median engagement rate by weekday and hour. ${bt.recommendation}`)}" class="chart heat">${defs}${hours}${days}${cells}</svg>`;
}

function heatLegend(accent: string): string {
  const steps = [0.15, 0.36, 0.57, 0.79, 1]
    .map((o) => `<span class="sw" style="background:${accent};opacity:${o}"></span>`)
    .join("");
  return `<div class="legend"><span class="muted">Lower</span>${steps}<span class="muted">Higher median engagement rate</span><span class="sw sw-thin"></span><span class="muted">Fewer than 3 posts</span></div>`;
}

function section(id: ReportSection, body: string): string {
  return `<section class="sec" id="${id}"><h2>${esc(SECTION_LABEL[id])}</h2>${body}</section>`;
}

function table(head: string[], rows: string[][], numericFrom = 1): string {
  const th = head.map((h, i) => `<th scope="col"${i >= numericFrom ? ' class="num"' : ""}>${esc(h)}</th>`).join("");
  const tr = rows.map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td class="num">${c}</td>`)).join("")}</tr>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

function totalsCells(t: AnalyticsTotals, currency: string | null): string[] {
  return (["posts", "impressions", "engagements", "engagementRate", "linkClicks", "conversions", "followersGained", "mentions"] as TotalKey[]).map((k) => esc(formatTotal(k, t, currency)));
}

function summarySection(doc: ReportDocument): string {
  const a = doc.analytics;
  const pts = a.series.map((d) => ({ label: dayShort(d.day), value: d.engagements }));
  const total = a.series.reduce((n, d) => n + d.engagements, 0);
  const peak = a.series.reduce<DailyPoint | null>((b, d) => (!b || d.engagements > b.engagements ? d : b), null);
  const caption = a.series.length
    ? `${fmtInt(total)} engagements on posts published ${dayShort(a.series[0]!.day)} to ${dayShort(a.series[a.series.length - 1]!.day)}${peak && peak.engagements ? `, most from ${dayShort(peak.day)} (${fmtInt(peak.engagements)})` : ""}. The gray line is the previous period.`
    : "No posts went out in this period.";
  const chart = a.series.length > 1 ? lineChartSvg(pts, a.previousSeries.map((d) => d.engagements), { title: `Engagements by day posted. ${caption}` }) : "";
  const dataTable = a.series.length
    ? `<table class="sr-only"><caption>Engagements by day posted</caption><thead><tr><th scope="col">Day</th><th scope="col">Engagements</th><th scope="col">Impressions</th><th scope="col">Link clicks</th></tr></thead><tbody>${a.series.map((d) => `<tr><th scope="row">${esc(d.day)}</th><td>${d.engagements}</td><td>${d.impressions}</td><td>${d.clicks}</td></tr>`).join("")}</tbody></table>`
    : "";
  const note = a.measured.posts && a.measured.withNumbers < a.measured.posts ? `<p class="muted small">${fmtInt(a.measured.withNumbers)} of ${fmtInt(a.measured.posts)} posts have numbers so far; the rest are too recent or their network does not report them.</p>` : "";
  return section("summary", `${kpis(a)}<h3>Engagements by day posted</h3>${chart}<p class="caption">${esc(caption)}</p>${dataTable}${note}`);
}

function byNetworkSection(doc: ReportDocument): string {
  const a = doc.analytics;
  if (!a.byNetwork.length) return section("by_network", `<p class="muted">Nothing went out and nothing was received in this period.</p>`);
  const head = ["Network", "Posts", "Impressions", "Engagements", "Eng. rate", "Link clicks", "Conversions", "Followers", "Mentions"];
  return section("by_network", table(head, a.byNetwork.map((r) => [esc(networkName(r.network)), ...totalsCells(r, a.currency)])));
}

function topPostsSection(doc: ReportDocument): string {
  const posts = doc.analytics.topPosts.slice(0, 5);
  if (!posts.length) return section("top_posts", `<p class="muted">No posts with numbers in this period yet.</p>`);
  const items = posts
    .map((p, i) => {
      const href = safeHttpUrl(p.url);
      const when = dateIn(p.publishedAt, doc.timezone, { month: "short", day: "numeric" });
      const nets = p.networks.map(networkName).join(", ");
      const text = esc(excerpt(p.text, 220));
      return `<li class="post"><span class="rank">${i + 1}</span><div><p class="post-text">${text}</p><p class="post-meta">${esc(nets)} · ${esc(when)}${href ? ` · <a href="${esc(href)}">View post</a>` : ""}</p><p class="post-nums"><b>${esc(fmtCompact(p.engagements))}</b> engagements · <b>${esc(fmtCompact(p.impressions))}</b> impressions · <b>${esc(fmtRate(p.engagementRate))}</b> rate${p.linkClicks ? ` · <b>${esc(fmtCompact(p.linkClicks))}</b> clicks` : ""}</p></div></li>`;
    })
    .join("");
  return section("top_posts", `<ol class="posts">${items}</ol>`);
}

function bestTimesSection(doc: ReportDocument, accent: string): string {
  const bt = doc.analytics.bestTimes;
  const top = bt.cells
    .filter((c) => !c.thin && c.medianRate !== null)
    .sort((x, y) => (y.medianRate ?? 0) - (x.medianRate ?? 0))
    .slice(0, 5);
  const list = top.length
    ? `<table class="sr-only"><caption>Best hours</caption><tbody>${top.map((c) => `<tr><th scope="row">${esc(`${WEEKDAYS[c.weekday]} ${hourLabel(c.hour)}`)}</th><td>${esc(fmtRate(c.medianRate))}</td><td>${c.posts} posts</td></tr>`).join("")}</tbody></table>`
    : "";
  const span = `${dateIn(bt.from, doc.timezone, { month: "short", day: "numeric" })} to ${dateIn(bt.to, doc.timezone, { month: "short", day: "numeric" })}`;
  return section("best_times", `<p class="lede">${esc(bt.recommendation)}</p>${bt.posts ? heatmapSvg(bt, accent) + heatLegend(accent) : ""}<p class="muted small">Median engagement rate at 24 hours by the local weekday and hour a post went out (${esc(doc.timezone)}), from posts published ${esc(span)}.</p>${list}`);
}

function linksSection(doc: ReportDocument): string {
  const l = doc.links;
  if (!l || !l.configured) return section("links", `<p class="muted">Link tracking is not on for this workspace, so clicks are not counted.</p>`);
  const tiles = `<div class="kpis kpis-3"><div class="kpi"><div class="kpi-label">People who clicked</div><div class="kpi-value">${esc(fmtCompact(l.uniqueVisitors))}</div><div class="kpi-change muted">${esc(fmtInt(l.clicks))} clicks in all</div></div><div class="kpi"><div class="kpi-label">Conversions</div><div class="kpi-value">${esc(fmtCompact(l.conversions))}</div></div><div class="kpi"><div class="kpi-label">Value</div><div class="kpi-value">${esc(l.conversionValue ? fmtMoney(l.conversionValue, l.currency) : "—")}</div></div></div>`;
  const rows = l.top.slice(0, 5).map((t) => [esc(excerpt(t.destination.replace(/^https?:\/\//, ""), 60)), esc(t.network ? networkName(t.network) : "—"), esc(fmtCompact(t.clicks)), esc(fmtCompact(t.conversions))]);
  return section("links", `${tiles}${rows.length ? table(["Destination", "Network", "Clicks", "Conversions"], rows) : `<p class="muted">No clicks in this period.</p>`}`);
}

function trackerSection(doc: ReportDocument): string {
  const rows = doc.tracker ?? [];
  if (!rows.length) return section("tracker", `<p class="muted">No names are tracked yet.</p>`);
  const top = rows.filter((r) => r.depth === 0 && (r.shareOfVoice ?? 0) > 0).sort((a, b) => (b.shareOfVoice ?? 0) - (a.shareOfVoice ?? 0));
  const shown = top.slice(0, 6);
  const bar = shown.length >= 2
    ? `<div class="sov" role="img" aria-label="${esc(`Share of voice: ${shown.map((r) => `${r.name} ${Math.round(r.shareOfVoice ?? 0)}%`).join(", ")}`)}">${shown.map((r, i) => `<span class="sov-seg c${i + 1}" style="flex-grow:${(r.shareOfVoice ?? 0).toFixed(1)}">${(r.shareOfVoice ?? 0) >= 12 ? `${Math.round(r.shareOfVoice ?? 0)}%` : ""}</span>`).join("")}</div><ul class="sov-legend">${shown.map((r, i) => `<li><span class="sw c${i + 1}"></span>${esc(r.name)} <span class="muted">${Math.round(r.shareOfVoice ?? 0)}%</span></li>`).join("")}</ul>`
    : "";
  const tone = (s: number | null) => (s === null ? "—" : s >= 0.25 ? "Mostly positive" : s <= -0.25 ? "Mostly negative" : "Mixed");
  const t = table(
    ["Name", "Mentions", "People talking", "Share of voice", "Tone"],
    rows.slice(0, 15).map((r) => [`${r.depth ? "<span class=\"indent\"></span>" : ""}${esc(r.name)}`, esc(fmtCompact(r.mentions)), esc(fmtCompact(r.people)), esc(r.shareOfVoice === null ? "—" : `${Math.round(r.shareOfVoice)}%`), esc(tone(r.sentiment))]),
  );
  return section("tracker", `${bar}${t}`);
}

function mentionsSection(doc: ReportDocument): string {
  const m = doc.analytics.mentions;
  if (!m.total) return section("mentions", `<p class="muted">No mentions, replies or comments came in during this period.</p>`);
  const scored = m.positive + m.neutral + m.negative;
  const pct = (n: number) => (scored ? `${Math.round((n / scored) * 100)}%` : "—");
  const bar = scored
    ? `<div class="sent" role="img" aria-label="${esc(`Of ${scored} scored: ${pct(m.positive)} positive, ${pct(m.neutral)} neutral, ${pct(m.negative)} negative`)}"><span class="pos" style="flex-grow:${m.positive}"></span><span class="neu" style="flex-grow:${m.neutral}"></span><span class="neg" style="flex-grow:${m.negative}"></span></div><ul class="sov-legend"><li><span class="sw pos"></span>Positive <span class="muted">${pct(m.positive)}</span></li><li><span class="sw neu"></span>Neutral <span class="muted">${pct(m.neutral)}</span></li><li><span class="sw neg"></span>Negative <span class="muted">${pct(m.negative)}</span></li></ul>`
    : "";
  const change = doc.analytics.change.mentions;
  const lede = `${fmtInt(m.total)} mentions, replies and comments came in${change !== null ? ` (${fmtChange(change)} on the period before)` : ""}.${m.unscored ? ` ${fmtInt(m.unscored)} were not scored for tone.` : ""}`;
  const t = m.byNetwork.length ? table(["Network", "Mentions"], m.byNetwork.map((r) => [esc(networkName(r.network)), esc(fmtCompact(r.n))])) : "";
  return section("mentions", `<p class="lede">${esc(lede)}</p>${bar}${t}`);
}

function whatWorkedSection(doc: ReportDocument): string {
  const w = doc.analytics.whatWorked;
  const items = w.comparisons.map((c) => `<li class="ww ww-${c.verdict}"><b>${esc(c.verdict === "not_enough" ? "—" : fmtRatio(c.ratio))}</b> <span>${esc(c.sentence)}</span></li>`).join("");
  return section("what_worked", `<ul class="ww-list">${items}</ul><p class="muted small">Median engagements at 24 hours, posts from ${esc(dateIn(w.from, doc.timezone, { month: "short", day: "numeric" }))} to ${esc(dateIn(w.to, doc.timezone, { month: "short", day: "numeric" }))}. A difference is only claimed with at least ${w.minPerSide} posts on each side.</p>`);
}

function upcomingSection(doc: ReportDocument): string {
  const u = doc.upcoming ?? [];
  if (!u.length) return section("upcoming", `<p class="muted">Nothing is scheduled for the next two weeks.</p>`);
  const items = u.slice(0, 12).map((x) => `<li><span class="when">${esc(dateIn(x.at, doc.timezone, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</span><span class="what">${esc(excerpt(x.text, 140))}</span><span class="muted">${esc(x.networks.map(networkName).join(", "))}</span></li>`).join("");
  return section("upcoming", `<ul class="upcoming">${items}</ul>`);
}

const REPORT_CSS = `
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#f4f4f2;color:#1b1c1f;font:14px/1.5 -apple-system,"Segoe UI",Roboto,Inter,system-ui,sans-serif}
.page{max-width:760px;margin:0 auto;padding:32px 28px 48px;background:#fff}
header.top{display:flex;align-items:center;gap:16px;padding-bottom:18px;border-bottom:3px solid var(--accent)}
header.top img{max-height:48px;max-width:160px;object-fit:contain}
header.top h1{margin:0;font-size:24px;line-height:1.2}
header.top .sub{color:#5d6068;font-size:13px}
.intro{margin:18px 0 0;padding:12px 14px;background:#f6f6f4;border-left:3px solid var(--accent);white-space:pre-wrap}
.sec{margin-top:28px;break-inside:avoid-page;page-break-inside:avoid}
.sec h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#5d6068;margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid #e4e4e0}
.sec h3{font-size:13px;margin:16px 0 4px}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.kpis-3{grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:12px}
.kpi{border:1px solid #e4e4e0;border-radius:6px;padding:10px 12px}
.kpi-label{font-size:12px;color:#5d6068}
.kpi-value{font-size:22px;font-weight:600;line-height:1.3}
.kpi-change{font-size:12px}
.kpi-change.up{color:#1d8a4e}.kpi-change.down{color:#c7322b}.kpi-change.flat{color:#5d6068}
.muted{color:#5d6068}.small{font-size:12px}
.lede{font-size:15px;margin:0 0 10px}
.caption{font-size:12px;color:#5d6068;margin:4px 0 0}
.chart{display:block;margin:6px 0;overflow:visible}
.chart .grid{stroke:#e4e4e0;stroke-width:1}
.chart .tick{font-size:10px;fill:#5d6068}
.chart .line{stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.chart .line-prev{stroke:#b4b6bc;stroke-width:2;stroke-linejoin:round}
.chart .dot{fill:var(--accent);stroke:#fff;stroke-width:2}
.heat .cell-empty{fill:#f0f0ee}
.heat .thin-bg{fill:#f0f0ee}.heat .thin-line{stroke:#b4b6bc;stroke-width:2}
.legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;margin:6px 0}
.legend .sw{width:16px;height:12px;border-radius:3px;display:inline-block}
.legend .sw-thin{margin-left:12px;background:repeating-linear-gradient(45deg,#f0f0ee 0 3px,#b4b6bc 3px 5px)}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
th,td{padding:6px 8px;border-bottom:1px solid #e4e4e0;text-align:left;vertical-align:top}
thead th{font-size:12px;color:#5d6068;font-weight:600}
.num{text-align:right;font-variant-numeric:tabular-nums}
tbody th{font-weight:500}
.indent{display:inline-block;width:14px}
.posts{list-style:none;margin:0;padding:0}
.post{display:flex;gap:12px;padding:10px 0;border-bottom:1px solid #e4e4e0;break-inside:avoid}
.rank{flex:0 0 22px;height:22px;border-radius:50%;background:var(--accent);color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center}
.post p{margin:0}.post-text{margin-bottom:4px!important}.post-meta,.post-nums{font-size:12px;color:#5d6068}
.post-nums b{color:#1b1c1f}
a{color:var(--accent)}
.sov,.sent{display:flex;gap:2px;height:28px;margin:8px 0 6px}
.sov-seg{border-radius:4px;color:#fff;font-size:12px;font-weight:600;padding:5px 6px;white-space:nowrap}
.sov-legend{list-style:none;padding:0;margin:0 0 6px;display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px}
.sov-legend .sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px}
.c1{background:#3b6fd6}.c2{background:#d9480f}.c3{background:#1d8a4e}.c4{background:#8a5fcf}.c5{background:#a87a00}.c6{background:#0f8b8d}
.sent span{border-radius:4px}.pos{background:#1d8a4e}.neu{background:#b4b6bc}.neg{background:#c7322b}
.ww-list{list-style:none;padding:0;margin:0}
.ww{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #e4e4e0}
.ww b{flex:0 0 auto;min-width:56px;font-variant-numeric:tabular-nums}
.ww-not_enough b{color:#5d6068;font-weight:500;min-width:auto}
.upcoming{list-style:none;padding:0;margin:0}
.upcoming li{display:grid;grid-template-columns:150px 1fr auto;gap:10px;padding:7px 0;border-bottom:1px solid #e4e4e0;font-size:13px}
.when{color:#5d6068;font-variant-numeric:tabular-nums}
footer.foot{margin-top:36px;padding-top:12px;border-top:1px solid #e4e4e0;font-size:12px;color:#5d6068}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media (max-width:600px){.page{padding:20px 16px}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.upcoming li{grid-template-columns:1fr}}
@media print{body{background:#fff}.page{max-width:none;padding:0}@page{margin:16mm 14mm}.sec{break-inside:avoid-page}#top_posts,#best_times,#tracker{break-before:auto}a{text-decoration:none}}
`;

/** A self-contained, printable report: inline CSS and SVG, no scripts, nothing fetched except the logo. */
export function renderReportHtml(doc: ReportDocument): string {
  const accent = safeAccent(doc.accent);
  const logo = doc.logoUrl && (safeHttpUrl(doc.logoUrl) || /^data:image\/(png|jpeg|gif|webp|svg\+xml)(;charset=utf-8)?(;base64)?,[A-Za-z0-9+/=%._~!*'()-]+$/.test(doc.logoUrl)) ? `<img src="${esc(doc.logoUrl)}" alt="${esc(doc.clientName ?? doc.title)}">` : "";
  const sub = [doc.clientName, doc.periodLabel].filter(Boolean).join(" · ");
  const body = doc.sections
    .map((s) => {
      switch (s) {
        case "summary":
          return summarySection(doc);
        case "by_network":
          return byNetworkSection(doc);
        case "top_posts":
          return topPostsSection(doc);
        case "best_times":
          return bestTimesSection(doc, accent);
        case "links":
          return linksSection(doc);
        case "tracker":
          return trackerSection(doc);
        case "mentions":
          return mentionsSection(doc);
        case "what_worked":
          return whatWorkedSection(doc);
        case "upcoming":
          return upcomingSection(doc);
        default:
          return "";
      }
    })
    .join("");
  const generated = dateIn(doc.generatedAt, doc.timezone, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const view = safeHttpUrl(doc.viewUrl);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<title>${esc(doc.title)} · ${esc(doc.periodLabel)}</title>
<style>:root{--accent:${accent}}${REPORT_CSS}</style></head>
<body><div class="page">
${view ? `<p class="small muted">Read this report in your browser: <a href="${esc(view)}">${esc(view)}</a></p>` : ""}
<header class="top">${logo}<div><h1>${esc(doc.title)}</h1><div class="sub">${esc(sub)}</div></div></header>
${doc.intro ? `<p class="intro">${esc(doc.intro)}</p>` : ""}
${body}
<footer class="foot">Prepared for ${esc(doc.clientName ?? doc.workspaceName)} by ${esc(doc.workspaceName)} with Starsign · ${esc(generated)} (${esc(doc.timezone)}) · Numbers are each post's 24-hour or 72-hour snapshot, or its latest when none was taken.</footer>
</div></body></html>`;
}

// ---------------------------------------------------------------- schedules, in words

export type ReportScheduleSpec = { kind: "none" } | { kind: "weekly"; weekday: number; hour: number } | { kind: "monthly"; day: number; hour: number };

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

/** "Every Monday at 8:00 to 3 people", "Monthly on the 1st at 9:00 to 1 person", "Not scheduled". */
export function scheduleSummary(schedule: ReportScheduleSpec, recipients: number): string {
  if (schedule.kind === "none") return "Not scheduled";
  const at = `${String(schedule.hour).padStart(1, "0")}:00`;
  const who = recipients === 0 ? "with no recipients yet" : `to ${recipients} ${recipients === 1 ? "person" : "people"}`;
  if (schedule.kind === "weekly") return `Every ${WEEKDAYS[schedule.weekday] ?? "Monday"} at ${at} ${who}`;
  return `Monthly on the ${ordinal(schedule.day)} at ${at} ${who}`;
}
