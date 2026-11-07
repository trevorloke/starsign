// Types mirroring docs/API.md (Starsign HTTP API v1). Kept hand-written so the web app
// has no build-time dependency on the server packages.

export type Network =
  | "x"
  | "bluesky"
  | "threads"
  | "instagram"
  | "facebook"
  | "linkedin"
  | "tiktok"
  | "youtube"
  | "pinterest"
  | "mastodon"
  | "reddit"
  | "google_business"
  | "telegram"
  | "discord"
  | "whatsapp"
  | "wechat"
  | "line"
  /** Listening only: news articles found by the tracker's public search. Never a publish target, never in Connections. */
  | "news"
  | "nostr"
  | "misskey"
  | "lemmy"
  | "tumblr"
  | "vk"
  | "twitch"
  | "slack"
  | "matrix"
  | "google_chat"
  | "teams"
  | "wordpress"
  | "ghost"
  | "mailchimp"
  | "kit"
  | "webhook"
  /** Listening only: feeds Starsign reads (blogs, news sites, podcasts). */
  | "rss"
  | "weibo"
  | "douyin"
  | "wecom"
  | "band"
  | "zalo"
  | "viber"
  | "ok";

export type ActorType = "human" | "operator" | "mcp" | "system";
export interface Actor {
  type: ActorType;
  id: string;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  profile: Record<string, unknown>;
  settings: Record<string, unknown>;
  createdAt: string;
}

export interface Me {
  workspace: Workspace;
  actor: Actor;
  role: string | null;
}

export interface Account {
  id: string;
  network: Network;
  externalId: string;
  handle: string;
  displayName: string | null;
  connector: string;
  status: "active" | "reauth_required" | "disabled";
  hasCredentials: boolean;
  lastIngestAt: string | null;
  config: Record<string, unknown>;
}

// --- Policy -------------------------------------------------------------

export type AutonomyLevel = "suggest" | "draft" | "schedule_with_approval" | "autopost";
export type ActionClass = "new_post" | "reply" | "dm" | "repost" | "campaign";
export type RedLineSeverity = "block" | "require_approval" | "warn";

export interface RedLine {
  id: string;
  kind: string;
  description: string;
  severity: RedLineSeverity;
  [extra: string]: unknown;
}

export type RedLineKind =
  | "forbidden_phrase"
  | "forbidden_topic"
  | "forbidden_claim"
  | "no_competitor_mention"
  | "quiet_hours"
  | "required_disclosure"
  | "max_posts_per_day"
  | "network_restriction"
  | "custom_regex";

/** Monthly ceilings, in USD. */
export interface SpendCaps {
  /** Metered X API reads. 0 turns X reads off. */
  xReadsUsdMonthly: number;
  /** Model spend for this workspace (adapting, translating, operators, briefs). */
  modelUsdMonthly: number;
}

export interface DisclosurePolicy {
  recordAlways: true;
  signMedia: boolean;
  visibleTextForAi: string;
}

export interface Policy {
  version: number;
  autonomy: Partial<Record<ActionClass, AutonomyLevel>>;
  requireApprovalForEditors: boolean;
  redLines: RedLine[];
  competitors: string[];
  timezone: string;
  /** Always present from the server; optional so older fixtures still type. */
  spendCaps?: SpendCaps;
  disclosure?: DisclosurePolicy;
}

/** GET /v1/policy/history: one row per version, newest first. */
export interface PolicyVersion {
  id: string;
  workspaceId: string;
  version: number;
  document: Policy;
  active: boolean;
  createdBy: Actor;
  createdAt: string;
}

/**
 * The conventional shape of `workspace.profile` (free-form JSON on the server). The Scout and the operators read
 * these fields; anything else in the profile is kept as it is.
 */
export interface BrandProfile {
  description?: string;
  audience?: string;
  topics?: string[];
  voice?: { do?: string[]; dont?: string[]; examples?: string[] };
  competitors?: string[];
  [extra: string]: unknown;
}

export interface Violation {
  redLineId: string;
  kind: string;
  severity: RedLineSeverity;
  message: string;
  matches: string[];
}

export interface PolicyDecision {
  verdict: "allow" | "require_approval" | "block";
  violations: Violation[];
  autonomy?: AutonomyLevel;
  policyVersion: number;
}

// --- Posts --------------------------------------------------------------

export type PostStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "scheduled"
  | "publishing"
  | "published"
  | "partially_published"
  | "failed"
  | "cancelled"
  | "blocked";

export type VariantStatus = "pending" | "publishing" | "published" | "failed" | "skipped";
export type TrendStage = "dormant" | "rising" | "peaking" | "plateau" | "fading";

export interface Media {
  kind: "image" | "video" | "gif" | "document";
  url: string;
  alt?: string;
  mime?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  bytes?: number;
  /** Starsign media library id when the file was uploaded here. */
  assetId?: string;
}

export interface Disclosure {
  aiAssisted: boolean;
  aiContributions?: string[];
  humanReviewed: boolean;
  reviewedBy?: string;
  model?: string;
  promptVersion?: string;
}

export interface Evidence {
  kind: string;
  ref: string;
  note?: string;
}

export interface Post {
  id: string;
  workspaceId: string;
  status: PostStatus;
  title: string | null;
  body: string;
  media: Media[];
  scheduledAt: string | null;
  publishedAt: string | null;
  actionClass: ActionClass | string;
  createdBy: Actor;
  trendTopicId: string | null;
  trendStageAtCreation: TrendStage | null;
  trendForecastId: string | null;
  experimentId: string | null;
  experimentArm: string | null;
  disclosure: Disclosure | null;
  evidence: Evidence[];
  policyDecision: PolicyDecision | null;
  createdAt: string;
  updatedAt: string;
}

export interface Variant {
  id: string;
  postId: string;
  socialAccountId: string;
  network: Network;
  text: string;
  media: Media[];
  thread: string[];
  status: VariantStatus;
  externalId: string | null;
  externalUrl: string | null;
  publishedAt: string | null;
  error: string | null;
  attemptCount: number;
}

export interface Approval {
  id: string;
  postId: string;
  state: "requested" | "approved" | "rejected" | "changes_requested";
  requestedBy: Actor | null;
  decidedBy: Actor | null;
  decidedAt: string | null;
  note: string | null;
  createdAt: string;
}

export interface PostSummary {
  post: Post;
  variants: Variant[];
}

export interface PostDetail extends PostSummary {
  approvals: Approval[];
}

export interface PostFull extends PostDetail {
  history: LedgerEvent[];
}

export interface DecideInput {
  decision: "approve" | "reject" | "request_changes";
  note?: string;
  edits?: Record<string, string>;
}

export interface LedgerEvent {
  id: string;
  seq: number;
  workspaceId: string;
  type: string;
  subjectType: string;
  subjectId: string;
  actor: Actor;
  data: Record<string, unknown>;
  occurredAt: string;
}

// --- Listening ----------------------------------------------------------

export type ActivityKind =
  | "own_post"
  | "reply"
  | "mention"
  | "comment"
  | "dm"
  | "repost"
  | "quote"
  | "like"
  | "follow"
  /** A message in a group chat, channel or server channel the account is part of. */
  | "message";

/** Where a chat message was said. "direct" is a one-to-one conversation with the business. */
export type ConversationType = "group" | "channel" | "direct";

export interface Activity {
  id: string;
  workspaceId: string;
  socialAccountId: string | null;
  network: Network;
  kind: ActivityKind;
  externalId: string;
  authorHandle: string | null;
  authorName: string | null;
  text: string | null;
  url: string | null;
  parentExternalId: string | null;
  occurredAt: string;
  ingestedAt: string;
  sentiment: number | null;
  matchedStreams: string[];
  rawEventId: string | null;
  // Chat and languages. Older servers omit these; treat a missing value like null.
  /** ISO 639-1 ("ja", "es"); null when the language is unknown. */
  lang?: string | null;
  conversationId?: string | null;
  /** "#general", "Acme Fans Tokyo". */
  conversationName?: string | null;
  conversationType?: ConversationType | null;
  /** The text in the team's language, once translated. */
  translation?: string | null;
  translationLang?: string | null;
  translatedAt?: string | null;
}

export interface StreamQuery {
  keywords: string[];
  authors: string[];
  networks: Network[];
  kinds: ActivityKind[];
  /** Only these languages (ISO 639-1). Empty or missing: every language. */
  languages?: string[];
  /** The keywords as people write them in other languages (lang → terms). Filled by "expand to languages". */
  translations?: Record<string, string[]>;
}

export interface Stream {
  id: string;
  name: string;
  query: StreamQuery;
  createdAt: string;
}

export interface FeedQuery {
  stream?: string;
  networks?: Network[];
  kinds?: ActivityKind[];
  account?: string;
  since?: string;
  before?: string;
  limit?: number;
  /** Searches the text and its translation. */
  q?: string;
  /** Only these languages (ISO 639-1). */
  languages?: string[];
  /** One conversation (conversationId). */
  conversation?: string;
  /** Only messages by or about this tracked entity. */
  entity?: string;
  /** With `entity`: include the people (and sub-brands) that belong to it. */
  children?: boolean;
}

// --- Languages ----------------------------------------------------------

/** GET/PATCH /v1/languages/settings */
export interface LanguageSettings {
  /** The team's language: what everything is translated into. */
  home: string;
  /** Translate new messages automatically. Off: only on demand from the feed. */
  autoTranslate: boolean;
  /** Most messages translated automatically per UTC day. */
  dailyLimit: number;
}

export type LanguageSettingsPatch = Partial<LanguageSettings>;

/** GET /v1/languages */
export interface LanguagesInfo {
  settings: LanguageSettings;
  /** The last 30 days, most common first. `lang` null = unknown. */
  seen: { lang: string | null; n: number }[];
  /** False when no model is configured on the server: detection and filtering still work, translation does not. */
  translationAvailable: boolean;
}

// --- Measurement --------------------------------------------------------

export interface Group {
  key: string;
  posts: number;
  impressions: number;
  engagements: number;
  avgEngagements: number;
}

export interface TopPost {
  postId: string;
  variantId: string;
  network: Network;
  text: string;
  impressions: number;
  engagements: number;
  lift: number;
}

export interface Summary {
  window: { from: string; to: string };
  publishedByNetwork: { network: Network; posts: number }[];
  measuredAt24h: number;
  totals: { impressions: number; engagements: number };
  baselineEngagements24h: number;
  byNetwork: Group[];
  byHour: Group[];
  byTrendStage: Group[];
  byAuthor: Group[];
  byExperiment: Group[];
  top: TopPost[];
}

export interface LiftByStage {
  stage: TrendStage;
  posts: number;
  avgEngagements: number;
  lift: number;
}

// --- Trends -------------------------------------------------------------

export interface ForecastPoint {
  at: string;
  value: number;
  lo: number;
  hi: number;
}

export interface Forecast {
  id: string;
  stage: TrendStage;
  /** 0..1 */
  confidence: number;
  velocity: number;
  hoursToPeak: number | null;
  computedAt: string;
  sources: string[];
  sourceAgreement: number | null;
  curve: ForecastPoint[];
}

export interface Topic {
  id: string;
  workspaceId: string | null;
  name: string;
  keywords: string[];
  relevance: number | null;
  createdAt?: string;
}

export interface RadarEntry {
  topic: Topic;
  forecast: Forecast | null;
  actedOn: number;
  score: number;
  window: string | null;
}

export interface SeriesPoint {
  t: string;
  v: number;
}

export interface TopicSeries {
  source: string;
  points: SeriesPoint[];
}

export interface TopicAction {
  postId: string;
  stageAtAction: TrendStage | null;
  forecastId: string | null;
  createdAt: string;
  outcome24h: Record<string, unknown> | null;
}

export interface TopicDetail {
  topic: Topic;
  forecast: Forecast | null;
  series: TopicSeries[];
  actions: TopicAction[];
}

// --- Operators' output --------------------------------------------------

export type AlertSeverity = "info" | "attention" | "urgent";

export interface Alert {
  id: string;
  kind: string;
  severity: AlertSeverity;
  title: string;
  body: string | null;
  evidence: unknown;
  topicId: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface Brief {
  id: string;
  periodStart: string;
  periodEnd: string;
  contentMd: string;
  evidence: unknown;
  runId: string | null;
  createdAt: string;
}

// --- Live stream (SSE) --------------------------------------------------

export type FeedEvent =
  | {
      type: "activity";
      /** `translated: true` when an item already in the feed just got its translation. */
      data: { workspaceId: string; id: string; network: Network; kind: ActivityKind; matchedStreams: string[]; lang?: string | null; translated?: boolean };
    }
  | { type: "post"; data: { workspaceId: string; postId: string; status: PostStatus } }
  | { type: "alert"; data: { workspaceId: string; id: string; title: string; severity: AlertSeverity } }
  | { type: "forecast"; data: { topicId: string; stage: TrendStage; confidence: number } }
  // ---- inbox workflow
  | { type: "inbox"; data: InboxLiveEvent };

export type LiveStatus = "live" | "connecting" | "off";

// --- Compose, calendar, connect (v1.1) -----------------------------------

export type ConnectMethod = "oauth" | "app_password" | "api_key" | "webhook_url" | "bot_token" | "none";

/** One field a person types before connecting (Mastodon server, Telegram bot token, Discord webhook URL…). */
export interface ConnectorInput {
  key: string;
  label: string;
  placeholder?: string;
  /** Shown masked. */
  secret?: boolean;
  /** May be left empty. */
  optional?: boolean;
}

/** What one connector can do on one network (v1.2). */
export interface NetworkCapabilities {
  publish: boolean;
  reply: boolean;
  moderate: boolean;
  accountMetrics: boolean;
  webhooks: boolean;
  video: boolean;
  kinds: string[];
  /**
   * Not in the v1.2 contract: when a server lists the moderation actions it supports, the room uses them
   * instead of its own per-network table.
   */
  moderateActions?: ModerateAction[];
}

/** GET /v1/connectors: which networks this deployment can connect, how, and what each can do. */
export interface Connector {
  name: string;
  networks: Network[];
  configured: boolean;
  connect: ConnectMethod;
  /** Older servers (v1.1) omit these two. */
  inputs?: ConnectorInput[];
  capabilities?: Partial<Record<Network, NetworkCapabilities>>;
}

export interface ConnectStartInput {
  network?: Network;
  inputs?: Record<string, string>;
}

export interface ConnectCredentialsInput {
  network: Network;
  inputs: Record<string, string>;
}

/** GET /v1/accounts/:id/metrics */
export interface AccountMetrics {
  latest: Record<string, number>;
  series: { value: number; observedAt: string }[];
}

/** POST /v1/accounts/connect/x/start: where to send the person's browser to authorize X. */
export interface OAuthStart {
  authorizeUrl: string;
  expiresAt: string;
}

export interface AdaptInput {
  body: string;
  networks: Network[];
  topicId?: string;
}

export interface AdaptedVariant {
  network: Network;
  text: string;
  thread: string[];
}

export interface AdaptResult {
  variants: AdaptedVariant[];
  /** The contract leaves the shape open; the room accepts a sentence or a list of them. */
  notes: string | string[] | null;
  usage: { costUsd: number; model: string };
}

export interface PolicyCheckInput {
  variants: { network: Network; text: string }[];
  scheduledAt?: string;
  actionClass?: ActionClass;
  disclosure?: Disclosure;
}

export type PostKind = "post" | "reel" | "story" | "carousel" | "video" | "short" | "pin" | "link" | "poll";
export type Privacy = "public" | "unlisted" | "private" | "followers" | "friends" | "self";
export type CallToAction = "BOOK" | "ORDER" | "SHOP" | "LEARN_MORE" | "SIGN_UP" | "CALL";
export type MastodonVisibility = "public" | "unlisted" | "private" | "direct";

/** Mirrors VariantOptions in packages/schema/src/networks.ts: each network reads what it understands. */
export interface VariantOptions {
  kind?: PostKind;
  title?: string;
  link?: string;
  privacy?: Privacy;
  boardId?: string;
  subreddit?: string;
  flairId?: string;
  firstComment?: string;
  tags?: string[];
  thumbnailUrl?: string;
  contentWarning?: string;
  brandedContent?: boolean;
  /** Not in VariantOptions yet: TikTok's "your brand" (brand_organic_toggle) disclosure. Servers that don't read it drop it. */
  brandOrganic?: boolean;
  callToAction?: CallToAction;
  allowComments?: boolean;
  allowDuet?: boolean;
  allowStitch?: boolean;
  visibility?: MastodonVisibility;
  poll?: { options: string[]; durationMinutes: number };
  /** Wrap this variant's links in Starsign short links with UTM tags. Omitted means on (when the server has a link base). */
  trackLinks?: boolean;
  /** utm_campaign for this variant's links. Default: the workspace's default campaign, else the post. */
  campaign?: string;
}

export interface CreateVariantInput {
  socialAccountId: string;
  text: string;
  media?: Media[];
  thread?: string[];
  options?: VariantOptions;
  replyToExternalId?: string;
}

export interface CreatePostInput {
  title?: string;
  body: string;
  media?: Media[];
  variants: CreateVariantInput[];
  scheduledAt?: string;
  actionClass?: ActionClass;
  trendTopicId?: string;
  trendStageAtCreation?: TrendStage;
  trendForecastId?: string;
  experimentId?: string;
  experimentArm?: string;
  disclosure?: Disclosure;
  evidence?: Evidence[];
  flags?: { paid?: boolean };
}

/** One per-variant problem from a 400 on POST /v1/posts (`details` is a list of these). */
export interface VariantIssue {
  code: string;
  message: string;
  segment?: number;
  socialAccountId?: string;
  network?: string;
}

/** GET /v1/sources: the trend sources this deployment pulls from. */
export interface TrendSource {
  name: string;
  kind: "sample" | "trending" | "both";
  configured: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  pointsLast24h: number;
}

/** GET /v1/trends/discoveries: raw "trending now" terms the scout saw. */
export interface Discovery {
  term: string;
  source: string;
  value: number | null;
  url: string | null;
  observedAt: string;
  region: string | null;
}

/** What the composer starts from when it opens from a topic. */
export interface ComposePrefill {
  body?: string;
  topicId?: string;
  topicName?: string;
  stage?: TrendStage;
  forecastId?: string;
}

// --- People, sign-in, teams (v1.2) --------------------------------------

export type Role = "owner" | "approver" | "editor" | "viewer";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface SessionWorkspace {
  id: string;
  slug: string;
  name: string;
  role: Role;
}

/** POST /v1/auth/login, /signup, /switch, /accept-invite and GET /v1/auth/session. */
export interface Session {
  user: SessionUser;
  workspaces: SessionWorkspace[];
  currentWorkspaceId: string;
}

export interface SignupInput {
  email: string;
  password: string;
  name: string;
  workspaceName: string;
  /** The new workspace's timezone (this browser's); schedules and quiet hours read in it. */
  timezone?: string;
}

export interface Member {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

/** POST /v1/invites. `emailed` is true only when the server actually sent the invite by email. */
export interface InviteCreated {
  inviteUrl: string;
  expiresAt: string;
  emailed: boolean;
}

/** GET /v1/invites/:token (no auth). */
export interface InviteInfo {
  workspaceName: string;
  email: string;
  role: Role;
  expiresAt: string;
  /** True when that email already has a Starsign account: accepting asks for its password, not a new one. */
  userExists: boolean;
}

/** GET /v1/invites (owners): invites not yet accepted, revoked or expired. */
export interface PendingInvite {
  id: string;
  email: string;
  role: Role;
  invitedBy: { id: string; name: string | null; email: string | null };
  expiresAt: string;
  createdAt: string;
}

export interface AcceptInviteInput {
  token: string;
  name?: string;
  password?: string;
}

// --- Media library, inbox actions (v1.2) ---------------------------------

/** One file in the workspace's media library (POST/GET /v1/media). */
export interface MediaAsset {
  id: string;
  url: string;
  kind: Media["kind"];
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  originalName?: string | null;
  alt?: string | null;
  createdAt?: string;
  media: Media;
}

export type ModerateAction = "hide" | "unhide" | "delete" | "like" | "unlike";

export interface ReplyInput {
  text: string;
  aiAssisted?: boolean;
}

// --- Links and conversions (v1.3) ------------------------------------------

/** Where in a post a wrapped link sat. "manual" is a link someone made by hand in the Links drawer. */
export type LinkPlacement = "text" | "thread" | "link" | "first_comment" | "manual";

export interface LinkSettings {
  /** Wrap links in published posts. */
  enabled: boolean;
  /** Add utm_source / utm_medium / utm_campaign to the destination. */
  utm: boolean;
  /** Append ssclid (the click id) to the landing URL so the site can report conversions. */
  clickIds: boolean;
  defaultCampaign?: string;
  medium: string;
}

export type LinkSettingsPatch = Partial<Pick<LinkSettings, "enabled" | "utm" | "clickIds" | "defaultCampaign" | "medium">>;

/** GET/PATCH /v1/links/settings */
export interface LinkSettingsResponse extends LinkSettings {
  baseUrl: string | null;
}

export interface LinkStats {
  links: number;
  clicks: number;
  uniqueVisitors: number;
  previews: number;
  conversions: number;
  conversionValue: number;
}

/** One short link (GET /v1/links, POST /v1/links). */
export interface TrackedLink {
  id: string;
  slug: string;
  destination: string;
  /** The destination with UTM tags, where the redirect sends people. */
  target: string;
  postId: string | null;
  variantId: string | null;
  network: string | null;
  placement: LinkPlacement;
  utm: Record<string, string>;
  createdAt: string;
  disabledAt: string | null;
  shortUrl: string | null;
  stats?: LinkStats;
}

/** GET /v1/links */
export interface LinkList {
  baseUrl: string | null;
  settings: LinkSettings;
  links: TrackedLink[];
}

export interface CreateLinkInput {
  url: string;
  network?: string;
  campaign?: string;
}

export interface LinkReportTop {
  id: string;
  slug: string;
  shortUrl: string | null;
  destination: string;
  network: string | null;
  postId: string | null;
  variantId: string | null;
  placement: LinkPlacement;
  links: number;
  clicks: number;
  uniqueVisitors: number;
  previews: number;
  conversions: number;
  conversionValue: number;
  clicksInRange: number;
}

/** GET /v1/links/report: clicks, people and conversions over a range (default the last 30 days). */
export interface LinkReport {
  from: string;
  to: string;
  /** False when the server has no short-link base: nothing is wrapped. */
  configured: boolean;
  totals: {
    clicks: number;
    uniqueVisitors: number;
    previews: number;
    conversions: number;
    attributedConversions: number;
    conversionValue: number;
    valueByCurrency: { currency: string | null; value: number }[];
  };
  byNetwork: { network: string | null; clicks: number; uniqueVisitors: number; conversions: number; value: number }[];
  byDay: { day: string; clicks: number }[];
  topLinks: LinkReportTop[];
}

/** GET /v1/conversions */
export interface Conversion {
  id: string;
  clickId: string | null;
  linkId: string | null;
  variantId: string | null;
  network: string | null;
  name: string;
  value: number | null;
  currency: string | null;
  externalId: string | null;
  source: "api" | "browser";
  occurredAt: string;
  createdAt: string;
}

// --- The tracker: parties, brands and people (v1.4) ------------------------

export type EntityKind = "organization" | "person";
export type EntityRelation = "own" | "client" | "prospect" | "competitor" | "opponent" | "watch";

/** GET /v1/entities: an organisation (party, brand, company) or a person (candidate, founder, creator) the team follows. */
export interface Entity {
  id: string;
  workspaceId: string;
  kind: EntityKind;
  name: string;
  /** In the team's words: party, brand, candidate, founder… */
  role: string | null;
  /** The organisation it belongs to. */
  parentId: string | null;
  relation: EntityRelation;
  /** Other ways it is written: other languages and scripts, nicknames, abbreviations. */
  aliases: string[];
  /** Its own accounts per network (without the @). */
  handles: Partial<Record<Network, string[]>>;
  /** A name match counts only when one of these words is nearby. */
  context: string[];
  /** Never count a match when one of these appears. */
  exclude: string[];
  /** Wikipedia article titles, for the momentum forecast. */
  wikipedia: string[];
  trendTopicId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** POST /v1/entities. PATCH takes any subset; "" clears `role`, `parentId` and `notes`. */
export interface EntityInput {
  kind: EntityKind;
  name: string;
  role?: string;
  parentId?: string;
  relation?: EntityRelation;
  aliases?: string[];
  handles?: Partial<Record<Network, string[]>>;
  context?: string[];
  exclude?: string[];
  wikipedia?: string[];
  /** Create only: forecast its momentum on the radar (default true). */
  trackTrend?: boolean;
  notes?: string;
}

export type EntityPatch = Partial<Omit<EntityInput, "trackTrend">>;

/** One entity in GET /v1/entities/report. Mentions exclude messages written by the entity itself (`authored`). */
export interface EntityReportRow {
  id: string;
  name: string;
  kind: EntityKind;
  role: string | null;
  relation: EntityRelation;
  parentId: string | null;
  trendTopicId: string | null;
  mentions: number;
  authored: number;
  /** Distinct people talking about it. */
  people: number;
  /** -1..1, null without scored messages. */
  sentiment: number | null;
  /** Its mentions plus those of everyone who belongs to it. */
  familyMentions: number;
  byNetwork: { network: string; n: number }[];
  byLanguage: { lang: string | null; n: number }[];
  /** Only days with mentions, in the workspace's time zone. */
  byDay: { day: string; n: number }[];
  /** Percent among top-level entities (by familyMentions); null for entities that belong to another. */
  shareOfVoice: number | null;
  /** Percent among an organisation's people; null at the top level. */
  shareWithinParent: number | null;
}

export interface EntityReport {
  from: string;
  to: string;
  entities: EntityReportRow[];
}

export type MentionHow = "name" | "handle" | "author";

/** GET /v1/entities/:id/mentions */
export interface EntityMention {
  mention: { id: string; entityId?: string; how: MentionHow; term: string; network: string; lang: string | null; occurredAt: string };
  activity: Activity;
}

/** POST /v1/entities/:id/suggest-aliases: suggestions only, nothing is saved. */
export interface AliasSuggestions {
  languages: string[];
  aliases: { text: string; lang: string; why: string }[];
  /** Names that also mean something else: worth context words. */
  ambiguous: string[];
}

// ---- inbox workflow ---------------------------------------------------------------------------

export type InboxStatus = "open" | "pending" | "done" | "spam";
export type InboxPriority = "normal" | "high" | "urgent";
export type InboxSort = "newest" | "oldest" | "due" | "priority";
/** none: no target applies; met / missed: answered; ok / soon / overdue: waiting on the team. */
export type SlaState = "none" | "met" | "missed" | "ok" | "soon" | "overdue";

export interface InboxSla {
  dueAt: string | null;
  state: SlaState;
  /** Until due; negative when overdue. Null unless waiting. */
  msLeft: number | null;
  targetMinutes: number;
}

export interface InboxItemState {
  status: InboxStatus;
  /** A member's user id. */
  assignee: string | null;
  priority: InboxPriority;
  tags: string[];
  firstResponseAt: string | null;
  doneAt: string | null;
  snoozedUntil: string | null;
  slaDueAt: string | null;
  lastActivityAt: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** One conversation in the queue: its first message (whose id is the item's id) and the newest one. */
export interface InboxEntry {
  activity: Activity;
  latest: Activity | null;
  state: InboxItemState;
  sla: InboxSla;
  notes: number;
}

export interface InboxCounts {
  open: number;
  pending: number;
  done: number;
  spam: number;
  /** Open or pending, assigned to the person asking. */
  mine: number;
  /** Open with nobody on it. */
  unassigned: number;
  snoozed: number;
}

export interface InboxViewer {
  userId: string | null;
  canWork: boolean;
  canAssign: boolean;
  canManage: boolean;
}

/** GET /v1/inbox */
export interface InboxList {
  items: InboxEntry[];
  counts: InboxCounts;
  viewer: InboxViewer;
}

export interface InboxQuery {
  status?: InboxStatus[];
  /** "me", "none", or a user id. */
  assignee?: string;
  tag?: string;
  priority?: InboxPriority[];
  network?: Network[];
  q?: string;
  sort?: InboxSort;
  snoozed?: boolean;
  limit?: number;
}

export interface InboxPatch {
  status?: InboxStatus;
  /** A user id, "me", or null to unassign. */
  assignee?: string | null;
  priority?: InboxPriority;
  tags?: string[];
  addTags?: string[];
  removeTags?: string[];
  snoozedUntil?: string | null;
}

export interface InboxNote {
  id: string;
  workspaceId: string;
  threadId: string;
  author: Actor;
  text: string;
  /** User ids. */
  mentions: string[];
  createdAt: string;
  editedAt: string | null;
}

/** A reply the team sent (or is sending) in this conversation. */
export interface InboxReply {
  postId: string;
  status: PostStatus;
  text: string;
  replyTo: string | null;
  network: string;
  createdAt: string;
  createdBy: Actor;
  publishedAt: string | null;
}

/** GET /v1/inbox/:activityId */
export interface InboxConversation {
  item: InboxEntry;
  messages: Activity[];
  /** The post the conversation answers, when it is in the feed (usually the brand's own). */
  parent: Activity | null;
  replies: InboxReply[];
  notes: InboxNote[];
}

export interface SavedReply {
  id: string;
  workspaceId: string;
  name: string;
  text: string;
  lang: string | null;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
}

export interface SavedReplyInput {
  name: string;
  text: string;
  lang?: string | null;
}

export type InboxTagColor = "gray" | "blue" | "green" | "amber" | "red" | "violet";
export interface InboxTag {
  name: string;
  color: InboxTagColor;
}

export interface InboxBusinessHours {
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  start: string;
  end: string;
}

/** GET /v1/inbox/settings */
export interface InboxSettings {
  /** First-response targets in minutes. */
  sla: Record<InboxPriority, number>;
  businessHours: InboxBusinessHours;
  tags: InboxTag[];
  timezone: string;
}

export interface InboxSettingsPatch {
  sla?: Partial<Record<InboxPriority, number>>;
  businessHours?: Partial<InboxBusinessHours>;
  tags?: InboxTag[];
}

export interface InboxRuleConditions {
  streams: string[];
  entities: string[];
  networks: string[];
  kinds: string[];
  languages: string[];
  keywords: string[];
}

export interface InboxRuleActions {
  assignee?: string | null;
  roundRobin?: string[];
  tags?: string[];
  priority?: InboxPriority;
  spam?: boolean;
}

export interface InboxRule {
  id: string;
  workspaceId: string;
  name: string;
  position: number;
  enabled: boolean;
  conditions: InboxRuleConditions;
  actions: InboxRuleActions;
  rrCursor: number;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
}

export interface InboxRuleInput {
  name: string;
  enabled?: boolean;
  conditions?: Partial<InboxRuleConditions>;
  actions: InboxRuleActions;
}

/** SSE "inbox": something changed in the shared inbox. `userIds` on "assigned" and "mention" say who to tell. */
export interface InboxLiveEvent {
  workspaceId: string;
  kind: "new" | "updated" | "assigned" | "mention" | "note" | "settings";
  ids?: string[];
  userIds?: string[];
  noteId?: string;
}
// ---- end inbox workflow
