import Anthropic from "@anthropic-ai/sdk";
import { REFUSAL_FALLBACK_BETA, resolveModel } from "../anthropic.ts";
import { estimateCostUsd, priceFor } from "../pricing.ts";
import { AnswerEngineError, dedupeCitations, questionFor, type AnswerCitation, type AnswerEngine, type AnswerResult, type AskOptions } from "./types.ts";

/**
 * Web search on the Claude API is billed per search on top of tokens: $10 per 1,000 searches (Claude API skill,
 * cached 2026-10-06). Kept here, next to the only caller, rather than in MODEL_PRICES (it is not a token price).
 */
export const ANTHROPIC_WEB_SEARCH_USD = 10 / 1000;

/** Server-side tool loops can pause (`pause_turn`); resume this many times at most. */
const MAX_RESUMES = 3;

export interface AnthropicEngineOptions {
  /** Injected client (tests pass one built with a mocked `fetch`). Default: `new Anthropic()`, which reads ANTHROPIC_API_KEY. */
  client?: Anthropic;
  model?: string;
  /** Most searches per answer. */
  maxSearches?: number;
}

/**
 * Claude with the web search server tool, asked the question the way a person would type it into claude.ai: no
 * system prompt about the brand, nothing that would steer the answer. Citations are the `web_search_result_location`
 * citations on the answer's text blocks (the sources the answer actually rests on), in order of first use.
 */
export class AnthropicAnswerEngine implements AnswerEngine {
  readonly id = "anthropic" as const;
  readonly label = "Claude";
  readonly model: string;
  private readonly client: Anthropic;
  private readonly maxSearches: number;

  constructor(opts: AnthropicEngineOptions = {}) {
    this.model = opts.model ?? resolveModel();
    this.client = opts.client ?? new Anthropic({ maxRetries: 2 });
    this.maxSearches = opts.maxSearches ?? 5;
  }

  async ask(prompt: string, opts: AskOptions): Promise<AnswerResult> {
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: questionFor(prompt, opts) }];
    const tool: Anthropic.Beta.BetaWebSearchTool20260209 = {
      type: "web_search_20260209",
      name: "web_search",
      max_uses: this.maxSearches,
      ...(opts.region ? { user_location: { type: "approximate", country: opts.region } } : {}),
    };
    let text = "";
    const citations: AnswerCitation[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let searches = 0;
    let served = this.model;
    for (let turn = 0; turn <= MAX_RESUMES; turn++) {
      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await this.client.beta.messages.create({
          model: this.model,
          max_tokens: 16_000,
          messages,
          tools: [tool],
          // Claude Opus 5.5 always thinks; effort is the only depth control. A consumer question gets the default.
          output_config: { effort: "medium" },
          betas: [REFUSAL_FALLBACK_BETA],
          fallbacks: "default",
        });
      } catch (e) {
        const status = (e as { status?: number }).status;
        throw new AnswerEngineError("anthropic", (e as Error).message, status, status === undefined || status === 429 || status >= 500);
      }
      served = message.model;
      const u = message.usage;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const cacheWrite = u.cache_creation_input_tokens ?? 0;
      inputTokens += u.input_tokens + cacheRead + cacheWrite;
      outputTokens += u.output_tokens;
      const turnSearches = u.server_tool_use?.web_search_requests ?? 0;
      searches += turnSearches;
      const priceModel = priceFor(served) ? served : this.model;
      costUsd += estimateCostUsd(priceModel, { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }) + turnSearches * ANTHROPIC_WEB_SEARCH_USD;

      for (const block of message.content) {
        if (block.type !== "text") continue;
        text += block.text;
        for (const c of block.citations ?? []) {
          if (c.type === "web_search_result_location") citations.push({ url: c.url, ...(c.title ? { title: c.title } : {}) });
        }
      }
      if (message.stop_reason === "refusal") {
        if (!text.trim()) throw new AnswerEngineError("anthropic", "declined to answer");
        break;
      }
      if (message.stop_reason !== "pause_turn") break;
      // The server-side search loop paused: send the turn back as is and it resumes where it stopped.
      messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
    }
    return { text: text.trim(), citations: dedupeCitations(citations), model: served, usage: { inputTokens, outputTokens, costUsd, searches } };
  }
}
