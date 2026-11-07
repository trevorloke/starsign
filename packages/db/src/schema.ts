import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
/** Mirrors @starsign/schema Actor without a cross-package import (db stays a leaf). */
export type ActorJson = { type: "human" | "operator" | "mcp" | "system"; id: string };
const now = () => ts("created_at").notNull().defaultNow();

// ---------------------------------------------------------------- tenancy

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  /** Brand profile: description, audience, topics of interest, tone notes. Grounds every model call. */
  profile: jsonb("profile").$type<Record<string, unknown>>().notNull().default({}),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: now(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  /** scrypt, encoded with its parameters (see core AuthService). Null: the person has not set a password (cannot sign in). */
  passwordHash: text("password_hash"),
  emailVerifiedAt: ts("email_verified_at"),
  createdAt: now(),
});

export const members = pgTable(
  "members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    userId: text("user_id").notNull().references(() => users.id),
    role: text("role").$type<"owner" | "approver" | "editor" | "viewer">().notNull(),
    createdAt: now(),
  },
  (t) => [uniqueIndex("members_ws_user").on(t.workspaceId, t.userId)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** sha256 of the secret; the secret is shown once. */
    keyHash: text("key_hash").notNull().unique(),
    name: text("name").notNull(),
    /** "human" keys act as this user; "agent" keys act as an MCP/operator actor. */
    actorType: text("actor_type").$type<"human" | "mcp" | "operator">().notNull(),
    actorId: text("actor_id").notNull(),
    role: text("role").$type<"owner" | "approver" | "editor" | "viewer">(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: now(),
  },
  (t) => [index("api_keys_ws").on(t.workspaceId)],
);

// ---------------------------------------------------------------- people: sessions, invites, password resets

/** Signed-in browser sessions. `id` is sha256 of the cookie token; the token itself is never stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    currentWorkspaceId: text("current_workspace_id").references(() => workspaces.id),
    createdAt: now(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    /** Sliding: pushed out 30 days whenever the session is used. */
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (t) => [index("sessions_user").on(t.userId, t.lastSeenAt)],
);

/** Workspace invites. Single use, seven days. Only the token's sha256 is stored. */
export const invites = pgTable(
  "invites",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    email: text("email").notNull(),
    role: text("role").$type<"owner" | "approver" | "editor" | "viewer">().notNull(),
    /** user id of the owner who sent it */
    invitedBy: text("invited_by").notNull(),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    acceptedBy: text("accepted_by"),
    /** An owner withdrew it; the link stops working at once. */
    revokedAt: ts("revoked_at"),
    createdAt: now(),
  },
  (t) => [index("invites_ws").on(t.workspaceId, t.createdAt)],
);

/** Password reset tokens. Single use, one hour. Only the token's sha256 is stored. */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: text("user_id").notNull().references(() => users.id),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: now(),
  },
  (t) => [index("password_resets_user").on(t.userId)],
);

// ---------------------------------------------------------------- accounts

export const socialAccounts = pgTable(
  "social_accounts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    network: text("network").notNull(),
    externalId: text("external_id").notNull(),
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    /** Which adapter publishes/reads for this account: "mock" | "bluesky" | "x" | "zernio" | ... */
    connector: text("connector").notNull(),
    /** AES-256-GCM ciphertext (base64) of the credential blob. Never stored in clear. */
    authCiphertext: text("auth_ciphertext"),
    status: text("status").$type<"active" | "reauth_required" | "disabled">().notNull().default("active"),
    /** Connector-specific non-secret config. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    lastIngestAt: ts("last_ingest_at"),
    createdAt: now(),
  },
  (t) => [uniqueIndex("social_accounts_ws_net_ext").on(t.workspaceId, t.network, t.externalId)],
);

// ---------------------------------------------------------------- policy

export const policies = pgTable(
  "policies",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    version: integer("version").notNull(),
    document: jsonb("document").$type<Record<string, unknown>>().notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: jsonb("created_by").$type<ActorJson>().notNull(),
    createdAt: now(),
  },
  (t) => [uniqueIndex("policies_ws_version").on(t.workspaceId, t.version)],
);

export const policyDecisions = pgTable(
  "policy_decisions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    policyVersion: integer("policy_version").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    verdict: text("verdict").notNull(),
    violations: jsonb("violations").$type<unknown[]>().notNull().default([]),
    actor: jsonb("actor").$type<ActorJson>().notNull(),
    createdAt: now(),
  },
  (t) => [index("policy_decisions_subject").on(t.subjectType, t.subjectId)],
);

// ---------------------------------------------------------------- content

export const posts = pgTable(
  "posts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    status: text("status").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    media: jsonb("media").$type<unknown[]>().notNull().default([]),
    scheduledAt: ts("scheduled_at"),
    publishedAt: ts("published_at"),
    actionClass: text("action_class").notNull().default("new_post"),
    createdBy: jsonb("created_by").$type<ActorJson>().notNull(),
    trendTopicId: text("trend_topic_id"),
    trendStageAtCreation: text("trend_stage_at_creation"),
    trendForecastId: text("trend_forecast_id"),
    experimentId: text("experiment_id"),
    experimentArm: text("experiment_arm"),
    disclosure: jsonb("disclosure").$type<Record<string, unknown>>(),
    evidence: jsonb("evidence").$type<unknown[]>().notNull().default([]),
    policyDecision: jsonb("policy_decision").$type<Record<string, unknown>>(),
    createdAt: now(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("posts_ws_status").on(t.workspaceId, t.status), index("posts_ws_sched").on(t.workspaceId, t.scheduledAt)],
);

export const postVariants = pgTable(
  "post_variants",
  {
    id: text("id").primaryKey(),
    postId: text("post_id").notNull().references(() => posts.id),
    socialAccountId: text("social_account_id").notNull().references(() => socialAccounts.id),
    network: text("network").notNull(),
    text: text("text").notNull(),
    media: jsonb("media").$type<unknown[]>().notNull().default([]),
    thread: jsonb("thread").$type<string[]>().notNull().default([]),
    options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
    replyToExternalId: text("reply_to_external_id"),
    status: text("status").notNull().default("pending"),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    publishedAt: ts("published_at"),
    error: text("error"),
    attemptCount: integer("attempt_count").notNull().default(0),
  },
  (t) => [index("post_variants_post").on(t.postId), index("post_variants_account").on(t.socialAccountId)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    postId: text("post_id").notNull().references(() => posts.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    state: text("state").notNull(),
    requestedBy: jsonb("requested_by").$type<ActorJson>().notNull(),
    decidedBy: jsonb("decided_by").$type<ActorJson>(),
    decidedAt: ts("decided_at"),
    note: text("note"),
    createdAt: now(),
  },
  (t) => [index("approvals_post").on(t.postId), index("approvals_ws_state").on(t.workspaceId, t.state)],
);

/** The training signal: what a human changed in a draft before it went out. */
export const approvalDiffs = pgTable(
  "approval_diffs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    postId: text("post_id").notNull().references(() => posts.id),
    variantId: text("variant_id").references(() => postVariants.id),
    beforeText: text("before_text").notNull(),
    afterText: text("after_text").notNull(),
    /** Who wrote the before (operator/mcp/human) and who edited. */
    draftedBy: jsonb("drafted_by").$type<ActorJson>().notNull(),
    editedBy: jsonb("edited_by").$type<ActorJson>().notNull(),
    createdAt: now(),
  },
  (t) => [index("approval_diffs_ws").on(t.workspaceId)],
);

export const experiments = pgTable("experiments", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  hypothesis: text("hypothesis").notNull(),
  status: text("status").$type<"draft" | "running" | "concluded">().notNull().default("draft"),
  arms: jsonb("arms").$type<{ key: string; description: string }[]>().notNull().default([]),
  primaryMetric: text("primary_metric").notNull().default("engagements"),
  result: jsonb("result").$type<Record<string, unknown>>(),
  createdAt: now(),
});

// ---------------------------------------------------------------- listening

export const streams = pgTable("streams", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  query: jsonb("query").$type<Record<string, unknown>>().notNull(),
  createdAt: now(),
});

export const activities = pgTable(
  "activities",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    socialAccountId: text("social_account_id").references(() => socialAccounts.id),
    network: text("network").notNull(),
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    authorHandle: text("author_handle"),
    authorName: text("author_name"),
    text: text("text"),
    url: text("url"),
    parentExternalId: text("parent_external_id"),
    occurredAt: ts("occurred_at").notNull(),
    ingestedAt: ts("ingested_at").notNull().defaultNow(),
    sentiment: doublePrecision("sentiment"),
    matchedStreams: jsonb("matched_streams").$type<string[]>().notNull().default([]),
    rawEventId: text("raw_event_id"),
    conversationId: text("conversation_id"),
    conversationName: text("conversation_name"),
    conversationType: text("conversation_type").$type<"group" | "channel" | "direct">(),
    /** ISO 639-1 (or the platform's BCP-47 tag). Null: unknown (too short, emoji only). */
    lang: text("lang"),
    /** Into the workspace's home language; derived, re-creatable. */
    translation: text("translation"),
    translationLang: text("translation_lang"),
    translatedAt: ts("translated_at"),
  },
  (t) => [
    uniqueIndex("activities_ws_net_ext").on(t.workspaceId, t.network, t.externalId),
    index("activities_ws_time").on(t.workspaceId, t.occurredAt),
    index("activities_ws_lang").on(t.workspaceId, t.lang, t.occurredAt),
    index("activities_ws_conv").on(t.workspaceId, t.conversationId, t.occurredAt),
  ],
);

// ---------------------------------------------------------------- measurement

/** Time series. Hypertable when TimescaleDB is present; plain indexed table otherwise. No PK by design. */
export const metrics = pgTable(
  "metrics",
  {
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    metric: text("metric").notNull(),
    value: doublePrecision("value").notNull(),
    observedAt: ts("observed_at").notNull(),
    source: text("source").notNull(),
  },
  (t) => [index("metrics_entity_time").on(t.entityType, t.entityId, t.metric, t.observedAt)],
);

export const postOutcomes = pgTable(
  "post_outcomes",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    postId: text("post_id").notNull().references(() => posts.id),
    variantId: text("variant_id").notNull().references(() => postVariants.id),
    offsetLabel: text("offset_label").notNull(),
    dueAt: ts("due_at").notNull(),
    capturedAt: ts("captured_at"),
    metrics: jsonb("metrics").$type<Record<string, number>>(),
    status: text("status").$type<"due" | "captured" | "skipped">().notNull().default("due"),
  },
  (t) => [uniqueIndex("post_outcomes_variant_offset").on(t.variantId, t.offsetLabel), index("post_outcomes_due").on(t.status, t.dueAt)],
);

// ---------------------------------------------------------------- trends

export const trendTopics = pgTable(
  "trend_topics",
  {
    id: text("id").primaryKey(),
    /** null = global topic shared across workspaces */
    workspaceId: text("workspace_id").references(() => workspaces.id),
    name: text("name").notNull(),
    keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
    relevance: doublePrecision("relevance"),
    createdAt: now(),
  },
  (t) => [index("trend_topics_ws").on(t.workspaceId)],
);

export const trendPoints = pgTable(
  "trend_points",
  {
    topicId: text("topic_id").notNull().references(() => trendTopics.id),
    source: text("source").notNull(),
    region: text("region").notNull().default("global"),
    value: doublePrecision("value").notNull(),
    observedAt: ts("observed_at").notNull(),
  },
  (t) => [index("trend_points_topic_time").on(t.topicId, t.source, t.observedAt)],
);

export const trendForecasts = pgTable(
  "trend_forecasts",
  {
    id: text("id").primaryKey(),
    topicId: text("topic_id").notNull().references(() => trendTopics.id),
    computedAt: ts("computed_at").notNull().defaultNow(),
    stage: text("stage").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    velocity: doublePrecision("velocity").notNull(),
    acceleration: doublePrecision("acceleration").notNull(),
    hoursToPeak: doublePrecision("hours_to_peak"),
    horizonHours: integer("horizon_hours").notNull(),
    curve: jsonb("curve").$type<unknown[]>().notNull(),
    modelVersion: text("model_version").notNull(),
    sourceAgreement: doublePrecision("source_agreement"),
    sources: jsonb("sources").$type<string[]>().notNull().default([]),
  },
  (t) => [index("trend_forecasts_topic_time").on(t.topicId, t.computedAt)],
);

/** The join nobody else has: which post rode which topic, at what stage, against which forecast. */
export const trendActions = pgTable(
  "trend_actions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    postId: text("post_id").notNull().references(() => posts.id),
    topicId: text("topic_id").notNull().references(() => trendTopics.id),
    stageAtAction: text("stage_at_action").notNull(),
    forecastId: text("forecast_id"),
    createdAt: now(),
  },
  (t) => [index("trend_actions_topic").on(t.topicId), index("trend_actions_ws").on(t.workspaceId)],
);

// ---------------------------------------------------------------- embeddings (pgvector)

export const embeddings = pgTable(
  "embeddings",
  {
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    model: text("model").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    createdAt: now(),
  },
  (t) => [primaryKey({ columns: [t.entityType, t.entityId, t.model] })],
);

// ---------------------------------------------------------------- event store (append-only)

export const rawEvents = pgTable(
  "raw_events",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    workspaceId: text("workspace_id"),
    externalId: text("external_id"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    payload: jsonb("payload").notNull(),
    /** sha256 of canonical payload; lets ingestion skip exact duplicates. */
    hash: text("hash").notNull(),
  },
  (t) => [index("raw_events_source_time").on(t.source, t.receivedAt), index("raw_events_hash").on(t.hash)],
);

export const ledgerEvents = pgTable(
  "ledger_events",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    workspaceId: text("workspace_id").notNull(),
    type: text("type").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    actor: jsonb("actor").$type<ActorJson>().notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
  },
  (t) => [index("ledger_ws_time").on(t.workspaceId, t.occurredAt), index("ledger_subject").on(t.subjectType, t.subjectId)],
);

// ---------------------------------------------------------------- operators

export const operatorRuns = pgTable(
  "operator_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    operator: text("operator").notNull(),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    status: text("status").$type<"running" | "succeeded" | "failed">().notNull().default("running"),
    summary: text("summary"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    error: text("error"),
  },
  (t) => [index("operator_runs_ws").on(t.workspaceId, t.startedAt)],
);

export const briefs = pgTable("briefs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  periodStart: ts("period_start").notNull(),
  periodEnd: ts("period_end").notNull(),
  contentMd: text("content_md").notNull(),
  evidence: jsonb("evidence").$type<unknown[]>().notNull().default([]),
  runId: text("run_id"),
  createdAt: now(),
});

export const alerts = pgTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    kind: text("kind").notNull(),
    severity: text("severity").$type<"info" | "attention" | "urgent">().notNull().default("attention"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    evidence: jsonb("evidence").$type<unknown[]>().notNull().default([]),
    topicId: text("topic_id"),
    acknowledgedAt: ts("acknowledged_at"),
    createdAt: now(),
  },
  (t) => [index("alerts_ws").on(t.workspaceId, t.createdAt)],
);

/** Uploaded media. Files live in the storage driver (local disk or S3-compatible); rows describe them. */
export const mediaAssets = pgTable(
  "media_assets",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    storageKey: text("storage_key").notNull().unique(),
    url: text("url").notNull(),
    kind: text("kind").$type<"image" | "video" | "gif" | "document">().notNull(),
    mime: text("mime").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    width: integer("width"),
    height: integer("height"),
    durationSeconds: doublePrecision("duration_seconds"),
    sha256: text("sha256").notNull(),
    originalName: text("original_name"),
    alt: text("alt"),
    uploadedBy: jsonb("uploaded_by").$type<ActorJson>().notNull(),
    createdAt: now(),
  },
  (t) => [index("media_assets_ws").on(t.workspaceId, t.createdAt), index("media_assets_sha").on(t.workspaceId, t.sha256)],
);

// ---------------------------------------------------------------- the tracker: organisations and people

/** A named organisation (party, brand, company) or person (candidate, spokesperson, creator, individual brand). */
export const trackedEntities = pgTable(
  "tracked_entities",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    kind: text("kind").$type<"organization" | "person">().notNull(),
    name: text("name").notNull(),
    role: text("role"),
    parentId: text("parent_id"),
    relation: text("relation").$type<"own" | "client" | "prospect" | "competitor" | "opponent" | "watch">().notNull().default("watch"),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    handles: jsonb("handles").$type<Record<string, string[]>>().notNull().default({}),
    context: jsonb("context").$type<string[]>().notNull().default([]),
    exclude: jsonb("exclude").$type<string[]>().notNull().default([]),
    wikipedia: jsonb("wikipedia").$type<string[]>().notNull().default([]),
    trendTopicId: text("trend_topic_id"),
    notes: text("notes"),
    /** Search public posts and news for this name (the tracker's public scan). */
    scanPublic: boolean("scan_public").notNull().default(true),
    /** Per search source: when it last ran for this entity. */
    scanState: jsonb("scan_state").$type<Record<string, string>>().notNull().default({}),
    createdBy: jsonb("created_by").$type<ActorJson>().notNull(),
    createdAt: now(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    archivedAt: ts("archived_at"),
  },
  (t) => [index("tracked_entities_ws").on(t.workspaceId, t.archivedAt), index("tracked_entities_parent").on(t.parentId)],
);

/** Which messages mention (or were written by) which tracked entity. Derived from activities; re-creatable. */
export const entityMentions = pgTable(
  "entity_mentions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    entityId: text("entity_id").notNull().references(() => trackedEntities.id),
    activityId: text("activity_id").notNull().references(() => activities.id),
    how: text("how").$type<"name" | "handle" | "author">().notNull(),
    term: text("term"),
    network: text("network").notNull(),
    lang: text("lang"),
    authorHandle: text("author_handle"),
    occurredAt: ts("occurred_at").notNull(),
    createdAt: now(),
  },
  (t) => [uniqueIndex("entity_mentions_once").on(t.entityId, t.activityId), index("entity_mentions_entity_time").on(t.entityId, t.occurredAt), index("entity_mentions_ws_time").on(t.workspaceId, t.occurredAt)],
);

// ---------------------------------------------------------------- owned measurement: links, clicks, conversions

/** Short links Starsign minted for published posts (or by hand). `target` is the destination with UTM tags. */
export const trackedLinks = pgTable(
  "tracked_links",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    slug: text("slug").notNull().unique(),
    destination: text("destination").notNull(),
    target: text("target").notNull(),
    postId: text("post_id").references(() => posts.id),
    variantId: text("variant_id").references(() => postVariants.id),
    network: text("network"),
    placement: text("placement").$type<"text" | "thread" | "link" | "first_comment" | "manual">().notNull().default("text"),
    utm: jsonb("utm").$type<Record<string, string>>().notNull().default({}),
    createdBy: jsonb("created_by").$type<ActorJson>().notNull(),
    createdAt: now(),
    disabledAt: ts("disabled_at"),
  },
  (t) => [index("tracked_links_ws").on(t.workspaceId, t.createdAt), index("tracked_links_variant").on(t.variantId)],
);

/** Append-only. One row per redirect; no raw IP (visitor_hash is salted daily). */
export const linkClicks = pgTable(
  "link_clicks",
  {
    id: text("id").primaryKey(),
    linkId: text("link_id").notNull().references(() => trackedLinks.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    variantId: text("variant_id"),
    network: text("network"),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    visitorHash: text("visitor_hash").notNull(),
    isBot: boolean("is_bot").notNull().default(false),
    device: text("device"),
    referrerHost: text("referrer_host"),
    country: text("country"),
  },
  (t) => [index("link_clicks_link").on(t.linkId, t.occurredAt), index("link_clicks_ws").on(t.workspaceId, t.occurredAt)],
);

/** Append-only. Downstream outcomes, attributed to a post through the click id when the reporter passes it. */
export const conversions = pgTable(
  "conversions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    clickId: text("click_id").references(() => linkClicks.id),
    linkId: text("link_id").references(() => trackedLinks.id),
    variantId: text("variant_id"),
    network: text("network"),
    name: text("name").notNull(),
    value: doublePrecision("value"),
    currency: text("currency"),
    externalId: text("external_id"),
    source: text("source").$type<"api" | "browser">().notNull(),
    occurredAt: ts("occurred_at").notNull(),
    createdAt: now(),
  },
  (t) => [index("conversions_ws").on(t.workspaceId, t.occurredAt), index("conversions_variant").on(t.variantId)],
);

/** Pending OAuth authorizations (PKCE). The verifier is encrypted; rows expire after ten minutes. */
export const oauthStates = pgTable("oauth_states", {
  state: text("state").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  connector: text("connector").notNull(),
  network: text("network").notNull(),
  verifierCiphertext: text("verifier_ciphertext").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  actor: jsonb("actor").$type<ActorJson>().notNull(),
  configCiphertext: text("config_ciphertext"),
  expiresAt: ts("expires_at").notNull(),
  createdAt: now(),
});

export const schemaMigrations = pgTable("schema_migrations", {
  name: text("name").primaryKey(),
  appliedAt: ts("applied_at").notNull().default(sql`now()`),
});

// ---- inbox workflow (migration 0011_inbox.sql) --------------------------------------------------

/** Shared work state over the live feed, one row per inbound activity. A conversation's state lives on its root row. */
export const inboxItems = pgTable(
  "inbox_items",
  {
    activityId: text("activity_id").primaryKey().references(() => activities.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** The conversation's first activity (itself for a root). */
    threadId: text("thread_id").notNull(),
    status: text("status").$type<"open" | "pending" | "done" | "spam">().notNull().default("open"),
    assignee: text("assignee"),
    priority: text("priority").$type<"normal" | "high" | "urgent">().notNull().default("normal"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    firstResponseAt: ts("first_response_at"),
    doneAt: ts("done_at"),
    snoozedUntil: ts("snoozed_until"),
    slaDueAt: ts("sla_due_at"),
    lastActivityAt: ts("last_activity_at").notNull(),
    messageCount: integer("message_count").notNull().default(1),
    createdAt: now(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("inbox_items_thread").on(t.threadId)],
);

/** Internal notes on a conversation, with @mentions of teammates. */
export const inboxNotes = pgTable(
  "inbox_notes",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    threadId: text("thread_id").notNull(),
    author: jsonb("author").$type<ActorJson>().notNull(),
    text: text("text").notNull(),
    mentions: jsonb("mentions").$type<string[]>().notNull().default([]),
    createdAt: now(),
    editedAt: ts("edited_at"),
  },
  (t) => [index("inbox_notes_thread").on(t.threadId, t.createdAt)],
);

/** Shared answers with variables, inserted into the reply box and edited before they go through the gate. */
export const savedReplies = pgTable(
  "saved_replies",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    name: text("name").notNull(),
    text: text("text").notNull(),
    lang: text("lang"),
    createdBy: jsonb("created_by").$type<ActorJson>().notNull(),
    createdAt: now(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("saved_replies_ws").on(t.workspaceId, t.name)],
);

/** Routing rules: conditions → assignee / round robin / tags / priority / spam. Evaluated in position order. */
export const inboxRules = pgTable(
  "inbox_rules",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    conditions: jsonb("conditions").$type<Record<string, unknown>>().notNull().default({}),
    actions: jsonb("actions").$type<Record<string, unknown>>().notNull().default({}),
    rrCursor: integer("rr_cursor").notNull().default(0),
    createdBy: jsonb("created_by").$type<ActorJson>().notNull(),
    createdAt: now(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("inbox_rules_ws").on(t.workspaceId, t.position)],
);

// ---------------------------------------------------------------- analytics & client reports (0010_reports.sql)

/** A saved client report: what to include, how it looks, who gets it and when. Rendered on demand. */
export const reports = pgTable(
  "reports",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    name: text("name").notNull(),
    period: text("period").$type<"last_7_days" | "last_30_days" | "calendar_month">().notNull().default("last_7_days"),
    sections: jsonb("sections").$type<string[]>().notNull().default([]),
    branding: jsonb("branding").$type<Record<string, unknown>>().notNull().default({}),
    recipients: jsonb("recipients").$type<string[]>().notNull().default([]),
    schedule: jsonb("schedule").$type<Record<string, unknown>>().notNull().default({ kind: "none" }),
    filters: jsonb("filters").$type<Record<string, unknown>>().notNull().default({}),
    intro: text("intro"),
    lastSentAt: ts("last_sent_at"),
    /** The period key last emailed by the schedule: a period is sent once. */
    lastSentPeriod: text("last_sent_period"),
    createdBy: jsonb("created_by").$type<ActorJson>().notNull(),
    createdAt: now(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("reports_ws").on(t.workspaceId, t.deletedAt)],
);

/** Read-only public links to a report. Only the token's sha256 is stored. */
export const reportShares = pgTable(
  "report_shares",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id").notNull().references(() => reports.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    tokenHash: text("token_hash").notNull().unique(),
    purpose: text("purpose").$type<"link" | "email">().notNull().default("link"),
    createdBy: jsonb("created_by").$type<ActorJson>().notNull(),
    createdAt: now(),
    revokedAt: ts("revoked_at"),
    lastViewedAt: ts("last_viewed_at"),
  },
  (t) => [index("report_shares_report").on(t.reportId, t.revokedAt)],
);
