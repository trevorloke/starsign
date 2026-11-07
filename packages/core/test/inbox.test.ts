import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createTestDb } from "@starsign/db/test";
import { inboxItems, type DbHandle } from "@starsign/db";
import { ConnectorRegistry, MockConnector } from "@starsign/connectors";
import type { ActivityInput } from "@starsign/schema";
import {
  DEFAULT_INBOX_SETTINGS,
  InMemoryScheduler,
  SecretBox,
  Starsign,
  fillSavedReply,
  parseMentions,
  replyVariables,
  slaDueAt,
  slaView,
  type Principal,
} from "../src/index.ts";

let h: DbHandle;
let m: Starsign;
let ws: string;
let acct: string;
let owner: Principal;
let approver: Principal;
let editor: Principal;
let editor2: Principal;
let viewer: Principal;
let agent: Principal;
let n = 0;
const T0 = Date.parse("2026-11-04T15:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const msg = (text: string, extra: Partial<ActivityInput> = {}): ActivityInput => ({
  network: "bluesky",
  kind: "mention",
  externalId: `e${++n}`,
  authorHandle: `person${n}.bsky.social`,
  authorName: `Person ${n}`,
  text,
  url: null,
  parentExternalId: null,
  occurredAt: at(n),
  raw: {},
  ...extra,
});
const ingest = async (...items: ActivityInput[]) => {
  await m.listening.ingestItems(ws, acct, items);
  const rows = await m.listening.feed(ws, { limit: 500 });
  return items.map((i) => rows.find((r) => r.externalId === i.externalId)!.id);
};
const item = async (id: string) => (await h.db.select().from(inboxItems).where(eq(inboxItems.activityId, id)))[0];
const ledger = async (types: string[]) => m.events.list({ workspaceId: ws, types, limit: 500 });

beforeAll(async () => {
  h = await createTestDb();
  m = new Starsign({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), now: () => new Date(T0 + 60 * 60_000) });
  const w = await m.workspaces.create({ slug: "nw", name: "Northwind" }, { type: "human", id: "u-owner" });
  ws = w.id;
  const person = async (email: string, name: string, role: "owner" | "approver" | "editor" | "viewer"): Promise<Principal> => {
    const u = await m.workspaces.ensureUser(email, name);
    await m.workspaces.addMember(ws, u.id, role);
    return { workspaceId: ws, actor: { type: "human", id: u.id }, role };
  };
  owner = await person("maya@northwind.coffee", "Maya Chen", "owner");
  approver = await person("dev@northwind.coffee", "Dev Patel", "approver");
  editor = await person("sam@northwind.coffee", "Sam Okafor", "editor");
  editor2 = await person("ana.ruiz@northwind.coffee", "Ana Ruiz", "editor");
  viewer = await person("rita@quill.agency", "Rita Alvarez", "viewer");
  agent = { workspaceId: ws, actor: { type: "mcp", id: "claude" } };
  acct = (await m.accounts.connect(owner, { network: "bluesky", externalId: "did:nw", handle: "northwind.coffee", connector: "mock" })).id;
  await m.inbox.updateSettings(owner, { tags: [{ name: "wholesale", color: "green" }, { name: "billing" }, { name: "japan", color: "red" }, { name: "x" }] });
});
afterAll(() => h.close());

describe("conversation state on ingest", () => {
  it("starts new messages open, normal, unassigned, with a first-response target; own posts, likes and our own replies are not inbox items", async () => {
    const [mention, own, like, ours] = await ingest(
      msg("Do you ship to Canada?"),
      msg("Doors at 7", { kind: "own_post", authorHandle: "northwind.coffee" }),
      msg(null as unknown as string, { kind: "like" }),
      msg("Thanks, we do", { kind: "reply", authorHandle: "@Northwind.Coffee" }),
    );
    const row = await item(mention!);
    expect(row).toMatchObject({ status: "open", priority: "normal", assignee: null, tags: [], threadId: mention, messageCount: 1, firstResponseAt: null, doneAt: null });
    const a = (await m.listening.feed(ws, { ids: [mention!] }))[0]!;
    expect(row!.slaDueAt!.getTime()).toBe(a.occurredAt.getTime() + 480 * 60_000);
    expect(await item(own!)).toBeUndefined();
    expect(await item(like!)).toBeUndefined();
    expect(await item(ours!)).toBeUndefined();
    // Public search results (no connected account) stay in the feed and the tracker.
    const pub = msg("Northwind opens in Shibuya", { network: "news" as ActivityInput["network"] });
    await m.listening.ingestItems(ws, null, [pub]);
    const pubId = (await m.listening.feed(ws, { limit: 500 })).find((r) => r.externalId === pub.externalId)!.id;
    expect(await item(pubId)).toBeUndefined();
    await expect(m.inbox.patch(editor, pubId, { status: "done" })).rejects.toThrow(/public search/);
  });

  it("threads replies into their root conversation and reopens it when the customer writes again", async () => {
    const root = msg("My order never arrived");
    const [rootId] = await ingest(root);
    await m.inbox.patch(editor, rootId!, { status: "done" });
    const [replyId] = await ingest(msg("Still waiting, any news?", { kind: "reply", parentExternalId: root.externalId, authorHandle: root.authorHandle }));
    expect(await item(replyId!)).toMatchObject({ threadId: rootId });
    expect(await item(rootId!)).toMatchObject({ status: "open", doneAt: null, messageCount: 2 });
    expect((await ledger(["inbox.reopened"])).map((e) => e.subjectId)).toContain(rootId);
    // Direct messages thread by conversation id.
    const dm = (text: string) => msg(text, { network: "bluesky", kind: "dm", conversation: { id: "convo-1", type: "direct" } });
    const [d1, d2] = await ingest(dm("hola"), dm("¿hacen envíos a México?"));
    expect(await item(d2!)).toMatchObject({ threadId: d1 });
    const convo = await m.inbox.conversation(viewer, d2!);
    expect(convo.item.activity.id).toBe(d1);
    expect(convo.messages.map((x) => x.id)).toEqual([d1, d2]);
    expect(convo.item.latest?.id).toBe(d2);
  });
});

describe("rules", () => {
  it("apply in order, first match per field wins, labels add up, round robin rotates, and each applied rule is in the ledger", async () => {
    const team = [editor.actor.id, editor2.actor.id];
    await m.inbox.createRule(approver, { name: "Wholesale to Sam", conditions: { keywords: ["wholesale"] }, actions: { assignee: editor.actor.id, priority: "high", tags: ["wholesale"] } });
    await m.inbox.createRule(approver, { name: "X rotation", conditions: { networks: ["x"] }, actions: { roundRobin: team, priority: "urgent", tags: ["x"] } });
    await m.inbox.createRule(approver, { name: "Japanese", conditions: { languages: ["ja"] }, actions: { tags: ["japan"] } });
    await m.inbox.createRule(approver, { name: "Crypto spam", conditions: { keywords: ["free crypto"] }, actions: { spam: true } });
    const [w1, x1, x2, x3, jp, spam] = await ingest(
      msg("wholesale pricing for 3 cafés on X?", { network: "x" }),
      msg("hi", { network: "x" }),
      msg("hello", { network: "x" }),
      msg("hey", { network: "x" }),
      msg("新しいレインジャケットはいつ発売ですか？"),
      msg("FREE CRYPTO giveaway click here"),
    );
    // Rule 1 wins assignee and priority; rule 2 still adds its label (and does not take a turn in the rotation).
    expect(await item(w1!)).toMatchObject({ assignee: editor.actor.id, priority: "high", tags: ["wholesale", "x"] });
    const rotated = [(await item(x1!))!.assignee, (await item(x2!))!.assignee, (await item(x3!))!.assignee];
    expect(rotated).toEqual([editor.actor.id, editor2.actor.id, editor.actor.id]);
    expect(await item(x1!)).toMatchObject({ priority: "urgent", tags: ["x"] });
    // Urgent target: 15 minutes.
    const x1Row = await item(x1!);
    const x1Act = (await m.listening.feed(ws, { ids: [x1!] }))[0]!;
    expect(x1Row!.slaDueAt!.getTime() - x1Act.occurredAt.getTime()).toBe(15 * 60_000);
    expect(await item(jp!)).toMatchObject({ tags: ["japan"], assignee: null });
    expect(await item(spam!)).toMatchObject({ status: "spam" });
    const applied = await ledger(["inbox.rule_applied"]);
    expect(applied.filter((e) => e.subjectId === w1).map((e) => e.data.rule).sort()).toEqual(["Wholesale to Sam", "X rotation"]);
  });

  it("are managed by owners and approvers only, never agents, and only assign people who can work the inbox", async () => {
    await expect(m.inbox.createRule(editor, { name: "r", actions: { tags: ["x"] } })).rejects.toThrow(/owner or approver/);
    await expect(m.inbox.createRule(agent, { name: "r", actions: { tags: ["x"] } })).rejects.toThrow(/not agents/);
    await expect(m.inbox.createRule(owner, { name: "r", actions: { assignee: viewer.actor.id } })).rejects.toThrow(/viewer/);
    await expect(m.inbox.createRule(owner, { name: "r", actions: { tags: ["nope"] } })).rejects.toThrow(/not one of this workspace's labels/);
    await expect(m.inbox.createRule(owner, { name: "r", actions: {} })).rejects.toThrow(/something to do/);
    const rules = await m.inbox.listRules(viewer);
    const reordered = await m.inbox.reorderRules(owner, [rules[3]!.id, rules[0]!.id]);
    expect(reordered.map((r) => r.name)).toEqual(["Crypto spam", "Wholesale to Sam", "X rotation", "Japanese"]);
  });
});

describe("first-response targets", () => {
  const bh = { enabled: true, days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
  it("count only business hours in the workspace's timezone, across a weekend and a DST change", () => {
    // Friday 16:30 in New York (EST), one hour target: 30 minutes Friday, 30 Monday morning, after clocks spring forward.
    expect(slaDueAt(new Date("2026-03-06T21:30:00Z"), 60, bh, "America/New_York").toISOString()).toBe("2026-03-09T13:30:00.000Z");
    // Before opening on a Tuesday: the clock starts at 09:00.
    expect(slaDueAt(new Date("2026-11-03T12:00:00Z"), 15, bh, "America/New_York").toISOString()).toBe("2026-11-03T14:15:00.000Z");
    // Tokyo, Saturday: Monday 09:00 JST + 8h → 17:00 JST.
    expect(slaDueAt(new Date("2026-11-07T03:00:00Z"), 480, bh, "Asia/Tokyo").toISOString()).toBe("2026-11-09T08:00:00.000Z");
    // Off: plain minutes.
    expect(slaDueAt(new Date("2026-11-07T03:00:00Z"), 15, DEFAULT_INBOX_SETTINGS.businessHours, "Asia/Tokyo").toISOString()).toBe("2026-11-07T03:15:00.000Z");
  });

  it("say ok, soon, overdue, met or missed", () => {
    const due = new Date("2026-11-04T16:00:00Z");
    const base = { status: "open" as const, priority: "high" as const, slaDueAt: due, firstResponseAt: null };
    const s = DEFAULT_INBOX_SETTINGS;
    expect(slaView(base, s, new Date("2026-11-04T15:00:00Z"))).toMatchObject({ state: "ok", msLeft: 3_600_000, targetMinutes: 60 });
    expect(slaView(base, s, new Date("2026-11-04T15:50:00Z")).state).toBe("soon");
    expect(slaView(base, s, new Date("2026-11-04T16:05:00Z"))).toMatchObject({ state: "overdue", msLeft: -300_000 });
    expect(slaView({ ...base, firstResponseAt: new Date("2026-11-04T15:59:00Z") }, s, new Date("2026-11-04T17:00:00Z")).state).toBe("met");
    expect(slaView({ ...base, firstResponseAt: new Date("2026-11-04T16:30:00Z") }, s, new Date("2026-11-04T17:00:00Z")).state).toBe("missed");
    expect(slaView({ ...base, status: "spam" }, s, new Date("2026-11-04T17:00:00Z")).state).toBe("none");
  });

  it("follow new targets, and a reply on its way marks the first response and moves the conversation to pending", async () => {
    const [id] = await ingest(msg("Is the Guji still on batch brew?"));
    await m.inbox.updateSettings(owner, { sla: { normal: 120 } });
    const a = (await m.listening.feed(ws, { ids: [id!] }))[0]!;
    expect((await item(id!))!.slaDueAt!.getTime()).toBe(a.occurredAt.getTime() + 120 * 60_000);
    const sent = await m.engagement.reply(owner, id!, "It is, until it runs out.");
    await m.inbox.noteReply(ws, sent.post.id);
    expect(await item(id!)).toMatchObject({ status: "pending", firstResponseAt: expect.any(Date) });
    const entry = await m.inbox.entry(viewer, id!);
    expect(entry.sla.state).toBe("met");
    const convo = await m.inbox.conversation(viewer, id!);
    expect(convo.replies.map((r) => r.text)).toEqual(["It is, until it runs out."]);
    expect((await ledger(["inbox.responded"])).filter((e) => e.subjectId === id)).toHaveLength(1);
  });
});

describe("working items", () => {
  it("lists with tab counts, filters, and bulk-closes", async () => {
    const ids = await ingest(msg("bulk one"), msg("bulk two"), msg("bulk three"));
    await m.inbox.patch(editor, ids[0]!, { assignee: "me", tags: ["billing"] });
    const mine = await m.inbox.list(editor, { status: ["open", "pending"], assignee: "me" });
    expect(mine.items.map((i) => i.activity.id)).toContain(ids[0]);
    expect(mine.counts.mine).toBeGreaterThanOrEqual(1);
    expect(mine.viewer).toMatchObject({ userId: editor.actor.id, canWork: true, canManage: false });
    expect((await m.inbox.list(viewer, { tag: "billing" })).items.map((i) => i.activity.id)).toEqual([ids[0]]);
    expect((await m.inbox.list(viewer, { q: "bulk t" })).items.map((i) => i.activity.text).sort()).toEqual(["bulk three", "bulk two"]);
    const before = (await m.inbox.list(viewer, {})).counts;
    const r = await m.inbox.bulkPatch(editor, ids, { status: "done" });
    expect(r.updated).toBe(3);
    expect(r.items.every((i) => i.state.status === "done" && i.state.doneAt)).toBe(true);
    const after = (await m.inbox.list(viewer, {})).counts;
    expect(after.done).toBe(before.done + 3);
    expect(after.open).toBe(before.open - 3);
    expect((await ledger(["inbox.item_updated"])).filter((e) => e.data.bulk)).toHaveLength(3);
  });

  it("snoozes out of the queue until the time comes", async () => {
    const [id] = await ingest(msg("snooze me"));
    await m.inbox.patch(editor, id!, { snoozedUntil: new Date(T0 + 5 * 3_600_000).toISOString() });
    expect((await m.inbox.list(viewer, { status: ["open"] })).items.map((i) => i.activity.id)).not.toContain(id);
    const snoozed = await m.inbox.list(viewer, { snoozed: true });
    expect(snoozed.items.map((i) => i.activity.id)).toContain(id);
    expect(snoozed.counts.snoozed).toBeGreaterThanOrEqual(1);
    await expect(m.inbox.patch(editor, id!, { snoozedUntil: new Date(T0).toISOString() })).rejects.toThrow(/future/);
  });

  it("follows roles: viewers read, editors work, agents set status, labels and notes but never assign", async () => {
    const [id] = await ingest(msg("roles"));
    await expect(m.inbox.patch(viewer, id!, { status: "done" })).rejects.toThrow(/viewers/);
    await expect(m.inbox.patch(agent, id!, { assignee: editor.actor.id })).rejects.toThrow(/agents/);
    await expect(m.inbox.patch(agent, id!, { priority: "urgent" })).rejects.toThrow(/agents/);
    await expect(m.inbox.bulkPatch(agent, [id!], { assignee: null })).rejects.toThrow(/agents/);
    expect((await m.inbox.patch(agent, id!, { status: "pending", addTags: ["billing"] })).state).toMatchObject({ status: "pending", tags: ["billing"] });
    await expect(m.inbox.patch(editor, id!, { assignee: viewer.actor.id })).rejects.toThrow(/viewer/);
    await expect(m.inbox.patch(editor, id!, { tags: ["made-up"] })).rejects.toThrow(/labels/);
    await expect(m.inbox.updateSettings(editor, { sla: { urgent: 5 } })).rejects.toThrow(/owner or approver/);
    await expect(m.inbox.updateSettings(agent, { sla: { urgent: 5 } })).rejects.toThrow(/not agents/);
    const ev = (await ledger(["inbox.item_updated"])).find((e) => e.subjectId === id && e.actor.type === "mcp");
    expect(ev?.data).toMatchObject({ status: { from: "open", to: "pending" }, tags: { added: ["billing"], removed: [] } });
    // Taking a label off the list takes it off conversations.
    await m.inbox.updateSettings(owner, { tags: [{ name: "wholesale" }, { name: "japan" }, { name: "x" }] });
    expect((await item(id!))!.tags).toEqual([]);
  });
});

describe("notes", () => {
  it("parse @mentions of teammates by first name, email name or full name", () => {
    const people = [
      { userId: "u1", email: "sam@northwind.coffee", name: "Sam Okafor" },
      { userId: "u2", email: "ana.ruiz@northwind.coffee", name: "Ana Ruiz" },
    ];
    expect(parseMentions("@sam can you take this? cc @ana.ruiz", people).sort()).toEqual(["u1", "u2"]);
    expect(parseMentions("@AnaRuiz, @SAM.", people).sort()).toEqual(["u1", "u2"]);
    expect(parseMentions("mail sam@northwind.coffee or @nobody", people)).toEqual([]);
  });

  it("notify the people mentioned live and in the ledger; only the author edits", async () => {
    const [id] = await ingest(msg("Can I return a grinder?"));
    const heard: { kind: string; userIds?: string[] }[] = [];
    m.emitter.on("inbox", (e) => heard.push(e));
    const note = await m.inbox.addNote(editor, id!, { text: "@ana can you check the returns policy? @maya fyi" });
    expect(note.mentions.sort()).toEqual([editor2.actor.id, owner.actor.id].sort());
    expect(heard.find((e) => e.kind === "mention")?.userIds?.sort()).toEqual([editor2.actor.id, owner.actor.id].sort());
    expect((await ledger(["inbox.mentioned"])).map((e) => e.subjectId).sort()).toEqual([editor2.actor.id, owner.actor.id].sort());
    await expect(m.inbox.addNote(viewer, id!, { text: "hi" })).rejects.toThrow(/viewers/);
    expect((await m.inbox.addNote(agent, id!, { text: "Customer bought it 40 days ago." })).author).toEqual({ type: "mcp", id: "claude" });
    await expect(m.inbox.updateNote(editor2, note.id, { text: "x" })).rejects.toThrow(/wrote/);
    expect((await m.inbox.updateNote(editor, note.id, { text: "@ana @dev please check" })).mentions).toContain(approver.actor.id);
    expect((await m.inbox.listNotes(viewer, id!)).length).toBe(2);
    expect((await m.inbox.entry(viewer, id!)).notes).toBe(2);
    await m.inbox.deleteNote(owner, note.id);
    expect((await m.inbox.listNotes(viewer, id!)).length).toBe(1);
  });
});

describe("saved replies", () => {
  it("fill variables in one pass, escape \\{{ }}, keep unknown ones, and never let a value inject markup or another variable", () => {
    const vars = replyVariables({ authorName: "Lucía {{brand}}\n<b>x</b>", authorHandle: "lucia_f" }, "Northwind");
    expect(fillSavedReply("Hi {{author_name}} ({{ author_handle }}), thanks from {{brand}}. \\{{brand}} {{order_id}}", vars)).toBe(
      "Hi Lucía {{brand}} <b>x</b> (@lucia_f), thanks from Northwind. {{brand}} {{order_id}}",
    );
    expect(fillSavedReply("Hi {{author_name}}", replyVariables({ authorName: null, authorHandle: "@kav" }, "N"))).toBe("Hi kav");
    expect(fillSavedReply("Hi {{author_name}}!", { author_name: null })).toBe("Hi !");
  });

  it("are shared per workspace, edited by editors and up, and filled for a conversation", async () => {
    const [id] = await ingest(msg("¿Envían a México?", { authorName: "Lucía", authorHandle: "lucia.bsky.social" }));
    await expect(m.inbox.createSavedReply(viewer, { name: "x", text: "y" })).rejects.toThrow();
    await expect(m.inbox.createSavedReply(agent, { name: "x", text: "y" })).rejects.toThrow(/not agents/);
    const r = await m.inbox.createSavedReply(editor, { name: "Shipping (es)", text: "Hola {{author_name}}, sí enviamos a México. — {{brand}}", lang: "es" });
    expect((await m.inbox.listSavedReplies(viewer)).map((x) => x.name)).toContain("Shipping (es)");
    expect(await m.inbox.fillSavedReply(viewer, r.id, id!)).toEqual({ text: "Hola Lucía, sí enviamos a México. — Northwind", lang: "es" });
    await m.inbox.updateSavedReply(editor, r.id, { name: "Shipping MX" });
    await m.inbox.deleteSavedReply(approver, r.id);
    expect((await ledger(["inbox.saved_reply_created", "inbox.saved_reply_updated", "inbox.saved_reply_deleted"])).length).toBe(3);
  });
});
