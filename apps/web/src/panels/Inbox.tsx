// ---- inbox workflow: the live feed worked as a shared inbox.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Account, FeedEvent, InboxEntry, InboxList, InboxPatch, InboxPriority, InboxSettings, InboxSort, InboxStatus, LanguagesInfo, LiveStatus, Member, Network } from "../types";
import { api, errorText, USE_FIXTURES } from "../api";
import { Menu } from "../components/Menu";
import { NetworkBadge } from "../components/NetworkBadge";
import { PanelState } from "../components/PanelState";
import { RelativeTime } from "../components/RelativeTime";
import { useToast } from "../components/Toast";
import { ConversationDrawer, type DrawerFocus } from "../drawers/ConversationDrawer";
import { InboxSettingsDrawer } from "../drawers/InboxSettingsDrawer";
import { authorHandleText, kindLabel, networkLabel, plural } from "../lib/format";
import {
  INBOX_TABS,
  PRIORITIES,
  PRIORITY_LABEL,
  SHORTCUTS,
  STATUS_LABEL,
  initialsOf,
  isTyping,
  latestOf,
  memberName,
  slaBadge,
  snoozeOptions,
  tabQuery,
  type InboxTabId,
} from "../lib/inbox";
import { languageName, languageTag, sameLanguage } from "../lib/lang";
import { useNow } from "../lib/useNow";
import "./inbox.css";

const TAB_STORAGE = "starsign.inboxTab";
const LIVE_LABEL: Record<LiveStatus, string> = { live: "Live", connecting: "Reconnecting…", off: "Paused" };

function readTab(): InboxTabId {
  try {
    const v = localStorage.getItem(TAB_STORAGE);
    return INBOX_TABS.some((t) => t.id === v) || v === "snoozed" ? (v as InboxTabId) : "open";
  } catch {
    return "open";
  }
}

type Quick = { kind: "label" | "snooze" | "assign"; ids: string[] } | null;

/**
 * The inbox: tabs with counts, filters, one row per conversation with its status, owner, priority, labels and
 * first-response target, bulk actions, keyboard shortcuts, and a drawer for the whole conversation.
 */
export function Inbox({
  accounts,
  liveTick,
  liveStatus,
  inboxTick,
  inboxEvent,
  languages,
  modeSwitch,
}: {
  accounts: Account[];
  liveTick: number;
  liveStatus: LiveStatus;
  inboxTick: number;
  inboxEvent: FeedEvent | null;
  languages: LanguagesInfo | null;
  modeSwitch: ReactNode;
}) {
  const toast = useToast();
  const now = useNow(30_000);
  const [tab, setTab] = useState<InboxTabId>(readTab);
  const [q, setQ] = useState("");
  const [qLive, setQLive] = useState("");
  const [priority, setPriority] = useState<InboxPriority | "">("");
  const [tag, setTag] = useState("");
  const [network, setNetwork] = useState<Network | "">("");
  const [sort, setSort] = useState<InboxSort | "">("");
  const [data, setData] = useState<InboxList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [settings, setSettings] = useState<InboxSettings | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState<{ id: string; focus: DrawerFocus } | null>(null);
  const [help, setHelp] = useState(false);
  const [quick, setQuick] = useState<Quick>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const section = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const rows = useRef(new Map<string, HTMLElement>());

  const home = languages?.settings.home ?? "en";
  const networks = useMemo(() => Array.from(new Set(accounts.map((a) => a.network))), [accounts]);
  const items = data?.items ?? [];
  const viewer = data?.viewer ?? null;
  const canWork = viewer?.canWork ?? true;
  const canAssign = viewer?.canAssign ?? true;
  const me = viewer?.userId ?? null;
  const workers = useMemo(() => members.filter((m) => m.role !== "viewer"), [members]);
  const tagColor = useMemo(() => new Map((settings?.tags ?? []).map((t) => [t.name, t.color])), [settings]);

  // Debounce the search box.
  useEffect(() => {
    const t = window.setTimeout(() => setQ(qLive.trim()), 250);
    return () => window.clearTimeout(t);
  }, [qLive]);

  const query = useMemo(() => {
    const base = tabQuery(tab);
    return { ...base, ...(sort ? { sort } : {}), q: q || undefined, priority: priority ? [priority] : undefined, tag: tag || undefined, network: network ? [network] : undefined, limit: 100 };
  }, [tab, q, priority, tag, network, sort]);

  const gen = useRef(0);
  const load = useCallback(
    async (quiet = false) => {
      const g = ++gen.current;
      if (!quiet) setLoading(true);
      setError(null);
      try {
        const r = await api.inbox(query);
        if (g !== gen.current) return;
        setData(r);
        setSelected((s) => new Set([...s].filter((id) => r.items.some((i) => i.activity.id === id))));
      } catch (e) {
        if (g !== gen.current) return;
        setError(errorText(e));
      } finally {
        if (g === gen.current) setLoading(false);
      }
    },
    [query],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const loadSettings = useCallback(() => {
    api.inboxSettings().then(setSettings, () => undefined);
  }, []);
  useEffect(() => {
    loadSettings();
    api.members().then(setMembers, () => setMembers([]));
  }, [loadSettings]);

  // Live: new messages and teammates' changes refresh the queue quietly.
  const ticks = `${liveTick}:${inboxTick}`;
  const seen = useRef(ticks);
  useEffect(() => {
    if (ticks === seen.current) return;
    seen.current = ticks;
    const t = window.setTimeout(() => void load(true), 400);
    return () => window.clearTimeout(t);
  }, [ticks, load]);
  useEffect(() => {
    if (liveStatus === "live") return;
    const id = window.setInterval(() => void load(true), 60_000);
    return () => window.clearInterval(id);
  }, [liveStatus, load]);
  // Someone mentioned me, or gave me a conversation.
  const lastEvent = useRef<FeedEvent | null>(null);
  useEffect(() => {
    if (!inboxEvent || inboxEvent === lastEvent.current || inboxEvent.type !== "inbox") return;
    lastEvent.current = inboxEvent;
    const e = inboxEvent.data;
    if (!me || !e.userIds?.includes(me)) return;
    if (e.kind === "mention") toast("You were mentioned in a note.");
    if (e.kind === "assigned") toast("A conversation was assigned to you.");
  }, [inboxEvent, me, toast]);

  const changeTab = (t: InboxTabId) => {
    setTab(t);
    setCursor(0);
    setSelected(new Set());
    try {
      localStorage.setItem(TAB_STORAGE, t);
    } catch {
      // fine
    }
  };

  const current = items[Math.min(cursor, Math.max(0, items.length - 1))] ?? null;

  useEffect(() => {
    if (cursor > 0 && cursor >= items.length) setCursor(Math.max(0, items.length - 1));
  }, [items.length, cursor]);
  useEffect(() => {
    if (!current) return;
    rows.current.get(current.activity.id)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  // ------------------------------------------------------------ actions

  const patchOne = useCallback(
    async (id: string, p: InboxPatch, done?: string) => {
      try {
        const next = await api.patchInbox(id, p);
        setData((d) => (d ? { ...d, items: d.items.map((i) => (i.activity.id === next.activity.id ? next : i)) } : d));
        if (done) toast(done);
        void load(true);
        return next;
      } catch (e) {
        toast(errorText(e), "bad");
        return null;
      }
    },
    [load, toast],
  );

  const bulk = useCallback(
    async (ids: string[], p: InboxPatch, what: string) => {
      if (!ids.length) return;
      setBusy(true);
      try {
        const r = await api.bulkInbox(ids, p);
        toast(`${what}: ${plural(r.updated, "conversation")}.`);
        setSelected(new Set());
        await load(true);
      } catch (e) {
        toast(errorText(e), "bad");
      } finally {
        setBusy(false);
      }
    },
    [load, toast],
  );

  const targetIds = useCallback((): string[] => (selected.size ? [...selected] : current ? [current.activity.id] : []), [selected, current]);

  const act = useCallback(
    (ids: string[], p: InboxPatch, what: string) => {
      if (ids.length > 1) void bulk(ids, p, what);
      else if (ids[0]) void patchOne(ids[0], p, what);
    },
    [bulk, patchOne],
  );

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // ------------------------------------------------------------ keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (!section.current || section.current.offsetParent === null) return; // the panel is not on screen
      // Another drawer (not ours) is open over the room.
      if (!open && !showSettings && document.querySelector(".drawer-root")) return;
      if (showSettings) return;
      if (help || quick) {
        if (e.key === "Escape") {
          setHelp(false);
          setQuick(null);
        }
        return;
      }
      const k = e.key;
      if (k === "?") {
        e.preventDefault();
        setHelp(true);
        return;
      }
      if (k === "/") {
        e.preventDefault();
        if (open) setOpen(null);
        search.current?.focus();
        return;
      }
      if (k === "j" || k === "ArrowDown") {
        if (k === "ArrowDown" && !open) return;
        e.preventDefault();
        setCursor((c) => {
          const n = Math.min(c + 1, Math.max(0, items.length - 1));
          if (open && items[n]) setOpen({ id: items[n]!.activity.id, focus: null });
          return n;
        });
        return;
      }
      if (k === "k" || k === "ArrowUp") {
        if (k === "ArrowUp" && !open) return;
        e.preventDefault();
        setCursor((c) => {
          const n = Math.max(c - 1, 0);
          if (open && items[n]) setOpen({ id: items[n]!.activity.id, focus: null });
          return n;
        });
        return;
      }
      if (!current) return;
      const id = current.activity.id;
      if (k === "Enter" || k === "o") {
        e.preventDefault();
        setOpen({ id, focus: null });
      } else if (k === "x") {
        e.preventDefault();
        toggle(id);
      } else if (k === "e" && canWork) {
        e.preventDefault();
        act(targetIds(), { status: "done" }, "Marked done");
      } else if (k === "a" && canAssign) {
        e.preventDefault();
        act(targetIds(), { assignee: "me" }, "Assigned to you");
      } else if (k === "r") {
        e.preventDefault();
        setOpen({ id, focus: "reply" });
      } else if (k === "n" && canWork) {
        e.preventDefault();
        setOpen({ id, focus: "note" });
      } else if (k === "#" && canWork) {
        e.preventDefault();
        setQuick({ kind: "label", ids: targetIds() });
      } else if (k === "s" && canAssign) {
        e.preventDefault();
        setQuick({ kind: "snooze", ids: targetIds() });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, current, open, help, quick, showSettings, canWork, canAssign, act, targetIds]);

  // ------------------------------------------------------------ render

  const counts = data?.counts ?? null;
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.activity.id));
  const tabLabel = tab === "snoozed" ? "Snoozed" : (INBOX_TABS.find((t) => t.id === tab)?.label ?? "");

  return (
    <section className="panel panel-feed panel-inbox" aria-labelledby="inbox-title" ref={section}>
      <header className="panel-head ibx-head-bar">
        <h2 id="inbox-title">Inbox</h2>
        {modeSwitch}
        <span className={`live live-${liveStatus}`}>
          <span className="live-dot" aria-hidden="true" />
          {LIVE_LABEL[liveStatus]}
          {USE_FIXTURES ? " · sample" : ""}
        </span>
        <span className="ibx-head-actions">
          <button type="button" className="btn btn-ghost btn-small" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelp(true)}>
            ?
          </button>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => setShowSettings(true)}>
            Inbox settings
          </button>
        </span>
      </header>

      <div className="ibx-tabs" role="tablist" aria-label="Inbox views">
        {INBOX_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className="ibx-tab" onClick={() => changeTab(t.id)}>
            {t.label}
            <span className="ibx-count mono">{counts ? counts[t.key] : "–"}</span>
          </button>
        ))}
        {counts && (counts.snoozed > 0 || tab === "snoozed") ? (
          <button type="button" role="tab" aria-selected={tab === "snoozed"} className="ibx-tab ibx-tab-quiet" onClick={() => changeTab("snoozed")}>
            Snoozed
            <span className="ibx-count mono">{counts.snoozed}</span>
          </button>
        ) : null}
      </div>

      <div className="ibx-filters" role="search">
        <label className="ibx-search">
          <span className="sr-only">Search the inbox</span>
          <input ref={search} className="input input-small" type="search" placeholder="Search messages, people…  ( / )" value={qLive} onChange={(e) => setQLive(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (e.currentTarget.blur(), setQLive(""))} />
        </label>
        <label>
          <span className="sr-only">Priority</span>
          <select className="select select-small" value={priority} onChange={(e) => setPriority(e.target.value as InboxPriority | "")}>
            <option value="">Any priority</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Label</span>
          <select className="select select-small" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">Any label</option>
            {(settings?.tags ?? []).map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {networks.length ? (
          <label>
            <span className="sr-only">Network</span>
            <select className="select select-small" value={network} onChange={(e) => setNetwork(e.target.value as Network | "")}>
              <option value="">Every network</option>
              {networks.map((n) => (
                <option key={n} value={n}>
                  {networkLabel(n)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          <span className="sr-only">Sort</span>
          <select className="select select-small" value={sort} onChange={(e) => setSort(e.target.value as InboxSort | "")}>
            <option value="">{tab === "done" || tab === "spam" || tab === "pending" || tab === "snoozed" ? "Newest first" : "Due soonest"}</option>
            <option value="due">Due soonest</option>
            <option value="priority">Priority</option>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
      </div>

      {canWork && items.length ? (
        <div className={`ibx-bulk${selected.size ? " ibx-bulk-on" : ""}`} role="toolbar" aria-label="Selected conversations">
          <label className="ibx-check">
            <input
              type="checkbox"
              checked={allSelected}
              aria-label={allSelected ? "Select none" : "Select every conversation shown"}
              onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.activity.id)))}
            />
          </label>
          {selected.size ? (
            <>
              <span className="ibx-bulk-n">{selected.size} selected</span>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => void bulk([...selected], { status: "done" }, "Marked done")}>
                Done
              </button>
              <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void bulk([...selected], { status: "pending" }, "Marked pending")}>
                Pending
              </button>
              <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void bulk([...selected], { status: "open" }, "Reopened")}>
                Open
              </button>
              {canAssign ? (
                <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => setQuick({ kind: "assign", ids: [...selected] })}>
                  Assign…
                </button>
              ) : null}
              <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => setQuick({ kind: "label", ids: [...selected] })}>
                Label…
              </button>
              {canAssign ? (
                <Menu label="Priority" buttonClassName="btn btn-small btn-ghost" ariaLabel="Set priority of the selected conversations">
                  {(close) =>
                    PRIORITIES.map((p) => (
                      <button
                        key={p}
                        type="button"
                        role="menuitem"
                        className="menu-item"
                        onClick={() => {
                          close();
                          void bulk([...selected], { priority: p }, `Priority ${PRIORITY_LABEL[p].toLowerCase()}`);
                        }}
                      >
                        {PRIORITY_LABEL[p]}
                      </button>
                    ))
                  }
                </Menu>
              ) : null}
              {canAssign ? (
                <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => setQuick({ kind: "snooze", ids: [...selected] })}>
                  Snooze…
                </button>
              ) : null}
              <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void bulk([...selected], { status: "spam" }, "Marked spam")}>
                Spam
              </button>
              <button type="button" className="btn btn-small btn-ghost" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </>
          ) : (
            <span className="muted small">
              {tabLabel}: {plural(items.length, "conversation")}. Press <kbd>?</kbd> for shortcuts.
            </span>
          )}
        </div>
      ) : null}

      <div className="panel-body ibx-list" role="list" aria-label={`${tabLabel} conversations`}>
        <PanelState
          loading={loading && !data}
          error={error}
          onRetry={() => void load()}
          empty={data && items.length === 0 ? (q || priority || tag || network ? "Nothing matches these filters." : tab === "mine" ? "Nothing assigned to you. Pick something from Unassigned." : tab === "unassigned" ? "Every open conversation has someone on it." : `Nothing ${tabLabel.toLowerCase()}.`) : null}
        />
        {items.map((e, i) => (
          <InboxRow
            key={e.activity.id}
            entry={e}
            now={now}
            home={home}
            members={members}
            workers={workers}
            me={me}
            current={i === cursor}
            selected={selected.has(e.activity.id)}
            canWork={canWork}
            canAssign={canAssign}
            tagColor={tagColor}
            rowRef={(el) => {
              if (el) rows.current.set(e.activity.id, el);
              else rows.current.delete(e.activity.id);
            }}
            onSelect={() => toggle(e.activity.id)}
            onOpen={() => {
              setCursor(i);
              setOpen({ id: e.activity.id, focus: null });
            }}
            onPatch={(p, what) => void patchOne(e.activity.id, p, what)}
            onQuick={(kind) => {
              setCursor(i);
              setQuick({ kind, ids: [e.activity.id] });
            }}
          />
        ))}
      </div>

      {open ? (
        <ConversationDrawer
          key={open.id}
          id={open.id}
          initial={items.find((x) => x.activity.id === open.id) ?? null}
          focus={open.focus}
          members={members}
          workers={workers}
          settings={settings}
          viewer={viewer}
          home={home}
          position={items.findIndex((x) => x.activity.id === open.id)}
          total={items.length}
          onClose={() => setOpen(null)}
          onPatch={(p, what) => patchOne(open.id, p, what)}
          onChanged={() => void load(true)}
        />
      ) : null}

      {showSettings ? (
        <InboxSettingsDrawer
          canManage={viewer?.canManage ?? false}
          canEditReplies={canAssign}
          members={workers}
          onClose={() => setShowSettings(false)}
          onSettings={(s) => {
            setSettings(s);
            void load(true);
          }}
        />
      ) : null}

      {help ? <ShortcutsOverlay onClose={() => setHelp(false)} /> : null}

      {quick ? (
        <QuickPick
          quick={quick}
          settings={settings}
          workers={workers}
          me={me}
          entries={items}
          onClose={() => setQuick(null)}
          onPatch={(p, what) => {
            const ids = quick.ids;
            setQuick(null);
            act(ids, p, what);
          }}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- one row

function InboxRow({
  entry: e,
  now,
  home,
  members,
  workers,
  me,
  current,
  selected,
  canWork,
  canAssign,
  tagColor,
  rowRef,
  onSelect,
  onOpen,
  onPatch,
  onQuick,
}: {
  entry: InboxEntry;
  now: number;
  home: string;
  members: Member[];
  workers: Member[];
  me: string | null;
  current: boolean;
  selected: boolean;
  canWork: boolean;
  canAssign: boolean;
  tagColor: Map<string, string>;
  rowRef: (el: HTMLElement | null) => void;
  onSelect: () => void;
  onOpen: () => void;
  onPatch: (p: InboxPatch, what: string) => void;
  onQuick: (kind: "label" | "snooze" | "assign") => void;
}) {
  const a = e.activity;
  const last = latestOf(e);
  const s = e.state;
  const sla = slaBadge(e.sla, now);
  const who = a.authorName ?? a.authorHandle ?? "Someone";
  const handle = authorHandleText(a.network, a.authorHandle);
  const foreign = !sameLanguage(last.lang ?? a.lang, home);
  const text = last.translation && foreign ? last.translation : (last.text ?? "");
  const assignee = s.assignee ? memberName(members, s.assignee, me) : null;
  const where = a.conversationName && a.conversationType !== "direct" ? a.conversationName : null;

  return (
    <article
      ref={rowRef}
      role="listitem"
      className={`ibx-row${current ? " ibx-current" : ""}${selected ? " ibx-selected" : ""} ibx-p-${s.priority}`}
      aria-current={current ? "true" : undefined}
      data-id={a.id}
    >
      {canWork ? (
        <label className="ibx-check">
          <input type="checkbox" checked={selected} onChange={onSelect} aria-label={`Select the conversation with ${who}`} />
        </label>
      ) : null}
      <button type="button" className="ibx-main" onClick={onOpen} aria-label={`Open the conversation with ${who} on ${networkLabel(a.network)}`}>
        <span className="ibx-line1">
          {s.priority !== "normal" ? <span className={`ibx-prio ibx-prio-${s.priority}`}>{PRIORITY_LABEL[s.priority]}</span> : null}
          <span className="ibx-author">{who}</span>
          {handle && handle !== who ? <span className="ibx-handle muted">{handle}</span> : null}
          <NetworkBadge network={a.network} short />
          <span className="muted ibx-kind">{kindLabel(a.kind)}</span>
          {where ? <span className="muted ibx-where">in {where}</span> : null}
          {(last.lang ?? a.lang) && foreign ? (
            <span className="tag feed-lang" title={languageName(last.lang ?? a.lang)}>
              <span aria-hidden="true">{languageTag((last.lang ?? a.lang)!)}</span>
              <span className="sr-only">Written in {languageName(last.lang ?? a.lang)}</span>
            </span>
          ) : null}
          <RelativeTime iso={s.lastActivityAt} className="ibx-time" />
        </span>
        <span className="ibx-text" lang={last.translation && foreign ? home : (last.lang ?? undefined)}>
          {s.messageCount > 1 ? <span className="ibx-msgs mono">{s.messageCount}</span> : null}
          {text || <span className="muted">(no text)</span>}
        </span>
      </button>
      <div className="ibx-meta">
        {s.status !== "open" ? <span className={`ibx-status ibx-status-${s.status}`}>{STATUS_LABEL[s.status]}</span> : null}
        {sla ? (
          <span className={`ibx-sla ibx-sla-${sla.tone}`} title={sla.title}>
            {sla.text}
          </span>
        ) : null}
        {s.snoozedUntil && Date.parse(s.snoozedUntil) > now ? (
          <span className="ibx-snoozed" title={new Date(s.snoozedUntil).toLocaleString()}>
            Snoozed
          </span>
        ) : null}
        {s.tags.map((t) => (
          <span key={t} className={`ibx-label ibx-c-${tagColor.get(t) ?? "gray"}`}>
            {t}
          </span>
        ))}
        {e.notes ? (
          <span className="muted small ibx-notes" title={plural(e.notes, "internal note")}>
            {plural(e.notes, "note")}
          </span>
        ) : null}
        <span className="ibx-row-actions">
          {canAssign ? (
            <Menu
              align="right"
              buttonClassName={`ibx-assignee${assignee ? "" : " ibx-assignee-none"}`}
              ariaLabel={assignee ? `Assigned to ${assignee}. Change` : `Nobody on it. Assign`}
              label={
                assignee ? (
                  <>
                    <span className="avatar avatar-small" aria-hidden="true">
                      {initialsOf(assignee === "You" ? memberName(members, me) : assignee)}
                    </span>
                    <span className="ibx-assignee-name">{assignee}</span>
                  </>
                ) : (
                  "Assign"
                )
              }
            >
              {(close) => (
                <>
                  {me && s.assignee !== me ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        close();
                        onPatch({ assignee: "me" }, "Assigned to you");
                      }}
                    >
                      Assign to me
                    </button>
                  ) : null}
                  {workers
                    .filter((m) => m.userId !== me)
                    .map((m) => (
                      <button
                        key={m.userId}
                        type="button"
                        role="menuitemradio"
                        aria-checked={s.assignee === m.userId}
                        className="menu-item"
                        onClick={() => {
                          close();
                          onPatch({ assignee: m.userId }, `Assigned to ${m.name || m.email}`);
                        }}
                      >
                        {m.name || m.email}
                      </button>
                    ))}
                  {s.assignee ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        close();
                        onPatch({ assignee: null }, "Unassigned");
                      }}
                    >
                      Unassign
                    </button>
                  ) : null}
                </>
              )}
            </Menu>
          ) : assignee ? (
            <span className="ibx-assignee ibx-assignee-static">{assignee}</span>
          ) : null}
          {canWork ? (
            s.status === "done" ? (
              <button type="button" className="btn btn-ghost btn-small" onClick={() => onPatch({ status: "open" }, "Reopened")}>
                Reopen
              </button>
            ) : (
              <button type="button" className="btn btn-ghost btn-small ibx-done" onClick={() => onPatch({ status: "done" }, "Marked done")} title="Mark done (e)">
                Done
              </button>
            )
          ) : null}
          {canWork ? (
            <Menu align="right" label="…" ariaLabel={`More for the conversation with ${who}`} buttonClassName="btn btn-ghost btn-small">
              {(close) => (
                <>
                  <div className="menu-h">Status</div>
                  {(["open", "pending", "done", "spam"] as InboxStatus[]).map((st) => (
                    <button
                      key={st}
                      type="button"
                      role="menuitemradio"
                      aria-checked={s.status === st}
                      className="menu-item"
                      onClick={() => {
                        close();
                        onPatch({ status: st }, `Marked ${STATUS_LABEL[st].toLowerCase()}`);
                      }}
                    >
                      {STATUS_LABEL[st]}
                    </button>
                  ))}
                  {canAssign ? (
                    <>
                      <div className="menu-sep" />
                      <div className="menu-h">Priority</div>
                      {PRIORITIES.map((p) => (
                        <button
                          key={p}
                          type="button"
                          role="menuitemradio"
                          aria-checked={s.priority === p}
                          className="menu-item"
                          onClick={() => {
                            close();
                            onPatch({ priority: p }, `Priority ${PRIORITY_LABEL[p].toLowerCase()}`);
                          }}
                        >
                          {PRIORITY_LABEL[p]}
                        </button>
                      ))}
                    </>
                  ) : null}
                  <div className="menu-sep" />
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    onClick={() => {
                      close();
                      onQuick("label");
                    }}
                  >
                    Labels…
                  </button>
                  {canAssign ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        close();
                        onQuick("snooze");
                      }}
                    >
                      Snooze…
                    </button>
                  ) : null}
                </>
              )}
            </Menu>
          ) : null}
        </span>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- overlays

function Overlay({ title, onClose, children, className }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("button, input")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="ibx-overlay" onClick={onClose}>
      <div className={`ibx-dialog${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-label={title} ref={box} onClick={(e) => e.stopPropagation()}>
        <div className="ibx-dialog-head">
          <h3>{title}</h3>
          <button type="button" className="btn btn-ghost btn-small" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <Overlay title="Keyboard shortcuts" onClose={onClose} className="ibx-help">
      <dl className="ibx-keys">
        {SHORTCUTS.map((s) => (
          <div key={s.keys} className="ibx-key-row">
            <dt>
              {s.keys.split(" ").map((k, i, all) => ((k === "/" && all.length > 1) || k === "or" ? <span key={i} className="muted"> {k} </span> : <kbd key={i}>{k}</kbd>))}
            </dt>
            <dd>{s.what}</dd>
          </div>
        ))}
      </dl>
      <p className="muted small">Shortcuts act on the highlighted conversation, or on every selected one.</p>
    </Overlay>
  );
}

function QuickPick({
  quick,
  settings,
  workers,
  me,
  entries,
  onClose,
  onPatch,
}: {
  quick: NonNullable<Quick>;
  settings: InboxSettings | null;
  workers: Member[];
  me: string | null;
  entries: InboxEntry[];
  onClose: () => void;
  onPatch: (p: InboxPatch, what: string) => void;
}) {
  const n = quick.ids.length;
  const on = entries.filter((e) => quick.ids.includes(e.activity.id));
  if (quick.kind === "label") {
    const tags = settings?.tags ?? [];
    return (
      <Overlay title={n > 1 ? `Label ${n} conversations` : "Label"} onClose={onClose}>
        {tags.length ? (
          <div className="ibx-pick">
            {tags.map((t) => {
              const all = on.length > 0 && on.every((e) => e.state.tags.includes(t.name));
              return (
                <button key={t.name} type="button" className="ibx-pick-item" aria-pressed={all} onClick={() => onPatch(all ? { removeTags: [t.name] } : { addTags: [t.name] }, all ? `Removed “${t.name}”` : `Labelled “${t.name}”`)}>
                  <span className={`ibx-label ibx-c-${t.color}`}>{t.name}</span>
                  <span className="muted small">{all ? "Remove" : "Add"}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="muted">No labels yet. An owner or approver adds them in Inbox settings.</p>
        )}
      </Overlay>
    );
  }
  if (quick.kind === "assign") {
    return (
      <Overlay title={n > 1 ? `Assign ${n} conversations` : "Assign"} onClose={onClose}>
        <div className="ibx-pick">
          {me ? (
            <button type="button" className="ibx-pick-item" onClick={() => onPatch({ assignee: "me" }, "Assigned to you")}>
              Me
            </button>
          ) : null}
          {workers
            .filter((m) => m.userId !== me)
            .map((m) => (
              <button key={m.userId} type="button" className="ibx-pick-item" onClick={() => onPatch({ assignee: m.userId }, `Assigned to ${m.name || m.email}`)}>
                {m.name || m.email}
              </button>
            ))}
          <button type="button" className="ibx-pick-item" onClick={() => onPatch({ assignee: null }, "Unassigned")}>
            Nobody
          </button>
        </div>
      </Overlay>
    );
  }
  return (
    <Overlay title={n > 1 ? `Snooze ${n} conversations` : "Snooze until"} onClose={onClose}>
      <div className="ibx-pick">
        {snoozeOptions(new Date()).map((o) => (
          <button key={o.label} type="button" className="ibx-pick-item" onClick={() => onPatch({ snoozedUntil: o.at.toISOString() }, `Snoozed until ${o.at.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`)}>
            {o.label}
            <span className="muted small">{o.at.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
          </button>
        ))}
        {on.some((e) => e.state.snoozedUntil) ? (
          <button type="button" className="ibx-pick-item" onClick={() => onPatch({ snoozedUntil: null }, "Back in the queue")}>
            Wake it now
          </button>
        ) : null}
      </div>
    </Overlay>
  );
}
