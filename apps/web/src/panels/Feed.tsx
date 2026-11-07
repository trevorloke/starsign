import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Account, Activity, ActivityKind, FeedEvent, FeedQuery, LanguagesInfo, LiveStatus, ModerateAction, Network, PostDetail, Violation } from "../types";
import { Inbox } from "./Inbox"; // ---- inbox workflow
import { api, errorText, isApiError, USE_FIXTURES } from "../api";
import { Menu } from "../components/Menu";
import { NetworkBadge } from "../components/NetworkBadge";
import { PanelState } from "../components/PanelState";
import { RelativeTime } from "../components/RelativeTime";
import { canReply, capabilitiesFor, moderationFor } from "../lib/connectors";
import { atHandle, authorHandleText, kindLabel, NETWORK_MAX_TEXT, networkLabel, textLength, violationText } from "../lib/format";
import { languageName, languageTag, sameLanguage } from "../lib/lang";
import { useRoom } from "../lib/room";

type KindFilter = "all" | ActivityKind;

const KIND_CHIPS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mention", label: "Mentions" },
  { id: "reply", label: "Replies" },
  { id: "comment", label: "Comments" },
  { id: "dm", label: "DMs" },
  { id: "message", label: "Messages" },
];

const LIVE_LABEL: Record<LiveStatus, string> = { live: "Live", connecting: "Reconnecting…", off: "Paused" };

/** The feed narrowed to one tracked name (and, for an organisation, its people). */
export interface FeedEntityFilter {
  id: string;
  name: string;
  /** Include the people (and sub-brands) that belong to it. */
  withPeople: boolean;
}

// ---- inbox workflow: the panel is the plain feed or the team inbox, the person's pick (remembered on this device).
const FEED_MODE_STORAGE = "starsign.feedMode";
type FeedMode = "feed" | "inbox";
function readFeedMode(): FeedMode {
  try {
    return localStorage.getItem(FEED_MODE_STORAGE) === "inbox" ? "inbox" : "feed";
  } catch {
    return "feed";
  }
}

export function Feed(
  props: FeedProps & {
    /** SSE "inbox" events counter and the last event (for mentions and assignments). */
    inboxTick?: number;
    inboxEvent?: FeedEvent | null;
  },
) {
  const [mode, setMode] = useState<FeedMode>(readFeedMode);
  const change = (m: FeedMode) => {
    setMode(m);
    try {
      localStorage.setItem(FEED_MODE_STORAGE, m);
    } catch {
      // fine: the pick lasts for this page load
    }
  };
  const modeSwitch = (
    <div className="seg seg-small feed-mode" role="radiogroup" aria-label="Show the feed or the team inbox">
      {(["feed", "inbox"] as FeedMode[]).map((m) => (
        <button key={m} type="button" role="radio" aria-checked={mode === m} className="seg-btn" onClick={() => change(m)}>
          {m === "feed" ? "Feed" : "Inbox"}
        </button>
      ))}
    </div>
  );
  // An entity filter from the tracker ("Show in feed") is a feed view.
  if (mode === "inbox" && !props.entity) {
    return <Inbox accounts={props.accounts} liveTick={props.liveTick} liveStatus={props.liveStatus} inboxTick={props.inboxTick ?? 0} inboxEvent={props.inboxEvent ?? null} languages={props.languages} modeSwitch={modeSwitch} />;
  }
  return <PlainFeed {...props} modeSwitch={modeSwitch} />;
}

type FeedProps = Parameters<typeof PlainFeed>[0];
// ---- end inbox workflow

function PlainFeed({
  accounts,
  liveTick,
  liveStatus,
  canDelete,
  languages,
  entity = null,
  onClearEntity,
  modeSwitch,
}: {
  accounts: Account[];
  liveTick: number;
  liveStatus: LiveStatus;
  canDelete: boolean;
  /** GET /v1/languages: the team's language and what the feed has seen. Null until it loads (or on older servers). */
  languages: LanguagesInfo | null;
  /** Set from the tracker's "Show in feed". */
  entity?: FeedEntityFilter | null;
  onClearEntity?: () => void;
  /** inbox workflow: the Feed / Inbox switch. */
  modeSwitch?: ReactNode;
}) {
  const [kind, setKind] = useState<KindFilter>("all");
  const [network, setNetwork] = useState<Network | null>(null);
  const [lang, setLang] = useState<string>("");
  const [conversation, setConversation] = useState<{ id: string; name: string } | null>(null);
  const { openAccounts } = useRoom();
  const noAccounts = (
    <>
      Nothing here yet.{" "}
      <button type="button" className="linkish strong" onClick={openAccounts}>
        Connect an account
      </button>{" "}
      and its mentions, replies, comments and messages land here. Names you follow in the Tracker are searched in public posts and news too.
    </>
  );
  const [items, setItems] = useState<Activity[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());

  const networks = useMemo(() => Array.from(new Set(accounts.map((a) => a.network))), [accounts]);
  const home = languages?.settings.home ?? "en";
  const seenLangs = languages?.seen ?? [];
  const query = useMemo<FeedQuery>(
    () => ({
      kinds: kind === "all" ? undefined : [kind],
      networks: network ? [network] : undefined,
      languages: lang ? [lang] : undefined,
      conversation: conversation?.id,
      entity: entity?.id,
      children: entity ? true : undefined,
      limit: 60,
    }),
    [kind, network, lang, conversation, entity],
  );

  const itemsRef = useRef<Activity[] | null>(null);
  itemsRef.current = items;

  // A late response from a previous filter must never overwrite the current one.
  const gen = useRef(0);
  const load = useCallback(async () => {
    const g = ++gen.current;
    setLoading(true);
    setError(null);
    try {
      const rows = await api.feed(query);
      if (g !== gen.current) return;
      setItems(rows);
    } catch (e) {
      if (g !== gen.current) return;
      setError(errorText(e));
    } finally {
      if (g === gen.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Re-read the first page and merge anything new by id. Items are ordered by when they happened, not when
   * they were ingested, so a late-ingested older item still appears (a "since newest" query would miss it).
   */
  const refreshSince = useCallback(async () => {
    const g = gen.current;
    try {
      const incoming = await api.feed({ ...query, limit: 60 });
      if (g !== gen.current || !incoming.length) return;
      let added: string[] = [];
      setItems((current) => {
        const byId = new Map(incoming.map((a) => [a.id, a]));
        const seen = new Set((current ?? []).map((a) => a.id));
        const add = incoming.filter((a) => !seen.has(a.id));
        added = add.map((a) => a.id);
        // An item already on screen may have just been translated (a live event with `translated: true`).
        let changed = false;
        const kept = (current ?? []).map((a) => {
          const next = byId.get(a.id);
          if (next && (next.translation ?? null) !== (a.translation ?? null)) {
            changed = true;
            return next;
          }
          return a;
        });
        if (!add.length && !changed) return current;
        return [...add, ...kept].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
      });
      if (added.length) setFresh((f) => new Set([...f, ...added]));
    } catch {
      // the next event or poll will try again
    }
  }, [query]);

  const seenTick = useRef(liveTick);
  useEffect(() => {
    if (liveTick === seenTick.current) return;
    seenTick.current = liveTick;
    void refreshSince();
  }, [liveTick, refreshSince]);

  const replaceItem = useCallback((next: Activity) => {
    setItems((current) => current?.map((a) => (a.id === next.id ? next : a)) ?? current);
  }, []);

  // Without a live connection, poll quietly.
  useEffect(() => {
    if (liveStatus === "live") return;
    const id = window.setInterval(() => void refreshSince(), 60_000);
    return () => window.clearInterval(id);
  }, [liveStatus, refreshSince]);

  return (
    <section className="panel panel-feed" aria-labelledby="feed-title">
      <header className="panel-head">
        <h2 id="feed-title">Feed</h2>
        {modeSwitch}
        <span className={`live live-${liveStatus}`}>
          <span className="live-dot" aria-hidden="true" />
          {LIVE_LABEL[liveStatus]}
          {USE_FIXTURES ? " · sample" : ""}
        </span>
      </header>
      <div className="chips" role="toolbar" aria-label="Filters">
        {KIND_CHIPS.map((c) => (
          <button key={c.id} type="button" className={`chip${kind === c.id ? " chip-on" : ""}`} aria-pressed={kind === c.id} onClick={() => setKind(c.id)}>
            {c.label}
          </button>
        ))}
        {networks.length ? <span className="chips-sep" aria-hidden="true" /> : null}
        {networks.map((n) => (
          <button
            key={n}
            type="button"
            className={`chip chip-net${network === n ? " chip-on" : ""}`}
            data-network={n}
            aria-pressed={network === n}
            onClick={() => setNetwork(network === n ? null : n)}
          >
            {networkLabel(n)}
          </button>
        ))}
        {seenLangs.length ? (
          <>
            <span className="chips-sep" aria-hidden="true" />
            <LanguageFilter value={lang} onChange={setLang} seen={seenLangs} />
          </>
        ) : null}
        {entity ? (
          <button
            type="button"
            className="chip chip-on feed-conv-chip"
            aria-label={`About: ${entity.name}${entity.withPeople ? " (+ people)" : ""}. Remove this filter`}
            onClick={onClearEntity}
          >
            <span className="feed-conv-name">
              About: {entity.name}
              {entity.withPeople ? " (+ people)" : ""}
            </span>
            <span aria-hidden="true"> ×</span>
          </button>
        ) : null}
        {conversation ? (
          <button
            type="button"
            className="chip chip-on feed-conv-chip"
            aria-label={`Show every conversation, not only ${conversation.name}`}
            onClick={() => setConversation(null)}
          >
            <span className="feed-conv-name">In {conversation.name}</span>
            <span aria-hidden="true"> ×</span>
          </button>
        ) : null}
      </div>
      <div className="panel-body">
        <PanelState loading={loading && !items} error={error} onRetry={() => void load()} empty={items && items.length === 0 ? (entity ? `Nothing about ${entity.name} matches these filters yet.` : accounts.length === 0 && kind === "all" && !network && !lang && !conversation ? noAccounts : "Quiet. Nothing matches these filters yet.") : null} />
        {items?.map((a) => (
          <FeedItem
            key={a.id}
            item={a}
            fresh={fresh.has(a.id)}
            canDelete={canDelete}
            home={home}
            onChange={replaceItem}
            onConversation={conversation ? undefined : (c) => setConversation(c)}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * The feed's language filter: the languages seen in the last 30 days, most common first. "Unknown" is shown for the
 * count only: the API filters by a language, not by its absence.
 */
function LanguageFilter({ value, onChange, seen }: { value: string; onChange: (lang: string) => void; seen: LanguagesInfo["seen"] }) {
  const known = seen.filter((s): s is { lang: string; n: number } => !!s.lang);
  const unknown = seen.find((s) => !s.lang);
  return (
    <label className="feed-lang-filter">
      <span className="sr-only">Language</span>
      <select className={`select select-small${value ? " feed-lang-on" : ""}`} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All languages</option>
        {known.map((s) => (
          <option key={s.lang} value={s.lang}>
            {languageName(s.lang)} · {s.n}
          </option>
        ))}
        {unknown ? (
          <option value="" disabled>
            Unknown · {unknown.n}
          </option>
        ) : null}
      </select>
    </label>
  );
}

type Outcome = { tone: "good" | "warn" | "bad"; text: string; postId?: string };

function outcomeOf(detail: PostDetail): Outcome {
  const { status, id, policyDecision } = detail.post;
  if (status === "blocked") {
    const v = (policyDecision?.violations ?? []).filter((x) => x.severity === "block");
    return { tone: "bad", text: `Blocked by a red line: ${v.length ? v.map((x) => violationText(x.message)).join("; ") : "change the words and try again."}`, postId: id };
  }
  if (status === "pending_approval") return { tone: "warn", text: "Waiting on approval", postId: id };
  if (status === "draft") return { tone: "warn", text: "Saved as a draft", postId: id };
  if (status === "failed") return { tone: "bad", text: "Didn't go out", postId: id };
  return { tone: "good", text: "Sent", postId: id };
}

/**
 * One inbox item. When it came in through a connected account, it can be answered in place (through the
 * same red lines as any post) and, where the network allows, liked, hidden or deleted.
 */
export function FeedItem({
  item: a,
  fresh,
  canDelete,
  home,
  onChange,
  onConversation,
  extra,
}: {
  item: Activity;
  fresh: boolean;
  canDelete: boolean;
  /** The team's language. */
  home: string;
  /** The item changed on the server (translated): replace it in the list. */
  onChange: (next: Activity) => void;
  /** Show only this conversation. Absent while the feed is already narrowed to one. */
  onConversation?: (c: { id: string; name: string }) => void;
  /** Extra tags in the head, before the time (the tracker says how a message matched). */
  extra?: ReactNode;
}) {
  const { streamsById, accountsById, connectors, openPost } = useRoom();
  const account = a.socialAccountId ? accountsById.get(a.socialAccountId) : undefined;
  const connected = !!account && account.status === "active";
  const caps = account ? capabilitiesFor(connectors, account) : null;
  const replyable = connected && canReply(caps, a.kind);
  const mod = connected ? moderationFor(caps, a.network, a.kind) : { like: false, hide: false, delete: false };
  const deletable = mod.delete && canDelete;

  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [liked, setLiked] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<ModerateAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [translating, setTranslating] = useState(false);

  const foreign = !sameLanguage(a.lang, home); // unknown counts as foreign: it may well need translating
  const translation = a.translation ?? null;
  const canTranslate = !!a.text && !translation && foreign;
  const where = a.conversationName && a.conversationType !== "direct" ? a.conversationName : null;
  const handle = authorHandleText(a.network, a.authorHandle);

  const streams = a.matchedStreams.map((id) => streamsById.get(id)?.name).filter((n): n is string => !!n);
  const max = NETWORK_MAX_TEXT[a.network as Network] ?? 10_000;
  const n = textLength(a.network as Network, text);
  const what = a.kind === "comment" ? "comment" : a.kind === "dm" || a.kind === "message" ? "message" : a.kind === "reply" ? "reply" : "post";

  async function send() {
    const t = text.trim();
    if (!t || sending || n > max) return;
    setSending(true);
    setError(null);
    try {
      const detail = await api.reply(a.id, { text: t });
      const o = outcomeOf(detail);
      setOutcome(o);
      if (o.tone !== "bad") {
        setText("");
        setReplying(false);
      }
    } catch (e) {
      if (isApiError(e) && e.status === 422 && e.details && typeof e.details === "object") {
        const v = ((e.details as { violations?: Violation[] }).violations ?? []).filter((x) => x.severity === "block");
        setOutcome({ tone: "bad", text: `Blocked by a red line: ${v.length ? v.map((x) => violationText(x.message)).join("; ") : "change the words and try again."}` });
      } else {
        setError(errorText(e));
      }
    } finally {
      setSending(false);
    }
  }

  async function translate() {
    setTranslating(true);
    setError(null);
    try {
      const next = await api.translate(a.id);
      setShowOriginal(false);
      onChange(next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setTranslating(false);
    }
  }

  async function moderate(action: ModerateAction) {
    setBusy(action);
    setError(null);
    try {
      await api.moderate(a.id, action);
      if (action === "like" || action === "unlike") setLiked(action === "like");
      if (action === "hide" || action === "unhide") setHidden(action === "hide");
      if (action === "delete") setDeleted(true);
      setConfirmDelete(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (deleted) {
    return (
      <article className="feed-row feed-gone">
        <span className="muted small">
          Deleted {a.authorName ?? a.authorHandle ?? "their"}'s {what} on {networkLabel(a.network)}.
        </span>
      </article>
    );
  }

  const hasMenu = mod.like || mod.hide || deletable;
  return (
    <article className={`feed-row${fresh ? " feed-fresh" : ""}${hidden ? " feed-hidden" : ""}`}>
      <div className="feed-head">
        <span className="feed-author">{a.authorName ?? a.authorHandle ?? "Someone"}</span>
        {handle ? <span className="feed-handle muted">{handle}</span> : null}
        <NetworkBadge network={a.network} />
        <span className="feed-kind muted">{a.network === "news" ? "Article" : kindLabel(a.kind)}</span>
        {where ? (
          onConversation && a.conversationId ? (
            <button
              type="button"
              className="linkish feed-where muted"
              title={`Show only ${where}`}
              onClick={() => onConversation({ id: a.conversationId!, name: where })}
            >
              in {where}
            </button>
          ) : (
            <span className="feed-where muted">in {where}</span>
          )
        ) : null}
        {a.lang && foreign ? (
          <span className="tag feed-lang" title={languageName(a.lang)}>
            <span aria-hidden="true">{languageTag(a.lang)}</span>
            <span className="sr-only">Written in {languageName(a.lang)}</span>
          </span>
        ) : null}
        {liked ? <span className="tag">Liked</span> : null}
        {hidden ? <span className="tag">Hidden</span> : null}
        {extra}
        <RelativeTime iso={a.occurredAt} className="feed-time" />
      </div>
      {a.text && translation ? (
        <>
          <p className="feed-translated muted">
            {showOriginal ? (a.lang ? `${languageName(a.lang)} original` : "Original") : a.lang ? `Translated from ${languageName(a.lang)}` : "Translated"}
            <span aria-hidden="true"> · </span>
            <button type="button" className="linkish feed-toggle" aria-controls={`feed-text-${a.id}`} onClick={() => setShowOriginal((v) => !v)}>
              {showOriginal ? "Show translation" : "Show original"}
            </button>
          </p>
          {/* Both versions share one grid cell, so switching never moves what is below; only the one shown is read out. */}
          <div className="feed-texts" id={`feed-text-${a.id}`}>
            <p className="feed-text" lang={a.translationLang ?? home} aria-hidden={showOriginal} data-on={!showOriginal}>
              {translation}
            </p>
            <p className="feed-text" lang={a.lang ?? undefined} aria-hidden={!showOriginal} data-on={showOriginal}>
              {a.text}
            </p>
          </div>
        </>
      ) : a.text ? (
        <p className="feed-text" lang={a.lang ?? undefined}>
          {a.text}
        </p>
      ) : null}
      <div className="feed-foot">
        {streams.map((name) => (
          <span key={name} className="tag">
            {name}
          </span>
        ))}
        <span className="feed-actions">
          {outcome ? (
            <span className={`feed-outcome feed-outcome-${outcome.tone}`} role="status">
              {outcome.text}
              {outcome.postId && outcome.tone !== "good" ? (
                <>
                  {" "}
                  <button type="button" className="linkish feed-outcome-open" onClick={() => openPost(outcome.postId!)}>
                    Open
                  </button>
                </>
              ) : null}
            </span>
          ) : null}
          {canTranslate ? (
            <button type="button" className="linkish feed-translate" disabled={translating} onClick={() => void translate()}>
              {translating ? "Translating…" : "Translate"}
            </button>
          ) : null}
          {replyable && !replying ? (
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setReplying(true)}>
              Reply
            </button>
          ) : null}
          {hasMenu ? (
            <Menu label="…" ariaLabel={`More actions for ${a.authorName ?? a.authorHandle ?? "this item"}`} buttonClassName="btn btn-ghost btn-small feed-more" align="right">
              {(close) => (
                <>
                  {mod.like ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      disabled={busy !== null}
                      onClick={() => {
                        close();
                        void moderate(liked ? "unlike" : "like");
                      }}
                    >
                      {liked ? "Unlike" : "Like"}
                    </button>
                  ) : null}
                  {mod.hide ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      disabled={busy !== null}
                      onClick={() => {
                        close();
                        void moderate(hidden ? "unhide" : "hide");
                      }}
                    >
                      {hidden ? `Unhide on ${networkLabel(a.network)}` : `Hide on ${networkLabel(a.network)}`}
                    </button>
                  ) : null}
                  {deletable ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item menu-danger"
                      onClick={() => {
                        close();
                        setConfirmDelete(true);
                      }}
                    >
                      Delete…
                    </button>
                  ) : null}
                </>
              )}
            </Menu>
          ) : null}
          {a.url ? (
            <a className="feed-link" href={a.url} target="_blank" rel="noopener noreferrer">
              Open ↗
            </a>
          ) : null}
        </span>
      </div>

      {confirmDelete ? (
        <div className="acct-confirm feed-confirm" role="group" aria-label="Delete this item?">
          <span>Delete this {what} on {networkLabel(a.network)}? It can't be undone.</span>
          <button type="button" className="btn btn-small btn-danger" disabled={busy === "delete"} onClick={() => void moderate("delete")}>
            {busy === "delete" ? "…" : "Yes"}
          </button>
          <span className="sep" aria-hidden="true">
            ·
          </span>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirmDelete(false)}>
            No
          </button>
        </div>
      ) : null}

      {replying && account ? (
        <div className="feed-reply">
          <textarea
            className="textarea"
            rows={2}
            value={text}
            placeholder={`Reply as ${atHandle(account.handle, account.network)}`}
            aria-label={`Reply to ${a.authorName ?? a.authorHandle ?? "them"} on ${networkLabel(a.network)}`}
            autoFocus
            onChange={(e) => {
              setText(e.target.value);
              if (outcome?.tone === "bad") setOutcome(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
              if (e.key === "Escape") setReplying(false);
            }}
          />
          <div className="feed-reply-bar">
            <button type="button" className="btn btn-primary btn-small" disabled={sending || !text.trim() || n > max} onClick={() => void send()}>
              {sending ? "Sending…" : "Send reply"}
            </button>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setReplying(false)}>
              Cancel
            </button>
            <span className="muted small feed-reply-note">Goes through your red lines first</span>
            <span className={`mono variant-count${n > max ? " over" : ""}`}>
              {n}/{max}
            </span>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="card-error feed-error" role="alert">
          {error}
        </div>
      ) : null}
    </article>
  );
}
