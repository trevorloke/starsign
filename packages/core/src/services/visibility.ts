import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { metrics, visibilityAnswers, visibilityMentions, visibilityPrompts, visibilitySettings, workspaces, type VisibilityCitationJson } from "@starsign/db";
import { phraseRegex } from "@starsign/policy";
import { newId } from "@starsign/ledger";
import type { CoreContext, Principal } from "../context.ts";
import { CoreError } from "../errors.ts";
import { matchEntity, type EntityRow, type EntityService } from "./entities.ts";
import type { OpsService } from "./ops.ts";
import type { PolicyService } from "./policy.ts";

/**
 * AI answer visibility. People ask ChatGPT, Claude, Perplexity and Gemini instead of searching. A workspace keeps a
 * list of the questions its audience asks; on a cadence Starsign asks every configured engine each question, in
 * each language and region, and records the answer, its sources, and for every tracked name: mentioned or not, where
 * among the tracked names it came first, the tone, one line on what was said, and whether the sources were its own.
 *
 * Answers vary from run to run; one answer proves little. The report is built for trends: share of answers that
 * mention a name, average position and tone, by engine, language and day, against the previous period.
 *
 * Every model call (the engines and the judge) is recorded as a "visibility" operator run and counts toward the
 * workspace's monthly model spend cap; past the cap, the remaining questions are recorded as "capped".
 */

// ---------------------------------------------------------------- inputs

export const VisibilityEngineId = z.enum(["anthropic", "openai", "perplexity", "gemini", "fake"]);
export const VisibilityCadence = z.enum(["daily", "weekly"]);
const Lang = z.string().trim().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "a language code such as en, ja or pt-BR");
const Region = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, "a two-letter country code such as CA or JP")
  .transform((r) => r.toUpperCase());
const Question = z.string().trim().min(3).max(500);
const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .transform((d) => d.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""))
  .pipe(z.string().regex(/^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/, "a domain such as example.com"));

export const VisibilityPromptInput = z.object({
  question: Question,
  /** The question as a native speaker would ask it, per language. Languages without one get the question as written. */
  translations: z.record(Lang, Question).default({}),
  languages: z.array(Lang).min(1).max(6).default(["en"]),
  regions: z.array(Region).max(6).default([]),
  /** Tracked names to look for; empty = every tracked name. */
  entityIds: z.array(z.string().min(1).max(64)).max(50).default([]),
  cadence: VisibilityCadence.default("weekly"),
  notes: z.string().max(2000).optional(),
});
export type VisibilityPromptInput = z.input<typeof VisibilityPromptInput>;

/** A PATCH names only what changes (no defaults filled in). */
export const VisibilityPromptPatch = z
  .object({
    question: Question,
    translations: z.record(Lang, Question),
    languages: z.array(Lang).min(1).max(6),
    regions: z.array(Region).max(6),
    entityIds: z.array(z.string().min(1).max(64)).max(50),
    cadence: VisibilityCadence,
    notes: z.string().max(2000),
  })
  .partial();

export const VisibilitySettingsPatch = z
  .object({
    /** Engines to ask (owners); null = every engine this deployment has a key for. */
    engines: z.array(VisibilityEngineId).max(5).nullable(),
    /** Cadences editors may choose (owners). Weekly only keeps the cost down. */
    cadences: z.array(VisibilityCadence).min(1).max(2),
    /** Most active questions (owners). */
    maxPrompts: z.number().int().min(1).max(200),
    /** Each tracked name's own web domains (editors and up): citations to them count as the name's own. */
    domains: z.record(z.string().min(1).max(64), z.array(Domain).max(10)),
  })
  .partial();

export type VisibilityPromptRow = typeof visibilityPrompts.$inferSelect;
export type VisibilityAnswerRow = typeof visibilityAnswers.$inferSelect;
export type VisibilityMentionRow = typeof visibilityMentions.$inferSelect;

export interface VisibilitySettings {
  engines: string[] | null;
  cadences: ("daily" | "weekly")[];
  maxPrompts: number;
  domains: Record<string, string[]>;
}
const DEFAULT_SETTINGS: VisibilitySettings = { engines: null, cadences: ["daily", "weekly"], maxPrompts: 20, domains: {} };

// ---------------------------------------------------------------- the runtime (wired by a process that has keys)

/** One assistant to ask (structurally the same as @starsign/ai's AnswerEngine; core does not depend on ai). */
export interface VisibilityEngine {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  ask(prompt: string, opts: { lang: string; region: string | null }): Promise<{
    text: string;
    citations: { url: string; title?: string }[];
    model: string;
    usage?: { inputTokens: number; outputTokens: number; costUsd: number; searches?: number };
  }>;
}

export interface JudgeInput {
  workspace: string;
  question: string;
  lang: string;
  engine: string;
  answer: string;
  entities: { id: string; name: string; kind: "organization" | "person"; role?: string | null; relation: string; matched: string; facts?: string | null }[];
}
/** One model call per answer: tone, a one-line summary and possible inaccuracies, per name it mentions. */
export type AnswerJudge = (input: JudgeInput) => Promise<{ entities: { id: string; sentiment: number; summary: string; flags: string[] }[]; inputTokens?: number; outputTokens?: number; costUsd?: number }>;

export interface SuggestInput {
  workspace: { name: string; profile: Record<string, unknown> };
  entities: { name: string; kind: "organization" | "person"; role?: string | null; relation: string }[];
  languages: string[];
  existing: string[];
  count: number;
}
export type QuestionSuggester = (input: SuggestInput) => Promise<{ questions: { question: string; lang: string; why: string; names: string[] }[]; inputTokens?: number; outputTokens?: number; costUsd?: number }>;

export interface VisibilityRuntime {
  engines: VisibilityEngine[];
  /** Absent: answers are still checked for mentions, positions and sources, without tone or summaries. */
  judge: AnswerJudge | null;
}

export interface VisibilityRunResult {
  runId: string | null;
  prompts: number;
  answers: number;
  errors: number;
  capped: number;
  mentions: number;
  costUsd: number;
  /** Why nothing ran, when nothing did. */
  skipped?: string;
}

// ---------------------------------------------------------------- pure helpers

/** The scheduling period a run belongs to: the UTC day for daily questions, the ISO week for weekly ones. */
export function slotFor(cadence: "daily" | "weekly", at: Date): string {
  if (cadence === "daily") return at.toISOString().slice(0, 10);
  // ISO 8601 week: the week with the year's first Thursday is week 1.
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

type Matchable = Pick<EntityRow, "id" | "name" | "aliases" | "handles" | "context" | "exclude">;

function termsOf(e: Matchable): string[] {
  const handles = Object.values(e.handles ?? {})
    .flat()
    .map((h) => `@${h.replace(/^@/, "")}`);
  return [e.name, ...e.aliases, ...handles].filter((t) => t.trim().length > 0);
}

/** Where a phrase first appears (NFKC, case-insensitive, word edges where the script has them). -1 when absent. */
function firstIndex(text: string, terms: string[]): { index: number; term: string } | null {
  let best: { index: number; term: string } | null = null;
  for (const t of terms) {
    const m = phraseRegex(t).exec(text);
    if (m && (best === null || m.index < best.index)) best = { index: m.index, term: m[0] };
  }
  return best;
}

export interface DetectedMention {
  entityId: string;
  term: string;
  index: number;
  /** 1 = the first tracked name the answer names. */
  position: number;
}

/**
 * Which tracked names an answer mentions, and in what order. The tracker's own matcher decides (names, aliases in
 * every language and script, @handles, context and exclusion words); position ranks the names by first appearance.
 */
export function detectMentions(text: string, entities: Matchable[]): DetectedMention[] {
  const normalized = text.normalize("NFKC");
  const hits: Omit<DetectedMention, "position">[] = [];
  for (const e of entities) {
    const m = matchEntity(e, { network: "ai_answer", text: normalized, authorHandle: null });
    if (!m) continue;
    const at = firstIndex(normalized, termsOf(e));
    hits.push({ entityId: e.id, term: at?.term ?? m.term, index: at?.index ?? normalized.length });
  }
  hits.sort((a, b) => a.index - b.index);
  return hits.map((h, i) => ({ ...h, position: i + 1 }));
}

/** Every place a tracked name appears in the text, for highlighting. Non-overlapping, in order. */
export function highlightSpans(text: string, entities: Matchable[]): { start: number; end: number; entityId: string }[] {
  const spans: { start: number; end: number; entityId: string }[] = [];
  for (const e of entities) {
    for (const t of termsOf(e)) {
      const re = new RegExp(phraseRegex(t).source, "giu");
      for (const m of text.matchAll(re)) if (m[0]) spans.push({ start: m.index!, end: m.index! + m[0].length, entityId: e.id });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: typeof spans = [];
  for (const s of spans) if (!out.length || s.start >= out[out.length - 1]!.end) out.push(s);
  return out;
}

/** "https://www.example.com/a" → "example.com". Grounding redirects carry the real domain in the title. */
export function citationDomain(url: string, title?: string | null): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
  const t = (title ?? "").trim().toLowerCase().replace(/^www\./, "");
  if (/(^|\.)vertexaisearch\.cloud\.google\.com$/.test(host) && /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(t)) return t;
  return host;
}

export function ownerOf(domain: string, domains: Record<string, string[]>): string | null {
  if (!domain) return null;
  for (const [entityId, ds] of Object.entries(domains)) if (ds.some((d) => domain === d || domain.endsWith(`.${d}`))) return entityId;
  return null;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x: number | null, digits = 3) => (x === null ? null : Math.round(x * 10 ** digits) / 10 ** digits);

interface Agg {
  answers: number;
  mentioned: number;
  share: number | null;
  avgPosition: number | null;
  sentiment: number | null;
}
function aggregate(rows: Pick<VisibilityMentionRow, "mentioned" | "position" | "sentiment">[]): Agg {
  const hit = rows.filter((r) => r.mentioned);
  return {
    answers: rows.length,
    mentioned: hit.length,
    share: rows.length ? round(hit.length / rows.length) : null,
    avgPosition: round(avg(hit.flatMap((r) => (r.position === null ? [] : [r.position]))), 2),
    sentiment: round(avg(hit.flatMap((r) => (r.sentiment === null ? [] : [r.sentiment]))), 2),
  };
}

/** Most answer-text characters stored per answer. */
const MAX_TEXT = 20_000;
/** Most engine calls one workspace makes per hourly tick; the rest stay due for the next hour. */
const MAX_CALLS_PER_TICK = 60;

// ---------------------------------------------------------------- the service

export class VisibilityService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly entities: EntityService,
    private readonly ops: OpsService,
    private readonly policy: PolicyService,
  ) {}

  private requireEditor(p: Principal) {
    if (p.actor.type !== "human" || !p.role || !["owner", "approver", "editor"].includes(p.role)) {
      throw new CoreError("forbidden", "only people with the editor role or above manage AI visibility questions");
    }
  }

  private requireOwner(p: Principal) {
    if (p.actor.type !== "human" || p.role !== "owner") throw new CoreError("forbidden", "only an owner chooses engines and cadence limits");
  }

  // ------------------------------------------------------------ settings

  async settings(workspaceId: string): Promise<VisibilitySettings> {
    const [row] = await this.ctx.db.select().from(visibilitySettings).where(eq(visibilitySettings.workspaceId, workspaceId)).limit(1);
    if (!row) return { ...DEFAULT_SETTINGS, domains: {} };
    return { engines: row.engines ?? null, cadences: row.cadences, maxPrompts: row.maxPrompts, domains: row.domains };
  }

  async updateSettings(p: Principal, raw: unknown): Promise<VisibilitySettings> {
    const patch = VisibilitySettingsPatch.parse(raw);
    const ownerOnly = patch.engines !== undefined || patch.cadences !== undefined || patch.maxPrompts !== undefined;
    if (ownerOnly) this.requireOwner(p);
    else this.requireEditor(p);
    const current = await this.settings(p.workspaceId);
    let domains = current.domains;
    if (patch.domains) {
      const known = new Set((await this.entities.list(p.workspaceId, { includeArchived: true })).map((e) => e.id));
      for (const id of Object.keys(patch.domains)) if (!known.has(id)) throw new CoreError("invalid", `unknown tracked name ${id}`);
      domains = { ...current.domains };
      for (const [id, ds] of Object.entries(patch.domains)) {
        if (ds.length) domains[id] = [...new Set(ds)];
        else delete domains[id];
      }
    }
    const next: VisibilitySettings = {
      engines: patch.engines !== undefined ? (patch.engines ? [...new Set(patch.engines)] : null) : current.engines,
      cadences: patch.cadences ? [...new Set(patch.cadences)] : current.cadences,
      maxPrompts: patch.maxPrompts ?? current.maxPrompts,
      domains,
    };
    const values = { ...next, updatedBy: p.actor, updatedAt: this.ctx.now() };
    await this.ctx.db
      .insert(visibilitySettings)
      .values({ workspaceId: p.workspaceId, ...values })
      .onConflictDoUpdate({ target: visibilitySettings.workspaceId, set: values });
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "visibility.settings_updated", subjectType: "workspace", subjectId: p.workspaceId, actor: p.actor, data: { changed: Object.keys(patch) } });
    return next;
  }

  // ------------------------------------------------------------ questions

  async listPrompts(workspaceId: string, opts: { includeArchived?: boolean } = {}): Promise<VisibilityPromptRow[]> {
    const conds = [eq(visibilityPrompts.workspaceId, workspaceId)];
    if (!opts.includeArchived) conds.push(isNull(visibilityPrompts.archivedAt));
    return this.ctx.db.select().from(visibilityPrompts).where(and(...conds)).orderBy(visibilityPrompts.createdAt);
  }

  async getPrompt(workspaceId: string, id: string): Promise<VisibilityPromptRow> {
    const [row] = await this.ctx.db.select().from(visibilityPrompts).where(and(eq(visibilityPrompts.id, id), eq(visibilityPrompts.workspaceId, workspaceId))).limit(1);
    if (!row) throw new CoreError("not_found", `question ${id}`);
    return row;
  }

  private async checkEntities(workspaceId: string, ids: string[]) {
    if (!ids.length) return;
    const known = new Set((await this.entities.list(workspaceId)).map((e) => e.id));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) throw new CoreError("invalid", `not tracked: ${missing.join(", ")}`);
  }

  private checkCadence(settings: VisibilitySettings, cadence: "daily" | "weekly") {
    if (!settings.cadences.includes(cadence)) throw new CoreError("invalid", `an owner limited questions to ${settings.cadences.join(" or ")} runs`);
  }

  async createPrompt(p: Principal, raw: unknown): Promise<VisibilityPromptRow> {
    this.requireEditor(p);
    const input = VisibilityPromptInput.parse(raw);
    const settings = await this.settings(p.workspaceId);
    this.checkCadence(settings, input.cadence);
    const active = await this.listPrompts(p.workspaceId);
    if (active.length >= settings.maxPrompts) throw new CoreError("conflict", `this workspace asks at most ${settings.maxPrompts} questions; archive one or ask an owner to raise the limit`);
    await this.checkEntities(p.workspaceId, input.entityIds);
    const id = newId("vqp");
    const [row] = await this.ctx.db
      .insert(visibilityPrompts)
      .values({
        id,
        workspaceId: p.workspaceId,
        question: input.question,
        translations: input.translations,
        languages: [...new Set(input.languages)],
        regions: [...new Set(input.regions)],
        entityIds: [...new Set(input.entityIds)],
        cadence: input.cadence,
        notes: input.notes ?? null,
        createdBy: p.actor,
        createdAt: this.ctx.now(),
        updatedAt: this.ctx.now(),
      })
      .returning();
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "visibility.prompt_created", subjectType: "visibility_prompt", subjectId: id, actor: p.actor, data: { question: input.question, languages: input.languages, regions: input.regions, cadence: input.cadence } });
    return row!;
  }

  async updatePrompt(p: Principal, id: string, raw: unknown): Promise<VisibilityPromptRow> {
    this.requireEditor(p);
    const current = await this.getPrompt(p.workspaceId, id);
    if (current.archivedAt) throw new CoreError("conflict", "this question is archived");
    const patch = VisibilityPromptPatch.parse(raw);
    if (patch.cadence) this.checkCadence(await this.settings(p.workspaceId), patch.cadence);
    if (patch.entityIds) await this.checkEntities(p.workspaceId, patch.entityIds);
    const [row] = await this.ctx.db
      .update(visibilityPrompts)
      .set({
        ...(patch.question !== undefined ? { question: patch.question } : {}),
        ...(patch.translations !== undefined ? { translations: patch.translations } : {}),
        ...(patch.languages !== undefined ? { languages: [...new Set(patch.languages)] } : {}),
        ...(patch.regions !== undefined ? { regions: [...new Set(patch.regions)] } : {}),
        ...(patch.entityIds !== undefined ? { entityIds: [...new Set(patch.entityIds)] } : {}),
        ...(patch.cadence !== undefined ? { cadence: patch.cadence } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes || null } : {}),
        updatedAt: this.ctx.now(),
      })
      .where(eq(visibilityPrompts.id, id))
      .returning();
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "visibility.prompt_updated", subjectType: "visibility_prompt", subjectId: id, actor: p.actor, data: { changed: Object.keys(patch) } });
    return row!;
  }

  /** Stop asking; past answers stay in the report. */
  async archivePrompt(p: Principal, id: string): Promise<void> {
    this.requireEditor(p);
    const row = await this.getPrompt(p.workspaceId, id);
    if (row.archivedAt) return;
    await this.ctx.db.update(visibilityPrompts).set({ archivedAt: this.ctx.now() }).where(eq(visibilityPrompts.id, id));
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "visibility.prompt_archived", subjectType: "visibility_prompt", subjectId: id, actor: p.actor, data: { question: row.question } });
  }

  /** Questions whose period has no completed run yet. */
  async duePrompts(opts: { workspaceId?: string } = {}): Promise<VisibilityPromptRow[]> {
    const now = this.ctx.now();
    const conds = [isNull(visibilityPrompts.archivedAt)];
    if (opts.workspaceId) conds.push(eq(visibilityPrompts.workspaceId, opts.workspaceId));
    const rows = await this.ctx.db.select().from(visibilityPrompts).where(and(...conds)).orderBy(visibilityPrompts.lastRunAt);
    return rows.filter((r) => r.lastSlot !== slotFor(r.cadence, now));
  }

  // ------------------------------------------------------------ running

  /** The hourly job: every due question in every workspace (or one), within each workspace's spend cap. */
  async runDue(runtime: VisibilityRuntime, opts: { workspaceId?: string } = {}): Promise<VisibilityRunResult[]> {
    const due = await this.duePrompts(opts);
    const byWs = new Map<string, VisibilityPromptRow[]>();
    for (const r of due) byWs.set(r.workspaceId, [...(byWs.get(r.workspaceId) ?? []), r]);
    const out: VisibilityRunResult[] = [];
    for (const [ws, prompts] of byWs) {
      try {
        out.push(await this.run(ws, prompts, runtime, (pr) => slotFor(pr.cadence, this.ctx.now())));
      } catch (e) {
        console.error(`[visibility] ${ws} failed:`, (e as Error).message);
      }
    }
    return out;
  }

  /** "Run now" on one question: a fresh sample outside the schedule, which also counts for the current period. */
  async runNow(p: Principal, promptId: string, runtime: VisibilityRuntime): Promise<VisibilityRunResult> {
    this.requireEditor(p);
    const prompt = await this.getPrompt(p.workspaceId, promptId);
    if (prompt.archivedAt) throw new CoreError("conflict", "this question is archived");
    const slot = `manual:${this.ctx.now().toISOString().slice(0, 16)}`;
    return this.run(p.workspaceId, [prompt], runtime, () => slot, { maxCalls: 48 });
  }

  private async run(workspaceId: string, prompts: VisibilityPromptRow[], runtime: VisibilityRuntime, slotOf: (p: VisibilityPromptRow) => string, opts: { maxCalls?: number } = {}): Promise<VisibilityRunResult> {
    const result: VisibilityRunResult = { runId: null, prompts: 0, answers: 0, errors: 0, capped: 0, mentions: 0, costUsd: 0 };
    const settings = await this.settings(workspaceId);
    const engines = runtime.engines.filter((e) => settings.engines === null || settings.engines.includes(e.id));
    if (engines.length === 0) return { ...result, skipped: "no answer engine is configured" };
    const tracked = await this.entities.list(workspaceId);
    const [ws] = await this.ctx.db.select({ name: workspaces.name, profile: workspaces.profile }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    const policy = await this.policy.getActive(workspaceId);
    const cap = policy.spendCaps.modelUsdMonthly;
    const spentBefore = await this.ops.modelSpendThisMonth(workspaceId, this.ctx.now());
    const overCap = () => spentBefore + result.costUsd >= cap;
    let inputTokens = 0;
    let outputTokens = 0;
    let calls = 0;
    const maxCalls = opts.maxCalls ?? MAX_CALLS_PER_TICK;
    const perEntity = new Map<string, { mentions: number; ownCitations: number }>();

    const runId = await this.ops.startRun(workspaceId, "visibility");
    result.runId = runId;
    try {
      for (const prompt of prompts) {
        const slot = slotOf(prompt);
        const scope = prompt.entityIds.length ? tracked.filter((e) => prompt.entityIds.includes(e.id)) : tracked;
        const regions = prompt.regions.length ? prompt.regions : [""];
        const combos = engines.flatMap((engine) => prompt.languages.flatMap((lang) => regions.map((region) => ({ engine, lang, region }))));
        const done = new Set(
          (await this.ctx.db.select({ engine: visibilityAnswers.engine, lang: visibilityAnswers.lang, region: visibilityAnswers.region }).from(visibilityAnswers).where(and(eq(visibilityAnswers.promptId, prompt.id), eq(visibilityAnswers.slot, slot)))).map(
            (r) => `${r.engine}|${r.lang}|${r.region}`,
          ),
        );
        let touched = false;
        for (const { engine, lang, region } of combos) {
          if (done.has(`${engine.id}|${lang}|${region}`)) continue;
          if (calls >= maxCalls) break;
          touched = true;
          const question = prompt.translations[lang] ?? prompt.question;
          const askedAt = this.ctx.now();
          const base = { id: newId("vqa"), workspaceId, promptId: prompt.id, runId, slot, engine: engine.id, lang, region, question, askedAt };
          if (overCap()) {
            const ins = await this.ctx.db.insert(visibilityAnswers).values({ ...base, status: "capped", model: engine.model, error: `monthly model spend cap of $${cap} reached` }).onConflictDoNothing().returning({ id: visibilityAnswers.id });
            if (ins.length) result.capped++;
            done.add(`${engine.id}|${lang}|${region}`);
            continue;
          }
          calls++;
          let answer: Awaited<ReturnType<VisibilityEngine["ask"]>>;
          try {
            answer = await engine.ask(question, { lang, region: region || null });
          } catch (e) {
            const ins = await this.ctx.db.insert(visibilityAnswers).values({ ...base, status: "error", model: engine.model, error: (e as Error).message.slice(0, 500) }).onConflictDoNothing().returning({ id: visibilityAnswers.id });
            if (ins.length) result.errors++;
            done.add(`${engine.id}|${lang}|${region}`);
            continue;
          }
          const callCost = answer.usage?.costUsd ?? 0;
          result.costUsd += callCost;
          inputTokens += answer.usage?.inputTokens ?? 0;
          outputTokens += answer.usage?.outputTokens ?? 0;
          const text = answer.text.slice(0, MAX_TEXT);
          const citations: VisibilityCitationJson[] = answer.citations.slice(0, 50).map((c) => {
            const domain = citationDomain(c.url, c.title);
            return { url: c.url, title: c.title ?? null, domain, ownerEntityId: ownerOf(domain, settings.domains) };
          });
          const found = detectMentions(text, scope);
          const byEntity = new Map(found.map((f) => [f.entityId, f]));

          // Tone and summary: one judge call per answer that mentions anything, inside the cap.
          let judged: Awaited<ReturnType<AnswerJudge>>["entities"] = [];
          let judgeCost = 0;
          if (found.length && runtime.judge && !overCap()) {
            try {
              const own = (r: string) => r === "own" || r === "client";
              const description = typeof ws?.profile?.description === "string" ? ws.profile.description : null;
              const res = await runtime.judge({
                workspace: ws?.name ?? "",
                question,
                lang,
                engine: engine.label,
                answer: text,
                entities: found.map((f) => {
                  const e = scope.find((x) => x.id === f.entityId)!;
                  return { id: e.id, name: e.name, kind: e.kind, role: e.role, relation: e.relation, matched: f.term, facts: own(e.relation) && e.kind === "organization" ? description : null };
                }),
              });
              judged = res.entities;
              judgeCost = res.costUsd ?? 0;
              inputTokens += res.inputTokens ?? 0;
              outputTokens += res.outputTokens ?? 0;
            } catch (e) {
              console.warn(`[visibility] judge failed for ${prompt.id}/${engine.id}: ${(e as Error).message}`);
            }
          }
          result.costUsd += judgeCost;
          const judgedById = new Map(judged.map((j) => [j.id, j]));

          const ins = await this.ctx.db
            .insert(visibilityAnswers)
            .values({ ...base, status: "ok", model: answer.model, text, citations, inputTokens: answer.usage?.inputTokens ?? 0, outputTokens: answer.usage?.outputTokens ?? 0, costUsd: callCost + judgeCost, judged: judged.length > 0 })
            .onConflictDoNothing()
            .returning({ id: visibilityAnswers.id });
          done.add(`${engine.id}|${lang}|${region}`);
          if (!ins.length) continue; // another run got there first
          result.answers++;
          if (scope.length) {
            await this.ctx.db
              .insert(visibilityMentions)
              .values(
                scope.map((e) => {
                  const f = byEntity.get(e.id);
                  const j = judgedById.get(e.id);
                  const ownCitations = citations.filter((c) => c.ownerEntityId === e.id).length;
                  const agg = perEntity.get(e.id) ?? { mentions: 0, ownCitations: 0 };
                  agg.mentions += f ? 1 : 0;
                  agg.ownCitations += ownCitations;
                  perEntity.set(e.id, agg);
                  return {
                    id: newId("vqm"),
                    workspaceId,
                    answerId: base.id,
                    promptId: prompt.id,
                    entityId: e.id,
                    engine: engine.id,
                    lang,
                    mentioned: !!f,
                    position: f?.position ?? null,
                    term: f?.term.slice(0, 200) ?? null,
                    sentiment: f && j ? j.sentiment : null,
                    summary: f && j ? j.summary : null,
                    flags: f && j ? j.flags : [],
                    ownCitations,
                    askedAt,
                  };
                }),
              )
              .onConflictDoNothing();
          }
          result.mentions += found.length;
        }
        // The period is done once every combination has an answer (ok, error or capped).
        if (combos.every((c) => done.has(`${c.engine.id}|${c.lang}|${c.region}`))) {
          await this.ctx.db.update(visibilityPrompts).set({ lastSlot: slotFor(prompt.cadence, this.ctx.now()), lastRunAt: this.ctx.now() }).where(eq(visibilityPrompts.id, prompt.id));
        }
        if (touched) result.prompts++;
      }

      // Canonical metrics, per tracked name per run: answers that mentioned it, citations of its own domains.
      const observedAt = this.ctx.now();
      const rows = [...perEntity.entries()].flatMap(([entityId, a]) => [
        { entityType: "tracked_entity", entityId, metric: "ai_answer_mentions", value: a.mentions, observedAt, source: `visibility:${runId}` },
        { entityType: "tracked_entity", entityId, metric: "ai_answer_citations", value: a.ownCitations, observedAt, source: `visibility:${runId}` },
      ]);
      if (rows.length) await this.ctx.db.insert(metrics).values(rows);

      const summary =
        result.answers === 0 && result.capped > 0
          ? `capped: monthly model spend cap reached ($${(spentBefore + result.costUsd).toFixed(2)} of $${cap}); ${result.capped} answer(s) skipped`
          : `asked ${result.prompts} question(s) on ${engines.length} engine(s): ${result.answers} answer(s), ${result.mentions} mention(s)${result.errors ? `, ${result.errors} error(s)` : ""}${result.capped ? `, ${result.capped} capped` : ""}`;
      await this.ops.finishRun(runId, { status: "succeeded", summary, inputTokens, outputTokens, costUsd: result.costUsd });
      await this.ctx.events.append({ workspaceId, type: "visibility.run_completed", subjectType: "operator_run", subjectId: runId, actor: { type: "operator", id: "visibility" }, data: { prompts: result.prompts, answers: result.answers, errors: result.errors, capped: result.capped, mentions: result.mentions, costUsd: result.costUsd } });
    } catch (e) {
      await this.ops.finishRun(runId, { status: "failed", error: (e as Error).message, summary: `${result.answers} answer(s) before failing`, inputTokens, outputTokens, costUsd: result.costUsd });
      throw e;
    }
    return result;
  }

  /** Question ideas from the brand profile and tracked names, in the languages the team works in. Nothing is saved. */
  async suggest(p: Principal, suggester: QuestionSuggester, opts: { languages?: string[]; count?: number } = {}) {
    this.requireEditor(p);
    const [ws] = await this.ctx.db.select({ name: workspaces.name, profile: workspaces.profile }).from(workspaces).where(eq(workspaces.id, p.workspaceId)).limit(1);
    const tracked = await this.entities.list(p.workspaceId);
    const existing = (await this.listPrompts(p.workspaceId)).map((q) => q.question);
    const languages = [...new Set((opts.languages ?? []).map((l) => Lang.parse(l)))].slice(0, 6);
    const runId = await this.ops.startRun(p.workspaceId, "visibility");
    try {
      const res = await suggester({
        workspace: { name: ws?.name ?? "", profile: ws?.profile ?? {} },
        entities: tracked.slice(0, 40).map((e) => ({ name: e.name, kind: e.kind, role: e.role, relation: e.relation })),
        languages: languages.length ? languages : ["en"],
        existing,
        count: Math.min(Math.max(opts.count ?? 8, 1), 20),
      });
      await this.ops.finishRun(runId, { status: "succeeded", summary: `suggested ${res.questions.length} question(s)`, inputTokens: res.inputTokens ?? 0, outputTokens: res.outputTokens ?? 0, costUsd: res.costUsd ?? 0 });
      return { languages: languages.length ? languages : ["en"], questions: res.questions };
    } catch (e) {
      await this.ops.finishRun(runId, { status: "failed", error: (e as Error).message });
      throw e;
    }
  }

  // ------------------------------------------------------------ reading

  private async answerViews(workspaceId: string, rows: VisibilityAnswerRow[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const mentionRows = await this.ctx.db.select().from(visibilityMentions).where(inArray(visibilityMentions.answerId, ids));
    const tracked = await this.entities.list(workspaceId, { includeArchived: true });
    const byId = new Map(tracked.map((e) => [e.id, e]));
    const promptIds = [...new Set(rows.map((r) => r.promptId))];
    const prompts = new Map((await this.ctx.db.select({ id: visibilityPrompts.id, question: visibilityPrompts.question }).from(visibilityPrompts).where(inArray(visibilityPrompts.id, promptIds))).map((p) => [p.id, p.question]));
    return rows.map((a) => {
      const ms = mentionRows.filter((m) => m.answerId === a.id);
      const mentionedEntities = ms.filter((m) => m.mentioned).flatMap((m) => (byId.get(m.entityId) ? [byId.get(m.entityId)!] : []));
      return {
        id: a.id,
        promptId: a.promptId,
        prompt: prompts.get(a.promptId) ?? a.question,
        question: a.question,
        engine: a.engine,
        model: a.model,
        lang: a.lang,
        region: a.region || null,
        status: a.status,
        text: a.text,
        error: a.error,
        citations: a.citations,
        costUsd: a.costUsd,
        askedAt: a.askedAt.toISOString(),
        mentions: ms
          .map((m) => ({ entityId: m.entityId, name: byId.get(m.entityId)?.name ?? m.entityId, mentioned: m.mentioned, position: m.position, term: m.term, sentiment: m.sentiment, summary: m.summary, flags: m.flags, ownCitations: m.ownCitations }))
          .sort((x, y) => (x.position ?? 99) - (y.position ?? 99) || x.name.localeCompare(y.name)),
        highlights: a.text ? highlightSpans(a.text, mentionedEntities) : [],
      };
    });
  }

  /** Answers for drill-down, newest first: by question, engine, or tracked name (mentioning it, or not). */
  async answers(workspaceId: string, opts: { promptId?: string; engine?: string; entityId?: string; mentioned?: boolean; lang?: string; from?: Date; to?: Date; limit?: number } = {}) {
    const conds = [eq(visibilityAnswers.workspaceId, workspaceId)];
    if (opts.promptId) conds.push(eq(visibilityAnswers.promptId, opts.promptId));
    if (opts.engine) conds.push(eq(visibilityAnswers.engine, opts.engine));
    if (opts.lang) conds.push(eq(visibilityAnswers.lang, opts.lang));
    if (opts.from) conds.push(gte(visibilityAnswers.askedAt, opts.from));
    if (opts.to) conds.push(lte(visibilityAnswers.askedAt, opts.to));
    if (opts.entityId) {
      const ids = await this.ctx.db
        .select({ id: visibilityMentions.answerId })
        .from(visibilityMentions)
        .where(and(eq(visibilityMentions.workspaceId, workspaceId), eq(visibilityMentions.entityId, opts.entityId), eq(visibilityMentions.mentioned, opts.mentioned ?? true)))
        .orderBy(desc(visibilityMentions.askedAt))
        .limit(2000);
      if (!ids.length) return [];
      conds.push(inArray(visibilityAnswers.id, ids.map((r) => r.id)));
    }
    const rows = await this.ctx.db.select().from(visibilityAnswers).where(and(...conds)).orderBy(desc(visibilityAnswers.askedAt)).limit(Math.min(opts.limit ?? 50, 200));
    return this.answerViews(workspaceId, rows);
  }

  /**
   * Per tracked name over [from, to]: the share of answers that mention it, average position among tracked names,
   * tone, by engine, by language and by day, own-domain citations, and the same numbers for the period before
   * (equal length) so the change is visible. Plus the domains answers cite (own vs others) and the latest answers.
   */
  async report(workspaceId: string, from: Date, to: Date) {
    const span = Math.max(to.getTime() - from.getTime(), 3_600_000);
    const prevFrom = new Date(from.getTime() - span);
    const tracked = await this.entities.list(workspaceId);
    const rows = await this.ctx.db
      .select({
        entityId: visibilityMentions.entityId,
        engine: visibilityMentions.engine,
        lang: visibilityMentions.lang,
        mentioned: visibilityMentions.mentioned,
        position: visibilityMentions.position,
        sentiment: visibilityMentions.sentiment,
        ownCitations: visibilityMentions.ownCitations,
        flags: visibilityMentions.flags,
        askedAt: visibilityMentions.askedAt,
      })
      .from(visibilityMentions)
      .where(and(eq(visibilityMentions.workspaceId, workspaceId), gte(visibilityMentions.askedAt, prevFrom), lte(visibilityMentions.askedAt, to)))
      .limit(100_000);
    const inCurrent = (at: Date) => at.getTime() >= from.getTime();
    const group = <T,>(xs: T[], key: (x: T) => string) => {
      const m = new Map<string, T[]>();
      for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
      return m;
    };
    const byEntity = group(rows, (r) => r.entityId);
    const delta = (a: number | null, b: number | null, digits = 3) => (a === null || b === null ? null : round(a - b, digits));

    const entities = tracked.map((e) => {
      const all = byEntity.get(e.id) ?? [];
      const cur = all.filter((r) => inCurrent(r.askedAt));
      const prev = all.filter((r) => !inCurrent(r.askedAt));
      const now = aggregate(cur);
      const before = aggregate(prev);
      return {
        id: e.id,
        name: e.name,
        kind: e.kind,
        role: e.role,
        relation: e.relation,
        parentId: e.parentId,
        ...now,
        ownCitations: cur.reduce((n, r) => n + r.ownCitations, 0),
        flagged: cur.filter((r) => r.flags.length > 0).length,
        previous: before,
        change: { share: delta(now.share, before.share), avgPosition: delta(now.avgPosition, before.avgPosition, 2), sentiment: delta(now.sentiment, before.sentiment, 2) },
        byEngine: [...group(cur, (r) => r.engine).entries()].map(([engine, xs]) => ({ engine, ...aggregate(xs) })).sort((a, b) => a.engine.localeCompare(b.engine)),
        byLanguage: [...group(cur, (r) => r.lang).entries()].map(([lang, xs]) => ({ lang, ...aggregate(xs) })).sort((a, b) => b.answers - a.answers),
        trend: [...group(cur, (r) => r.askedAt.toISOString().slice(0, 10)).entries()].map(([day, xs]) => ({ day, ...aggregate(xs) })).sort((a, b) => a.day.localeCompare(b.day)),
      };
    });

    const answers = await this.ctx.db
      .select({ id: visibilityAnswers.id, promptId: visibilityAnswers.promptId, engine: visibilityAnswers.engine, lang: visibilityAnswers.lang, status: visibilityAnswers.status, citations: visibilityAnswers.citations, costUsd: visibilityAnswers.costUsd })
      .from(visibilityAnswers)
      .where(and(eq(visibilityAnswers.workspaceId, workspaceId), gte(visibilityAnswers.askedAt, from), lte(visibilityAnswers.askedAt, to)))
      .limit(50_000);
    const ok = answers.filter((a) => a.status === "ok");
    const domains = new Map<string, { domain: string; n: number; answers: Set<string>; ownerEntityId: string | null }>();
    for (const a of ok) {
      for (const c of a.citations) {
        if (!c.domain) continue;
        const d = domains.get(c.domain) ?? { domain: c.domain, n: 0, answers: new Set<string>(), ownerEntityId: c.ownerEntityId };
        d.n++;
        d.answers.add(a.id);
        d.ownerEntityId ??= c.ownerEntityId;
        domains.set(c.domain, d);
      }
    }
    const domainRows = [...domains.values()].map((d) => ({ domain: d.domain, citations: d.n, answers: d.answers.size, ownerEntityId: d.ownerEntityId })).sort((a, b) => b.citations - a.citations || a.domain.localeCompare(b.domain));
    const totalCitations = domainRows.reduce((n, d) => n + d.citations, 0);
    const ownCitations = domainRows.filter((d) => d.ownerEntityId).reduce((n, d) => n + d.citations, 0);

    const latestRows = await this.ctx.db
      .select()
      .from(visibilityAnswers)
      .where(and(eq(visibilityAnswers.workspaceId, workspaceId), eq(visibilityAnswers.status, "ok"), gte(visibilityAnswers.askedAt, from), lte(visibilityAnswers.askedAt, to)))
      .orderBy(desc(visibilityAnswers.askedAt))
      .limit(6);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      previous: { from: prevFrom.toISOString(), to: from.toISOString() },
      totals: {
        answers: ok.length,
        prompts: new Set(ok.map((a) => a.promptId)).size,
        errors: answers.filter((a) => a.status === "error").length,
        capped: answers.filter((a) => a.status === "capped").length,
        costUsd: round(answers.reduce((n, a) => n + a.costUsd, 0), 4) ?? 0,
        byEngine: [...group(ok, (a) => a.engine).entries()].map(([engine, xs]) => ({ engine, answers: xs.length })).sort((a, b) => a.engine.localeCompare(b.engine)),
        byLanguage: [...group(ok, (a) => a.lang).entries()].map(([lang, xs]) => ({ lang, answers: xs.length })).sort((a, b) => b.answers - a.answers),
      },
      entities,
      citations: {
        total: totalCitations,
        own: ownCitations,
        ownShare: totalCitations ? round(ownCitations / totalCitations) : null,
        ownDomains: domainRows.filter((d) => d.ownerEntityId).slice(0, 15),
        otherDomains: domainRows.filter((d) => !d.ownerEntityId).slice(0, 15),
      },
      latest: await this.answerViews(workspaceId, latestRows),
    };
  }
}
