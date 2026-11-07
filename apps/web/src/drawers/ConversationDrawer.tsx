// ---- inbox workflow: one conversation, its state, the thread, internal notes and the reply box.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Activity, InboxConversation, InboxEntry, InboxNote, InboxPatch, InboxReply, InboxSettings, InboxStatus, InboxViewer, Member, Network, PostDetail, SavedReply, Violation } from "../types";
import { api, errorText, isApiError } from "../api";
import { Drawer } from "../components/Drawer";
import { Menu } from "../components/Menu";
import { NetworkBadge } from "../components/NetworkBadge";
import { PanelState } from "../components/PanelState";
import { RelativeTime } from "../components/RelativeTime";
import { canReply, capabilitiesFor } from "../lib/connectors";
import { actorLabel, atHandle, authorHandleText, kindLabel, NETWORK_MAX_TEXT, networkLabel, POST_STATUS_LABEL, textLength, violationText } from "../lib/format";
import { PRIORITIES, PRIORITY_LABEL, STATUSES, STATUS_HINT, STATUS_LABEL, memberName, mentionHandle, slaBadge, snoozeOptions } from "../lib/inbox";
import { languageName, sameLanguage } from "../lib/lang";
import { useRoom } from "../lib/room";
import { useNow } from "../lib/useNow";

export type DrawerFocus = "reply" | "note" | null;

type Outcome = { tone: "good" | "warn" | "bad"; text: string; postId?: string };

function outcomeOf(d: PostDetail): Outcome {
  const { status, id, policyDecision } = d.post;
  if (status === "blocked") {
    const v = (policyDecision?.violations ?? []).filter((x) => x.severity === "block");
    return { tone: "bad", text: `Blocked by a red line: ${v.length ? v.map((x) => violationText(x.message)).join("; ") : "change the words and try again."}`, postId: id };
  }
  if (status === "pending_approval") return { tone: "warn", text: "Waiting on approval", postId: id };
  if (status === "draft") return { tone: "warn", text: "Saved as a draft", postId: id };
  if (status === "failed") return { tone: "bad", text: "Didn't go out", postId: id };
  return { tone: "good", text: "Sent" };
}

/**
 * The whole conversation: the post it answers, every message in it and the team's replies in order, internal notes
 * with @mentions, and the reply box (saved replies go in, are edited, then pass the red lines like any reply).
 */
export function ConversationDrawer({
  id,
  initial,
  focus,
  members,
  workers,
  settings,
  viewer,
  home,
  position,
  total,
  onClose,
  onPatch,
  onChanged,
}: {
  id: string;
  initial: InboxEntry | null;
  focus: DrawerFocus;
  members: Member[];
  workers: Member[];
  settings: InboxSettings | null;
  viewer: InboxViewer | null;
  home: string;
  position: number;
  total: number;
  onClose: () => void;
  onPatch: (p: InboxPatch, what: string) => Promise<InboxEntry | null>;
  onChanged: () => void;
}) {
  const [convo, setConvo] = useState<InboxConversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(30_000);
  const { accountsById, connectors, openPost } = useRoom();

  const load = useCallback(async () => {
    setError(null);
    try {
      setConvo(await api.conversation(id));
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const entry = convo?.item ?? initial;
  const canWork = viewer?.canWork ?? true;
  const canAssign = viewer?.canAssign ?? true;
  const me = viewer?.userId ?? null;

  const patch = async (p: InboxPatch, what: string) => {
    const next = await onPatch(p, what);
    if (next) setConvo((c) => (c ? { ...c, item: next } : c));
  };

  if (!entry) {
    return (
      <Drawer title="Conversation" onClose={onClose} className="drawer-wide ibx-drawer">
        <PanelState loading={!error} error={error} onRetry={() => void load()} />
      </Drawer>
    );
  }

  const a = entry.activity;
  const s = entry.state;
  const sla = slaBadge(entry.sla, now);
  const who = a.authorName ?? a.authorHandle ?? "Someone";
  const latest = convo ? (convo.messages[convo.messages.length - 1] ?? a) : (entry.latest ?? a);
  const account = latest.socialAccountId ? accountsById.get(latest.socialAccountId) : undefined;
  const caps = account ? capabilitiesFor(connectors, account) : null;
  const replyable = !!account && account.status === "active" && canReply(caps, latest.kind);
  const whyNot = !account
    ? "This didn't come in through a connected account, so there is nothing to reply from."
    : account.status !== "active"
      ? `${atHandle(account.handle, account.network)} needs reconnecting before it can reply.`
      : `${networkLabel(latest.network)} replies aren't supported through this connection.`;

  return (
    <Drawer
      title={who}
      className="drawer-wide ibx-drawer"
      subtitle={
        <span className="ibx-drawer-sub">
          <NetworkBadge network={a.network} />
          <span className="muted">{kindLabel(a.kind)}</span>
          {a.conversationName && a.conversationType !== "direct" ? <span className="muted">in {a.conversationName}</span> : null}
          {sla ? (
            <span className={`ibx-sla ibx-sla-${sla.tone}`} title={sla.title}>
              {sla.text}
            </span>
          ) : null}
          {position >= 0 && total > 1 ? (
            <span className="muted small mono" title="j / k for the next and previous">
              {position + 1} of {total}
            </span>
          ) : null}
        </span>
      }
      onClose={onClose}
    >
      <section className="dsec ibx-state" aria-label="Conversation state">
        <div className="ibx-state-row">
          <span className="ibx-state-label" id="ibx-status-l">
            Status
          </span>
          <div className="seg seg-small" role="radiogroup" aria-labelledby="ibx-status-l">
            {STATUSES.map((st: InboxStatus) => (
              <button key={st} type="button" role="radio" aria-checked={s.status === st} className="seg-btn" disabled={!canWork} title={STATUS_HINT[st]} onClick={() => void patch({ status: st }, `Marked ${STATUS_LABEL[st].toLowerCase()}`)}>
                {STATUS_LABEL[st]}
              </button>
            ))}
          </div>
        </div>
        <div className="ibx-state-grid">
          <label className="ibx-field">
            <span className="ibx-state-label">Assigned to</span>
            <select
              className="select select-small"
              value={s.assignee ?? ""}
              disabled={!canAssign}
              onChange={(e) => void patch({ assignee: e.target.value || null }, e.target.value ? `Assigned to ${memberName(members, e.target.value, me)}` : "Unassigned")}
            >
              <option value="">Nobody</option>
              {me && !workers.some((w) => w.userId === me) ? <option value={me}>You</option> : null}
              {workers.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.userId === me ? `${m.name || m.email} (you)` : m.name || m.email}
                </option>
              ))}
              {s.assignee && !workers.some((w) => w.userId === s.assignee) && s.assignee !== me ? <option value={s.assignee}>{memberName(members, s.assignee)}</option> : null}
            </select>
          </label>
          <label className="ibx-field">
            <span className="ibx-state-label">Priority</span>
            <select className="select select-small" value={s.priority} disabled={!canAssign} onChange={(e) => void patch({ priority: e.target.value as InboxPatch["priority"] }, `Priority ${e.target.value}`)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                  {settings ? ` · first reply in ${settings.sla[p] >= 60 ? `${Math.round((settings.sla[p] / 60) * 10) / 10}h` : `${settings.sla[p]}m`}` : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="ibx-field">
            <span className="ibx-state-label">Snooze</span>
            {s.snoozedUntil && Date.parse(s.snoozedUntil) > now ? (
              <span className="ibx-snooze-on">
                <span className="small">Until {new Date(s.snoozedUntil).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
                {canAssign ? (
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => void patch({ snoozedUntil: null }, "Back in the queue")}>
                    Wake
                  </button>
                ) : null}
              </span>
            ) : (
              <Menu label="Snooze…" buttonClassName="btn btn-small" ariaLabel="Snooze this conversation">
                {(close) =>
                  snoozeOptions(new Date()).map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      disabled={!canAssign}
                      onClick={() => {
                        close();
                        void patch({ snoozedUntil: o.at.toISOString() }, `Snoozed: ${o.label.toLowerCase()}`);
                      }}
                    >
                      {o.label}
                    </button>
                  ))
                }
              </Menu>
            )}
          </div>
        </div>
        <div className="ibx-state-row ibx-labels-row" role="group" aria-label="Labels">
          <span className="ibx-state-label">Labels</span>
          <span className="ibx-labels-edit">
            {(settings?.tags ?? []).map((t) => {
              const on = s.tags.includes(t.name);
              return (
                <button
                  key={t.name}
                  type="button"
                  className={`ibx-label ibx-label-btn ibx-c-${t.color}${on ? " ibx-label-on" : ""}`}
                  aria-pressed={on}
                  disabled={!canWork}
                  onClick={() => void patch(on ? { removeTags: [t.name] } : { addTags: [t.name] }, on ? `Removed “${t.name}”` : `Labelled “${t.name}”`)}
                >
                  {t.name}
                </button>
              );
            })}
            {!settings?.tags.length ? <span className="muted small">No labels yet.</span> : null}
          </span>
        </div>
      </section>

      <section className="dsec ibx-thread" aria-label="Messages">
        <h3 className="section-h">Conversation</h3>
        {convo?.parent ? (
          <div className="ibx-parent">
            <span className="muted small">In reply to {convo.parent.kind === "own_post" ? "your post" : (convo.parent.authorName ?? "a post")}</span>
            <p className="ibx-parent-text">{convo.parent.text}</p>
          </div>
        ) : null}
        <PanelState loading={!convo && !error} error={error} onRetry={() => void load()} />
        {convo ? <Thread messages={convo.messages} replies={convo.replies} home={home} members={members} onOpenPost={openPost} /> : null}
      </section>

      {canWork ? (
        <ReplyBox
          key={`reply-${latest.id}`}
          rootId={a.id}
          target={latest}
          replyable={replyable}
          whyNot={whyNot}
          fromHandle={account ? atHandle(account.handle, account.network) : ""}
          autoFocus={focus === "reply"}
          onSent={() => {
            void load();
            onChanged();
          }}
          onOpenPost={openPost}
        />
      ) : null}

      <Notes
        rootId={a.id}
        notes={convo?.notes ?? null}
        members={members}
        me={me}
        canWrite={canWork}
        autoFocus={focus === "note"}
        onChanged={() => {
          void load();
          onChanged();
        }}
      />
    </Drawer>
  );
}

// ---------------------------------------------------------------- the thread

function Thread({ messages, replies, home, members, onOpenPost }: { messages: Activity[]; replies: InboxReply[]; home: string; members: Member[]; onOpenPost: (id: string) => void }) {
  const people = useMemo(() => new Map(members.map((m) => [m.userId, m.name || m.email])), [members]);
  const items = useMemo(
    () =>
      [...messages.map((m) => ({ at: m.occurredAt, kind: "in" as const, m })), ...replies.map((r) => ({ at: r.publishedAt ?? r.createdAt, kind: "out" as const, r }))].sort(
        (x, y) => Date.parse(x.at) - Date.parse(y.at),
      ),
    [messages, replies],
  );
  return (
    <ol className="ibx-msgs-list">
      {items.map((it) =>
        it.kind === "in" ? (
          <li key={it.m.id} className="ibx-msg ibx-msg-in">
            <Message a={it.m} home={home} />
          </li>
        ) : (
          <li key={it.r.postId} className="ibx-msg ibx-msg-out">
            <div className="ibx-msg-head">
              <span className="strong">{actorLabel(it.r.createdBy, people)}</span>
              <span className={`ibx-reply-status ibx-reply-${it.r.status}`}>{POST_STATUS_LABEL[it.r.status] ?? it.r.status}</span>
              <RelativeTime iso={it.r.publishedAt ?? it.r.createdAt} className="ibx-msg-time" />
            </div>
            <p className="ibx-msg-text">{it.r.text}</p>
            {it.r.status === "pending_approval" || it.r.status === "blocked" ? (
              <button type="button" className="linkish small ibx-open-post" onClick={() => onOpenPost(it.r.postId)}>
                Open the reply
              </button>
            ) : null}
          </li>
        ),
      )}
    </ol>
  );
}

function Message({ a, home }: { a: Activity; home: string }) {
  const [original, setOriginal] = useState(false);
  const foreign = !sameLanguage(a.lang, home);
  const translated = !!a.translation && foreign;
  const handle = authorHandleText(a.network, a.authorHandle);
  return (
    <>
      <div className="ibx-msg-head">
        <span className="strong">{a.authorName ?? a.authorHandle ?? "Someone"}</span>
        {handle ? <span className="muted small">{handle}</span> : null}
        <span className="muted small">{kindLabel(a.kind)}</span>
        <RelativeTime iso={a.occurredAt} className="ibx-msg-time" />
      </div>
      {translated ? (
        <>
          <p className="ibx-msg-text" lang={original ? (a.lang ?? undefined) : home}>
            {original ? a.text : a.translation}
          </p>
          <button type="button" className="linkish small ibx-toggle" onClick={() => setOriginal((v) => !v)}>
            {original ? "Show translation" : `Show the ${languageName(a.lang)} original`}
          </button>
        </>
      ) : (
        <p className="ibx-msg-text" lang={a.lang ?? undefined}>
          {a.text}
        </p>
      )}
      {a.url ? (
        <a className="small" href={a.url} target="_blank" rel="noopener noreferrer">
          Open on {networkLabel(a.network)} ↗
        </a>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- reply box with saved replies

function ReplyBox({
  rootId,
  target,
  replyable,
  whyNot,
  fromHandle,
  autoFocus,
  onSent,
  onOpenPost,
}: {
  rootId: string;
  target: Activity;
  replyable: boolean;
  whyNot: string;
  fromHandle: string;
  autoFocus: boolean;
  onSent: () => void;
  onOpenPost: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const max = NETWORK_MAX_TEXT[target.network as Network] ?? 10_000;
  const n = textLength(target.network as Network, text);

  useEffect(() => {
    if (autoFocus && replyable) area.current?.focus();
  }, [autoFocus, replyable]);

  const insert = (snippet: string) => {
    const el = area.current;
    if (!el || !text.trim()) {
      setText(snippet);
    } else {
      const start = el.selectionStart ?? text.length;
      const end = el.selectionEnd ?? text.length;
      setText(text.slice(0, start) + snippet + text.slice(end));
    }
    setOutcome(null);
    window.requestAnimationFrame(() => area.current?.focus());
  };

  async function send() {
    const t = text.trim();
    if (!t || sending || n > max) return;
    setSending(true);
    setError(null);
    try {
      const d = await api.replyInInbox(target.id, { text: t });
      const o = outcomeOf(d);
      setOutcome(o);
      if (o.tone !== "bad") {
        setText("");
        onSent();
      }
    } catch (e) {
      if (isApiError(e) && e.status === 422 && e.details && typeof e.details === "object") {
        const v = ((e.details as { violations?: Violation[] }).violations ?? []).filter((x) => x.severity === "block");
        setOutcome({ tone: "bad", text: `Blocked by a red line: ${v.length ? v.map((x) => violationText(x.message)).join("; ") : "change the words and try again."}` });
      } else setError(errorText(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="dsec ibx-reply" aria-labelledby="ibx-reply-h">
      <div className="ibx-reply-top">
        <h3 className="section-h" id="ibx-reply-h">
          Reply
        </h3>
        {replyable ? <SavedReplyPicker rootId={rootId} lang={target.lang ?? null} onPick={insert} /> : null}
      </div>
      {replyable ? (
        <>
          <label className="sr-only" htmlFor="ibx-reply-text">
            Reply to {target.authorName ?? target.authorHandle ?? "them"} on {networkLabel(target.network)}
          </label>
          <textarea
            id="ibx-reply-text"
            ref={area}
            className="textarea"
            rows={4}
            value={text}
            placeholder={`Reply as ${fromHandle}`}
            onChange={(e) => {
              setText(e.target.value);
              if (outcome?.tone === "bad") setOutcome(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
          />
          <div className="ibx-reply-bar">
            <button type="button" className="btn btn-primary btn-small" disabled={sending || !text.trim() || n > max} onClick={() => void send()}>
              {sending ? "Sending…" : "Send reply"}
            </button>
            <span className="muted small">Goes through your red lines first</span>
            <span className={`mono variant-count${n > max ? " over" : ""}`}>
              {n}/{max}
            </span>
          </div>
          {outcome ? (
            <p className={`feed-outcome feed-outcome-${outcome.tone}`} role="status">
              {outcome.text}
              {outcome.postId && outcome.tone !== "good" ? (
                <>
                  {" "}
                  <button type="button" className="linkish feed-outcome-open" onClick={() => onOpenPost(outcome.postId!)}>
                    Open
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
          {error ? (
            <div className="card-error" role="alert">
              {error}
            </div>
          ) : null}
        </>
      ) : (
        <p className="muted small">{whyNot}</p>
      )}
    </section>
  );
}

function SavedReplyPicker({ rootId, lang, onPick }: { rootId: string; lang: string | null; onPick: (text: string) => void }) {
  const [list, setList] = useState<SavedReply[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    if (list) return;
    api.savedReplies().then(setList, (e: unknown) => setError(errorText(e)));
  };
  const shown = (list ?? [])
    .filter((r) => !filter.trim() || `${r.name}\n${r.text}`.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((x, y) => Number(sameLanguage(y.lang, lang)) - Number(sameLanguage(x.lang, lang)) || x.name.localeCompare(y.name));

  async function pick(r: SavedReply, close: () => void) {
    setBusy(r.id);
    setError(null);
    try {
      const filled = await api.fillSavedReply(r.id, rootId);
      onPick(filled.text);
      close();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div onFocusCapture={load} onMouseEnter={load}>
      <Menu label="Saved replies" align="right" buttonClassName="btn btn-small" className="ibx-saved" ariaLabel="Insert a saved reply">
        {(close) => (
          <div className="ibx-saved-pop">
            <label className="sr-only" htmlFor="ibx-saved-filter">
              Find a saved reply
            </label>
            <input id="ibx-saved-filter" className="input input-small" placeholder="Find a saved reply" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
            {!list && !error ? <p className="muted small ibx-saved-empty">Loading…</p> : null}
            {list && !shown.length ? <p className="muted small ibx-saved-empty">{list.length ? "None match." : "No saved replies yet. Add them in Inbox settings."}</p> : null}
            {shown.map((r) => (
              <button key={r.id} type="button" role="menuitem" className="menu-item ibx-saved-item" disabled={busy !== null} onClick={() => void pick(r, close)}>
                <span className="ibx-saved-name">
                  {r.name}
                  {r.lang ? <span className="tag">{r.lang.toUpperCase()}</span> : null}
                </span>
                <span className="muted small ibx-saved-text">{r.text}</span>
              </button>
            ))}
            {error ? (
              <div className="card-error" role="alert">
                {error}
              </div>
            ) : null}
          </div>
        )}
      </Menu>
    </div>
  );
}

// ---------------------------------------------------------------- internal notes with @mentions

function renderMentions(text: string, members: Member[]): ReactNode {
  const handles = new Set(members.flatMap((m) => [mentionHandle(m), (m.name ?? "").split(/\s+/)[0]?.toLowerCase() ?? "", (m.name ?? "").toLowerCase().replace(/\s+/g, "")].filter(Boolean)));
  const parts = text.split(/(@[\p{L}\p{N}][\p{L}\p{N}._-]*)/u);
  return parts.map((p, i) =>
    p.startsWith("@") && handles.has(p.slice(1).toLowerCase().replace(/[._-]+$/, "")) ? (
      <span key={i} className="ibx-mention">
        {p}
      </span>
    ) : (
      <Fragment key={i}>{p}</Fragment>
    ),
  );
}

function Notes({ rootId, notes, members, me, canWrite, autoFocus, onChanged }: { rootId: string; notes: InboxNote[] | null; members: Member[]; me: string | null; canWrite: boolean; autoFocus: boolean; onChanged: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const people = useMemo(() => new Map(members.map((m) => [m.userId, m.name || m.email])), [members]);

  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus]);

  // "@sa" right before the caret: suggest teammates.
  const token = /(^|\s)@([\p{L}\p{N}._-]*)$/u.exec(text.slice(0, caret));
  const suggestions = token ? members.filter((m) => `${mentionHandle(m)} ${(m.name ?? "").toLowerCase()}`.includes(token[2]!.toLowerCase()) && m.userId !== me).slice(0, 5) : [];

  const complete = (m: Member) => {
    if (!token) return;
    const start = caret - token[2]!.length - 1;
    const next = `${text.slice(0, start)}@${mentionHandle(m)} ${text.slice(caret)}`;
    setText(next);
    const pos = start + mentionHandle(m).length + 2;
    setCaret(pos);
    window.requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(pos, pos);
    });
  };

  async function add() {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      await api.addInboxNote(rootId, t);
      setText("");
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(n: InboxNote) {
    try {
      await api.deleteInboxNote(n.id);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <section className="dsec ibx-notes-sec" aria-labelledby="ibx-notes-h">
      <h3 className="section-h" id="ibx-notes-h">
        Internal notes
      </h3>
      <p className="small muted">Only your team sees these. @name tells a teammate.</p>
      {notes?.length ? (
        <ol className="ibx-note-list">
          {notes.map((n) => (
            <li key={n.id} className="ibx-note">
              <div className="ibx-msg-head">
                <span className="strong">{actorLabel(n.author, people)}</span>
                {n.editedAt ? <span className="muted small">edited</span> : null}
                <RelativeTime iso={n.createdAt} className="ibx-msg-time" />
                {canWrite && n.author.id === me ? (
                  <button type="button" className="linkish small muted" aria-label="Delete this note" onClick={() => void remove(n)}>
                    Delete
                  </button>
                ) : null}
              </div>
              <p className="ibx-msg-text">{renderMentions(n.text, members)}</p>
            </li>
          ))}
        </ol>
      ) : notes ? (
        <p className="muted small">No notes yet.</p>
      ) : null}
      {canWrite ? (
        <div className="ibx-note-new">
          <label className="sr-only" htmlFor="ibx-note-text">
            New internal note
          </label>
          <textarea
            id="ibx-note-text"
            ref={area}
            className="textarea"
            rows={2}
            placeholder="Add a note for the team. Type @ to mention someone."
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={(e) => {
              if (suggestions.length && (e.key === "Enter" || e.key === "Tab")) {
                e.preventDefault();
                complete(suggestions[0]!);
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void add();
            }}
          />
          {suggestions.length ? (
            <div className="ibx-mention-pop" role="listbox" aria-label="Mention a teammate">
              {suggestions.map((m) => (
                <button key={m.userId} type="button" role="option" aria-selected="false" className="ibx-mention-opt" onMouseDown={(e) => e.preventDefault()} onClick={() => complete(m)}>
                  <span className="strong">{m.name || m.email}</span>
                  <span className="muted small">@{mentionHandle(m)}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="ibx-reply-bar">
            <button type="button" className="btn btn-small" disabled={busy || !text.trim()} onClick={() => void add()}>
              {busy ? "Adding…" : "Add note"}
            </button>
          </div>
          {error ? (
            <div className="card-error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
