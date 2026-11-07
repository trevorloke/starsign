import { describe, expect, it } from "vitest";
import { StarsignClient } from "../src/client.ts";
import { visibilityHandlers, type ToolContext } from "../src/tools.ts";
import { NOW, fakeApi, textOf } from "./helpers.ts";

const ctx = (api: ReturnType<typeof fakeApi>): ToolContext => ({ client: new StarsignClient({ baseUrl: "http://api.test", apiKey: "star_t", fetch: api.fetch }), now: () => NOW });
const agg = (answers: number, mentioned: number, avgPosition: number | null, sentiment: number | null) => ({ answers, mentioned, share: answers ? mentioned / answers : null, avgPosition, sentiment });

const report = {
  totals: { answers: 20, prompts: 4, errors: 0, capped: 2, costUsd: 0.41 },
  entities: [
    { id: "ent_nw", name: "Northwind Coffee", parentId: null, ...agg(20, 13, 1.4, 0.42), ownCitations: 5, flagged: 1, change: { share: 0.1, avgPosition: -0.2, sentiment: 0.05 }, byEngine: [{ engine: "anthropic", ...agg(10, 8, 1.2, 0.5) }], byLanguage: [] },
    { id: "ent_bb", name: "Blue Bottle", parentId: null, ...agg(20, 15, 1.1, 0.3), ownCitations: 0, flagged: 0, change: { share: null, avgPosition: null, sentiment: null }, byEngine: [], byLanguage: [] },
    { id: "ent_x", name: "Nobody asked", parentId: null, ...agg(0, 0, null, null), ownCitations: 0, flagged: 0, change: { share: null, avgPosition: null, sentiment: null }, byEngine: [], byLanguage: [] },
  ],
  citations: { total: 40, own: 5, ownShare: 0.125, ownDomains: [{ domain: "northwind.coffee", citations: 5 }], otherDomains: [{ domain: "eater.com", citations: 12 }] },
  engines: [
    { id: "anthropic", label: "Claude", configured: true, enabled: true, envVar: "ANTHROPIC_API_KEY" },
    { id: "openai", label: "ChatGPT", configured: false, enabled: false, envVar: "OPENAI_API_KEY" },
  ],
};

describe("get_ai_visibility", () => {
  it("summarises share, position, tone and change per tracked name, and citations", async () => {
    const api = fakeApi([{ path: "/v1/visibility/report", body: report }]);
    const res = await visibilityHandlers.get_ai_visibility(ctx(api), { days: 28 });
    const text = textOf(res);
    expect(api.last().url.searchParams.get("from")).toBe(new Date(NOW.getTime() - 28 * 86_400_000).toISOString());
    expect(text).toMatch(/20 answers to 4 question\(s\) from Claude; 2 skipped at the spend cap/);
    expect(text.indexOf("Blue Bottle")).toBeLessThan(text.indexOf("Northwind Coffee")); // highest share first
    expect(text).toMatch(/Northwind Coffee · in 65% of 20 answers · \+10 pts vs before · avg position 1.4 · tone 0.42 · 5 own-site citation/);
    expect(text).not.toContain("Nobody asked");
    expect(text).toMatch(/5 of 40 to own sites \(13%\).*eater.com 12/);
  });

  it("adds the latest answers for one name", async () => {
    const api = fakeApi([
      { path: "/v1/visibility/report", body: report },
      { path: "/v1/visibility/answers", body: [{ engine: "anthropic", lang: "ja", question: "おすすめのコーヒー", askedAt: "2026-11-01T10:00:00Z", text: "…", citations: [], mentions: [{ entityId: "ent_nw", name: "Northwind Coffee", mentioned: true, position: 2, sentiment: 0.4, summary: "Listed as a local favourite", flags: [] }] }] },
    ]);
    const text = textOf(await visibilityHandlers.get_ai_visibility(ctx(api), { days: 7, entity: "ent_nw" }));
    expect(api.last().url.searchParams.get("entity")).toBe("ent_nw");
    expect(text).toMatch(/2026-11-01 anthropic \(ja\) · "おすすめのコーヒー" · #2 · tone 0.40 · Listed as a local favourite/);
  });
});
