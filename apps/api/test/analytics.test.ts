import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestDb } from "@starsign/db/test";
import type { DbHandle } from "@starsign/db";
import { ConnectorRegistry, MockConnector } from "@starsign/connectors";
import { InMemoryScheduler, Starsign, SecretBox, type MailMessage } from "@starsign/core";
import { createApp } from "../src/app.ts";

let h: DbHandle;
let app: ReturnType<typeof createApp>;
let ownerKey: string;
let viewerKey: string;
let agentKey: string;
let otherKey: string;
const mail: MailMessage[] = [];
const auth = (k: string) => ({ "content-type": "application/json", authorization: `Bearer ${k}` });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();

beforeAll(async () => {
  h = await createTestDb();
  const m = new Starsign({
    handle: h,
    connectors: new ConnectorRegistry().register(new MockConnector()),
    scheduler: new InMemoryScheduler(),
    secrets: new SecretBox(randomBytes(32)),
    linkBaseUrl: "https://app.acme.test/l",
    auth: { mailer: { send: async (msg) => void mail.push(msg) }, publicUrl: "https://app.acme.test" },
  });
  const ws = await m.workspaces.create({ slug: "acme", name: "Acme", timezone: "Europe/London" }, { type: "human", id: "u1" });
  const ws2 = await m.workspaces.create({ slug: "other", name: "Other" }, { type: "human", id: "u9" });
  ownerKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "o", actorType: "human", actorId: "u1", role: "owner" })).secret;
  viewerKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "v", actorType: "human", actorId: "u2", role: "viewer" })).secret;
  agentKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "claude", actorType: "mcp", actorId: "claude" })).secret;
  otherKey = (await m.workspaces.createApiKey({ workspaceId: ws2.id, name: "x", actorType: "human", actorId: "u9", role: "owner" })).secret;
  app = createApp(m, { publicUrl: "https://app.acme.test" });
});
afterAll(() => h.close());

describe("analytics api", () => {
  it("answers one payload for the view, for anyone in the workspace", async () => {
    const r = await app.request("/v1/analytics?from=2026-10-01T00:00:00Z&to=2026-10-31T00:00:00Z&networks=x,bluesky", { headers: auth(viewerKey) });
    expect(r.status).toBe(200);
    const a = await json(r);
    expect(Object.keys(a).sort()).toEqual(["bestTimes", "byAccount", "byNetwork", "change", "currency", "filters", "measured", "mentions", "previous", "previousSeries", "series", "topPosts", "totals", "whatWorked", "window"].sort());
    expect(a.window).toMatchObject({ days: 30, timezone: "Europe/London" });
    expect(a.filters.networks).toEqual(["x", "bluesky"]);
    expect(a.bestTimes.cells).toHaveLength(168);
    expect(a.series.length).toBeGreaterThanOrEqual(30);
    expect((await app.request("/v1/analytics?from=nonsense", { headers: auth(viewerKey) })).status).toBe(400);
    expect((await app.request("/v1/analytics?from=2026-11-01T00:00:00Z&to=2026-10-01T00:00:00Z", { headers: auth(viewerKey) })).status).toBe(400);
    expect((await app.request("/v1/analytics")).status).toBe(401);
  });
});

describe("reports api", () => {
  let id: string;

  it("creates, lists, updates and renders a report with the right roles", async () => {
    const body = { name: "Bloom weekly", recipients: ["c@bloom.test"], schedule: { kind: "weekly", weekday: 0, hour: 8 }, branding: { clientName: "Bloom", accent: "#d9480f" }, intro: "Hello <there>" };
    expect((await app.request("/v1/reports", { method: "POST", headers: auth(viewerKey), body: JSON.stringify(body) })).status).toBe(403);
    expect((await app.request("/v1/reports", { method: "POST", headers: auth(agentKey), body: JSON.stringify(body) })).status).toBe(403);
    const created = await app.request("/v1/reports", { method: "POST", headers: auth(ownerKey), body: JSON.stringify(body) });
    expect(created.status).toBe(201);
    const r = await json(created);
    id = r.id;
    expect(r).toMatchObject({ name: "Bloom weekly", scheduleSummary: "Every Monday at 8:00 to 1 person", period: "last_7_days" });
    expect((await app.request("/v1/reports", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ name: "x", schedule: { kind: "weekly", weekday: 9, hour: 8 } }) })).status).toBe(400);

    const listed = await json(await app.request("/v1/reports", { headers: auth(viewerKey) }));
    expect(listed.map((x: { id: string }) => x.id)).toContain(id);
    expect((await app.request(`/v1/reports/${id}`, { headers: auth(otherKey) })).status).toBe(404);

    expect((await app.request(`/v1/reports/${id}`, { method: "PATCH", headers: auth(viewerKey), body: JSON.stringify({ name: "x" }) })).status).toBe(403);
    expect((await app.request(`/v1/reports/${id}`, { method: "PATCH", headers: auth(agentKey), body: JSON.stringify({ recipients: ["evil@x.test"] }) })).status).toBe(403);
    const patched = await json(await app.request(`/v1/reports/${id}`, { method: "PATCH", headers: auth(ownerKey), body: JSON.stringify({ sections: ["summary", "best_times", "what_worked"], period: "calendar_month" }) }));
    expect(patched).toMatchObject({ period: "calendar_month", sections: ["summary", "best_times", "what_worked"] });

    const rendered = await app.request(`/v1/reports/${id}/render?format=html`, { headers: auth(viewerKey) });
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("content-type")).toContain("text/html");
    expect(rendered.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await rendered.text();
    expect(html).toContain("<h2>Best times to post</h2>");
    expect(html).toContain("Hello &lt;there&gt;");
    expect((await app.request(`/v1/reports/${id}/render?format=pdf`, { headers: auth(viewerKey) })).status).toBe(400);

    const preview = await app.request("/v1/reports/preview", { method: "POST", headers: auth(viewerKey), body: JSON.stringify({ name: "Draft <1>", sections: ["summary"] }) });
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain("<h1>Draft &lt;1&gt;</h1>");
  });

  it("sends now, by a person or an agent, never by a viewer", async () => {
    expect((await app.request(`/v1/reports/${id}/send`, { method: "POST", headers: auth(viewerKey) })).status).toBe(403);
    const r = await app.request(`/v1/reports/${id}/send`, { method: "POST", headers: auth(agentKey) });
    expect(r.status).toBe(200);
    const out = await json(r);
    expect(out).toMatchObject({ sent: 1 });
    expect(out.viewUrl).toMatch(/^https:\/\/app\.acme\.test\/r\/[\w-]{40,}$/);
    expect(mail.at(-1)).toMatchObject({ to: "c@bloom.test" });
    expect(mail.at(-1)!.html).toContain("<!doctype html>");
    // The emailed link opens the report without signing in.
    expect((await app.request(new URL(out.viewUrl).pathname)).status).toBe(200);
  });

  it("shares a public, read-only link and revokes it", async () => {
    expect((await app.request(`/v1/reports/${id}/share`, { method: "POST", headers: auth(viewerKey) })).status).toBe(403);
    const r = await app.request(`/v1/reports/${id}/share`, { method: "POST", headers: auth(ownerKey) });
    expect(r.status).toBe(201);
    const { url } = await json(r);
    const path = new URL(url).pathname;
    const pub = await app.request(path);
    expect(pub.status).toBe(200);
    expect(pub.headers.get("cache-control")).toBe("no-store");
    expect(pub.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await pub.text()).toContain("<h1>Bloom weekly</h1>");
    // Read-only: nothing but GET exists there.
    expect((await app.request(path, { method: "POST" })).status).toBe(404);
    expect((await app.request(path, { method: "DELETE" })).status).toBe(404);
    expect((await app.request("/r/not-a-token")).status).toBe(404);

    expect((await app.request(`/v1/reports/${id}/share`, { method: "DELETE", headers: auth(agentKey) })).status).toBe(403);
    expect((await app.request(`/v1/reports/${id}/share`, { method: "DELETE", headers: auth(ownerKey) })).status).toBe(204);
    expect((await app.request(path)).status).toBe(404);
    const report = await json(await app.request(`/v1/reports/${id}`, { headers: auth(ownerKey) }));
    expect(report.shares.active).toBe(0);
  });

  it("deletes for editors and up only", async () => {
    expect((await app.request(`/v1/reports/${id}`, { method: "DELETE", headers: auth(viewerKey) })).status).toBe(403);
    expect((await app.request(`/v1/reports/${id}`, { method: "DELETE", headers: auth(ownerKey) })).status).toBe(204);
    expect((await app.request(`/v1/reports/${id}`, { headers: auth(ownerKey) })).status).toBe(404);
    const ledger = await json(await app.request(`/v1/ledger?subjectType=report&subjectId=${id}`, { headers: auth(ownerKey) }));
    expect(ledger.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(["report.created", "report.updated", "report.sent", "report.shared", "report.share_revoked", "report.deleted"]));
  });
});
