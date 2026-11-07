import type { AnswerEngine, AnswerEngineId, AnswerResult, AskOptions } from "./types.ts";

/**
 * An engine that never leaves the process: for tests and `STARSIGN_FAKE_AI=1` development. By default it answers
 * with the question's own words and one example source, so nothing it says is invented; tests pass `answer` to
 * script exactly what comes back.
 */
export class FakeAnswerEngine implements AnswerEngine {
  /** "fake" unless a test stands it in for a real engine. */
  readonly id: AnswerEngineId;
  readonly label: string;
  readonly model: string;
  readonly calls: { prompt: string; opts: AskOptions }[] = [];
  private readonly answer: (prompt: string, opts: AskOptions) => AnswerResult | Promise<AnswerResult>;

  constructor(opts: { id?: AnswerEngineId; label?: string; model?: string; answer?: (prompt: string, opts: AskOptions) => AnswerResult | Promise<AnswerResult> } = {}) {
    this.id = opts.id ?? "fake";
    this.label = opts.label ?? "Demo engine";
    this.model = opts.model ?? "fake-answers";
    this.answer =
      opts.answer ??
      ((prompt) => ({
        text: `Demo answer (no engine is configured). You asked: ${prompt}`,
        citations: [{ url: `https://example.com/search?q=${encodeURIComponent(prompt.slice(0, 80))}`, title: "Example source" }],
        model: this.model,
        usage: { inputTokens: Math.ceil(prompt.length / 4), outputTokens: 40, costUsd: 0 },
      }));
  }

  async ask(prompt: string, opts: AskOptions): Promise<AnswerResult> {
    this.calls.push({ prompt, opts });
    return this.answer(prompt, opts);
  }
}
