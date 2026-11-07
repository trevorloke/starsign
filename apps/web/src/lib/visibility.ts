/** AI answer visibility: the shapes /v1/visibility/* returns, and small helpers for showing them. */

export type VisEngineId = "anthropic" | "openai" | "perplexity" | "gemini" | "fake";
export type VisCadence = "daily" | "weekly";

export interface VisEngine {
  id: VisEngineId;
  label: string;
  /** This server has the engine's key. */
  configured: boolean;
  /** Configured and not turned off by an owner for this workspace. */
  enabled: boolean;
  envVar: string;
  modelEnvVar: string | null;
  model: string;
  /** Whether the engine's cost is known and counted toward the spend cap. */
  priced: boolean;
}

export interface VisSettings {
  /** null: every configured engine. */
  engines: string[] | null;
  cadences: VisCadence[];
  maxPrompts: number;
  /** Tracked name id → its own web domains. */
  domains: Record<string, string[]>;
}

export interface VisSettingsResponse {
  settings: VisSettings;
  engines: VisEngine[];
  /** A model is configured to read answers for tone and summaries. */
  judge: boolean;
}

export type VisSettingsPatch = Partial<VisSettings>;

export interface VisPrompt {
  id: string;
  question: string;
  translations: Record<string, string>;
  languages: string[];
  regions: string[];
  /** Empty: every tracked name. */
  entityIds: string[];
  cadence: VisCadence;
  notes: string | null;
  lastSlot: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** Not yet asked in the current day or week. */
  due: boolean;
}

export interface VisPromptInput {
  question: string;
  translations?: Record<string, string>;
  languages?: string[];
  regions?: string[];
  entityIds?: string[];
  cadence?: VisCadence;
  notes?: string;
}

export interface VisAgg {
  answers: number;
  mentioned: number;
  /** 0..1 of answers that mention it. */
  share: number | null;
  avgPosition: number | null;
  /** -1..1 */
  sentiment: number | null;
}

export interface VisEntityRow extends VisAgg {
  id: string;
  name: string;
  kind: "organization" | "person";
  role: string | null;
  relation: "own" | "client" | "prospect" | "competitor" | "opponent" | "watch";
  parentId: string | null;
  ownCitations: number;
  flagged: number;
  previous: VisAgg;
  change: { share: number | null; avgPosition: number | null; sentiment: number | null };
  byEngine: (VisAgg & { engine: string })[];
  byLanguage: (VisAgg & { lang: string })[];
  trend: (VisAgg & { day: string })[];
}

export interface VisCitation {
  url: string;
  title: string | null;
  domain: string;
  ownerEntityId: string | null;
}

export interface VisMention {
  entityId: string;
  name: string;
  mentioned: boolean;
  position: number | null;
  term: string | null;
  sentiment: number | null;
  summary: string | null;
  flags: string[];
  ownCitations: number;
}

export interface VisAnswer {
  id: string;
  promptId: string;
  /** The question as saved. */
  prompt: string;
  /** Exactly what was sent (the native question for that language). */
  question: string;
  engine: string;
  model: string | null;
  lang: string;
  region: string | null;
  status: "ok" | "error" | "capped";
  text: string | null;
  error: string | null;
  citations: VisCitation[];
  costUsd: number;
  askedAt: string;
  mentions: VisMention[];
  highlights: { start: number; end: number; entityId: string }[];
}

export interface VisDomain {
  domain: string;
  citations: number;
  answers: number;
  ownerEntityId: string | null;
}

export interface VisReport {
  from: string;
  to: string;
  previous: { from: string; to: string };
  totals: { answers: number; prompts: number; errors: number; capped: number; costUsd: number; byEngine: { engine: string; answers: number }[]; byLanguage: { lang: string; answers: number }[] };
  entities: VisEntityRow[];
  citations: { total: number; own: number; ownShare: number | null; ownDomains: VisDomain[]; otherDomains: VisDomain[] };
  latest: VisAnswer[];
  engines: VisEngine[];
}

export interface VisRunResult {
  runId: string | null;
  prompts: number;
  answers: number;
  errors: number;
  capped: number;
  mentions: number;
  costUsd: number;
}

export interface VisSuggestion {
  question: string;
  lang: string;
  why: string;
  names: string[];
}

export interface VisAnswersQuery {
  promptId?: string;
  engine?: string;
  entity?: string;
  /** With entity: false lists the answers that left it out. */
  mentioned?: boolean;
  lang?: string;
  limit?: number;
}

// ---------------------------------------------------------------- display helpers

export const ENGINE_LABEL: Record<string, string> = { anthropic: "Claude", openai: "ChatGPT", perplexity: "Perplexity", gemini: "Gemini", fake: "Demo engine" };
export const engineLabel = (id: string) => ENGINE_LABEL[id] ?? id;

/** 0.634 → "63%". */
export function sharePct(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${Math.round(x * 100)}%`;
}

/** A change in share as points: 0.08 → "+8 pts". */
export function sharePts(x: number | null | undefined): string | null {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const pts = Math.round(x * 100);
  if (pts === 0) return "no change";
  return `${pts > 0 ? "+" : "−"}${Math.abs(pts)} pts`;
}

/** -1..1 → a short word, matching the tracker's tone words. */
export function toneLabel(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return "—";
  if (s >= 0.25) return "Positive";
  if (s <= -0.25) return "Negative";
  return "Neutral";
}

export function toneClass(s: number | null | undefined): string {
  if (s === null || s === undefined) return "vis-tone-none";
  return s >= 0.25 ? "vis-tone-pos" : s <= -0.25 ? "vis-tone-neg" : "vis-tone-mid";
}

/** 1.4 → "#1.4"; null → "—". Lower is better. */
export function positionLabel(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "—";
  return `#${Number.isInteger(p) ? p : p.toFixed(1)}`;
}

/** Split an answer into plain and highlighted pieces, in order. */
export function highlightPieces(text: string, spans: VisAnswer["highlights"]): { text: string; entityId: string | null }[] {
  const out: { text: string; entityId: string | null }[] = [];
  let at = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.start < at || s.end > text.length) continue;
    if (s.start > at) out.push({ text: text.slice(at, s.start), entityId: null });
    out.push({ text: text.slice(s.start, s.end), entityId: s.entityId });
    at = s.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), entityId: null });
  return out;
}

export const VIS_PERIODS = [
  { id: "7d", days: 7, label: "7 days" },
  { id: "28d", days: 28, label: "28 days" },
  { id: "90d", days: 90, label: "90 days" },
] as const;
export type VisPeriodId = (typeof VIS_PERIODS)[number]["id"];
