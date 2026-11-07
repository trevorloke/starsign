import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestDb } from "@starsign/db/test";
import type { DbHandle } from "@starsign/db";
import { ConnectorRegistry, MockConnector } from "@starsign/connectors";
import { InMemoryScheduler, Starsign, SecretBox, type VisibilityEngine } from "@starsign/core";
import { FakeAnswerEngine, FakeGateway, defaultFakeHandlers } from "@starsign/ai";
import { createApp } from "../src/app.ts";

let h: DbHandle;
let m: Starsign;
let app: ReturnType<typeof createApp>;
let bare: ReturnType<typeof createApp>;
let ownerKey: string;
let editorKey: string;
let viewerKey: string;
let agentKey: string;
let brandId: string;
const auth = (k: string) => ({ "content-type": "application/json", authorization: `Bearer ${k}` });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();

const claude = new FakeAnswerEngine({
  id: "anthropic",
  label: "Claude",
  model: "fake-claude",
  answer: (q) => ({
    text: q.includes("ethical") ? "Northwind Coffee is praised for ethical sourcing." : "Popular picks are Stumptown and Northwind Coffee.",
    citations: [{ url: "https://northwind.coffee/ethics", title: "Ethics" }, { url: "https://www.dailyhive.com/x", title: "Daily Hive" }],
    model: "fake-claude",
    usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.002 },
  }),
});
const engines: VisibilityEngine[] = [claude];

beforeAll(async () => {
  h = await createTestDb();
  m = new Starsign({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)) });
  const ws = await m.workspaces.create({ slug: "nw", name: "Northwind" }, { type: "human", id: "u1" });
  ownerKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "o", actorType: "human", actorId: "u1", role: "owner" })).secret;
  editorKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "e", actorType: "human", actorId: "u2", role: "editor" })).secret;
  viewerKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "v", actorType: "human", actorId: "u3", role: "viewer" })).secret;
  agentKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "a", actorType: "mcp", actorId: "claude" })).secret;
  const gateway = new FakeGateway(defaultFakeHandlers());
  app = createApp(m, { gateway, answerEngines: engines });
  bare = createApp(m, { gateway: null, answerEngines: [] });
  const brand = await json(await app.request("/v1/entities", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ kind: "organization", name: "Northwind Coffee", relation: "own", trackTrend: false, scanPublic: false }) }));
  brandId = brand.id;
  await app.request("/v1/entities", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ kind: "organization", name: "Stumptown", relation: "competitor", trackTrend: false, scanPublic: false }) });
});
afterAll(() => h.close());

describe("visibility api", () => {
  it("lists engines with the variable that turns each on", async () => {
    const list = await json(await app.request("/v1/visibility/engines", { headers: auth(viewerKey) }));
    expect(list.find((e: { id: string }) => e.id === "anthropic")).toMatchObject({ configured: true, enabled: true, envVar: "ANTHROPIC_API_KEY", model: "fake-claude" });
    expect(list.find((e: { id: string }) => e.id === "perplexity")).toMatchObject({ configured: false, enabled: false, envVar: "PERPLEXITY_API_KEY" });
  });

  it("manages questions by role: editors write, viewers and agents read", async () => {
    const body = { question: "Is Northwind Coffee ethical?", languages: ["en", "fr"], regions: ["CA"], cadence: "weekly" };
    expect((await app.request("/v1/visibility/prompts", { method: "POST", headers: auth(viewerKey), body: JSON.stringify(body) })).status).toBe(403);
    expect((await app.request("/v1/visibility/prompts", { method: "POST", headers: auth(agentKey), body: JSON.stringify(body) })).status).toBe(403);
    expect((await app.request("/v1/visibility/prompts", { method: "POST", headers: auth(editorKey), body: JSON.stringify({ question: "" }) })).status).toBe(400);
    const created = await app.request("/v1/visibility/prompts", { method: "POST", headers: auth(editorKey), body: JSON.stringify(body) });
    expect(created.status).toBe(201);
    const q = await json(created);
    expect(q).toMatchObject({ question: "Is Northwind Coffee ethical?", languages: ["en", "fr"], regions: ["CA"], due: true });
    const listed = await json(await app.request("/v1/visibility/prompts", { headers: auth(agentKey) }));
    expect(listed.map((x: { id: string }) => x.id)).toEqual([q.id]);
    expect((await app.request(`/v1/visibility/prompts/${q.id}`, { method: "PATCH", headers: auth(viewerKey), body: JSON.stringify({ cadence: "daily" }) })).status).toBe(403);
    const patched = await json(await app.request(`/v1/visibility/prompts/${q.id}`, { method: "PATCH", headers: auth(editorKey), body: JSON.stringify({ cadence: "daily" }) }));
    expect(patched).toMatchObject({ cadence: "daily", languages: ["en", "fr"] });

    const other = await json(await app.request("/v1/visibility/prompts", { method: "POST", headers: auth(editorKey), body: JSON.stringify({ question: "Best coffee roasters in Vancouver" }) }));
    expect((await app.request(`/v1/visibility/prompts/${other.id}`, { method: "DELETE", headers: auth(viewerKey) })).status).toBe(403);
    expect((await app.request(`/v1/visibility/prompts/${other.id}`, { method: "DELETE", headers: auth(editorKey) })).status).toBe(204);
    expect((await json(await app.request("/v1/visibility/prompts?archived=1", { headers: auth(viewerKey) }))).length).toBe(2);
    expect((await app.request("/v1/visibility/prompts/vqp_nope", { headers: auth(viewerKey) })).status).toBe(404);
  });

  it("keeps engine and cadence limits for owners; editors set their own domains", async () => {
    expect((await app.request("/v1/visibility/settings", { method: "PATCH", headers: auth(editorKey), body: JSON.stringify({ engines: ["anthropic"] }) })).status).toBe(403);
    const byEditor = await json(await app.request("/v1/visibility/settings", { method: "PATCH", headers: auth(editorKey), body: JSON.stringify({ domains: { [brandId]: ["northwind.coffee"] } }) }));
    expect(byEditor.settings.domains).toEqual({ [brandId]: ["northwind.coffee"] });
    const byOwner = await json(await app.request("/v1/visibility/settings", { method: "PATCH", headers: auth(ownerKey), body: JSON.stringify({ engines: ["anthropic", "openai"], cadences: ["daily", "weekly"], maxPrompts: 10 }) }));
    expect(byOwner.settings).toMatchObject({ engines: ["anthropic", "openai"], maxPrompts: 10 });
    expect((await app.request("/v1/visibility/settings", { method: "PATCH", headers: auth(ownerKey), body: JSON.stringify({ domains: { ent_nope: ["x.com"] } }) })).status).toBe(400);
  });

  it("runs a question now, then reports and drills down", async () => {
    const [q] = await json(await app.request("/v1/visibility/prompts", { headers: auth(viewerKey) }));
    expect((await app.request(`/v1/visibility/prompts/${q.id}/run`, { method: "POST", headers: auth(viewerKey) })).status).toBe(403);
    expect((await bare.request(`/v1/visibility/prompts/${q.id}/run`, { method: "POST", headers: auth(editorKey) })).status).toBe(503);
    const run = await json(await app.request(`/v1/visibility/prompts/${q.id}/run`, { method: "POST", headers: auth(editorKey) }));
    expect(run).toMatchObject({ answers: 2, errors: 0, capped: 0, runId: expect.any(String) }); // en + fr, one region
    expect(claude.calls.map((c) => [c.opts.lang, c.opts.region])).toEqual([["en", "CA"], ["fr", "CA"]]);
    expect((await json(await app.request(`/v1/visibility/prompts/${q.id}`, { headers: auth(viewerKey) }))).due).toBe(false);

    const report = await json(await app.request("/v1/visibility/report", { headers: auth(viewerKey) }));
    const nw = report.entities.find((e: { id: string }) => e.id === brandId);
    expect(nw).toMatchObject({ answers: 2, mentioned: 2, share: 1, avgPosition: 1, ownCitations: 2 });
    expect(nw.sentiment).toBeGreaterThan(0);
    expect(report.citations.ownDomains).toEqual([{ domain: "northwind.coffee", citations: 2, answers: 2, ownerEntityId: brandId }]);
    expect(report.citations.otherDomains[0]).toMatchObject({ domain: "dailyhive.com" });
    expect(report.engines.find((e: { id: string }) => e.id === "anthropic").enabled).toBe(true);
    expect(report.latest[0].highlights[0]).toMatchObject({ entityId: brandId, start: 0, end: "Northwind Coffee".length });

    const answers = await json(await app.request(`/v1/visibility/answers?entity=${brandId}&engine=anthropic`, { headers: auth(agentKey) }));
    expect(answers).toHaveLength(2);
    expect(answers[0].mentions.find((x: { entityId: string }) => x.entityId === brandId)).toMatchObject({ mentioned: true, position: 1 });
    expect(await json(await app.request(`/v1/visibility/answers?promptId=${q.id}&engine=openai`, { headers: auth(viewerKey) }))).toEqual([]);
    expect((await app.request("/v1/visibility/report?from=2026-01-02&to=2026-01-01", { headers: auth(viewerKey) })).status).toBe(400);

    const runs = await json(await app.request("/v1/runs", { headers: auth(viewerKey) }));
    expect(runs.find((r: { operator: string }) => r.operator === "visibility")).toMatchObject({ status: "succeeded" });
  });

  it("suggests questions for editors, and says when no model is configured", async () => {
    const res = await app.request("/v1/visibility/suggest", { method: "POST", headers: auth(editorKey), body: JSON.stringify({ languages: ["en"], count: 3 }) });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.questions.length).toBeGreaterThan(0);
    expect(body.questions.every((x: { question: string }) => x.question.length > 3)).toBe(true);
    expect((await app.request("/v1/visibility/suggest", { method: "POST", headers: auth(viewerKey), body: "{}" })).status).toBe(403);
    expect((await bare.request("/v1/visibility/suggest", { method: "POST", headers: auth(editorKey), body: "{}" })).status).toBe(503);
  });
});
