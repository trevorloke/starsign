import type { Starsign, VisibilityRuntime } from "@starsign/core";
import { AnthropicGateway, FakeGateway, answerEnginesFromEnv, defaultFakeHandlers, gatewayAnswerJudge, type ModelGateway } from "@starsign/ai";

/**
 * AI answer visibility, wired from the environment: one engine per key present (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * PERPLEXITY_API_KEY, GEMINI_API_KEY) and the Claude gateway as the judge. STARSIGN_FAKE_AI=1 runs offline.
 */
export function visibilityRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env, gateway?: ModelGateway | null): VisibilityRuntime {
  const gw = gateway !== undefined ? gateway : env.STARSIGN_FAKE_AI === "1" ? new FakeGateway(defaultFakeHandlers()) : env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? new AnthropicGateway() : null;
  return { engines: answerEnginesFromEnv(env), judge: gw ? gatewayAnswerJudge(gw) : null };
}

/** The hourly job: ask every due question on every configured engine. Nothing to do without an engine. */
export async function runVisibility(m: Starsign, runtime: VisibilityRuntime = visibilityRuntimeFromEnv()) {
  if (runtime.engines.length === 0) return { skipped: "no answer engine is configured" };
  const runs = await m.visibility.runDue(runtime);
  return {
    workspaces: runs.length,
    answers: runs.reduce((n, r) => n + r.answers, 0),
    capped: runs.reduce((n, r) => n + r.capped, 0),
    errors: runs.reduce((n, r) => n + r.errors, 0),
  };
}
