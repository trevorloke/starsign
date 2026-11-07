import { AnswerEngineError, dedupeCitations, questionFor, send, type AnswerCitation, type AnswerEngine, type AnswerResult, type AskOptions, type FetchLike } from "./types.ts";

// TODO(verify): the default model name. Set OPENAI_ANSWER_MODEL to the model ChatGPT users get today.
export const OPENAI_DEFAULT_MODEL = "gpt-5";
const ENDPOINT = "https://api.openai.com/v1/responses";

export interface OpenAIEngineOptions {
  apiKey: string;
  model?: string;
  fetch?: FetchLike;
}

interface ResponsesOutput {
  model?: string;
  output?: {
    type?: string;
    content?: { type?: string; text?: string; annotations?: { type?: string; url?: string; title?: string }[] }[];
  }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * ChatGPT's behaviour through the Responses API with the hosted web search tool. Plain fetch, no SDK.
 * Cost is recorded as $0: OpenAI's prices are not in Starsign's price table (tokens are still recorded).
 */
export class OpenAIAnswerEngine implements AnswerEngine {
  readonly id = "openai" as const;
  readonly label = "ChatGPT";
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OpenAIEngineOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? OPENAI_DEFAULT_MODEL;
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  async ask(prompt: string, opts: AskOptions): Promise<AnswerResult> {
    const body = {
      model: this.model,
      input: questionFor(prompt, opts),
      // TODO(verify): tool type name ("web_search" vs the older "web_search_preview") and the user_location shape.
      tools: [{ type: "web_search", ...(opts.region ? { user_location: { type: "approximate", country: opts.region } } : {}) }],
    };
    const json = (await send("openai", this.fetchImpl, ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    })) as ResponsesOutput;
    return parseOpenAIResponse(json, this.model);
  }
}

/** Text is the `output_text` parts of `message` items; citations are their `url_citation` annotations. */
export function parseOpenAIResponse(json: ResponsesOutput, fallbackModel: string): AnswerResult {
  // TODO(verify): output item and annotation shapes (message → output_text → annotations[type=url_citation]).
  let text = "";
  const citations: AnswerCitation[] = [];
  for (const item of json.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type !== "output_text" || typeof part.text !== "string") continue;
      text += (text ? "\n\n" : "") + part.text;
      for (const a of part.annotations ?? []) if (a.type === "url_citation" && a.url) citations.push({ url: a.url, ...(a.title ? { title: a.title } : {}) });
    }
  }
  if (!text.trim()) throw new AnswerEngineError("openai", "the reply carried no answer text");
  return {
    text: text.trim(),
    citations: dedupeCitations(citations),
    model: json.model ?? fallbackModel,
    usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0, costUsd: 0 },
  };
}
