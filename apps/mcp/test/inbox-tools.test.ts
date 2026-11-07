import { describe, expect, it } from "vitest";
import { StarsignClient } from "../src/client.ts";
import { inboxHandlers, type ToolContext } from "../src/tools.ts";
import { NOW, fakeApi, textOf } from "./helpers.ts";

const ctx = (api: ReturnType<typeof fakeApi>): ToolContext => ({ client: new StarsignClient({ baseUrl: "http://api.test", apiKey: "star_t", fetch: api.fetch }), now: () => NOW });

const entry = {
  activity: { id: "act_1", network: "whatsapp", kind: "dm", authorName: "Lucía", authorHandle: "5215512345678", text: "¿Hacen envíos a CDMX?", translation: "Do you ship to Mexico City?", lang: "es" },
  latest: null,
  state: { status: "open", assignee: null, priority: "urgent", tags: ["wholesale"], messageCount: 2 },
  sla: { state: "overdue", msLeft: -12 * 60_000 },
  notes: 1,
};

describe("inbox tools", () => {
  it("list_inbox asks for open and pending by due time and summarises counts, translations and targets", async () => {
    const api = fakeApi([{ path: "/v1/inbox", body: { items: [entry], counts: { open: 4, pending: 1, done: 9, spam: 2, mine: 0, unassigned: 3, snoozed: 1 } } }]);
    const res = await inboxHandlers.list_inbox(ctx(api), { sort: "due", limit: 30 });
    const q = api.last().url.searchParams;
    expect(q.get("status")).toBe("open,pending");
    expect(q.get("sort")).toBe("due");
    const text = textOf(res);
    expect(text).toContain("Inbox: 4 open (3 unassigned), 1 pending, 9 done, 2 spam, 1 snoozed.");
    expect(text).toContain('[open, urgent] · Lucía on whatsapp (dm) · translated from es · "Do you ship to Mexico City?" · 2 messages · unassigned · labels wholesale · overdue by 12m · 1 note(s) · act_1');
  });

  it("update_inbox_item patches status and labels, then adds the note", async () => {
    const api = fakeApi([
      { method: "PATCH", path: "/v1/inbox/act_1", respond: (r) => ({ ...entry, state: { ...entry.state, status: (r.body as { status: string }).status } }) },
      { method: "POST", path: "/v1/inbox/act_1/notes", body: { id: "note_1", mentions: ["usr_sam"] } },
    ]);
    const res = await inboxHandlers.update_inbox_item(ctx(api), { activityId: "act_1", status: "pending", addTags: ["wholesale"], note: "@sam quote sent" });
    expect(api.calls.map((c) => [c.method, c.url.pathname, c.body])).toEqual([
      ["PATCH", "/v1/inbox/act_1", { status: "pending", addTags: ["wholesale"] }],
      ["POST", "/v1/inbox/act_1/notes", { text: "@sam quote sent" }],
    ]);
    expect(textOf(res)).toMatch(/^Now \[pending, urgent\]/);
    expect(textOf(res)).toContain("Note added, notifying 1 teammate(s).");
  });

  it("passes the API's refusal through and does nothing without a change", async () => {
    const api = fakeApi([{ method: "PATCH", path: "/v1/inbox/act_1", status: 403, body: { error: { code: "forbidden", message: "agents may change status, labels and notes" } } }]);
    const res = await inboxHandlers.update_inbox_item(ctx(api), { activityId: "act_1", status: "done" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("agents may change status");
    expect(textOf(await inboxHandlers.update_inbox_item(ctx(fakeApi([])), { activityId: "act_1" }))).toContain("Nothing to change");
  });
});
