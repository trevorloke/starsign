import type {
  ActionClass,
  ActivityKind,
  Actor,
  AlertSeverity,
  AutonomyLevel,
  Network,
  PostStatus,
  RedLineSeverity,
  TrendStage,
  VariantStatus,
} from "../types";

// Their words, not ours. Every label a strategist reads comes from here.

export const STAGE_LABEL: Record<TrendStage, string> = {
  rising: "Rising",
  peaking: "Peaking",
  plateau: "Plateau",
  fading: "Fading",
  dormant: "Dormant",
};

export const STAGE_HINT: Record<TrendStage, string> = {
  rising: "gaining attention",
  peaking: "at or near the top",
  plateau: "holding steady",
  fading: "losing attention",
  dormant: "quiet",
};

export const NETWORK_LABEL: Record<Network, string> = {
  x: "X",
  bluesky: "Bluesky",
  threads: "Threads",
  instagram: "Instagram",
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
  nostr: "Nostr",
  misskey: "Misskey",
  lemmy: "Lemmy",
  tumblr: "Tumblr",
  vk: "VK",
  twitch: "Twitch",
  slack: "Slack",
  matrix: "Matrix",
  google_chat: "Google Chat",
  teams: "Microsoft Teams",
  wordpress: "WordPress",
  ghost: "Ghost",
  mailchimp: "Mailchimp",
  kit: "Kit",
  webhook: "Custom webhook",
  rss: "RSS / Atom",
  weibo: "Weibo",
  douyin: "Douyin",
  wecom: "WeCom",
  band: "Naver Band",
  zalo: "Zalo",
  viber: "Viber",
  ok: "OK.ru",
};

/**
 * Every network an account can be connected on, in the order the room lists them. "news" is not here: it is
 * listening only (articles found by public search), with no connector and nothing to publish to.
 */
export const NETWORKS: Network[] = [
  "x",
  "bluesky",
  "threads",
  "instagram",
  "facebook",
  "linkedin",
  "tiktok",
  "youtube",
  "pinterest",
  "mastodon",
  "reddit",
  "google_business",
  "telegram",
  "discord",
  "whatsapp",
  "wechat",
  "line",
  "nostr",
  "misskey",
  "lemmy",
  "tumblr",
  "vk",
  "twitch",
  "slack",
  "matrix",
  "google_chat",
  "teams",
  "wordpress",
  "ghost",
  "mailchimp",
  "kit",
  "webhook",
  "weibo",
  "douyin",
  "wecom",
  "band",
  "zalo",
  "viber",
  "ok",
];

/** Hard text limits per network, for the inline editor's counter. */
export const NETWORK_MAX_TEXT: Record<Network, number> = {
  x: 280,
  bluesky: 300,
  threads: 500,
  instagram: 2200,
  facebook: 63206,
  linkedin: 3000,
  tiktok: 4000,
  youtube: 5000,
  pinterest: 500,
  mastodon: 500,
  reddit: 40000,
  google_business: 1500,
  telegram: 4096,
  discord: 2000,
  whatsapp: 4096,
  wechat: 20000,
  line: 5000,
  news: 0,
  nostr: 10000,
  misskey: 3000,
  lemmy: 10000,
  tumblr: 10000,
  vk: 15000,
  twitch: 500,
  slack: 40000,
  matrix: 30000,
  google_chat: 32000,
  teams: 28000,
  wordpress: 100000,
  ghost: 100000,
  mailchimp: 100000,
  kit: 100000,
  webhook: 100000,
  rss: 0,
  weibo: 2000,
  douyin: 1000,
  wecom: 2048,
  band: 10000,
  zalo: 2000,
  viber: 7000,
  ok: 10000,
};

/** Networks where one post can continue as a thread of replies. */
export const NETWORK_THREADS: ReadonlySet<Network> = new Set<Network>(["x", "bluesky", "threads", "mastodon", "nostr", "misskey"]);

/** Networks that refuse a post without an image or video. */
export const NETWORK_NEEDS_MEDIA: ReadonlySet<Network> = new Set<Network>(["instagram", "tiktok", "pinterest", "youtube", "douyin", "wechat"]);

/** Most attachments a single post can carry. */
export const NETWORK_MAX_MEDIA: Record<Network, number> = {
  x: 4,
  bluesky: 4,
  threads: 20,
  instagram: 10,
  facebook: 10,
  linkedin: 20,
  tiktok: 35,
  youtube: 1,
  pinterest: 1,
  mastodon: 4,
  reddit: 20,
  google_business: 1,
  telegram: 10,
  discord: 10,
  whatsapp: 1,
  wechat: 20,
  line: 5,
  news: 0,
  nostr: 4,
  misskey: 16,
  lemmy: 1,
  tumblr: 10,
  vk: 10,
  twitch: 0,
  slack: 10,
  matrix: 1,
  google_chat: 0,
  teams: 1,
  wordpress: 20,
  ghost: 20,
  mailchimp: 10,
  kit: 10,
  webhook: 10,
  rss: 0,
  weibo: 9,
  douyin: 1,
  wecom: 1,
  band: 10,
  zalo: 1,
  viber: 1,
  ok: 10,
};

/** Approximate longest organic video, in seconds, where a network caps it. */
export const NETWORK_MAX_VIDEO_SECONDS: Partial<Record<Network, number>> = {
  x: 140,
  bluesky: 180,
  threads: 300,
  instagram: 900,
  linkedin: 900,
  tiktok: 600,
  reddit: 900,
  google_business: 30,
};

export const ROLE_LABEL: Record<"owner" | "approver" | "editor" | "viewer", string> = {
  owner: "Owner",
  approver: "Approver",
  editor: "Editor",
  viewer: "Viewer",
};

export const ROLE_HINT: Record<"owner" | "approver" | "editor" | "viewer", string> = {
  owner: "everything, including the team and red lines",
  approver: "approves posts and connects accounts",
  editor: "writes and schedules posts",
  viewer: "reads the room",
};

export function roleLabel(role: string | null | undefined): string {
  return role ? ((ROLE_LABEL as Record<string, string>)[role] ?? role) : "";
}

export const POST_KIND_LABEL: Record<string, string> = {
  post: "Post",
  reel: "Reel",
  story: "Story",
  carousel: "Carousel",
  video: "Video",
  short: "Short",
  pin: "Pin",
  link: "Link",
  poll: "Poll",
};

export function postKindLabel(kind: string): string {
  return POST_KIND_LABEL[kind] ?? kind.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** 734 → "12:14", 3725 → "1:02:05" */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** 2_400_000 → "2.4 MB" */
export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

/** "Facebook", "Facebook and Instagram", "X, Bluesky and Threads" */
export function listOf(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

const URL_RE = /https?:\/\/[^\s]+/gi;
const graphemes = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** Characters as each network counts them: X weighs links as 23 and emoji/CJK as 2; Bluesky counts graphemes. */
export function textLength(network: Network, s: string): number {
  if (network === "x") {
    const urls = s.match(URL_RE)?.length ?? 0;
    let n = 0;
    for (const ch of s.replace(URL_RE, "")) {
      const cp = ch.codePointAt(0) ?? 0;
      const heavy =
        (cp >= 0x1100 && cp <= 0x11ff) ||
        (cp >= 0x2600 && cp <= 0x27bf) ||
        (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7af) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe4f) ||
        (cp >= 0xff00 && cp <= 0xffef) ||
        cp >= 0x1f000;
      n += heavy ? 2 : 1;
    }
    return n + urls * 23;
  }
  if (network === "bluesky" && graphemes) {
    let n = 0;
    for (const _ of graphemes.segment(s)) n++;
    return n;
  }
  return [...s].length;
}

export const ACCOUNT_STATUS_LABEL: Record<"active" | "reauth_required" | "disabled", string> = {
  active: "Connected",
  reauth_required: "Needs reconnecting",
  disabled: "Disconnected",
};

/**
 * An account's handle as people read it: "@northwindcoffee". Handles that already carry their own prefix ("@northwindjp"
 * on LINE, "+1 503 555 0142" on WhatsApp), names with spaces (a Discord server) and WeChat ids ("gh_…") stay as they are.
 */
export function atHandle(handle: string, network?: string): string {
  if (/^[@+]/.test(handle) || /\s/.test(handle) || network === "wechat") return handle;
  return `@${handle}`;
}

/**
 * The author's handle on a feed item, or null when there is nothing a person could read: LINE and WeChat give opaque
 * ids, WhatsApp gives a phone number.
 */
export function authorHandleText(network: string, handle: string | null | undefined): string | null {
  if (!handle) return null;
  // News items carry the site's domain as the author, already shown as the name.
  if (network === "line" || network === "wechat" || network === "news") return null;
  if (network === "whatsapp") return /^\d{6,15}$/.test(handle) ? `+${handle}` : handle;
  return atHandle(handle, network);
}

export function networkLabel(network: string): string {
  return (NETWORK_LABEL as Record<string, string>)[network] ?? network;
}

export const POST_STATUS_LABEL: Record<PostStatus, string> = {
  draft: "Draft",
  pending_approval: "Waiting on you",
  approved: "Approved",
  scheduled: "Scheduled",
  publishing: "Going out",
  published: "Went out",
  partially_published: "Partly went out",
  failed: "Failed",
  cancelled: "Cancelled",
  blocked: "Blocked by a red line",
};

export const VARIANT_STATUS_LABEL: Record<VariantStatus, string> = {
  pending: "Waiting",
  publishing: "Going out",
  published: "Went out",
  failed: "Failed",
  skipped: "Skipped",
};

export const AUTONOMY_LABEL: Record<AutonomyLevel, string> = {
  suggest: "Suggest only",
  draft: "Draft only",
  schedule_with_approval: "Approval required",
  autopost: "Posts on its own",
};

export const ACTION_CLASS_LABEL: Record<ActionClass, string> = {
  new_post: "New posts",
  reply: "Replies",
  dm: "DMs",
  repost: "Reposts",
  campaign: "Campaigns",
};

export const ACTION_CLASS_ORDER: ActionClass[] = ["new_post", "reply", "dm", "repost", "campaign"];

export const SEVERITY_LABEL: Record<RedLineSeverity, string> = {
  block: "Blocks",
  require_approval: "Needs approval",
  warn: "Warns",
};

export const ALERT_SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: "FYI",
  attention: "Attention",
  urgent: "Urgent",
};

export const KIND_LABEL: Record<ActivityKind, string> = {
  own_post: "Post",
  reply: "Reply",
  mention: "Mention",
  comment: "Comment",
  dm: "DM",
  repost: "Repost",
  quote: "Quote",
  like: "Like",
  follow: "Follow",
  message: "Message",
};

export function kindLabel(kind: string): string {
  return (KIND_LABEL as Record<string, string>)[kind] ?? kind;
}

/** "Operator · watch", "MCP agent · claude-desktop", "Human · marta", "System". */
export function actorLabel(actor: Actor | null | undefined, people?: ReadonlyMap<string, string>): string {
  if (!actor) return "Unknown";
  switch (actor.type) {
    case "human":
      return people?.get(actor.id) ?? `Human · ${actor.id}`;
    case "operator":
      return `Operator · ${actor.id}`;
    case "mcp":
      return `MCP agent · ${actor.id}`;
    case "system":
      return "System";
    default:
      return `${actor.type} · ${actor.id}`;
  }
}

/** For sentences: "Approved by marta", "Created by the watch operator", "…by an MCP agent (claude-desktop)". */
export function actorPhrase(actor: Actor | null | undefined, people?: ReadonlyMap<string, string>): string {
  if (!actor) return "someone";
  switch (actor.type) {
    case "human":
      return people?.get(actor.id) ?? actor.id;
    case "operator":
      return `the ${actor.id} operator`;
    case "mcp":
      return `an MCP agent (${actor.id})`;
    case "system":
      return "Starsign";
    default:
      return actor.id;
  }
}

export const ACTION_CLASS_SINGULAR: Record<ActionClass, string> = {
  new_post: "New post",
  reply: "Reply",
  dm: "DM",
  repost: "Repost",
  campaign: "Campaign",
};

export function actionClassLabel(cls: string): string {
  return (ACTION_CLASS_SINGULAR as Record<string, string>)[cls] ?? cls.replace(/_/g, " ");
}

const SOURCE_LABEL: Record<string, string> = {
  google_trends: "Google Trends",
  google_trends_rss: "Google Trends, trending now",
  youtube_trending: "YouTube trending",
  bluesky_firehose: "Bluesky firehose",
  bluesky_search: "Bluesky",
  hacker_news: "Hacker News",
  wikipedia_pageviews: "Wikipedia pageviews",
  reddit: "Reddit",
  x: "X",
  tiktok_creative_center: "TikTok Creative Center",
  news: "News",
  own_feed: "Your feed",
  ai_answers: "AI answers",
  manual: "Manual",
};

/** "[linkedin] Naming a competitor…" → "LinkedIn: Naming a competitor…" (the server prefixes the network key). */
export function violationText(message: string): string {
  const m = message.match(/^\[([a-z_]+)\]\s*(.*)$/s);
  if (!m) return message;
  return `${networkLabel(m[1]!)}: ${m[2]}`;
}

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source.replace(/_/g, " ");
}

/** 0.78 → "78%" */
export function pct(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${Math.round(x * 100)}%`;
}

/** 12400 → "12.4k", 1_200_000 → "1.2M" */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

/** 3.08 → "3.1x" */
export function lift(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${x.toFixed(1)}x`;
}

/** Velocity 0.14 → "+14%/h" */
export function perHour(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const p = Math.round(v * 100);
  return `${p > 0 ? "+" : ""}${p}%/h`;
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…`;
}

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** "Mentions · 41 in 3h" style evidence kinds → readable words. */
export function evidenceKindLabel(kind: string): string {
  return kind.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

// --- The tracker -------------------------------------------------------------

export const RELATION_LABEL: Record<"own" | "client" | "prospect" | "competitor" | "opponent" | "watch", string> = {
  own: "Own",
  client: "Client",
  prospect: "Prospect",
  competitor: "Competitor",
  opponent: "Opponent",
  watch: "Watching",
};

export const RELATION_HINT: Record<"own" | "client" | "prospect" | "competitor" | "opponent" | "watch", string> = {
  own: "us, or one of our people",
  client: "someone we work for",
  prospect: "someone we're pitching",
  competitor: "a rival brand",
  opponent: "the other side in a race",
  watch: "just keeping an eye on it",
};

export const RELATION_ORDER = ["own", "client", "prospect", "competitor", "opponent", "watch"] as const;

/** Offered in the role field; anything else can be typed. */
export const ENTITY_ROLE_SUGGESTIONS = ["party", "brand", "company", "candidate", "spokesperson", "founder", "creator", "ambassador"];

export function entityKindLabel(kind: string): string {
  return kind === "organization" ? "Organisation" : kind === "person" ? "Person" : kind;
}

/** 41.2 → "41%", 4.25 → "4.3%" (already a percent, not a fraction). */
export function percent(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return x >= 10 || Number.isInteger(x) ? `${Math.round(x)}%` : `${x.toFixed(1)}%`;
}
