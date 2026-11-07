import { AnswerEngineError, dedupeCitations, questionFor, send, type AnswerCitation, type AnswerEngine, type AnswerResult, type AskOptions, type FetchLike } from "./types.ts";

// TODO(verify): the default model name. Set GEMINI_ANSWER_MODEL to override.
export const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiEngineOptions {
  apiKey: string;
  model?: string;
  fetch?: FetchLike;
}

interface GenerateContentResponse {
  modelVersion?: string;
  candidates?: {
    content?: { parts?: { text?: string }[] };
    groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Gemini with Grounding with Google Search. Plain fetch; the key goes in a header, never the URL.
 * Grounding sources are Google redirect links whose `title` is the source's domain; both are kept (the report
 * reads the domain from the title when the link is a redirect). Cost is recorded as $0 (price not in the table).
 */
export class GeminiAnswerEngine implements AnswerEngine {
  readonly id = "gemini" as const;
  readonly label = "Gemini";
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: GeminiEngineOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? GEMINI_DEFAULT_MODEL;
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  async ask(prompt: string, opts: AskOptions): Promise<AnswerResult> {
    // TODO(verify): Google Search grounding has no documented per-request country; the region is not sent.
    const body = { contents: [{ role: "user", parts: [{ text: questionFor(prompt, opts) }] }], tools: [{ google_search: {} }] };
    const json = (await send("gemini", this.fetchImpl, `${BASE}/${encodeURIComponent(this.model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(body),
    })) as GenerateContentResponse;
    return parseGeminiResponse(json, this.model);
  }
}

export function parseGeminiResponse(json: GenerateContentResponse, fallbackModel: string): AnswerResult {
  // TODO(verify): candidates[0].groundingMetadata.groundingChunks[].web.{uri,title} and usageMetadata field names.
  const cand = json.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (!text.trim()) throw new AnswerEngineError("gemini", "the reply carried no answer text");
  const citations: AnswerCitation[] = (cand?.groundingMetadata?.groundingChunks ?? []).filter((c) => c.web?.uri).map((c) => ({ url: c.web!.uri!, ...(c.web!.title ? { title: c.web!.title } : {}) }));
  return {
    text: text.trim(),
    citations: dedupeCitations(citations),
    model: json.modelVersion ?? fallbackModel,
    usage: { inputTokens: json.usageMetadata?.promptTokenCount ?? 0, outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0, costUsd: 0 },
  };
}
