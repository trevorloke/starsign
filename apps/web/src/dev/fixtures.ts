// Fixture data for developing and screenshotting the room without the API (VITE_USE_FIXTURES=1).
// Everything here is plausible, deterministic, and relative to the moment the page loads.

import type {
  AcceptInviteInput,
  Account,
  AccountMetrics,
  Activity,
  ActivityKind,
  AdaptInput,
  AdaptResult,
  AdaptedVariant,
  Alert,
  Approval,
  Brief,
  ConnectCredentialsInput,
  ConnectStartInput,
  Connector,
  Conversion,
  CreateLinkInput,
  AliasSuggestions,
  Entity,
  EntityInput,
  EntityMention,
  EntityPatch,
  EntityRelation,
  EntityReport,
  EntityReportRow,
  MentionHow,
  LinkList,
  LinkPlacement,
  LinkReport,
  LinkSettings,
  LinkSettingsPatch,
  LinkSettingsResponse,
  LinkStats,
  TrackedLink,
  InviteCreated,
  InviteInfo,
  LanguageSettings,
  LanguageSettingsPatch,
  LanguagesInfo,
  MediaAsset,
  Member,
  ModerateAction,
  NetworkCapabilities,
  ReplyInput,
  Role,
  Session,
  SessionWorkspace,
  SignupInput,
  CreatePostInput,
  DecideInput,
  Discovery,
  FeedQuery,
  Forecast,
  ForecastPoint,
  LedgerEvent,
  LiftByStage,
  Me,
  Network,
  OAuthStart,
  PendingInvite,
  Policy,
  PolicyCheckInput,
  PolicyDecision,
  PolicyVersion,
  Post,
  PostStatus,
  PostDetail,
  PostFull,
  PostSummary,
  RadarEntry,
  SeriesPoint,
  Stream,
  Summary,
  TopicDetail,
  TopicSeries,
  TrendSource,
  TrendStage,
  Variant,
  Violation,
  Workspace,
} from "../types";
import type { StreamHandlers } from "../api";
import { ApiError } from "../lib/errors";
import { NETWORK_THREADS, networkLabel, truncate } from "../lib/format";
import { LANG_CODE_RE, primaryLanguage } from "../lib/lang";
import { dayKey, weekStartMs } from "../lib/tz";

const NOW = Date.now();
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (hours: number) => iso(NOW - hours * HOUR);
const ahead = (hours: number) => iso(NOW + hours * HOUR);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const delay = <T,>(v: T, ms = 140) => new Promise<T>((resolve) => setTimeout(() => resolve(clone(v)), ms));

// --- Workspace, accounts, streams, policy -------------------------------

const workspace: Workspace = {
  id: "ws_northwind",
  slug: "northwind",
  name: "Northwind Coffee",
  profile: {
    description: "Specialty roaster in Portland with four cafés and a wholesale program.",
    audience: "People who care where their coffee comes from and don't want to be sold to.",
    topics: ["cold brew", "seasonal menu", "sourcing", "home brewing"],
    voice: { do: ["plain words", "specific numbers", "dry humor"], dont: ["hype", "exclamation marks", "trend-chasing"], examples: [] },
    competitors: ["Blue Bottle", "Stumptown", "Starbucks"],
  },
  settings: {},
  createdAt: ago(24 * 90),
};

const me: Me = { workspace, actor: { type: "human", id: "dev" }, role: "owner" };

const acct = (id: string, network: Network, handle: string, displayName: string, connector: string, status: Account["status"], ingestedHoursAgo: number | null, externalId = id): Account => ({
  id,
  network,
  externalId,
  handle,
  displayName,
  connector,
  status,
  hasCredentials: status !== "disabled",
  lastIngestAt: ingestedHoursAgo === null ? null : ago(ingestedHoursAgo),
  config: {},
});

// Northwind's accounts. The feed, posts and calendar below reference these ids.
const accounts: Account[] = [
  acct("acc_x", "x", "northwindcoffee", "Northwind Coffee", "x", "active", 0.1, "1842"),
  acct("acc_bsky", "bluesky", "northwind.coffee", "Northwind Coffee", "bluesky", "active", 0.2, "did:plc:nw"),
  acct("acc_ig", "instagram", "northwindcoffee", "Northwind Coffee", "meta", "reauth_required", 9, "17841"),
  acct("acc_fb", "facebook", "northwindcoffeepdx", "Northwind Coffee", "meta", "active", 0.4),
  acct("acc_yt", "youtube", "northwindroasters", "Northwind Roasters", "youtube", "active", 1.5),
  acct("acc_tt", "tiktok", "northwind.coffee", "Northwind Coffee", "tiktok", "active", 0.8),
  acct("acc_masto", "mastodon", "northwind@mastodon.social", "Northwind Coffee", "mastodon", "active", 0.6),
  acct("acc_li", "linkedin", "northwind-coffee-roasters", "Northwind Coffee Roasters", "linkedin", "disabled", null),
  // Chat apps: the LINE official account for the Tokyo cafés, the WhatsApp business number, the WeChat Official
  // Account, and a bot in the community Discord server.
  acct("acc_line", "line", "@northwindjp", "Northwind Coffee Japan", "line", "active", 0.05, "U4af4980629f1b2c3d4e5f60718293a4b"),
  acct("acc_wa", "whatsapp", "+1 503 555 0142", "Northwind Coffee", "whatsapp", "active", 0.05, "106540352242922"),
  acct("acc_wechat", "wechat", "gh_6a1f2c3d4e5f", "Northwind Coffee", "wechat", "active", 0.1),
  acct("acc_dbot", "discord", "Northwind Community", "Northwind Community", "discord_bot", "active", 0.1, "934215867301928960"),
];

const streams: Stream[] = [
  {
    id: "st_brand",
    name: "Brand mentions",
    query: { keywords: ["northwind", "northwind coffee"], authors: [], networks: [], kinds: [], languages: [], translations: { ja: ["ノースウィンド", "ノースウィンドコーヒー"] } },
    createdAt: ago(24 * 60),
  },
  {
    id: "st_jp",
    name: "Tokyo community",
    query: {
      keywords: ["cold brew", "yuzu blend", "shibuya"],
      authors: [],
      networks: ["line", "x"],
      kinds: [],
      languages: ["ja"],
      translations: { ja: ["コールドブリュー", "水出しコーヒー", "ゆずブレンド", "渋谷"] },
    },
    createdAt: ago(24 * 14),
  },
  { id: "st_comp", name: "Competitor watch", query: { keywords: ["blue bottle", "stumptown", "starbucks"], authors: [], networks: [], kinds: [] }, createdAt: ago(24 * 40) },
  { id: "st_psl", name: "Pumpkin spice", query: { keywords: ["pumpkin spice", "psl"], authors: [], networks: [], kinds: [] }, createdAt: ago(24 * 3) },
];

const policy: Policy = {
  version: 3,
  autonomy: { new_post: "schedule_with_approval", reply: "draft", dm: "suggest", repost: "draft", campaign: "suggest" },
  requireApprovalForEditors: true,
  redLines: [
    { id: "rl_comp", kind: "no_competitor_mention", description: "Never name a competitor in our own posts or replies", severity: "require_approval", competitors: ["Blue Bottle", "Stumptown", "Starbucks"] },
    { id: "rl_health", kind: "forbidden_claim", description: "No health, energy or weight-loss claims about coffee", severity: "block", patterns: ["(cures?|heals?|burns? fat|weight loss|detox)"] },
    { id: "rl_guarantee", kind: "forbidden_phrase", description: "Never promise guaranteed results", severity: "block", phrases: ["guaranteed", "guarantee"] },
    { id: "rl_quiet", kind: "quiet_hours", description: "Nothing goes out between 10pm and 7am Pacific", severity: "require_approval", timezone: "America/Los_Angeles", startHour: 22, endHour: 7, days: [] },
    { id: "rl_disclose", kind: "required_disclosure", description: "AI-assisted posts carry #AIassisted", severity: "warn", requiredText: "#AIassisted", when: "ai_assisted" },
  ],
  competitors: ["Blue Bottle", "Stumptown", "Starbucks"],
  timezone: "America/Los_Angeles",
  spendCaps: { xReadsUsdMonthly: 50, modelUsdMonthly: 100 },
  disclosure: { recordAlways: true, signMedia: true, visibleTextForAi: "" },
};

// --- Curves ------------------------------------------------------------
// tau is a position on one timeline: 0 = 48h ago, 1 = now, 1.5 = 24h ahead. Shapes return a 0..1 level.

type Shape = (tau: number) => number;
const bump =
  (peak: number, sigma: number, base: number, amp: number): Shape =>
  (tau) =>
    base + amp * Math.exp(-((tau - peak) ** 2) / (2 * sigma * sigma));

const SHAPES: Record<TrendStage, Shape> = {
  rising: bump(1.25, 0.2, 0.08, 0.82),
  peaking: bump(1.03, 0.28, 0.1, 0.78),
  plateau: (tau) => 0.55 + 0.03 * Math.sin(tau * 14),
  fading: bump(0.55, 0.26, 0.08, 0.7),
  dormant: (tau) => 0.07 + 0.015 * Math.sin(tau * 9),
};

const noise = (tau: number, seed: number) => 0.025 * Math.sin(tau * 31 + seed) + 0.015 * Math.sin(tau * 73 + seed * 2);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function forecastCurve(stage: TrendStage, confidence: number, seed: number): ForecastPoint[] {
  const shape = SHAPES[stage];
  const points: ForecastPoint[] = [];
  for (let i = 0; i <= 12; i++) {
    const hours = i * 2;
    const tau = 1 + hours / 48;
    const value = 100 * clamp01(shape(tau) + noise(tau, seed));
    const width = 100 * (0.05 + (1 - confidence) * 0.3) * (0.35 + (0.65 * i) / 12);
    points.push({
      at: ahead(hours),
      value: round1(value),
      lo: round1(Math.max(0, value - width * 0.9)),
      hi: round1(value + width * 1.1),
    });
  }
  return points;
}

function historySeries(stage: TrendStage, sources: { source: string; scale: number }[], seed: number): TopicSeries[] {
  const shape = SHAPES[stage];
  return sources.map(({ source, scale }, idx) => {
    const points: SeriesPoint[] = [];
    for (let i = 0; i < 48; i++) {
      const tau = i / 47;
      const lagged = tau - 0.02 * idx;
      const level = clamp01(shape(lagged) + noise(tau, seed + idx * 7) * (1 + idx * 0.5));
      points.push({ t: ago(47 - i), v: round1(level * scale) });
    }
    return { source, points };
  });
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

// --- Topics --------------------------------------------------------------

interface TopicSpec {
  id: string;
  name: string;
  keywords: string[];
  relevance: number;
  stage: TrendStage;
  confidence: number;
  velocity: number;
  hoursToPeak: number | null;
  sources: { source: string; scale: number }[];
  agreement: number | null;
  actedOn: number;
  score: number;
  window: string | null;
  seed: number;
}

const TOPICS: TopicSpec[] = [
  {
    id: "tp_psl",
    name: "Pumpkin spice backlash",
    keywords: ["pumpkin spice", "psl", "too early"],
    relevance: 0.86,
    stage: "rising",
    confidence: 0.78,
    velocity: 0.14,
    hoursToPeak: 6,
    sources: [
      { source: "google_trends", scale: 100 },
      { source: "bluesky_firehose", scale: 420 },
      { source: "own_feed", scale: 40 },
    ],
    agreement: 0.81,
    actedOn: 1,
    score: 0.91,
    window: "act within 6h",
    seed: 1,
  },
  {
    id: "tp_coldbrew",
    name: "Cold brew at home",
    keywords: ["cold brew", "cold brew ratio", "home cold brew"],
    relevance: 0.79,
    stage: "peaking",
    confidence: 0.66,
    velocity: 0.03,
    hoursToPeak: 1.4,
    sources: [
      { source: "google_trends", scale: 100 },
      { source: "youtube_trending", scale: 60 },
      { source: "reddit", scale: 180 },
    ],
    agreement: 0.7,
    actedOn: 2,
    score: 0.74,
    window: "act within 2h",
    seed: 2,
  },
  {
    id: "tp_oatmilk",
    name: "Oat milk shortage",
    keywords: ["oat milk", "oatly shortage"],
    relevance: 0.58,
    stage: "plateau",
    confidence: 0.52,
    velocity: 0,
    hoursToPeak: null,
    sources: [
      { source: "news", scale: 30 },
      { source: "x", scale: 250 },
    ],
    agreement: 0.55,
    actedOn: 0,
    score: 0.48,
    window: null,
    seed: 3,
  },
  {
    id: "tp_dirtychai",
    name: "Dirty chai",
    keywords: ["dirty chai", "chai latte espresso"],
    relevance: 0.64,
    stage: "fading",
    confidence: 0.61,
    velocity: -0.09,
    hoursToPeak: null,
    sources: [
      { source: "tiktok_creative_center", scale: 100 },
      { source: "bluesky_firehose", scale: 300 },
    ],
    agreement: 0.64,
    actedOn: 3,
    score: 0.33,
    window: "window closing",
    seed: 4,
  },
  {
    id: "tp_coffeeday",
    name: "World Coffee Day",
    keywords: ["world coffee day", "international coffee day"],
    relevance: 0.4,
    stage: "dormant",
    confidence: 0.28,
    velocity: 0,
    hoursToPeak: null,
    sources: [{ source: "wikipedia_pageviews", scale: 900 }],
    agreement: null,
    actedOn: 0,
    score: 0.09,
    window: null,
    seed: 5,
  },  // Trend topics the tracker made for the names it follows (see "The tracker" below).
  {
    id: "tp_ent_northwind",
    name: "Northwind Coffee",
    keywords: ["Northwind Coffee", "Northwind", "ノースウィンド", "北风咖啡"],
    relevance: 1,
    stage: "rising",
    confidence: 0.62,
    velocity: 0.08,
    hoursToPeak: 20,
    sources: [
      { source: "news", scale: 40 },
      { source: "own_feed", scale: 60 },
      { source: "bluesky_search", scale: 120 },
    ],
    agreement: 0.68,
    actedOn: 0,
    score: 0.41,
    window: null,
    seed: 6,
  },
  {
    id: "tp_ent_bluebottle",
    name: "Blue Bottle",
    keywords: ["Blue Bottle", "Blue Bottle Coffee", "ブルーボトル", "wiki:Blue_Bottle_Coffee"],
    relevance: 1,
    stage: "plateau",
    confidence: 0.57,
    velocity: 0.01,
    hoursToPeak: null,
    sources: [
      { source: "news", scale: 30 },
      { source: "wikipedia_pageviews", scale: 2400 },
    ],
    agreement: 0.6,
    actedOn: 0,
    score: 0.22,
    window: null,
    seed: 7,
  },
  {
    id: "tp_ent_stumptown",
    name: "Stumptown",
    keywords: ["Stumptown", "Stumptown Coffee", "wiki:Stumptown_Coffee_Roasters"],
    relevance: 1,
    stage: "fading",
    confidence: 0.44,
    velocity: -0.04,
    hoursToPeak: null,
    sources: [{ source: "wikipedia_pageviews", scale: 800 }],
    agreement: null,
    actedOn: 0,
    score: 0.12,
    window: null,
    seed: 8,
  },
];

function forecastOf(t: TopicSpec): Forecast {
  return {
    id: `fc_${t.id}`,
    stage: t.stage,
    confidence: t.confidence,
    velocity: t.velocity,
    hoursToPeak: t.hoursToPeak,
    computedAt: ago(0.25),
    sources: t.sources.map((s) => s.source),
    sourceAgreement: t.agreement,
    curve: forecastCurve(t.stage, t.confidence, t.seed),
  };
}

const radar: RadarEntry[] = TOPICS.map((t) => ({
  topic: { id: t.id, workspaceId: workspace.id, name: t.name, keywords: t.keywords, relevance: t.relevance, createdAt: ago(24 * 20) },
  forecast: forecastOf(t),
  actedOn: t.actedOn,
  score: t.score,
  window: t.window,
}));

// --- Posts ---------------------------------------------------------------

function variant(
  id: string,
  postId: string,
  accountId: string,
  network: Network,
  text: string,
  extra: Partial<Variant> = {},
): Variant {
  return {
    id,
    postId,
    socialAccountId: accountId,
    network,
    text,
    media: [],
    thread: [],
    status: "pending",
    externalId: null,
    externalUrl: null,
    publishedAt: null,
    error: null,
    attemptCount: 0,
    ...extra,
  };
}

const basePost: Pick<Post, "workspaceId" | "media" | "publishedAt" | "experimentId" | "experimentArm" | "trendForecastId"> = {
  workspaceId: workspace.id,
  media: [],
  publishedAt: null,
  experimentId: null,
  experimentArm: null,
  trendForecastId: null,
};

const queueSeed: PostSummary[] = [
  {
    post: {
      ...basePost,
      id: "p_psl",
      status: "pending_approval",
      title: "Pumpkin spice, but honest",
      body: "We don't do pumpkin spice. We do a maple-cardamom cortado for exactly six weeks, and then it's gone. Fall doesn't need a syrup.",
      scheduledAt: ahead(3),
      actionClass: "new_post",
      createdBy: { type: "operator", id: "watch" },
      trendTopicId: "tp_psl",
      trendStageAtCreation: "rising",
      trendForecastId: "fc_tp_psl",
      disclosure: { aiAssisted: true, aiContributions: ["text_drafted"], humanReviewed: false, model: "claude-opus-5-5", promptVersion: "watch/3" },
      evidence: [
        { kind: "forecast", ref: "Pumpkin spice backlash · rising", note: "78% confidence, peak in ~6h, 3 sources agree" },
        { kind: "mentions", ref: "https://bsky.app/search?q=pumpkin+spice+too+early", note: "41 mentions in the last 3h; 68% are 'too early' complaints" },
        { kind: "past_post", ref: "https://x.com/northwindcoffee/status/1710000000000000001", note: "Last year's 'no PSL' post did 2.4x our baseline" },
      ],
      policyDecision: { verdict: "require_approval", violations: [], autonomy: "schedule_with_approval", policyVersion: 3 },
      createdAt: ago(1.5),
      updatedAt: ago(1.5),
    },
    variants: [
      variant("v_psl_x", "p_psl", "acc_x", "x", "We don't do pumpkin spice. We do a maple-cardamom cortado for exactly six weeks, then it's gone. Fall doesn't need a syrup. #AIassisted"),
      variant("v_psl_bsky", "p_psl", "acc_bsky", "bluesky", "Not doing pumpkin spice this year either. Maple-cardamom cortado, six weeks, then gone. Fall doesn't need a syrup. #AIassisted"),
    ],
  },
  {
    post: {
      ...basePost,
      id: "p_reply_mara",
      status: "pending_approval",
      title: null,
      body: "Reply to @mara.k about which beans to use for cold brew.",
      scheduledAt: null,
      actionClass: "reply",
      createdBy: { type: "mcp", id: "claude-desktop" },
      trendTopicId: "tp_coldbrew",
      trendStageAtCreation: "peaking",
      trendForecastId: "fc_tp_coldbrew",
      disclosure: { aiAssisted: true, aiContributions: ["text_drafted"], humanReviewed: false, model: "claude-opus-5-5" },
      evidence: [
        { kind: "activity", ref: "https://bsky.app/profile/mara.k/post/3l5k2", note: "@mara.k asked which beans we'd recommend for cold brew" },
        { kind: "forecast", ref: "Cold brew at home · peaking", note: "66% confidence, peak in ~1h" },
      ],
      policyDecision: {
        verdict: "require_approval",
        violations: [{ redLineId: "rl_comp", kind: "no_competitor_mention", severity: "require_approval", message: "Names a competitor: Blue Bottle", matches: ["Blue Bottle"] }],
        autonomy: "draft",
        policyVersion: 3,
      },
      createdAt: ago(0.3),
      updatedAt: ago(0.3),
    },
    variants: [
      variant("v_mara_bsky", "p_reply_mara", "acc_bsky", "bluesky", "@mara.k the Ethiopian (Guji) is the one — 1:8 ratio, 16h in the fridge. If you want something closer to Blue Bottle's, our Brazil blend is the nearest thing."),
      variant("v_mara_x", "p_reply_mara", "acc_x", "x", "The Ethiopian Guji, 1:8, 16 hours in the fridge. Closer to Blue Bottle's style? Try the Brazil blend."),
    ],
  },
  {
    post: {
      ...basePost,
      id: "p_menu",
      status: "pending_approval",
      title: "Fall menu goes live Thursday",
      body: "Thursday: the fall menu. Maple-cardamom cortado, brown butter oat latte, and the Guji is back on espresso.",
      scheduledAt: ahead(30),
      actionClass: "new_post",
      createdBy: { type: "human", id: "marta" },
      trendTopicId: null,
      trendStageAtCreation: null,
      disclosure: { aiAssisted: false, aiContributions: [], humanReviewed: true, reviewedBy: "marta" },
      evidence: [{ kind: "calendar", ref: "Fall menu launch · Thursday 7am", note: "Menu goes live at all four cafés" }],
      policyDecision: { verdict: "require_approval", violations: [], policyVersion: 3 },
      createdAt: ago(5),
      updatedAt: ago(5),
    },
    variants: [
      variant("v_menu_x", "p_menu", "acc_x", "x", "Thursday: the fall menu. Maple-cardamom cortado, brown butter oat latte, and the Guji is back on espresso."),
      variant("v_menu_bsky", "p_menu", "acc_bsky", "bluesky", "Thursday: the fall menu. Maple-cardamom cortado, brown butter oat latte, and the Guji is back on espresso. Come early; the cortado runs out by 10."),
      variant("v_menu_ig", "p_menu", "acc_ig", "instagram", "Fall menu, Thursday. Maple-cardamom cortado. Brown butter oat latte. Guji back on espresso. All four cafés, 7am.", {
        media: [{ kind: "image", url: "https://images.northwind.coffee/fall-menu.jpg", alt: "Three drinks on a walnut counter" }],
      }),
    ],
  },
];

const IG_ERROR = "Instagram via Zernio: the account's token expired and the post was refused (401 unauthorized). Reconnect the account and retry.";

const published: PostSummary[] = [
  {
    post: {
      ...basePost,
      id: "p_ratio",
      status: "partially_published",
      title: "Cold brew ratio card",
      body: "1:8 coffee to water, coarse grind, 16 hours in the fridge. Dilute to taste. That's the whole recipe.",
      scheduledAt: ago(28),
      publishedAt: ago(28),
      actionClass: "new_post",
      createdBy: { type: "operator", id: "watch" },
      trendTopicId: "tp_coldbrew",
      trendStageAtCreation: "rising",
      trendForecastId: "fc_tp_coldbrew_prev",
      disclosure: { aiAssisted: true, aiContributions: ["text_drafted", "text_edited"], humanReviewed: true, reviewedBy: "marta", model: "claude-opus-5-5" },
      evidence: [{ kind: "forecast", ref: "Cold brew at home · rising", note: "71% confidence at the time, peak in ~30h" }],
      policyDecision: { verdict: "require_approval", violations: [], autonomy: "schedule_with_approval", policyVersion: 3 },
      createdAt: ago(30.5),
      updatedAt: ago(28),
    },
    variants: [
      variant("v_ratio_x", "p_ratio", "acc_x", "x", "Cold brew, the whole recipe: 1:8 coffee to water, coarse grind, 16 hours in the fridge. Dilute to taste. #AIassisted", {
        status: "published",
        externalId: "1842000000000000002",
        externalUrl: "https://x.com/northwindcoffee/status/1842000000000000002",
        publishedAt: ago(28),
        attemptCount: 1,
      }),
      variant("v_ratio_bsky", "p_ratio", "acc_bsky", "bluesky", "Cold brew, the whole recipe: 1:8, coarse grind, 16 hours in the fridge. Dilute to taste. #AIassisted", {
        status: "published",
        externalId: "3l7m",
        externalUrl: "https://bsky.app/profile/northwind.coffee/post/3l7m",
        publishedAt: ago(28),
        attemptCount: 1,
      }),
      variant("v_ratio_ig", "p_ratio", "acc_ig", "instagram", "1:8. Coarse. 16 hours in the fridge. Dilute to taste. #AIassisted", {
        status: "failed",
        error: IG_ERROR,
        attemptCount: 3,
        media: [{ kind: "image", url: "https://images.northwind.coffee/ratio-card.jpg", alt: "Ratio card" }],
      }),
    ],
  },
  publishedSimple("p_chai_iced", "Dirty chai, iced", "Dirty chai, iced: double shot over masala chai concentrate, oat milk, lots of ice.", "tp_dirtychai", "rising", 70),
  publishedSimple("p_chai_explained", "Dirty chai, explained", "A dirty chai is a chai latte with a shot of espresso in it. Ours uses our own masala concentrate.", "tp_dirtychai", "peaking", 40),
  publishedSimple("p_chai_ratio", "Dirty chai: the ratio", "Dirty chai at home: 1 shot, 120ml chai concentrate, 120ml milk. Don't overthink it.", "tp_dirtychai", "fading", 20),
];

function publishedSimple(id: string, title: string, body: string, topicId: string, stage: TrendStage, hoursAgo: number): PostSummary {
  return {
    post: {
      ...basePost,
      id,
      status: "published",
      title,
      body,
      scheduledAt: ago(hoursAgo),
      publishedAt: ago(hoursAgo),
      actionClass: "new_post",
      createdBy: { type: "operator", id: "watch" },
      trendTopicId: topicId,
      trendStageAtCreation: stage,
      trendForecastId: `fc_${topicId}_${hoursAgo}`,
      disclosure: { aiAssisted: true, aiContributions: ["text_drafted"], humanReviewed: true, reviewedBy: "dev", model: "claude-opus-5-5" },
      evidence: [{ kind: "forecast", ref: `Dirty chai · ${stage}`, note: "Operator proposal" }],
      policyDecision: { verdict: "require_approval", violations: [], autonomy: "schedule_with_approval", policyVersion: 3 },
      createdAt: ago(hoursAgo + 2),
      updatedAt: ago(hoursAgo),
    },
    variants: [
      variant(`${id}_x`, id, "acc_x", "x", `${body} #AIassisted`, { status: "published", externalId: `${hoursAgo}001`, externalUrl: `https://x.com/northwindcoffee/status/18420000000000${hoursAgo}1`, publishedAt: ago(hoursAgo), attemptCount: 1 }),
      variant(`${id}_bsky`, id, "acc_bsky", "bluesky", `${body} #AIassisted`, { status: "published", externalId: `3l${hoursAgo}`, externalUrl: `https://bsky.app/profile/northwind.coffee/post/3l${hoursAgo}`, publishedAt: ago(hoursAgo), attemptCount: 1 }),
    ],
  };
}

const OUTCOMES: Record<string, Record<string, unknown> | null> = {
  p_ratio: { impressions: 18400, engagements: 612, lift: 2.3 },
  p_chai_iced: { impressions: 14200, engagements: 540, lift: 2.0 },
  p_chai_explained: { impressions: 9100, engagements: 203, lift: 0.8 },
  p_chai_ratio: null,
  p_psl: null,
  p_reply_mara: null,
};

// --- Ledger history ------------------------------------------------------

let seq = 1000;
function ev(type: string, subjectId: string, actor: LedgerEvent["actor"], occurredAt: string, data: Record<string, unknown> = {}): LedgerEvent {
  seq += 1;
  return { id: `le_${seq}`, seq, workspaceId: workspace.id, type, subjectType: "post", subjectId, actor, data, occurredAt };
}

function historyFor(item: PostSummary): LedgerEvent[] {
  const { post, variants } = item;
  const sys = { type: "system" as const, id: "system" };
  const out: LedgerEvent[] = [
    ev("post.created", post.id, post.createdBy, post.createdAt, { actionClass: post.actionClass }),
    ev("policy.evaluated", post.id, sys, post.createdAt, { verdict: post.policyDecision?.verdict ?? "allow", violations: post.policyDecision?.violations.length ?? 0 }),
  ];
  if (post.status === "pending_approval") {
    out.push(ev("post.approval_requested", post.id, post.createdBy, post.createdAt));
    return out;
  }
  const approvedAt = iso(Date.parse(post.createdAt) + 1.5 * HOUR);
  out.push(ev("post.approval_requested", post.id, post.createdBy, post.createdAt));
  out.push(ev("post.approval_decided", post.id, { type: "human", id: post.disclosure?.reviewedBy ?? "dev" }, approvedAt, { decision: "approve", edits: post.id === "p_ratio" ? 1 : 0 }));
  if (post.scheduledAt) out.push(ev("post.scheduled", post.id, sys, approvedAt, { at: post.scheduledAt }));
  if (post.status === "failed" && post.scheduledAt) {
    out.push(ev("post.publish_started", post.id, sys, post.scheduledAt));
    for (const v of variants) out.push(ev("variant.failed", post.id, sys, post.scheduledAt, { network: v.network, error: v.error, attempt: v.attemptCount }));
    out.push(ev("post.failed", post.id, sys, post.scheduledAt, { status: post.status }));
  }
  if (post.publishedAt) {
    out.push(ev("post.publish_started", post.id, sys, post.publishedAt));
    for (const v of variants) {
      if (v.status === "published") out.push(ev("variant.published", post.id, sys, v.publishedAt ?? post.publishedAt, { network: v.network, externalUrl: v.externalUrl }));
      if (v.status === "failed") out.push(ev("variant.failed", post.id, sys, post.publishedAt, { network: v.network, error: v.error, attempt: v.attemptCount }));
    }
    out.push(ev(post.status === "partially_published" ? "post.failed" : "post.published", post.id, sys, post.publishedAt, { status: post.status }));
    const outcome = OUTCOMES[post.id];
    if (outcome) out.push(ev("outcome.captured", post.id, sys, iso(Date.parse(post.publishedAt) + 24 * HOUR), { offset: "24h", ...outcome }));
  }
  return out;
}

function approvalsFor(item: PostSummary): Approval[] {
  const { post } = item;
  const requested: Approval = {
    id: `ap_${post.id}`,
    postId: post.id,
    state: "requested",
    requestedBy: post.createdBy,
    decidedBy: null,
    decidedAt: null,
    note: null,
    createdAt: post.createdAt,
  };
  if (post.status === "pending_approval") return [requested];
  return [{ ...requested, state: "approved", decidedBy: { type: "human", id: post.disclosure?.reviewedBy ?? "dev" }, decidedAt: iso(Date.parse(post.createdAt) + 1.5 * HOUR) }];
}

// --- Feed ----------------------------------------------------------------

function act(
  id: string,
  network: Network,
  kind: ActivityKind,
  handle: string,
  name: string,
  text: string,
  hoursAgo: number,
  matched: string[],
  sentiment: number | null = null,
  chat: Partial<Pick<Activity, "lang" | "conversationId" | "conversationName" | "conversationType" | "translation" | "translationLang" | "translatedAt">> = {},
): Activity {
  const accountId = accounts.find((a) => a.network === network)?.id ?? null;
  const url =
    network === "x"
      ? `https://x.com/${handle}/status/${id}`
      : network === "bluesky"
        ? `https://bsky.app/profile/${handle}/post/${id}`
        : network === "instagram"
          ? `https://www.instagram.com/p/${id}/`
          : network === "youtube"
            ? `https://www.youtube.com/watch?v=${id}`
            : network === "facebook"
              ? `https://www.facebook.com/${id}`
              : network === "tiktok"
                ? `https://www.tiktok.com/@${handle}/video/${id}`
                : network === "discord" && chat.conversationId
                  ? `https://discord.com/channels/934215867301928960/${chat.conversationId}/${id}`
                  : null;
  return {
    id,
    workspaceId: workspace.id,
    socialAccountId: accountId,
    network,
    kind,
    externalId: id,
    authorHandle: handle,
    authorName: name,
    text,
    url,
    parentExternalId: null,
    occurredAt: ago(hoursAgo),
    ingestedAt: ago(Math.max(0, hoursAgo - 0.02)),
    sentiment,
    matchedStreams: matched,
    rawEventId: null,
    lang: "en",
    conversationId: null,
    conversationName: null,
    conversationType: null,
    translation: null,
    translationLang: null,
    translatedAt: null,
    ...chat,
  };
}

const TOKYO = { conversationId: "C8f3a1b2c4d5e6f708192a3b4c5d6e7f8", conversationName: "Acme Fans Tokyo", conversationType: "group" as const };
const translated = (text: string, hoursAgo: number) => ({ translation: text, translationLang: "en", translatedAt: ago(Math.max(0, hoursAgo - 0.01)) });

const feedSeed: Activity[] = [
  act("a01", "x", "mention", "latte_lauren", "Lauren", "is it just me or is @northwindcoffee the only one not doing pumpkin spice yet?? respect", 0.07, ["st_brand", "st_psl"], 0.6),
  act("a02", "bluesky", "reply", "mara.k", "Mara K.", "which beans do you recommend for cold brew? the ethiopian?", 0.18, ["st_brand"], 0.3),
  act("a03", "instagram", "comment", "dan.espresso", "Dan", "that pour. no notes.", 0.3, ["st_brand"], 0.8),
  act("a04", "x", "quote", "coffeewire", "Coffee Wire", "Northwind says the quiet part out loud about PSL season", 0.43, ["st_brand", "st_psl"], 0.4),
  act("a05", "x", "dm", "wholesale_jo", "Jo Ramirez", "Hi — interested in wholesale pricing for 3 cafés in Portland. Who should I talk to?", 0.68, [], 0.2),
  act("a06", "bluesky", "mention", "oat.enjoyer", "oat enjoyer", "oat milk shortage is hitting @northwind.coffee too, they're out at the Pearl location", 1.0, ["st_brand"], -0.3),
  act("a07", "x", "mention", "stumptown_fan", "pdx coffee guy", "stumptown vs northwind cold brew — fight", 1.3, ["st_comp", "st_brand"], 0.1),
  act("a08", "instagram", "comment", "kate.reads", "Kate", "do you ship beans to Canada?", 2.0, ["st_brand"], 0.2),
  act("a09", "bluesky", "reply", "pdx.morning", "PDX Morning", "the dirty chai is so good, bring it back for winter", 2.5, ["st_brand"], 0.7),
  act("a10", "x", "reply", "m_torres", "M. Torres", "@northwindcoffee your app logged me out again. third time this week.", 3.0, ["st_brand"], -0.6),
  act("a11", "instagram", "mention", "pdxfoodie", "PDX Foodie", "best cold brew in town is northwindcoffee, no notes", 4.0, ["st_brand"], 0.9),
  act("a12", "x", "mention", "beanwatch", "Bean Watch", "Blue Bottle just dropped a pumpkin cold foam. @northwindcoffee your move", 5.0, ["st_comp", "st_psl"], 0.0),
  act("a13", "facebook", "comment", "linda.park", "Linda Park", "Are you open on Thanksgiving morning? Want to grab beans for the family.", 0.55, ["st_brand"], 0.3),
  act("a14", "youtube", "comment", "brewnerd42", "brewnerd42", "What grind setting on a Baratza for the 1:8 cold brew in this video?", 1.6, ["st_brand"], 0.4),
  act("a15", "tiktok", "comment", "jules.sips", "jules", "the latte art at 0:12 😮", 2.2, ["st_brand"], 0.8),
  act("a16", "mastodon", "mention", "kav@hachyderm.io", "Kavya", "@northwind@mastodon.social do you publish your green coffee prices? would love to see more roasters do that", 3.4, ["st_brand"], 0.5),

  // Chat apps, in several languages.
  act("c01", "line", "message", "Ua1b2c3d4e5f60718293a4b5c6d7e8f90", "さくら", "渋谷の新しいお店、コールドブリューが本当においしかった。週末は混んでるので朝早めがおすすめです。", 0.12, ["st_jp"], 0.8, {
    lang: "ja",
    ...TOKYO,
    ...translated("The cold brew at the new Shibuya shop was really good. It gets busy on weekends, so I'd go early in the morning.", 0.12),
  }),
  act("c02", "line", "message", "Ub2c3d4e5f60718293a4b5c6d7e8f9a01", "けんた", "限定のゆずブレンドっていつまで買えますか？オンラインでも売ってほしいです。", 0.25, ["st_jp"], 0.3, { lang: "ja", ...TOKYO }),
  act("c03", "whatsapp", "dm", "5215512345678", "Lucía Fernández", "Hola, ¿hacen envíos a Ciudad de México? Quiero pedir 3 bolsas del tueste etíope para la oficina.", 0.38, [], 0.4, {
    lang: "es",
    conversationId: "5215512345678",
    conversationName: "Lucía Fernández",
    conversationType: "direct",
    ...translated("Hi, do you ship to Mexico City? I'd like to order 3 bags of the Ethiopian roast for the office.", 0.38),
  }),
  act("c04", "wechat", "dm", "oX7a2Fq9kLm3nP0rS5tU8vW1yZ4b", "王伟", "你好，请问你们的咖啡豆可以寄到上海吗？运费大概多少？", 0.5, [], 0.2, {
    lang: "zh",
    conversationId: "oX7a2Fq9kLm3nP0rS5tU8vW1yZ4b",
    conversationType: "direct",
  }),
  act("c05", "discord", "message", "brewbuddy", "Brew Buddy", "anyone tried the new decaf yet? curious if it holds up as espresso", 0.62, ["st_brand"], 0.3, {
    conversationId: "1029384756102938475",
    conversationName: "#general",
    conversationType: "channel",
  }),
  act("c06", "whatsapp", "message", "15035550199", "Tomás (Alberta café)", "Pedido #4471 ok 👍", 0.8, [], 0.5, {
    lang: null,
    conversationId: "120363041122334455",
    conversationName: "Northwind wholesale partners",
    conversationType: "group",
  }),
];

/** A news article the tracker's public search found: the site is the author, the headline is the text. */
function newsItem(id: string, domain: string, path: string, title: string, hoursAgo: number, sentiment: number | null, extra: Parameters<typeof act>[9] = {}): Activity {
  return { ...act(id, "news", "mention", domain, domain, title, hoursAgo, [], sentiment, extra), url: `https://${domain}/${path}` };
}

/**
 * Messages by and about the names the tracker follows, from public search (news, Bluesky, Reddit…) and the inboxes.
 * Which entity each belongs to is worked out by matching, like the server does, not listed here.
 */
const trackerFeedSeed: Activity[] = [
  newsItem("t01", "coffeewire.news", "2026/northwind-shibuya", "Northwind Coffee opens its fifth café, this time in Tokyo's Shibuya", 3, 0.4),
  newsItem("t02", "tokyocafetimes.jp", "news/northwind-shibuya", "ノースウィンド、渋谷に新店舗　ポートランド発のロースターが日本初出店", 9, 0.5, {
    lang: "ja",
    ...translated("Northwind opens a new shop in Shibuya: the Portland roaster's first store in Japan", 9),
  }),
  act("t03", "x", "mention", "early_cup", "early cup", "@northwindcoffee the guji on batch brew today is unreal", 5, ["st_brand"], 0.8),
  act("t04", "x", "own_post", "northwindcoffee", "Northwind Coffee", "Doors at 7 at all four cafés. The Guji is on batch brew until it runs out.", 20, [], null),
  newsItem("t05", "portlandledger.com", "food/cold-brew-guide", "Where to drink cold brew in Portland right now: Northwind, Stumptown Coffee and six more", 30, 0.3),
  act("t06", "bluesky", "mention", "elena.bsky.social", "Elena", "Probé el cold brew de Northwind en Portland. Muy bueno, nada dulce.", 14, [], 0.7, {
    lang: "es",
    ...translated("I tried the Northwind cold brew in Portland. Very good, not sweet at all.", 14),
  }),
  newsItem("t07", "beanbusiness.co", "interviews/ana-ruiz", "Northwind Coffee founder Ana Ruiz on paying farmers more and publishing what she pays", 26, 0.6),
  act("t08", "x", "own_post", "anaroasts", "Ana Ruiz", "Cupping the new Guji lots this morning. Two of them taste like apricot jam.", 7, [], null),
  act("t09", "instagram", "comment", "maya.brews", "Maya", "@ana.roasts your talk at the roasters guild was the best thing I saw this year", 11, [], 0.9),
  act("t10", "x", "mention", "roastmag", "Roast Mag", "Ana Ruiz is right about green coffee prices. More roasters should publish them.", 40, [], 0.5),
  act("t11", "tiktok", "own_post", "jules.sips", "jules", "trying every cold brew in portland. day 4: northwind. honestly the best so far", 18, [], null),
  act("t12", "tiktok", "comment", "coldbrewkid", "cold brew kid", "@jules.sips which one was day 2??", 17, [], 0.2),
  act("t13", "instagram", "mention", "hana.coffee", "はな", "@jules.sips さんの動画を見てノースウィンドに行ってきました。本当においしかった", 23, [], 0.8, {
    lang: "ja",
    ...translated("I went to Northwind after watching @jules.sips's video. It was really good.", 23),
  }),
  newsItem("t14", "tokyocafetimes.jp", "news/bluebottle-winter", "ブルーボトルコーヒー、冬季限定ブレンドを発表", 6, 0.3, {
    lang: "ja",
    ...translated("Blue Bottle Coffee announces a winter-only blend", 6),
  }),
  act("t15", "x", "mention", "pdxbudget", "PDX on a budget", "Blue Bottle's new cold foam is fine but $7 is a lot", 22, [], -0.3),
  act("t16", "instagram", "comment", "jiwoo.cafe", "지우", "블루보틀 성수 매장 커피 맛있어요. 라떼 추천", 35, [], 0.7, {
    lang: "ko",
    ...translated("The coffee at Blue Bottle's Seongsu store is good. I recommend the latte.", 35),
  }),
  act("t17", "reddit", "mention", "pdxlocal", "pdxlocal", "Stumptown Coffee on Division still pulls the best espresso in town, fight me", 28, [], 0.4),
  act("t18", "instagram", "own_post", "littlefern.tea", "Little Fern Tea", "Hojicha latte is back for winter. Same farm in Shizuoka.", 12, [], null),
  act("t19", "tiktok", "comment", "momof3pdx", "Dana", "@littleferntea your matcha is the only one my kid will drink", 15, [], 0.8),
  newsItem("t20", "beanbusiness.co", "funding/little-fern", "Little Fern Tea raises a small seed round to open its first café", 50, 0.4),
  act("t21", "instagram", "own_post", "priya.brews", "Priya Nair", "Packing orders until midnight again. Little Fern turns two next week.", 8, [], null),
  act("t22", "x", "mention", "teafest_pdx", "PDX Tea Fest", "Priya Nair's matcha talk was the best one this year. Slides are up.", 44, [], 0.6),
];

/** What the fixture "model" answers when someone presses Translate. */
const FIXTURE_TRANSLATIONS: Record<string, string> = {
  c02: "How long will the limited yuzu blend be available? I'd love it if you sold it online too.",
  c04: "Hello, can you ship your coffee beans to Shanghai? Roughly how much is shipping?",
  c06: "Order #4471 ok 👍",
};

/** How a few stream keywords are written in other languages, for the fixture "expand to languages". */
const FIXTURE_TERMS: Record<string, Record<string, string[]>> = {
  northwind: { ja: ["ノースウィンド"], zh: ["北风", "Northwind"], ko: ["노스윈드"], es: ["Northwind"], fr: ["Northwind"], de: ["Northwind"], pt: ["Northwind"] },
  "northwind coffee": { ja: ["ノースウィンドコーヒー"], zh: ["北风咖啡"], ko: ["노스윈드 커피"], es: ["café Northwind", "Northwind café"], fr: ["café Northwind"], de: ["Northwind Kaffee"], pt: ["café Northwind"] },
  "cold brew": { ja: ["コールドブリュー", "水出しコーヒー"], zh: ["冷萃咖啡", "冷萃"], ko: ["콜드브루"], es: ["café cold brew", "café infusionado en frío"], fr: ["café infusé à froid"], de: ["Cold Brew Kaffee"], pt: ["café cold brew"] },
  "yuzu blend": { ja: ["ゆずブレンド"], zh: ["柚子拼配"], ko: ["유자 블렌드"], es: ["mezcla de yuzu"], fr: ["mélange yuzu"], de: ["Yuzu-Mischung"], pt: ["blend de yuzu"] },
  shibuya: { ja: ["渋谷"], zh: ["涩谷"], ko: ["시부야"] },
  "pumpkin spice": { ja: ["パンプキンスパイス"], zh: ["南瓜香料"], ko: ["펌킨 스파이스"], es: ["especias de calabaza"], fr: ["épices à citrouille"], de: ["Kürbisgewürz"], pt: ["especiarias de abóbora"] },
  psl: { ja: ["パンプキンスパイスラテ"], zh: ["南瓜拿铁"], ko: ["펌킨 스파이스 라떼"], es: ["latte de calabaza"], fr: ["latte à la citrouille"], de: ["Kürbis-Latte"], pt: ["latte de abóbora"] },
  "blue bottle": { ja: ["ブルーボトル"], zh: ["蓝瓶咖啡"], ko: ["블루보틀"] },
  starbucks: { ja: ["スターバックス", "スタバ"], zh: ["星巴克"], ko: ["스타벅스"] },
  stumptown: { ja: ["スタンプタウン"] },
};

const LIVE_LINES: { network: Network; kind: ActivityKind; handle: string; name: string; text: string; matched: string[] }[] = [
  { network: "x", kind: "mention", handle: "fallhater", "name": "Sam", text: "@northwindcoffee are you doing anything for fall or is it just the cortado", matched: ["st_brand", "st_psl"] },
  { network: "bluesky", kind: "mention", handle: "cortado.club", name: "cortado club", text: "ok the maple-cardamom cortado at @northwind.coffee is actually good", matched: ["st_brand"] },
  { network: "instagram", kind: "comment", handle: "early.riser", name: "Early Riser", text: "please open earlier on weekends 🙏", matched: ["st_brand"] },
  { network: "x", kind: "reply", handle: "pslforever", name: "PSL forever", text: "@northwindcoffee boring take. pumpkin spice is fine.", matched: ["st_brand", "st_psl"] },
];

// --- Alerts, brief, metrics ------------------------------------------------

const alertsSeed: Alert[] = [
  {
    id: "al_psl",
    kind: "trend_window",
    severity: "urgent",
    title: "Pumpkin spice backlash is rising fast",
    body: "Three sources agree. Peak in about 6 hours; the proposal in your queue rides it.",
    evidence: [{ kind: "forecast", ref: "fc_tp_psl" }],
    topicId: "tp_psl",
    acknowledgedAt: null,
    createdAt: ago(0.35),
  },
  {
    id: "al_ig",
    kind: "connector",
    severity: "attention",
    title: "Instagram needs re-authorization",
    body: "The Instagram token expired 9 hours ago. Instagram variants will fail until someone reconnects the account.",
    evidence: [{ kind: "account", ref: "acc_ig" }],
    topicId: null,
    acknowledgedAt: null,
    createdAt: ago(3),
  },
];

const brief: Brief = {
  id: "br_w44",
  periodStart: ago(24 * 6.6),
  periodEnd: ago(2),
  runId: "run_brief_44",
  evidence: null,
  createdAt: ago(2),
  contentMd: `# The week in attention

**38 posts went out**: 21 on X, 12 on Bluesky, 5 on Instagram. Engagement ran **1.6x** the 30-day baseline.

## What moved
- **Cold brew at home** peaked Thursday. The ratio card rode the rise and did 2.3x baseline — the best post of the week.
- **Dirty chai** faded faster than forecast (we said ~36h, it took 20h). Two posts landed after the peak and did 0.8x.
- Oat milk shortage mentions are flat but negative. Nobody is asking us to fix it; they're asking whether we have it.

## What we did
- 3 proposals approved, 1 rejected (the "quiet luxury" angle — off voice).
- The approver edited 2 of 3 operator drafts; edits shortened them by about 30%.

## What's next
- Pumpkin spice backlash is rising with a ~6h window. One proposal is waiting on you.
- Instagram needs reconnecting; 1 queued variant will fail until it is.

Evidence: [lift by stage](https://starsign.local/metrics/lift) · [ledger export](https://starsign.local/export)
`,
};

const summary: Summary = {
  window: { from: ago(24 * 7), to: iso(NOW) },
  publishedByNetwork: [
    { network: "x", posts: 21 },
    { network: "bluesky", posts: 12 },
    { network: "instagram", posts: 5 },
  ],
  measuredAt24h: 36,
  totals: { impressions: 412_000, engagements: 9_800 },
  baselineEngagements24h: 160,
  byNetwork: [
    { key: "x", posts: 21, impressions: 260_000, engagements: 5_900, avgEngagements: 281 },
    { key: "bluesky", posts: 12, impressions: 98_000, engagements: 2_700, avgEngagements: 225 },
    { key: "instagram", posts: 5, impressions: 54_000, engagements: 1_200, avgEngagements: 240 },
  ],
  byHour: [],
  byTrendStage: [
    { key: "rising", posts: 6, impressions: 140_000, engagements: 3_000, avgEngagements: 500 },
    { key: "peaking", posts: 9, impressions: 120_000, engagements: 2_600, avgEngagements: 289 },
    { key: "plateau", posts: 14, impressions: 110_000, engagements: 2_250, avgEngagements: 161 },
    { key: "fading", posts: 5, impressions: 30_000, engagements: 560, avgEngagements: 112 },
    { key: "dormant", posts: 4, impressions: 12_000, engagements: 580, avgEngagements: 145 },
  ],
  byAuthor: [],
  byExperiment: [],
  top: [{ postId: "p_ratio", variantId: "v_ratio_x", network: "x", text: "Cold brew, the whole recipe…", impressions: 18_400, engagements: 612, lift: 2.3 }],
};

const liftByStage: LiftByStage[] = [
  { stage: "rising", posts: 6, avgEngagements: 500, lift: 3.1 },
  { stage: "peaking", posts: 9, avgEngagements: 289, lift: 1.8 },
  { stage: "plateau", posts: 14, avgEngagements: 161, lift: 1.0 },
  { stage: "fading", posts: 5, avgEngagements: 112, lift: 0.7 },
  { stage: "dormant", posts: 4, avgEngagements: 145, lift: 0.9 },
];

// --- Calendar (two weeks from this Monday, workspace time) ------------------

const DAY = 24 * HOUR;
const WEEK_START = weekStartMs(NOW, policy.timezone);
const CAL_STATUSES: PostStatus[] = ["pending_approval", "approved", "scheduled", "publishing", "published", "partially_published", "failed"];

/** A slot this week that has already happened: spread over the time since Monday, or last week early on Monday. */
function pastSlot(fraction: number): number {
  const since = NOW - WEEK_START;
  return since > 3 * HOUR ? WEEK_START + since * fraction : NOW - (6 + 30 * (1 - fraction)) * HOUR;
}

function calPost(
  id: string,
  title: string,
  body: string,
  ms: number,
  status: PostStatus,
  targets: [string, Network, string?][],
  extra: Partial<Post> = {},
): PostSummary {
  // A seeded "future" slot that has already passed by the time the page loads simply went out.
  const effective: PostStatus = ms < NOW && !["published", "failed", "partially_published"].includes(status) ? "published" : status;
  const wentOut = effective === "published" || effective === "partially_published";
  return {
    post: {
      ...basePost,
      id,
      status: effective,
      title,
      body,
      scheduledAt: iso(ms),
      publishedAt: wentOut ? iso(ms) : null,
      actionClass: "new_post",
      createdBy: { type: "human", id: "marta" },
      trendTopicId: null,
      trendStageAtCreation: null,
      disclosure: { aiAssisted: false, aiContributions: [], humanReviewed: true, reviewedBy: "marta" },
      evidence: [],
      policyDecision: { verdict: effective === "pending_approval" ? "require_approval" : "allow", violations: [], policyVersion: 3 },
      createdAt: iso(ms - 2 * DAY),
      updatedAt: iso(ms - 2 * DAY),
      ...extra,
    },
    variants: targets.map(([accountId, network, text], i) =>
      variant(`${id}_v${i}`, id, accountId, network, text ?? body, {
        status: effective === "failed" ? "failed" : wentOut ? (effective === "partially_published" && network === "instagram" ? "failed" : "published") : "pending",
        error: effective === "failed" || (effective === "partially_published" && network === "instagram") ? IG_ERROR : null,
        attemptCount: effective === "failed" ? 3 : wentOut ? 1 : 0,
        publishedAt: wentOut && !(effective === "partially_published" && network === "instagram") ? iso(ms) : null,
        externalUrl: wentOut && network !== "instagram" ? (network === "x" ? `https://x.com/northwindcoffee/status/${id}` : `https://bsky.app/profile/northwind.coffee/post/${id}`) : null,
        media: network === "instagram" ? [{ kind: "image", url: `https://images.northwind.coffee/${id}.jpg`, alt: title }] : [],
      }),
    ),
  };
}

const slot = (day: number, hour: number) => WEEK_START + day * DAY + hour * HOUR;
const XB: [string, Network][] = [
  ["acc_x", "x"],
  ["acc_bsky", "bluesky"],
];

const calendarSeed: PostSummary[] = [
  calPost("p_cal_open", "Doors at 7", "Doors at 7 at all four cafés. The Guji is on batch brew until it runs out.", pastSlot(0.35), "published", XB),
  calPost("p_cal_pour", "The pour", "Forty seconds, one pour, no notes.", pastSlot(0.75), "failed", [["acc_ig", "instagram"]]),
  calPost("p_cal_guji", "The Guji is back", "The Guji is back on espresso. Bright, a little floral, gone in three weeks.", slot(1, 9.5), "scheduled", XB),
  calPost("p_cal_latte", "Latte art Thursday", "Every Thursday our baristas pour whatever you ask for. Within reason.", slot(3, 15), "pending_approval", [["acc_ig", "instagram"], ["acc_bsky", "bluesky"]]),
  calPost("p_cal_sat", "Saturday cuppings", "Saturday cupping at the Pearl, 10am. Free, twelve seats, bring questions.", slot(5, 8), "scheduled", [...XB, ["acc_ig", "instagram"]]),
  calPost("p_cal_roast", "Roast day", "Roast day. If you smell burnt sugar on Division, that's us.", slot(7, 10), "scheduled", XB),
  calPost("p_cal_wholesale", "Wholesale, plainly", "We roast for 31 cafés now. If you run one and want to taste, write to us.", slot(9, 11), "pending_approval", [["acc_x", "x"]]),
  calPost("p_cal_beans", "Bean subscription", "The subscription now ships every two weeks, not every month. Same beans, fresher.", slot(10, 9), "approved", XB),
  calPost("p_cal_fri", "Friday pastries", "Friday: cardamom buns at the Alberta café. They go by 9.", slot(11, 7.5), "scheduled", [...XB, ["acc_ig", "instagram"]]),
];

const cap = (kinds: string[], o: Partial<NetworkCapabilities> = {}): NetworkCapabilities => ({
  publish: true,
  reply: true,
  moderate: true,
  accountMetrics: true,
  webhooks: false,
  video: true,
  kinds,
  ...o,
});

// Every network, in mixed states: some set up and connected, some set up and waiting, some not set up here.
const connectorsSeed: Connector[] = [
  { name: "x", networks: ["x"], configured: true, connect: "oauth", inputs: [], capabilities: { x: cap(["post", "poll"]) } },
  {
    name: "bluesky",
    networks: ["bluesky"],
    configured: true,
    connect: "app_password",
    inputs: [
      { key: "identifier", label: "Handle", placeholder: "yourbrand.bsky.social" },
      { key: "appPassword", label: "App password", placeholder: "xxxx-xxxx-xxxx-xxxx" },
    ],
    capabilities: { bluesky: cap(["post"]) },
  },
  {
    name: "meta",
    networks: ["facebook", "instagram"],
    configured: true,
    connect: "oauth",
    inputs: [],
    capabilities: {
      facebook: cap(["post", "link", "reel", "story"], { webhooks: true }),
      instagram: cap(["post", "carousel", "reel", "story"], { webhooks: true }),
    },
  },
  { name: "threads", networks: ["threads"], configured: true, connect: "oauth", inputs: [], capabilities: { threads: cap(["post", "carousel"]) } },
  { name: "linkedin", networks: ["linkedin"], configured: true, connect: "oauth", inputs: [], capabilities: { linkedin: cap(["post", "link", "carousel"]) } },
  { name: "tiktok", networks: ["tiktok"], configured: true, connect: "oauth", inputs: [], capabilities: { tiktok: cap(["video", "carousel"], { reply: false, moderate: false }) } },
  { name: "youtube", networks: ["youtube"], configured: true, connect: "oauth", inputs: [], capabilities: { youtube: cap(["video", "short"]) } },
  { name: "pinterest", networks: ["pinterest"], configured: false, connect: "oauth", inputs: [], capabilities: { pinterest: cap(["pin"], { reply: false, moderate: false }) } },
  {
    name: "mastodon",
    networks: ["mastodon"],
    configured: true,
    connect: "oauth",
    inputs: [{ key: "instance", label: "Your server", placeholder: "mastodon.social" }],
    capabilities: { mastodon: cap(["post", "poll"], { webhooks: true }) },
  },
  { name: "reddit", networks: ["reddit"], configured: false, connect: "oauth", inputs: [], capabilities: { reddit: cap(["post", "link"]) } },
  { name: "google_business", networks: ["google_business"], configured: false, connect: "oauth", inputs: [], capabilities: { google_business: cap(["post"], { reply: true, moderate: false, video: false }) } },
  {
    name: "telegram",
    networks: ["telegram"],
    configured: true,
    connect: "bot_token",
    inputs: [
      { key: "botToken", label: "Bot token", placeholder: "123456789:AA…" },
      { key: "chatId", label: "Channel", placeholder: "@yourchannel" },
    ],
    capabilities: { telegram: cap(["post", "poll"], { reply: true, moderate: true, accountMetrics: true }) },
  },
  {
    name: "discord",
    networks: ["discord"],
    configured: true,
    connect: "webhook_url",
    inputs: [{ key: "webhookUrl", label: "Webhook URL", placeholder: "https://discord.com/api/webhooks/…" }],
    capabilities: { discord: cap(["post"], { reply: false, moderate: false, accountMetrics: false }) },
  },
  // Chat apps. Credential inputs mirror packages/connectors (discord-bot.ts, whatsapp.ts, wechat.ts, line.ts).
  {
    name: "discord_bot",
    networks: ["discord"],
    configured: true,
    connect: "bot_token",
    inputs: [
      { key: "botToken", label: "Bot token (Developer Portal → Bot → Reset Token)", placeholder: "MTIz...abc.Gh1234.xyz...", secret: true },
      { key: "guildId", label: "Server ID (right-click the server → Copy Server ID)", placeholder: "123456789012345678" },
      { key: "defaultChannelId", label: "Channel ID for posts (optional; default: first text channel)", placeholder: "234567890123456789", optional: true },
    ],
    capabilities: { discord: cap(["post", "video", "carousel", "link"], { moderateActions: ["like", "unlike", "delete"] }) },
  },
  {
    name: "whatsapp",
    networks: ["whatsapp"],
    configured: true,
    connect: "api_key",
    inputs: [
      { key: "phoneNumberId", label: "Phone number ID (WhatsApp Manager > API setup)", placeholder: "106540352242922" },
      { key: "wabaId", label: "WhatsApp Business Account ID", placeholder: "102290129340398" },
      { key: "accessToken", label: "System User access token (permanent)", placeholder: "EAAG...", secret: true },
      { key: "defaultGroupId", label: "Group to post to (optional; a group your business created)", placeholder: "group id from the Groups API", optional: true },
    ],
    capabilities: { whatsapp: cap(["post"], { accountMetrics: false, webhooks: true, moderateActions: ["like", "unlike"] }) },
  },
  {
    name: "wechat",
    networks: ["wechat"],
    configured: true,
    connect: "api_key",
    inputs: [
      { key: "appId", label: "AppID", placeholder: "wx1234567890abcdef" },
      { key: "appSecret", label: "AppSecret", placeholder: "32 letters and digits", secret: true },
      { key: "originalId", label: "Original ID (原始ID)", placeholder: "gh_0123456789ab" },
      { key: "token", label: "Server Token (服务器配置 Token)", placeholder: "the Token you entered in the server configuration", secret: true },
      { key: "encodingAesKey", label: "EncodingAESKey (only for safe mode)", placeholder: "43 characters; leave empty for plaintext mode", secret: true, optional: true },
    ],
    capabilities: { wechat: cap([], { publish: false, moderate: false, webhooks: true, video: false }) },
  },
  {
    name: "line",
    networks: ["line"],
    configured: true,
    connect: "bot_token",
    inputs: [
      { key: "channelAccessToken", label: "Channel access token (long-lived, Messaging API tab)", placeholder: "eyJhbGciOi... or a long base64 string", secret: true },
      { key: "channelSecret", label: "Channel secret (Basic settings tab)", placeholder: "32 hex characters", secret: true },
    ],
    capabilities: { line: cap(["post"], { moderate: false, webhooks: true, video: false }) },
  },
];

const sourcesSeed: TrendSource[] = [
  { name: "google_trends", kind: "both", configured: true, lastRunAt: ago(0.3), lastError: null, pointsLast24h: 288 },
  { name: "bluesky_firehose", kind: "both", configured: true, lastRunAt: ago(0.1), lastError: null, pointsLast24h: 1_420 },
  { name: "wikipedia_pageviews", kind: "sample", configured: true, lastRunAt: ago(7), lastError: null, pointsLast24h: 24 },
  { name: "youtube_trending", kind: "trending", configured: true, lastRunAt: ago(5), lastError: "quota exceeded for today", pointsLast24h: 60 },
  { name: "tiktok_creative_center", kind: "trending", configured: false, lastRunAt: null, lastError: null, pointsLast24h: 0 },
];

const discoveriesSeed: Discovery[] = [
  { term: "pumpkin spice too early", source: "google_trends", value: 100, url: null, observedAt: ago(0.4), region: "US-OR" },
  { term: "cold brew ratio", source: "google_trends", value: 64, url: null, observedAt: ago(0.4), region: "US" },
  { term: "oat milk shortage", source: "bluesky_firehose", value: 212, url: "https://bsky.app/search?q=oat+milk+shortage", observedAt: ago(1.1), region: null },
  { term: "world coffee day", source: "wikipedia_pageviews", value: 880, url: "https://en.wikipedia.org/wiki/International_Coffee_Day", observedAt: ago(7), region: null },
];

// --- Red lines, dry run --------------------------------------------------

const NEEDS_APPROVAL: { id: string; kind: string; re: RegExp; message: (m: string) => string }[] = [
  { id: "rl_comp", kind: "no_competitor_mention", re: /\b(MEC|Blue Bottle|Stumptown|Starbucks)\b/g, message: (m) => `Names a competitor: ${m}` },
];

const SEEDED_LINES = new Set(["rl_comp", "rl_health", "rl_guarantee", "rl_quiet", "rl_disclose"]);

function checkPolicy(input: PolicyCheckInput): PolicyDecision {
  const found = new Map<string, { redLineId: string; kind: string; severity: "block" | "require_approval"; message: string; matches: Set<string> }>();
  const add = (redLineId: string, kind: string, severity: "block" | "require_approval", message: string, match: string | null) => {
    const key = `${redLineId}|${message}`;
    const v = found.get(key) ?? { redLineId, kind, severity, message, matches: new Set<string>() };
    if (match) v.matches.add(match);
    found.set(key, v);
  };
  for (const v of input.variants) {
    for (const rule of BLOCKING) for (const m of v.text.match(rule.re) ?? []) add(rule.id, rule.kind, "block", rule.message, m);
    for (const rule of NEEDS_APPROVAL) for (const m of v.text.match(rule.re) ?? []) add(rule.id, rule.kind, "require_approval", rule.message(m), m);
  }
  // Quiet hours are about when something goes out; a draft with no time isn't going anywhere.
  const hour = input.scheduledAt
    ? Number(new Intl.DateTimeFormat("en-US", { timeZone: policy.timezone, hour: "numeric", hourCycle: "h23" }).format(new Date(input.scheduledAt)))
    : 12;
  if (policy.redLines.some((r) => r.id === "rl_quiet") && (hour >= 22 || hour < 7)) add("rl_quiet", "quiet_hours", "require_approval", "Falls inside quiet hours (10pm–7am Pacific)", null);
  // Red lines added in Settings, judged roughly the way the server does.
  for (const r of policy.redLines) {
    if (SEEDED_LINES.has(r.id) || r.severity === "warn") continue;
    const sev = r.severity as "block" | "require_approval";
    const res: RegExp[] = [];
    const words = (k: string) => ((r[k] as string[] | undefined) ?? []).map((w) => new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(w)}(?![\\p{L}\\p{N}_])`, "iu"));
    if (r.kind === "forbidden_phrase") res.push(...words("phrases"));
    if (r.kind === "forbidden_topic") res.push(...words("keywords"));
    if (r.kind === "no_competitor_mention") res.push(...words("competitors"));
    if (r.kind === "forbidden_claim" || r.kind === "custom_regex") {
      const pats = r.kind === "custom_regex" ? [r.pattern as string] : ((r.patterns as string[] | undefined) ?? []);
      const flags = r.kind === "custom_regex" ? String(r.flags ?? "i") : "i";
      for (const p of pats) {
        try {
          res.push(new RegExp(p, flags.includes("u") ? flags.replace("g", "") : `${flags.replace("g", "")}u`));
        } catch {
          // an invalid pattern never matches, like the server
        }
      }
    }
    if (r.kind === "quiet_hours" && input.scheduledAt) {
      const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: String(r.timezone), hour: "numeric", hourCycle: "h23" }).format(new Date(input.scheduledAt)));
      const start = Number(r.startHour);
      const end = Number(r.endHour);
      const inside = start <= end ? h >= start && h < end : h >= start || h < end;
      if (inside) add(r.id, r.kind, sev, `${r.description}: falls inside quiet hours`, null);
    }
    for (const v of input.variants) for (const re of res) {
      const m = v.text.match(re);
      if (m?.[0]) add(r.id, r.kind, sev, r.description, m[0].trim());
    }
  }
  const violations: Violation[] = [...found.values()].map((v) => ({ ...v, matches: [...v.matches] }));
  const verdict = violations.some((v) => v.severity === "block") ? "block" : violations.length ? "require_approval" : "allow";
  return { verdict, violations, policyVersion: policy.version };
}

// --- Compose, adapted per network -----------------------------------------

function sentences(text: string): string[] {
  return text.match(/[^.!?]+[.!?]*\s*/g)?.map((x) => x.trim()).filter(Boolean) ?? [text];
}

/** Pack sentences into segments under `max`; whatever doesn't fit continues as a thread. */
function packThread(text: string, max: number): { text: string; thread: string[] } {
  const segs: string[] = [];
  let cur = "";
  for (const sentence of sentences(text)) {
    const next = cur ? `${cur} ${sentence}` : sentence;
    if (next.length <= max) cur = next;
    else {
      if (cur) segs.push(cur);
      cur = truncate(sentence, max);
    }
  }
  if (cur) segs.push(cur);
  return { text: segs[0] ?? "", thread: segs.slice(1) };
}

function adaptFor(network: Network, body: string): AdaptedVariant {
  const plain = body.replace(/\s+/g, " ").trim();
  switch (network) {
    case "x": {
      const tight = plain.replace(/\band\b/g, "&").replace(/\bwe are\b/gi, "we're");
      return { network, ...packThread(tight, 270) };
    }
    case "bluesky":
      return { network, ...packThread(plain, 290) };
    case "threads":
    case "mastodon":
      return { network, ...packThread(plain, 480) };
    case "instagram":
      return { network, text: `${sentences(plain).join("\n\n")}\n\n#northwindcoffee #portlandcoffee`, thread: [] };
    case "linkedin":
      return { network, text: `${plain}\n\nNorthwind Coffee roasts in Portland for four cafés and 31 wholesale partners.`, thread: [] };
    default:
      return { network, text: plain, thread: [] };
  }
}

// --- Mutable state (the fixture "server") ----------------------------------

const state = {
  streams: clone(streams),
  languageSettings: { home: "en", autoTranslate: true, dailyLimit: 2000 } as LanguageSettings,
  queue: clone(queueSeed),
  decided: [] as PostSummary[],
  feed: clone([...feedSeed, ...trackerFeedSeed]),
  alerts: clone(alertsSeed),
  liveIndex: 0,
  calendar: clone(calendarSeed),
  created: [] as PostSummary[],
  createdSeq: 0,
};

function allPosts(): PostSummary[] {
  return [...state.queue, ...state.decided, ...published, ...state.calendar, ...state.created];
}

function topicActions(topicId: string): TopicDetail["actions"] {
  return allPosts()
    .filter((p) => p.post.trendTopicId === topicId)
    .sort((a, b) => Date.parse(b.post.createdAt) - Date.parse(a.post.createdAt))
    .map((p) => ({
      postId: p.post.id,
      stageAtAction: p.post.trendStageAtCreation,
      forecastId: p.post.trendForecastId,
      createdAt: p.post.createdAt,
      outcome24h: OUTCOMES[p.post.id] ?? null,
    }));
}

const BLOCKING: { id: string; kind: string; re: RegExp; message: string }[] = [
  { id: "rl_guarantee", kind: "forbidden_phrase", re: /\bguarantee[sd]?\b/gi, message: "Promises guaranteed results" },
  { id: "rl_health", kind: "forbidden_claim", re: /\b(cures?|heals?|burns? fat|weight loss|detox)\b/gi, message: "Makes a health claim about coffee" },
];

// --- People, sign-in, teams (v1.2) ----------------------------------------
// The fixture "server" keeps who is signed in, which workspace is current, and each workspace's accounts in
// localStorage, standing in for the session cookie. That way a sign-in or an OAuth round trip (which reloads
// the page) behaves like the real thing. Sign in with any email; the password "wrong" fails.

interface FxUser {
  id: string;
  email: string;
  name: string;
}

interface FxWorkspace {
  id: string;
  slug: string;
  name: string;
  role: Role;
  createdAt: string;
}

interface FxStore {
  signedIn: boolean;
  user: FxUser;
  currentWorkspaceId: string;
  workspaces: FxWorkspace[];
  accounts: Record<string, Account[]>;
  members: Member[];
  /** Pending invites, per workspace. Older stored states lack it; it is seeded on load. */
  invites?: Record<string, (PendingInvite & { token: string })[]>;
}

const FX_STORE_KEY = "starsign.fixtures.v2";

function seedStore(): FxStore {
  return {
    signedIn: false,
    user: { id: "usr_maya", email: "maya@northwind.coffee", name: "Maya Chen" },
    currentWorkspaceId: workspace.id,
    workspaces: [
      { id: workspace.id, slug: workspace.slug, name: workspace.name, role: "owner", createdAt: workspace.createdAt },
      { id: "ws_alder", slug: "alder-pine", name: "Alder & Pine Bakery", role: "owner", createdAt: ago(24 * 30) },
      { id: "ws_harbor", slug: "harbor-books", name: "Harbor Books", role: "editor", createdAt: ago(24 * 12) },
    ],
    accounts: {
      [workspace.id]: clone(accounts),
      ws_alder: [acct("acc_alder_ig", "instagram", "alderandpine", "Alder & Pine", "meta", "active", 2), acct("acc_alder_fb", "facebook", "alderandpinebakery", "Alder & Pine Bakery", "meta", "active", 2)],
      ws_harbor: [acct("acc_harbor_bsky", "bluesky", "harborbooks.bsky.social", "Harbor Books", "bluesky", "active", 3)],
    },
    members: [
      { id: "mem_maya", userId: "usr_maya", email: "maya@northwind.coffee", name: "Maya Chen", role: "owner", createdAt: ago(24 * 90) },
      { id: "mem_dev", userId: "usr_dev", email: "dev@northwind.coffee", name: "Dev Patel", role: "approver", createdAt: ago(24 * 60) },
      { id: "mem_sam", userId: "usr_sam", email: "sam@northwind.coffee", name: "Sam Okafor", role: "editor", createdAt: ago(24 * 21) },
      { id: "mem_rita", userId: "usr_rita", email: "rita@quillagency.com", name: "Rita Alvarez", role: "viewer", createdAt: ago(24 * 4) },
    ],
  };
}

function seedInvites(): Record<string, (PendingInvite & { token: string })[]> {
  const maya = { id: "usr_maya", name: "Maya Chen", email: "maya@northwind.coffee" };
  return {
    [workspace.id]: [
      { id: "inv_jordan", token: "demo", email: "jordan@northwind.coffee", role: "editor", invitedBy: maya, expiresAt: ahead(24 * 6), createdAt: ago(24) },
      { id: "inv_lee", token: "inv_lee", email: "lee@quillagency.com", role: "viewer", invitedBy: maya, expiresAt: ahead(24 * 2), createdAt: ago(24 * 5) },
    ],
  };
}

function loadStore(): FxStore {
  try {
    const raw = localStorage.getItem(FX_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as FxStore;
      if (parsed && parsed.user && Array.isArray(parsed.workspaces) && parsed.accounts) return parsed;
    }
  } catch {
    // fall through to a fresh seed
  }
  return seedStore();
}

const store: FxStore = loadStore();
store.invites ??= seedInvites();

function invitesHere(): (PendingInvite & { token: string })[] {
  const all = (store.invites ??= {});
  const id = currentWs().id;
  all[id] = (all[id] ?? []).filter((i) => Date.parse(i.expiresAt) > Date.now());
  return all[id]!;
}

function save(): void {
  try {
    localStorage.setItem(FX_STORE_KEY, JSON.stringify(store));
  } catch {
    // private window: fixture state lasts for this page load
  }
}

function currentWs(): FxWorkspace {
  return store.workspaces.find((w) => w.id === store.currentWorkspaceId) ?? store.workspaces[0]!;
}

function currentAccounts(): Account[] {
  const id = currentWs().id;
  store.accounts[id] ??= [];
  return store.accounts[id]!;
}

function currentMe(): Me {
  const w = currentWs();
  const ws: Workspace = w.id === workspace.id ? workspace : { ...workspace, id: w.id, slug: w.slug, name: w.name, profile: {}, createdAt: w.createdAt };
  return { workspace: ws, actor: { type: "human", id: store.signedIn ? store.user.name.split(" ")[0]!.toLowerCase() : "dev" }, role: w.role };
}

function sessionOf(): Session {
  const workspaces: SessionWorkspace[] = store.workspaces.map((w) => ({ id: w.id, slug: w.slug, name: w.name, role: w.role }));
  return clone({ user: store.user, workspaces, currentWorkspaceId: currentWs().id });
}

function requireSession(): void {
  if (!store.signedIn) throw new ApiError(401, "unauthorized", "Sign in first.");
}

function requireOwner(): void {
  requireSession();
  if (currentWs().role !== "owner") throw new ApiError(403, "forbidden", "Only an owner can change the team.");
}

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "workspace";

const INVITES: Record<string, InviteInfo> = {
  demo: { workspaceName: "Northwind Coffee", email: "jordan@northwind.coffee", role: "editor", expiresAt: ahead(24 * 6), userExists: false },
  member: { workspaceName: "Harbor Books", email: "maya@northwind.coffee", role: "approver", expiresAt: ahead(24 * 3), userExists: true },
};

function peopleApi() {
  return {
    session: async (): Promise<Session> => {
      await delay(null, 120);
      // The real server could say whether it takes sign-ups; fixtures say yes so every screen is reachable.
      if (!store.signedIn) throw new ApiError(401, "unauthorized", "not signed in", { signupAllowed: true });
      return sessionOf();
    },

    login: async (email: string, password: string): Promise<Session> => {
      await delay(null, 450);
      if (/^locked@/i.test(email.trim())) throw new ApiError(429, "rate_limited", "too many attempts");
      if (!email.includes("@") || !password || password === "wrong") throw new ApiError(401, "unauthorized", "That email and password don't match.");
      store.signedIn = true;
      if (email.trim().toLowerCase() !== store.user.email) {
        const local = email.split("@")[0] ?? "you";
        store.user = { ...store.user, email: email.trim().toLowerCase(), name: local.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) };
      }
      save();
      return sessionOf();
    },

    signup: async (input: SignupInput): Promise<Session> => {
      await delay(null, 600);
      if (input.password.length < 10) throw new ApiError(400, "invalid", "Use at least 10 characters for the password.");
      const id = `ws_${slugify(input.workspaceName).replace(/-/g, "_")}`;
      store.signedIn = true;
      store.user = { id: "usr_new", email: input.email.trim().toLowerCase(), name: input.name.trim() };
      if (!store.workspaces.some((w) => w.id === id)) {
        store.workspaces.unshift({ id, slug: slugify(input.workspaceName), name: input.workspaceName.trim(), role: "owner", createdAt: iso(Date.now()) });
      }
      store.currentWorkspaceId = id;
      store.members = [{ id: "mem_new", userId: "usr_new", email: store.user.email, name: store.user.name, role: "owner", createdAt: iso(Date.now()) }];
      save();
      return sessionOf();
    },

    logout: async (): Promise<void> => {
      await delay(null, 150);
      store.signedIn = false;
      save();
    },

    switchWorkspace: async (workspaceId: string): Promise<Session> => {
      await delay(null, 220);
      requireSession();
      if (!store.workspaces.some((w) => w.id === workspaceId)) throw new ApiError(403, "forbidden", "You aren't a member of that workspace.");
      store.currentWorkspaceId = workspaceId;
      save();
      return sessionOf();
    },

    forgot: async (_email: string): Promise<void> => {
      await delay(null, 400);
    },

    reset: async (token: string, password: string): Promise<void> => {
      await delay(null, 400);
      if (token === "expired") throw new ApiError(400, "invalid", "This reset link has expired. Ask for a new one.");
      if (password.length < 10) throw new ApiError(400, "invalid", "Use at least 10 characters for the password.");
    },

    createWorkspace: async (name: string): Promise<Workspace> => {
      await delay(null, 350);
      requireSession();
      const clean = name.trim();
      if (!clean) throw new ApiError(400, "invalid", "Give the workspace a name.");
      let slug = slugify(clean);
      while (store.workspaces.some((w) => w.slug === slug)) slug = `${slug}-2`;
      const w: FxWorkspace = { id: `ws_${slug.replace(/-/g, "_")}`, slug, name: clean, role: "owner", createdAt: iso(Date.now()) };
      store.workspaces.push(w);
      store.accounts[w.id] = [];
      save();
      return clone({ ...workspace, id: w.id, slug, name: clean, profile: {}, createdAt: w.createdAt });
    },

    members: async (): Promise<Member[]> => {
      await delay(null, 160);
      requireSession();
      const mine = store.members.find((m) => m.email === store.user.email);
      if (!mine) store.members.unshift({ id: "mem_self", userId: store.user.id, email: store.user.email, name: store.user.name, role: currentWs().role, createdAt: ago(24 * 90) });
      return clone(store.members);
    },

    setMemberRole: async (id: string, role: Role): Promise<Member> => {
      await delay(null, 300);
      requireOwner();
      const m = store.members.find((x) => x.id === id);
      if (!m) throw new ApiError(404, "not_found", "That person isn't on the team anymore.");
      const owners = store.members.filter((x) => x.role === "owner");
      if (m.role === "owner" && role !== "owner" && owners.length <= 1) {
        throw new ApiError(409, "conflict", "A workspace needs at least one owner. Make someone else an owner first.");
      }
      m.role = role;
      save();
      return clone(m);
    },

    removeMember: async (id: string): Promise<void> => {
      await delay(null, 300);
      requireOwner();
      const idx = store.members.findIndex((x) => x.id === id);
      const m = store.members[idx];
      if (!m) throw new ApiError(404, "not_found", "That person isn't on the team anymore.");
      if (m.role === "owner" && store.members.filter((x) => x.role === "owner").length <= 1) {
        throw new ApiError(409, "conflict", "You can't remove the last owner.");
      }
      store.members.splice(idx, 1);
      save();
    },

    invite: async (email: string, role: Role): Promise<InviteCreated> => {
      await delay(null, 450);
      requireOwner();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) throw new ApiError(400, "invalid", "That doesn't look like an email address.");
      if (store.members.some((m) => m.email === email.trim().toLowerCase())) throw new ApiError(409, "conflict", "They're already on the team.");
      const token = `inv${Math.random().toString(36).slice(2, 10)}`;
      INVITES[token] = { workspaceName: currentWs().name, email: email.trim().toLowerCase(), role, expiresAt: ahead(24 * 7), userExists: false };
      invitesHere().unshift({
        id: `inv_${token}`,
        token,
        email: email.trim().toLowerCase(),
        role,
        invitedBy: { id: store.user.id, name: store.user.name, email: store.user.email },
        expiresAt: ahead(24 * 7),
        createdAt: iso(Date.now()),
      });
      save();
      // Pretend email is configured for company addresses only, so both outcomes show up.
      return { inviteUrl: `${window.location.origin}/?invite=${token}`, expiresAt: ahead(24 * 7), emailed: !/gmail\.com$/i.test(email) };
    },

    invites: async (): Promise<PendingInvite[]> => {
      await delay(null, 160);
      requireSession();
      if (currentWs().role !== "owner") throw new ApiError(403, "forbidden", "Only an owner can see pending invites.");
      return clone(invitesHere().map(({ token: _t, ...rest }) => rest));
    },

    revokeInvite: async (id: string): Promise<void> => {
      await delay(null, 280);
      requireSession();
      if (currentWs().role !== "owner") throw new ApiError(403, "forbidden", "Only an owner can revoke invites.");
      const list = invitesHere();
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) throw new ApiError(404, "not_found", "That invite was already used, expired or revoked.");
      delete INVITES[list[i]!.token];
      list.splice(i, 1);
      save();
    },

    inviteInfo: async (token: string): Promise<InviteInfo> => {
      await delay(null, 250);
      const info = INVITES[token];
      if (!info) throw new ApiError(404, "not_found", "invite not found");
      return clone(info);
    },

    acceptInvite: async (input: AcceptInviteInput): Promise<Session> => {
      await delay(null, 500);
      const info = INVITES[input.token];
      if (!info) throw new ApiError(404, "not_found", "This invite has expired or was already used.");
      if (!store.signedIn) {
        if (info.userExists) {
          if (!input.password || input.password === "wrong") throw new ApiError(401, "unauthorized", "That password doesn't match the account for this email.");
          store.user = { ...store.user, email: info.email };
        } else {
          if (!input.name?.trim() || !input.password) throw new ApiError(400, "invalid", "Add your name and a password to join.");
          if (input.password.length < 10) throw new ApiError(400, "invalid", "Use at least 10 characters for the password.");
          store.user = { id: "usr_invited", email: info.email, name: input.name.trim() };
        }
      }
      store.signedIn = true;
      const existing = store.workspaces.find((w) => w.name === info.workspaceName);
      if (existing) store.currentWorkspaceId = existing.id;
      else {
        const slug = slugify(info.workspaceName);
        store.workspaces.push({ id: `ws_${slug}`, slug, name: info.workspaceName, role: info.role, createdAt: iso(Date.now()) });
        store.currentWorkspaceId = `ws_${slug}`;
      }
      delete INVITES[input.token];
      for (const list of Object.values(store.invites ?? {})) {
        const i = list.findIndex((x) => x.token === input.token);
        if (i >= 0) list.splice(i, 1);
      }
      save();
      return sessionOf();
    },
  };
}

// --- Integrations (v1.2) -----------------------------------------------------

const FOLLOWERS: Record<string, number> = {
  acc_x: 18_420,
  acc_bsky: 3_912,
  acc_ig: 41_300,
  acc_fb: 12_870,
  acc_yt: 6_240,
  acc_tt: 22_150,
  acc_masto: 1_184,
  acc_alder_ig: 8_710,
  acc_alder_fb: 2_302,
  acc_harbor_bsky: 940,
};

/** Who an OAuth round trip "finds" behind one login, per connector. */
const OAUTH_FINDS: Record<string, { network: Network; handle: string; name: string }[]> = {
  meta: [
    { network: "facebook", handle: "northwindpearl", name: "Northwind Coffee · Pearl" },
    { network: "facebook", handle: "northwindalberta", name: "Northwind Coffee · Alberta" },
    { network: "instagram", handle: "northwindwholesale", name: "Northwind Wholesale" },
  ],
  threads: [{ network: "threads", handle: "northwindcoffee", name: "Northwind Coffee" }],
  linkedin: [
    { network: "linkedin", handle: "maya-chen", name: "Maya Chen" },
    { network: "linkedin", handle: "northwind-coffee-roasters", name: "Northwind Coffee Roasters" },
  ],
  x: [{ network: "x", handle: "northwindwholesale", name: "Northwind Wholesale" }],
  tiktok: [{ network: "tiktok", handle: "northwind.coffee", name: "Northwind Coffee" }],
  youtube: [{ network: "youtube", handle: "northwindroasters", name: "Northwind Roasters" }],
};

/** A small SVG "photo" so library thumbnails render offline. */
function svgThumb(label: string, a: string, b: string, w = 1080, h = 1350): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.68}" cy="${h * 0.36}" r="${Math.min(w, h) * 0.22}" fill="rgba(255,255,255,0.18)"/><text x="${w * 0.08}" y="${h * 0.9}" font-family="Inter, sans-serif" font-size="${Math.round(w / 14)}" fill="rgba(255,255,255,0.92)">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function asset(id: string, kind: MediaAsset["kind"], mime: string, url: string, name: string, extra: Partial<MediaAsset> = {}, hoursAgo = 24): MediaAsset {
  const a: MediaAsset = {
    id,
    url,
    kind,
    mime,
    bytes: extra.bytes ?? 1_200_000,
    width: extra.width ?? null,
    height: extra.height ?? null,
    durationSeconds: extra.durationSeconds ?? null,
    originalName: name,
    alt: extra.alt ?? null,
    createdAt: ago(hoursAgo),
    media: { kind, url, mime },
  };
  a.media = {
    kind,
    url,
    mime,
    bytes: a.bytes,
    assetId: id,
    ...(a.width ? { width: a.width } : {}),
    ...(a.height ? { height: a.height } : {}),
    ...(a.durationSeconds ? { durationSeconds: a.durationSeconds } : {}),
    ...(a.alt ? { alt: a.alt } : {}),
  };
  return a;
}

const mediaLibrary: MediaAsset[] = [
  asset("med_pour", "image", "image/jpeg", svgThumb("The pour", "#6b3f1d", "#d9a066"), "pour.jpg", { width: 1080, height: 1350, bytes: 2_400_000, alt: "A barista pouring a rosetta into a flat white" }, 20),
  asset("med_pearl", "image", "image/jpeg", svgThumb("Pearl café", "#24414f", "#8fb3a8", 1600, 1067), "pearl-cafe.jpg", { width: 1600, height: 1067, bytes: 3_100_000, alt: "Morning light in the Pearl café" }, 52),
  asset("med_roast", "video", "video/mp4", svgThumb("Roast day", "#3d1f12", "#c2562b", 1080, 1920), "roast-day.mp4", { width: 1080, height: 1920, durationSeconds: 42, bytes: 48_000_000 }, 75),
  asset("med_menu", "document", "application/pdf", "", "wholesale-menu-fall.pdf", { bytes: 860_000 }, 120),
];

function kindOfFile(file: File): MediaAsset["kind"] | null {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "document";
  if (file.type === "image/gif") return "gif";
  if (/^image\/(jpeg|png|webp)$/.test(file.type)) return "image";
  if (/^video\/(mp4|quicktime|webm)$/.test(file.type) || /\.(mp4|mov|webm)$/i.test(file.name)) return "video";
  return null;
}

function probeImage(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function probeVideo(url: string): Promise<{ width: number; height: number; duration: number } | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration });
    v.onerror = () => resolve(null);
    v.src = url;
  });
}

/** Simulated upload: progress ticks over a second or two, then the file joins this tab's library. */
export function fixtureUpload(file: File, onProgress: (p: number) => void, alt?: string): { done: Promise<MediaAsset>; abort: () => void } {
  let timer: number | null = null;
  let rejectFn: ((e: unknown) => void) | null = null;
  const done = new Promise<MediaAsset>((resolve, reject) => {
    rejectFn = reject;
    const kind = kindOfFile(file);
    if (!kind) {
      window.setTimeout(() => reject(new ApiError(400, "invalid", "unsupported file: upload JPEG, PNG, GIF, WebP, MP4, MOV, WebM or PDF")), 300);
      return;
    }
    const cap = kind === "video" ? 1024e6 : kind === "document" ? 100e6 : 30e6;
    if (file.size > cap) {
      window.setTimeout(() => reject(new ApiError(400, "invalid", `file is ${Math.round(file.size / 1e6)}MB; the limit for ${kind} is ${Math.round(cap / 1e6)}MB`)), 300);
      return;
    }
    const total = Math.min(2600, 700 + file.size / 4000);
    const started = Date.now();
    timer = window.setInterval(async () => {
      const p = Math.min(1, (Date.now() - started) / total);
      onProgress(p);
      if (p < 1) return;
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      const url = URL.createObjectURL(file);
      let width: number | null = null;
      let height: number | null = null;
      let durationSeconds: number | null = null;
      if (kind === "image" || kind === "gif") {
        const d = await probeImage(url);
        width = d?.width ?? null;
        height = d?.height ?? null;
      } else if (kind === "video") {
        const d = await probeVideo(url);
        width = d?.width || null;
        height = d?.height || null;
        durationSeconds = d && Number.isFinite(d.duration) ? Math.round(d.duration * 10) / 10 : null;
      }
      state.createdSeq += 1;
      const a = asset(`med_up_${state.createdSeq}`, kind, file.type || "application/octet-stream", url, file.name, { width, height, durationSeconds, bytes: file.size, alt: alt ?? null }, 0);
      mediaLibrary.unshift(a);
      resolve(clone(a));
    }, 90);
  });
  return {
    done,
    abort: () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      rejectFn?.(new ApiError(0, "aborted", "Upload cancelled."));
    },
  };
}

function integrationsApi() {
  return {
    connectStart: async (connector: string, input: ConnectStartInput): Promise<OAuthStart> => {
      await delay(null, 350);
      const c = connectorsSeed.find((k) => k.name === connector);
      if (!c) throw new ApiError(404, "not_found", "No such connector.");
      if (!c.configured) throw new ApiError(503, "unavailable", `${networkLabel(c.networks[0] ?? connector)} isn't set up on this server`);
      if (c.inputs?.length) {
        for (const field of c.inputs) {
          if (!input.inputs?.[field.key]?.trim()) throw new ApiError(400, "invalid", `${field.label} is required`, { reason: `Enter ${field.label.toLowerCase()} first.` });
        }
      }
      // Fixture mode round-trips locally: the "network" sends the browser straight back as if it had said yes.
      const server = input.inputs?.instance?.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (server === "fail.example") return { authorizeUrl: `/?connect_error=access_denied&connector=${encodeURIComponent(connector)}`, expiresAt: ahead(0.2) };
      const finds =
        OAUTH_FINDS[connector] ??
        (connector === "mastodon"
          ? [{ network: "mastodon" as Network, handle: `northwind@${server || "mastodon.social"}`, name: "Northwind Coffee" }]
          : [{ network: (input.network ?? c.networks[0]!) as Network, handle: "northwindcoffee", name: "Northwind Coffee" }]);
      const list = currentAccounts();
      const added: string[] = [];
      for (const f of finds) {
        if (input.network && f.network !== input.network && connector !== "meta") continue;
        const existing = list.find((a) => a.network === f.network && a.handle === f.handle);
        if (existing) {
          existing.status = "active";
          existing.hasCredentials = true;
        } else {
          state.createdSeq += 1;
          list.push(acct(`acc_${f.network}_${Date.now().toString(36)}_${state.createdSeq}`, f.network, f.handle, f.name, connector, "active", null));
        }
        added.push(f.handle);
      }
      save();
      return { authorizeUrl: `/?connected=${encodeURIComponent(connector)}&handle=${encodeURIComponent(added.join(","))}&count=${added.length}`, expiresAt: ahead(0.2) };
    },

    connectCredentials: async (connector: string, input: ConnectCredentialsInput): Promise<Account[]> => {
      await delay(null, 600);
      const c = connectorsSeed.find((k) => k.name === connector);
      if (!c) throw new ApiError(404, "not_found", "No such connector.");
      for (const field of c.inputs ?? []) {
        if (!field.optional && !input.inputs[field.key]?.trim()) throw new ApiError(400, "invalid", "connect failed", { reason: `Enter ${field.label.toLowerCase()}.` });
      }
      const values = Object.values(input.inputs).map((v) => v.trim());
      if (values.includes("fail")) {
        const reason =
          connector === "bluesky"
            ? "Bluesky said the handle or app password is wrong."
            : connector === "telegram"
              ? "Telegram didn't accept that bot token, or the bot isn't an admin of that channel."
              : connector === "discord_bot"
                ? "Discord didn't accept that bot token, or the bot isn't in that server."
                : connector === "whatsapp"
                  ? "WhatsApp didn't accept that access token for this phone number."
                  : connector === "wechat"
                    ? "WeChat didn't accept that AppID and AppSecret."
                    : connector === "line"
                      ? "LINE didn't accept that channel access token."
                      : "Discord didn't accept that webhook URL.";
        throw new ApiError(400, "invalid", "connect failed", { reason });
      }
      let handle: string;
      let name: string | null = null;
      if (connector === "bluesky") {
        const h = (input.inputs.identifier ?? "").replace(/^@/, "");
        handle = h.includes(".") ? h : `${h}.bsky.social`;
      } else if (connector === "telegram") {
        handle = (input.inputs.chatId ?? "channel").replace(/^@/, "");
        name = "Northwind Coffee updates";
      } else if (connector === "discord_bot") {
        handle = "Northwind Coffee Club";
      } else if (connector === "whatsapp") {
        handle = "+1 503 555 0177";
        name = "Northwind Coffee Wholesale";
      } else if (connector === "wechat") {
        handle = (input.inputs.originalId ?? "gh_000000000000").trim();
      } else if (connector === "line") {
        handle = "@northwindus";
        name = "Northwind Coffee US";
      } else {
        handle = "northwind-community";
        name = "#announcements";
      }
      const list = currentAccounts();
      if (list.some((a) => a.network === input.network && a.handle === handle && a.status === "active")) {
        throw new ApiError(409, "conflict", `That ${networkLabel(input.network)} account is already connected.`);
      }
      const existing = list.find((a) => a.network === input.network && a.handle === handle);
      if (existing) {
        existing.status = "active";
        existing.hasCredentials = true;
        save();
        return clone([existing]);
      }
      state.createdSeq += 1;
      const a = acct(`acc_${input.network}_${Date.now().toString(36)}_${state.createdSeq}`, input.network, handle, name ?? handle, connector, "active", null);
      list.push(a);
      save();
      return clone([a]);
    },

    accountMetrics: async (id: string, _metric: string): Promise<AccountMetrics> => {
      await delay(null, 200 + (id.length % 5) * 60);
      const latest = FOLLOWERS[id];
      if (latest === undefined) return { latest: {}, series: [] };
      const series = Array.from({ length: 30 }, (_, i) => ({ value: Math.round(latest * (0.93 + (0.07 * i) / 29)), observedAt: ago(24 * (29 - i)) }));
      return { latest: { followers_total: latest }, series };
    },

    media: async (): Promise<MediaAsset[]> => delay(mediaLibrary, 180),

    deleteMedia: async (id: string): Promise<void> => {
      await delay(null, 200);
      const idx = mediaLibrary.findIndex((m) => m.id === id);
      if (idx < 0) throw new ApiError(404, "not_found", "No such file.");
      mediaLibrary.splice(idx, 1);
    },

    reply: async (activityId: string, input: ReplyInput): Promise<PostDetail> => {
      await delay(null, 520);
      const item = state.feed.find((a) => a.id === activityId);
      if (!item) throw new ApiError(404, "not_found", "That item is gone.");
      const account = currentAccounts().find((a) => a.id === item.socialAccountId);
      if (!account) throw new ApiError(400, "invalid", "That item didn't come in through a connected account.");
      if (account.status !== "active") throw new ApiError(409, "conflict", `@${account.handle} needs reconnecting before it can reply.`);
      const decision = checkPolicy({ variants: [{ network: account.network, text: input.text }] });
      // Replies from people go out unless a red line says otherwise; a long reply goes to an approver in fixtures.
      const verdict = decision.verdict === "allow" && input.text.length > 240 ? "require_approval" : decision.verdict;
      const status: PostStatus = verdict === "block" ? "blocked" : verdict === "require_approval" ? "pending_approval" : "scheduled";
      state.createdSeq += 1;
      const id = `p_reply_${state.createdSeq}`;
      const now = iso(Date.now());
      const post: Post = {
        ...basePost,
        id,
        status,
        title: null,
        body: input.text,
        media: [],
        scheduledAt: status === "scheduled" ? now : null,
        actionClass: "reply",
        createdBy: currentMe().actor,
        trendTopicId: null,
        trendStageAtCreation: null,
        trendForecastId: null,
        disclosure: { aiAssisted: !!input.aiAssisted, humanReviewed: true },
        evidence: [{ kind: "activity", ref: activityId }],
        policyDecision: { ...decision, verdict },
        createdAt: now,
        updatedAt: now,
      };
      const item2: PostSummary = { post, variants: [variant(`${id}_v0`, id, account.id, account.network, input.text, { status: status === "blocked" ? "skipped" : "pending" })] };
      if (status === "pending_approval") state.queue.push(item2);
      else state.created.push(item2);
      return clone({ post, variants: item2.variants, approvals: approvalsFor(item2) });
    },

    moderate: async (activityId: string, action: ModerateAction): Promise<{ ok: boolean; action: ModerateAction }> => {
      await delay(null, 320);
      const idx = state.feed.findIndex((a) => a.id === activityId);
      if (idx < 0) throw new ApiError(404, "not_found", "That item is gone.");
      if (action === "delete") {
        if (currentWs().role !== "owner" && currentWs().role !== "approver") throw new ApiError(403, "forbidden", "Only owners and approvers can delete comments.");
        state.feed.splice(idx, 1);
      }
      return { ok: true, action };
    },
  };
}

// --- Links and conversions ---------------------------------------------------
// A handful of short links from published posts, about a month of clicks, and a few purchases in USD.

const LINK_BASE = "https://nwc.to";

interface LinkSpec {
  id: string;
  slug: string;
  destination: string;
  network: Network | null;
  postId: string | null;
  placement: LinkPlacement;
  daysAgo: number;
  people: number;
  previews: number;
  /** Purchase values, one per conversion. */
  sales: number[];
}

const LINK_SPECS: LinkSpec[] = [
  { id: "lnk_guji_x", slug: "guji", destination: "https://northwind.coffee/shop/ethiopia-guji", network: "x", postId: "p_cal_guji", placement: "text", daysAgo: 4, people: 412, previews: 38, sales: [24, 24, 48, 24] },
  { id: "lnk_sub_li", slug: "sub2w", destination: "https://northwind.coffee/subscribe?plan=two-weeks", network: "linkedin", postId: "p_cal_beans", placement: "first_comment", daysAgo: 9, people: 268, previews: 61, sales: [49, 49, 98] },
  { id: "lnk_ratio_bsky", slug: "ratio", destination: "https://northwind.coffee/journal/cold-brew-the-whole-recipe", network: "bluesky", postId: "p_ratio", placement: "thread", daysAgo: 16, people: 233, previews: 22, sales: [18] },
  { id: "lnk_cup_threads", slug: "cupping", destination: "https://northwind.coffee/events/saturday-cupping-pearl", network: "threads", postId: "p_cal_sat", placement: "text", daysAgo: 6, people: 141, previews: 17, sales: [] },
  { id: "lnk_whole_li", slug: "wholesale", destination: "https://northwind.coffee/wholesale", network: "linkedin", postId: "p_cal_wholesale", placement: "link", daysAgo: 12, people: 96, previews: 44, sales: [180] },
  { id: "lnk_guji_bsky", slug: "guji-b", destination: "https://northwind.coffee/shop/ethiopia-guji", network: "bluesky", postId: "p_cal_guji", placement: "text", daysAgo: 4, people: 88, previews: 9, sales: [24] },
  { id: "lnk_menu_x", slug: "fall-menu", destination: "https://northwind.coffee/menu/fall", network: "x", postId: "p_chai_iced", placement: "text", daysAgo: 22, people: 57, previews: 12, sales: [] },
  { id: "lnk_manual", slug: "gift", destination: "https://northwind.coffee/gift-cards", network: null, postId: null, placement: "manual", daysAgo: 2, people: 21, previews: 0, sales: [] },
];

function linkStatsOf(spec: LinkSpec): LinkStats {
  return {
    links: 1,
    clicks: Math.round(spec.people * 1.27),
    uniqueVisitors: spec.people,
    previews: spec.previews,
    conversions: spec.sales.length,
    conversionValue: spec.sales.reduce((a, b) => a + b, 0),
  };
}

function utmFor(network: string | null, campaign: string, medium: string): Record<string, string> {
  return { utm_source: network ?? "starsign", utm_medium: medium, utm_campaign: campaign };
}

function targetOf(destination: string, utm: Record<string, string>, on: boolean): string {
  if (!on) return destination;
  try {
    const u = new URL(destination);
    for (const [k, v] of Object.entries(utm)) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    return destination;
  }
}

const linkState = {
  settings: { enabled: true, utm: true, clickIds: true, defaultCampaign: "fall-2026", medium: "social" } as LinkSettings,
  links: LINK_SPECS.map((spec): TrackedLink => {
    const utm = utmFor(spec.network, spec.postId ? spec.postId.replace(/^p_(cal_)?/, "") : "fall-2026", "social");
    return {
      id: spec.id,
      slug: spec.slug,
      destination: spec.destination,
      target: targetOf(spec.destination, utm, true),
      postId: spec.postId,
      variantId: spec.postId ? `${spec.postId}_v0` : null,
      network: spec.network,
      placement: spec.placement,
      utm,
      createdAt: ago(24 * spec.daysAgo),
      disabledAt: null,
      shortUrl: `${LINK_BASE}/${spec.slug}`,
      stats: linkStatsOf(spec),
    };
  }),
  conversions: LINK_SPECS.flatMap((spec, i) =>
    spec.sales.map(
      (value, j): Conversion => ({
        id: `cv_${spec.slug}_${j}`,
        clickId: `ssc_${spec.slug}${j}${i}`,
        linkId: spec.id,
        variantId: spec.postId ? `${spec.postId}_v0` : null,
        network: spec.network,
        name: spec.id === "lnk_sub_li" ? "subscribe" : spec.id === "lnk_whole_li" ? "lead" : "purchase",
        value,
        currency: "USD",
        externalId: `order_${4100 + i * 10 + j}`,
        source: j % 2 ? "api" : "browser",
        occurredAt: ago(24 * Math.max(0.2, spec.daysAgo - 1 - j * 1.3)),
        createdAt: ago(24 * Math.max(0.2, spec.daysAgo - 1 - j * 1.3)),
      }),
    ),
  ),
  seq: 0,
};

/** Thirty days of clicks: a weekday rhythm, bumps the day after each link went out, a little noise. */
function clicksByDay(links: TrackedLink[], fromMs: number, toMs: number): { day: string; clicks: number }[] {
  const days: { day: string; clicks: number }[] = [];
  const start = new Date(fromMs);
  start.setUTCHours(0, 0, 0, 0);
  for (let t = start.getTime(); t <= toMs; t += DAY) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    let clicks = 18 + (dow === 0 || dow === 6 ? -6 : 4) + Math.round(5 * Math.sin(t / DAY));
    for (const l of links) {
      const age = (t - Date.parse(l.createdAt)) / DAY;
      if (age >= -1 && age < 8) clicks += Math.round(((l.stats?.clicks ?? 0) / 4) * Math.exp(-Math.max(0, age) / 1.6));
    }
    days.push({ day: d.toISOString().slice(0, 10), clicks: Math.max(0, clicks) });
  }
  return days;
}

function canChangeLinks(): boolean {
  const r = currentWs().role;
  return r === "owner" || r === "approver";
}

function linksApi() {
  return {
    linkReport: async (from?: string, to?: string): Promise<LinkReport> => {
      const toMs = to ? Date.parse(to) : Date.now();
      const fromMs = from ? Date.parse(from) : toMs - 29 * DAY;
      const live = linkState.links.filter((l) => !l.disabledAt);
      const sum = (k: keyof LinkStats) => live.reduce((n, l) => n + (l.stats?.[k] ?? 0), 0);
      const conversions = linkState.conversions.filter((c) => live.some((l) => l.id === c.linkId));
      const byNet = new Map<string | null, { network: string | null; clicks: number; uniqueVisitors: number; conversions: number; value: number }>();
      for (const l of live) {
        const row = byNet.get(l.network) ?? { network: l.network, clicks: 0, uniqueVisitors: 0, conversions: 0, value: 0 };
        row.clicks += l.stats?.clicks ?? 0;
        row.uniqueVisitors += l.stats?.uniqueVisitors ?? 0;
        row.conversions += l.stats?.conversions ?? 0;
        row.value += l.stats?.conversionValue ?? 0;
        byNet.set(l.network, row);
      }
      const value = sum("conversionValue");
      return delay({
        from: iso(fromMs),
        to: iso(toMs),
        configured: true,
        totals: {
          clicks: sum("clicks"),
          uniqueVisitors: sum("uniqueVisitors"),
          previews: sum("previews"),
          conversions: conversions.length,
          attributedConversions: conversions.filter((c) => c.linkId).length,
          conversionValue: value,
          valueByCurrency: value ? [{ currency: "USD", value }] : [],
        },
        byNetwork: [...byNet.values()].sort((a, b) => b.uniqueVisitors - a.uniqueVisitors),
        byDay: clicksByDay(live, fromMs, toMs),
        topLinks: live
          .slice()
          .sort((a, b) => (b.stats?.clicks ?? 0) - (a.stats?.clicks ?? 0))
          .map((l) => ({
            id: l.id,
            slug: l.slug,
            shortUrl: l.shortUrl,
            destination: l.destination,
            network: l.network,
            postId: l.postId,
            variantId: l.variantId,
            placement: l.placement,
            ...(l.stats ?? { links: 1, clicks: 0, uniqueVisitors: 0, previews: 0, conversions: 0, conversionValue: 0 }),
            clicksInRange: l.stats?.clicks ?? 0,
          })),
      }, 220);
    },

    links: async (limit: number): Promise<LinkList> =>
      delay({ baseUrl: LINK_BASE, settings: linkState.settings, links: linkState.links.filter((l) => !l.disabledAt).slice(0, limit) }),

    createLink: async (input: CreateLinkInput): Promise<TrackedLink> => {
      await delay(null, 300);
      requireSession();
      if (currentWs().role === "viewer") throw new ApiError(403, "forbidden", "Viewers can't make links.");
      const url = input.url.trim();
      if (!/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(url)) throw new ApiError(400, "invalid", "That isn't a full web address (https://…).");
      linkState.seq += 1;
      const slug = `m${(4242 + linkState.seq * 37).toString(36)}`;
      const campaign = input.campaign?.trim() || linkState.settings.defaultCampaign || "manual";
      const utm = utmFor(input.network ?? null, campaign, linkState.settings.medium);
      const link: TrackedLink = {
        id: `lnk_new_${linkState.seq}`,
        slug,
        destination: url,
        target: targetOf(url, utm, linkState.settings.utm),
        postId: null,
        variantId: null,
        network: input.network ?? null,
        placement: "manual",
        utm: linkState.settings.utm ? utm : {},
        createdAt: iso(Date.now()),
        disabledAt: null,
        shortUrl: `${LINK_BASE}/${slug}`,
        stats: { links: 1, clicks: 0, uniqueVisitors: 0, previews: 0, conversions: 0, conversionValue: 0 },
      };
      linkState.links.unshift(link);
      return clone(link);
    },

    disableLink: async (id: string): Promise<void> => {
      await delay(null, 240);
      requireSession();
      if (!canChangeLinks()) throw new ApiError(403, "forbidden", "Only owners and approvers can turn links off.");
      const link = linkState.links.find((l) => l.id === id && !l.disabledAt);
      if (!link) throw new ApiError(404, "not_found", "That link is already off.");
      link.disabledAt = iso(Date.now());
    },

    linkSettings: (): Promise<LinkSettingsResponse> => delay({ ...linkState.settings, baseUrl: LINK_BASE }),

    updateLinkSettings: async (input: LinkSettingsPatch): Promise<LinkSettingsResponse> => {
      await delay(null, 260);
      requireSession();
      if (currentWs().role !== "owner") throw new ApiError(403, "forbidden", "Only an owner can change link settings.");
      if (input.defaultCampaign !== undefined && input.defaultCampaign.length > 100) throw new ApiError(400, "invalid", "Keep the campaign under 100 characters.");
      const next: LinkSettings = { ...linkState.settings, ...input };
      if (input.defaultCampaign !== undefined && !input.defaultCampaign.trim()) delete next.defaultCampaign;
      linkState.settings = next;
      return clone({ ...next, baseUrl: LINK_BASE });
    },

    conversions: async (limit: number): Promise<Conversion[]> =>
      delay(linkState.conversions.slice().sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, limit)),
  };
}

// --- Languages ----------------------------------------------------------------

function languagesApi() {
  return {
    languages: async (): Promise<LanguagesInfo> => {
      const since = Date.now() - 30 * DAY;
      const counts = new Map<string | null, number>();
      for (const a of state.feed) {
        if (Date.parse(a.occurredAt) < since) continue;
        const l = a.lang ? primaryLanguage(a.lang) : null;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      const seen = [...counts.entries()].map(([lang, n]) => ({ lang, n })).sort((a, b) => b.n - a.n);
      return delay({ settings: state.languageSettings, seen, translationAvailable: true });
    },

    updateLanguageSettings: async (input: LanguageSettingsPatch): Promise<LanguageSettings> => {
      await delay(null, 260);
      requireSession();
      if (currentWs().role !== "owner") throw new ApiError(403, "forbidden", "Only an owner changes language settings.");
      if (input.home !== undefined && !LANG_CODE_RE.test(input.home)) throw new ApiError(400, "invalid", "Use a language code such as en, ja or pt-BR.");
      if (input.dailyLimit !== undefined && (!Number.isInteger(input.dailyLimit) || input.dailyLimit < 0 || input.dailyLimit > 100_000)) {
        throw new ApiError(400, "invalid", "The daily limit is a whole number from 0 to 100,000.");
      }
      state.languageSettings = { ...state.languageSettings, ...input };
      return clone(state.languageSettings);
    },

    translate: async (activityId: string): Promise<Activity> => {
      await delay(null, 900);
      const item = state.feed.find((a) => a.id === activityId);
      if (!item) throw new ApiError(404, "not_found", "That item is gone.");
      if (!item.text) throw new ApiError(400, "invalid", "This item has no text to translate.");
      item.translation = FIXTURE_TRANSLATIONS[item.id] ?? item.text;
      item.translationLang = state.languageSettings.home;
      item.translatedAt = iso(Date.now());
      return clone(item);
    },

    expandStream: async (streamId: string, languages: string[]): Promise<Stream> => {
      await delay(null, 1100);
      if (currentWs().role === "viewer") throw new ApiError(403, "forbidden", "Viewers can't change streams.");
      const stream = state.streams.find((s) => s.id === streamId);
      if (!stream) throw new ApiError(404, "not_found", "No such stream.");
      if (!stream.query.keywords.length) throw new ApiError(400, "invalid", "This stream has no keywords to translate.");
      const langs = [...new Set(languages.map(primaryLanguage))].slice(0, 12);
      if (!langs.length) throw new ApiError(400, "invalid", "Name at least one language.");
      const translations = { ...(stream.query.translations ?? {}) };
      for (const lang of langs) {
        const terms = [...new Set(stream.query.keywords.flatMap((k) => FIXTURE_TERMS[k.toLowerCase()]?.[lang] ?? []))];
        if (terms.length) translations[lang] = terms;
      }
      stream.query = { ...stream.query, translations };
      return clone(stream);
    },
  };
}

// --- The tracker ----------------------------------------------------------------
// Northwind as an agency would set it up: the own brand with its founder and an ambassador, two competitors, and a
// prospect brand with its founder. Mentions are matched against the fixture feed the way the server matches them;
// the report's numbers come from a deterministic daily series, so the 30-day view has shape.

const ENT_CREATED = ago(24 * 40);

function entity(e: Pick<Entity, "id" | "kind" | "name" | "relation"> & Partial<Entity>): Entity {
  return {
    workspaceId: workspace.id,
    role: null,
    parentId: null,
    aliases: [],
    handles: {},
    context: [],
    exclude: [],
    wikipedia: [],
    trendTopicId: null,
    notes: null,
    createdAt: ENT_CREATED,
    updatedAt: ENT_CREATED,
    archivedAt: null,
    ...e,
  };
}

const entitiesSeed: Entity[] = [
  entity({
    id: "ent_northwind",
    kind: "organization",
    name: "Northwind Coffee",
    role: "brand",
    relation: "own",
    aliases: ["Northwind", "Northwind Roasters", "ノースウィンド", "北风咖啡"],
    handles: { x: ["northwindcoffee"], bluesky: ["northwind.coffee"], instagram: ["northwindcoffee"], tiktok: ["northwind.coffee"], mastodon: ["northwind@mastodon.social"] },
    exclude: ["Northwind Traders", "Northwind Airlines"],
    trendTopicId: "tp_ent_northwind",
    notes: "Us. Count the Tokyo shop under the same name.",
  }),
  entity({
    id: "ent_ana",
    kind: "person",
    name: "Ana Ruiz",
    role: "founder",
    parentId: "ent_northwind",
    relation: "own",
    handles: { x: ["anaroasts"], instagram: ["ana.roasts"] },
    context: ["coffee", "roaster", "roasters", "Northwind", "Guji"],
  }),
  entity({
    id: "ent_jules",
    kind: "person",
    name: "Jules Park",
    role: "ambassador",
    parentId: "ent_northwind",
    relation: "own",
    aliases: ["jules sips"],
    handles: { tiktok: ["jules.sips"], instagram: ["jules.sips"] },
    notes: "Paid partnership through March. Posts need the #ad disclosure.",
  }),
  entity({
    id: "ent_bluebottle",
    kind: "organization",
    name: "Blue Bottle",
    role: "brand",
    relation: "competitor",
    aliases: ["Blue Bottle Coffee", "ブルーボトル", "블루보틀"],
    handles: { x: ["bluebottleroast"], instagram: ["bluebottle"] },
    context: ["coffee", "café", "latte", "espresso", "cold foam", "cold brew", "コーヒー", "커피", "라떼"],
    wikipedia: ["Blue_Bottle_Coffee"],
    trendTopicId: "tp_ent_bluebottle",
  }),
  entity({
    id: "ent_stumptown",
    kind: "organization",
    name: "Stumptown",
    role: "brand",
    relation: "competitor",
    aliases: ["Stumptown Coffee", "Stumptown Coffee Roasters"],
    handles: { x: ["stumptowncoffee"] },
    context: ["coffee", "espresso", "cold brew", "roaster", "latte"],
    wikipedia: ["Stumptown_Coffee_Roasters"],
    trendTopicId: "tp_ent_stumptown",
  }),
  entity({
    id: "ent_fern",
    kind: "organization",
    name: "Little Fern Tea",
    role: "brand",
    relation: "prospect",
    aliases: ["Little Fern"],
    handles: { instagram: ["littlefern.tea"], tiktok: ["littleferntea"] },
    notes: "Pitch meeting on the 18th. They want a café launch plan.",
  }),
  entity({
    id: "ent_priya",
    kind: "person",
    name: "Priya Nair",
    role: "founder",
    parentId: "ent_fern",
    relation: "prospect",
    handles: { instagram: ["priya.brews"] },
    context: ["tea", "matcha", "hojicha", "Little Fern"],
  }),
];

/** How each seeded name is talked about: mentions per day, who writes, and where. */
interface SeriesSpec {
  base: number;
  slope: number;
  seed: number;
  /** Days ago with a burst, and how big. */
  spikes: [number, number][];
  authored: number;
  people: number;
  sentiment: number;
  networks: [string, number][];
  languages: [string | null, number][];
}

const SERIES: Record<string, SeriesSpec> = {
  ent_northwind: {
    base: 30,
    slope: 0.35,
    seed: 1,
    spikes: [[0, 1.6], [1, 2.1]],
    authored: 0.09,
    people: 0.64,
    sentiment: 0.41,
    networks: [["x", 34], ["instagram", 22], ["bluesky", 14], ["news", 11], ["tiktok", 9], ["line", 6], ["reddit", 4]],
    languages: [["en", 70], ["ja", 15], ["es", 8], ["zh", 4], [null, 3]],
  },
  ent_ana: {
    base: 5,
    slope: 0.5,
    seed: 2,
    spikes: [[1, 2.4]],
    authored: 0.22,
    people: 0.8,
    sentiment: 0.58,
    networks: [["x", 45], ["news", 25], ["instagram", 20], ["linkedin", 10]],
    languages: [["en", 88], ["es", 12]],
  },
  ent_jules: {
    base: 8,
    slope: 0.2,
    seed: 3,
    spikes: [[3, 1.8]],
    authored: 0.18,
    people: 0.72,
    sentiment: 0.66,
    networks: [["tiktok", 62], ["instagram", 30], ["x", 8]],
    languages: [["en", 74], ["ja", 22], [null, 4]],
  },
  ent_bluebottle: {
    base: 24,
    slope: 0.05,
    seed: 4,
    spikes: [[0, 1.9]],
    authored: 0.05,
    people: 0.7,
    sentiment: 0.22,
    networks: [["instagram", 30], ["x", 28], ["news", 18], ["line", 12], ["bluesky", 7], ["reddit", 5]],
    languages: [["en", 52], ["ja", 33], ["ko", 9], ["zh", 6]],
  },
  ent_stumptown: {
    base: 13,
    slope: -0.25,
    seed: 5,
    spikes: [],
    authored: 0.04,
    people: 0.68,
    sentiment: 0.18,
    networks: [["x", 40], ["reddit", 30], ["instagram", 18], ["news", 12]],
    languages: [["en", 95], ["es", 5]],
  },
  ent_fern: {
    base: 4,
    slope: 0.6,
    seed: 6,
    spikes: [[2, 2.2]],
    authored: 0.25,
    people: 0.75,
    sentiment: 0.62,
    networks: [["instagram", 50], ["tiktok", 32], ["news", 18]],
    languages: [["en", 90], ["ja", 10]],
  },
  ent_priya: {
    base: 1.6,
    slope: 0.3,
    seed: 7,
    spikes: [],
    authored: 0.3,
    people: 0.85,
    sentiment: 0.7,
    networks: [["instagram", 70], ["x", 30]],
    languages: [["en", 100]],
  },
};

const trackerState = {
  /** Per workspace. Only the Northwind workspace starts with names; the others show the empty state. */
  entities: { [workspace.id]: clone(entitiesSeed) } as Record<string, Entity[]>,
  seq: 0,
};

function wsEntities(): Entity[] {
  const id = currentWs().id;
  trackerState.entities[id] ??= [];
  return trackerState.entities[id]!;
}

function familyOf(all: Entity[], rootId: string): string[] {
  const out = [rootId];
  for (let i = 0; i < out.length; i++) for (const e of all) if (e.parentId === out[i] && !out.includes(e.id)) out.push(e.id);
  return out;
}

const normHandle = (h: string) => h.replace(/^@/, "").toLowerCase();
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CJK = /[぀-ヿ㐀-鿿가-힯]/;

/** Whole words for Latin text; anywhere inside Chinese, Japanese and Korean, which don't space words. */
function findTerm(text: string, terms: string[]): string | null {
  const folded = text.normalize("NFKC").toLowerCase();
  for (const term of terms) {
    const t = term.normalize("NFKC").toLowerCase().trim();
    if (!t) continue;
    if (CJK.test(t) ? folded.includes(t) : new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(t)}(?![\\p{L}\\p{N}_])`, "u").test(folded)) return term;
  }
  return null;
}

/** The server's matching, in order: written by one of its handles; an @mention of one; its name or an alias. */
function matchFixtureEntity(e: Entity, a: Activity): { how: MentionHow; term: string } | null {
  const own = (e.handles[a.network] ?? []).map(normHandle);
  if (a.authorHandle && own.includes(normHandle(a.authorHandle))) return { how: "author", term: `@${normHandle(a.authorHandle)}` };
  const texts = [a.text, a.translation].filter((t): t is string => !!t);
  const ats = Object.values(e.handles).flat().map((h) => `@${normHandle(h ?? "")}`);
  for (const t of texts) {
    const lower = t.toLowerCase();
    const hit = ats.find((h) => new RegExp(`${escapeRe(h)}(?![\\w.@])`).test(lower) || new RegExp(`${escapeRe(h)}(?=[.]?(\\s|$))`).test(lower));
    if (hit) return { how: "handle", term: hit };
  }
  for (const t of texts) {
    const hit = findTerm(t, [e.name, ...e.aliases]);
    if (!hit) continue;
    if (e.exclude.length && texts.some((x) => findTerm(x, e.exclude))) return null;
    if (e.context.length && !texts.some((x) => findTerm(x, e.context))) continue;
    return { how: "name", term: hit };
  }
  return null;
}

function mentionsOf(entityIds: string[]): EntityMention[] {
  const all = wsEntities();
  const out: EntityMention[] = [];
  const seen = new Set<string>();
  for (const a of state.feed) {
    for (const id of entityIds) {
      const e = all.find((x) => x.id === id);
      if (!e) continue;
      const m = matchFixtureEntity(e, a);
      if (!m) continue;
      const key = `${id}:${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ mention: { id: `emn_${key}`, entityId: id, how: m.how, term: m.term, network: a.network, lang: a.lang ?? null, occurredAt: a.occurredAt }, activity: a });
    }
  }
  return out.sort((x, y) => Date.parse(y.mention.occurredAt) - Date.parse(x.mention.occurredAt));
}

function entityActivityIds(entityId: string, children: boolean): Set<string> {
  const ids = children ? familyOf(wsEntities(), entityId) : [entityId];
  return new Set(mentionsOf(ids).map((m) => m.activity.id));
}

/** Split `total` by weights so the parts add up exactly (largest remainder). */
function apportion<K>(total: number, weights: [K, number][]): { key: K; n: number }[] {
  const sum = weights.reduce((n, [, w]) => n + w, 0) || 1;
  const raw = weights.map(([key, w]) => ({ key, exact: (total * w) / sum }));
  const parts = raw.map((r) => ({ key: r.key, n: Math.floor(r.exact), rest: r.exact - Math.floor(r.exact) }));
  let left = total - parts.reduce((n, p) => n + p.n, 0);
  for (const p of [...parts].sort((a, b) => b.rest - a.rest)) {
    if (left <= 0) break;
    p.n += 1;
    left -= 1;
  }
  return parts.filter((p) => p.n > 0).map((p) => ({ key: p.key, n: p.n })).sort((a, b) => b.n - a.n);
}

/** Mentions per day for a seeded name, `daysAgo` days back (0 = today). */
function dailyRate(spec: SeriesSpec, daysAgo: number): number {
  const d = Math.floor((NOW - daysAgo * DAY) / DAY);
  const dow = new Date(NOW - daysAgo * DAY).getUTCDay();
  const weekday = dow === 0 || dow === 6 ? 0.78 : 1.06;
  const wave = 1 + 0.22 * Math.sin(d * 0.9 + spec.seed) + 0.1 * Math.sin(d * 2.3 + spec.seed * 3);
  const trend = 1 + spec.slope * ((30 - daysAgo) / 30 - 0.5);
  const spike = spec.spikes.find(([ago]) => ago === daysAgo)?.[1] ?? 1;
  return Math.max(0, spec.base * weekday * wave * trend * spike);
}

function reportRowFor(e: Entity, fromMs: number, toMs: number): Omit<EntityReportRow, "familyMentions" | "shareOfVoice" | "shareWithinParent"> {
  const tz = policy.timezone;
  const spec = SERIES[e.id];
  const days = new Map<string, number>();
  let mentions = 0;
  let authored = 0;
  let people = 0;
  let sentiment: number | null = null;
  let byNetwork: { network: string; n: number }[] = [];
  let byLanguage: { lang: string | null; n: number }[] = [];
  if (spec) {
    // Spread each day's mentions over its hours, so a 24-hour window takes the right share of two days.
    const exact = new Map<string, number>();
    for (let t = fromMs; t < toMs; t += HOUR) {
      const daysAgo = Math.max(0, Math.floor((NOW - t) / DAY));
      const k = dayKey(t, tz);
      exact.set(k, (exact.get(k) ?? 0) + dailyRate(spec, daysAgo) / 24);
    }
    for (const [k, v] of exact) {
      const n = Math.round(v);
      if (n > 0) days.set(k, n);
      mentions += n;
    }
    authored = Math.round(mentions * spec.authored);
    people = Math.round(mentions * spec.people);
    sentiment = mentions ? spec.sentiment : null;
    byNetwork = apportion(mentions, spec.networks).map((x) => ({ network: x.key, n: x.n }));
    byLanguage = apportion(mentions, spec.languages).map((x) => ({ lang: x.key, n: x.n }));
  } else {
    // Names added here: what matching finds in the stored feed (the server rescans 90 days on create).
    const rows = mentionsOf([e.id]).filter((m) => {
      const t = Date.parse(m.mention.occurredAt);
      return t >= fromMs && t <= toMs;
    });
    const others = rows.filter((m) => m.mention.how !== "author");
    mentions = others.length;
    authored = rows.length - others.length;
    people = new Set(others.map((m) => m.activity.authorHandle)).size;
    const scored = others.map((m) => m.activity.sentiment).filter((x): x is number => x !== null);
    sentiment = scored.length ? scored.reduce((n, x) => n + x, 0) / scored.length : null;
    const count = <K,>(key: (m: EntityMention) => K) => {
      const c = new Map<K, number>();
      for (const m of others) c.set(key(m), (c.get(key(m)) ?? 0) + 1);
      return [...c.entries()].sort((a, b) => b[1] - a[1]);
    };
    byNetwork = count((m) => m.mention.network).map(([network, n]) => ({ network, n }));
    byLanguage = count((m) => m.mention.lang).map(([lang, n]) => ({ lang, n }));
    for (const [k, n] of count((m) => dayKey(Date.parse(m.mention.occurredAt), tz))) days.set(k, n);
  }
  return {
    id: e.id,
    name: e.name,
    kind: e.kind,
    role: e.role,
    relation: e.relation,
    parentId: e.parentId,
    trendTopicId: e.trendTopicId,
    mentions,
    authored,
    people,
    sentiment,
    byNetwork,
    byLanguage,
    byDay: [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, n]) => ({ day, n })),
  };
}

const RELATIONS: EntityRelation[] = ["own", "client", "prospect", "competitor", "opponent", "watch"];

function requireTrackerEditor(): void {
  if (currentWs().role === "viewer") throw new ApiError(403, "forbidden", "Viewers can't change the tracker.");
}

function cleanTerms(xs: unknown, max: number, what: string): string[] {
  if (xs === undefined) return [];
  if (!Array.isArray(xs)) throw new ApiError(400, "invalid", `${what} must be a list.`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    const t = String(x).trim();
    if (!t) continue;
    if (t.length > 120) throw new ApiError(400, "invalid", `"${truncate(t, 30)}" is too long for ${what.toLowerCase()} (120 characters at most).`);
    const k = t.normalize("NFKC").toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  if (out.length > max) throw new ApiError(400, "invalid", `At most ${max} ${what.toLowerCase()}.`);
  return out;
}

function cleanHandles(h: EntityInput["handles"]): Entity["handles"] {
  const out: Entity["handles"] = {};
  for (const [net, list] of Object.entries(h ?? {})) {
    const clean = cleanTerms(list, 20, "Handles").map((x) => x.replace(/^@/, ""));
    if (clean.length) out[net as Network] = clean;
  }
  return out;
}

function checkParent(all: Entity[], parentId: string | undefined, selfId?: string): void {
  if (!parentId) return;
  const parent = all.find((e) => e.id === parentId && !e.archivedAt);
  if (!parent) throw new ApiError(404, "not_found", "That organisation isn't tracked anymore.");
  if (parent.kind !== "organization") throw new ApiError(400, "invalid", "a person or organisation can only belong to an organisation");
  let cursor: Entity | undefined = parent;
  for (let depth = 0; cursor && depth < 10; depth++) {
    if (cursor.id === selfId) throw new ApiError(400, "invalid", "that would make the organisation part of itself");
    cursor = cursor.parentId ? all.find((e) => e.id === cursor!.parentId) : undefined;
  }
}

/** A dormant radar topic for a newly tracked name; the forecast fills in as data arrives. */
function topicForEntity(name: string, keywords: string[]): string {
  trackerState.seq += 1;
  const spec: TopicSpec = {
    id: `tp_ent_new_${trackerState.seq}`,
    name,
    keywords,
    relevance: 1,
    stage: "dormant",
    confidence: 0.2,
    velocity: 0,
    hoursToPeak: null,
    sources: [{ source: "news", scale: 10 }],
    agreement: null,
    actedOn: 0,
    score: 0.05,
    window: null,
    seed: 20 + trackerState.seq,
  };
  TOPICS.push(spec);
  radar.push({ topic: { id: spec.id, workspaceId: currentWs().id, name, keywords, relevance: 1, createdAt: iso(Date.now()) }, forecast: forecastOf(spec), actedOn: 0, score: spec.score, window: null });
  return spec.id;
}

/** What the fixture "model" suggests, per seeded name; anything else gets a generic pair. */
const FIXTURE_ALIASES: Record<string, AliasSuggestions["aliases"]> = {
  ent_northwind: [
    { text: "노스윈드 커피", lang: "ko", why: "How Korean posts write the brand name" },
    { text: "Café Northwind", lang: "es", why: "Spanish posts often put café first" },
    { text: "北風", lang: "ja", why: "Kanji for “north wind”, used in some Japanese posts about the Shibuya shop" },
  ],
  ent_bluebottle: [
    { text: "ブルーボトルコーヒー", lang: "ja", why: "The full Japanese name, as on the shop signs" },
    { text: "蓝瓶", lang: "zh", why: "Short Chinese name; it also just means “blue bottle”" },
  ],
  ent_ana: [{ text: "アナ・ルイス", lang: "ja", why: "Her name in katakana, from the Shibuya opening coverage" }],
};
const FIXTURE_AMBIGUOUS: Record<string, string[]> = { ent_northwind: ["北風"], ent_bluebottle: ["蓝瓶"] };

function trackerApi() {
  return {
    entities: async (archived: boolean): Promise<Entity[]> =>
      delay(
        wsEntities()
          .filter((e) => archived || !e.archivedAt)
          .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
      ),

    createEntity: async (input: EntityInput): Promise<Entity> => {
      await delay(null, 420);
      requireSession();
      requireTrackerEditor();
      const all = wsEntities();
      if (input.kind !== "organization" && input.kind !== "person") throw new ApiError(400, "invalid", "kind must be organization or person");
      const name = (input.name ?? "").trim();
      if (!name) throw new ApiError(400, "invalid", "Give it a name.");
      if (name.length > 200) throw new ApiError(400, "invalid", "Keep the name under 200 characters.");
      if (input.relation && !RELATIONS.includes(input.relation)) throw new ApiError(400, "invalid", "That relation isn't one Starsign knows.");
      if (all.some((e) => !e.archivedAt && e.name.toLowerCase() === name.toLowerCase())) throw new ApiError(409, "conflict", `${name} is already tracked.`);
      checkParent(all, input.parentId || undefined);
      const aliases = cleanTerms(input.aliases, 60, "Aliases");
      const wikipedia = cleanTerms(input.wikipedia, 10, "Wikipedia articles");
      trackerState.seq += 1;
      const now = iso(Date.now());
      const e: Entity = {
        id: `ent_new_${trackerState.seq}`,
        workspaceId: currentWs().id,
        kind: input.kind,
        name,
        role: input.role?.trim() || null,
        parentId: input.parentId || null,
        relation: input.relation ?? "watch",
        aliases,
        handles: cleanHandles(input.handles),
        context: cleanTerms(input.context, 40, "Context words"),
        exclude: cleanTerms(input.exclude, 40, "Exclude words"),
        wikipedia,
        trendTopicId: input.trackTrend === false ? null : topicForEntity(name, [name, ...aliases.slice(0, 6), ...wikipedia.map((w) => `wiki:${w}`)]),
        notes: input.notes?.trim() || null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      all.push(e);
      return clone(e);
    },

    updateEntity: async (id: string, input: EntityPatch): Promise<Entity> => {
      await delay(null, 380);
      requireSession();
      requireTrackerEditor();
      const all = wsEntities();
      const e = all.find((x) => x.id === id && !x.archivedAt);
      if (!e) throw new ApiError(404, "not_found", "That name isn't tracked anymore.");
      if (input.name !== undefined && !input.name.trim()) throw new ApiError(400, "invalid", "Give it a name.");
      if (input.kind !== undefined && input.kind !== e.kind && input.kind === "person" && all.some((x) => x.parentId === e.id && !x.archivedAt)) {
        throw new ApiError(400, "invalid", "People belong to this organisation. Move them first.");
      }
      if (input.parentId !== undefined) checkParent(all, input.parentId || undefined, id);
      if (input.relation !== undefined && !RELATIONS.includes(input.relation)) throw new ApiError(400, "invalid", "That relation isn't one Starsign knows.");
      if (input.name !== undefined) e.name = input.name.trim();
      if (input.kind !== undefined) e.kind = input.kind;
      if (input.role !== undefined) e.role = input.role.trim() || null;
      if (input.parentId !== undefined) e.parentId = input.parentId || null;
      if (input.relation !== undefined) e.relation = input.relation;
      if (input.aliases !== undefined) e.aliases = cleanTerms(input.aliases, 60, "Aliases");
      if (input.handles !== undefined) e.handles = cleanHandles(input.handles);
      if (input.context !== undefined) e.context = cleanTerms(input.context, 40, "Context words");
      if (input.exclude !== undefined) e.exclude = cleanTerms(input.exclude, 40, "Exclude words");
      if (input.wikipedia !== undefined) e.wikipedia = cleanTerms(input.wikipedia, 10, "Wikipedia articles");
      if (input.notes !== undefined) e.notes = input.notes.trim() || null;
      e.updatedAt = iso(Date.now());
      const topic = e.trendTopicId ? radar.find((r) => r.topic.id === e.trendTopicId) : undefined;
      if (topic) topic.topic.name = e.name;
      return clone(e);
    },

    archiveEntity: async (id: string): Promise<void> => {
      await delay(null, 300);
      requireSession();
      requireTrackerEditor();
      const e = wsEntities().find((x) => x.id === id && !x.archivedAt);
      if (!e) throw new ApiError(404, "not_found", "That name isn't tracked anymore.");
      e.archivedAt = iso(Date.now());
    },

    entityReport: async (from?: string, to?: string): Promise<EntityReport> => {
      const toMs = to ? Date.parse(to) : Date.now();
      const fromMs = from ? Date.parse(from) : toMs - 7 * DAY;
      const live = wsEntities().filter((e) => !e.archivedAt);
      const rows = live.map((e) => reportRowFor(e, fromMs, toMs));
      const own = new Map(rows.map((r) => [r.id, r]));
      const withFamily = rows.map((r) => ({ ...r, familyMentions: familyOf(live, r.id).reduce((n, id) => n + (own.get(id)?.mentions ?? 0), 0) }));
      const byId = new Map(withFamily.map((r) => [r.id, r]));
      const share = (ids: string[], value: (id: string) => number) => {
        const total = ids.reduce((n, id) => n + value(id), 0);
        return new Map(ids.map((id) => [id, total ? Math.round((value(id) / total) * 1000) / 10 : 0]));
      };
      const top = share(
        withFamily.filter((r) => !r.parentId || !byId.has(r.parentId)).map((r) => r.id),
        (id) => byId.get(id)!.familyMentions,
      );
      const within = new Map<string, number>();
      for (const parent of withFamily) {
        for (const [id, v] of share(withFamily.filter((r) => r.parentId === parent.id).map((r) => r.id), (id) => byId.get(id)!.mentions)) within.set(id, v);
      }
      return delay(
        { from: iso(fromMs), to: iso(toMs), entities: withFamily.map((r) => ({ ...r, shareOfVoice: top.get(r.id) ?? null, shareWithinParent: within.get(r.id) ?? null })) },
        200,
      );
    },

    entityMentions: async (id: string, opts: { children?: boolean; limit?: number }): Promise<EntityMention[]> => {
      const all = wsEntities();
      if (!all.some((e) => e.id === id)) throw new ApiError(404, "not_found", "No such tracked name.");
      const ids = opts.children ? familyOf(all, id) : [id];
      return delay(mentionsOf(ids).slice(0, Math.min(opts.limit ?? 50, 500)), 180);
    },

    suggestAliases: async (id: string, languages?: string[]): Promise<AliasSuggestions> => {
      await delay(null, 1100);
      const e = wsEntities().find((x) => x.id === id);
      if (!e) throw new ApiError(404, "not_found", "No such tracked name.");
      const have = new Set([e.name, ...e.aliases].map((x) => x.normalize("NFKC").toLowerCase()));
      const generic: AliasSuggestions["aliases"] = [
        { text: `#${e.name.replace(/[^\p{L}\p{N}]+/gu, "")}`, lang: "en", why: "The hashtag people use for it" },
        { text: e.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""), lang: "en", why: "Written as one word in handles and replies" },
      ];
      const langs = languages?.length ? languages.map(primaryLanguage) : ["en", "ja", "es", "zh", "ko"];
      const aliases = (FIXTURE_ALIASES[e.id] ?? generic).filter((a) => langs.includes(primaryLanguage(a.lang)) && !have.has(a.text.normalize("NFKC").toLowerCase()));
      return clone({ languages: langs, aliases, ambiguous: FIXTURE_AMBIGUOUS[e.id] ?? [] });
    },
  };
}

// --- Settings: brand profile, policy versions, retries ------------------------

const ACTIONS = ["new_post", "reply", "dm", "repost", "campaign"] as const;
const LEVELS = ["suggest", "draft", "schedule_with_approval", "autopost"];

/** What the server's schema would refuse, in its words. */
function policyProblem(doc: Policy): string | null {
  for (const a of ACTIONS) if (doc.autonomy[a] && !LEVELS.includes(doc.autonomy[a]!)) return `autonomy ${a}: invalid value`;
  const ids = new Set<string>();
  for (const [i, r] of doc.redLines.entries()) {
    const at = `redLines ${i}`;
    if (!r.id || ids.has(r.id)) return `${at} id: must be unique`;
    ids.add(r.id);
    if (!["block", "require_approval", "warn"].includes(r.severity)) return `${at} severity: invalid value`;
    const list = (k: string) => Array.isArray(r[k]) && (r[k] as unknown[]).length > 0 && (r[k] as unknown[]).every((x) => typeof x === "string" && x.length > 0);
    const hour = (k: string) => Number.isInteger(r[k]) && (r[k] as number) >= 0 && (r[k] as number) <= 23;
    switch (r.kind) {
      case "forbidden_phrase":
        if (!list("phrases")) return `${at} phrases: Array must contain at least 1 element(s)`;
        break;
      case "forbidden_topic":
        if (!list("keywords")) return `${at} keywords: Array must contain at least 1 element(s)`;
        break;
      case "forbidden_claim":
        if (!list("patterns")) return `${at} patterns: Array must contain at least 1 element(s)`;
        break;
      case "no_competitor_mention":
        if (!list("competitors")) return `${at} competitors: Array must contain at least 1 element(s)`;
        break;
      case "network_restriction":
        if (!list("networks")) return `${at} networks: Array must contain at least 1 element(s)`;
        break;
      case "quiet_hours":
        if (!hour("startHour") || !hour("endHour")) return `${at} startHour: Number must be between 0 and 23`;
        if (typeof r.timezone !== "string" || !r.timezone) return `${at} timezone: Required`;
        break;
      case "required_disclosure":
        if (typeof r.requiredText !== "string" || !r.requiredText) return `${at} requiredText: String must contain at least 1 character(s)`;
        if (!["ai_assisted", "always", "paid"].includes(r.when as string)) return `${at} when: invalid value`;
        break;
      case "max_posts_per_day":
        if (!Number.isInteger(r.limit) || (r.limit as number) < 1) return `${at} limit: Number must be greater than 0`;
        break;
      case "custom_regex":
        if (typeof r.pattern !== "string" || !r.pattern) return `${at} pattern: String must contain at least 1 character(s)`;
        break;
      default:
        return `${at} kind: invalid discriminator value`;
    }
  }
  const caps = doc.spendCaps;
  if (caps && (!(caps.modelUsdMonthly >= 0) || !(caps.xReadsUsdMonthly >= 0))) return "spendCaps: Number must be greater than or equal to 0";
  return null;
}

const MAYA = { type: "human" as const, id: "usr_maya" };
const policyHistory: PolicyVersion[] = (() => {
  const v1: Policy = { ...clone(policy), version: 1, redLines: [], autonomy: { new_post: "draft", reply: "draft", dm: "suggest", repost: "draft", campaign: "suggest" } };
  const v2: Policy = { ...clone(policy), version: 2, redLines: clone(policy.redLines.slice(0, 3)), autonomy: v1.autonomy };
  const v3: Policy = clone(policy);
  const row = (doc: Policy, hoursAgo: number, by: PolicyVersion["createdBy"], active = false): PolicyVersion => ({
    id: `pol_${doc.version}`,
    workspaceId: workspace.id,
    version: doc.version,
    document: doc,
    active,
    createdBy: by,
    createdAt: ago(hoursAgo),
  });
  return [row(v3, 24 * 20, MAYA, true), row(v2, 24 * 60, MAYA), row(v1, 24 * 90, { type: "system", id: "starsign" })];
})();

const profiles: Record<string, Record<string, unknown>> = {};

function profileHere(): Record<string, unknown> {
  const id = currentWs().id;
  return id === workspace.id ? workspace.profile : (profiles[id] ??= {});
}

function settingsApi() {
  return {
    workspace: async (): Promise<Workspace> => {
      const me = currentMe();
      return delay({ ...me.workspace, profile: profileHere() });
    },

    updateProfile: async (profile: Record<string, unknown>): Promise<Workspace> => {
      await delay(null, 300);
      requireSession();
      if (!["owner", "approver", "editor"].includes(currentWs().role)) throw new ApiError(403, "forbidden", "requires one of: owner, approver, editor");
      const id = currentWs().id;
      if (id === workspace.id) workspace.profile = clone(profile);
      else profiles[id] = clone(profile);
      return clone({ ...currentMe().workspace, profile: profileHere() });
    },

    updatePolicy: async (doc: Policy): Promise<Policy> => {
      await delay(null, 340);
      requireSession();
      if (currentWs().role !== "owner") throw new ApiError(403, "forbidden", "requires one of: owner");
      const problem = policyProblem(doc);
      if (problem) {
        const [path, message] = problem.split(": ");
        throw new ApiError(400, "invalid", "Validation failed", [{ path: path!.split(" "), message }]);
      }
      const next: Policy = { ...clone(doc), version: policy.version + 1 };
      Object.assign(policy, next);
      for (const r of policyHistory) r.active = false;
      policyHistory.unshift({ id: `pol_${next.version}`, workspaceId: workspace.id, version: next.version, document: clone(next), active: true, createdBy: { type: "human", id: store.user.id }, createdAt: iso(Date.now()) });
      return clone(policy);
    },

    policyHistory: async (): Promise<PolicyVersion[]> => delay(policyHistory),

    retryPost: async (id: string): Promise<PostDetail> => {
      await delay(null, 420);
      requireSession();
      if (!["owner", "approver", "editor"].includes(currentWs().role)) throw new ApiError(403, "forbidden", "requires one of: owner, approver, editor");
      const item = allPosts().find((p) => p.post.id === id);
      if (!item) throw new ApiError(404, "not_found", "No such post.");
      const failed = item.variants.filter((v) => v.status === "failed");
      if (!["failed", "partially_published"].includes(item.post.status) || !failed.length) throw new ApiError(409, "conflict", "nothing failed on this post");
      for (const v of failed) {
        v.status = "publishing";
        v.error = null;
      }
      item.post.status = "publishing";
      item.post.updatedAt = iso(Date.now());
      // A moment later the network takes it.
      window.setTimeout(() => {
        const at = iso(Date.now());
        for (const v of failed) {
          v.status = "published";
          v.attemptCount += 1;
          v.publishedAt = at;
          v.externalUrl = v.network === "instagram" ? `https://www.instagram.com/p/${v.id}` : v.externalUrl;
        }
        item.post.status = "published";
        item.post.publishedAt ??= at;
        item.post.updatedAt = at;
      }, 2500);
      return clone({ post: item.post, variants: item.variants, approvals: approvalsFor(item) });
    },
  };
}

export const fixtureApi = {
  me: () => delay(currentMe()),
  policy: () => delay(policy),
  accounts: () => delay(currentAccounts()),
  streams: () => delay(state.streams),

  queue: () => delay(state.queue),

  post: async (id: string): Promise<PostFull> => {
    const found = allPosts().find((p) => p.post.id === id);
    if (!found) throw new ApiError(404, "not_found", "No such post.");
    return delay({ ...found, approvals: approvalsFor(found), history: historyFor(found) });
  },

  decide: async (id: string, input: DecideInput): Promise<PostDetail> => {
    await delay(null, 320);
    const idx = state.queue.findIndex((q) => q.post.id === id);
    const item = state.queue[idx];
    if (!item) throw new ApiError(404, "not_found", "That post isn't waiting anymore.");

    if (input.decision === "approve") {
      // Approving re-runs the red lines over the edited text, like the real gate does.
      const violations: Violation[] = [];
      for (const v of item.variants) {
        const text = input.edits?.[v.id] ?? v.text;
        for (const rule of BLOCKING) {
          const matches = text.match(rule.re);
          if (matches) violations.push({ redLineId: rule.id, kind: rule.kind, severity: "block", message: rule.message, matches });
        }
      }
      if (violations.length) {
        throw new ApiError(422, "policy_blocked", "The edit crosses a red line.", { verdict: "block", violations, policyVersion: 3 });
      }
      for (const v of item.variants) {
        const edited = input.edits?.[v.id];
        if (edited !== undefined) v.text = edited;
      }
      item.post.status = item.post.scheduledAt ? "scheduled" : "approved";
    } else if (input.decision === "reject") {
      item.post.status = "cancelled";
    } else {
      item.post.status = "draft";
    }
    item.post.updatedAt = iso(Date.now());
    state.queue.splice(idx, 1);
    state.decided.push(item);
    const approval: Approval = {
      id: `ap_${id}_d`,
      postId: id,
      state: input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "changes_requested",
      requestedBy: item.post.createdBy,
      decidedBy: me.actor,
      decidedAt: iso(Date.now()),
      note: input.note ?? null,
      createdAt: item.post.createdAt,
    };
    return clone({ post: item.post, variants: item.variants, approvals: [approval] });
  },

  radar: () => delay(radar),

  topic: async (id: string): Promise<TopicDetail> => {
    const spec = TOPICS.find((t) => t.id === id);
    const entry = radar.find((r) => r.topic.id === id);
    if (!spec || !entry) throw new ApiError(404, "not_found", "No such topic.");
    return delay({
      topic: entry.topic,
      forecast: entry.forecast,
      series: historySeries(spec.stage, spec.sources, spec.seed),
      actions: topicActions(id),
    });
  },

  feed: async (q: FeedQuery = {}): Promise<Activity[]> => {
    let items = state.feed.slice().sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    if (q.kinds?.length) items = items.filter((a) => q.kinds!.includes(a.kind));
    if (q.networks?.length) items = items.filter((a) => q.networks!.includes(a.network));
    if (q.stream) items = items.filter((a) => a.matchedStreams.includes(q.stream!));
    if (q.since) items = items.filter((a) => Date.parse(a.occurredAt) > Date.parse(q.since!));
    if (q.before) items = items.filter((a) => Date.parse(a.occurredAt) < Date.parse(q.before!));
    if (q.q) items = items.filter((a) => `${a.text ?? ""}\n${a.translation ?? ""}`.toLowerCase().includes(q.q!.toLowerCase()));
    if (q.languages?.length) items = items.filter((a) => !!a.lang && q.languages!.includes(primaryLanguage(a.lang)));
    if (q.conversation) items = items.filter((a) => a.conversationId === q.conversation);
    if (q.entity) {
      const ids = entityActivityIds(q.entity, !!q.children);
      items = items.filter((a) => ids.has(a.id));
    }
    return delay(items.slice(0, q.limit ?? 100));
  },

  summary: (_from: string, _to: string) => delay(summary),
  liftByStage: (_from: string, _to: string) => delay(liftByStage),

  alerts: () => delay(state.alerts.filter((a) => !a.acknowledgedAt)),
  ackAlert: async (id: string): Promise<void> => {
    await delay(null, 160);
    const a = state.alerts.find((x) => x.id === id);
    if (!a) throw new ApiError(404, "not_found", "No such alert.");
    a.acknowledgedAt = iso(Date.now());
  },

  latestBrief: () => delay(brief),

  // --- Compose, calendar, connect (v1.1) ---

  connectors: () => delay(connectorsSeed),

  deleteAccount: async (id: string): Promise<void> => {
    await delay(null, 260);
    const list = currentAccounts();
    const idx = list.findIndex((a) => a.id === id);
    if (idx < 0) throw new ApiError(404, "not_found", "No such account.");
    list.splice(idx, 1);
    save();
  },

  adapt: async (input: AdaptInput): Promise<AdaptResult> => {
    if (!input.body.trim()) throw new ApiError(400, "invalid", "Write the idea first.");
    const networks = [...new Set(input.networks)];
    const variants = networks.map((n) => adaptFor(n, input.body));
    const threaded = variants.filter((v) => v.thread.length && NETWORK_THREADS.has(v.network));
    const notes = [
      "Kept the voice plain: no exclamation marks, no hype.",
      threaded.length ? `Split into a thread where it ran long.` : null,
      networks.includes("instagram") ? "Instagram gets line breaks and two tags; it still needs an image." : null,
    ].filter((x): x is string => !!x);
    return delay({ variants, notes, usage: { costUsd: 0.0042, model: "claude-opus-5-5" } }, 700);
  },

  policyCheck: async (input: PolicyCheckInput): Promise<PolicyDecision> => delay(checkPolicy(input), 120),

  createPost: async (input: CreatePostInput): Promise<PostDetail> => {
    await delay(null, 380);
    const issues: { code: string; message: string; socialAccountId: string; network: string }[] = [];
    const targets = input.variants.map((v) => {
      const account = currentAccounts().find((a) => a.id === v.socialAccountId);
      if (!account) throw new ApiError(404, "not_found", "One of those accounts is gone.");
      if (account.status === "disabled") throw new ApiError(409, "conflict", `account ${account.handle} is disabled`);
      if (["instagram", "tiktok", "pinterest", "youtube"].includes(account.network) && !(v.media ?? []).length) {
        issues.push({ code: "media_required", message: `${account.network} requires at least one media item`, socialAccountId: account.id, network: account.network });
      }
      const o = v.options ?? {};
      if (["youtube", "reddit", "pinterest"].includes(account.network) && !o.title?.trim()) {
        issues.push({ code: "title_required", message: `${account.network} requires a title`, socialAccountId: account.id, network: account.network });
      }
      if (account.network === "reddit" && !o.subreddit) issues.push({ code: "subreddit_required", message: "reddit requires a subreddit", socialAccountId: account.id, network: account.network });
      if (account.network === "pinterest" && !o.boardId) issues.push({ code: "board_required", message: "pinterest requires a board", socialAccountId: account.id, network: account.network });
      if (account.network === "tiktok" && !o.privacy) issues.push({ code: "privacy_required", message: "tiktok requires a privacy level", socialAccountId: account.id, network: account.network });
      return { v, account };
    });
    if (issues.length) throw new ApiError(400, "invalid", "variant validation failed", issues);

    const decision = checkPolicy({
      variants: targets.map(({ v, account }) => ({ network: account.network, text: [v.text, ...(v.thread ?? [])].join("\n") })),
      scheduledAt: input.scheduledAt,
    });
    const status: PostStatus =
      decision.verdict === "block" ? "blocked" : decision.verdict === "require_approval" ? "pending_approval" : input.scheduledAt ? "scheduled" : "draft";
    state.createdSeq += 1;
    const id = `p_new_${state.createdSeq}`;
    const now = iso(Date.now());
    const item: PostSummary = {
      post: {
        ...basePost,
        id,
        status,
        title: input.title ?? null,
        body: input.body,
        media: input.media ?? [],
        scheduledAt: input.scheduledAt ?? null,
        actionClass: input.actionClass ?? "new_post",
        createdBy: me.actor,
        trendTopicId: input.trendTopicId ?? null,
        trendStageAtCreation: input.trendStageAtCreation ?? null,
        trendForecastId: input.trendForecastId ?? null,
        disclosure: input.disclosure ?? null,
        evidence: input.evidence ?? [],
        policyDecision: decision,
        createdAt: now,
        updatedAt: now,
      },
      variants: targets.map(({ v, account }, i) =>
        variant(`${id}_v${i}`, id, account.id, account.network, v.text, { media: v.media ?? [], thread: v.thread ?? [], status: status === "blocked" ? "skipped" : "pending" }),
      ),
    };
    if (status === "pending_approval") state.queue.push(item);
    else state.created.push(item);
    return clone({ post: item.post, variants: item.variants, approvals: approvalsFor(item) });
  },

  calendar: async (from: string, to: string): Promise<PostSummary[]> => {
    const lo = from ? Date.parse(from) : WEEK_START;
    const hi = to ? Date.parse(to) : WEEK_START + 14 * DAY;
    const seen = new Set<string>();
    const timeOf = (p: Post) => Date.parse(p.publishedAt ?? p.scheduledAt ?? "");
    const items = allPosts().filter((p) => {
      if (seen.has(p.post.id)) return false;
      seen.add(p.post.id);
      const t = timeOf(p.post);
      return CAL_STATUSES.includes(p.post.status) && Number.isFinite(t) && t >= lo && t < hi;
    });
    return delay(items.sort((a, b) => timeOf(a.post) - timeOf(b.post)));
  },

  sources: () => delay(sourcesSeed),
  discoveries: (limit: number) => delay(discoveriesSeed.slice(0, limit)),

  ...peopleApi(),
  ...integrationsApi(),
  ...linksApi(),
  ...languagesApi(),
  ...trackerApi(),
  ...settingsApi(),
};

/** A pretend live stream: one new mention arrives every 40 seconds. */
export function openFixtureStream(h: StreamHandlers): () => void {
  h.onStatus("live");
  const timer = window.setInterval(() => {
    const line = LIVE_LINES[state.liveIndex % LIVE_LINES.length];
    state.liveIndex += 1;
    if (!line) return;
    const id = `live_${state.liveIndex}`;
    const a = act(id, line.network, line.kind, line.handle, line.name, line.text, 0, line.matched, 0.2);
    state.feed.unshift(a);
    h.onEvent({ type: "activity", data: { workspaceId: workspace.id, id, network: a.network, kind: a.kind, matchedStreams: a.matchedStreams } });
  }, 40_000);
  return () => {
    window.clearInterval(timer);
    h.onStatus("off");
  };
}

// ---- inbox workflow: the shared inbox's fixture "server" lives in ./inboxFixtures.ts, over this feed and this team.
import { createInboxFixtures } from "./inboxFixtures";
export const inboxFixtureApi = createInboxFixtures({
  feed: () => state.feed,
  members: () => store.members,
  me: () => ({ userId: store.user.id, role: currentWs().role }),
  workspaceName: () => currentWs().name,
  accounts: () => currentAccounts(),
});
// ---- end inbox workflow

// ---- analytics & client reports: six months of history and two sample reports (./fixtures-analytics.ts).
import { createAnalyticsFixtures, sampleLogoDataUrl } from "./fixtures-analytics";
mediaLibrary.push(asset("med_logo", "image", "image/svg+xml", sampleLogoDataUrl(), "northwind-wordmark.svg", { width: 480, height: 120, bytes: 1_400, alt: "Northwind wordmark" }, 24 * 30));
export const analyticsFixtureApi = createAnalyticsFixtures({
  accounts: () => currentAccounts(),
  posts: () => allPosts(),
  media: () => mediaLibrary,
  role: () => currentWs().role,
  workspaceId: () => currentWs().id,
  workspaceName: () => currentWs().name,
  timezone: () => policy.timezone,
  linkReport: (from, to) => fixtureApi.linkReport(from, to),
  entityReport: (from, to) => fixtureApi.entityReport(from, to),
  calendar: (from, to) => fixtureApi.calendar(from, to),
});
// ---- end analytics & client reports

// ---- AI answer visibility: the fixture "server" lives in ./visibility-fixtures.ts, over this workspace's tracked names.
import { createVisibilityFixtures } from "./visibility-fixtures";
export const visibilityFixtureApi = createVisibilityFixtures({
  role: () => currentWs().role,
  entities: () => wsEntities(),
});
// ---- end AI answer visibility
