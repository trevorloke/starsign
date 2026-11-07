import { useCallback, useEffect, useMemo, useState } from "react";
import type { Role } from "../types";
import type { VisAnswer, VisCadence, VisEngine, VisEntityRow, VisPeriodId, VisPrompt, VisReport, VisSettingsResponse } from "../lib/visibility";
import { VIS_PERIODS, engineLabel, positionLabel, sharePct, sharePts } from "../lib/visibility";
import { visibilityApi, errorText } from "../api";
import { BigNumber } from "../components/BigNumber";
import { ChipsInput } from "../components/ChipsInput";
import { Drawer } from "../components/Drawer";
import { PanelState } from "../components/PanelState";
import { RelationPill } from "../components/Pill";
import { useToast } from "../components/Toast";
import { languageName } from "../lib/lang";
import { formatRange } from "../lib/time";
import { plural } from "../lib/format";
import { AnswerView } from "./visibility/AnswerView";
import { PromptsSection } from "./visibility/PromptsSection";
import { AnswerCard, ShareBar, ShareSpark, Tone } from "./visibility/parts";
import "./visibility/visibility.css";

const PERIOD_STORAGE = "starsign.visibility.period";
function readPeriod(): VisPeriodId {
  try {
    const v = localStorage.getItem(PERIOD_STORAGE);
    return VIS_PERIODS.some((p) => p.id === v) ? (v as VisPeriodId) : "28d";
  } catch {
    return "28d";
  }
}

/**
 * How AI assistants (Claude, ChatGPT, Perplexity, Gemini) answer the questions the workspace cares about: which
 * tracked names they mention, in what order and tone, which sources they lean on, and how that moves over time.
 */
export function VisibilityDrawer({ myRole, focusEntityId = null, onClose }: { myRole: Role | null; focusEntityId?: string | null; onClose: () => void }) {
  const toast = useToast();
  const canEdit = myRole === "owner" || myRole === "approver" || myRole === "editor";
  const isOwner = myRole === "owner";
  const [period, setPeriod] = useState<VisPeriodId>(readPeriod);
  const [report, setReport] = useState<VisReport | null>(null);
  const [settings, setSettings] = useState<VisSettingsResponse | null>(null);
  const [prompts, setPrompts] = useState<VisPrompt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(focusEntityId);
  const [viewing, setViewing] = useState<VisAnswer | null>(null);
  const [answerFilter, setAnswerFilter] = useState<{ promptId?: string; engine?: string }>({});
  const [answers, setAnswers] = useState<VisAnswer[] | null>(null);

  const days = VIS_PERIODS.find((p) => p.id === period)!.days;
  const load = useCallback(() => {
    setError(null);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    void Promise.allSettled([visibilityApi.report(from.toISOString(), to.toISOString()), visibilityApi.settings(), visibilityApi.prompts()]).then(([r, s, p]) => {
      if (r.status === "fulfilled") setReport(r.value);
      else setError(errorText(r.reason));
      if (s.status === "fulfilled") setSettings(s.value);
      if (p.status === "fulfilled") setPrompts(p.value);
    });
  }, [days]);
  useEffect(load, [load]);

  useEffect(() => {
    if (!answerFilter.promptId && !answerFilter.engine) {
      setAnswers(null);
      return;
    }
    let live = true;
    void visibilityApi.answers({ ...answerFilter, limit: 12 }).then(
      (xs) => live && setAnswers(xs),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [answerFilter]);

  const changePeriod = (p: VisPeriodId) => {
    setPeriod(p);
    try {
      localStorage.setItem(PERIOD_STORAGE, p);
    } catch {
      // private window: the choice lasts for this visit
    }
  };

  const relationOf = useMemo(() => {
    const m = new Map((report?.entities ?? []).map((e) => [e.id, e.relation]));
    return (id: string) => m.get(id);
  }, [report]);
  const engines = report?.engines ?? settings?.engines ?? [];
  const on = engines.filter((e) => e.enabled);
  const rows = useMemo(() => orderRows(report?.entities ?? []), [report]);
  const focused = rows.find((r) => r.id === focus) ?? null;

  if (viewing) {
    return (
      <Drawer title="AI visibility" subtitle={<span className="muted">One answer</span>} onClose={onClose} className="vis-drawer">
        <AnswerView answer={viewing} relationOf={relationOf} onBack={() => setViewing(null)} />
      </Drawer>
    );
  }

  return (
    <Drawer
      title="AI visibility"
      subtitle={report ? <span className="muted mono">{`${formatRange(report.from, report.to)} · ${plural(report.totals.answers, "answer")}`}</span> : null}
      onClose={onClose}
      className="vis-drawer"
    >
      <section className="dsec">
        <p className="vis-lede-main">
          What ChatGPT, Claude, Perplexity and Gemini say when people ask the questions below. Answers change from run to run, so one answer proves little: watch how often a name comes up, and the trend.
        </p>
        <div className="seg vis-period" role="radiogroup" aria-label="Period">
          {VIS_PERIODS.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={period === p.id} className="seg-btn" onClick={() => changePeriod(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      </section>

      <PanelState error={error} loading={!report && !error} onRetry={load} />

      {report ? (
        <>
          <section className="dsec">
            <div className="vis-nums">
              <BigNumber value={report.totals.answers.toLocaleString()} label="answers read" title={`${report.totals.prompts} questions asked in this period`} />
              <BigNumber value={String(on.length)} label={on.length === 1 ? "engine on" : "engines on"} muted={!on.length} />
              <BigNumber value={sharePct(report.citations.ownShare)} label="of sources are your own sites" muted={report.citations.ownShare === null} title={`${report.citations.own} of ${report.citations.total} citations`} />
              {report.totals.capped ? <BigNumber value={String(report.totals.capped)} label="skipped at the spend cap" /> : null}
            </div>
            <EnginesList engines={engines} isOwner={isOwner} settings={settings} onSaved={(s) => { setSettings(s); load(); }} />
          </section>

          <section className="dsec" aria-labelledby="vis-names-h">
            <h3 id="vis-names-h" className="section-h">
              How often each name comes up <span className="muted vis-h-sub">· change against the {days} days before</span>
            </h3>
            {rows.length ? (
              <ul className="vis-names">
                {rows.map((r) => (
                  <li key={r.id} className={`vis-name${r.id === focus ? " vis-name-on" : ""}`} data-depth={r.parentId ? 1 : 0}>
                    <NameRow row={r} expanded={r.id === focus} onToggle={() => setFocus((f) => (f === r.id ? null : r.id))} />
                    {r.id === focus ? (
                      <EntityFocus
                        row={r}
                        domains={settings?.settings.domains[r.id] ?? []}
                        canEdit={canEdit}
                        relationOf={relationOf}
                        onOpen={setViewing}
                        onDomains={async (ds) => {
                          const next = await visibilityApi.updateSettings({ domains: { [r.id]: ds } });
                          setSettings(next);
                          toast(ds.length ? `Saved ${r.name}'s sites` : `Cleared ${r.name}'s sites`);
                          load();
                        }}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Nothing tracked yet. Track a party, brand or person first; then their mentions show here.</p>
            )}
            {focused === null && focusEntityId && !rows.some((r) => r.id === focusEntityId) ? <p className="muted small">That name has no answers in this period.</p> : null}
          </section>

          <section className="dsec" aria-labelledby="vis-src-h">
            <h3 id="vis-src-h" className="section-h">
              Sources the answers cite
            </h3>
            {report.citations.total ? (
              <div className="vis-sources">
                <div>
                  <h4 className="vis-h4">Your sites</h4>
                  {report.citations.ownDomains.length ? (
                    <ul className="vis-domains">
                      {report.citations.ownDomains.map((d) => (
                        <li key={d.domain}>
                          <span className="mono">{d.domain}</span>
                          <span className="muted small">{rows.find((r) => r.id === d.ownerEntityId)?.name}</span>
                          <span className="mono vis-domain-n">{d.citations}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted small">None yet. Add each name's own sites under its row above, so citations to them count.</p>
                  )}
                </div>
                <div>
                  <h4 className="vis-h4">Other sites</h4>
                  <ul className="vis-domains">
                    {report.citations.otherDomains.slice(0, 8).map((d) => (
                      <li key={d.domain}>
                        <span className="mono">{d.domain}</span>
                        <span className="muted small">{plural(d.answers, "answer")}</span>
                        <span className="mono vis-domain-n">{d.citations}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <p className="muted">No sources cited in this period.</p>
            )}
            <p className="muted small vis-note">The sites assistants cite are the ones worth being on: reviews, guides and forums they lean on, and your own pages.</p>
          </section>

          <PromptsSection
            prompts={prompts}
            names={(report.entities ?? []).map((e) => ({ id: e.id, name: e.name }))}
            cadences={(settings?.settings.cadences ?? ["daily", "weekly"]) as VisCadence[]}
            canEdit={canEdit}
            canRun={on.length > 0}
            onChanged={load}
            onShowAnswers={(promptId) => setAnswerFilter({ promptId })}
          />

          <section className="dsec" aria-labelledby="vis-latest-h">
            <div className="vis-sec-head">
              <h3 id="vis-latest-h" className="section-h">
                Latest answers
              </h3>
              <span className="vis-sec-actions">
                <label className="vis-inline-field">
                  <span className="sr-only">Question</span>
                  <select className="select select-small" value={answerFilter.promptId ?? ""} onChange={(e) => setAnswerFilter((f) => ({ ...f, promptId: e.target.value || undefined }))} aria-label="Question">
                    <option value="">Every question</option>
                    {prompts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.question.length > 40 ? `${p.question.slice(0, 40)}…` : p.question}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="vis-inline-field">
                  <span className="sr-only">Engine</span>
                  <select className="select select-small" value={answerFilter.engine ?? ""} onChange={(e) => setAnswerFilter((f) => ({ ...f, engine: e.target.value || undefined }))} aria-label="Engine">
                    <option value="">Every engine</option>
                    {engines.filter((e) => e.configured).map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.label}
                      </option>
                    ))}
                  </select>
                </label>
              </span>
            </div>
            {(answers ?? report.latest).length ? (
              <ul className="vis-answers">
                {(answers ?? report.latest).map((a) => (
                  <AnswerCard key={a.id} answer={a} relationOf={relationOf} onOpen={() => setViewing(a)} />
                ))}
              </ul>
            ) : (
              <p className="muted">No answers yet. {on.length ? "Ask a question now, or wait for the hourly run." : "Turn on an engine first."}</p>
            )}
          </section>
        </>
      ) : null}
    </Drawer>
  );
}

/** Top-level names by share, each followed by the people who belong to it. */
function orderRows(rows: VisEntityRow[]): VisEntityRow[] {
  const byShare = (a: VisEntityRow, b: VisEntityRow) => (b.share ?? -1) - (a.share ?? -1) || a.name.localeCompare(b.name);
  const ids = new Set(rows.map((r) => r.id));
  const top = rows.filter((r) => !r.parentId || !ids.has(r.parentId)).sort(byShare);
  return top.flatMap((t) => [t, ...rows.filter((r) => r.parentId === t.id).sort(byShare)]);
}

function NameRow({ row, expanded, onToggle }: { row: VisEntityRow; expanded: boolean; onToggle: () => void }) {
  const pts = sharePts(row.change.share);
  const dir = row.change.share === null || Math.round(row.change.share * 100) === 0 ? "flat" : row.change.share > 0 ? "up" : "down";
  return (
    <div className="vis-name-row">
      <span className="vis-name-id">
        <button type="button" className="linkish vis-name-btn" aria-expanded={expanded} onClick={onToggle}>
          {row.name}
        </button>
        <RelationPill relation={row.relation} />
      </span>
      <span className="vis-name-share">
        <span className="mono vis-big">{sharePct(row.share)}</span>
        <span className="muted small">of {plural(row.answers, "answer")}</span>
      </span>
      <span className="vis-name-meta small">
        <span title="Average order among your tracked names, where it was named. #1 is named first.">
          <span className="muted">avg </span>
          <span className="mono">{positionLabel(row.avgPosition)}</span>
        </span>
        <Tone value={row.sentiment} />
        {pts ? (
          <span className={`vis-change vis-change-${dir}`} title={`Before: ${sharePct(row.previous.share)} of ${plural(row.previous.answers, "answer")}`}>
            {dir === "up" ? "▲ " : dir === "down" ? "▼ " : ""}
            {pts}
          </span>
        ) : (
          <span className="muted">new</span>
        )}
      </span>
      <ShareSpark trend={row.trend} />
    </div>
  );
}

function EntityFocus({
  row,
  domains,
  canEdit,
  relationOf,
  onOpen,
  onDomains,
}: {
  row: VisEntityRow;
  domains: string[];
  canEdit: boolean;
  relationOf: (id: string) => string | undefined;
  onOpen: (a: VisAnswer) => void;
  onDomains: (ds: string[]) => Promise<void>;
}) {
  const [mentioned, setMentioned] = useState(true);
  const [list, setList] = useState<VisAnswer[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(domains);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    setList(null);
    void visibilityApi.answers({ entity: row.id, mentioned, limit: 4 }).then(
      (xs) => live && setList(xs),
      () => live && setList([]),
    );
    return () => {
      live = false;
    };
  }, [row.id, mentioned]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await onDomains(draft);
      setEditing(false);
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="vis-focus">
      <div className="vis-focus-grid">
        <div>
          <h4 className="vis-h4">By engine</h4>
          <ul className="vis-bars">
            {row.byEngine.map((e) => (
              <ShareBar key={e.engine} label={engineLabel(e.engine)} share={e.share} answers={e.answers} sub={e.avgPosition !== null ? `avg ${positionLabel(e.avgPosition)}` : null} />
            ))}
          </ul>
        </div>
        <div>
          <h4 className="vis-h4">By language</h4>
          <ul className="vis-bars">
            {row.byLanguage.map((l) => (
              <ShareBar key={l.lang} label={languageName(l.lang)} share={l.share} answers={l.answers} />
            ))}
          </ul>
        </div>
      </div>
      {row.flagged ? <p className="small vis-flag">{plural(row.flagged, "answer")} said something that may be wrong about {row.name}. Open them below to check.</p> : null}
      <div className="vis-own">
        <span className="small">
          <span className="muted">Own sites: </span>
          {domains.length ? <span className="mono">{domains.join(", ")}</span> : <span className="muted">none set</span>}
          {row.ownCitations ? <span className="muted"> · cited {plural(row.ownCitations, "time")}</span> : null}
        </span>
        {canEdit && !editing ? (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => { setDraft(domains); setEditing(true); }}>
            Edit sites
          </button>
        ) : null}
      </div>
      {editing ? (
        <div className="vis-own-form">
          <ChipsInput id={`vis-dom-${row.id}`} label={`${row.name}'s own sites`} what="site" values={draft} onChange={setDraft} placeholder="example.com" help="Citations to these domains, and their subdomains, count as its own." max={10} maxLength={253} />
          {saveError ? (
            <div className="card-error" role="alert">
              {saveError}
            </div>
          ) : null}
          <div className="vis-form-actions">
            <button type="button" className="btn btn-small btn-primary" disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save sites"}
            </button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <div className="vis-sec-head">
        <h4 className="vis-h4">{mentioned ? `Answers that name ${row.name}` : `Answers that leave ${row.name} out`}</h4>
        <div className="seg" role="radiogroup" aria-label="Which answers">
          <button type="button" role="radio" aria-checked={mentioned} className="seg-btn" onClick={() => setMentioned(true)}>
            Named
          </button>
          <button type="button" role="radio" aria-checked={!mentioned} className="seg-btn" onClick={() => setMentioned(false)}>
            Left out
          </button>
        </div>
      </div>
      {list === null ? (
        <p className="muted small">Loading…</p>
      ) : list.length ? (
        <ul className="vis-answers">
          {list.map((a) => (
            <AnswerCard key={a.id} answer={a} relationOf={relationOf} onOpen={() => onOpen(a)} />
          ))}
        </ul>
      ) : (
        <p className="muted small">None in the latest answers.</p>
      )}
    </div>
  );
}

function EnginesList({ engines, isOwner, settings, onSaved }: { engines: VisEngine[]; isOwner: boolean; settings: VisSettingsResponse | null; onSaved: (s: VisSettingsResponse) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function toggle(id: string, enabled: boolean) {
    const configured = engines.filter((e) => e.configured).map((e) => e.id);
    const current = settings?.settings.engines ?? configured;
    const next = enabled ? [...new Set([...current, id])] : current.filter((x) => x !== id);
    setBusy(true);
    setError(null);
    try {
      onSaved(await visibilityApi.updateSettings({ engines: next.length === configured.length && configured.every((c) => next.includes(c)) ? null : next }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function cadence(c: VisCadence, allowed: boolean) {
    const cur = settings?.settings.cadences ?? ["daily", "weekly"];
    const next = allowed ? [...new Set([...cur, c])] : cur.filter((x) => x !== c);
    if (!next.length) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await visibilityApi.updateSettings({ cadences: next }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="vis-engines">
      <ul className="vis-engine-list" aria-label="Answer engines">
        {engines.map((e) => (
          <li key={e.id} className={`vis-engine${e.configured ? "" : " vis-engine-off"}`}>
            <span className="vis-engine-name strong">{e.label}</span>
            {e.configured ? (
              isOwner ? (
                <label className="vis-check small">
                  <input type="checkbox" checked={e.enabled} disabled={busy} onChange={(ev) => void toggle(e.id, ev.target.checked)} /> Ask
                </label>
              ) : (
                <span className={`small ${e.enabled ? "vis-on" : "muted"}`}>{e.enabled ? "On" : "Off for this workspace"}</span>
              )
            ) : (
              <span className="small muted">
                Not set up: set <code className="vis-code">{e.envVar}</code>
              </span>
            )}
            <span className="muted small mono vis-engine-model">{e.configured ? e.model : ""}</span>
          </li>
        ))}
      </ul>
      {isOwner ? (
        <div className="vis-limits small">
          <span className="muted">Editors may choose:</span>
          {(["daily", "weekly"] as const).map((c) => (
            <label key={c} className="vis-check">
              <input type="checkbox" checked={(settings?.settings.cadences ?? ["daily", "weekly"]).includes(c)} disabled={busy} onChange={(ev) => void cadence(c, ev.target.checked)} /> {c === "daily" ? "daily runs" : "weekly runs"}
            </label>
          ))}
        </div>
      ) : null}
      {error ? (
        <div className="card-error" role="alert">
          {error}
        </div>
      ) : null}
      <p className="muted small vis-note">Every answer and every tone check counts toward the monthly model spend cap in Settings. Past it, questions are skipped and marked as such.</p>
    </div>
  );
}
