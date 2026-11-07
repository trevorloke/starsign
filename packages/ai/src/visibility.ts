import { runPrompt, type FakeHandler, type ModelGateway } from "./gateway.ts";
import { readProfile } from "./prompts/context.ts";
import { judgeAnswer, type JudgeAnswerOutput, type JudgeAnswerVars } from "./prompts/judgeAnswer.ts";
import { suggestQuestions, type SuggestQuestionsOutput, type SuggestQuestionsVars } from "./prompts/suggestQuestions.ts";

/**
 * AI answer visibility, the model side: the judge that reads an answer for tone, and the helper that suggests
 * questions. Shaped structurally to core's `AnswerJudge` / `QuestionSuggester` so ai does not depend on core.
 */

const clamp = (x: number) => (Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0);

export function gatewayAnswerJudge(gw: ModelGateway) {
  return async (input: JudgeAnswerVars) => {
    const res = await runPrompt(gw, judgeAnswer, input);
    const wanted = new Set(input.entities.map((e) => e.id));
    const entities = res.output.entities
      .filter((e) => wanted.has(e.id))
      .map((e) => ({ id: e.id, sentiment: clamp(e.sentiment), summary: e.summary.trim().slice(0, 300), flags: e.flags.map((f) => f.trim().slice(0, 300)).filter(Boolean).slice(0, 5) }));
    return { entities, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: res.usage.costUsd, model: res.usage.model, promptVersion: res.usage.promptVersion };
  };
}

export function gatewayQuestionSuggester(gw: ModelGateway) {
  return async (input: SuggestQuestionsVars) => {
    const res = await runPrompt(gw, suggestQuestions, input);
    const have = new Set(input.existing.map((q) => q.normalize("NFKC").trim().toLowerCase()));
    const seen = new Set<string>();
    const questions = res.output.questions
      .map((q) => ({ ...q, question: q.question.trim().slice(0, 500) }))
      .filter((q) => {
        const k = q.question.normalize("NFKC").toLowerCase();
        if (q.question.length < 3 || have.has(k) || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, input.count);
    return { questions, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: res.usage.costUsd };
  };
}

// ---------------------------------------------------------------- fake handlers (tests, STARSIGN_FAKE_AI=1)

const POSITIVE = ["best", "great", "excellent", "recommend", "recommended", "popular", "favourite", "favorite", "praised", "ethical", "sustainable", "trusted", "loved", "top", "leading", "strong", "おすすめ", "人気", "最高", "mejor", "excelente", "recomendado"];
const NEGATIVE = ["avoid", "criticised", "criticized", "controversy", "scandal", "overpriced", "lawsuit", "poor", "worst", "complaints", "recall", "weak", "decline", "declined", "problem", "problems", "批判", "malo", "peor"];

function sentenceAround(text: string, term: string): string {
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return "";
  const start = Math.max(text.lastIndexOf(".", i) + 1, text.lastIndexOf("\n", i) + 1, 0);
  const endDot = text.indexOf(".", i);
  const end = endDot < 0 ? text.length : endDot + 1;
  return text.slice(start, end).trim();
}

function tone(sentence: string): number {
  const s = sentence.toLowerCase();
  const count = (words: string[]) => words.filter((w) => s.includes(w)).length;
  const pos = count(POSITIVE);
  const neg = count(NEGATIVE);
  return clamp((pos - neg) / (pos + neg + 1));
}

/** Deterministic, schema-valid outputs derived only from the inputs. */
export function visibilityFakeHandlers(): Record<string, FakeHandler> {
  return {
    judgeAnswer: (vars) => {
      const v = vars as JudgeAnswerVars;
      const out: JudgeAnswerOutput = {
        entities: v.entities.map((e) => {
          const sentence = sentenceAround(v.answer, e.matched);
          const words = sentence.split(/\s+/).filter(Boolean);
          return { id: e.id, sentiment: tone(sentence), summary: sentence ? `Mentioned: ${words.slice(0, 22).join(" ")}${words.length > 22 ? "…" : ""}` : "Mentioned in passing", flags: [] };
        }),
      };
      return out;
    },
    suggestQuestions: (vars) => {
      const v = vars as SuggestQuestionsVars;
      const p = readProfile(v.workspace.profile);
      const own = v.entities.filter((e) => e.relation === "own" || e.relation === "client").map((e) => e.name);
      const rivals = v.entities.filter((e) => e.relation === "competitor" || e.relation === "opponent").map((e) => e.name);
      const name = own[0] ?? v.workspace.name;
      const base: { question: string; why: string; names: string[] }[] = [
        ...p.topics.map((t) => ({ question: `What is the best choice for ${t}?`, why: "open question: do we come up unprompted", names: [name] })),
        { question: `Is ${name} worth it?`, why: "reputation check", names: [name] },
        ...rivals.map((r) => ({ question: `${name} or ${r}: which is better?`, why: "head-to-head", names: [name, r] })),
        { question: `What do people say about ${name}?`, why: "reputation check", names: [name] },
      ];
      const langs = v.languages.length ? v.languages : ["en"];
      const have = new Set(v.existing.map((q) => q.toLowerCase()));
      const out: SuggestQuestionsOutput = { questions: [] };
      for (const lang of langs) {
        for (const q of base) {
          const question = lang.startsWith("en") ? q.question : `[${lang}] ${q.question}`;
          if (have.has(question.toLowerCase()) || out.questions.some((x) => x.question === question)) continue;
          out.questions.push({ question, lang, why: `fake gateway: ${q.why}`, names: q.names });
        }
      }
      out.questions = out.questions.slice(0, v.count);
      return out;
    },
  };
}
