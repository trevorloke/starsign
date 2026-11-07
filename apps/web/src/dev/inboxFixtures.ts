// ---- inbox workflow: the shared inbox's fixture "server" (VITE_USE_FIXTURES=1).
// Built over the feed fixtures: every message that came in through a connected account is a conversation, plus a busy,
// multilingual set of follow-ups and new messages. Everything is relative to page load and lives in memory.

import type {
  Account,
  Activity,
  ActivityKind,
  Actor,
  InboxConversation,
  InboxCounts,
  InboxEntry,
  InboxItemState,
  InboxList,
  InboxNote,
  InboxPatch,
  InboxPriority,
  InboxQuery,
  InboxReply,
  InboxRule,
  InboxRuleInput,
  InboxSettings,
  InboxSettingsPatch,
  InboxStatus,
  Member,
  Network,
  PostDetail,
  Role,
  SavedReply,
  SavedReplyInput,
} from "../types";
import { ApiError } from "../lib/errors";
import { fillSavedReply, parseMentions, replyVariables } from "../lib/inbox";

export interface InboxFixtureDeps {
  /** The feed fixture's own list (mutable): the inbox adds its extra messages to it. */
  feed: () => Activity[];
  members: () => Member[];
  me: () => { userId: string; role: Role };
  workspaceName: () => string;
  accounts: () => Account[];
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const delay = <T,>(v: T, ms = 120) => new Promise<T>((resolve) => setTimeout(() => resolve(clone(v)), ms));
const NOT_INBOX = new Set<ActivityKind>(["own_post", "like", "follow", "repost"]);
const WORKERS: Role[] = ["owner", "approver", "editor"];
const MANAGERS: Role[] = ["owner", "approver"];

interface Extra {
  id: string;
  network: Network;
  kind: ActivityKind;
  handle: string;
  name: string;
  text: string;
  minutesAgo: number;
  lang?: string | null;
  translation?: string;
  /** Root id this message replies to (same conversation). */
  parent?: string;
  conversation?: { id: string; name?: string | null; type: "group" | "channel" | "direct" };
  streams?: string[];
}

/** Follow-ups in existing conversations, and new conversations in many languages. */
const EXTRAS: Extra[] = [
  // Follow-ups (threads).
  { id: "i_f01", network: "x", kind: "dm", handle: "wholesale_jo", name: "Jo Ramirez", text: "Also: do you do oat milk for wholesale accounts? We'd need about 40 cartons a week.", minutesAgo: 22, parent: "a05" },
  { id: "i_f02", network: "whatsapp", kind: "dm", handle: "5215512345678", name: "Lucía Fernández", text: "Y si pido 6 bolsas, ¿el envío sale más barato?", minutesAgo: 9, lang: "es", translation: "And if I order 6 bags, is shipping cheaper?", parent: "c03", conversation: { id: "5215512345678", name: "Lucía Fernández", type: "direct" } },
  { id: "i_f03", network: "x", kind: "reply", handle: "m_torres", name: "M. Torres", text: "Still happening. iOS 18, app version 4.2.1.", minutesAgo: 95, parent: "a10" },
  { id: "i_f04", network: "wechat", kind: "dm", handle: "oX7a2Fq9kLm3nP0rS5tU8vW1yZ4b", name: "王伟", text: "另外，可以开发票吗？", minutesAgo: 14, lang: "zh", translation: "Also, can you issue an invoice?", parent: "c04", conversation: { id: "oX7a2Fq9kLm3nP0rS5tU8vW1yZ4b", type: "direct" } },
  // New conversations.
  { id: "i_n01", network: "facebook", kind: "comment", handle: "jana.mueller", name: "Jana Müller", text: "Liefert ihr auch nach Berlin? Eure Guji-Bohnen sind unglaublich.", minutesAgo: 6, lang: "de", translation: "Do you deliver to Berlin too? Your Guji beans are incredible.", streams: ["st_brand"] },
  { id: "i_n02", network: "x", kind: "mention", handle: "claire_cafe", name: "Claire Dubois", text: "@northwindcoffee est-ce que vous avez une version décaféinée du blend d'hiver ?", minutesAgo: 18, lang: "fr", translation: "@northwindcoffee do you have a decaf version of the winter blend?", streams: ["st_brand"] },
  { id: "i_n03", network: "whatsapp", kind: "dm", handle: "5511987654321", name: "Rafael Souza", text: "Oi! Vocês têm assinatura mensal de café? Moro em São Paulo.", minutesAgo: 33, lang: "pt", translation: "Hi! Do you have a monthly coffee subscription? I live in São Paulo.", conversation: { id: "5511987654321", name: "Rafael Souza", type: "direct" } },
  { id: "i_n04", network: "line", kind: "message", handle: "Uc3d4e5f60718293a4b5c6d7e8f9a0b12", name: "ゆい", text: "渋谷店のWi-Fiのパスワードを教えてください。", minutesAgo: 41, lang: "ja", translation: "Could you tell me the Wi-Fi password at the Shibuya shop?", conversation: { id: "C8f3a1b2c4d5e6f708192a3b4c5d6e7f8", name: "Acme Fans Tokyo", type: "group" }, streams: ["st_jp"] },
  { id: "i_n05", network: "bluesky", kind: "mention", handle: "minji.bsky.social", name: "민지", text: "@northwind.coffee 한국으로 배송 가능한가요? 콜드브루 원두 사고 싶어요", minutesAgo: 52, lang: "ko", translation: "@northwind.coffee can you ship to Korea? I want to buy the cold brew beans", streams: ["st_brand"] },
  { id: "i_n06", network: "x", kind: "dm", handle: "cryptoqueen_77", name: "Crypto Queen", text: "Earn 500% in 3 days 🚀 DM me for free crypto signals", minutesAgo: 64 },
  { id: "i_n07", network: "facebook", kind: "comment", handle: "tom.ellis", name: "Tom Ellis", text: "Charged twice for my subscription this month. Order #88213. Please refund one.", minutesAgo: 71, streams: ["st_brand"] },
  { id: "i_n08", network: "discord", kind: "message", handle: "latte_lab", name: "Latte Lab", text: "is the cupping event on saturday still on? can't find the link", minutesAgo: 88, conversation: { id: "1029384756102938475", name: "#general", type: "channel" }, streams: ["st_brand"] },
  { id: "i_n09", network: "youtube", kind: "comment", handle: "baristaprime", name: "Barista Prime", text: "Can you do a video on dialing in the Guji for espresso? 18g in, how many out?", minutesAgo: 130, streams: ["st_brand"] },
  { id: "i_n10", network: "mastodon", kind: "mention", handle: "lea@chaos.social", name: "Lea", text: "@northwind@mastodon.social Gibt es eure Preise für Rohkaffee auch auf Deutsch?", minutesAgo: 180, lang: "de", translation: "@northwind@mastodon.social Are your green coffee prices available in German too?" },
  { id: "i_n11", network: "tiktok", kind: "comment", handle: "sip.with.ari", name: "Ari", text: "where's this cafe?? need it", minutesAgo: 210, streams: ["st_brand"] },
  { id: "i_n12", network: "whatsapp", kind: "dm", handle: "34612345678", name: "Marta Gil", text: "¿Tenéis tarjetas regalo? Es para el cumpleaños de mi padre.", minutesAgo: 260, lang: "es", translation: "Do you have gift cards? It's for my dad's birthday.", conversation: { id: "34612345678", name: "Marta Gil", type: "direct" } },
  { id: "i_n13", network: "x", kind: "mention", handle: "ahmed_r", name: "Ahmed", text: "@northwindcoffee هل لديكم فرع في دبي؟", minutesAgo: 300, lang: "ar", translation: "@northwindcoffee do you have a branch in Dubai?" },
  { id: "i_n14", network: "bluesky", kind: "reply", handle: "priya.k", name: "Priya K.", text: "the pearl location had no oat milk again this morning", minutesAgo: 340, streams: ["st_brand"] },
];

interface FxItem extends InboxItemState {
  id: string;
}

export function createInboxFixtures(deps: InboxFixtureDeps) {
  const now = Date.now();
  const accountFor = (network: Network) => deps.accounts().find((a) => a.network === network)?.id ?? null;

  // The extra messages join the feed too: the plain feed and the inbox show the same world.
  const extras: Activity[] = EXTRAS.map((e) => ({
    id: e.id,
    workspaceId: "ws_northwind",
    socialAccountId: accountFor(e.network),
    network: e.network,
    kind: e.kind,
    externalId: e.id,
    authorHandle: e.handle,
    authorName: e.name,
    text: e.text,
    url: null,
    parentExternalId: e.parent ?? null,
    occurredAt: new Date(now - e.minutesAgo * MIN).toISOString(),
    ingestedAt: new Date(now - e.minutesAgo * MIN + 30_000).toISOString(),
    sentiment: null,
    matchedStreams: e.streams ?? [],
    rawEventId: null,
    lang: e.lang === undefined ? "en" : e.lang,
    conversationId: e.conversation?.id ?? null,
    conversationName: e.conversation?.name ?? null,
    conversationType: e.conversation?.type ?? null,
    translation: e.translation ?? null,
    translationLang: e.translation ? "en" : null,
    translatedAt: e.translation ? new Date(now - e.minutesAgo * MIN + 60_000).toISOString() : null,
  }));
  {
    const feed = deps.feed();
    const have = new Set(feed.map((a) => a.id));
    for (const x of extras) if (!have.has(x.id)) feed.push(x);
  }

  const settings: InboxSettings = {
    sla: { urgent: 15, high: 60, normal: 240 },
    businessHours: { enabled: true, days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" },
    tags: [
      { name: "wholesale", color: "green" },
      { name: "shipping", color: "blue" },
      { name: "billing", color: "amber" },
      { name: "bug", color: "red" },
      { name: "japan", color: "violet" },
      { name: "press", color: "gray" },
    ],
    timezone: "America/Los_Angeles",
  };

  /** Seeded state per conversation root: [status, assignee, priority, tags, extra]. */
  const SEED: Record<string, Partial<InboxItemState> & { answeredMinutesAgo?: number }> = {
    a05: { assignee: "usr_sam", priority: "high", tags: ["wholesale"] },
    c03: { assignee: "usr_maya", priority: "high", tags: ["shipping"] },
    a10: { assignee: "usr_maya", priority: "urgent", tags: ["bug"] },
    c04: { priority: "high", tags: ["shipping", "billing"] },
    i_n07: { assignee: "usr_dev", priority: "urgent", tags: ["billing"] },
    a02: { assignee: "usr_maya" },
    a13: { assignee: "usr_sam", status: "pending", answeredMinutesAgo: 20 },
    a08: { status: "pending", assignee: "usr_maya", tags: ["shipping"], answeredMinutesAgo: 70 },
    c02: { tags: ["japan"] },
    i_n04: { tags: ["japan"] },
    c01: { status: "done", tags: ["japan"], answeredMinutesAgo: 5 },
    a03: { status: "done" },
    a11: { status: "done" },
    a15: { status: "done" },
    a09: { status: "done", assignee: "usr_sam", answeredMinutesAgo: 120 },
    i_n06: { status: "spam" },
    a07: { status: "spam" },
    i_n11: { snoozedUntil: new Date(now + 3 * HOUR).toISOString() },
    i_n14: { assignee: "usr_dev", tags: ["bug"] },
  };

  const items = new Map<string, FxItem>();
  /** Message id → its conversation's root id. */
  const threadOf = new Map<string, string>();
  const notes: InboxNote[] = [];
  const replies = new Map<string, InboxReply[]>();
  let seq = 0;

  const due = (start: string, priority: InboxPriority) => new Date(Date.parse(start) + settings.sla[priority] * MIN).toISOString();

  function eligible(a: Activity): boolean {
    return !NOT_INBOX.has(a.kind) && !!a.socialAccountId;
  }

  function rootOf(a: Activity, all: Map<string, Activity>): string {
    if (a.parentExternalId) {
      const parent = [...all.values()].find((x) => x.externalId === a.parentExternalId && x.network === a.network);
      if (parent && threadOf.has(parent.id)) return threadOf.get(parent.id)!;
    }
    if (a.conversationType === "direct" && a.conversationId) {
      const prev = [...all.values()].filter((x) => x.id !== a.id && x.conversationId === a.conversationId && x.network === a.network && threadOf.has(x.id)).sort((x, y) => Date.parse(y.occurredAt) - Date.parse(x.occurredAt))[0];
      if (prev) return threadOf.get(prev.id)!;
    }
    return a.id;
  }

  /** Bring the state up to date with the feed (live items arrive there). */
  function sync() {
    const all = new Map(deps.feed().map((a) => [a.id, a]));
    const fresh = [...all.values()].filter((a) => eligible(a) && !threadOf.has(a.id)).sort((x, y) => Date.parse(x.occurredAt) - Date.parse(y.occurredAt));
    for (const a of fresh) {
      const root = rootOf(a, all);
      threadOf.set(a.id, root);
      if (root !== a.id) {
        const it = items.get(root);
        if (it) {
          it.messageCount += 1;
          if (Date.parse(a.occurredAt) > Date.parse(it.lastActivityAt)) it.lastActivityAt = a.occurredAt;
        }
        continue;
      }
      // Older conversations nobody seeded were handled before today.
      const old = !SEED[a.id] && now - Date.parse(a.occurredAt) > 10 * HOUR && !a.id.startsWith("live_");
      const s = SEED[a.id] ?? (old ? { status: "done" as const, answeredMinutesAgo: Math.round((now - Date.parse(a.occurredAt)) / MIN) - 30 } : {});
      const priority = s.priority ?? "normal";
      const status: InboxStatus = s.status ?? "open";
      const answered = s.answeredMinutesAgo !== undefined ? new Date(now - s.answeredMinutesAgo * MIN).toISOString() : null;
      items.set(a.id, {
        id: a.id,
        status,
        assignee: s.assignee ?? null,
        priority,
        tags: s.tags ?? [],
        firstResponseAt: answered,
        doneAt: status === "done" ? (answered ?? a.occurredAt) : null,
        snoozedUntil: s.snoozedUntil ?? null,
        slaDueAt: due(a.occurredAt, priority),
        lastActivityAt: a.occurredAt,
        messageCount: 1,
        createdAt: a.ingestedAt,
        updatedAt: a.ingestedAt,
      });
      if (answered) {
        replies.set(a.id, [
          {
            postId: `p_seed_reply_${a.id}`,
            status: "published",
            text: a.lang && a.lang !== "en" ? "Thanks for writing. We're on it and will follow up here." : "Thanks for the note. We're on it and will follow up here.",
            replyTo: a.externalId,
            network: a.network,
            createdAt: answered,
            createdBy: { type: "human", id: s.assignee ?? "usr_maya" },
            publishedAt: answered,
          },
        ]);
      }
    }
  }
  sync();

  // Notes, saved replies and rules.
  const noteAt = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();
  notes.push(
    { id: "note_1", workspaceId: "ws_northwind", threadId: "a05", author: { type: "human", id: "usr_maya" }, text: "@sam this is the café group from Portland we met at the expo. Quote them the 3-café tier.", mentions: ["usr_sam"], createdAt: noteAt(25), editedAt: null },
    { id: "note_2", workspaceId: "ws_northwind", threadId: "a10", author: { type: "mcp", id: "claude" }, text: "Three other people reported the same logout on iOS 18 this week (see the Bluesky reply from oat.enjoyer).", mentions: [], createdAt: noteAt(80), editedAt: null },
    { id: "note_3", workspaceId: "ws_northwind", threadId: "i_n07", author: { type: "human", id: "usr_sam" }, text: "@dev can you refund in Stripe? I checked: two charges on the 3rd.", mentions: ["usr_dev"], createdAt: noteAt(40), editedAt: null },
  );
  const savedReplies: SavedReply[] = [
    sr("srep_ship_en", "Shipping: where we ship", "Hi {{author_name}}, we ship beans to the US, Canada, Mexico, the EU and Japan. Orders over $40 ship free. — {{brand}}", "en"),
    sr("srep_ship_es", "Envíos (es)", "Hola {{author_name}}, sí enviamos a México y España. Los pedidos de más de 40 USD van sin costo de envío. — {{brand}}", "es"),
    sr("srep_ship_ja", "配送 (ja)", "{{author_name}}さん、お問い合わせありがとうございます。日本への配送も承っております。— {{brand}}", "ja"),
    sr("srep_wholesale", "Wholesale: intro", "Thanks {{author_name}}. Our wholesale lead will email you a price sheet today. What's the best address for {{author_handle}}?", "en"),
    sr("srep_bug", "App: we're looking into it", "Sorry about that, {{author_name}}. We're looking into it now and will update you here.", null),
  ];
  function sr(id: string, name: string, text: string, lang: string | null): SavedReply {
    return { id, workspaceId: "ws_northwind", name, text, lang, createdBy: { type: "human", id: "usr_maya" }, createdAt: noteAt(60 * 24 * 10), updatedAt: noteAt(60 * 24 * 10) };
  }
  const emptyConditions = { streams: [], entities: [], networks: [], kinds: [], languages: [], keywords: [] };
  const rules: InboxRule[] = [
    rule("rule_1", 0, "Wholesale to Sam", { keywords: ["wholesale", "café group", "cafés"] }, { assignee: "usr_sam", tags: ["wholesale"], priority: "high" }),
    rule("rule_2", 1, "Japanese messages", { languages: ["ja"] }, { tags: ["japan"] }),
    rule("rule_3", 2, "Refunds and charges", { keywords: ["refund", "charged", "invoice"] }, { roundRobin: ["usr_dev", "usr_maya"], tags: ["billing"], priority: "urgent" }),
    rule("rule_4", 3, "Crypto spam", { keywords: ["free crypto", "crypto signals"] }, { spam: true }),
  ];
  function rule(id: string, position: number, name: string, c: Partial<InboxRule["conditions"]>, actions: InboxRule["actions"]): InboxRule {
    return { id, workspaceId: "ws_northwind", name, position, enabled: true, conditions: { ...emptyConditions, ...c }, actions, rrCursor: 0, createdBy: { type: "human", id: "usr_maya" }, createdAt: noteAt(60 * 24 * 20), updatedAt: noteAt(60 * 24 * 20) };
  }

  // ------------------------------------------------------------ helpers

  const byId = () => new Map(deps.feed().map((a) => [a.id, a]));
  function requireWorker() {
    if (!WORKERS.includes(deps.me().role)) throw new ApiError(403, "forbidden", "viewers can read the inbox but not change it");
  }
  function requireManager() {
    if (!MANAGERS.includes(deps.me().role)) throw new ApiError(403, "forbidden", "inbox labels, rules and response targets need an owner or approver");
  }
  function root(id: string): FxItem {
    sync();
    const r = threadOf.get(id);
    const it = r ? items.get(r) : undefined;
    if (!it) throw new ApiError(404, "not_found", `inbox item ${id}`);
    return it;
  }
  function slaOf(s: FxItem): InboxEntry["sla"] {
    const targetMinutes = settings.sla[s.priority];
    if (!s.slaDueAt || s.status === "spam") return { dueAt: s.slaDueAt, state: "none", msLeft: null, targetMinutes };
    if (s.firstResponseAt) return { dueAt: s.slaDueAt, state: Date.parse(s.firstResponseAt) <= Date.parse(s.slaDueAt) ? "met" : "missed", msLeft: null, targetMinutes };
    if (s.status === "done") return { dueAt: s.slaDueAt, state: "none", msLeft: null, targetMinutes };
    const msLeft = Date.parse(s.slaDueAt) - Date.now();
    return { dueAt: s.slaDueAt, state: msLeft < 0 ? "overdue" : msLeft <= Math.min(targetMinutes * MIN * 0.25, HOUR) ? "soon" : "ok", msLeft, targetMinutes };
  }
  function entryOf(s: FxItem, all = byId()): InboxEntry {
    const activity = all.get(s.id)!;
    const msgs = [...threadOf.entries()].filter(([, r]) => r === s.id && all.has(r)).map(([m]) => all.get(m)!).filter((a) => a.id !== s.id);
    const latest = msgs.sort((x, y) => Date.parse(y.occurredAt) - Date.parse(x.occurredAt))[0] ?? null;
    const { id: _id, ...state } = s;
    return { activity, latest, state, sla: slaOf(s), notes: notes.filter((n) => n.threadId === s.id).length };
  }
  const snoozed = (s: FxItem) => !!s.snoozedUntil && Date.parse(s.snoozedUntil) > Date.now();
  async function tagNames(wanted: string[]): Promise<string[]> {
    const map = new Map(settings.tags.map((t) => [t.name.toLowerCase(), t.name]));
    return wanted.map((w) => {
      const n = map.get(w.trim().toLowerCase());
      if (!n) throw new ApiError(400, "invalid", `"${w}" is not one of this workspace's labels; an owner or approver adds labels in inbox settings`);
      return n;
    });
  }
  function apply(s: FxItem, p: InboxPatch, tags: { set?: string[]; add?: string[]; remove?: string[] }) {
    const t = new Date().toISOString();
    if (p.status && p.status !== s.status) {
      s.status = p.status;
      s.doneAt = p.status === "done" ? t : null;
      if (p.status === "done" || p.status === "spam") s.snoozedUntil = null;
    }
    if (p.assignee !== undefined) s.assignee = p.assignee === "me" ? deps.me().userId : p.assignee;
    if (p.priority && p.priority !== s.priority) {
      s.priority = p.priority;
      s.slaDueAt = due(byId().get(s.id)!.occurredAt, p.priority);
    }
    if (tags.set) s.tags = tags.set;
    if (tags.add) s.tags = [...s.tags, ...tags.add.filter((x) => !s.tags.includes(x))];
    if (tags.remove) s.tags = s.tags.filter((x) => !tags.remove!.map((r) => r.toLowerCase()).includes(x.toLowerCase()));
    if (p.snoozedUntil !== undefined && p.status !== "done" && p.status !== "spam") s.snoozedUntil = p.snoozedUntil;
    s.updatedAt = t;
  }
  async function prepare(p: InboxPatch) {
    requireWorker();
    if (p.assignee && p.assignee !== "me") {
      const m = deps.members().find((x) => x.userId === p.assignee);
      if (!m) throw new ApiError(400, "invalid", `${p.assignee} is not a member of this workspace`);
      if (m.role === "viewer") throw new ApiError(400, "invalid", `${m.name} is a viewer and cannot work the inbox`);
    }
    if (p.snoozedUntil && Date.parse(p.snoozedUntil) <= Date.now()) throw new ApiError(400, "invalid", "snooze until a time in the future");
    return { set: p.tags ? await tagNames(p.tags) : undefined, add: p.addTags ? await tagNames(p.addTags) : undefined, remove: p.removeTags };
  }
  function savedReplyById(id: string): SavedReply {
    const r = savedReplies.find((x) => x.id === id);
    if (!r) throw new ApiError(404, "not_found", `saved reply ${id}`);
    return r;
  }

  // ------------------------------------------------------------ the API

  return {
    list: async (q: InboxQuery = {}): Promise<InboxList> => {
      sync();
      const me = deps.me();
      const all = byId();
      const text = q.q?.trim().toLowerCase();
      const base = [...items.values()].filter((s) => {
        const a = all.get(s.id);
        if (!a) return false;
        if (q.tag && !s.tags.includes(q.tag)) return false;
        if (q.priority?.length && !q.priority.includes(s.priority)) return false;
        if (q.network?.length && !q.network.includes(a.network)) return false;
        if (text) {
          const thread = [...threadOf.entries()].filter(([, r]) => r === s.id).map(([m]) => all.get(m)).filter((x): x is Activity => !!x);
          if (!thread.some((x) => `${x.text ?? ""}\n${x.translation ?? ""}\n${x.authorName ?? ""}\n${x.authorHandle ?? ""}`.toLowerCase().includes(text))) return false;
        }
        return true;
      });
      const counts: InboxCounts = { open: 0, pending: 0, done: 0, spam: 0, mine: 0, unassigned: 0, snoozed: 0 };
      for (const s of base) {
        const active = s.status === "open" || s.status === "pending";
        if (active && snoozed(s)) {
          counts.snoozed++;
          continue;
        }
        counts[s.status]++;
        if (active && s.assignee === me.userId) counts.mine++;
        if (s.status === "open" && !s.assignee) counts.unassigned++;
      }
      let rows = base.filter((s) => (q.snoozed ? snoozed(s) : !snoozed(s)));
      if (q.status?.length) rows = rows.filter((s) => q.status!.includes(s.status));
      if (q.assignee === "me") rows = rows.filter((s) => s.assignee === me.userId);
      else if (q.assignee === "none") rows = rows.filter((s) => !s.assignee);
      else if (q.assignee && q.assignee !== "any") rows = rows.filter((s) => s.assignee === q.assignee);
      const waitingDue = (s: FxItem) => (!s.firstResponseAt && (s.status === "open" || s.status === "pending") && s.slaDueAt ? Date.parse(s.slaDueAt) : Infinity);
      const rank: Record<InboxPriority, number> = { urgent: 0, high: 1, normal: 2 };
      const newest = (x: FxItem, y: FxItem) => Date.parse(y.lastActivityAt) - Date.parse(x.lastActivityAt);
      rows.sort(
        q.sort === "oldest"
          ? (x, y) => -newest(x, y)
          : q.sort === "due"
            ? (x, y) => waitingDue(x) - waitingDue(y) || newest(x, y)
            : q.sort === "priority"
              ? (x, y) => rank[x.priority] - rank[y.priority] || waitingDue(x) - waitingDue(y) || newest(x, y)
              : newest,
      );
      const role = me.role;
      return delay({
        items: rows.slice(0, q.limit ?? 50).map((s) => entryOf(s, all)),
        counts,
        viewer: { userId: me.userId, canWork: WORKERS.includes(role), canAssign: WORKERS.includes(role), canManage: MANAGERS.includes(role) },
      });
    },

    conversation: async (id: string): Promise<InboxConversation> => {
      const s = root(id);
      const all = byId();
      const messages = [...threadOf.entries()]
        .filter(([, r]) => r === s.id)
        .map(([m]) => all.get(m))
        .filter((x): x is Activity => !!x)
        .sort((x, y) => Date.parse(x.occurredAt) - Date.parse(y.occurredAt));
      return delay({ item: entryOf(s, all), messages, parent: null, replies: replies.get(s.id) ?? [], notes: notes.filter((n) => n.threadId === s.id) });
    },

    patch: async (id: string, p: InboxPatch): Promise<InboxEntry> => {
      const tags = await prepare(p);
      const s = root(id);
      apply(s, p, tags);
      return delay(entryOf(s), 160);
    },

    bulk: async (ids: string[], p: InboxPatch): Promise<{ updated: number; items: InboxEntry[] }> => {
      const tags = await prepare(p);
      const roots = [...new Set(ids.map((id) => root(id)))];
      for (const s of roots) apply(s, p, tags);
      return delay({ updated: roots.length, items: roots.map((s) => entryOf(s)) }, 220);
    },

    addNote: async (id: string, text: string, mentions: string[] = []): Promise<InboxNote> => {
      requireWorker();
      const s = root(id);
      if (!text.trim()) throw new ApiError(400, "invalid", "write the note first");
      const team = deps.members();
      const ids = [...new Set([...parseMentions(text, team), ...mentions.filter((m) => team.some((t) => t.userId === m))])];
      const note: InboxNote = { id: `note_new_${++seq}`, workspaceId: "ws_northwind", threadId: s.id, author: { type: "human", id: deps.me().userId } as Actor, text: text.trim(), mentions: ids, createdAt: new Date().toISOString(), editedAt: null };
      notes.push(note);
      return delay(note, 160);
    },
    updateNote: async (noteId: string, text: string): Promise<InboxNote> => {
      requireWorker();
      const n = notes.find((x) => x.id === noteId);
      if (!n) throw new ApiError(404, "not_found", `note ${noteId}`);
      if (n.author.id !== deps.me().userId) throw new ApiError(403, "forbidden", "only the person who wrote a note can edit it");
      n.text = text.trim();
      n.mentions = parseMentions(text, deps.members());
      n.editedAt = new Date().toISOString();
      return delay(n);
    },
    deleteNote: async (noteId: string): Promise<void> => {
      requireWorker();
      const i = notes.findIndex((x) => x.id === noteId);
      if (i < 0) throw new ApiError(404, "not_found", `note ${noteId}`);
      if (notes[i]!.author.id !== deps.me().userId && deps.me().role !== "owner") throw new ApiError(403, "forbidden", "a note is removed by the person who wrote it, or an owner");
      notes.splice(i, 1);
      await delay(null);
    },

    savedReplies: () => delay([...savedReplies].sort((a, b) => a.name.localeCompare(b.name))),
    createSavedReply: async (input: SavedReplyInput): Promise<SavedReply> => {
      requireWorker();
      if (!input.name.trim() || !input.text.trim()) throw new ApiError(400, "invalid", "a saved reply needs a name and text");
      const r = sr(`srep_new_${++seq}`, input.name.trim(), input.text.trim(), input.lang ?? null);
      r.createdBy = { type: "human", id: deps.me().userId };
      savedReplies.push(r);
      return delay(r, 160);
    },
    updateSavedReply: async (id: string, input: Partial<SavedReplyInput>): Promise<SavedReply> => {
      requireWorker();
      const r = savedReplyById(id);
      if (input.name !== undefined) r.name = input.name.trim();
      if (input.text !== undefined) r.text = input.text.trim();
      if (input.lang !== undefined) r.lang = input.lang ?? null;
      r.updatedAt = new Date().toISOString();
      return delay(r);
    },
    deleteSavedReply: async (id: string): Promise<void> => {
      requireWorker();
      savedReplyById(id);
      savedReplies.splice(savedReplies.findIndex((x) => x.id === id), 1);
      await delay(null);
    },
    fillSavedReply: async (id: string, activityId: string): Promise<{ text: string; lang: string | null }> => {
      const r = savedReplyById(id);
      const s = root(activityId);
      const a = byId().get(s.id)!;
      return delay({ text: fillSavedReply(r.text, replyVariables(a, deps.workspaceName())), lang: r.lang }, 80);
    },

    rules: () => delay([...rules].sort((a, b) => a.position - b.position)),
    createRule: async (input: InboxRuleInput): Promise<InboxRule> => {
      requireManager();
      const a = input.actions;
      if (!a.assignee && !a.roundRobin?.length && !a.tags?.length && !a.priority && !a.spam) throw new ApiError(400, "invalid", "a rule needs something to do: assign, rotate, label, set priority or mark spam");
      if (a.tags?.length) a.tags = await tagNames(a.tags);
      const r = rule(`rule_new_${++seq}`, rules.length, input.name.trim(), input.conditions ?? {}, a);
      r.enabled = input.enabled ?? true;
      rules.push(r);
      return delay(r, 160);
    },
    updateRule: async (id: string, input: Partial<InboxRuleInput>): Promise<InboxRule> => {
      requireManager();
      const r = rules.find((x) => x.id === id);
      if (!r) throw new ApiError(404, "not_found", `rule ${id}`);
      if (input.name !== undefined) r.name = input.name;
      if (input.enabled !== undefined) r.enabled = input.enabled;
      if (input.conditions) r.conditions = { ...emptyConditions, ...input.conditions };
      if (input.actions) r.actions = input.actions;
      r.updatedAt = new Date().toISOString();
      return delay(r);
    },
    deleteRule: async (id: string): Promise<void> => {
      requireManager();
      const i = rules.findIndex((x) => x.id === id);
      if (i < 0) throw new ApiError(404, "not_found", `rule ${id}`);
      rules.splice(i, 1);
      rules.forEach((r, n) => (r.position = n));
      await delay(null);
    },
    reorderRules: async (ids: string[]): Promise<InboxRule[]> => {
      requireManager();
      const order = [...ids.filter((id) => rules.some((r) => r.id === id)), ...rules.map((r) => r.id).filter((id) => !ids.includes(id))];
      for (const r of rules) r.position = order.indexOf(r.id);
      return delay([...rules].sort((a, b) => a.position - b.position));
    },

    settings: () => delay(settings),
    updateSettings: async (p: InboxSettingsPatch): Promise<InboxSettings> => {
      requireManager();
      const bh = { ...settings.businessHours, ...(p.businessHours ?? {}) };
      if (bh.end <= bh.start) throw new ApiError(400, "invalid", "business hours must end after they start, on the same day");
      if (p.tags) {
        const names = p.tags.map((t) => t.name.trim().toLowerCase());
        if (new Set(names).size !== names.length) throw new ApiError(400, "invalid", "a label is listed twice");
        const removed = settings.tags.filter((t) => !names.includes(t.name.toLowerCase())).map((t) => t.name);
        for (const s of items.values()) s.tags = s.tags.filter((t) => !removed.includes(t));
        settings.tags = p.tags.map((t) => ({ name: t.name.trim(), color: t.color }));
      }
      settings.sla = { ...settings.sla, ...(p.sla ?? {}) };
      settings.businessHours = bh;
      if (p.sla) for (const s of items.values()) if (!s.firstResponseAt) s.slaDueAt = due(byId().get(s.id)?.occurredAt ?? s.createdAt, s.priority);
      return delay(settings, 180);
    },

    /** The feed fixture's reply went out: in the inbox it is a response (and open becomes pending). */
    recordReply: (activityId: string, detail: PostDetail) => {
      const s = (() => {
        try {
          return root(activityId);
        } catch {
          return null;
        }
      })();
      if (!s) return;
      const a = byId().get(activityId);
      const list = replies.get(s.id) ?? [];
      list.push({ postId: detail.post.id, status: detail.post.status, text: detail.post.body, replyTo: a?.externalId ?? null, network: a?.network ?? "", createdAt: detail.post.createdAt, createdBy: { type: "human", id: deps.me().userId }, publishedAt: null });
      replies.set(s.id, list);
      if (["scheduled", "approved", "publishing", "published", "partially_published"].includes(detail.post.status)) {
        s.firstResponseAt ??= new Date().toISOString();
        if (s.status === "open") s.status = "pending";
      }
    },
  };
}
