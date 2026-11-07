import { z } from "zod";
import { renderJson } from "./context.ts";
import { definePrompt } from "./types.ts";

export type JudgeAnswerVars = {
  /** The workspace asking, for context only (the judge is neutral, not the brand's advocate). */
  workspace: string;
  question: string;
  /** BCP-47 language the answer is in. */
  lang: string;
  engine: string;
  answer: string;
  /** The tracked names the answer mentions (found by Starsign's own matcher), with what the team knows about each. */
  entities: { id: string; name: string; kind: "organization" | "person"; role?: string | null; relation: string; matched: string; facts?: string | null }[];
};

export const JudgeAnswerOutput = z.object({
  entities: z.array(
    z.object({
      id: z.string().describe("The id given in the input"),
      sentiment: z.number().describe("How the answer portrays it, from -1 (clearly negative) through 0 (neutral or merely listed) to 1 (clearly positive)"),
      summary: z.string().describe("One plain line, in English, on what the answer says about it; no more than 25 words"),
      flags: z.array(z.string()).describe("Statements about it that contradict the facts given, or that look outdated or unsupported; empty when none"),
    }),
  ),
});
export type JudgeAnswerOutput = z.infer<typeof JudgeAnswerOutput>;

export const judgeAnswer = definePrompt<JudgeAnswerVars, JudgeAnswerOutput>({
  name: "judgeAnswer",
  version: "1.0.0",
  description: "How an AI assistant's answer talks about each tracked name it mentions: tone, one-line summary, possible inaccuracies.",
  effort: "low",
  maxTokens: 4000,
  system: () =>
    `You read answers that AI assistants (ChatGPT, Claude, Perplexity, Gemini) gave to everyday questions, and report how each answer talks about specific organisations and people. You are a neutral reader, not anyone's advocate.
For every name listed, judge only this answer's text:
- sentiment: -1 to 1. Being recommended, praised or listed first as a good choice is positive; criticism, warnings, scandals or being advised against is negative; a bare listing or a factual mention is about 0.
- summary: one plain line in English on what the answer says about it. Quote nothing longer than a few words.
- flags: statements about it that contradict the facts you were given, or that look outdated or unsupported. Do not flag opinions. Never invent facts of your own; with no facts given, flag only internal contradictions.
Return exactly one entry per name you were given, with its id.`,
  user: (v) =>
    [
      `Question (${v.lang}, asked of ${v.engine}): ${v.question}`,
      `Names to judge:\n${renderJson(v.entities)}`,
      `The answer:\n<<<\n${v.answer}\n>>>`,
    ].join("\n\n"),
  schema: JudgeAnswerOutput,
});
