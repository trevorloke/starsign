import type { Hono } from "hono";
import { z } from "zod";
import { INBOX_PRIORITIES, INBOX_STATUSES, type InboxQuery, type Starsign } from "@starsign/core";
import type { Env } from "./app.ts";

const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const Sort = z.enum(["newest", "oldest", "due", "priority"]);

/**
 * The team inbox: the live feed worked as a shared queue. Static paths are registered before `/:activityId`.
 * Roles are checked in core (InboxService): viewers read; editors and up work items; owners and approvers manage
 * rules, labels and response targets; agents set status, labels and notes, never assignment or rules.
 */
export function registerInboxRoutes(app: Hono<Env>, m: Starsign, _opts: object = {}) {
  // ---------------------------------------------------------------- settings: labels, response targets, business hours
  app.get("/v1/inbox/settings", async (c) => c.json(await m.inbox.settings(c.get("principal").workspaceId)));
  app.patch("/v1/inbox/settings", async (c) => c.json(await m.inbox.updateSettings(c.get("principal"), await c.req.json())));

  // ---------------------------------------------------------------- rules
  app.get("/v1/inbox/rules", async (c) => c.json(await m.inbox.listRules(c.get("principal"))));
  app.post("/v1/inbox/rules", async (c) => c.json(await m.inbox.createRule(c.get("principal"), await c.req.json()), 201));
  app.post("/v1/inbox/rules/reorder", async (c) => {
    const body = z.object({ ids: z.array(z.string().min(1)).max(200) }).parse(await c.req.json());
    return c.json(await m.inbox.reorderRules(c.get("principal"), body.ids));
  });
  app.patch("/v1/inbox/rules/:id", async (c) => c.json(await m.inbox.updateRule(c.get("principal"), c.req.param("id"), await c.req.json())));
  app.delete("/v1/inbox/rules/:id", async (c) => {
    await m.inbox.deleteRule(c.get("principal"), c.req.param("id"));
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- notes (by note id)
  app.patch("/v1/inbox/notes/:noteId", async (c) => c.json(await m.inbox.updateNote(c.get("principal"), c.req.param("noteId"), await c.req.json())));
  app.delete("/v1/inbox/notes/:noteId", async (c) => {
    await m.inbox.deleteNote(c.get("principal"), c.req.param("noteId"));
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- saved replies
  app.get("/v1/saved-replies", async (c) => c.json(await m.inbox.listSavedReplies(c.get("principal"))));
  app.post("/v1/saved-replies", async (c) => c.json(await m.inbox.createSavedReply(c.get("principal"), await c.req.json()), 201));
  app.patch("/v1/saved-replies/:id", async (c) => c.json(await m.inbox.updateSavedReply(c.get("principal"), c.req.param("id"), await c.req.json())));
  app.delete("/v1/saved-replies/:id", async (c) => {
    await m.inbox.deleteSavedReply(c.get("principal"), c.req.param("id"));
    return c.body(null, 204);
  });
  /** The text with this conversation's {{author_name}}, {{author_handle}} and {{brand}} filled in. Nothing is sent. */
  app.post("/v1/saved-replies/:id/fill", async (c) => {
    const body = z.object({ activityId: z.string().min(1) }).parse(await c.req.json());
    return c.json(await m.inbox.fillSavedReply(c.get("principal"), c.req.param("id"), body.activityId));
  });

  // ---------------------------------------------------------------- the queue
  app.get("/v1/inbox", async (c) => {
    const q = c.req.query();
    const query: InboxQuery = {
      status: z.array(z.enum(INBOX_STATUSES)).parse(list(q.status)),
      assignee: q.assignee || undefined,
      tag: q.tag || undefined,
      priority: z.array(z.enum(INBOX_PRIORITIES)).parse(list(q.priority)),
      networks: list(q.network ?? q.networks),
      q: q.q || undefined,
      sort: q.sort ? Sort.parse(q.sort) : undefined,
      snoozed: q.snoozed === "1" || q.snoozed === "true",
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    };
    return c.json(await m.inbox.list(c.get("principal"), query));
  });
  /** Bulk: the same change to up to 200 conversations. */
  app.patch("/v1/inbox", async (c) => {
    const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(200), patch: z.record(z.string(), z.unknown()) }).parse(await c.req.json());
    return c.json(await m.inbox.bulkPatch(c.get("principal"), body.ids, body.patch));
  });
  app.get("/v1/inbox/:activityId", async (c) => c.json(await m.inbox.conversation(c.get("principal"), c.req.param("activityId"))));
  app.patch("/v1/inbox/:activityId", async (c) => c.json(await m.inbox.patch(c.get("principal"), c.req.param("activityId"), await c.req.json())));
  app.get("/v1/inbox/:activityId/notes", async (c) => c.json(await m.inbox.listNotes(c.get("principal"), c.req.param("activityId"))));
  app.post("/v1/inbox/:activityId/notes", async (c) => c.json(await m.inbox.addNote(c.get("principal"), c.req.param("activityId"), await c.req.json()), 201));
}
