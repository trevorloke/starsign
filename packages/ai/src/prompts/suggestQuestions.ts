import { z } from "zod";
import { readProfile } from "./context.ts";
import { definePrompt } from "./types.ts";

export type SuggestQuestionsVars = {
  workspace: { name: string; profile: Record<string, unknown> };
  /** Tracked names: the brand itself, its people, competitors, opponents. */
  entities: { name: string; kind: "organization" | "person"; role?: string | null; relation: string }[];
  /** BCP-47 codes to write questions in. */
  languages: string[];
  /** Questions the team already asks. */
  existing: string[];
  count: number;
};

export const SuggestQuestionsOutput = z.object({
  questions: z.array(
    z.object({
      question: z.string().describe("The question exactly as a person would type it into an AI assistant"),
      lang: z.string().describe("BCP-47 code of the language the question is written in"),
      why: z.string().describe("A few words: what this question tells the team"),
      names: z.array(z.string()).describe("Tracked names a good answer would likely mention"),
    }),
  ),
});
export type SuggestQuestionsOutput = z.infer<typeof SuggestQuestionsOutput>;

export const suggestQuestions = definePrompt<SuggestQuestionsVars, SuggestQuestionsOutput>({
  name: "suggestQuestions",
  version: "1.0.0",
  description: "Questions real people ask AI assistants where this brand or campaign should come up.",
  effort: "low",
  maxTokens: 4000,
  system: () =>
    `You help a communications team see how AI assistants answer the questions their audience asks. Suggest questions real people would type into ChatGPT, Claude, Perplexity or Gemini when they are deciding something this organisation cares about: choosing, comparing, checking a reputation, finding where to buy or who to vote for, asking what something stands for.
Rules:
- Write questions as people actually type them: short, plain, often with a place or a need ("best ... in ...", "is ... worth it", "who should I vote for in ... if I care about ...").
- Mix: questions that name the organisation, questions that name a competitor or opponent, and open questions that name nobody (those show whether the organisation comes up unprompted). Most should be open questions.
- Do not write leading questions designed to produce praise. Do not repeat questions the team already has.
- Write each question in one of the requested languages, as a native speaker would phrase it, not as a translation.`,
  user: (v) => {
    const p = readProfile(v.workspace.profile);
    return [
      `Organisation: ${v.workspace.name}`,
      p.description ? `What it is: ${p.description}` : null,
      p.audience ? `Audience: ${p.audience}` : null,
      p.topics.length ? `Topics: ${p.topics.join(", ")}` : null,
      p.competitors.length ? `Competitors: ${p.competitors.join(", ")}` : null,
      `Tracked names: ${JSON.stringify(v.entities)}`,
      `Languages: ${JSON.stringify(v.languages)}`,
      `Already asked: ${JSON.stringify(v.existing)}`,
      `Suggest ${v.count} questions.`,
    ]
      .filter((x): x is string => x !== null)
      .join("\n");
  },
  schema: SuggestQuestionsOutput,
});
