import { resolveModel } from "../anthropic.ts";
import { AnthropicAnswerEngine } from "./anthropic.ts";
import { FakeAnswerEngine } from "./fake.ts";
import { GEMINI_DEFAULT_MODEL, GeminiAnswerEngine } from "./gemini.ts";
import { OPENAI_DEFAULT_MODEL, OpenAIAnswerEngine } from "./openai.ts";
import { PERPLEXITY_DEFAULT_MODEL, PerplexityAnswerEngine } from "./perplexity.ts";
import type { AnswerEngine, AnswerEngineStatus, FetchLike } from "./types.ts";

export * from "./types.ts";
export * from "./anthropic.ts";
export * from "./openai.ts";
export * from "./perplexity.ts";
export * from "./gemini.ts";
export * from "./fake.ts";

const has = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;
const model = (v: string | undefined, fallback: string) => (has(v) ? v!.trim() : fallback);

/** Every engine Starsign knows, whether this deployment has its key, and which variable turns it on. */
export function answerEngineStatus(env: NodeJS.ProcessEnv = process.env): AnswerEngineStatus[] {
  return [
    { id: "anthropic", label: "Claude", configured: has(env.ANTHROPIC_API_KEY), envVar: "ANTHROPIC_API_KEY", modelEnvVar: "STARSIGN_MODEL", model: resolveModel(env), priced: true },
    { id: "openai", label: "ChatGPT", configured: has(env.OPENAI_API_KEY), envVar: "OPENAI_API_KEY", modelEnvVar: "OPENAI_ANSWER_MODEL", model: model(env.OPENAI_ANSWER_MODEL, OPENAI_DEFAULT_MODEL), priced: false },
    { id: "perplexity", label: "Perplexity", configured: has(env.PERPLEXITY_API_KEY), envVar: "PERPLEXITY_API_KEY", modelEnvVar: "PERPLEXITY_ANSWER_MODEL", model: model(env.PERPLEXITY_ANSWER_MODEL, PERPLEXITY_DEFAULT_MODEL), priced: false },
    { id: "gemini", label: "Gemini", configured: has(env.GEMINI_API_KEY), envVar: "GEMINI_API_KEY", modelEnvVar: "GEMINI_ANSWER_MODEL", model: model(env.GEMINI_ANSWER_MODEL, GEMINI_DEFAULT_MODEL), priced: false },
  ];
}

/**
 * The engines this deployment can ask, one per key present. With `STARSIGN_FAKE_AI=1` and no keys, one demo
 * engine, so the whole flow runs offline. Keys are read here and handed to each adapter; they are never logged.
 */
export function answerEnginesFromEnv(env: NodeJS.ProcessEnv = process.env, opts: { fetch?: FetchLike } = {}): AnswerEngine[] {
  const out: AnswerEngine[] = [];
  if (has(env.ANTHROPIC_API_KEY)) out.push(new AnthropicAnswerEngine({ model: resolveModel(env) }));
  if (has(env.OPENAI_API_KEY)) out.push(new OpenAIAnswerEngine({ apiKey: env.OPENAI_API_KEY!.trim(), model: model(env.OPENAI_ANSWER_MODEL, OPENAI_DEFAULT_MODEL), fetch: opts.fetch }));
  if (has(env.PERPLEXITY_API_KEY)) out.push(new PerplexityAnswerEngine({ apiKey: env.PERPLEXITY_API_KEY!.trim(), model: model(env.PERPLEXITY_ANSWER_MODEL, PERPLEXITY_DEFAULT_MODEL), fetch: opts.fetch }));
  if (has(env.GEMINI_API_KEY)) out.push(new GeminiAnswerEngine({ apiKey: env.GEMINI_API_KEY!.trim(), model: model(env.GEMINI_ANSWER_MODEL, GEMINI_DEFAULT_MODEL), fetch: opts.fetch }));
  if (out.length === 0 && env.STARSIGN_FAKE_AI === "1") out.push(new FakeAnswerEngine());
  return out.map((e) => (e.id === "anthropic" || e.id === "fake" ? e : withCostFloor(e, perCallEstimate(env))));
}

/** Default charge for an answer whose provider reports no price: a grounded answer with web search, on the high side. */
export const DEFAULT_ANSWER_CALL_COST_USD = 0.05;

function perCallEstimate(env: NodeJS.ProcessEnv): number {
  const v = Number(env.STARSIGN_ANSWER_CALL_COST_USD);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_ANSWER_CALL_COST_USD;
}

/**
 * Engines whose price Starsign cannot read from the response would otherwise cost "$0" and never reach the
 * workspace's model spend cap. Charge them a conservative estimate per call instead, marked as an estimate.
 */
export function withCostFloor(engine: AnswerEngine, estimateUsd: number): AnswerEngine {
  return {
    id: engine.id,
    label: engine.label,
    model: engine.model,
    ask: async (prompt, opts) => {
      const r = await engine.ask(prompt, opts);
      const u = r.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      if (u.costUsd > 0) return r;
      return { ...r, usage: { ...u, costUsd: estimateUsd, costEstimated: true } };
    },
  };
}
