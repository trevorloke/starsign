import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { trackedEntities, workspaces, type ActorJson } from "./schema.ts";

/** AI answer visibility (migration 0012_visibility.sql). Kept apart from schema.ts so parallel work does not collide. */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export interface VisibilityCitationJson {
  url: string;
  title: string | null;
  domain: string;
  /** The tracked name whose own domain this is, if any. */
  ownerEntityId: string | null;
}

export const visibilitySettings = pgTable("visibility_settings", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id),
  engines: jsonb("engines").$type<string[] | null>(),
  cadences: jsonb("cadences").$type<("daily" | "weekly")[]>().notNull().default(["daily", "weekly"]),
  maxPrompts: integer("max_prompts").notNull().default(20),
  domains: jsonb("domains").$type<Record<string, string[]>>().notNull().default({}),
  updatedBy: jsonb("updated_by").$type<ActorJson | null>(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const visibilityPrompts = pgTable(
  "visibility_prompts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    question: text("question").notNull(),
    translations: jsonb("translations").$type<Record<string, string>>().notNull().default({}),
    languages: jsonb("languages").$type<string[]>().notNull().default(["en"]),
    regions: jsonb("regions").$type<string[]>().notNull().default([]),
    entityIds: jsonb("entity_ids").$type<string[]>().notNull().default([]),
    cadence: text("cadence").$type<"daily" | "weekly">().notNull().default("weekly"),
    notes: text("notes"),
    lastSlot: text("last_slot"),
    lastRunAt: ts("last_run_at"),
    createdBy: jsonb("created_by").$type<ActorJson>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    archivedAt: ts("archived_at"),
  },
  (t) => [index("visibility_prompts_ws").on(t.workspaceId, t.archivedAt)],
);

export const visibilityAnswers = pgTable(
  "visibility_answers",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    promptId: text("prompt_id").notNull().references(() => visibilityPrompts.id),
    runId: text("run_id"),
    slot: text("slot").notNull(),
    engine: text("engine").notNull(),
    model: text("model"),
    lang: text("lang").notNull(),
    region: text("region").notNull().default(""),
    question: text("question").notNull(),
    status: text("status").$type<"ok" | "error" | "capped">().notNull(),
    text: text("text"),
    citations: jsonb("citations").$type<VisibilityCitationJson[]>().notNull().default([]),
    error: text("error"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    judged: boolean("judged").notNull().default(false),
    askedAt: ts("asked_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("visibility_answers_once").on(t.promptId, t.slot, t.engine, t.lang, t.region), index("visibility_answers_ws_time").on(t.workspaceId, t.askedAt)],
);

export const visibilityMentions = pgTable(
  "visibility_mentions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    answerId: text("answer_id").notNull().references(() => visibilityAnswers.id),
    promptId: text("prompt_id").notNull(),
    entityId: text("entity_id").notNull().references(() => trackedEntities.id),
    engine: text("engine").notNull(),
    lang: text("lang").notNull(),
    mentioned: boolean("mentioned").notNull(),
    position: integer("position"),
    term: text("term"),
    sentiment: doublePrecision("sentiment"),
    summary: text("summary"),
    flags: jsonb("flags").$type<string[]>().notNull().default([]),
    ownCitations: integer("own_citations").notNull().default(0),
    askedAt: ts("asked_at").notNull(),
  },
  (t) => [
    uniqueIndex("visibility_mentions_once").on(t.answerId, t.entityId),
    index("visibility_mentions_entity_time").on(t.entityId, t.askedAt),
    index("visibility_mentions_ws_time").on(t.workspaceId, t.askedAt),
  ],
);
