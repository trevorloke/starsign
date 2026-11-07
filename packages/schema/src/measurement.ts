import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

/** Canonical metric names across networks. Connectors map native names to these. */
export const MetricName = z.enum([
  "impressions",
  "reach",
  "likes",
  "replies",
  "reposts",
  "quotes",
  "saves",
  "shares",
  "clicks",
  "link_clicks",
  "video_views",
  "watch_time_seconds",
  "profile_visits",
  "follows",
  "followers_total",
  "engagements",
  "engagement_rate",
  /** Starsign-owned: link-layer clicks and downstream conversions. */
  "tracked_clicks",
  "conversions",
  "conversion_value",
  /** AI-answer visibility: mentions of the brand in sampled prompts. */
  "ai_answer_mentions",
  "ai_answer_citations",
]);
export type MetricName = z.infer<typeof MetricName>;

export const MetricEntityType = z.enum(["post_variant", "social_account", "workspace", "trend_topic", "competitor", /* AI answer visibility: per tracked name */ "tracked_entity"]);
export type MetricEntityType = z.infer<typeof MetricEntityType>;

export const MetricInput = z.object({
  entityType: MetricEntityType,
  entityId: Id,
  metric: MetricName,
  value: z.number(),
  observedAt: Timestamp,
  source: z.string(),
});
export type MetricInput = z.infer<typeof MetricInput>;

/** Fixed offsets at which every published variant is snapshotted. The outcome ledger's spine. */
export const OUTCOME_OFFSETS = [
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
  { label: "72h", minutes: 4320 },
  { label: "7d", minutes: 10080 },
  { label: "30d", minutes: 43200 },
] as const;
export type OutcomeOffsetLabel = (typeof OUTCOME_OFFSETS)[number]["label"];
export const OutcomeOffsetLabel = z.enum(["1h", "6h", "24h", "72h", "7d", "30d"]);
