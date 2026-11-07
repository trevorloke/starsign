import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "@starsign/db/test";
import { metrics, operatorRuns, visibilityAnswers, visibilityMentions, type DbHandle } from "@starsign/db";
import { ConnectorRegistry, MockConnector } from "@starsign/connectors";
import { InMemoryScheduler, SecretBox, Starsign, citationDomain, detectMentions, highlightSpans, ownerOf, slotFor, type AnswerJudge, type Principal, type QuestionSuggester, type VisibilityEngine } from "../src/index.ts";

let h: DbHandle;
let m: Starsign;
let owner: Principal;
let editor: Principal;
let viewer: Principal;
const agent = (ws: string): Principal => ({ workspaceId: ws, actor: { type: "mcp", id: "claude" } });
let clock = new Date("2026-11-04T10:00:00Z"); // a Wednesday
let ids: { northwind: string; blue: string; ana: string; stump: string };

/** An engine that answers from a script, counting its calls. */
function engine(id: string, label: string, answer: (q: string, lang: string) => string, citations: { url: string; title?: string }[] = [], costUsd = 0.01) {
  const calls: { q: string; lang: string; region: string | null }[] = [];
  const e: VisibilityEngine & { calls: typeof calls } = {
    id,
    label,
    model: `${id}-model`,
    calls,
    async ask(q, opts) {
      calls.push({ q, lang: opts.lang, region: opts.region });
      return { text: answer(q, opts.lang), citations, model: `${id}-model`, usage: { inputTokens: 100, outputTokens: 50, costUsd } };
    },
  };
  return e;
}

beforeAll(async () => {
  h = await createTestDb();
  m = new Starsign({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), now: () => clock });
  const ws = await m.workspaces.create({ slug: "roasters", name: "Northwind" }, { type: "human", id: "u" });
  owner = { workspaceId: ws.id, actor: { type: "human", id: "u" }, role: "owner" };
  editor = { workspaceId: ws.id, actor: { type: "human", id: "e" }, role: "editor" };
  viewer = { workspaceId: ws.id, actor: { type: "human", id: "v" }, role: "viewer" };
  const northwind = await m.entities.create(owner, { kind: "organization", name: "Northwind Coffee", relation: "own", aliases: ["Northwind", "ノースウィンド", "北风咖啡"], exclude: ["Northwind Traders"], trackTrend: false, scanPublic: false });
  const blue = await m.entities.create(owner, { kind: "organization", name: "Blue Bottle", relation: "competitor", aliases: ["ブルーボトル"], context: ["coffee", "café", "コーヒー", "roaster", "roasters"], trackTrend: false, scanPublic: false });
  const ana = await m.entities.create(owner, { kind: "person", name: "Ana Ruiz", parentId: northwind.id, relation: "own", trackTrend: false, scanPublic: false });
  const stump = await m.entities.create(owner, { kind: "organization", name: "Stumptown", relation: "competitor", trackTrend: false, scanPublic: false });
  ids = { northwind: northwind.id, blue: blue.id, ana: ana.id, stump: stump.id };
});
afterAll(() => h.close());

describe("detection", () => {
  type E = { id: string; name: string; aliases: string[]; handles: Record<string, string[]>; context: string[]; exclude: string[] };
  const ents = (): E[] => [
    { id: "nw", name: "Northwind Coffee", aliases: ["Northwind", "ノースウィンド", "北风咖啡"], handles: { x: ["northwindcoffee"] }, context: [], exclude: ["Northwind Traders"] },
    { id: "bb", name: "Blue Bottle", aliases: ["ブルーボトル", "블루보틀"], handles: {}, context: ["coffee", "café", "コーヒー", "커피"], exclude: [] },
    { id: "st", name: "Stumptown", aliases: [], handles: {}, context: [], exclude: [] },
  ];

  it("finds names and aliases in any script and ranks them by first appearance", () => {
    const en = detectMentions("For beans, try Stumptown first; Blue Bottle coffee is fine and @northwindcoffee ships fast.", ents());
    expect(en.map((d) => [d.entityId, d.position])).toEqual([["st", 1], ["bb", 2], ["nw", 3]]);
    expect(en.find((d) => d.entityId === "nw")!.term).toBe("@northwindcoffee");

    const ja = detectMentions("東京でおすすめのコーヒーはブルーボトルとノースウィンドです。", ents());
    expect(ja.map((d) => d.entityId)).toEqual(["bb", "nw"]);
    const zh = detectMentions("北风咖啡在温哥华很受欢迎", ents());
    expect(zh).toEqual([{ entityId: "nw", term: "北风咖啡", index: 0, position: 1 }]);
    const ko = detectMentions("블루보틀 커피 추천", ents());
    expect(ko.map((d) => d.entityId)).toEqual(["bb"]);
  });

  it("honours context and exclusion words, and folds full-width letters", () => {
    expect(detectMentions("Blue Bottle of wine, not a café chain? Actually no.", ents()).map((d) => d.entityId)).toEqual(["bb"]); // café is a context word
    expect(detectMentions("A blue bottle on the shelf.", ents())).toEqual([]); // no context word
    expect(detectMentions("Northwind Traders sells databases.", ents())).toEqual([]); // excluded namesake
    expect(detectMentions("ＳＴＵＭＰＴＯＷＮ is good", ents()).map((d) => d.entityId)).toEqual(["st"]);
  });

  it("highlights every mention once, in order, without overlaps", () => {
    const text = "Northwind Coffee (Northwind) beats Stumptown.";
    const spans = highlightSpans(text, ents());
    expect(spans.map((s) => [text.slice(s.start, s.end), s.entityId])).toEqual([["Northwind Coffee", "nw"], ["Northwind", "nw"], ["Stumptown", "st"]]);
  });

  it("reads citation domains and owners", () => {
    expect(citationDomain("https://www.northwind.coffee/about")).toBe("northwind.coffee");
    expect(citationDomain("https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", "eater.com")).toBe("eater.com");
    expect(citationDomain("not a url")).toBe("");
    const domains = { nw: ["northwind.coffee"] };
    expect(ownerOf("shop.northwind.coffee", domains)).toBe("nw");
    expect(ownerOf("evilnorthwind.coffee", domains)).toBeNull();
  });

  it("slots runs by UTC day and ISO week", () => {
    expect(slotFor("daily", new Date("2026-11-04T23:59:00Z"))).toBe("2026-11-04");
    expect(slotFor("weekly", new Date("2026-11-04T10:00:00Z"))).toBe("2026-W45");
    expect(slotFor("weekly", new Date("2026-11-08T23:00:00Z"))).toBe("2026-W45"); // Sunday, same week
    expect(slotFor("weekly", new Date("2026-11-09T00:00:00Z"))).toBe("2026-W46");
    expect(slotFor("weekly", new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });
});

describe("questions", () => {
  it("lets editors manage questions; viewers and agents cannot; owners set caps", async () => {
    await expect(m.visibility.createPrompt(viewer, { question: "Best coffee in Vancouver?" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(m.visibility.createPrompt(agent(owner.workspaceId), { question: "Best coffee in Vancouver?" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(m.visibility.createPrompt(editor, { question: "x" })).rejects.toThrow();
    await expect(m.visibility.createPrompt(editor, { question: "Best coffee?", entityIds: ["ent_nope"] })).rejects.toMatchObject({ code: "invalid" });
    const q = await m.visibility.createPrompt(editor, { question: "Best independent coffee roasters in Vancouver", languages: ["en", "ja"], translations: { ja: "バンクーバーでおすすめの独立系コーヒーロースターは？" }, regions: ["ca"], cadence: "daily" });
    expect(q).toMatchObject({ regions: ["CA"], cadence: "daily", languages: ["en", "ja"] });
    const patched = await m.visibility.updatePrompt(editor, q.id, { notes: "launch tracking" });
    expect(patched).toMatchObject({ notes: "launch tracking", cadence: "daily", languages: ["en", "ja"] }); // a patch keeps what it does not name

    await expect(m.visibility.updateSettings(editor, { cadences: ["weekly"] })).rejects.toMatchObject({ code: "forbidden" });
    await m.visibility.updateSettings(editor, { domains: { [ids.northwind]: ["https://www.northwind.coffee/"] } }); // editors set domains
    await m.visibility.updateSettings(owner, { cadences: ["weekly"], maxPrompts: 2 });
    await expect(m.visibility.createPrompt(editor, { question: "Is Northwind Coffee ethical?", cadence: "daily" })).rejects.toMatchObject({ code: "invalid" });
    const second = await m.visibility.createPrompt(editor, { question: "Is Northwind Coffee ethical?", cadence: "weekly" });
    await expect(m.visibility.createPrompt(editor, { question: "Third question?" })).rejects.toMatchObject({ code: "conflict" });
    await m.visibility.archivePrompt(editor, second.id);
    expect((await m.visibility.listPrompts(owner.workspaceId)).map((p) => p.question)).toEqual(["Best independent coffee roasters in Vancouver"]);
    expect(await m.visibility.settings(owner.workspaceId)).toMatchObject({ cadences: ["weekly"], maxPrompts: 2, domains: { [ids.northwind]: ["northwind.coffee"] } });
    await m.visibility.updateSettings(owner, { cadences: ["daily", "weekly"], maxPrompts: 20 });
    const events = await m.events.list({ workspaceId: owner.workspaceId, types: ["visibility.prompt_created", "visibility.prompt_archived", "visibility.settings_updated"] });
    expect(events.length).toBeGreaterThanOrEqual(5);
  });
});

describe("runs", () => {
  const claude = engine(
    "anthropic",
    "Claude",
    (q, lang) => (lang === "ja" ? "おすすめはブルーボトルです。ノースウィンドも人気があります。" : "Northwind Coffee is the best choice: ethical and popular. Stumptown is also good. Avoid Blue Bottle coffee if you want small-batch."),
    [{ url: "https://www.northwind.coffee/about", title: "About" }, { url: "https://eater.com/vancouver", title: "Eater" }],
  );
  const gpt = engine("openai", "ChatGPT", () => "Try Stumptown or Blue Bottle coffee roasters.", [{ url: "https://eater.com/vancouver" }]);
  // One call per answer; negative when the answer says to avoid the name. Costs a cent, like a real judge would.
  const judge: AnswerJudge = async (input) => ({
    entities: input.entities.map((e) => ({ id: e.id, sentiment: input.answer.includes(`Avoid ${e.matched}`) ? -0.5 : 0.6, summary: `Mentioned as ${e.matched}`, flags: [] })),
    costUsd: 0.01,
  });

  it("asks every engine in every language once per period, scores each answer, and is idempotent", async () => {
    const r1 = await m.visibility.runDue({ engines: [claude, gpt], judge });
    expect(r1).toHaveLength(1);
    expect(r1[0]).toMatchObject({ prompts: 1, answers: 4, errors: 0, capped: 0 }); // 2 engines × 2 languages × 1 region
    expect(claude.calls.map((c) => [c.lang, c.region])).toEqual([["en", "CA"], ["ja", "CA"]]);
    expect(claude.calls[1]!.q).toBe("バンクーバーでおすすめの独立系コーヒーロースターは？"); // the native question, not a translation of the English

    // Same hour, same day: nothing is due, nothing is asked again.
    expect(await m.visibility.runDue({ engines: [claude, gpt], judge })).toEqual([]);
    expect(claude.calls).toHaveLength(2);

    const answers = await m.visibility.answers(owner.workspaceId, { engine: "anthropic", lang: "en" });
    expect(answers).toHaveLength(1);
    const a = answers[0]!;
    expect(a.status).toBe("ok");
    expect(a.citations).toEqual([
      { url: "https://www.northwind.coffee/about", title: "About", domain: "northwind.coffee", ownerEntityId: ids.northwind },
      { url: "https://eater.com/vancouver", title: "Eater", domain: "eater.com", ownerEntityId: null },
    ]);
    const nw = a.mentions.find((x) => x.entityId === ids.northwind)!;
    expect(nw).toMatchObject({ mentioned: true, position: 1, ownCitations: 1, term: "Northwind Coffee" });
    expect(nw.sentiment).toBeGreaterThan(0);
    expect(nw.summary).toBe("Mentioned as Northwind Coffee");
    expect(a.mentions.find((x) => x.entityId === ids.blue)).toMatchObject({ mentioned: true, position: 3 });
    expect(a.mentions.find((x) => x.entityId === ids.blue)!.sentiment).toBeLessThan(0);
    expect(a.mentions.find((x) => x.entityId === ids.ana)).toMatchObject({ mentioned: false, position: null, sentiment: null });
    expect(a.text!.slice(a.highlights[0]!.start, a.highlights[0]!.end)).toBe("Northwind Coffee");

    // Metrics per tracked name, and one "visibility" operator run with the cost.
    const mm = await h.db.select().from(metrics).where(and(eq(metrics.entityType, "tracked_entity"), eq(metrics.entityId, ids.northwind)));
    expect(Object.fromEntries(mm.map((x) => [x.metric, x.value]))).toEqual({ ai_answer_mentions: 2, ai_answer_citations: 2 }); // en + ja Claude answers, each citing northwind.coffee
    const runs = await h.db.select().from(operatorRuns).where(eq(operatorRuns.operator, "visibility"));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.costUsd).toBeGreaterThan(0.04);
    expect(runs[0]!.summary).toMatch(/4 answer/);

    // Next day: the daily question is due again.
    clock = new Date("2026-11-05T10:00:00Z");
    expect((await m.visibility.duePrompts()).length).toBe(1);
    await m.visibility.runDue({ engines: [claude, gpt], judge });
    expect(claude.calls).toHaveLength(4);
  });

  it("records failures without retrying them in the same period", async () => {
    const broken: VisibilityEngine = { id: "gemini", label: "Gemini", model: "g", ask: async () => { throw new Error("HTTP 500: boom"); } };
    clock = new Date("2026-11-06T10:00:00Z");
    const [r] = await m.visibility.runDue({ engines: [claude, broken], judge: null });
    expect(r).toMatchObject({ answers: 2, errors: 2 });
    expect(await m.visibility.duePrompts()).toEqual([]);
    const rows = await h.db.select().from(visibilityAnswers).where(eq(visibilityAnswers.engine, "gemini"));
    expect(rows.map((x) => x.status)).toEqual(["error", "error"]);
    // Without a judge, mentions and positions are still recorded; tone is not.
    const todays = await m.visibility.answers(owner.workspaceId, { engine: "anthropic", from: new Date("2026-11-06T00:00:00Z") });
    expect(todays[0]!.mentions.find((x) => x.entityId === ids.northwind)).toMatchObject({ mentioned: true, sentiment: null });
  });

  it("skips and records capped when the workspace is over its model spend cap", async () => {
    const current = await m.policy.getActive(owner.workspaceId);
    const { version: _v, ...doc } = current as typeof current & { version?: number };
    await m.policy.update(owner, { ...doc, spendCaps: { ...current.spendCaps, modelUsdMonthly: 0.01 } });
    clock = new Date("2026-11-07T10:00:00Z");
    const before = claude.calls.length;
    const [r] = await m.visibility.runDue({ engines: [claude, gpt], judge });
    expect(r).toMatchObject({ answers: 0, capped: 4 });
    expect(claude.calls.length).toBe(before);
    const [run] = await h.db.select().from(operatorRuns).where(eq(operatorRuns.operator, "visibility")).orderBy(operatorRuns.startedAt).then((xs) => xs.slice(-1));
    expect(run!.summary).toMatch(/^capped: monthly model spend cap reached/);
    expect(await m.visibility.duePrompts()).toEqual([]); // the period is closed; it tries again tomorrow
    await m.policy.update(owner, { ...doc, spendCaps: { ...current.spendCaps, modelUsdMonthly: 100 } });
  });

  it("runs a question now, on demand, for editors only", async () => {
    const [q] = await m.visibility.listPrompts(owner.workspaceId);
    await expect(m.visibility.runNow(viewer, q!.id, { engines: [gpt], judge })).rejects.toMatchObject({ code: "forbidden" });
    clock = new Date("2026-11-07T11:00:00Z");
    const r = await m.visibility.runNow(editor, q!.id, { engines: [gpt], judge });
    expect(r).toMatchObject({ answers: 2 });
    // Running again in the same minute is a no-op (same slot).
    expect(await m.visibility.runNow(editor, q!.id, { engines: [gpt], judge })).toMatchObject({ answers: 0 });
  });

  it("reports share, position, tone, by engine, language and day, against the previous period", async () => {
    const r = await m.visibility.report(owner.workspaceId, new Date("2026-11-05T00:00:00Z"), new Date("2026-11-08T00:00:00Z"));
    const nw = r.entities.find((e) => e.id === ids.northwind)!;
    // 11-05: 4 answers (claude en/ja mention it, gpt en/ja do not); 11-06: 2 ok claude answers mention it; 11-07: 2 manual gpt answers do not.
    expect(nw).toMatchObject({ answers: 8, mentioned: 4, share: 0.5, avgPosition: 1, ownCitations: 4 }); // named first wherever named
    expect(nw.byEngine).toEqual([
      expect.objectContaining({ engine: "anthropic", answers: 4, mentioned: 4, share: 1 }),
      expect.objectContaining({ engine: "openai", answers: 4, mentioned: 0, share: 0 }),
    ]);
    expect(nw.byLanguage.map((l) => [l.lang, l.answers])).toEqual([["en", 4], ["ja", 4]]);
    expect(nw.trend.map((d) => [d.day, d.share])).toEqual([["2026-11-05", 0.5], ["2026-11-06", 1], ["2026-11-07", 0]]);
    // Previous period (11-02..11-05) holds the first run: 4 answers, 2 mentions.
    expect(nw.previous).toMatchObject({ answers: 4, mentioned: 2, share: 0.5 });
    expect(nw.change.share).toBe(0);
    const stump = r.entities.find((e) => e.id === ids.stump)!;
    expect(stump.share).toBeGreaterThan(0);
    expect(r.totals).toMatchObject({ answers: 8, errors: 2, capped: 4, prompts: 1 });
    expect(r.citations.ownDomains).toEqual([expect.objectContaining({ domain: "northwind.coffee", ownerEntityId: ids.northwind })]);
    expect(r.citations.otherDomains[0]).toMatchObject({ domain: "eater.com" });
    expect(r.citations.ownShare).toBeGreaterThan(0);
    expect(r.latest.length).toBeGreaterThan(0);

    const drill = await m.visibility.answers(owner.workspaceId, { entityId: ids.northwind });
    expect(drill.every((a) => a.mentions.some((x) => x.entityId === ids.northwind && x.mentioned))).toBe(true);
    const missing = await m.visibility.answers(owner.workspaceId, { entityId: ids.northwind, mentioned: false });
    expect(missing.every((a) => a.engine === "openai")).toBe(true);
    expect((await h.db.select().from(visibilityMentions)).length).toBeGreaterThan(0);
  });

  it("suggests questions without saving them", async () => {
    const seen: Parameters<QuestionSuggester>[0][] = [];
    const suggester: QuestionSuggester = async (input) => {
      seen.push(input);
      return { questions: [{ question: `Is ${input.entities[0]!.name} worth it?`, lang: "en", why: "reputation", names: [] }], costUsd: 0.002 };
    };
    const before = (await m.visibility.listPrompts(owner.workspaceId)).length;
    const res = await m.visibility.suggest(editor, suggester, { languages: ["en"], count: 3 });
    expect(res.questions).toHaveLength(1);
    expect(seen[0]).toMatchObject({ languages: ["en"], count: 3, existing: ["Best independent coffee roasters in Vancouver"] });
    expect(seen[0]!.entities.map((e) => e.name)).toContain("Northwind Coffee");
    expect((await m.visibility.listPrompts(owner.workspaceId)).length).toBe(before);
    await expect(m.visibility.suggest(viewer, suggester)).rejects.toMatchObject({ code: "forbidden" });
  });
});
