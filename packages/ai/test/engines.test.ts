import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_WEB_SEARCH_USD,
  AnswerEngineError,
  AnthropicAnswerEngine,
  FakeGateway,
  GeminiAnswerEngine,
  OpenAIAnswerEngine,
  PerplexityAnswerEngine,
  answerEngineStatus,
  answerEnginesFromEnv,
  defaultFakeHandlers,
  estimateCostUsd,
  gatewayAnswerJudge,
  gatewayQuestionSuggester,
  judgeAnswer,
  suggestQuestions,
} from "../src/index.ts";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that records each request and answers from the queue. */
function mockFetch(...replies: { status?: number; json: unknown }[]) {
  const requests: Captured[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    requests.push({ url, method: init?.method ?? "GET", headers, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    const r = replies.shift() ?? { status: 500, json: { error: { message: "no more replies" } } };
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fn, requests };
}

const message = (over: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "independent coffee roasters Vancouver" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://eater.com/vancouver", title: "Eater Vancouver", encrypted_content: "x", page_age: null }] },
    { type: "text", text: "Northwind Coffee is a popular pick", citations: [{ type: "web_search_result_location", url: "https://eater.com/vancouver", title: "Eater Vancouver", cited_text: "Northwind…", encrypted_index: "e1" }] },
    { type: "text", text: ", and Stumptown ships nationwide.", citations: [{ type: "web_search_result_location", url: "https://www.northwind.coffee/about", title: null, cited_text: "…", encrypted_index: "e2" }, { type: "web_search_result_location", url: "https://eater.com/vancouver", title: "Eater Vancouver", cited_text: "…", encrypted_index: "e3" }] },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 } },
  ...over,
});

describe("Anthropic answer engine", () => {
  it("asks with the web search tool and region, and reads cited sources and cost", async () => {
    const f = mockFetch({ json: message() });
    const engine = new AnthropicAnswerEngine({ client: new Anthropic({ apiKey: "sk-test", fetch: f.fn, maxRetries: 0 }), model: "claude-opus-5-5" });
    const r = await engine.ask("Best independent coffee roasters in Vancouver", { lang: "en", region: "CA" });
    const req = f.requests[0]!;
    expect(req.url).toMatch(/\/v1\/messages(\?beta=true)?$/);
    expect(req.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(req.body).toMatchObject({
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "Best independent coffee roasters in Vancouver" }],
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5, user_location: { type: "approximate", country: "CA" } }],
      fallbacks: "default",
    });
    expect(req.body).not.toHaveProperty("system"); // asked like a person would, nothing steering it
    expect(r.text).toBe("Northwind Coffee is a popular pick, and Stumptown ships nationwide.");
    expect(r.citations).toEqual([{ url: "https://eater.com/vancouver", title: "Eater Vancouver" }, { url: "https://www.northwind.coffee/about" }]);
    expect(r.usage!.searches).toBe(2);
    expect(r.usage!.costUsd).toBeCloseTo(estimateCostUsd("claude-opus-5-5", { inputTokens: 2000, outputTokens: 300 }) + 2 * ANTHROPIC_WEB_SEARCH_USD, 8);
  });

  it("asks for the answer in the question's language and resumes a paused search turn", async () => {
    const paused = message({ content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } }], stop_reason: "pause_turn", usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } } });
    const f = mockFetch({ json: paused }, { json: message() });
    const engine = new AnthropicAnswerEngine({ client: new Anthropic({ apiKey: "sk-test", fetch: f.fn, maxRetries: 0 }) });
    const r = await engine.ask("バンクーバーのおすすめコーヒー", { lang: "ja", region: null });
    expect(f.requests).toHaveLength(2);
    expect((f.requests[0]!.body.messages as { content: string }[])[0]!.content).toBe("バンクーバーのおすすめコーヒー\n\n(Answer in Japanese.)");
    expect(f.requests[0]!.body.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 5 }]);
    expect((f.requests[1]!.body.messages as { role: string }[]).map((x) => x.role)).toEqual(["user", "assistant"]);
    expect(r.usage!.searches).toBe(3);
    expect(r.text).toMatch(/^Northwind Coffee/);
  });

  it("turns a decline with no text into an engine error", async () => {
    const f = mockFetch({ json: message({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null } }) });
    const engine = new AnthropicAnswerEngine({ client: new Anthropic({ apiKey: "sk-test", fetch: f.fn, maxRetries: 0 }) });
    await expect(engine.ask("q", { lang: "en", region: null })).rejects.toBeInstanceOf(AnswerEngineError);
  });
});

describe("OpenAI answer engine", () => {
  it("calls the Responses API with web search and reads url citations", async () => {
    const f = mockFetch({
      json: {
        model: "gpt-5-2026",
        output: [
          { type: "web_search_call", id: "ws_1", status: "completed" },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Try Northwind Coffee or Blue Bottle.",
                annotations: [
                  { type: "url_citation", url: "https://eater.com/vancouver", title: "Eater", start_index: 4, end_index: 20 },
                  { type: "url_citation", url: "https://eater.com/vancouver", title: "Eater", start_index: 24, end_index: 35 },
                ],
              },
            ],
          },
        ],
        usage: { input_tokens: 900, output_tokens: 120 },
      },
    });
    const engine = new OpenAIAnswerEngine({ apiKey: "sk-openai", model: "gpt-5", fetch: f.fn });
    const r = await engine.ask("Best coffee in Vancouver", { lang: "en", region: "CA" });
    const req = f.requests[0]!;
    expect(req.url).toBe("https://api.openai.com/v1/responses");
    expect(req.headers.authorization).toBe("Bearer sk-openai");
    expect(req.body).toEqual({ model: "gpt-5", input: "Best coffee in Vancouver", tools: [{ type: "web_search", user_location: { type: "approximate", country: "CA" } }] });
    expect(r).toEqual({ text: "Try Northwind Coffee or Blue Bottle.", citations: [{ url: "https://eater.com/vancouver", title: "Eater" }], model: "gpt-5-2026", usage: { inputTokens: 900, outputTokens: 120, costUsd: 0 } });
  });

  it("reports HTTP errors without the key, and marks 429 retryable", async () => {
    const f = mockFetch({ status: 429, json: { error: { message: "Rate limit reached" } } });
    const err = await new OpenAIAnswerEngine({ apiKey: "sk-secret", fetch: f.fn }).ask("q", { lang: "en", region: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnswerEngineError);
    expect(err).toMatchObject({ status: 429, retryable: true });
    expect(String((err as Error).message)).not.toContain("sk-secret");
  });
});

describe("Perplexity answer engine", () => {
  it("calls Sonar chat completions and reads search results, citations and reported cost", async () => {
    const f = mockFetch({
      json: {
        model: "sonar",
        choices: [{ message: { role: "assistant", content: "Northwind Coffee [1] and Stumptown [2]." } }],
        search_results: [{ title: "Eater", url: "https://eater.com/vancouver" }],
        citations: ["https://eater.com/vancouver", "https://www.reddit.com/r/vancouver/x"],
        usage: { prompt_tokens: 20, completion_tokens: 40, cost: { total_cost: 0.0062 } },
      },
    });
    const r = await new PerplexityAnswerEngine({ apiKey: "pplx-1", fetch: f.fn }).ask("¿Mejor café en Vancouver?", { lang: "es", region: "CA" });
    const req = f.requests[0]!;
    expect(req.url).toBe("https://api.perplexity.ai/chat/completions");
    expect(req.headers.authorization).toBe("Bearer pplx-1");
    expect(req.body).toEqual({ model: "sonar", messages: [{ role: "user", content: "¿Mejor café en Vancouver?\n\n(Answer in Spanish.)" }], web_search_options: { user_location: { country: "CA" } } });
    expect(r.citations).toEqual([{ url: "https://eater.com/vancouver", title: "Eater" }, { url: "https://www.reddit.com/r/vancouver/x" }]);
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 40, costUsd: 0.0062 });
  });

  it("refuses an empty answer", async () => {
    const f = mockFetch({ json: { choices: [{ message: { content: "" } }] } });
    await expect(new PerplexityAnswerEngine({ apiKey: "k", fetch: f.fn }).ask("q", { lang: "en", region: null })).rejects.toThrow(/no answer text/);
  });
});

describe("Gemini answer engine", () => {
  it("calls generateContent with Google Search grounding, key in a header, and reads grounding chunks", async () => {
    const f = mockFetch({
      json: {
        modelVersion: "gemini-2.5-flash-001",
        candidates: [
          {
            content: { parts: [{ text: "Blue Bottle is popular. " }, { text: "Northwind Coffee is local." }] },
            groundingMetadata: { groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "eater.com" } }, { web: { uri: "https://northwind.coffee/", title: "northwind.coffee" } }] },
          },
        ],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 30 },
      },
    });
    const r = await new GeminiAnswerEngine({ apiKey: "gem-key", fetch: f.fn }).ask("Best coffee in Vancouver", { lang: "en", region: "CA" });
    const req = f.requests[0]!;
    expect(req.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(req.url).not.toContain("gem-key");
    expect(req.headers["x-goog-api-key"]).toBe("gem-key");
    expect(req.body).toEqual({ contents: [{ role: "user", parts: [{ text: "Best coffee in Vancouver" }] }], tools: [{ google_search: {} }] });
    expect(r.text).toBe("Blue Bottle is popular. Northwind Coffee is local.");
    expect(r.citations).toEqual([
      { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "eater.com" },
      { url: "https://northwind.coffee/", title: "northwind.coffee" },
    ]);
    expect(r.model).toBe("gemini-2.5-flash-001");
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 30, costUsd: 0 });
  });
});

describe("engines from the environment", () => {
  it("configures one engine per key and says which variable turns each on", () => {
    expect(answerEnginesFromEnv({})).toEqual([]);
    expect(answerEnginesFromEnv({ STARSIGN_FAKE_AI: "1" }).map((e) => e.id)).toEqual(["fake"]);
    const engines = answerEnginesFromEnv({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", OPENAI_ANSWER_MODEL: "gpt-x", GEMINI_API_KEY: " " });
    expect(engines.map((e) => [e.id, e.model])).toEqual([["anthropic", "claude-opus-5-5"], ["openai", "gpt-x"]]);
    const status = answerEngineStatus({ PERPLEXITY_API_KEY: "p" });
    expect(status.map((s) => [s.id, s.configured, s.envVar])).toEqual([
      ["anthropic", false, "ANTHROPIC_API_KEY"],
      ["openai", false, "OPENAI_API_KEY"],
      ["perplexity", true, "PERPLEXITY_API_KEY"],
      ["gemini", false, "GEMINI_API_KEY"],
    ]);
  });
});

describe("visibility prompts", () => {
  it("judgeAnswer renders the answer and names; the fake judge reads tone from the sentence", async () => {
    const vars = { workspace: "Northwind", question: "Is Northwind Coffee ethical?", lang: "en", engine: "Claude", answer: "Northwind Coffee is praised for ethical sourcing. Avoid Acme, which faced a lawsuit.", entities: [{ id: "e1", name: "Northwind Coffee", kind: "organization" as const, relation: "own", matched: "Northwind Coffee" }, { id: "e2", name: "Acme", kind: "organization" as const, relation: "competitor", matched: "Acme" }] };
    expect(judgeAnswer.user(vars)).toContain("Is Northwind Coffee ethical?");
    expect(judgeAnswer.user(vars)).toContain('"id": "e2"');
    const judge = gatewayAnswerJudge(new FakeGateway(defaultFakeHandlers()));
    const r = await judge(vars);
    expect(r.entities.find((e) => e.id === "e1")!.sentiment).toBeGreaterThan(0);
    expect(r.entities.find((e) => e.id === "e2")!.sentiment).toBeLessThan(0);
    expect(r.entities[0]!.summary).toMatch(/^Mentioned: Northwind Coffee is praised/);
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it("suggestQuestions grounds in the profile and drops questions the team already asks", async () => {
    const vars = { workspace: { name: "Northwind", profile: { description: "Coffee roaster", topics: ["cold brew"] } }, entities: [{ name: "Northwind Coffee", kind: "organization" as const, relation: "own" }, { name: "Blue Bottle", kind: "organization" as const, relation: "competitor" }], languages: ["en"], existing: ["Is Northwind Coffee worth it?"], count: 5 };
    expect(suggestQuestions.user(vars)).toContain("cold brew");
    const r = await gatewayQuestionSuggester(new FakeGateway(defaultFakeHandlers()))(vars);
    expect(r.questions.map((q) => q.question)).toEqual(["What is the best choice for cold brew?", "Northwind Coffee or Blue Bottle: which is better?", "What do people say about Northwind Coffee?"]);
  });
});

describe("spend cap for engines without a known price", () => {
  it("charges a conservative estimate when the provider reports no cost, and keeps a reported cost", async () => {
    const { withCostFloor, answerEnginesFromEnv, DEFAULT_ANSWER_CALL_COST_USD } = await import("../src/engines/index.ts");
    const base = (cost: number) => ({ id: "openai" as const, label: "ChatGPT", model: "m", ask: async () => ({ text: "t", citations: [], model: "m", usage: { inputTokens: 1, outputTokens: 1, costUsd: cost } }) });
    expect((await withCostFloor(base(0), 0.05).ask("q", { lang: "en", region: null })).usage).toMatchObject({ costUsd: 0.05, costEstimated: true });
    expect((await withCostFloor(base(0.012), 0.05).ask("q", { lang: "en", region: null })).usage).toMatchObject({ costUsd: 0.012 });
    expect((await withCostFloor(base(0.012), 0.05).ask("q", { lang: "en", region: null })).usage?.costEstimated).toBeUndefined();
    expect(DEFAULT_ANSWER_CALL_COST_USD).toBeGreaterThan(0);
    // Every non-Claude engine from env gets the floor; the estimate is configurable.
    const engines = answerEnginesFromEnv({ OPENAI_API_KEY: "k", GEMINI_API_KEY: "g", STARSIGN_ANSWER_CALL_COST_USD: "0.2" }, { fetch: async () => new Response(JSON.stringify({ output: [], usage: {} })) });
    expect(engines.map((e) => e.id).sort()).toEqual(["gemini", "openai"]);
  });
});
