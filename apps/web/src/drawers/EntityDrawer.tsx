import { useCallback, useEffect, useMemo, useState } from "react";
import type { Activity, Entity, EntityKind, EntityMention, EntityReport, EntityReportRow, MentionHow } from "../types";
import { api, errorText } from "../api";
import { BigNumber } from "../components/BigNumber";
import { Drawer } from "../components/Drawer";
import { NetworkBadge } from "../components/NetworkBadge";
import { PanelState } from "../components/PanelState";
import { RelationPill } from "../components/Pill";
import { useToast } from "../components/Toast";
import { compact, entityKindLabel, listOf, networkLabel, percent, plural } from "../lib/format";
import { languageName } from "../lib/lang";
import { useRoom } from "../lib/room";
import { isoDaysAgo } from "../lib/time";
import { dayLabel, familyTree, fillDays, periodOf, seriesSummary, toneWord, type TrackerPeriod } from "../lib/tracker";
import { FeedItem, type FeedEntityFilter } from "../panels/Feed";
import { EntityForm } from "./EntityForm";

const HOW_LABEL: Record<MentionHow, string> = { author: "by them", handle: "@mention", name: "named" };
const HOW_HINT: Record<MentionHow, string> = {
  author: "Written by one of its own accounts",
  handle: "An @mention of one of its accounts",
  name: "Its name or an alias in the text or the translation",
};

/**
 * One tracked name: its numbers over the tracker's period, the people who belong to it, how it is matched, and the
 * latest messages by and about it. Edit and Track a name use the same drawer.
 */
export function EntityDrawer({
  id,
  startEditing = false,
  preset,
  period,
  canEdit,
  canDelete,
  home,
  onClose,
  onOpen,
  onChanged,
  onShowInFeed,
  onAiVisibility,
}: {
  /** null: track a new name. */
  id: string | null;
  startEditing?: boolean;
  /** A new name's starting point ("Add a person" from an organisation). */
  preset?: { parentId?: string; kind?: EntityKind };
  period: TrackerPeriod;
  canEdit: boolean;
  canDelete: boolean;
  /** The team's language, for the feed items. */
  home: string;
  onClose: () => void;
  /** Show another name in this drawer (a parent, one of its people, a name just created). */
  onOpen: (id: string) => void;
  /** Something was added, changed or archived: the tracker reloads. */
  onChanged: () => void;
  onShowInFeed: (filter: FeedEntityFilter) => void;
  /** AI answer visibility: open the AI visibility drawer on this name. */
  onAiVisibility?: (entityId: string) => void;
}) {
  const toast = useToast();
  const { openTopic } = useRoom();
  const [all, setAll] = useState<Entity[] | null>(null);
  const [report, setReport] = useState<EntityReport | null>(null);
  const [week, setWeek] = useState<EntityReport | null>(null);
  const [mentions, setMentions] = useState<EntityMention[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mentionsError, setMentionsError] = useState<string | null>(null);
  const [editing, setEditing] = useState(startEditing || id === null);
  const [saving, setSaving] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const p = periodOf(period);
  const load = useCallback(() => {
    setError(null);
    setMentionsError(null);
    const now = new Date().toISOString();
    void Promise.allSettled([
      api.entities(),
      id ? api.entityReport(isoDaysAgo(p.days), now) : Promise.resolve(null),
      id ? api.entityMentions(id, { children: true, limit: 30 }) : Promise.resolve(null),
      // For 24 hours the numbers cover the day, the strip still shows the week.
      id && p.days < 7 ? api.entityReport(isoDaysAgo(7), now) : Promise.resolve(null),
    ]).then(([a, r, m, w]) => {
      if (a.status === "fulfilled") setAll(a.value);
      else setError(errorText(a.reason));
      if (r.status === "fulfilled") setReport(r.value);
      else setError(errorText(r.reason));
      if (m.status === "fulfilled") setMentions(m.value);
      else setMentionsError(errorText(m.reason));
      setWeek(w.status === "fulfilled" ? w.value : null);
    });
  }, [id, p.days]);
  useEffect(load, [load]);

  // A different name opened in the same drawer starts on its details.
  useEffect(() => {
    setEditing(startEditing || id === null);
    setConfirmArchive(false);
    setArchiveError(null);
  }, [id, startEditing]);

  const entity = id && all ? (all.find((e) => e.id === id) ?? null) : null;
  const missing = !!id && !!all && !entity;
  const byId = useMemo(() => new Map((all ?? []).map((e) => [e.id, e])), [all]);
  const parent = entity?.parentId ? (byId.get(entity.parentId) ?? null) : null;
  const people = useMemo(() => (entity ? (all ?? []).filter((e) => e.parentId === entity.id && !e.archivedAt) : []), [all, entity]);

  async function archive() {
    if (!entity) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      await api.archiveEntity(entity.id);
      toast(`Stopped tracking ${entity.name}. Its history stays.`);
      onChanged();
      onClose();
    } catch (e) {
      setArchiveError(errorText(e));
    } finally {
      setArchiving(false);
    }
  }

  function saved(e: Entity, created: boolean) {
    onChanged();
    if (created) {
      toast(`Tracking ${e.name}. Counting the last 90 days now.`);
      onOpen(e.id);
    } else {
      toast(`Saved ${e.name}`);
      setAll((list) => (list ? list.map((x) => (x.id === e.id ? e : x)) : list));
      setEditing(false);
      load();
    }
  }

  // --- Form -----------------------------------------------------------------
  if (editing && (id === null || entity)) {
    return (
      <Drawer
        title={entity ? `Edit ${entity.name}` : "Track a name"}
        subtitle={<span className="muted">{entity ? "Changing names, handles or words recounts its mentions." : "A party, a brand, a company, or a person."}</span>}
        onClose={onClose}
        footer={
          <div className="dsec-act">
            <button type="submit" form="entity-form" className="btn btn-primary" disabled={saving || !all}>
              {saving ? "Saving…" : entity ? "Save" : "Start tracking"}
            </button>
            <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => (entity && !startEditing ? setEditing(false) : onClose())}>
              Cancel
            </button>
          </div>
        }
      >
        <PanelState error={error} loading={!all && !error} onRetry={load} />
        {all ? <EntityForm key={entity?.id ?? "new"} entity={entity} all={all} preset={preset} onSaved={saved} onBusy={setSaving} /> : null}
      </Drawer>
    );
  }

  // --- Details --------------------------------------------------------------
  const row = report?.entities.find((r) => r.id === id) ?? null;
  const filterLabel: FeedEntityFilter | null = entity ? { id: entity.id, name: entity.name, withPeople: people.length > 0 } : null;

  return (
    <Drawer
      title={entity?.name ?? (missing ? "Not tracked" : "Tracker")}
      subtitle={
        entity ? (
          <>
            {entity.role ? <span className="tag">{entity.role}</span> : <span className="tag">{entityKindLabel(entity.kind)}</span>}
            <RelationPill relation={entity.relation} />
            {parent ? (
              <span className="muted">
                Part of{" "}
                <button type="button" className="linkish ent-parent" onClick={() => onOpen(parent.id)}>
                  {parent.name}
                </button>
              </span>
            ) : null}
          </>
        ) : null
      }
      onClose={onClose}
    >
      <PanelState error={error} loading={!all && !error} onRetry={load} />
      {missing ? (
        <section className="dsec">
          <p className="muted">This name isn't tracked anymore.</p>
        </section>
      ) : null}

      {entity ? (
        <>
          <section className="dsec">
            <div className="dsec-act ent-actions">
              {filterLabel ? (
                <button type="button" className="btn btn-primary" onClick={() => onShowInFeed(filterLabel)}>
                  Show in feed
                </button>
              ) : null}
              {entity.trendTopicId ? (
                <button type="button" className="btn" onClick={() => openTopic(entity.trendTopicId!)}>
                  Momentum on the radar
                </button>
              ) : null}
              {onAiVisibility ? (
                <button type="button" className="btn" onClick={() => onAiVisibility(entity.id)}>
                  How AI answers talk about {entity.name}
                </button>
              ) : null}
              {canEdit ? (
                <span className="ent-actions-end">
                  <button type="button" className="btn btn-ghost" onClick={() => setEditing(true)}>
                    Edit
                  </button>
                  {!confirmArchive ? (
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirmArchive(true)}>
                      Archive
                    </button>
                  ) : null}
                </span>
              ) : null}
            </div>
            {confirmArchive ? (
              <div className="acct-confirm ent-confirm" role="group" aria-label={`Stop tracking ${entity.name}?`}>
                <span className="ent-confirm-text">
                  Stop tracking {entity.name}? {people.length ? `Its ${plural(people.length, "person", "people")} stay tracked on their own. ` : ""}Its history stays.
                </span>
                <button type="button" className="btn btn-small btn-danger" disabled={archiving} onClick={() => void archive()}>
                  {archiving ? "…" : "Archive"}
                </button>
                <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirmArchive(false)}>
                  Keep
                </button>
              </div>
            ) : null}
            {archiveError ? (
              <div className="card-error" role="alert">
                {archiveError}
              </div>
            ) : null}
          </section>

          {report ? (
            <Numbers row={row} strip={week ?? report} stripRow={(week ?? report).entities.find((r) => r.id === id) ?? null} period={period} people={people.length} parentName={parent?.name ?? null} />
          ) : null}

          {people.length && report ? <People report={report} rootId={entity.id} onOpen={onOpen} /> : null}

          <Matching entity={entity} />

          <section className="dsec">
            <h3 className="section-h">Latest mentions{people.length ? " (with its people)" : ""}</h3>
            <PanelState loading={!mentions && !mentionsError} error={mentionsError} onRetry={load} empty={mentions && mentions.length === 0 ? "Nothing yet. New messages are matched as they arrive." : null} />
            {mentions?.length ? (
              <div className="ent-mentions">
                {mentions.map((m) => (
                  <FeedItem
                    key={`${m.mention.id}`}
                    item={m.activity}
                    fresh={false}
                    canDelete={canDelete}
                    home={home}
                    onChange={(next: Activity) => setMentions((list) => list?.map((x) => (x.activity.id === next.id ? { ...x, activity: next } : x)) ?? list)}
                    extra={<HowTag how={m.mention.how} term={m.mention.term} about={m.mention.entityId && m.mention.entityId !== entity.id ? (byId.get(m.mention.entityId)?.name ?? null) : null} />}
                  />
                ))}
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </Drawer>
  );
}

function HowTag({ how, term, about }: { how: MentionHow; term: string; about: string | null }) {
  return (
    <span className={`tag how-tag how-${how}`} title={`${HOW_HINT[how]}: ${term}`}>
      {HOW_LABEL[how] ?? how}
      {about ? ` · ${about}` : ""}
    </span>
  );
}

function Numbers({
  row,
  strip,
  stripRow,
  period,
  people,
  parentName,
}: {
  row: EntityReportRow | null;
  /** The report the day strip is drawn from: the period's, or the last week's for 24 hours. */
  strip: EntityReport;
  stripRow: EntityReportRow | null;
  period: TrackerPeriod;
  people: number;
  parentName: string | null;
}) {
  const { timezone } = useRoom();
  const p = periodOf(period);
  if (!row) {
    return (
      <section className="dsec">
        <p className="muted">No numbers yet. They appear once its first mention is matched.</p>
      </section>
    );
  }
  const days = stripRow ? fillDays(stripRow.byDay, strip.from, strip.to, timezone, Math.max(7, p.days)) : [];
  const share = row.parentId ? row.shareWithinParent : row.shareOfVoice;
  const tone = toneWord(row.sentiment);
  const totalLang = row.byLanguage.reduce((n, l) => n + l.n, 0);
  const totalNet = row.byNetwork.reduce((n, l) => n + l.n, 0);
  return (
    <>
      <section className="dsec">
        <h3 className="section-h">{p.long.replace(/^t/, "T")}</h3>
        <div className="links-nums ent-nums">
          <BigNumber value={compact(row.mentions)} label={row.mentions === 1 ? "mention" : "mentions"} title="Messages by others that name it, @mention it, or are about it" />
          {people ? <BigNumber value={compact(row.familyMentions)} label="incl. its people" /> : null}
          <BigNumber value={compact(row.people)} label="people talking" />
          <BigNumber value={compact(row.authored)} label="by them" title="Messages written from its own accounts" muted={!row.authored} />
          {share !== null ? <BigNumber value={percent(share)} label={row.parentId ? `within ${parentName ?? "its organisation"}` : "share of voice"} /> : null}
        </div>
        {tone ? <p className="muted small ent-tone">Tone of what people say: {tone.toLowerCase()}.</p> : null}
        <MentionStrip days={days} />
      </section>
      {row.byLanguage.length || row.byNetwork.length ? (
        <section className="dsec ent-split">
          <div>
            <h3 className="section-h">Languages</h3>
            <ul className="lang-seen">
              {row.byLanguage.slice(0, 6).map((l) => (
                <li key={l.lang ?? "unknown"} className="lang-seen-row">
                  <span className="lang-seen-name">{languageName(l.lang)}</span>
                  <span className="lang-seen-bar" aria-hidden="true">
                    <span style={{ width: `${totalLang ? Math.max(2, Math.round((l.n / totalLang) * 100)) : 0}%` }} />
                  </span>
                  <span className="mono lang-seen-n">{l.n.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="section-h">Where</h3>
            <ul className="lang-seen">
              {row.byNetwork.slice(0, 6).map((n) => (
                <li key={n.network} className="lang-seen-row">
                  <span className="lang-seen-name">
                    <NetworkBadge network={n.network} />
                  </span>
                  <span className="lang-seen-bar" aria-hidden="true">
                    <span style={{ width: `${totalNet ? Math.max(2, Math.round((n.n / totalNet) * 100)) : 0}%` }} />
                  </span>
                  <span className="mono lang-seen-n" aria-label={`${n.n} on ${networkLabel(n.network)}`}>
                    {n.n.toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </>
  );
}

/** One bar per day, like the Links drawer's strip. The numbers live in each bar's title and in the summary label. */
function MentionStrip({ days }: { days: { day: string; n: number }[] }) {
  if (days.length < 2) return null;
  const max = Math.max(1, ...days.map((d) => d.n));
  return (
    <div className="links-strip-wrap">
      <div className="links-strip" role="img" aria-label={seriesSummary(days)}>
        {days.map((d) => (
          <div key={d.day} className="links-bar" title={`${dayLabel(d.day)}: ${plural(d.n, "mention")}`}>
            <span className="links-bar-fill" style={{ height: `${d.n ? Math.max(4, (d.n / max) * 100) : 0}%` }} />
          </div>
        ))}
      </div>
      <div className="links-strip-axis muted small">
        <span>{dayLabel(days[0]!.day)}</span>
        <span>mentions per day</span>
        <span>{dayLabel(days[days.length - 1]!.day)}</span>
      </div>
    </div>
  );
}

function People({ report, rootId, onOpen }: { report: EntityReport; rootId: string; onOpen: (id: string) => void }) {
  // Everyone below this organisation, at any depth, in the tracker's order.
  const rows = familyTree(report.entities);
  const start = rows.findIndex((r) => r.row.id === rootId);
  if (start < 0) return null;
  const base = rows[start]!.depth;
  const below: typeof rows = [];
  for (let i = start + 1; i < rows.length && rows[i]!.depth > base; i++) below.push(rows[i]!);
  if (!below.length) return null;
  return (
    <section className="dsec">
      <h3 className="section-h">Its people</h3>
      <ul className="acct-list">
        {below.map(({ row, depth }) => (
          <li key={row.id} className="acct-row ent-person" style={{ paddingLeft: (depth - base - 1) * 16 }}>
            <div className="acct-main">
              <div className="acct-id">
                <button type="button" className="linkish strong" onClick={() => onOpen(row.id)}>
                  {row.name}
                </button>
                {row.role ? <span className="tag">{row.role}</span> : null}
              </div>
              <div className="acct-meta muted small">
                <span>
                  <span className="mono">{compact(row.mentions)}</span> mentions
                </span>
                <span>
                  <span className="mono">{compact(row.authored)}</span> by them
                </span>
                {row.shareWithinParent !== null ? (
                  <span>
                    <span className="mono">{percent(row.shareWithinParent)}</span> of its people's mentions
                  </span>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** How Starsign recognises it: read-only here, changed with Edit. */
function Matching({ entity }: { entity: Entity }) {
  const handles = Object.entries(entity.handles).flatMap(([net, list]) => (list ?? []).map((h) => ({ net, h })));
  const words = (xs: string[]) => (xs.length ? <span className="ent-words">{xs.map((x) => <span key={x} className="tag">{x}</span>)}</span> : <span className="muted">None</span>);
  return (
    <section className="dsec">
      <h3 className="section-h">How it's matched</h3>
      <dl className="kv ent-kv">
        <div className="kv-row">
          <dt>Aliases</dt>
          <dd>{words(entity.aliases)}</dd>
        </div>
        <div className="kv-row">
          <dt>Accounts</dt>
          <dd>
            {handles.length ? (
              <span className="ent-words">
                {handles.map(({ net, h }) => (
                  <span key={`${net}:${h}`} className="ent-handle">
                    <NetworkBadge network={net} short /> <span className="mono small">@{h}</span>
                  </span>
                ))}
              </span>
            ) : (
              <span className="muted">None</span>
            )}
          </dd>
        </div>
        {entity.context.length ? (
          <div className="kv-row">
            <dt>Only near</dt>
            <dd>{words(entity.context)}</dd>
          </div>
        ) : null}
        {entity.exclude.length ? (
          <div className="kv-row">
            <dt>Never with</dt>
            <dd>{words(entity.exclude)}</dd>
          </div>
        ) : null}
        {entity.wikipedia.length ? (
          <div className="kv-row">
            <dt>Wikipedia</dt>
            <dd>{listOf(entity.wikipedia.map((w) => w.replace(/_/g, " ")))}</dd>
          </div>
        ) : null}
        {entity.notes ? (
          <div className="kv-row">
            <dt>Notes</dt>
            <dd className="ent-notes">{entity.notes}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
