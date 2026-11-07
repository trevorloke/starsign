import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestDb } from "@starsign/db/test";
import type { DbHandle } from "@starsign/db";
import { ConnectorRegistry, MockConnector } from "@starsign/connectors";
import { InMemoryScheduler, Starsign, SecretBox } from "@starsign/core";
import { createApp } from "../src/app.ts";

let h: DbHandle;
let m: Starsign;
let app: ReturnType<typeof createApp>;
let wsId: string;
let acct: string;
let ownerKey: string;
let editorKey: string;
let viewerKey: string;
let agentKey: string;
let editorId: string;
let approverId: string;
const auth = (k: string) => ({ "content-type": "application/json", authorization: `Bearer ${k}` });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();
let n = 0;
const msg = (text: string, extra: Record<string, unknown> = {}) => ({ network: "bluesky", kind: "mention", externalId: `b${++n}`, authorHandle: `p${n}.bsky.social`, authorName: `P${n}`, text, url: null, parentExternalId: null, occurredAt: new Date(Date.now() - (100 - n) * 1000).toISOString(), raw: {}, ...extra });
const call = (key: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: auth(key), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeAll(async () => {
  h = await createTestDb();
  m = new Starsign({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)) });
  const ws = await m.workspaces.create({ slug: "support", name: "Northwind" }, { type: "human", id: "u-owner" });
  wsId = ws.id;
  const member = async (email: string, name: string, role: "owner" | "approver" | "editor" | "viewer") => {
    const u = await m.workspaces.ensureUser(email, name);
    await m.workspaces.addMember(ws.id, u.id, role);
    return { id: u.id, key: (await m.workspaces.createApiKey({ workspaceId: ws.id, name, actorType: "human", actorId: u.id, role })).secret };
  };
  const owner = await member("maya@northwind.coffee", "Maya Chen", "owner");
  ownerKey = owner.key;
  const ed = await member("sam@northwind.coffee", "Sam Okafor", "editor");
  editorKey = ed.key;
  editorId = ed.id;
  approverId = (await member("dev@northwind.coffee", "Dev Patel", "approver")).id;
  viewerKey = (await member("rita@quill.agency", "Rita Alvarez", "viewer")).key;
  agentKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "agent", actorType: "mcp", actorId: "claude" })).secret;
  acct = (await m.accounts.connect({ workspaceId: ws.id, actor: { type: "human", id: owner.id }, role: "owner" }, { network: "bluesky", externalId: "did:nw", handle: "northwind.coffee", connector: "mock" })).id;
  app = createApp(m);
});
afterAll(() => h.close());

describe("inbox api", () => {
  it("manages labels, targets and rules by role, routes new conversations, lists with counts, and works items", async () => {
    // Settings: owners/approvers only.
    expect((await call(editorKey, "PATCH", "/v1/inbox/settings", { tags: [{ name: "vip" }] })).status).toBe(403);
    expect((await call(agentKey, "PATCH", "/v1/inbox/settings", { tags: [{ name: "vip" }] })).status).toBe(403);
    const settings = await json(await call(ownerKey, "PATCH", "/v1/inbox/settings", { tags: [{ name: "vip", color: "amber" }, { name: "returns" }], sla: { urgent: 10 }, businessHours: { enabled: true, days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" } }));
    expect(settings).toMatchObject({ sla: { urgent: 10, high: 60, normal: 480 }, businessHours: { enabled: true, start: "08:00" }, timezone: "UTC" });
    expect((await call(ownerKey, "PATCH", "/v1/inbox/settings", { businessHours: { start: "18:00", end: "08:00" } })).status).toBe(400);
    expect(await json(await call(viewerKey, "GET", "/v1/inbox/settings"))).toMatchObject({ tags: [{ name: "vip", color: "amber" }, { name: "returns", color: "gray" }] });

    // Rules.
    expect((await call(editorKey, "POST", "/v1/inbox/rules", { name: "r", actions: { tags: ["vip"] } })).status).toBe(403);
    expect((await call(agentKey, "POST", "/v1/inbox/rules", { name: "r", actions: { tags: ["vip"] } })).status).toBe(403);
    const rule = await call(ownerKey, "POST", "/v1/inbox/rules", { name: "Returns", conditions: { keywords: ["return", "refund"] }, actions: { roundRobin: [editorId, approverId], tags: ["returns"], priority: "high" } });
    expect(rule.status).toBe(201);
    const r1 = await json(rule);
    const r2 = await json(await call(ownerKey, "POST", "/v1/inbox/rules", { name: "Off", enabled: false, actions: { spam: true } }));
    expect((await json(await call(ownerKey, "POST", "/v1/inbox/rules/reorder", { ids: [r2.id, r1.id] }))).map((r: { name: string }) => r.name)).toEqual(["Off", "Returns"]);
    expect((await json(await call(ownerKey, "PATCH", `/v1/inbox/rules/${r2.id}`, { name: "Disabled spam rule" }))).name).toBe("Disabled spam rule");
    expect((await call(ownerKey, "DELETE", `/v1/inbox/rules/${r2.id}`)).status).toBe(204);
    expect(await json(await call(viewerKey, "GET", "/v1/inbox/rules"))).toHaveLength(1);

    await m.listening.ingestItems(wsId, acct, [msg("I want to return my grinder"), msg("refund please"), msg("Hello there"), msg("Doors at 7", { kind: "own_post", authorHandle: "northwind.coffee" })]);

    const all = await json(await call(viewerKey, "GET", "/v1/inbox?status=open&sort=priority"));
    expect(all.items).toHaveLength(3);
    expect(all.items.map((i: { state: { priority: string } }) => i.state.priority)).toEqual(["high", "high", "normal"]);
    expect(all.items[0].state.tags).toEqual(["returns"]);
    expect(new Set(all.items.slice(0, 2).map((i: { state: { assignee: string } }) => i.state.assignee))).toEqual(new Set([editorId, approverId]));
    expect(all.items[0].sla).toMatchObject({ targetMinutes: 60, dueAt: expect.any(String) });
    expect(all.counts).toMatchObject({ open: 3, pending: 0, done: 0, spam: 0, unassigned: 1 });
    expect(all.viewer).toMatchObject({ canWork: false, canManage: false });

    const mine = await json(await call(editorKey, "GET", "/v1/inbox?status=open,pending&assignee=me"));
    expect(mine.items).toHaveLength(1);
    expect(mine.counts.mine).toBe(1);
    expect(mine.viewer).toMatchObject({ userId: editorId, canWork: true, canAssign: true, canManage: false });
    const hello = all.items.find((i: { activity: { text: string } }) => i.activity.text === "Hello there");
    expect((await json(await call(viewerKey, "GET", "/v1/inbox?assignee=none"))).items.map((i: { activity: { id: string } }) => i.activity.id)).toEqual([hello.activity.id]);
    expect((await json(await call(viewerKey, "GET", "/v1/inbox?q=grinder"))).items).toHaveLength(1);
    expect((await json(await call(viewerKey, "GET", "/v1/inbox?tag=returns"))).items).toHaveLength(2);
    expect((await json(await call(viewerKey, "GET", "/v1/inbox?network=x"))).items).toHaveLength(0);
    expect((await call(viewerKey, "GET", "/v1/inbox?status=closed")).status).toBe(400);

    // One item: viewers can't; agents can set status/labels but not assign; editors assign to themselves.
    const id = hello.activity.id;
    expect((await call(viewerKey, "PATCH", `/v1/inbox/${id}`, { status: "done" })).status).toBe(403);
    expect((await call(agentKey, "PATCH", `/v1/inbox/${id}`, { assignee: editorId })).status).toBe(403);
    expect((await json(await call(agentKey, "PATCH", `/v1/inbox/${id}`, { addTags: ["vip"] }))).state.tags).toEqual(["vip"]);
    const assigned = await json(await call(editorKey, "PATCH", `/v1/inbox/${id}`, { assignee: "me", priority: "urgent" }));
    expect(assigned.state).toMatchObject({ assignee: editorId, priority: "urgent" });
    expect(assigned.sla.targetMinutes).toBe(10);
    expect((await call(editorKey, "PATCH", `/v1/inbox/${id}`, { tags: ["nope"] })).status).toBe(400);

    // Bulk.
    const ids = all.items.map((i: { activity: { id: string } }) => i.activity.id);
    expect((await call(agentKey, "PATCH", "/v1/inbox", { ids, patch: { assignee: null } })).status).toBe(403);
    const bulk = await json(await call(editorKey, "PATCH", "/v1/inbox", { ids, patch: { status: "done" } }));
    expect(bulk.updated).toBe(3);
    expect((await json(await call(viewerKey, "GET", "/v1/inbox"))).counts).toMatchObject({ open: 0, done: 3 });

    // Every change is in the ledger.
    const ledger = await json(await call(viewerKey, "GET", "/v1/ledger?types=inbox.item_updated,inbox.rule_applied,inbox.rule_created,inbox.settings_updated&limit=100"));
    const types = new Set(ledger.map((e: { type: string }) => e.type));
    expect(types).toEqual(new Set(["inbox.item_updated", "inbox.rule_applied", "inbox.rule_created", "inbox.settings_updated"]));
  });

  it("shows a conversation with its thread, notes with mentions, and saved replies filled for it", async () => {
    const root = msg("Do you ship to Mexico City?", { authorName: "Lucía", authorHandle: "lucia.bsky.social" });
    await m.listening.ingestItems(wsId, acct, [root, msg("3 bags of the Ethiopian", { kind: "reply", parentExternalId: root.externalId, authorHandle: root.authorHandle })]);
    const { items } = await json(await call(viewerKey, "GET", "/v1/inbox?q=Mexico"));
    const id = items[0].activity.id;
    expect(items[0]).toMatchObject({ state: { messageCount: 2 }, latest: { text: "3 bags of the Ethiopian" } });
    const convo = await json(await call(viewerKey, "GET", `/v1/inbox/${id}`));
    expect(convo.messages.map((x: { text: string }) => x.text)).toEqual(["Do you ship to Mexico City?", "3 bags of the Ethiopian"]);
    // A message id inside the thread resolves to the conversation.
    expect((await json(await call(viewerKey, "GET", `/v1/inbox/${convo.messages[1].id}`))).item.activity.id).toBe(id);

    expect((await call(viewerKey, "POST", `/v1/inbox/${id}/notes`, { text: "hi" })).status).toBe(403);
    const note = await call(editorKey, "POST", `/v1/inbox/${id}/notes`, { text: "@dev can we ship to MX?" });
    expect(note.status).toBe(201);
    const nt = await json(note);
    expect(nt.mentions).toEqual([approverId]);
    expect((await call(agentKey, "POST", `/v1/inbox/${id}/notes`, { text: "Customer ordered twice before." })).status).toBe(201);
    expect(await json(await call(viewerKey, "GET", `/v1/inbox/${id}/notes`))).toHaveLength(2);
    expect((await call(ownerKey, "PATCH", `/v1/inbox/notes/${nt.id}`, { text: "edit" })).status).toBe(403);
    expect((await json(await call(editorKey, "PATCH", `/v1/inbox/notes/${nt.id}`, { text: "@dev @maya can we ship to MX?" }))).mentions.length).toBe(2);
    expect((await call(ownerKey, "DELETE", `/v1/inbox/notes/${nt.id}`)).status).toBe(204);

    expect((await call(viewerKey, "POST", "/v1/saved-replies", { name: "x", text: "y" })).status).toBe(403);
    const saved = await json(await call(editorKey, "POST", "/v1/saved-replies", { name: "Shipping MX", text: "Hola {{author_name}} ({{author_handle}}), sí. — {{brand}}", lang: "es" }));
    expect(await json(await call(viewerKey, "GET", "/v1/saved-replies"))).toHaveLength(1);
    expect(await json(await call(viewerKey, "POST", `/v1/saved-replies/${saved.id}/fill`, { activityId: id }))).toEqual({ text: "Hola Lucía (@lucia.bsky.social), sí. — Northwind", lang: "es" });
    expect((await json(await call(editorKey, "PATCH", `/v1/saved-replies/${saved.id}`, { text: "Hi {{author_name}}" }))).text).toBe("Hi {{author_name}}");
    expect((await call(editorKey, "DELETE", `/v1/saved-replies/${saved.id}`)).status).toBe(204);

    // Replying (through the gate, as before) counts as the first response and moves it to pending.
    // An editor's reply waiting on an approver is not a response yet.
    const waiting = await json(await call(editorKey, "POST", `/v1/feed/${convo.messages[1].id}/reply`, { text: "Sí, enviamos." }));
    expect(waiting.post.status).toBe("pending_approval");
    expect(await m.inbox.noteReply(wsId, waiting.post.id)).toEqual([]);
    expect((await json(await call(viewerKey, "GET", `/v1/inbox/${id}`))).item.state).toMatchObject({ status: "open", firstResponseAt: null });
    const reply = await json(await call(ownerKey, "POST", `/v1/feed/${convo.messages[1].id}/reply`, { text: "Sí, enviamos a CDMX." }));
    await m.inbox.noteReply(wsId, reply.post.id);
    const after = await json(await call(viewerKey, "GET", `/v1/inbox/${id}`));
    expect(after.item.state).toMatchObject({ status: "pending", firstResponseAt: expect.any(String) });
    expect(after.replies.map((r: { text: string; status: string }) => [r.text, r.status])).toEqual([["Sí, enviamos.", "pending_approval"], ["Sí, enviamos a CDMX.", "scheduled"]]);
  });

  it("refuses unknown items and snooze in the past", async () => {
    expect((await call(editorKey, "PATCH", "/v1/inbox/act_nope", { status: "done" })).status).toBe(404);
    const { items } = await json(await call(viewerKey, "GET", "/v1/inbox?status=pending"));
    expect((await call(editorKey, "PATCH", `/v1/inbox/${items[0].activity.id}`, { snoozedUntil: "2000-01-01T00:00:00Z" })).status).toBe(400);
  });
});
