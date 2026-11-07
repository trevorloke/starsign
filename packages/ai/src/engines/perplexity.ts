import { AnswerEngineError, dedupeCitations, questionFor, send, type AnswerCitation, type AnswerEngine, type AnswerResult, type AskOptions, type FetchLike } from "./types.ts";

export const PERPLEXITY_DEFAULT_MODEL = "sonar";
const ENDPOINT = "https://api.perplexity.ai/chat/completions";

export interface PerplexityEngineOptions {
  apiKey: string;
  model?: string;
  fetch?: FetchLike;
}

interface SonarResponse {
  model?: string;
  choices?: { message?: { content?: string } }[];
  citations?: string[];
  search_results?: { url?: string; title?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: { total_cost?: number } };
}

/** Perplexity's Sonar models, which search on every question and return their sources. Plain fetch. */
export class PerplexityAnswerEngine implements AnswerEngine {
  readonly id = "perplexity" as const;
  readonly label = "Perplexity";
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: PerplexityEngineOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? PERPLEXITY_DEFAULT_MODEL;
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  async ask(prompt: string, opts: AskOptions): Promise<AnswerResult> {
    const body = {
      model: this.model,
      messages: [{ role: "user", content: questionFor(prompt, opts) }],
      // TODO(verify): web_search_options.user_location.country as the way to localise search.
      ...(opts.region ? { web_search_options: { user_location: { country: opts.region } } } : {}),
    };
    const json = (await send("perplexity", this.fetchImpl, ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    })) as SonarResponse;
    return parsePerplexityResponse(json, this.model);
  }
}

/**
 * The answer is the first choice's message. Sources come from `search_results` (url + title) when present,
 * otherwise from the older top-level `citations` list of URLs.
 */
export function parsePerplexityResponse(json: SonarResponse, fallbackModel: string): AnswerResult {
  // TODO(verify): `search_results` and `citations` field names, and `usage.cost.total_cost` (USD) for the request.
  const text = json.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new AnswerEngineError("perplexity", "the reply carried no answer text");
  const citations: AnswerCitation[] = (json.search_results ?? []).filter((r) => r.url).map((r) => ({ url: r.url!, ...(r.title ? { title: r.title } : {}) }));
  for (const url of json.citations ?? []) citations.push({ url });
  const cost = json.usage?.cost?.total_cost;
  return {
    text: text.trim(),
    citations: dedupeCitations(citations),
    model: json.model ?? fallbackModel,
    // Perplexity reports the request's cost itself; when it does not, $0 (the price is not in Starsign's table).
    usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0, costUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : 0 },
  };
}
