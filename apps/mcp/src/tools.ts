/**
 * The MCP tools: Starsign's front door for agents.
 * Agents can see the radar, the feed, the queue, the ledger and the red lines, and propose posts.
 * They cannot approve, publish, change policy or connect accounts: humans do that in the app.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ActionClass, ActivityKind, LedgerEventType, Network, PostStatus, Timestamp, TrendStage, type Disclosure } from "@starsign/schema";
import { StarsignApiError, type StarsignClient } from "./client.ts";
import * as fmt from "./format.ts";
import type { CreatePostBody } from "./types.ts";

export const TOOL_NAMES = [
  "get_brand_context",
  "get_radar",
  "get_topic",
  "search_feed",
  "get_queue",
  "get_post",
  "list_posts",
  "get_metrics_summary",
  "get_lift_by_stage",
  "check_policy",
  "create_post",
  "schedule_post",
  "cancel_post",
  "get_latest_brief",
  "list_alerts",
  "get_policy",
  "get_ledger",
  "get_calendar",
  "get_sources",
  "get_discoveries",
  "list_experiments",
  "get_experiment",
  "create_experiment",
  "get_link_report",
  "create_link",
  "list_tracked",
  "get_tracker_report",
  "track_entity",
  // ---- inbox workflow
  "list_inbox",
  "update_inbox_item",
  // ---- AI answer visibility
  "get_ai_visibility",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Recorded on every post this server creates. Humans review in the app; `humanReviewed` flips there. */
export const MCP_MODEL_LABEL = "mcp-client";

export interface ToolContext {
  client: StarsignClient;
  now: () => Date;
}

// ---- input schemas (zod v4 raw shapes; the SDK turns them into JSON Schema) --------------------

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const variantForCheck = z.object({
  network: Network.describe("Network the text is meant for"),
  text: z.string().min(1).describe("Full text including any thread segments joined by newlines"),
});

export const inputs = {
  get_topic: {
    topicId: z.string().min(1).describe("Topic id, as listed by get_radar or get_brand_context"),
  },
  search_feed: {
    q: z.string().min(1).optional().describe("Free-text search over the activity text"),
    networks: z.array(Network).optional().describe("Only these networks"),
    kinds: z.array(ActivityKind).optional().describe("Only these activity kinds (mention, reply, comment, dm, repost, quote, own_post, like, follow)"),
    streamId: z.string().min(1).optional().describe("Only activity matching this saved stream (see the app)"),
    sinceHours: z.number().positive().max(24 * 90).optional().describe("Only activity from the last N hours"),
    limit: z.number().int().min(1).max(200).default(50).describe("Max items (default 50)"),
  },
  get_post: {
    postId: z.string().min(1).describe("Post id, e.g. from get_queue or create_post"),
  },
  list_posts: {
    status: z.array(PostStatus).optional().describe("Only these statuses; default all"),
    limit: z.number().int().min(1).max(200).default(20).describe("Max posts (default 20)"),
  },
  get_metrics_summary: {
    days: z.number().int().min(1).max(365).default(7).describe("Window ending now, in days (default 7)"),
  },
  get_lift_by_stage: {
    days: z.number().int().min(1).max(365).default(30).describe("Window ending now, in days (default 30)"),
  },
  check_policy: {
    variants: z.array(variantForCheck).min(1).describe("One entry per network you intend to post to"),
    scheduledAt: Timestamp.optional().describe("ISO-8601 publish time, so quiet-hours and per-day limits are checked for that moment"),
    actionClass: ActionClass.optional().describe("What kind of action this is (default new_post); decides which autonomy level applies"),
    aiAssisted: z.boolean().default(true).describe("Whether the text is machine-drafted (default true). The same disclosure create_post will record, so disclosure red lines are checked the same way."),
  },
  create_post: {
    title: z.string().max(200).optional().describe("Short internal label shown in the approval queue"),
    body: z.string().min(1).describe("The idea in canonical form; variants adapt it per network"),
    variants: z
      .array(
        z.object({
          socialAccountId: z.string().min(1).describe("Connected account id from get_brand_context"),
          text: z.string().min(1).describe("Text for this account's network, within its character limit"),
          thread: z.array(z.string().min(1)).optional().describe("Additional thread/carousel segments after the first"),
        }),
      )
      .min(1)
      .describe("One variant per connected account to post to"),
    scheduledAt: Timestamp.optional().describe("ISO-8601 publish time. Omit to leave it unscheduled for a human to schedule."),
    actionClass: ActionClass.optional().describe("new_post (default), reply, dm, repost or campaign; each has its own autonomy level"),
    trendTopicId: z.string().min(1).optional().describe("Radar topic this post acts on (from get_radar)"),
    trendStageAtCreation: TrendStage.optional().describe("The topic's stage right now (from get_radar), recorded for the outcome ledger"),
    trendForecastId: z.string().min(1).optional().describe("The forecast id you acted on (from get_radar JSON)"),
    evidence: z
      .array(z.object({ kind: z.string().min(1), ref: z.string().min(1), note: z.string().optional() }))
      .optional()
      .describe("Why this post: links to feed items, radar topics, briefs, e.g. { kind: 'activity', ref: '<id>', note: '...' }"),
    aiAssisted: z.boolean().default(true).describe("Whether the text is machine-drafted (default true); recorded in the disclosure"),
  },
  schedule_post: {
    postId: z.string().min(1).describe("Post id"),
    at: Timestamp.describe("ISO-8601 publish time"),
  },
  cancel_post: {
    postId: z.string().min(1).describe("Post id"),
  },
  list_alerts: {
    unacknowledgedOnly: z.boolean().default(true).describe("Only alerts nobody has acknowledged yet (default true)"),
    limit: z.number().int().min(1).max(200).default(50).describe("Max alerts (default 50)"),
  },
  get_ledger: {
    types: z.array(LedgerEventType).optional().describe("Only these event types, e.g. post.created, policy.blocked, post.approval_decided"),
    subjectType: z.string().min(1).optional().describe("e.g. post, account, policy, trend_topic"),
    subjectId: z.string().min(1).optional().describe("Id of the subject, e.g. a post id"),
    limit: z.number().int().min(1).max(500).default(50).describe("Max events (default 50)"),
  },
  get_calendar: {
    days: z.number().int().min(1).max(92).default(14).describe("How many days ahead, starting today (default 14)"),
    pastDays: z.number().int().min(0).max(31).default(0).describe("Also include this many past days"),
  },
  get_discoveries: {
    limit: z.number().int().min(1).max(200).default(50).describe("Max terms (default 50)"),
  },
  get_experiment: {
    experimentId: z.string().min(1).describe("Experiment id, as listed by list_experiments"),
  },
  create_experiment: {
    name: z.string().min(1).max(200).describe("Short name, e.g. 'Name the trail vs generic hook'"),
    hypothesis: z.string().min(1).max(2000).describe("What you expect and why, in one or two sentences"),
    arms: z
      .array(z.object({ key: z.string().regex(/^[a-z0-9_-]{1,32}$/).describe("Short key, lowercase"), description: z.string().max(500) }))
      .min(2)
      .max(6)
      .describe("2-6 arms. Then create posts with experimentId and experimentArm set to one of these keys"),
    primaryMetric: z.enum(["engagements", "impressions", "likes", "replies", "reposts", "link_clicks", "conversions"]).default("engagements"),
    offset: z.enum(["24h", "72h", "7d"]).default("24h").describe("When outcomes are compared after publishing"),
  },
  get_link_report: {
    days: z.number().int().min(1).max(365).default(30).describe("How many days back (default 30)"),
  },
  get_tracker_report: {
    days: z.number().int().min(1).max(90).default(7).describe("How many days back (default 7)"),
  },
  track_entity: {
    kind: z.enum(["organization", "person"]).describe("organization: a party, brand or company. person: a candidate, spokesperson, creator or individual brand"),
    name: z.string().min(1).max(200),
    role: z.string().max(60).optional().describe("party, brand, candidate, spokesperson, creator..."),
    parentId: z.string().optional().describe("The organisation this person or sub-brand belongs to (an id from list_tracked)"),
    relation: z.enum(["own", "client", "prospect", "competitor", "opponent", "watch"]).default("watch"),
    aliases: z.array(z.string().max(120)).max(60).default([]).describe("Other spellings, names in other languages and scripts, nicknames, abbreviations"),
    handles: z.record(z.string(), z.array(z.string())).default({}).describe("Their own accounts per network, e.g. {\"x\": [\"handle\"]}"),
    context: z.array(z.string().max(120)).max(40).default([]).describe("For ambiguous names: a match counts only near one of these words"),
    exclude: z.array(z.string().max(120)).max(40).default([]).describe("Never count a match when one of these appears (namesakes)"),
  },
  create_link: {
    url: z.string().url().describe("Absolute http(s) destination"),
    network: z.enum(["x", "bluesky", "threads", "instagram", "facebook", "linkedin", "tiktok", "youtube", "pinterest", "mastodon", "reddit", "google_business", "telegram", "discord"]).optional().describe("Where the link will be shared (sets utm_source)"),
    campaign: z.string().max(100).optional().describe("utm_campaign"),
  },
};

type Args<S extends z.ZodRawShape> = z.output<z.ZodObject<S>>;

// ---- result helpers --------------------------------------------------------------------------

/** Readable summary first, raw JSON second. */
export function ok(summary: string, data: unknown): CallToolResult {
  return {
    content: [
      { type: "text", text: summary },
      { type: "text", text: JSON.stringify(data ?? null, null, 2) },
    ],
  };
}

/** Never throw raw: every failure becomes an `isError` result the agent can read. */
export function toolError(err: unknown): CallToolResult {
  const text = err instanceof StarsignApiError ? err.toText() : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  return { isError: true, content: [{ type: "text", text }] };
}

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return toolError(err);
  }
}

function disclosureFor(aiAssisted: boolean): Disclosure {
  return { aiAssisted, aiContributions: aiAssisted ? ["text_drafted"] : [], humanReviewed: false, model: MCP_MODEL_LABEL };
}

// ---- handlers (exported so they can be tested without MCP plumbing) ----------------------------

export const handlers = {
  get_brand_context: (ctx: ToolContext) =>
    run(async () => {
      const c = await ctx.client.getContext();
      return ok(fmt.formatContext(c), c);
    }),

  get_radar: (ctx: ToolContext) =>
    run(async () => {
      const r = await ctx.client.getRadar();
      return ok(fmt.formatRadar(r), r);
    }),

  get_topic: (ctx: ToolContext, args: Args<typeof inputs.get_topic>) =>
    run(async () => {
      const t = await ctx.client.getTopic(args.topicId);
      return ok(fmt.formatTopic(t), t);
    }),

  search_feed: (ctx: ToolContext, args: Args<typeof inputs.search_feed>) =>
    run(async () => {
      const since = args.sinceHours !== undefined ? new Date(ctx.now().getTime() - args.sinceHours * HOUR_MS).toISOString() : undefined;
      const items = await ctx.client.searchFeed({ q: args.q, networks: args.networks, kinds: args.kinds, stream: args.streamId, since, limit: args.limit });
      return ok(fmt.formatFeed(items), items);
    }),

  get_queue: (ctx: ToolContext) =>
    run(async () => {
      const q = await ctx.client.getQueue();
      return ok(fmt.formatQueue(q), q);
    }),

  get_post: (ctx: ToolContext, args: Args<typeof inputs.get_post>) =>
    run(async () => {
      const d = await ctx.client.getPost(args.postId);
      return ok(fmt.formatPostDetail(d, { history: d.history ?? [] }), d);
    }),

  list_posts: (ctx: ToolContext, args: Args<typeof inputs.list_posts>) =>
    run(async () => {
      const items = await ctx.client.listPosts({ status: args.status, limit: args.limit });
      return ok(fmt.formatPostList(items), items);
    }),

  get_metrics_summary: (ctx: ToolContext, args: Args<typeof inputs.get_metrics_summary>) =>
    run(async () => {
      const to = ctx.now();
      const from = new Date(to.getTime() - args.days * DAY_MS);
      const s = await ctx.client.getMetricsSummary({ from, to });
      return ok(fmt.formatSummary(s, { from, to, days: args.days }), s);
    }),

  get_lift_by_stage: (ctx: ToolContext, args: Args<typeof inputs.get_lift_by_stage>) =>
    run(async () => {
      const to = ctx.now();
      const from = new Date(to.getTime() - args.days * DAY_MS);
      const rows = await ctx.client.getLiftByStage({ from, to });
      return ok(fmt.formatLift(rows, args.days), rows);
    }),

  check_policy: (ctx: ToolContext, args: Args<typeof inputs.check_policy>) =>
    run(async () => {
      const decision = await ctx.client.checkPolicy({
        variants: args.variants,
        scheduledAt: args.scheduledAt,
        actionClass: args.actionClass,
        disclosure: disclosureFor(args.aiAssisted),
      });
      return ok(fmt.formatPolicyDecision(decision), decision);
    }),

  create_post: (ctx: ToolContext, args: Args<typeof inputs.create_post>) =>
    run(async () => {
      const body: CreatePostBody = {
        title: args.title,
        body: args.body,
        variants: args.variants.map((v) => ({ socialAccountId: v.socialAccountId, text: v.text, thread: v.thread ?? [] })),
        scheduledAt: args.scheduledAt,
        actionClass: args.actionClass ?? "new_post",
        trendTopicId: args.trendTopicId,
        trendStageAtCreation: args.trendStageAtCreation,
        trendForecastId: args.trendForecastId,
        evidence: args.evidence ?? [],
        disclosure: disclosureFor(args.aiAssisted),
      };
      const d = await ctx.client.createPost(body);
      return ok(fmt.formatPostDetail(d, { lead: "Created." }), d);
    }),

  schedule_post: (ctx: ToolContext, args: Args<typeof inputs.schedule_post>) =>
    run(async () => {
      const d = await ctx.client.schedulePost(args.postId, args.at);
      return ok(fmt.formatPostDetail(d, { lead: "Schedule requested." }), d);
    }),

  cancel_post: (ctx: ToolContext, args: Args<typeof inputs.cancel_post>) =>
    run(async () => {
      const d = await ctx.client.cancelPost(args.postId);
      return ok(fmt.formatPostDetail(d, { lead: "Cancelled." }), d);
    }),

  get_latest_brief: (ctx: ToolContext) =>
    run(async () => {
      const b = await ctx.client.getLatestBrief();
      return ok(fmt.formatBrief(b), b);
    }),

  list_alerts: (ctx: ToolContext, args: Args<typeof inputs.list_alerts>) =>
    run(async () => {
      const alerts = await ctx.client.listAlerts({ unacknowledgedOnly: args.unacknowledgedOnly, limit: args.limit });
      return ok(fmt.formatAlerts(alerts, args.unacknowledgedOnly), alerts);
    }),

  get_policy: (ctx: ToolContext) =>
    run(async () => {
      const p = await ctx.client.getPolicy();
      return ok(fmt.formatPolicy(p), p);
    }),

  get_ledger: (ctx: ToolContext, args: Args<typeof inputs.get_ledger>) =>
    run(async () => {
      const events = await ctx.client.getLedger({ types: args.types, subjectType: args.subjectType, subjectId: args.subjectId, limit: args.limit });
      return ok(fmt.formatLedger(events), events);
    }),
} satisfies Record<Exclude<ToolName, keyof typeof moreHandlers | keyof typeof linkHandlers | keyof typeof trackerHandlers | keyof typeof inboxHandlers /* inbox workflow */ | keyof typeof visibilityHandlers /* AI answer visibility */>, (ctx: ToolContext, ...args: never[]) => Promise<CallToolResult>>;

// ---- registration ----------------------------------------------------------------------------

function line(parts: (string | null | undefined | false)[]): string {
  return parts.filter(Boolean).join(" · ");
}

type CalendarRow = { post: { id: string; status: string; scheduledAt: string | null; publishedAt: string | null; body: string; experimentArm?: string | null }; variants: { network: string }[] };
type ExperimentRow = { id: string; name: string; hypothesis: string; status: string; arms: { key: string; description: string }[]; primaryMetric: string };
type ReadoutShape = { verdict: string; summary: string; arms: { key: string; posts: number; measured: number; mean: number | null }[] };

const moreHandlers = {
  get_calendar: (ctx: ToolContext, args: Args<typeof inputs.get_calendar>) =>
    run(async () => {
      const start = new Date(ctx.now().getTime() - args.pastDays * DAY_MS);
      start.setUTCHours(0, 0, 0, 0);
      const to = new Date(start.getTime() + (args.days + args.pastDays) * DAY_MS);
      const rows = await ctx.client.request<CalendarRow[]>("GET", "/v1/calendar", { query: { from: start.toISOString(), to: to.toISOString() } });
      const lines = rows.map((r) =>
        line([(r.post.publishedAt ?? r.post.scheduledAt ?? "").slice(0, 16).replace("T", " ") + "Z", r.post.status, r.variants.map((v) => v.network).join("+"), r.post.experimentArm ? `arm ${r.post.experimentArm}` : null, `"${r.post.body.slice(0, 70)}"`, r.post.id]),
      );
      return ok(rows.length ? `${rows.length} posts between ${start.toISOString().slice(0, 10)} and ${to.toISOString().slice(0, 10)}:\n${lines.join("\n")}` : "Nothing scheduled or published in that window.", rows);
    }),
  get_sources: (ctx: ToolContext) =>
    run(async () => {
      const rows = await ctx.client.request<{ name: string; configured: boolean; lastRunAt: string | null; lastError: string | null; pointsLast24h: number }[]>("GET", "/v1/sources");
      return ok(rows.map((s) => line([s.name, s.configured ? "configured" : "not configured", s.lastRunAt ? `last run ${s.lastRunAt}` : "never run", `${s.pointsLast24h} points in 24h`, s.lastError ? `error: ${s.lastError}` : null])).join("\n"), rows);
    }),
  get_discoveries: (ctx: ToolContext, args: Args<typeof inputs.get_discoveries>) =>
    run(async () => {
      const rows = await ctx.client.request<{ term: string; source: string; value: number | null; region: string; context?: string[] }[]>("GET", "/v1/trends/discoveries", { query: { limit: String(args.limit) } });
      return ok(rows.length ? `Trending now (raw, not yet topics):\n${rows.map((d) => line([d.term, d.source, d.region, d.value !== null ? `size ${d.value}` : null, d.context?.[0]])).join("\n")}` : "No trending terms collected yet.", rows);
    }),
  list_experiments: (ctx: ToolContext) =>
    run(async () => {
      const rows = await ctx.client.request<ExperimentRow[]>("GET", "/v1/experiments");
      return ok(rows.length ? rows.map((e) => line([e.name, e.status, `arms ${e.arms.map((a) => a.key).join("/")}`, e.primaryMetric, e.id])).join("\n") : "No experiments yet.", rows);
    }),
  get_experiment: (ctx: ToolContext, args: Args<typeof inputs.get_experiment>) =>
    run(async () => {
      const r = await ctx.client.request<{ experiment: ExperimentRow; readout: ReadoutShape }>("GET", `/v1/experiments/${encodeURIComponent(args.experimentId)}`);
      const arms = r.readout.arms.map((a) => `  - ${a.key}: ${a.measured}/${a.posts} measured${a.mean !== null ? `, mean ${a.mean.toFixed(1)}` : ""}`).join("\n");
      return ok(`${r.experiment.name} (${r.experiment.status})\nHypothesis: ${r.experiment.hypothesis}\nVerdict: ${r.readout.verdict}. ${r.readout.summary}\n${arms}`, r);
    }),
  create_experiment: (ctx: ToolContext, args: Args<typeof inputs.create_experiment>) =>
    run(async () => {
      const e = await ctx.client.request<ExperimentRow>("POST", "/v1/experiments", { body: args });
      return ok(`Experiment "${e.name}" is running (${e.id}). Create posts with experimentId "${e.id}" and experimentArm one of: ${e.arms.map((a) => a.key).join(", ")}. They still go through the approval queue.`, e);
    }),
};

interface LinkReportShape {
  configured: boolean;
  totals: { clicks: number; uniqueVisitors: number; previews: number; conversions: number; attributedConversions: number; conversionValue: number; valueByCurrency: { currency: string | null; value: number }[] };
  byNetwork: { network: string | null; clicks: number; uniqueVisitors: number; conversions: number; value: number }[];
  topLinks: { slug: string; shortUrl: string | null; destination: string; network: string | null; postId: string | null; uniqueVisitors: number; conversions: number; conversionValue: number; clicksInRange: number }[];
}

interface TrackedRow {
  id: string;
  kind: string;
  name: string;
  role: string | null;
  relation: string;
  parentId: string | null;
  aliases: string[];
}
interface TrackerReportShape {
  entities: (TrackedRow & { mentions: number; authored: number; people: number; familyMentions: number; shareOfVoice: number | null; shareWithinParent: number | null; byLanguage: { lang: string | null; n: number }[]; byNetwork: { network: string; n: number }[] })[];
}

const trackerHandlers = {
  list_tracked: (ctx: ToolContext) =>
    run(async () => {
      const rows = await ctx.client.request<TrackedRow[]>("GET", "/v1/entities");
      const byId = new Map(rows.map((r) => [r.id, r]));
      return ok(
        rows.length
          ? rows.map((r) => line([r.name, r.role ?? r.kind, r.relation, r.parentId ? `of ${byId.get(r.parentId)?.name ?? r.parentId}` : null, r.aliases.length ? `aka ${r.aliases.slice(0, 4).join(", ")}` : null, r.id])).join("\n")
          : "Nothing is tracked yet. Use track_entity to add a party, brand or person.",
        rows,
      );
    }),
  get_tracker_report: (ctx: ToolContext, args: Args<typeof inputs.get_tracker_report>) =>
    run(async () => {
      const to = ctx.now();
      const from = new Date(to.getTime() - args.days * DAY_MS);
      const r = await ctx.client.request<TrackerReportShape>("GET", "/v1/entities/report", { query: { from: from.toISOString(), to: to.toISOString() } });
      const fmtLangs = (xs: { lang: string | null; n: number }[]) => xs.slice(0, 4).map((x) => `${x.lang ?? "?"} ${x.n}`).join(", ");
      const lines = r.entities
        .slice()
        .sort((a, b) => b.familyMentions - a.familyMentions)
        .map((e) =>
          line([
            `${e.parentId ? "  " : ""}${e.name}`,
            `${e.mentions} mention(s)`,
            e.familyMentions !== e.mentions ? `${e.familyMentions} incl. its people` : null,
            `${e.people} people`,
            e.authored ? `${e.authored} by them` : null,
            e.shareOfVoice !== null ? `${e.shareOfVoice}% share of voice` : e.shareWithinParent !== null ? `${e.shareWithinParent}% within party/brand` : null,
            e.byLanguage.length ? `langs ${fmtLangs(e.byLanguage)}` : null,
          ]),
        );
      return ok(lines.length ? `Last ${args.days} days:\n${lines.join("\n")}` : "Nothing is tracked yet.", r);
    }),
  track_entity: (ctx: ToolContext, args: Args<typeof inputs.track_entity>) =>
    run(async () => {
      const e = await ctx.client.request<TrackedRow>("POST", "/v1/entities", { body: args });
      return ok(`Now tracking ${e.name} (${e.id}). Past 90 days of messages were scanned; new ones are scanned as they arrive. get_tracker_report shows the counts.`, e);
    }),
};

const linkHandlers = {
  get_link_report: (ctx: ToolContext, args: Args<typeof inputs.get_link_report>) =>
    run(async () => {
      const to = ctx.now();
      const from = new Date(to.getTime() - args.days * DAY_MS);
      const r = await ctx.client.request<LinkReportShape>("GET", "/v1/links/report", { query: { from: from.toISOString(), to: to.toISOString() } });
      if (!r.configured && r.totals.clicks === 0) return ok("Link tracking is not configured on this deployment, so there are no owned click or conversion numbers yet.", r);
      const t = r.totals;
      const money = t.valueByCurrency.map((c) => `${c.value.toFixed(2)} ${c.currency ?? "(no currency)"}`).join(", ");
      const nets = r.byNetwork.map((n) => `  - ${n.network ?? "manual"}: ${n.uniqueVisitors} people, ${n.conversions} conversions`).join("\n");
      const top = r.topLinks.map((l) => `  - ${l.shortUrl ?? l.slug} → ${l.destination}: ${l.clicksInRange} clicks, ${l.conversions} conversions${l.postId ? ` (post ${l.postId})` : ""}`).join("\n");
      return ok(
        `Last ${args.days} days: ${t.uniqueVisitors} people clicked (${t.clicks} clicks; ${t.previews} link-preview fetches not counted). ${t.conversions} conversions (${t.attributedConversions} traced to a post)${money ? `, worth ${money}` : ""}.${nets ? `\nBy network:\n${nets}` : ""}${top ? `\nTop links:\n${top}` : ""}`,
        r,
      );
    }),
  create_link: (ctx: ToolContext, args: Args<typeof inputs.create_link>) =>
    run(async () => {
      const l = await ctx.client.request<{ id: string; slug: string; shortUrl: string; target: string }>("POST", "/v1/links", { body: args });
      return ok(`Short link ${l.shortUrl} → ${l.target}. Clicks and conversions on it show up in get_link_report. Links inside posts are wrapped automatically; use this for bios and anything posted by hand.`, l);
    }),
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export function registerTools(server: McpServer, client: StarsignClient, opts: { now?: () => Date } = {}): void {
  const ctx: ToolContext = { client, now: opts.now ?? (() => new Date()) };

  server.registerTool(
    "get_brand_context",
    {
      title: "Brand context",
      description:
        "Call this FIRST, before drafting or proposing anything. Returns the brand profile (description, audience, topics, voice do/don't), " +
        "your autonomy per action class and the red lines you must not cross (in plain language), the connected social accounts " +
        "(you need their ids for create_post), voice examples (before → after edits humans made to earlier drafts; write like the 'after'), " +
        "recent top posts, and the active trend topics.",
      annotations: READ_ONLY,
    },
    () => handlers.get_brand_context(ctx),
  );

  server.registerTool(
    "get_radar",
    {
      title: "Trend radar",
      description:
        "The trend radar: the topics this brand tracks with their forecast stage (dormant, rising, peaking, plateau, fading), confidence, " +
        "estimated hours to peak, the suggested acting window, and how often the brand already acted on each. Sorted by score. " +
        "Use get_topic for detail and pass trendTopicId/trendStageAtCreation/trendForecastId to create_post when you act on one.",
      annotations: READ_ONLY,
    },
    () => handlers.get_radar(ctx),
  );

  server.registerTool(
    "get_topic",
    {
      title: "Topic detail",
      description: "Detail for one radar topic: the forecast with its confidence band, the per-source time series, and the brand's past posts on it with 24h outcomes.",
      inputSchema: inputs.get_topic,
      annotations: READ_ONLY,
    },
    (args) => handlers.get_topic(ctx, args),
  );

  server.registerTool(
    "search_feed",
    {
      title: "Search the live feed",
      description:
        "Search inbound activity across the brand's connected networks (mentions, replies, comments, DMs, reposts, quotes, own posts). " +
        "Filter by free text, networks, kinds, a saved stream and a window in hours. Newest first. Use it to find what to respond to and as evidence for create_post.",
      inputSchema: inputs.search_feed,
      annotations: READ_ONLY,
    },
    (args) => handlers.search_feed(ctx, args),
  );

  server.registerTool(
    "get_queue",
    {
      title: "Approval queue",
      description: "Posts waiting on a human in the approval queue, oldest first. Read-only: approving and rejecting happen in the Starsign app, never through this server.",
      annotations: READ_ONLY,
    },
    () => handlers.get_queue(ctx),
  );

  server.registerTool(
    "get_post",
    {
      title: "Post detail",
      description: "One post with its variants, approvals, policy decision and full ledger history (creation, red-line decisions, approvals and edits, scheduling, publishing).",
      inputSchema: inputs.get_post,
      annotations: READ_ONLY,
    },
    (args) => handlers.get_post(ctx, args),
  );

  server.registerTool(
    "list_posts",
    {
      title: "List posts",
      description: "Posts newest first, optionally filtered by status (draft, pending_approval, approved, scheduled, publishing, published, partially_published, failed, cancelled, blocked).",
      inputSchema: inputs.list_posts,
      annotations: READ_ONLY,
    },
    (args) => handlers.list_posts(ctx, args),
  );

  server.registerTool(
    "get_metrics_summary",
    {
      title: "Outcome summary",
      description:
        "Outcomes for the last N days (default 7): impressions and engagements, what was published per network, engagement by network / trend stage / hour / author / experiment arm, and the top posts with lift versus the 24h baseline.",
      inputSchema: inputs.get_metrics_summary,
      annotations: READ_ONLY,
    },
    (args) => handlers.get_metrics_summary(ctx, args),
  );

  server.registerTool(
    "get_lift_by_stage",
    {
      title: "Lift by trend stage",
      description:
        "Average engagements and lift versus baseline for posts grouped by the trend stage they were created in (last N days, default 30). This is the evidence for whether acting early on rising topics pays for this brand.",
      inputSchema: inputs.get_lift_by_stage,
      annotations: READ_ONLY,
    },
    (args) => handlers.get_lift_by_stage(ctx, args),
  );

  server.registerTool(
    "check_policy",
    {
      title: "Check red lines (dry run)",
      description:
        "Dry-run the brand's red lines and autonomy against draft text per network. Nothing is created or stored. Use it before create_post: " +
        "fix every 'block' violation (it would be blocked for real), and expect a human review on 'require_approval'. " +
        "The same AI-assisted disclosure create_post records is included, so disclosure red lines are evaluated the same way.",
      inputSchema: inputs.check_policy,
      annotations: READ_ONLY,
    },
    (args) => handlers.check_policy(ctx, args),
  );

  server.registerTool(
    "create_post",
    {
      title: "Propose a post",
      description:
        "Propose a post: one idea with one text variant per connected account. The server runs the red lines and the autonomy dial and decides where it lands: " +
        "usually the approval queue (pending_approval), otherwise draft or scheduled, or blocked when a red line is crossed (the block is recorded in the ledger). " +
        "You cannot approve or publish; humans do that in the Starsign app. Get account ids and voice from get_brand_context and dry-run with check_policy first. " +
        "The post is recorded as AI-assisted and not yet human-reviewed. The result states plainly where the post landed.",
      inputSchema: inputs.create_post,
      annotations: { ...WRITES, idempotentHint: false },
    },
    (args) => handlers.create_post(ctx, args),
  );

  server.registerTool(
    "schedule_post",
    {
      title: "Schedule a post",
      description: "Ask to schedule an existing post (draft or approved) at an ISO-8601 time. Autonomy decides whether it is scheduled directly or waits for a human.",
      inputSchema: inputs.schedule_post,
      annotations: { ...WRITES, idempotentHint: true },
    },
    (args) => handlers.schedule_post(ctx, args),
  );

  server.registerTool(
    "cancel_post",
    {
      title: "Cancel a post",
      description: "Cancel a post that has not published yet; it leaves the queue or schedule. Cannot be undone (create a new post instead).",
      inputSchema: inputs.cancel_post,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => handlers.cancel_post(ctx, args),
  );

  server.registerTool(
    "get_latest_brief",
    {
      title: "Latest brief",
      description: "The most recent operator brief: a Markdown digest of what happened on the brand's surfaces, what moved and what is coming, with evidence.",
      annotations: READ_ONLY,
    },
    () => handlers.get_latest_brief(ctx),
  );

  server.registerTool(
    "list_alerts",
    {
      title: "Alerts",
      description: "Operator alerts (urgent, attention, info): mention spikes, trend windows opening, accounts needing re-auth. Unacknowledged only by default; acknowledging happens in the app.",
      inputSchema: inputs.list_alerts,
      annotations: READ_ONLY,
    },
    (args) => handlers.list_alerts(ctx, args),
  );

  server.registerTool(
    "get_policy",
    {
      title: "Policy document",
      description: "The full active policy: autonomy per action class, every red line with its parameters (phrases, keywords, patterns, quiet hours...), spend caps, disclosure settings and timezone. Read-only: policy changes are made by owners in the app.",
      annotations: READ_ONLY,
    },
    () => handlers.get_policy(ctx),
  );

  server.registerTool(
    "get_ledger",
    {
      title: "Ledger",
      description: "Query the append-only ledger: every fact Starsign asserts (post.created, policy.blocked, post.approval_decided, post.published, outcome.captured, operator.alert...). Filter by event types and subject. Newest first.",
      inputSchema: inputs.get_ledger,
      annotations: READ_ONLY,
    },
    (args) => handlers.get_ledger(ctx, args),
  );

  server.registerTool("get_calendar", { title: "Calendar", description: "Posts scheduled, waiting on approval or already out, by time. Use it to avoid crowding a day and to see what is coming.", inputSchema: inputs.get_calendar, annotations: READ_ONLY }, (args) => moreHandlers.get_calendar(ctx, args));
  server.registerTool("get_sources", { title: "Trend sources", description: "Which trend sources feed the radar (Google Trends, Wikipedia, Hacker News, Bluesky, YouTube, the brand's own feed), whether each is configured and healthy.", annotations: READ_ONLY }, () => moreHandlers.get_sources(ctx));
  server.registerTool("get_discoveries", { title: "Trending now", description: "Raw terms the sources say are trending right now, before the Scout turns relevant ones into topics. Useful to spot something the radar does not track yet.", inputSchema: inputs.get_discoveries, annotations: READ_ONLY }, (args) => moreHandlers.get_discoveries(ctx, args));
  server.registerTool("list_experiments", { title: "Experiments", description: "Running and concluded experiments: name, arms, metric.", annotations: READ_ONLY }, () => moreHandlers.list_experiments(ctx));
  server.registerTool("get_experiment", { title: "Experiment readout", description: "One experiment with its readout: posts and measured outcomes per arm, lift with an 80% interval, and a verdict that names a winner only when the evidence clears.", inputSchema: inputs.get_experiment, annotations: READ_ONLY }, (args) => moreHandlers.get_experiment(ctx, args));
  server.registerTool("get_link_report", { title: "What posts drove", description: "Owned outcome numbers from Starsign's short links: people who clicked, conversions and their value, by network and top link. Unlike network metrics these are first-party and comparable across networks; use them to judge which posts actually worked.", inputSchema: inputs.get_link_report, annotations: READ_ONLY }, (args) => linkHandlers.get_link_report(ctx, args));
  server.registerTool("create_link", { title: "Make a tracked link", description: "Make a tracked short link with UTM tags for a destination (for a bio or a manual post). Links inside posts created with create_post are wrapped automatically at publish time.", inputSchema: inputs.create_link, annotations: { ...WRITES, idempotentHint: false } }, (args) => linkHandlers.create_link(ctx, args));
  server.registerTool("list_tracked", { title: "Tracked names", description: "Parties, brands, companies and people (candidates, spokespeople, creators, individual brands) the workspace tracks, with their aliases and who belongs to which organisation.", annotations: READ_ONLY }, () => trackerHandlers.list_tracked(ctx));
  server.registerTool("get_tracker_report", { title: "Who is being talked about", description: "Mentions per tracked party, brand or person across every network, chat app and language: mentions by others, messages by them, distinct people, share of voice, and languages. Organisations include their people.", inputSchema: inputs.get_tracker_report, annotations: READ_ONLY }, (args) => trackerHandlers.get_tracker_report(ctx, args));
  server.registerTool("track_entity", { title: "Track a name", description: "Start tracking a party, brand, company or person. Give every way it is written (aliases in other languages and scripts), its own handles, and context words when the name is a common word.", inputSchema: inputs.track_entity, annotations: { ...WRITES, idempotentHint: false } }, (args) => trackerHandlers.track_entity(ctx, args));
  server.registerTool("create_experiment", { title: "Start an experiment", description: "Start an experiment with 2-6 arms. Then create posts with experimentId and experimentArm. Concluding happens in the app.", inputSchema: inputs.create_experiment, annotations: { ...WRITES, idempotentHint: false } }, (args) => moreHandlers.create_experiment(ctx, args));
  // ---- inbox workflow
  server.registerTool("list_inbox", { title: "Team inbox", description: "The shared inbox: conversations (comments, mentions, DMs, chat messages from every network, translated) with their status (open, pending, done, spam), who is on them, priority, labels, and the first-response target (time left or overdue). Filter by status, assignee, label, priority, network or text.", inputSchema: inboxInputs.list_inbox, annotations: READ_ONLY }, (args) => inboxHandlers.list_inbox(ctx, args));
  server.registerTool("update_inbox_item", { title: "Work an inbox conversation", description: "Set a conversation's status (open, pending, done, spam), add or remove workspace labels, and leave an internal note (never sent; @name mentions notify teammates). Assigning people, priority and rules are for people in the app. Replies go through create_post with actionClass reply and the red lines.", inputSchema: inboxInputs.update_inbox_item, annotations: { ...WRITES, idempotentHint: false } }, (args) => inboxHandlers.update_inbox_item(ctx, args));
  // ---- end inbox workflow
  // ---- AI answer visibility
  server.registerTool("get_ai_visibility", { title: "How AI assistants answer about us", description: "What ChatGPT, Claude, Perplexity and Gemini say when asked the workspace's tracked questions: per tracked name, the share of answers that mention it, its average position among tracked names, tone (-1..1), change against the previous period, by engine and language; the domains answers cite (own vs others); and the latest answers with what each said. Answers vary run to run, so read the trend, not one answer.", inputSchema: visibilityInputs.get_ai_visibility, annotations: READ_ONLY }, (args) => visibilityHandlers.get_ai_visibility(ctx, args));
}

// ---- inbox workflow ---------------------------------------------------------------------------

export const inboxInputs = {
  list_inbox: {
    status: z.array(z.enum(["open", "pending", "done", "spam"])).optional().describe("Only these statuses; default open and pending"),
    assignee: z.string().min(1).optional().describe("\"none\" for unassigned, or a member's user id"),
    tag: z.string().min(1).optional().describe("Only conversations with this label"),
    priority: z.array(z.enum(["normal", "high", "urgent"])).optional(),
    network: z.array(Network).optional().describe("Only these networks"),
    q: z.string().min(1).optional().describe("Search the messages (original or translation) and author"),
    sort: z.enum(["newest", "oldest", "due", "priority"]).default("due").describe("due (default): soonest first-response deadline first"),
    limit: z.number().int().min(1).max(100).default(30),
  },
  update_inbox_item: {
    activityId: z.string().min(1).describe("The conversation's id (any message id in it works), from list_inbox or search_feed"),
    status: z.enum(["open", "pending", "done", "spam"]).optional(),
    addTags: z.array(z.string().min(1)).max(20).optional().describe("Workspace labels to add (only labels the workspace defined)"),
    removeTags: z.array(z.string().min(1)).max(20).optional(),
    note: z.string().min(1).max(5000).optional().describe("An internal note for the team; never sent to the customer"),
  },
};

interface InboxEntryShape {
  activity: { id: string; network: string; kind: string; authorName: string | null; authorHandle: string | null; text: string | null; translation?: string | null; lang?: string | null };
  latest: { text: string | null } | null;
  state: { status: string; assignee: string | null; priority: string; tags: string[]; messageCount: number };
  sla: { state: string; msLeft: number | null };
  notes: number;
}
interface InboxListShape {
  items: InboxEntryShape[];
  counts: { open: number; pending: number; done: number; spam: number; mine: number; unassigned: number; snoozed: number };
}

function slaText(sla: InboxEntryShape["sla"]): string | null {
  if (sla.state === "overdue" && sla.msLeft !== null) return `overdue by ${Math.max(1, Math.round(-sla.msLeft / 60_000))}m`;
  if ((sla.state === "ok" || sla.state === "soon") && sla.msLeft !== null) return `${Math.round(sla.msLeft / 60_000)}m left to first reply`;
  if (sla.state === "missed") return "first reply was late";
  return null;
}

function inboxLine(e: InboxEntryShape): string {
  const a = e.activity;
  const text = (a.translation ?? a.text ?? "").replace(/\s+/g, " ").slice(0, 140);
  return line([
    `[${e.state.status}${e.state.priority !== "normal" ? `, ${e.state.priority}` : ""}]`,
    `${a.authorName ?? a.authorHandle ?? "someone"} on ${a.network} (${a.kind})`,
    a.lang && a.translation ? `translated from ${a.lang}` : null,
    `"${text}"`,
    e.state.messageCount > 1 ? `${e.state.messageCount} messages` : null,
    e.state.assignee ? `assigned ${e.state.assignee}` : "unassigned",
    e.state.tags.length ? `labels ${e.state.tags.join(", ")}` : null,
    slaText(e.sla),
    e.notes ? `${e.notes} note(s)` : null,
    a.id,
  ]);
}

export const inboxHandlers = {
  list_inbox: (ctx: ToolContext, args: Args<typeof inboxInputs.list_inbox>) =>
    run(async () => {
      const r = await ctx.client.request<InboxListShape>("GET", "/v1/inbox", {
        query: { status: (args.status ?? ["open", "pending"]).join(","), assignee: args.assignee, tag: args.tag, priority: args.priority?.join(","), network: args.network?.join(","), q: args.q, sort: args.sort, limit: args.limit },
      });
      const c = r.counts;
      const head = `Inbox: ${c.open} open (${c.unassigned} unassigned), ${c.pending} pending, ${c.done} done, ${c.spam} spam${c.snoozed ? `, ${c.snoozed} snoozed` : ""}.`;
      return ok(r.items.length ? `${head}\n${r.items.map(inboxLine).join("\n")}` : `${head}\nNothing matches.`, r);
    }),
  update_inbox_item: (ctx: ToolContext, args: Args<typeof inboxInputs.update_inbox_item>) =>
    run(async () => {
      const id = encodeURIComponent(args.activityId);
      const patch = { ...(args.status ? { status: args.status } : {}), ...(args.addTags?.length ? { addTags: args.addTags } : {}), ...(args.removeTags?.length ? { removeTags: args.removeTags } : {}) };
      if (!Object.keys(patch).length && !args.note) return ok("Nothing to change: give a status, labels or a note.", null);
      let entry: InboxEntryShape | null = null;
      if (Object.keys(patch).length) entry = await ctx.client.request<InboxEntryShape>("PATCH", `/v1/inbox/${id}`, { body: patch });
      let note: { id: string; mentions: string[] } | null = null;
      if (args.note) note = await ctx.client.request<{ id: string; mentions: string[] }>("POST", `/v1/inbox/${id}/notes`, { body: { text: args.note } });
      const parts = [entry ? `Now ${inboxLine(entry)}` : null, note ? `Note added${note.mentions.length ? `, notifying ${note.mentions.length} teammate(s)` : ""}.` : null].filter(Boolean);
      return ok(parts.join("\n"), { item: entry, note });
    }),
};
// ---- end inbox workflow

// ---- AI answer visibility ----------------------------------------------------------------------

export const visibilityInputs = {
  get_ai_visibility: {
    days: z.number().int().min(1).max(180).default(28).describe("How many days back (default 28); compared with the same length before it"),
    entity: z.string().min(1).optional().describe("Only this tracked name (an id from list_tracked): also lists its latest answers"),
  },
};

interface VisAgg {
  answers: number;
  mentioned: number;
  share: number | null;
  avgPosition: number | null;
  sentiment: number | null;
}
interface VisibilityReportShape {
  totals: { answers: number; prompts: number; errors: number; capped: number; costUsd: number };
  entities: (VisAgg & { id: string; name: string; parentId: string | null; ownCitations: number; flagged: number; change: { share: number | null; avgPosition: number | null; sentiment: number | null }; byEngine: (VisAgg & { engine: string })[]; byLanguage: (VisAgg & { lang: string })[] })[];
  citations: { total: number; own: number; ownShare: number | null; ownDomains: { domain: string; citations: number }[]; otherDomains: { domain: string; citations: number }[] };
  engines: { id: string; label: string; configured: boolean; enabled: boolean; envVar: string }[];
}
interface VisibilityAnswerShape {
  engine: string;
  lang: string;
  question: string;
  askedAt: string;
  text: string | null;
  mentions: { entityId: string; name: string; mentioned: boolean; position: number | null; sentiment: number | null; summary: string | null; flags: string[] }[];
  citations: { domain: string }[];
}

const pctOf = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
const signed = (x: number | null, unit = "") => (x === null ? null : `${x > 0 ? "+" : ""}${unit === "pts" ? Math.round(x * 100) : x.toFixed(2)}${unit ? ` ${unit}` : ""}`);

export const visibilityHandlers = {
  get_ai_visibility: (ctx: ToolContext, args: Args<typeof visibilityInputs.get_ai_visibility>) =>
    run(async () => {
      const to = ctx.now();
      const from = new Date(to.getTime() - args.days * DAY_MS);
      const r = await ctx.client.request<VisibilityReportShape>("GET", "/v1/visibility/report", { query: { from: from.toISOString(), to: to.toISOString() } });
      const engines = r.engines.filter((e) => e.enabled).map((e) => e.label);
      const head = engines.length
        ? `Last ${args.days} days: ${r.totals.answers} answers to ${r.totals.prompts} question(s) from ${engines.join(", ")}${r.totals.capped ? `; ${r.totals.capped} skipped at the spend cap` : ""}. Answers vary run to run; read the trend.`
        : `No answer engine is configured (set ${r.engines.map((e) => e.envVar).join(", ")} on the server).`;
      const rows = (args.entity ? r.entities.filter((e) => e.id === args.entity) : r.entities).filter((e) => e.answers > 0);
      const lines = rows
        .slice()
        .sort((a, b) => (b.share ?? 0) - (a.share ?? 0))
        .map((e) =>
          line([
            `${e.parentId ? "  " : ""}${e.name}`,
            `in ${pctOf(e.share)} of ${e.answers} answers`,
            signed(e.change.share, "pts") ? `${signed(e.change.share, "pts")} vs before` : null,
            e.avgPosition !== null ? `avg position ${e.avgPosition}` : null,
            e.sentiment !== null ? `tone ${e.sentiment.toFixed(2)}` : null,
            e.ownCitations ? `${e.ownCitations} own-site citation(s)` : null,
            e.flagged ? `${e.flagged} answer(s) with possible inaccuracies` : null,
            e.byEngine.length ? `by engine ${e.byEngine.map((x) => `${x.engine} ${pctOf(x.share)}`).join(", ")}` : null,
          ]),
        );
      const cites = r.citations.total ? `Citations: ${r.citations.own} of ${r.citations.total} to own sites (${pctOf(r.citations.ownShare)}). Top other sources: ${r.citations.otherDomains.slice(0, 5).map((d) => `${d.domain} ${d.citations}`).join(", ") || "none"}.` : null;
      let latest = "";
      let answers: VisibilityAnswerShape[] = [];
      if (args.entity) {
        answers = await ctx.client.request<VisibilityAnswerShape[]>("GET", "/v1/visibility/answers", { query: { entity: args.entity, limit: 5 } });
        latest = answers
          .map((a) => {
            const m = a.mentions.find((x) => x.entityId === args.entity);
            return line([`${a.askedAt.slice(0, 10)} ${a.engine} (${a.lang})`, `"${a.question}"`, m?.position ? `#${m.position}` : null, m?.sentiment !== null && m?.sentiment !== undefined ? `tone ${m.sentiment.toFixed(2)}` : null, m?.summary ?? null, m?.flags.length ? `flags: ${m.flags.join("; ")}` : null]);
          })
          .join("\n");
      }
      const text = [head, lines.join("\n") || "No answers in this period yet.", cites, latest ? `Latest answers mentioning it:\n${latest}` : null].filter(Boolean).join("\n");
      return ok(text, { report: r, ...(args.entity ? { answers } : {}) });
    }),
};
// ---- end AI answer visibility
