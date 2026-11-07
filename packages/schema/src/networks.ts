import { z } from "zod";

/** Every network Starsign can observe or publish to. Open protocols first-class. */
export const Network = z.enum([
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
  /** Listening only: news articles found by the tracker's public search. Nothing publishes to it. */
  "news",
  // Open networks, team chat, blogs and newsletters, streaming, and the universal connectors.
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
  "rss",
  // Community platforms: Chinese, Korean, Vietnamese, Russian-speaking and other diaspora audiences.
  "weibo",
  "douyin",
  "wecom",
  "band",
  "zalo",
  "viber",
  "ok",
]);
export type Network = z.infer<typeof Network>;

/** Networks Starsign only listens to (nothing can be published there). */
export const LISTEN_ONLY_NETWORKS: ReadonlySet<Network> = new Set<Network>(["news", "rss"]);

/** Hard publishing limits per network. Soft limits (engagement cliffs) live in the ledger, learned. */
export interface NetworkLimits {
  /** Max characters (graphemes for Bluesky) in a primary text body. */
  maxText: number;
  /** Max media attachments on one post. */
  maxMedia: number;
  /** Networks that cannot publish text-only posts. */
  requiresMedia: boolean;
  /** Whether the network supports native threads/carousels. */
  supportsThread: boolean;
  /** Approx. max video seconds for an organic post, if relevant. */
  maxVideoSeconds?: number;
}

export const NETWORK_LIMITS: Record<Network, NetworkLimits> = {
  x: { maxText: 280, maxMedia: 4, requiresMedia: false, supportsThread: true, maxVideoSeconds: 140 },
  bluesky: { maxText: 300, maxMedia: 4, requiresMedia: false, supportsThread: true, maxVideoSeconds: 180 },
  threads: { maxText: 500, maxMedia: 20, requiresMedia: false, supportsThread: true, maxVideoSeconds: 300 },
  instagram: { maxText: 2200, maxMedia: 10, requiresMedia: true, supportsThread: true, maxVideoSeconds: 900 },
  facebook: { maxText: 63206, maxMedia: 10, requiresMedia: false, supportsThread: false },
  linkedin: { maxText: 3000, maxMedia: 20, requiresMedia: false, supportsThread: false, maxVideoSeconds: 900 },
  tiktok: { maxText: 4000, maxMedia: 35, requiresMedia: true, supportsThread: false, maxVideoSeconds: 600 },
  youtube: { maxText: 5000, maxMedia: 1, requiresMedia: true, supportsThread: false },
  pinterest: { maxText: 800, maxMedia: 5, requiresMedia: true, supportsThread: false, maxVideoSeconds: 900 },
  mastodon: { maxText: 500, maxMedia: 4, requiresMedia: false, supportsThread: true },
  reddit: { maxText: 40000, maxMedia: 20, requiresMedia: false, supportsThread: false, maxVideoSeconds: 900 },
  google_business: { maxText: 1500, maxMedia: 1, requiresMedia: false, supportsThread: false, maxVideoSeconds: 30 },
  telegram: { maxText: 4096, maxMedia: 10, requiresMedia: false, supportsThread: false },
  discord: { maxText: 2000, maxMedia: 10, requiresMedia: false, supportsThread: false },
  // TODO(verify): chat apps' limits — WhatsApp text 4096, WeChat customer-service text ~2048 bytes, LINE text 5000.
  whatsapp: { maxText: 4096, maxMedia: 1, requiresMedia: false, supportsThread: false },
  wechat: { maxText: 20000, maxMedia: 20, requiresMedia: true, supportsThread: false }, // one article (图文): cover image required
  line: { maxText: 5000, maxMedia: 5, requiresMedia: false, supportsThread: false },
  news: { maxText: 0, maxMedia: 0, requiresMedia: false, supportsThread: false },
  // TODO(verify): limits below are conservative readings of each platform's documented maxima; connectors validate precisely.
  nostr: { maxText: 10000, maxMedia: 4, requiresMedia: false, supportsThread: true },
  misskey: { maxText: 3000, maxMedia: 16, requiresMedia: false, supportsThread: true },
  lemmy: { maxText: 10000, maxMedia: 1, requiresMedia: false, supportsThread: false },
  tumblr: { maxText: 10000, maxMedia: 10, requiresMedia: false, supportsThread: false },
  vk: { maxText: 15000, maxMedia: 10, requiresMedia: false, supportsThread: false },
  twitch: { maxText: 500, maxMedia: 0, requiresMedia: false, supportsThread: false },
  slack: { maxText: 40000, maxMedia: 10, requiresMedia: false, supportsThread: false },
  matrix: { maxText: 30000, maxMedia: 1, requiresMedia: false, supportsThread: false },
  google_chat: { maxText: 32000, maxMedia: 0, requiresMedia: false, supportsThread: false },
  teams: { maxText: 28000, maxMedia: 1, requiresMedia: false, supportsThread: false },
  wordpress: { maxText: 100000, maxMedia: 20, requiresMedia: false, supportsThread: false },
  ghost: { maxText: 100000, maxMedia: 20, requiresMedia: false, supportsThread: false },
  mailchimp: { maxText: 100000, maxMedia: 10, requiresMedia: false, supportsThread: false },
  kit: { maxText: 100000, maxMedia: 10, requiresMedia: false, supportsThread: false },
  webhook: { maxText: 100000, maxMedia: 10, requiresMedia: false, supportsThread: false },
  rss: { maxText: 0, maxMedia: 0, requiresMedia: false, supportsThread: false },
  // TODO(verify): community platforms' limits, as documented by each; connectors validate precisely.
  weibo: { maxText: 2000, maxMedia: 9, requiresMedia: false, supportsThread: false },
  douyin: { maxText: 1000, maxMedia: 1, requiresMedia: true, supportsThread: false },
  wecom: { maxText: 2048, maxMedia: 1, requiresMedia: false, supportsThread: false },
  band: { maxText: 10000, maxMedia: 10, requiresMedia: false, supportsThread: false },
  zalo: { maxText: 2000, maxMedia: 1, requiresMedia: false, supportsThread: false },
  viber: { maxText: 7000, maxMedia: 1, requiresMedia: false, supportsThread: false },
  ok: { maxText: 10000, maxMedia: 10, requiresMedia: false, supportsThread: false },
};

/**
 * Per-variant publishing options. Each network reads the fields it understands and ignores the rest.
 * Kept in one open object so the composer, the API and agents share one shape.
 */
export const PostKind = z.enum(["post", "reel", "story", "carousel", "video", "short", "pin", "link", "poll"]);
export type PostKind = z.infer<typeof PostKind>;

export const VariantOptions = z
  .object({
    /** What to publish as. Default "post"; networks map it (instagram reel/story/carousel, youtube short/video, pinterest pin). */
    kind: PostKind.optional(),
    /** Title: YouTube, Reddit, Pinterest, LinkedIn articles. */
    title: z.string().max(300).optional(),
    /** Destination link: Pinterest, Reddit link posts, Facebook/LinkedIn link shares, Google Business call to action. */
    link: z.string().url().optional(),
    /** YouTube / TikTok privacy. TikTok's allowed values come from the creator info query at post time. */
    privacy: z.enum(["public", "unlisted", "private", "followers", "friends", "self"]).optional(),
    /** Pinterest board id. */
    boardId: z.string().optional(),
    /** Reddit subreddit name without r/. */
    subreddit: z.string().regex(/^[A-Za-z0-9_]{2,21}$/).optional(),
    /** Reddit flair id. */
    flairId: z.string().optional(),
    /** Posted as the first comment right after the post (Instagram, Facebook, LinkedIn, YouTube, Reddit). */
    firstComment: z.string().max(2200).optional(),
    /** Hashtags/tags where a network has a separate field (YouTube tags, TikTok handled in caption). */
    tags: z.array(z.string().max(100)).max(30).optional(),
    /** Cover/thumbnail image URL for video. */
    thumbnailUrl: z.string().url().optional(),
    /** Mark as adult content (Reddit NSFW). */
    nsfw: z.boolean().optional(),
    /** Content warning / spoiler (Mastodon, Reddit spoiler). */
    contentWarning: z.string().max(500).optional(),
    /** Disclose as branded/paid content where the network requires it (TikTok, Instagram, YouTube). */
    brandedContent: z.boolean().optional(),
    /** Google Business call to action. */
    callToAction: z.enum(["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"]).optional(),
    /** TikTok: allow comments, duets, stitches (must match creator settings). */
    allowComments: z.boolean().optional(),
    allowDuet: z.boolean().optional(),
    allowStitch: z.boolean().optional(),
    /** Mastodon visibility. */
    visibility: z.enum(["public", "unlisted", "private", "direct"]).optional(),
    /** Google Business Profile event/offer details (topicType, event dates, offer coupon/terms); validated by the connector. */
    googleBusiness: z.record(z.string(), z.unknown()).optional(),
    /** Poll (Mastodon, Telegram, X): options and duration. */
    /** Wrap links in Starsign short links with UTM tags (default: on when link tracking is configured). */
    trackLinks: z.boolean().optional(),
    /** utm_campaign for this variant's links. Default: the workspace's default campaign, else the post. */
    campaign: z.string().max(100).optional(),
    poll: z.object({ options: z.array(z.string().max(100)).min(2).max(10), durationMinutes: z.number().int().min(5).max(10080) }).optional(),
  })
  .partial();
export type VariantOptions = z.infer<typeof VariantOptions>;
