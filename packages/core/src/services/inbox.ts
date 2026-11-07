import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { activities, entityMentions, inboxItems, inboxNotes, inboxRules, members, posts, postVariants, savedReplies, socialAccounts, users, workspaces } from "@starsign/db";
import { newId } from "@starsign/ledger";
import { findPhrases } from "@starsign/policy";
import { SYSTEM, type CoreContext, type Principal } from "../context.ts";
import { CoreError } from "../errors.ts";
import { primaryLanguage } from "../lang.ts";
import type { PolicyService } from "./policy.ts";

// ---------------------------------------------------------------- shapes

export const INBOX_STATUSES = ["open", "pending", "done", "spam"] as const;
export const INBOX_PRIORITIES = ["normal", "high", "urgent"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];
export type InboxPriority = (typeof INBOX_PRIORITIES)[number];

/**
 * Kinds that are not a message anyone could answer: never inbox items. Own posts are the workspace's own words.
 * Items without a connected account (public search for tracked names) are not inbox items either.
 */
export const NOT_INBOX_KINDS = new Set(["own_post", "like", "follow", "repost"]);

export type ActivityRow = typeof activities.$inferSelect;
type ItemRow = typeof inboxItems.$inferSelect;
export type InboxNoteRow = typeof inboxNotes.$inferSelect;
export type SavedReplyRow = typeof savedReplies.$inferSelect;
export type InboxRuleRow = Omit<typeof inboxRules.$inferSelect, "conditions" | "actions"> & { conditions: RuleConditions; actions: RuleActions };

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");
const Minutes = z.number().int().min(1).max(60 * 24 * 14);
const TagName = z.string().trim().min(1).max(40);

export const BusinessHours = z
  .object({
    enabled: z.boolean(),
    /** 0 = Sunday … 6 = Saturday, in the workspace's timezone. */
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start: HHMM,
    end: HHMM,
  })
  .refine((b) => b.end > b.start, { message: "business hours must end after they start, on the same day" });
export type BusinessHours = z.infer<typeof BusinessHours>;

export const InboxSettings = z.object({
  /** First-response targets in minutes, per priority. */
  sla: z.object({ urgent: Minutes, high: Minutes, normal: Minutes }),
  businessHours: BusinessHours,
  /** The workspace's labels. Items can only carry these. */
  tags: z.array(z.object({ name: TagName, color: z.enum(["gray", "blue", "green", "amber", "red", "violet"]).default("gray") })).max(100),
});
export type InboxSettings = z.infer<typeof InboxSettings>;

export const DEFAULT_INBOX_SETTINGS: InboxSettings = {
  sla: { urgent: 15, high: 60, normal: 480 },
  businessHours: { enabled: false, days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
  tags: [],
};

export const InboxSettingsPatch = z.object({
  sla: z.object({ urgent: Minutes, high: Minutes, normal: Minutes }).partial().optional(),
  businessHours: z.object({ enabled: z.boolean(), days: z.array(z.number().int().min(0).max(6)).min(1).max(7), start: HHMM, end: HHMM }).partial().optional(),
  tags: InboxSettings.shape.tags.optional(),
});

export const InboxPatch = z.object({
  status: z.enum(INBOX_STATUSES).optional(),
  /** A member's user id, "me", or null to unassign. */
  assignee: z.string().min(1).max(200).nullable().optional(),
  priority: z.enum(INBOX_PRIORITIES).optional(),
  /** Replaces the labels. */
  tags: z.array(TagName).max(20).optional(),
  addTags: z.array(TagName).max(20).optional(),
  removeTags: z.array(TagName).max(20).optional(),
  /** Hidden from the queue until then; null wakes it now. */
  snoozedUntil: z.string().datetime({ offset: true }).nullable().optional(),
});
export type InboxPatch = z.infer<typeof InboxPatch>;

export const RuleConditions = z.object({
  streams: z.array(z.string().min(1)).max(50).default([]),
  entities: z.array(z.string().min(1)).max(50).default([]),
  networks: z.array(z.string().min(1)).max(50).default([]),
  kinds: z.array(z.string().min(1)).max(20).default([]),
  languages: z.array(z.string().regex(/^[a-z]{2,3}$/)).max(50).default([]),
  keywords: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
});
export type RuleConditions = z.infer<typeof RuleConditions>;

export const RuleActions = z
  .object({
    assignee: z.string().min(1).nullable().optional(),
    /** Assign in turn among these members. */
    roundRobin: z.array(z.string().min(1)).max(50).optional(),
    tags: z.array(TagName).max(20).optional(),
    priority: z.enum(INBOX_PRIORITIES).optional(),
    spam: z.boolean().optional(),
  })
  .refine((a) => !(a.assignee && a.roundRobin?.length), { message: "a rule assigns one person or rotates among several, not both" });
export type RuleActions = z.infer<typeof RuleActions>;

export const RuleInput = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  conditions: RuleConditions.default({ streams: [], entities: [], networks: [], kinds: [], languages: [], keywords: [] }),
  actions: RuleActions,
});

export const SavedReplyInput = z.object({
  name: z.string().trim().min(1).max(120),
  text: z.string().trim().min(1).max(5000),
  lang: z.string().regex(/^[a-z]{2,3}$/).nullable().optional(),
});

export interface SlaView {
  dueAt: Date | null;
  /** none: no target applies; met / missed: answered; ok / soon / overdue: waiting on the team. */
  state: "none" | "met" | "missed" | "ok" | "soon" | "overdue";
  /** Milliseconds until due (negative when overdue). Null unless waiting. */
  msLeft: number | null;
  targetMinutes: number;
}

export interface InboxState {
  status: InboxStatus;
  assignee: string | null;
  priority: InboxPriority;
  tags: string[];
  firstResponseAt: Date | null;
  doneAt: Date | null;
  snoozedUntil: Date | null;
  slaDueAt: Date | null;
  lastActivityAt: Date;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface InboxEntry {
  /** The conversation's first message: its id is the item's id. */
  activity: ActivityRow;
  /** The newest message when the conversation has more than one. */
  latest: ActivityRow | null;
  state: InboxState;
  sla: SlaView;
  notes: number;
}

export interface InboxCounts {
  open: number;
  pending: number;
  done: number;
  spam: number;
  mine: number;
  unassigned: number;
  snoozed: number;
}

export interface InboxQuery {
  status?: InboxStatus[];
  /** "me", "none", "any" or a user id. */
  assignee?: string;
  tag?: string;
  priority?: InboxPriority[];
  networks?: string[];
  q?: string;
  sort?: "newest" | "oldest" | "due" | "priority";
  /** true: only snoozed items; default: snoozed items are hidden. */
  snoozed?: boolean;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------- pure helpers (exported for tests and the web app's twin)

/** Milliseconds a wall clock in `timezone` is ahead of UTC at `at`. */
function tzOffset(at: number, timezone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
      .formatToParts(new Date(at))
      .map((x) => [x.type, x.value]),
  );
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return wall - Math.floor(at / 1000) * 1000;
}

/** The UTC instant of a wall-clock time in `timezone` (days may overflow: d + 1 is the next day). */
export function zonedInstant(y: number, m: number, d: number, h: number, min: number, timezone: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = guess - tzOffset(guess, timezone);
  const second = guess - tzOffset(first, timezone);
  return second;
}

function localDate(at: number, timezone: string): { y: number; m: number; d: number; dow: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" })
      .formatToParts(new Date(at))
      .map((x) => [x.type, x.value]),
  );
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(p.weekday)) };
}

/**
 * When a first response is due: `minutes` after `start`, counting only business hours when they are on
 * (in the workspace's timezone, across days off and DST changes).
 */
export function slaDueAt(start: Date, minutes: number, hours: BusinessHours, timezone: string): Date {
  if (!hours.enabled) return new Date(start.getTime() + minutes * 60_000);
  const [sh, sm] = hours.start.split(":").map(Number) as [number, number];
  const [eh, em] = hours.end.split(":").map(Number) as [number, number];
  let remaining = minutes * 60_000;
  let cursor = start.getTime();
  for (let i = 0; i < 800; i++) {
    const { y, m, d, dow } = localDate(cursor, timezone);
    if (hours.days.includes(dow)) {
      const open = zonedInstant(y, m, d, sh, sm, timezone);
      const close = zonedInstant(y, m, d, eh, em, timezone);
      if (cursor < close) {
        const from = Math.max(cursor, open);
        const available = close - from;
        if (available >= remaining) return new Date(from + remaining);
        remaining -= available;
      }
    }
    cursor = zonedInstant(y, m, d + 1, 0, 0, timezone);
  }
  return new Date(cursor);
}

/** Where a conversation stands against its first-response target. */
export function slaView(state: Pick<InboxState, "status" | "priority" | "slaDueAt" | "firstResponseAt">, settings: InboxSettings, now: Date): SlaView {
  const targetMinutes = settings.sla[state.priority];
  const due = state.slaDueAt;
  if (!due || state.status === "spam") return { dueAt: due, state: "none", msLeft: null, targetMinutes };
  if (state.firstResponseAt) return { dueAt: due, state: state.firstResponseAt.getTime() <= due.getTime() ? "met" : "missed", msLeft: null, targetMinutes };
  if (state.status === "done") return { dueAt: due, state: "none", msLeft: null, targetMinutes };
  const msLeft = due.getTime() - now.getTime();
  const soonMs = Math.min(targetMinutes * 60_000 * 0.25, 60 * 60_000);
  return { dueAt: due, state: msLeft < 0 ? "overdue" : msLeft <= soonMs ? "soon" : "ok", msLeft, targetMinutes };
}

const VARIABLE = /(\\?)\{\{\s*([a-zA-Z_]+)\s*\}\}/g;
export const SAVED_REPLY_VARIABLES = ["author_name", "author_handle", "brand"] as const;

/** One substituted value: plain text on one line, nothing that could be read as markup or another variable later. */
function cleanValue(v: string): string {
  return v
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * Fill a saved reply. One pass: a value that itself contains `{{brand}}` stays literal. `\{{x}}` writes `{{x}}`.
 * Unknown variables are left in place for the person to see and edit; known ones without a value become "".
 */
export function fillSavedReply(template: string, vars: Partial<Record<(typeof SAVED_REPLY_VARIABLES)[number], string | null>>): string {
  return template.replace(VARIABLE, (whole, escape: string, name: string) => {
    if (escape) return whole.slice(1);
    const key = name.toLowerCase() as (typeof SAVED_REPLY_VARIABLES)[number];
    if (!(SAVED_REPLY_VARIABLES as readonly string[]).includes(key)) return whole;
    const v = vars[key];
    return v ? cleanValue(v) : "";
  });
}

/** The variables for one conversation's author. */
export function replyVariables(a: Pick<ActivityRow, "authorName" | "authorHandle">, brand: string): Record<(typeof SAVED_REPLY_VARIABLES)[number], string | null> {
  const handle = a.authorHandle ? (a.authorHandle.startsWith("@") ? a.authorHandle : `@${a.authorHandle}`) : null;
  const firstName = a.authorName?.trim() ? a.authorName.trim() : (a.authorHandle?.replace(/^@/, "") ?? null);
  return { author_name: firstName, author_handle: handle, brand };
}

export interface MentionCandidate {
  userId: string;
  email: string;
  name: string | null;
}

/** @mentions in a note: `@sam`, `@sam.okafor`, `@SamOkafor` match a member by first name, email name or full name. */
export function parseMentions(text: string, people: MentionCandidate[]): string[] {
  const keys = new Map<string, string>();
  for (const p of people) {
    const local = p.email.split("@")[0]!.toLowerCase();
    keys.set(local, p.userId);
    if (p.name) {
      const name = p.name.trim().toLowerCase();
      keys.set(name.replace(/\s+/g, ""), p.userId);
      keys.set(name.replace(/\s+/g, "."), p.userId);
      const first = name.split(/\s+/)[0];
      if (first && !keys.has(first)) keys.set(first, p.userId);
    }
  }
  const out = new Set<string>();
  for (const m of text.matchAll(/(^|[^\p{L}\p{N}_.@])@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu)) {
    const token = m[2]!.toLowerCase().replace(/[._-]+$/, "");
    const id = keys.get(token);
    if (id) out.add(id);
  }
  return [...out];
}

/** Whether a rule's conditions hold for a message. Empty groups match anything; within a group any value matches. */
export function ruleMatches(c: RuleConditions, a: Pick<ActivityRow, "network" | "kind" | "lang" | "text" | "translation" | "matchedStreams">, entityIds: readonly string[]): boolean {
  if (c.networks.length && !c.networks.includes(a.network)) return false;
  if (c.kinds.length && !c.kinds.includes(a.kind)) return false;
  if (c.languages.length && (!a.lang || !c.languages.includes(primaryLanguage(a.lang)))) return false;
  if (c.streams.length && !c.streams.some((s) => a.matchedStreams.includes(s))) return false;
  if (c.entities.length && !c.entities.some((e) => entityIds.includes(e))) return false;
  if (c.keywords.length) {
    const hit = (a.text && findPhrases(a.text, c.keywords).length > 0) || (a.translation && findPhrases(a.translation, c.keywords).length > 0);
    if (!hit) return false;
  }
  return true;
}

const RESPONDED_POST_STATUSES = new Set(["scheduled", "approved", "publishing", "published", "partially_published"]);
const WORKER_ROLES = ["owner", "approver", "editor"] as const;
const MANAGER_ROLES = ["owner", "approver"] as const;

// ---------------------------------------------------------------- the service

/**
 * The team inbox: the live feed worked as a shared queue. Conversations get a status, an owner, a priority, labels
 * and a first-response target; notes and saved replies help the team answer; rules route new conversations.
 * Replies themselves still go through EngagementService and the gate (red lines and the reply autonomy dial).
 */
export class InboxService {
  /** Reply posts already counted (or being counted), so each one is counted once whatever events it emits. */
  private readonly replyWork = new Map<string, Promise<string[]>>();

  constructor(
    private readonly ctx: CoreContext,
    private readonly policy: PolicyService,
  ) {
    // A reply that is on its way counts as a response for its conversation, from people and agents alike.
    this.ctx.emitter.on("post", (e: { workspaceId?: string; postId?: string; status?: string }) => {
      if (!e.workspaceId || !e.postId || !e.status || !RESPONDED_POST_STATUSES.has(e.status)) return;
      this.noteReply(e.workspaceId, e.postId).catch((err) => console.error("[inbox] reply bookkeeping failed:", (err as Error).message));
    });
  }

  // ------------------------------------------------------------ roles

  private requireMember(p: Principal) {
    if (p.actor.type === "human" && !p.role) throw new CoreError("forbidden", "not a member of this workspace");
  }

  /** People: editors and up. Agents: status, labels and notes only; never assignment, priority or snooze. */
  private requireWorker(p: Principal, patch?: InboxPatch) {
    if (p.actor.type !== "human") {
      if (patch && (patch.assignee !== undefined || patch.priority !== undefined || patch.snoozedUntil !== undefined)) {
        throw new CoreError("forbidden", "agents may change status, labels and notes; assigning people, priority and snoozing are for people");
      }
      return;
    }
    if (!p.role || !(WORKER_ROLES as readonly string[]).includes(p.role)) throw new CoreError("forbidden", "viewers can read the inbox but not change it");
  }

  private requireManager(p: Principal, what: string) {
    if (p.actor.type !== "human") throw new CoreError("forbidden", `${what} are managed by people (an owner or approver), not agents`);
    if (!p.role || !(MANAGER_ROLES as readonly string[]).includes(p.role)) throw new CoreError("forbidden", `${what} need an owner or approver`);
  }

  private requireEditorHuman(p: Principal, what: string) {
    if (p.actor.type !== "human") throw new CoreError("forbidden", `${what} are managed by people, not agents`);
    if (!p.role || !(WORKER_ROLES as readonly string[]).includes(p.role)) throw new CoreError("forbidden", `${what} need an editor, approver or owner`);
  }

  private async people(workspaceId: string): Promise<(MentionCandidate & { role: string })[]> {
    return this.ctx.db
      .select({ userId: members.userId, email: users.email, name: users.name, role: members.role })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.workspaceId, workspaceId));
  }

  /** Someone who can work items: a member with an editor role or above (or the acting person themselves). */
  private async assignable(p: Principal, userId: string): Promise<string> {
    if (p.actor.type === "human" && userId === p.actor.id) return userId;
    const ok = (await this.people(p.workspaceId)).find((x) => x.userId === userId);
    if (!ok) throw new CoreError("invalid", `${userId} is not a member of this workspace`);
    if (ok.role === "viewer") throw new CoreError("invalid", `${ok.name ?? ok.email} is a viewer and cannot work the inbox`);
    return userId;
  }

  // ------------------------------------------------------------ settings

  async settings(workspaceId: string): Promise<InboxSettings & { timezone: string }> {
    const [ws] = await this.ctx.db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!ws) throw new CoreError("not_found", `workspace ${workspaceId}`);
    const raw = ((ws.settings ?? {}) as { inbox?: Partial<InboxSettings> }).inbox ?? {};
    const parsed = InboxSettings.safeParse({
      sla: { ...DEFAULT_INBOX_SETTINGS.sla, ...(raw.sla ?? {}) },
      businessHours: { ...DEFAULT_INBOX_SETTINGS.businessHours, ...(raw.businessHours ?? {}) },
      tags: raw.tags ?? [],
    });
    const value = parsed.success ? parsed.data : DEFAULT_INBOX_SETTINGS;
    const timezone = (await this.policy.getActive(workspaceId)).timezone;
    return { ...value, timezone };
  }

  async updateSettings(p: Principal, raw: unknown) {
    this.requireManager(p, "inbox labels, rules and response targets");
    const patch = InboxSettingsPatch.parse(raw);
    const { timezone, ...current } = await this.settings(p.workspaceId);
    const next = InboxSettings.parse({
      sla: { ...current.sla, ...(patch.sla ?? {}) },
      businessHours: { ...current.businessHours, ...(patch.businessHours ?? {}) },
      tags: patch.tags ?? current.tags,
    });
    const seen = new Set<string>();
    for (const t of next.tags) {
      const k = t.name.toLowerCase();
      if (seen.has(k)) throw new CoreError("invalid", `the label "${t.name}" is listed twice`);
      seen.add(k);
    }
    await this.ctx.db
      .update(workspaces)
      .set({ settings: sql`jsonb_set(coalesce(${workspaces.settings}, '{}'::jsonb), '{inbox}', ${JSON.stringify(next)}::jsonb, true)` })
      .where(eq(workspaces.id, p.workspaceId));
    // Labels taken off the list come off the conversations that carried them.
    const removed = current.tags.filter((t) => !seen.has(t.name.toLowerCase())).map((t) => t.name);
    for (const name of removed) {
      await this.ctx.db
        .update(inboxItems)
        .set({ tags: sql`(${inboxItems.tags} - ${name}::text)` })
        .where(and(eq(inboxItems.workspaceId, p.workspaceId), sql`${inboxItems.tags} @> ${JSON.stringify([name])}::jsonb`));
    }
    // New targets apply to conversations still waiting on a first response.
    if (patch.sla || patch.businessHours) await this.recomputeDue(p.workspaceId, { ...next, timezone });
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "inbox.settings_updated", subjectType: "workspace", subjectId: p.workspaceId, actor: p.actor, data: { sla: next.sla, businessHours: next.businessHours, tags: next.tags.map((t) => t.name), removedTags: removed } });
    this.emit(p.workspaceId, { kind: "settings" });
    return { ...next, timezone };
  }

  private async recomputeDue(workspaceId: string, s: InboxSettings & { timezone: string }) {
    const rows = await this.ctx.db
      .select({ id: inboxItems.activityId, priority: inboxItems.priority, start: activities.occurredAt })
      .from(inboxItems)
      .innerJoin(activities, eq(activities.id, inboxItems.activityId))
      .where(and(eq(inboxItems.workspaceId, workspaceId), eq(inboxItems.threadId, inboxItems.activityId), isNull(inboxItems.firstResponseAt), inArray(inboxItems.status, ["open", "pending"])))
      .limit(5000);
    for (const r of rows) {
      await this.ctx.db.update(inboxItems).set({ slaDueAt: slaDueAt(r.start, s.sla[r.priority], s.businessHours, s.timezone) }).where(eq(inboxItems.activityId, r.id));
    }
  }

  private async tagNames(workspaceId: string, wanted: string[]): Promise<string[]> {
    if (!wanted.length) return [];
    const defined = (await this.settings(workspaceId)).tags;
    const byKey = new Map(defined.map((t) => [t.name.toLowerCase(), t.name]));
    const out: string[] = [];
    for (const w of wanted) {
      const name = byKey.get(w.trim().toLowerCase());
      if (!name) throw new CoreError("invalid", `"${w}" is not one of this workspace's labels; an owner or approver adds labels in inbox settings`);
      if (!out.includes(name)) out.push(name);
    }
    return out;
  }

  // ------------------------------------------------------------ ingest

  /** The ListeningService.afterIngest hook: new messages become conversations, or join the one they belong to. */
  async onIngest(workspaceId: string, activityIds: string[]): Promise<number> {
    if (!activityIds.length) return 0;
    const rows = await this.ctx.db.select().from(activities).where(and(eq(activities.workspaceId, workspaceId), inArray(activities.id, activityIds))).orderBy(asc(activities.occurredAt));
    const own = await this.ctx.db.select({ network: socialAccounts.network, handle: socialAccounts.handle }).from(socialAccounts).where(eq(socialAccounts.workspaceId, workspaceId));
    const norm = (h: string) => h.replace(/^@/, "").toLowerCase();
    const ownHandles = new Set(own.map((o) => `${o.network}:${norm(o.handle)}`));
    let settings: (InboxSettings & { timezone: string }) | null = null;
    let rules: InboxRuleRow[] | null = null;
    let mentions: Map<string, string[]> | null = null;
    const created: string[] = [];
    for (const a of rows) {
      if (NOT_INBOX_KINDS.has(a.kind)) continue;
      // What the public scan found (no connected account) stays in the feed and the tracker: the inbox is what was said to the brand.
      if (!a.socialAccountId) continue;
      if (a.authorHandle && ownHandles.has(`${a.network}:${norm(a.authorHandle)}`)) continue;
      const root = await this.threadRootFor(workspaceId, a);
      if (root) {
        await this.ctx.db
          .insert(inboxItems)
          .values({ activityId: a.id, workspaceId, threadId: root.activityId, lastActivityAt: a.occurredAt, createdAt: this.ctx.now(), updatedAt: this.ctx.now() })
          .onConflictDoNothing();
        const reopen = root.status === "done" || root.status === "pending";
        await this.ctx.db
          .update(inboxItems)
          .set({
            messageCount: sql`${inboxItems.messageCount} + 1`,
            lastActivityAt: sql`greatest(${inboxItems.lastActivityAt}, ${a.occurredAt.toISOString()}::timestamptz)`,
            updatedAt: this.ctx.now(),
            ...(reopen ? { status: "open" as const, doneAt: null, snoozedUntil: null } : {}),
          })
          .where(eq(inboxItems.activityId, root.activityId));
        if (reopen) {
          await this.ctx.events.append({ workspaceId, type: "inbox.reopened", subjectType: "inbox_item", subjectId: root.activityId, actor: SYSTEM, data: { from: root.status, by: a.id } });
        }
        created.push(root.activityId);
        continue;
      }
      settings ??= await this.settings(workspaceId);
      const inserted = await this.ctx.db
        .insert(inboxItems)
        .values({
          activityId: a.id,
          workspaceId,
          threadId: a.id,
          lastActivityAt: a.occurredAt,
          slaDueAt: slaDueAt(a.occurredAt, settings.sla.normal, settings.businessHours, settings.timezone),
          createdAt: this.ctx.now(),
          updatedAt: this.ctx.now(),
        })
        .onConflictDoNothing()
        .returning({ id: inboxItems.activityId });
      if (!inserted.length) continue;
      created.push(a.id);
      rules ??= (await this.listRulesRaw(workspaceId)).filter((r) => r.enabled);
      if (rules.length) {
        mentions ??= await this.entityIdsFor(workspaceId, rows.map((r) => r.id));
        await this.applyRules(workspaceId, a, rules, mentions.get(a.id) ?? [], settings);
      }
    }
    if (created.length) this.emit(workspaceId, { kind: "new", ids: [...new Set(created)] });
    return created.length;
  }

  private async threadRootFor(workspaceId: string, a: ActivityRow): Promise<ItemRow | null> {
    let threadId: string | null = null;
    if (a.parentExternalId) {
      const [parent] = await this.ctx.db
        .select({ threadId: inboxItems.threadId })
        .from(activities)
        .innerJoin(inboxItems, eq(inboxItems.activityId, activities.id))
        .where(and(eq(activities.workspaceId, workspaceId), eq(activities.network, a.network), eq(activities.externalId, a.parentExternalId)))
        .limit(1);
      threadId = parent?.threadId ?? null;
    }
    if (!threadId && a.conversationType === "direct" && a.conversationId) {
      const [prev] = await this.ctx.db
        .select({ threadId: inboxItems.threadId })
        .from(inboxItems)
        .innerJoin(activities, eq(activities.id, inboxItems.activityId))
        .where(and(eq(activities.workspaceId, workspaceId), eq(activities.network, a.network), eq(activities.conversationId, a.conversationId), ne(activities.id, a.id)))
        .orderBy(desc(activities.occurredAt))
        .limit(1);
      threadId = prev?.threadId ?? null;
    }
    if (!threadId) return null;
    const [root] = await this.ctx.db.select().from(inboxItems).where(eq(inboxItems.activityId, threadId)).limit(1);
    return root ?? null;
  }

  private async entityIdsFor(workspaceId: string, ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!ids.length) return out;
    const rows = await this.ctx.db
      .select({ activityId: entityMentions.activityId, entityId: entityMentions.entityId })
      .from(entityMentions)
      .where(and(eq(entityMentions.workspaceId, workspaceId), inArray(entityMentions.activityId, ids)));
    for (const r of rows) out.set(r.activityId, [...(out.get(r.activityId) ?? []), r.entityId]);
    return out;
  }

  private async nextInRotation(workspaceId: string, rule: InboxRuleRow): Promise<string | null> {
    const team = new Map((await this.people(workspaceId)).map((x) => [x.userId, x.role]));
    const eligible = (rule.actions.roundRobin ?? []).filter((id) => team.has(id) && team.get(id) !== "viewer");
    if (!eligible.length) return null;
    const [row] = await this.ctx.db
      .update(inboxRules)
      .set({ rrCursor: sql`${inboxRules.rrCursor} + 1` })
      .where(eq(inboxRules.id, rule.id))
      .returning({ cursor: inboxRules.rrCursor });
    return eligible[((row?.cursor ?? 1) - 1) % eligible.length]!;
  }

  /** In order; the first matching rule decides each of assignee, priority and spam. Labels from every matching rule add up. */
  private async applyRules(workspaceId: string, a: ActivityRow, rules: InboxRuleRow[], entityIds: string[], settings: InboxSettings & { timezone: string }) {
    let assignee: string | undefined;
    let priority: InboxPriority | undefined;
    let spam = false;
    const tags: string[] = [];
    const defined = new Map(settings.tags.map((t) => [t.name.toLowerCase(), t.name]));
    for (const rule of rules) {
      if (!ruleMatches(rule.conditions, a, entityIds)) continue;
      const applied: Record<string, unknown> = {};
      if (assignee === undefined && (rule.actions.assignee || rule.actions.roundRobin?.length)) {
        const who = rule.actions.assignee ?? (await this.nextInRotation(workspaceId, rule));
        if (who) {
          assignee = who;
          applied.assignee = who;
          if (rule.actions.roundRobin?.length) applied.roundRobin = true;
        }
      }
      if (priority === undefined && rule.actions.priority) {
        priority = rule.actions.priority;
        applied.priority = priority;
      }
      if (!spam && rule.actions.spam) {
        spam = true;
        applied.status = "spam";
      }
      const newTags = (rule.actions.tags ?? []).map((t) => defined.get(t.toLowerCase())).filter((t): t is string => !!t && !tags.includes(t));
      if (newTags.length) {
        tags.push(...newTags);
        applied.tags = newTags;
      }
      if (Object.keys(applied).length) {
        await this.ctx.events.append({ workspaceId, type: "inbox.rule_applied", subjectType: "inbox_item", subjectId: a.id, actor: SYSTEM, data: { ruleId: rule.id, rule: rule.name, ...applied } });
      }
    }
    if (assignee === undefined && priority === undefined && !spam && !tags.length) return;
    await this.ctx.db
      .update(inboxItems)
      .set({
        ...(assignee !== undefined ? { assignee } : {}),
        ...(priority ? { priority, slaDueAt: slaDueAt(a.occurredAt, settings.sla[priority], settings.businessHours, settings.timezone) } : {}),
        ...(spam ? { status: "spam" as const } : {}),
        ...(tags.length ? { tags } : {}),
        updatedAt: this.ctx.now(),
      })
      .where(eq(inboxItems.activityId, a.id));
    if (assignee) this.emit(workspaceId, { kind: "assigned", ids: [a.id], userIds: [assignee] });
  }

  // ------------------------------------------------------------ replies count as responses

  /** Called for a post on its way out: when it answers an inbox conversation, that conversation has been responded to. */
  noteReply(workspaceId: string, postId: string): Promise<string[]> {
    const running = this.replyWork.get(postId);
    if (running) return running.then(() => []);
    if (this.replyWork.size > 5000) this.replyWork.clear();
    const work = this.recordReply(workspaceId, postId).then((r) => {
      if (!r.live) this.replyWork.delete(postId); // not on its way yet (waiting on approval): a later event counts it
      return r.roots;
    });
    this.replyWork.set(postId, work);
    return work;
  }

  private async recordReply(workspaceId: string, postId: string): Promise<{ live: boolean; roots: string[] }> {
    const rows = await this.ctx.db
      .select({ replyTo: postVariants.replyToExternalId, network: postVariants.network, status: posts.status, createdBy: posts.createdBy })
      .from(postVariants)
      .innerJoin(posts, eq(posts.id, postVariants.postId))
      .where(and(eq(posts.id, postId), eq(posts.workspaceId, workspaceId), sql`${postVariants.replyToExternalId} IS NOT NULL`));
    const live = rows.filter((r) => RESPONDED_POST_STATUSES.has(r.status));
    if (!live.length) return { live: false, roots: [] };
    const roots: string[] = [];
    for (const r of live) {
      const [hit] = await this.ctx.db
        .select({ threadId: inboxItems.threadId })
        .from(activities)
        .innerJoin(inboxItems, eq(inboxItems.activityId, activities.id))
        .where(and(eq(activities.workspaceId, workspaceId), eq(activities.network, r.network), eq(activities.externalId, r.replyTo!)))
        .limit(1);
      if (!hit || roots.includes(hit.threadId)) continue;
      const now = this.ctx.now();
      const [before] = await this.ctx.db.select().from(inboxItems).where(eq(inboxItems.activityId, hit.threadId)).limit(1);
      if (!before) continue;
      await this.ctx.db
        .update(inboxItems)
        .set({ firstResponseAt: sql`coalesce(${inboxItems.firstResponseAt}, ${now.toISOString()}::timestamptz)`, status: before.status === "open" ? "pending" : before.status, updatedAt: now })
        .where(eq(inboxItems.activityId, hit.threadId));
      roots.push(hit.threadId);
      await this.ctx.events.append({
        workspaceId,
        type: "inbox.responded",
        subjectType: "inbox_item",
        subjectId: hit.threadId,
        actor: r.createdBy,
        data: { postId, first: !before.firstResponseAt, ...(before.status === "open" ? { status: { from: "open", to: "pending" } } : {}) },
      });
    }
    if (roots.length) this.emit(workspaceId, { kind: "updated", ids: roots });
    return { live: true, roots };
  }

  // ------------------------------------------------------------ reading

  private filters(workspaceId: string, q: InboxQuery): SQL[] {
    const conds: SQL[] = [eq(inboxItems.workspaceId, workspaceId), eq(inboxItems.threadId, inboxItems.activityId)];
    if (q.tag) conds.push(sql`${inboxItems.tags} @> ${JSON.stringify([q.tag])}::jsonb`);
    if (q.priority?.length) conds.push(inArray(inboxItems.priority, q.priority));
    if (q.networks?.length) conds.push(inArray(activities.network, q.networks));
    if (q.q?.trim()) {
      const like = `%${q.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      conds.push(sql`EXISTS (SELECT 1 FROM inbox_items t JOIN activities x ON x.id = t.activity_id WHERE t.thread_id = ${inboxItems.activityId} AND (x.text ILIKE ${like} OR x.translation ILIKE ${like} OR x.author_handle ILIKE ${like} OR x.author_name ILIKE ${like}))`);
    }
    return conds;
  }

  async list(p: Principal, q: InboxQuery = {}): Promise<{ items: InboxEntry[]; counts: InboxCounts; viewer: { userId: string | null; canWork: boolean; canAssign: boolean; canManage: boolean } }> {
    this.requireMember(p);
    const now = this.ctx.now();
    const me = p.actor.type === "human" ? p.actor.id : null;
    const base = this.filters(p.workspaceId, q);
    const conds = [...base];
    if (q.status?.length) conds.push(inArray(inboxItems.status, q.status));
    if (q.assignee === "me") conds.push(me ? eq(inboxItems.assignee, me) : sql`false`);
    else if (q.assignee === "none") conds.push(isNull(inboxItems.assignee));
    else if (q.assignee && q.assignee !== "any") conds.push(eq(inboxItems.assignee, q.assignee));
    const nowIso = now.toISOString();
    if (q.snoozed) conds.push(gt(inboxItems.snoozedUntil, now));
    else conds.push(or(isNull(inboxItems.snoozedUntil), lte(inboxItems.snoozedUntil, now))!);
    const waitingDue = sql`CASE WHEN ${inboxItems.firstResponseAt} IS NULL AND ${inboxItems.status} IN ('open','pending') THEN ${inboxItems.slaDueAt} END`;
    const order =
      q.sort === "oldest"
        ? [asc(inboxItems.lastActivityAt)]
        : q.sort === "due"
          ? [sql`${waitingDue} ASC NULLS LAST`, desc(inboxItems.lastActivityAt)]
          : q.sort === "priority"
            ? [sql`CASE ${inboxItems.priority} WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END`, sql`${waitingDue} ASC NULLS LAST`, desc(inboxItems.lastActivityAt)]
            : [desc(inboxItems.lastActivityAt)];
    const rows = await this.ctx.db
      .select({ item: inboxItems, activity: activities })
      .from(inboxItems)
      .innerJoin(activities, eq(activities.id, inboxItems.activityId))
      .where(and(...conds))
      .orderBy(...order)
      .limit(Math.min(Math.max(q.limit ?? 50, 1), 200))
      .offset(Math.max(q.offset ?? 0, 0));

    const countRows = await this.ctx.db
      .select({
        status: inboxItems.status,
        mine: me ? sql<boolean>`coalesce(${inboxItems.assignee} = ${me}, false)` : sql<boolean>`false`,
        unassigned: sql<boolean>`${inboxItems.assignee} IS NULL`,
        snoozed: sql<boolean>`coalesce(${inboxItems.snoozedUntil} > ${nowIso}::timestamptz, false)`,
        n: sql<number>`count(*)`,
      })
      .from(inboxItems)
      .innerJoin(activities, eq(activities.id, inboxItems.activityId))
      .where(and(...base))
      .groupBy(sql`1`, sql`2`, sql`3`, sql`4`);
    const counts: InboxCounts = { open: 0, pending: 0, done: 0, spam: 0, mine: 0, unassigned: 0, snoozed: 0 };
    for (const r of countRows) {
      const n = Number(r.n);
      const active = r.status === "open" || r.status === "pending";
      if (active && r.snoozed) {
        counts.snoozed += n;
        continue;
      }
      counts[r.status] += n;
      if (active && r.mine) counts.mine += n;
      if (r.status === "open" && r.unassigned) counts.unassigned += n;
    }
    const settings = await this.settings(p.workspaceId);
    const items = await this.entries(p.workspaceId, rows, settings, now);
    const human = p.actor.type === "human";
    return {
      items,
      counts,
      viewer: {
        userId: me,
        canWork: human ? !!p.role && (WORKER_ROLES as readonly string[]).includes(p.role) : true,
        canAssign: human && !!p.role && (WORKER_ROLES as readonly string[]).includes(p.role),
        canManage: human && !!p.role && (MANAGER_ROLES as readonly string[]).includes(p.role),
      },
    };
  }

  private toState(r: ItemRow): InboxState {
    return {
      status: r.status,
      assignee: r.assignee,
      priority: r.priority,
      tags: r.tags,
      firstResponseAt: r.firstResponseAt,
      doneAt: r.doneAt,
      snoozedUntil: r.snoozedUntil,
      slaDueAt: r.slaDueAt,
      lastActivityAt: r.lastActivityAt,
      messageCount: r.messageCount,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private async entries(workspaceId: string, rows: { item: ItemRow; activity: ActivityRow }[], settings: InboxSettings, now: Date): Promise<InboxEntry[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.item.activityId);
    const multi = rows.filter((r) => r.item.messageCount > 1).map((r) => r.item.activityId);
    const latest = new Map<string, ActivityRow>();
    if (multi.length) {
      const msgs = await this.ctx.db
        .select({ threadId: inboxItems.threadId, activity: activities })
        .from(inboxItems)
        .innerJoin(activities, eq(activities.id, inboxItems.activityId))
        .where(and(eq(inboxItems.workspaceId, workspaceId), inArray(inboxItems.threadId, multi), ne(inboxItems.activityId, inboxItems.threadId)))
        .orderBy(desc(activities.occurredAt));
      for (const m of msgs) if (!latest.has(m.threadId)) latest.set(m.threadId, m.activity);
    }
    const noteRows = await this.ctx.db
      .select({ threadId: inboxNotes.threadId, n: sql<number>`count(*)` })
      .from(inboxNotes)
      .where(and(eq(inboxNotes.workspaceId, workspaceId), inArray(inboxNotes.threadId, ids)))
      .groupBy(inboxNotes.threadId);
    const notes = new Map(noteRows.map((r) => [r.threadId, Number(r.n)]));
    return rows.map(({ item, activity }) => {
      const state = this.toState(item);
      return { activity, latest: latest.get(item.activityId) ?? null, state, sla: slaView(state, settings, now), notes: notes.get(item.activityId) ?? 0 };
    });
  }

  /** The root row for any message of a conversation; an older item without a row gets one now. */
  private async rootRow(workspaceId: string, activityId: string): Promise<{ item: ItemRow; activity: ActivityRow }> {
    const [hit] = await this.ctx.db
      .select({ threadId: inboxItems.threadId })
      .from(inboxItems)
      .where(and(eq(inboxItems.activityId, activityId), eq(inboxItems.workspaceId, workspaceId)))
      .limit(1);
    let rootId = hit?.threadId;
    if (!rootId) {
      const [a] = await this.ctx.db.select().from(activities).where(and(eq(activities.id, activityId), eq(activities.workspaceId, workspaceId))).limit(1);
      if (!a) throw new CoreError("not_found", `activity ${activityId}`);
      if (NOT_INBOX_KINDS.has(a.kind)) throw new CoreError("invalid", `a ${a.kind.replace("_", " ")} is not an inbox conversation`);
      if (!a.socialAccountId) throw new CoreError("invalid", "this came from public search, not to one of your accounts, so it is not an inbox conversation");
      await this.ctx.db.insert(inboxItems).values({ activityId: a.id, workspaceId, threadId: a.id, lastActivityAt: a.occurredAt }).onConflictDoNothing();
      rootId = a.id;
    }
    const [row] = await this.ctx.db
      .select({ item: inboxItems, activity: activities })
      .from(inboxItems)
      .innerJoin(activities, eq(activities.id, inboxItems.activityId))
      .where(eq(inboxItems.activityId, rootId))
      .limit(1);
    if (!row) throw new CoreError("not_found", `inbox item ${activityId}`);
    return row;
  }

  async entry(p: Principal, activityId: string): Promise<InboxEntry> {
    this.requireMember(p);
    const row = await this.rootRow(p.workspaceId, activityId);
    const [e] = await this.entries(p.workspaceId, [row], await this.settings(p.workspaceId), this.ctx.now());
    return e!;
  }

  /** One conversation: every message in it, the post it answers (when it is ours), the team's replies and notes. */
  async conversation(p: Principal, activityId: string) {
    this.requireMember(p);
    const root = await this.rootRow(p.workspaceId, activityId);
    const messages = (
      await this.ctx.db
        .select({ activity: activities })
        .from(inboxItems)
        .innerJoin(activities, eq(activities.id, inboxItems.activityId))
        .where(and(eq(inboxItems.workspaceId, p.workspaceId), eq(inboxItems.threadId, root.item.activityId)))
        .orderBy(asc(activities.occurredAt))
    ).map((r) => r.activity);
    let parent: ActivityRow | null = null;
    if (root.activity.parentExternalId) {
      const [row] = await this.ctx.db
        .select()
        .from(activities)
        .where(and(eq(activities.workspaceId, p.workspaceId), eq(activities.network, root.activity.network), eq(activities.externalId, root.activity.parentExternalId)))
        .limit(1);
      parent = row ?? null;
    }
    const externalIds = messages.map((m) => m.externalId);
    const replies = externalIds.length
      ? await this.ctx.db
          .select({ postId: posts.id, status: posts.status, text: postVariants.text, replyTo: postVariants.replyToExternalId, network: postVariants.network, createdAt: posts.createdAt, createdBy: posts.createdBy, publishedAt: postVariants.publishedAt })
          .from(postVariants)
          .innerJoin(posts, eq(posts.id, postVariants.postId))
          .where(and(eq(posts.workspaceId, p.workspaceId), eq(postVariants.network, root.activity.network), inArray(postVariants.replyToExternalId, externalIds)))
          .orderBy(asc(posts.createdAt))
      : [];
    const [item] = await this.entries(p.workspaceId, [root], await this.settings(p.workspaceId), this.ctx.now());
    return { item: item!, messages, parent, replies, notes: await this.notesOf(p.workspaceId, root.item.activityId) };
  }

  // ------------------------------------------------------------ changing

  private async prepare(p: Principal, patch: InboxPatch) {
    this.requireWorker(p, patch);
    let assignee: string | null | undefined;
    if (patch.assignee !== undefined) {
      if (patch.assignee === null) assignee = null;
      else {
        const who = patch.assignee === "me" ? p.actor.id : patch.assignee;
        if (patch.assignee === "me" && p.actor.type !== "human") throw new CoreError("forbidden", "agents cannot be assigned conversations");
        assignee = await this.assignable(p, who);
      }
    }
    const tags = patch.tags ? await this.tagNames(p.workspaceId, patch.tags) : undefined;
    const addTags = patch.addTags ? await this.tagNames(p.workspaceId, patch.addTags) : undefined;
    const removeTags = patch.removeTags?.map((t) => t.toLowerCase());
    let snoozedUntil: Date | null | undefined;
    if (patch.snoozedUntil !== undefined) {
      snoozedUntil = patch.snoozedUntil === null ? null : new Date(patch.snoozedUntil);
      if (snoozedUntil && snoozedUntil.getTime() <= this.ctx.now().getTime()) throw new CoreError("invalid", "snooze until a time in the future");
    }
    return { status: patch.status, priority: patch.priority, assignee, tags, addTags, removeTags, snoozedUntil };
  }

  private async apply(p: Principal, root: { item: ItemRow; activity: ActivityRow }, change: Awaited<ReturnType<InboxService["prepare"]>>, settings: InboxSettings & { timezone: string }, bulk = false): Promise<boolean> {
    const cur = root.item;
    const now = this.ctx.now();
    const set: Partial<typeof inboxItems.$inferInsert> = {};
    const changes: Record<string, unknown> = {};
    if (change.status && change.status !== cur.status) {
      set.status = change.status;
      changes.status = { from: cur.status, to: change.status };
      if (change.status === "done") set.doneAt = now;
      else set.doneAt = null;
      if (change.status === "done" || change.status === "spam") set.snoozedUntil = null;
    }
    if (change.assignee !== undefined && change.assignee !== cur.assignee) {
      set.assignee = change.assignee;
      changes.assignee = { from: cur.assignee, to: change.assignee };
    }
    if (change.priority && change.priority !== cur.priority) {
      set.priority = change.priority;
      set.slaDueAt = slaDueAt(root.activity.occurredAt, settings.sla[change.priority], settings.businessHours, settings.timezone);
      changes.priority = { from: cur.priority, to: change.priority };
    }
    let tags = cur.tags;
    if (change.tags) tags = change.tags;
    if (change.addTags) tags = [...tags, ...change.addTags.filter((t) => !tags.includes(t))];
    if (change.removeTags) tags = tags.filter((t) => !change.removeTags!.includes(t.toLowerCase()));
    if (tags.length > 20) throw new CoreError("invalid", "at most 20 labels on one conversation");
    if (JSON.stringify(tags) !== JSON.stringify(cur.tags)) {
      set.tags = tags;
      changes.tags = { added: tags.filter((t) => !cur.tags.includes(t)), removed: cur.tags.filter((t) => !tags.includes(t)) };
    }
    if (change.snoozedUntil !== undefined && set.snoozedUntil === undefined) {
      const before = cur.snoozedUntil?.getTime() ?? null;
      const after = change.snoozedUntil?.getTime() ?? null;
      if (before !== after) {
        set.snoozedUntil = change.snoozedUntil;
        changes.snoozedUntil = change.snoozedUntil ? change.snoozedUntil.toISOString() : null;
      }
    }
    if (!Object.keys(changes).length) return false;
    set.updatedAt = now;
    await this.ctx.db.update(inboxItems).set(set).where(eq(inboxItems.activityId, cur.activityId));
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "inbox.item_updated", subjectType: "inbox_item", subjectId: cur.activityId, actor: p.actor, data: { ...changes, ...(bulk ? { bulk: true } : {}) } });
    if (set.assignee && set.assignee !== p.actor.id) this.emit(p.workspaceId, { kind: "assigned", ids: [cur.activityId], userIds: [set.assignee] });
    return true;
  }

  async patch(p: Principal, activityId: string, raw: unknown): Promise<InboxEntry> {
    const change = await this.prepare(p, InboxPatch.parse(raw));
    const root = await this.rootRow(p.workspaceId, activityId);
    if (await this.apply(p, root, change, await this.settings(p.workspaceId))) this.emit(p.workspaceId, { kind: "updated", ids: [root.item.activityId] });
    return this.entry(p, root.item.activityId);
  }

  async bulkPatch(p: Principal, ids: unknown, raw: unknown): Promise<{ updated: number; items: InboxEntry[] }> {
    const list = z.array(z.string().min(1)).min(1).max(200).parse(ids);
    const change = await this.prepare(p, InboxPatch.parse(raw));
    const settings = await this.settings(p.workspaceId);
    const roots = new Map<string, { item: ItemRow; activity: ActivityRow }>();
    for (const id of list) {
      const r = await this.rootRow(p.workspaceId, id);
      roots.set(r.item.activityId, r);
    }
    let updated = 0;
    for (const r of roots.values()) if (await this.apply(p, r, change, settings, true)) updated++;
    if (updated) this.emit(p.workspaceId, { kind: "updated", ids: [...roots.keys()] });
    const rows = await this.ctx.db
      .select({ item: inboxItems, activity: activities })
      .from(inboxItems)
      .innerJoin(activities, eq(activities.id, inboxItems.activityId))
      .where(inArray(inboxItems.activityId, [...roots.keys()]));
    return { updated, items: await this.entries(p.workspaceId, rows, settings, this.ctx.now()) };
  }

  // ------------------------------------------------------------ notes

  private async notesOf(workspaceId: string, threadId: string) {
    return this.ctx.db
      .select()
      .from(inboxNotes)
      .where(and(eq(inboxNotes.workspaceId, workspaceId), eq(inboxNotes.threadId, threadId)))
      .orderBy(asc(inboxNotes.createdAt));
  }

  async listNotes(p: Principal, activityId: string): Promise<InboxNoteRow[]> {
    this.requireMember(p);
    const root = await this.rootRow(p.workspaceId, activityId);
    return this.notesOf(p.workspaceId, root.item.activityId);
  }

  private async mentionsIn(workspaceId: string, text: string, explicit: string[] = []): Promise<string[]> {
    const team = await this.people(workspaceId);
    const known = new Set(team.map((t) => t.userId));
    return [...new Set([...parseMentions(text, team), ...explicit.filter((id) => known.has(id))])];
  }

  private notifyMentions(p: Principal, threadId: string, noteId: string, userIds: string[]) {
    const others = userIds.filter((u) => u !== p.actor.id);
    if (others.length) this.emit(p.workspaceId, { kind: "mention", ids: [threadId], userIds: others, noteId });
    return others;
  }

  async addNote(p: Principal, activityId: string, raw: unknown): Promise<InboxNoteRow> {
    this.requireWorker(p);
    const input = z.object({ text: z.string().trim().min(1).max(5000), mentions: z.array(z.string().min(1)).max(50).optional() }).parse(raw);
    const root = await this.rootRow(p.workspaceId, activityId);
    const mentions = await this.mentionsIn(p.workspaceId, input.text, input.mentions);
    const [row] = await this.ctx.db
      .insert(inboxNotes)
      .values({ id: newId("note"), workspaceId: p.workspaceId, threadId: root.item.activityId, author: p.actor, text: input.text, mentions, createdAt: this.ctx.now() })
      .returning();
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "inbox.note_added", subjectType: "inbox_item", subjectId: root.item.activityId, actor: p.actor, data: { noteId: row!.id, mentions } });
    const notified = this.notifyMentions(p, root.item.activityId, row!.id, mentions);
    for (const userId of notified) {
      await this.ctx.events.append({ workspaceId: p.workspaceId, type: "inbox.mentioned", subjectType: "user", subjectId: userId, actor: p.actor, data: { noteId: row!.id, activityId: root.item.activityId } });
    }
    this.emit(p.workspaceId, { kind: "note", ids: [root.item.activityId], noteId: row!.id });
    return row!;
  }

  private async noteRow(p: Principal, noteId: string): Promise<InboxNoteRow> {
    const [row] = await this.ctx.db.select().from(inboxNotes).where(and(eq(inboxNotes.id, noteId), eq(inboxNotes.workspaceId, p.workspaceId))).limit(1);
    if (!row) throw new CoreError("not_found", `note ${noteId}`);
    return row;
  }

  async updateNote(p: Principal, noteId: string, raw: unknown): Promise<InboxNoteRow> {
    this.requireWorker(p);
    const input = z.object({ text: z.string().trim().min(1).max(5000) }).parse(raw);
    const note = await this.noteRow(p, noteId);
    if (note.author.type !== p.actor.type || note.author.id !== p.actor.id) throw new CoreError("forbidden", "only the person who wrote a note can edit it");
    const mentions = await this.mentionsIn(p.workspaceId, input.text);
    const [row] = await this.ctx.db.update(inboxNotes).set({ text: input.text, mentions, editedAt: this.ctx.now() }).where(eq(inboxNotes.id, noteId)).returning();
    const added = mentions.filter((m) => !note.mentions.includes(m));
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "inbox.note_updated", subjectType: "inbox_item", subjectId: note.threadId, actor: p.actor, data: { noteId, mentions } });
    for (const userId of this.notifyMentions(p, note.threadId, noteId, added)) {
      await this.ctx.events.append({ workspaceId: p.workspaceId, type: "inbox.mentioned", subjectType: "user", subjectId: userId, actor: p.actor, data: { noteId, activityId: note.threadId } });
    }
    this.emit(p.workspaceId, { kind: "note", ids: [note.threadId], noteId });
    return row!;
  }

  async deleteNote(p: Principal, noteId: string): Promise<void> {
    this.requireWorker(p);
    const note = await this.noteRow(p, noteId);
    const own = note.author.type === p.actor.type && note.author.id === p.actor.id;
    if (!own && !(p.actor.type === "human" && p.role === "owner")) throw new CoreError("forbidden", "a note is removed by the person who wrote it, or an owner");
    await this.ctx.db.delete(inboxNotes).where(eq(inboxNotes.id, noteId));
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "inbox.note_deleted", subjectType: "inbox_item", subjectId: note.threadId, actor: p.actor, data: { noteId } });
    this.emit(p.workspaceId, { kind: "note", ids: [note.threadId], noteId });
  }

  // ------------------------------------------------------------ saved replies

  async listSavedReplies(p: Principal): Promise<SavedReplyRow[]> {
    this.requireMember(p);
    return this.ctx.db.select().from(savedReplies).where(eq(savedReplies.workspaceId, p.workspaceId)).orderBy(asc(savedReplies.name));
  }

  async createSavedReply(p: Principal, raw: unknown): Promise<SavedReplyRow> {
    this.requireEditorHuman(p, "saved replies");
    const input = SavedReplyInput.parse(raw);
    const now = this.ctx.now();
    const [row] = await this.ctx.db
      .insert(savedReplies)
      .values({ id: newId("srep"), workspaceId: p.workspaceId, name: input.name, text: input.text, lang: input.lang ?? null, createdBy: p.actor, createdAt: now, updatedAt: now })
      .returning();
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "inbox.saved_reply_created", subjectType: "saved_reply", subjectId: row!.id, actor: p.actor, data: { name: input.name, lang: input.lang ?? null } });
    return row!;
  }

  private async savedReply(p: Principal, id: string): Promise<SavedReplyRow> {
    const [row] = await this.ctx.db.select().from(savedReplies).where(and(eq(savedReplies.id, id), eq(savedReplies.workspaceId, p.workspaceId))).limit(1);
    if (!row) throw new CoreError("not_found", `saved reply ${id}`);
    return row;
  }

  async updateSavedReply(p: Principal, id: string, raw: unknown): Promise<SavedReplyRow> {
    this.requireEditorHuman(p, "saved replies");
    const input = SavedReplyInput.partial().parse(raw);
    await this.savedReply(p, id);
    const [row] = await this.ctx.db
      .update(savedReplies)
      .set({ ...(input.name !== undefined ? { name: input.name } : {}), ...(input.text !== undefined ? { text: input.text } : {}), ...(input.lang !== undefined ? { lang: input.lang } : {}), updatedAt: this.ctx.now() })
      .where(eq(savedReplies.id, id))
      .returning();
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "inbox.saved_reply_updated", subjectType: "saved_reply", subjectId: id, actor: p.actor, data: { fields: Object.keys(input) } });
    return row!;
  }

  async deleteSavedReply(p: Principal, id: string): Promise<void> {
    this.requireEditorHuman(p, "saved replies");
    const row = await this.savedReply(p, id);
    await this.ctx.db.delete(savedReplies).where(eq(savedReplies.id, id));
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "inbox.saved_reply_deleted", subjectType: "saved_reply", subjectId: id, actor: p.actor, data: { name: row.name } });
  }

  /** The saved reply with this conversation's variables filled in, for the reply box. Nothing is sent. */
  async fillSavedReply(p: Principal, id: string, activityId: string): Promise<{ text: string; lang: string | null }> {
    this.requireMember(p);
    const reply = await this.savedReply(p, id);
    const root = await this.rootRow(p.workspaceId, activityId);
    const [ws] = await this.ctx.db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, p.workspaceId)).limit(1);
    return { text: fillSavedReply(reply.text, replyVariables(root.activity, ws?.name ?? "")), lang: reply.lang };
  }

  // ------------------------------------------------------------ rules

  private toRule(r: typeof inboxRules.$inferSelect): InboxRuleRow {
    const c = RuleConditions.safeParse(r.conditions);
    const a = RuleActions.safeParse(r.actions);
    return { ...r, conditions: c.success ? c.data : RuleConditions.parse({}), actions: a.success ? a.data : {} };
  }

  private async listRulesRaw(workspaceId: string): Promise<InboxRuleRow[]> {
    const rows = await this.ctx.db.select().from(inboxRules).where(eq(inboxRules.workspaceId, workspaceId)).orderBy(asc(inboxRules.position), asc(inboxRules.createdAt));
    return rows.map((r) => this.toRule(r));
  }

  async listRules(p: Principal): Promise<InboxRuleRow[]> {
    this.requireMember(p);
    return this.listRulesRaw(p.workspaceId);
  }

  private async checkRule(p: Principal, input: { actions: RuleActions }) {
    const a = input.actions;
    if (!a.assignee && !a.roundRobin?.length && !a.tags?.length && !a.priority && !a.spam) throw new CoreError("invalid", "a rule needs something to do: assign, rotate, label, set priority or mark spam");
    for (const id of [...(a.assignee ? [a.assignee] : []), ...(a.roundRobin ?? [])]) await this.assignable({ ...p, actor: { type: "system", id: "rules" } }, id);
    if (a.tags?.length) a.tags = await this.tagNames(p.workspaceId, a.tags);
  }

  async createRule(p: Principal, raw: unknown): Promise<InboxRuleRow> {
    this.requireManager(p, "inbox rules");
    const input = RuleInput.parse(raw);
    await this.checkRule(p, input);
    const [last] = await this.ctx.db.select({ max: sql<number>`coalesce(max(${inboxRules.position}), -1)` }).from(inboxRules).where(eq(inboxRules.workspaceId, p.workspaceId));
    const now = this.ctx.now();
    const [row] = await this.ctx.db
      .insert(inboxRules)
      .values({ id: newId("rule"), workspaceId: p.workspaceId, name: input.name, enabled: input.enabled, position: Number(last?.max ?? -1) + 1, conditions: input.conditions, actions: input.actions, createdBy: p.actor, createdAt: now, updatedAt: now })
      .returning();
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "inbox.rule_created", subjectType: "inbox_rule", subjectId: row!.id, actor: p.actor, data: { name: input.name, conditions: input.conditions, actions: input.actions } });
    return this.toRule(row!);
  }

  async updateRule(p: Principal, id: string, raw: unknown): Promise<InboxRuleRow> {
    this.requireManager(p, "inbox rules");
    const [cur] = await this.ctx.db.select().from(inboxRules).where(and(eq(inboxRules.id, id), eq(inboxRules.workspaceId, p.workspaceId))).limit(1);
    if (!cur) throw new CoreError("not_found", `rule ${id}`);
    const input = RuleInput.partial().parse(raw);
    if (input.actions) await this.checkRule(p, { actions: input.actions });
    const [row] = await this.ctx.db
      .update(inboxRules)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.conditions ? { conditions: input.conditions } : {}),
        ...(input.actions ? { actions: input.actions, rrCursor: 0 } : {}),
        updatedAt: this.ctx.now(),
      })
      .where(eq(inboxRules.id, id))
      .returning();
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "inbox.rule_updated", subjectType: "inbox_rule", subjectId: id, actor: p.actor, data: input as Record<string, unknown> });
    return this.toRule(row!);
  }

  async deleteRule(p: Principal, id: string): Promise<void> {
    this.requireManager(p, "inbox rules");
    const [row] = await this.ctx.db.delete(inboxRules).where(and(eq(inboxRules.id, id), eq(inboxRules.workspaceId, p.workspaceId))).returning();
    if (!row) throw new CoreError("not_found", `rule ${id}`);
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "inbox.rule_deleted", subjectType: "inbox_rule", subjectId: id, actor: p.actor, data: { name: row.name } });
  }

  /** New order: rules not listed keep their place after the listed ones. */
  async reorderRules(p: Principal, raw: unknown): Promise<InboxRuleRow[]> {
    this.requireManager(p, "inbox rules");
    const ids = z.array(z.string().min(1)).max(200).parse(raw);
    const all = await this.listRulesRaw(p.workspaceId);
    const known = new Set(all.map((r) => r.id));
    const order = [...ids.filter((id) => known.has(id)), ...all.map((r) => r.id).filter((id) => !ids.includes(id))];
    for (const [i, id] of order.entries()) await this.ctx.db.update(inboxRules).set({ position: i }).where(eq(inboxRules.id, id));
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "inbox.rule_updated", subjectType: "workspace", subjectId: p.workspaceId, actor: p.actor, data: { order } });
    return this.listRulesRaw(p.workspaceId);
  }

  // ------------------------------------------------------------ live

  private emit(workspaceId: string, payload: { kind: "new" | "updated" | "assigned" | "mention" | "note" | "settings"; ids?: string[]; userIds?: string[]; noteId?: string }) {
    this.ctx.emitter.emit("inbox", { workspaceId, ...payload });
  }
}
