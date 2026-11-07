/**
 * Answer engines: the assistants people now ask instead of searching (Claude, ChatGPT, Perplexity, Gemini).
 * Starsign asks each one the questions a workspace cares about and records what comes back, so a brand or a
 * campaign can see whether it is mentioned, how, and on which sources the answer rests.
 *
 * Every adapter here asks with the engine's own web search turned on, because that is what a person using the
 * consumer product gets, and because only grounded answers carry citations.
 */

export type AnswerEngineId = "anthropic" | "openai" | "perplexity" | "gemini" | "fake";

export interface AnswerCitation {
  url: string;
  title?: string;
}

export interface AnswerUsage {
  inputTokens: number;
  outputTokens: number;
  /** USD for this call. When the provider reports no price, a conservative per-call estimate (see costEstimated). */
  costUsd: number;
  /** True when costUsd is Starsign's estimate rather than a known price, so the spend cap still applies. */
  costEstimated?: boolean;
  /** Web searches the engine ran for this answer, when it reports them. */
  searches?: number;
}

export interface AnswerResult {
  text: string;
  citations: AnswerCitation[];
  /** The model that answered, as the provider reported it. */
  model: string;
  usage?: AnswerUsage;
}

export interface AskOptions {
  /** BCP-47 language the question is asked in; the answer is requested in it too. */
  lang: string;
  /** ISO 3166-1 alpha-2 country the person asking is in (search localisation), or null. */
  region: string | null;
}

export interface AnswerEngine {
  readonly id: AnswerEngineId;
  /** What people call it: "Claude", "ChatGPT", "Perplexity", "Gemini". */
  readonly label: string;
  readonly model: string;
  ask(prompt: string, opts: AskOptions): Promise<AnswerResult>;
}

/** What the settings screen shows: every engine Starsign knows, whether this deployment can use it, and how to turn it on. */
export interface AnswerEngineStatus {
  id: AnswerEngineId;
  label: string;
  configured: boolean;
  /** The environment variable that holds the key. */
  envVar: string;
  /** Optional variable that picks the model. */
  modelEnvVar: string | null;
  model: string;
  /** Whether the call's cost is known and counted (false: recorded as $0, see docs/visibility.md). */
  priced: boolean;
}

/** A failure talking to an engine. `retryable` for 429 / 5xx / network. Never carries the key. */
export class AnswerEngineError extends Error {
  constructor(
    public readonly engine: AnswerEngineId,
    message: string,
    public readonly status?: number,
    public readonly retryable = false,
  ) {
    super(`${engine}: ${message}`);
    this.name = "AnswerEngineError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Language names for the "answer in" instruction (the question itself is asked as written). */
export function languageLabel(lang: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

/** The text sent to an engine: the question as a person would type it, plus the language to answer in. */
export function questionFor(prompt: string, opts: AskOptions): string {
  const base = opts.lang.split("-")[0]!.toLowerCase();
  if (base === "en") return prompt;
  return `${prompt}\n\n(Answer in ${languageLabel(opts.lang)}.)`;
}

/** Drop duplicate URLs (keeping the first title seen) and anything that is not http(s). */
export function dedupeCitations(xs: AnswerCitation[]): AnswerCitation[] {
  const seen = new Map<string, AnswerCitation>();
  for (const c of xs) {
    if (!c.url || !/^https?:\/\//i.test(c.url)) continue;
    const prev = seen.get(c.url);
    if (!prev) seen.set(c.url, { url: c.url, ...(c.title ? { title: c.title } : {}) });
    else if (!prev.title && c.title) prev.title = c.title;
  }
  return [...seen.values()];
}

/** Read a JSON body or throw an AnswerEngineError that says what the provider said (truncated, never the request). */
export async function readJson(engine: AnswerEngineId, res: Response): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string };
      message = typeof j.error === "string" ? j.error : (j.error?.message ?? message);
    } catch {
      // not JSON: keep the text
    }
    throw new AnswerEngineError(engine, `HTTP ${res.status}: ${message}`, res.status, res.status === 429 || res.status >= 500);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AnswerEngineError(engine, "the reply was not JSON");
  }
}

export async function send(engine: AnswerEngineId, fetchImpl: FetchLike, url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    throw new AnswerEngineError(engine, `could not reach the API (${(e as Error).message})`, undefined, true);
  }
  return readJson(engine, res);
}
