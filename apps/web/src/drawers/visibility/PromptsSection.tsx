import { useState, type FormEvent } from "react";
import type { VisCadence, VisPrompt, VisPromptInput, VisSuggestion } from "../../lib/visibility";
import { visibilityApi, errorText, isApiError } from "../../api";
import { ChipsInput } from "../../components/ChipsInput";
import { RelativeTime } from "../../components/RelativeTime";
import { useToast } from "../../components/Toast";
import { languageName } from "../../lib/lang";
import { plural } from "../../lib/format";

interface NameOption {
  id: string;
  name: string;
}

const CADENCE_LABEL: Record<VisCadence, string> = { daily: "Daily", weekly: "Weekly" };

/** The questions the workspace asks AI assistants: add, edit, suggest, run now, archive. */
export function PromptsSection({
  prompts,
  names,
  cadences,
  canEdit,
  canRun,
  onChanged,
  onShowAnswers,
}: {
  prompts: VisPrompt[];
  names: NameOption[];
  cadences: VisCadence[];
  canEdit: boolean;
  /** An engine is on, so asking now does something. */
  canRun: boolean;
  onChanged: () => void;
  onShowAnswers: (promptId: string) => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState<VisSuggestion[] | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [preset, setPreset] = useState<VisPromptInput | null>(null);

  async function run(p: VisPrompt) {
    setRunning(p.id);
    setRowError(null);
    try {
      const r = await visibilityApi.runPrompt(p.id);
      toast(`Asked ${plural(r.answers + r.errors + r.capped, "time")}: ${plural(r.answers, "answer")}${r.capped ? `, ${r.capped} skipped at the spend cap` : ""}${r.errors ? `, ${plural(r.errors, "error")}` : ""}`);
      onChanged();
    } catch (e) {
      setRowError({ id: p.id, text: isApiError(e) && e.status === 503 ? "No answer engine is on for this workspace yet." : errorText(e) });
    } finally {
      setRunning(null);
    }
  }

  async function archive(p: VisPrompt) {
    setRowError(null);
    try {
      await visibilityApi.archivePrompt(p.id);
      setConfirming(null);
      toast("Stopped asking that question. Its past answers stay in the report.");
      onChanged();
    } catch (e) {
      setRowError({ id: p.id, text: errorText(e) });
    }
  }

  async function suggest() {
    setSuggesting(true);
    setSuggestError(null);
    try {
      const langs = [...new Set(prompts.flatMap((p) => p.languages))].slice(0, 4);
      const r = await visibilityApi.suggest(langs.length ? langs : undefined, 8);
      setSuggestions(r.questions);
    } catch (e) {
      setSuggestError(isApiError(e) && e.status === 503 ? "Suggestions need a model on this server, within the monthly spend cap." : errorText(e));
    } finally {
      setSuggesting(false);
    }
  }

  return (
    <section className="dsec" aria-labelledby="vis-q-h">
      <div className="vis-sec-head">
        <h3 id="vis-q-h" className="section-h">
          Questions asked
        </h3>
        {canEdit && editing === null ? (
          <span className="vis-sec-actions">
            <button type="button" className="btn btn-small" disabled={suggesting} onClick={() => void suggest()}>
              {suggesting ? "Thinking…" : "Suggest questions"}
            </button>
            <button
              type="button"
              className="btn btn-small btn-primary"
              onClick={() => {
                setPreset(null);
                setEditing("new");
              }}
            >
              Add a question
            </button>
          </span>
        ) : null}
      </div>
      <p className="muted small vis-lede">Write them the way your audience would type them. Open questions that name nobody show whether you come up unprompted.</p>
      {suggestError ? (
        <div className="card-error" role="alert">
          {suggestError}
        </div>
      ) : null}
      {suggestions ? (
        <div className="vis-suggest">
          <div className="vis-sec-head">
            <span className="small strong">Suggestions</span>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setSuggestions(null)}>
              Hide
            </button>
          </div>
          {suggestions.length ? (
            <ul className="vis-suggest-list">
              {suggestions.map((s) => (
                <li key={s.question} className="vis-suggest-row">
                  <div>
                    <div>{s.question}</div>
                    <div className="muted small">
                      {languageName(s.lang)} · {s.why}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => {
                      setPreset({ question: s.question, languages: [s.lang] });
                      setEditing("new");
                      setSuggestions((xs) => xs?.filter((x) => x.question !== s.question) ?? null);
                    }}
                  >
                    Use
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Nothing new to suggest.</p>
          )}
        </div>
      ) : null}
      {editing === "new" ? (
        <PromptForm
          key={preset?.question ?? "new"}
          names={names}
          cadences={cadences}
          initial={preset}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast("Added. It is asked on the next hourly run, or now with Ask now.");
            onChanged();
          }}
        />
      ) : null}
      {prompts.length === 0 && editing === null ? <p className="muted">No questions yet. {canEdit ? "Add one, or ask for suggestions." : "An editor adds them."}</p> : null}
      <ul className="vis-prompts">
        {prompts.map((p) =>
          editing === p.id ? (
            <li key={p.id} className="vis-prompt">
              <PromptForm
                prompt={p}
                names={names}
                cadences={cadences}
                onCancel={() => setEditing(null)}
                onSaved={() => {
                  setEditing(null);
                  toast("Saved");
                  onChanged();
                }}
              />
            </li>
          ) : (
            <li key={p.id} className="vis-prompt">
              <div className="vis-prompt-q">{p.question}</div>
              <div className="vis-prompt-meta muted small">
                <span>{p.languages.map((l) => languageName(l)).join(", ")}</span>
                {p.regions.length ? <span>from {p.regions.join(", ")}</span> : null}
                <span>{CADENCE_LABEL[p.cadence]}</span>
                <span>{p.entityIds.length ? `looks for ${plural(p.entityIds.length, "name")}` : "looks for every tracked name"}</span>
                <span>
                  {p.due ? (
                    <span className="vis-due">due now</span>
                  ) : p.lastRunAt ? (
                    <>
                      asked <RelativeTime iso={p.lastRunAt} />
                    </>
                  ) : (
                    "not asked yet"
                  )}
                </span>
              </div>
              {rowError?.id === p.id ? (
                <div className="card-error" role="alert">
                  {rowError.text}
                </div>
              ) : null}
              <div className="vis-prompt-actions">
                <button type="button" className="btn btn-small btn-ghost" onClick={() => onShowAnswers(p.id)}>
                  Answers
                </button>
                {canEdit ? (
                  <>
                    <button type="button" className="btn btn-small" disabled={!canRun || running !== null} title={canRun ? "Ask every engine that is on, in every language, now" : "No answer engine is on"} onClick={() => void run(p)}>
                      {running === p.id ? "Asking…" : "Ask now"}
                    </button>
                    <button type="button" className="btn btn-small btn-ghost" onClick={() => setEditing(p.id)}>
                      Edit
                    </button>
                    {confirming === p.id ? (
                      <span className="acct-confirm" role="group" aria-label="Stop asking this question?">
                        <span>Stop asking?</span>
                        <button type="button" className="btn btn-small btn-danger" onClick={() => void archive(p)}>
                          Yes
                        </button>
                        <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirming(null)}>
                          No
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirming(p.id)}>
                        Archive
                      </button>
                    )}
                  </>
                ) : null}
              </div>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

function PromptForm({
  prompt,
  initial,
  names,
  cadences,
  onCancel,
  onSaved,
}: {
  prompt?: VisPrompt;
  initial?: VisPromptInput | null;
  names: NameOption[];
  cadences: VisCadence[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const idBase = prompt?.id ?? "new";
  const [question, setQuestion] = useState(prompt?.question ?? initial?.question ?? "");
  const [languages, setLanguages] = useState<string[]>(prompt?.languages ?? initial?.languages ?? ["en"]);
  const [translations, setTranslations] = useState<Record<string, string>>(prompt?.translations ?? {});
  const [regions, setRegions] = useState<string[]>(prompt?.regions ?? []);
  const [cadence, setCadence] = useState<VisCadence>(prompt?.cadence ?? (cadences.includes("weekly") ? "weekly" : (cadences[0] ?? "weekly")));
  const [scope, setScope] = useState<string[]>(prompt?.entityIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const extra = languages.slice(1);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const keep = Object.fromEntries(Object.entries(translations).filter(([l, t]) => languages.includes(l) && t.trim()));
    const input: VisPromptInput = { question: question.trim(), languages, translations: keep, regions: regions.map((r) => r.toUpperCase()), cadence, entityIds: scope };
    try {
      if (prompt) await visibilityApi.updatePrompt(prompt.id, input);
      else await visibilityApi.createPrompt(input);
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="vis-form" onSubmit={(e) => void submit(e)}>
      <label className="field">
        <span>Question, as a person would ask it</span>
        <textarea className="input vis-textarea" required minLength={3} maxLength={500} rows={2} value={question} placeholder="Best independent coffee roasters in Vancouver" onChange={(e) => setQuestion(e.target.value)} />
      </label>
      <ChipsInput id={`vis-langs-${idBase}`} label="Languages to ask in" what="language" values={languages} onChange={(v) => setLanguages(v.map((x) => x.trim()).filter(Boolean))} placeholder="en, ja, es" help="Language codes. The first is the question's own language." max={6} maxLength={12} />
      {extra.map((l) => (
        <label key={l} className="field">
          <span>The question in {languageName(l)} (optional)</span>
          <input className="input" value={translations[l] ?? ""} maxLength={500} placeholder={`Without one, it is asked as written and the answer requested in ${languageName(l)}`} onChange={(e) => setTranslations((t) => ({ ...t, [l]: e.target.value }))} />
        </label>
      ))}
      <ChipsInput id={`vis-regions-${idBase}`} label="Ask from (optional)" what="country" values={regions} onChange={(v) => setRegions(v.map((x) => x.trim().toUpperCase()).filter(Boolean))} placeholder="CA, JP" help="Two-letter country codes. Engines that support it search as if from there." max={6} maxLength={2} />
      <div className="vis-form-row">
        <label className="field">
          <span>How often</span>
          <select className="select" value={cadence} onChange={(e) => setCadence(e.target.value as VisCadence)}>
            {(["daily", "weekly"] as const).map((c) => (
              <option key={c} value={c} disabled={!cadences.includes(c)}>
                {CADENCE_LABEL[c]}
                {!cadences.includes(c) ? " (an owner turned this off)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="vis-scope">
        <legend className="small">Names to look for</legend>
        <label className="vis-check">
          <input type="checkbox" checked={scope.length === 0} onChange={() => setScope([])} /> Every tracked name
        </label>
        <div className="vis-scope-list">
          {names.map((n) => (
            <label key={n.id} className="vis-check">
              <input type="checkbox" checked={scope.includes(n.id)} onChange={(e) => setScope((s) => (e.target.checked ? [...s, n.id] : s.filter((x) => x !== n.id)))} /> {n.name}
            </label>
          ))}
        </div>
      </fieldset>
      {error ? (
        <div className="card-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="vis-form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || question.trim().length < 3 || !languages.length}>
          {busy ? "Saving…" : prompt ? "Save" : "Add question"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
