import { adaptForNetwork } from "./adaptForNetwork.ts";
import { classifyTopic } from "./classifyTopic.ts";
import { clusterSignals } from "./clusterSignals.ts";
import { draftForTrend } from "./draftForTrend.ts";
import { scoreRelevance } from "./scoreRelevance.ts";
import type { PromptSpec } from "./types.ts";
import { writeBrief } from "./writeBrief.ts";
import { translateMessages } from "./translateMessages.ts";
import { translateKeywords } from "./translateKeywords.ts";
import { suggestAliases } from "./suggestAliases.ts";
// ---- AI answer visibility
import { judgeAnswer } from "./judgeAnswer.ts";
import { suggestQuestions } from "./suggestQuestions.ts";

export * from "./types.ts";
export * from "./context.ts";
export * from "./shared.ts";
export * from "./adaptForNetwork.ts";
export * from "./draftForTrend.ts";
export * from "./clusterSignals.ts";
export * from "./writeBrief.ts";
export * from "./classifyTopic.ts";
export * from "./scoreRelevance.ts";
export * from "./translateMessages.ts";
export * from "./translateKeywords.ts";
export * from "./suggestAliases.ts";
// ---- AI answer visibility
export * from "./judgeAnswer.ts";
export * from "./suggestQuestions.ts";

/** Every prompt the gateway knows, for evals and the fake gateway. */
export const ALL_PROMPTS: readonly PromptSpec[] = [adaptForNetwork, draftForTrend, clusterSignals, writeBrief, classifyTopic, scoreRelevance, translateMessages, translateKeywords, suggestAliases, /* AI answer visibility */ judgeAnswer, suggestQuestions];
