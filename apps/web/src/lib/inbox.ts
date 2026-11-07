// The team inbox, shared by the panel, the drawers and the fixture server. Mirrors core's inbox helpers where both need them.
import type { Activity, InboxEntry, InboxPriority, InboxQuery, InboxSla, InboxStatus, InboxTagColor, Member } from "../types";

export const STATUS_LABEL: Record<InboxStatus, string> = { open: "Open", pending: "Pending", done: "Done", spam: "Spam" };
export const STATUS_HINT: Record<InboxStatus, string> = {
  open: "Waiting on the team",
  pending: "Answered; waiting on them",
  done: "Nothing left to do",
  spam: "Not worth an answer",
};
export const PRIORITY_LABEL: Record<InboxPriority, string> = { urgent: "Urgent", high: "High", normal: "Normal" };
export const PRIORITIES: InboxPriority[] = ["urgent", "high", "normal"];
export const STATUSES: InboxStatus[] = ["open", "pending", "done", "spam"];
export const TAG_COLORS: InboxTagColor[] = ["gray", "blue", "green", "amber", "red", "violet"];
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type InboxTabId = "mine" | "unassigned" | "open" | "pending" | "done" | "spam" | "snoozed";

export const INBOX_TABS: { id: InboxTabId; label: string; key: keyof import("../types").InboxCounts }[] = [
  { id: "mine", label: "Mine", key: "mine" },
  { id: "unassigned", label: "Unassigned", key: "unassigned" },
  { id: "open", label: "Open", key: "open" },
  { id: "pending", label: "Pending", key: "pending" },
  { id: "done", label: "Done", key: "done" },
  { id: "spam", label: "Spam", key: "spam" },
];

/** What each tab asks the server for. */
export function tabQuery(tab: InboxTabId): Pick<InboxQuery, "status" | "assignee" | "snoozed" | "sort"> {
  switch (tab) {
    case "mine":
      return { status: ["open", "pending"], assignee: "me", sort: "due" };
    case "unassigned":
      return { status: ["open"], assignee: "none", sort: "due" };
    case "open":
      return { status: ["open"], sort: "due" };
    case "pending":
      return { status: ["pending"], sort: "newest" };
    case "done":
      return { status: ["done"], sort: "newest" };
    case "spam":
      return { status: ["spam"], sort: "newest" };
    case "snoozed":
      return { snoozed: true, sort: "newest" };
  }
}

/** "12m", "3h 5m", "2d 4h". */
export function span(ms: number): string {
  const m = Math.max(0, Math.round(Math.abs(ms) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** The SLA badge: time left, or how late. Null when no target applies. */
export function slaBadge(sla: InboxSla, now: number): { tone: "ok" | "soon" | "overdue" | "met" | "missed"; text: string; title: string } | null {
  const due = sla.dueAt ? Date.parse(sla.dueAt) : null;
  switch (sla.state) {
    case "ok":
    case "soon":
    case "overdue": {
      const left = due !== null ? due - now : (sla.msLeft ?? 0);
      if (left < 0) return { tone: "overdue", text: `${span(left)} overdue`, title: `First reply was due ${span(left)} ago (target ${span(sla.targetMinutes * 60_000)})` };
      return { tone: left <= Math.min(sla.targetMinutes * 60_000 * 0.25, 3_600_000) ? "soon" : "ok", text: `${span(left)} left`, title: `First reply due in ${span(left)} (target ${span(sla.targetMinutes * 60_000)})` };
    }
    case "met":
      return { tone: "met", text: "Answered", title: "First reply went out within the target" };
    case "missed":
      return { tone: "missed", text: "Answered late", title: "First reply went out after the target" };
    default:
      return null;
  }
}

/** The newest words in a conversation, for the row. */
export function latestOf(e: InboxEntry): Activity {
  return e.latest ?? e.activity;
}

/** Snooze choices relative to now. */
export function snoozeOptions(now: Date): { label: string; at: Date }[] {
  const inHours = (h: number) => new Date(now.getTime() + h * 3_600_000);
  const tomorrow9 = new Date(now);
  tomorrow9.setDate(tomorrow9.getDate() + 1);
  tomorrow9.setHours(9, 0, 0, 0);
  const monday9 = new Date(now);
  monday9.setDate(monday9.getDate() + (((8 - monday9.getDay()) % 7) || 7));
  monday9.setHours(9, 0, 0, 0);
  return [
    { label: "1 hour", at: inHours(1) },
    { label: "3 hours", at: inHours(3) },
    { label: "Tomorrow 9:00", at: tomorrow9 },
    { label: "Monday 9:00", at: monday9 },
  ];
}

export function memberName(members: readonly Member[], userId: string | null | undefined, me?: string | null): string {
  if (!userId) return "Nobody";
  if (me && userId === me) return "You";
  const m = members.find((x) => x.userId === userId);
  return m ? m.name || m.email : userId;
}

export function initialsOf(name: string): string {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
}

/** How a teammate is @mentioned in a note: their email name ("sam", "ana.ruiz"). */
export function mentionHandle(m: Pick<Member, "email">): string {
  return m.email.split("@")[0]!.toLowerCase();
}

/** Same rules as the server: first name, email name, or full name without spaces. */
export function parseMentions(text: string, people: readonly Pick<Member, "userId" | "email" | "name">[]): string[] {
  const keys = new Map<string, string>();
  for (const p of people) {
    keys.set(mentionHandle(p), p.userId);
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
    const id = keys.get(m[2]!.toLowerCase().replace(/[._-]+$/, ""));
    if (id) out.add(id);
  }
  return [...out];
}

const VARIABLE = /(\\?)\{\{\s*([a-zA-Z_]+)\s*\}\}/g;
export const SAVED_REPLY_VARIABLES = ["author_name", "author_handle", "brand"] as const;

/** Same as the server: one pass, `\{{x}}` is literal, unknown variables stay, values are one plain line. */
export function fillSavedReply(template: string, vars: Partial<Record<(typeof SAVED_REPLY_VARIABLES)[number], string | null>>): string {
  return template.replace(VARIABLE, (whole, escape: string, name: string) => {
    if (escape) return whole.slice(1);
    const key = name.toLowerCase() as (typeof SAVED_REPLY_VARIABLES)[number];
    if (!(SAVED_REPLY_VARIABLES as readonly string[]).includes(key)) return whole;
    const v = vars[key];
    return v
      ? v
          .replace(/[\p{Cc}\p{Cf}]/gu, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80)
      : "";
  });
}

export function replyVariables(a: Pick<Activity, "authorName" | "authorHandle">, brand: string) {
  const handle = a.authorHandle ? (a.authorHandle.startsWith("@") ? a.authorHandle : `@${a.authorHandle}`) : null;
  const name = a.authorName?.trim() ? a.authorName.trim() : (a.authorHandle?.replace(/^@/, "") ?? null);
  return { author_name: name, author_handle: handle, brand };
}

/** Typing in an input, a textarea, a select or an editable element: shortcuts stay out of the way. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: "j / k", what: "Next / previous conversation" },
  { keys: "Enter or o", what: "Open the conversation" },
  { keys: "x", what: "Select it" },
  { keys: "e", what: "Mark done" },
  { keys: "a", what: "Assign to me" },
  { keys: "r", what: "Reply" },
  { keys: "n", what: "Add a note" },
  { keys: "#", what: "Label" },
  { keys: "s", what: "Snooze" },
  { keys: "/", what: "Search" },
  { keys: "?", what: "Show these shortcuts" },
  { keys: "Esc", what: "Close" },
];
