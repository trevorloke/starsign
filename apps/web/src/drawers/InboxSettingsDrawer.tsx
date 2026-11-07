// ---- inbox workflow: labels, routing rules, first-response targets and saved replies.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { InboxPriority, InboxRule, InboxRuleActions, InboxRuleInput, InboxSettings, InboxTag, InboxTagColor, Member, Network, SavedReply } from "../types";
import { api, errorText } from "../api";
import { ChipsInput } from "../components/ChipsInput";
import { Drawer } from "../components/Drawer";
import { PanelState } from "../components/PanelState";
import { useToast } from "../components/Toast";
import { kindLabel, networkLabel, plural } from "../lib/format";
import { DAY_NAMES, PRIORITIES, PRIORITY_LABEL, SAVED_REPLY_VARIABLES, TAG_COLORS, memberName } from "../lib/inbox";
import { languageName } from "../lib/lang";
import { useRoom } from "../lib/room";

const SECTIONS = [
  { id: "labels", label: "Labels" },
  { id: "targets", label: "Response targets" },
  { id: "rules", label: "Rules" },
  { id: "replies", label: "Saved replies" },
] as const;
const MANAGE_NOTE = "Only an owner or approver, signed in as a person, can change this.";
const RULE_KINDS = ["mention", "reply", "comment", "dm", "message", "quote"];
/** The list with items i and i + 1 swapped. */
const swap = (ids: string[], i: number) => ids.map((id, j) => (j === i ? ids[i + 1]! : j === i + 1 ? ids[i]! : id));

export function InboxSettingsDrawer({
  canManage,
  canEditReplies,
  members,
  onClose,
  onSettings,
}: {
  canManage: boolean;
  canEditReplies: boolean;
  /** People who can work the inbox (editors and up). */
  members: Member[];
  onClose: () => void;
  onSettings: (s: InboxSettings) => void;
}) {
  const [settings, setSettings] = useState<InboxSettings | null>(null);
  const [rules, setRules] = useState<InboxRule[] | null>(null);
  const [replies, setReplies] = useState<SavedReply[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([api.inboxSettings(), api.inboxRules(), api.savedReplies()])
      .then(([s, r, sr]) => {
        setSettings(s);
        setRules(r);
        setReplies(sr);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  const saved = (s: InboxSettings) => {
    setSettings(s);
    onSettings(s);
  };

  return (
    <Drawer title="Inbox settings" className="drawer-wide settings-drawer ibx-settings" subtitle={<span className="muted">Shared by everyone in this workspace</span>} onClose={onClose}>
      <nav className="settings-nav" aria-label="Inbox settings sections">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className="chip" onClick={() => document.getElementById(`ibx-set-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            {s.label}
          </button>
        ))}
      </nav>
      <PanelState error={error} loading={!settings && !error} onRetry={load} />
      {settings && rules && replies ? (
        <>
          <Section id="labels" title="Labels" lede="The labels conversations can carry. Taking one off the list takes it off every conversation.">
            <LabelsSection tags={settings.tags} canEdit={canManage} onSaved={saved} />
          </Section>
          <Section id="targets" title="Response targets" lede={`How soon a first reply is due, by priority. The queue shows time left or how late. Hours are in ${settings.timezone}.`}>
            <TargetsSection settings={settings} canEdit={canManage} onSaved={saved} />
          </Section>
          <Section id="rules" title={rules.length ? plural(rules.length, "rule") : "Rules"} lede="Checked in order when a new conversation arrives. For assignee, priority and spam, the first matching rule decides; labels from every matching rule add up.">
            <RulesSection rules={rules} tags={settings.tags} members={members} canEdit={canManage} onRules={setRules} />
          </Section>
          <Section id="replies" title="Saved replies" lede="Shared answers for the reply box. They go in, you edit, then they pass the red lines like any reply.">
            <RepliesSection replies={replies} canEdit={canEditReplies} onReplies={setReplies} />
          </Section>
        </>
      ) : null}
    </Drawer>
  );
}

function Section({ id, title, lede, children }: { id: string; title: string; lede: string; children: React.ReactNode }) {
  return (
    <section id={`ibx-set-${id}`} className="dsec settings-sec" aria-labelledby={`ibx-set-${id}-h`}>
      <h3 id={`ibx-set-${id}-h`} className="section-h">
        {title}
      </h3>
      <p className="small settings-lede">{lede}</p>
      {children}
    </section>
  );
}

function SaveRow({ busy, dirty, error, onUndo, disabled }: { busy: boolean; dirty: boolean; error: string | null; onUndo: () => void; disabled?: boolean }) {
  return (
    <>
      {error ? (
        <div className="card-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="dsec-act">
        <button type="submit" className="btn btn-primary" disabled={busy || !dirty || disabled}>
          {busy ? "Saving…" : "Save"}
        </button>
        {dirty && !busy ? (
          <button type="button" className="btn btn-ghost" onClick={onUndo}>
            Undo changes
          </button>
        ) : null}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- labels

function LabelsSection({ tags, canEdit, onSaved }: { tags: InboxTag[]; canEdit: boolean; onSaved: (s: InboxSettings) => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<InboxTag[]>(tags);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(tags);

  function addTag() {
    const n = name.trim();
    if (!n) return;
    if (draft.some((t) => t.name.toLowerCase() === n.toLowerCase())) {
      setError(`“${n}” is already a label.`);
      return;
    }
    setError(null);
    setDraft([...draft, { name: n.slice(0, 40), color: TAG_COLORS[draft.length % TAG_COLORS.length]! }]);
    setName("");
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateInboxSettings({ tags: draft }));
      toast("Labels saved.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void save(e)}>
      <ul className="ibx-set-list">
        {draft.map((t, i) => (
          <li key={t.name} className="ibx-set-row">
            <span className={`ibx-label ibx-c-${t.color}`}>{t.name}</span>
            <label className="ibx-inline">
              <span className="sr-only">Colour of {t.name}</span>
              <select className="select select-small" value={t.color} disabled={!canEdit} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, color: e.target.value as InboxTagColor } : x)))}>
                {TAG_COLORS.map((c) => (
                  <option key={c} value={c}>
                    {c[0]!.toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            {canEdit ? (
              <button type="button" className="btn btn-ghost btn-small" aria-label={`Remove the label ${t.name}`} onClick={() => setDraft(draft.filter((_, j) => j !== i))}>
                Remove
              </button>
            ) : null}
          </li>
        ))}
        {!draft.length ? <li className="muted small">No labels yet.</li> : null}
      </ul>
      {canEdit ? (
        <div className="ibx-set-add">
          <label className="ibx-inline">
            <span className="sr-only">New label</span>
            <input
              className="input input-small"
              placeholder="New label, e.g. wholesale"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag();
                }
              }}
            />
          </label>
          <button type="button" className="btn btn-small" disabled={!name.trim()} onClick={addTag}>
            Add label
          </button>
        </div>
      ) : (
        <p className="muted small">{MANAGE_NOTE}</p>
      )}
      {canEdit ? <SaveRow busy={busy} dirty={dirty} error={error} onUndo={() => setDraft(tags)} /> : null}
    </form>
  );
}

// ---------------------------------------------------------------- response targets

function TargetsSection({ settings, canEdit, onSaved }: { settings: InboxSettings; canEdit: boolean; onSaved: (s: InboxSettings) => void }) {
  const toast = useToast();
  const [sla, setSla] = useState(settings.sla);
  const [bh, setBh] = useState(settings.businessHours);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(sla) !== JSON.stringify(settings.sla) || JSON.stringify(bh) !== JSON.stringify(settings.businessHours);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (bh.enabled && bh.end <= bh.start) {
      setError("Business hours must end after they start, on the same day.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateInboxSettings({ sla, businessHours: bh }));
      toast("Response targets saved. Waiting conversations use them now.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void save(e)}>
      <div className="ibx-targets">
        {PRIORITIES.map((p: InboxPriority) => (
          <label key={p} className="ibx-target">
            <span className={`ibx-prio ibx-prio-${p}`}>{PRIORITY_LABEL[p]}</span>
            <span className="ibx-target-input">
              <input
                className="input input-small mono"
                type="number"
                min={1}
                max={20160}
                value={sla[p]}
                disabled={!canEdit}
                onChange={(e) => setSla({ ...sla, [p]: Math.max(1, Number(e.target.value) || 1) })}
                aria-label={`${PRIORITY_LABEL[p]}: first reply within, in minutes`}
              />
              <span className="muted small">minutes</span>
            </span>
          </label>
        ))}
      </div>
      <label className="ibx-check-line">
        <input type="checkbox" checked={bh.enabled} disabled={!canEdit} onChange={(e) => setBh({ ...bh, enabled: e.target.checked })} />
        <span>Count business hours only</span>
      </label>
      {bh.enabled ? (
        <div className="ibx-hours">
          <div className="ibx-days" role="group" aria-label="Business days">
            {DAY_NAMES.map((d, i) => {
              const on = bh.days.includes(i);
              return (
                <button
                  key={d}
                  type="button"
                  className={`chip${on ? " chip-on" : ""}`}
                  aria-pressed={on}
                  disabled={!canEdit || (on && bh.days.length === 1)}
                  onClick={() => setBh({ ...bh, days: on ? bh.days.filter((x) => x !== i) : [...bh.days, i].sort() })}
                >
                  {d}
                </button>
              );
            })}
          </div>
          <label className="ibx-inline">
            <span className="small">From</span>
            <input className="input input-small mono" type="time" value={bh.start} disabled={!canEdit} onChange={(e) => setBh({ ...bh, start: e.target.value })} />
          </label>
          <label className="ibx-inline">
            <span className="small">to</span>
            <input className="input input-small mono" type="time" value={bh.end} disabled={!canEdit} onChange={(e) => setBh({ ...bh, end: e.target.value })} />
          </label>
        </div>
      ) : null}
      {canEdit ? <SaveRow busy={busy} dirty={dirty} error={error} onUndo={() => (setSla(settings.sla), setBh(settings.businessHours))} /> : <p className="muted small">{MANAGE_NOTE}</p>}
    </form>
  );
}

// ---------------------------------------------------------------- rules

function ruleSummary(r: InboxRule, members: Member[], streams: Map<string, string>): { when: string; then: string } {
  const c = r.conditions;
  const parts: string[] = [];
  if (c.keywords.length) parts.push(`says ${c.keywords.map((k) => `“${k}”`).join(" or ")}`);
  if (c.networks.length) parts.push(`is on ${c.networks.map(networkLabel).join(" or ")}`);
  if (c.kinds.length) parts.push(`is a ${c.kinds.map((k) => kindLabel(k).toLowerCase()).join(" or ")}`);
  if (c.languages.length) parts.push(`is in ${c.languages.map((l) => languageName(l)).join(" or ")}`);
  if (c.streams.length) parts.push(`matches ${c.streams.map((s) => streams.get(s) ?? s).join(" or ")}`);
  if (c.entities.length) parts.push(`is about ${plural(c.entities.length, "tracked name")}`);
  const a = r.actions;
  const then: string[] = [];
  if (a.assignee) then.push(`assign ${memberName(members, a.assignee)}`);
  if (a.roundRobin?.length) then.push(`take turns: ${a.roundRobin.map((u) => memberName(members, u)).join(", ")}`);
  if (a.priority) then.push(`priority ${PRIORITY_LABEL[a.priority].toLowerCase()}`);
  if (a.tags?.length) then.push(`label ${a.tags.join(", ")}`);
  if (a.spam) then.push("mark spam");
  return { when: parts.length ? `When it ${parts.join(" and ")}` : "Every new conversation", then: then.join(" · ") };
}

function RulesSection({ rules, tags, members, canEdit, onRules }: { rules: InboxRule[]; tags: InboxTag[]; members: Member[]; canEdit: boolean; onRules: (r: InboxRule[]) => void }) {
  const toast = useToast();
  const { streamsById } = useRoom();
  const streams = useMemo(() => new Map([...streamsById.values()].map((s) => [s.id, s.name])), [streamsById]);
  const [editing, setEditing] = useState<InboxRule | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    }
  }
  const reload = async () => onRules(await api.inboxRules());

  return (
    <>
      <ol className="ibx-rules">
        {rules.map((r, i) => {
          const s = ruleSummary(r, members, streams);
          return (
            <li key={r.id} className={`ibx-rule${r.enabled ? "" : " ibx-rule-off"}`}>
              <span className="ibx-rule-n mono">{i + 1}</span>
              <div className="ibx-rule-body">
                <span className="strong">{r.name}</span>
                <span className="small">{s.when}</span>
                <span className="small muted">→ {s.then}</span>
              </div>
              {canEdit ? (
                <span className="ibx-rule-actions">
                  <label className="ibx-inline small">
                    <input type="checkbox" checked={r.enabled} onChange={(e) => void run(async () => (await api.updateInboxRule(r.id, { enabled: e.target.checked }), await reload()))} />
                    On
                  </label>
                  <button type="button" className="btn btn-ghost btn-small" aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => void run(async () => onRules(await api.reorderInboxRules(swap(rules.map((x) => x.id), i - 1))))}>
                    ↑
                  </button>
                  <button type="button" className="btn btn-ghost btn-small" aria-label={`Move ${r.name} down`} disabled={i === rules.length - 1} onClick={() => void run(async () => onRules(await api.reorderInboxRules(swap(rules.map((x) => x.id), i))))}>
                    ↓
                  </button>
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => setEditing(r)}>
                    Edit
                  </button>
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => void run(async () => (await api.deleteInboxRule(r.id), await reload(), toast(`Removed “${r.name}”.`)))}>
                    Remove
                  </button>
                </span>
              ) : null}
            </li>
          );
        })}
        {!rules.length ? <li className="muted small">No rules yet. New conversations arrive unassigned, at normal priority.</li> : null}
      </ol>
      {error ? (
        <div className="card-error" role="alert">
          {error}
        </div>
      ) : null}
      {canEdit ? (
        editing ? (
          <RuleForm
            key={editing === "new" ? "new" : editing.id}
            rule={editing === "new" ? null : editing}
            tags={tags}
            members={members}
            streams={streams}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await reload();
              toast("Rule saved.");
            }}
          />
        ) : (
          <button type="button" className="btn btn-small" onClick={() => setEditing("new")}>
            Add a rule
          </button>
        )
      ) : (
        <p className="muted small">{MANAGE_NOTE}</p>
      )}
    </>
  );
}

type AssignMode = "none" | "person" | "rotate";

function RuleForm({ rule, tags, members, streams, onCancel, onSaved }: { rule: InboxRule | null; tags: InboxTag[]; members: Member[]; streams: Map<string, string>; onCancel: () => void; onSaved: () => Promise<void> }) {
  const { accountsById } = useRoom();
  const networks = useMemo(() => [...new Set([...accountsById.values()].map((a) => a.network))] as Network[], [accountsById]);
  const c = rule?.conditions;
  const a = rule?.actions ?? {};
  const [name, setName] = useState(rule?.name ?? "");
  const [keywords, setKeywords] = useState<string[]>(c?.keywords ?? []);
  const [nets, setNets] = useState<string[]>(c?.networks ?? []);
  const [kinds, setKinds] = useState<string[]>(c?.kinds ?? []);
  const [langs, setLangs] = useState<string[]>(c?.languages ?? []);
  const [streamIds, setStreamIds] = useState<string[]>(c?.streams ?? []);
  const [mode, setMode] = useState<AssignMode>(a.roundRobin?.length ? "rotate" : a.assignee ? "person" : "none");
  const [person, setPerson] = useState(a.assignee ?? members[0]?.userId ?? "");
  const [rotation, setRotation] = useState<string[]>(a.roundRobin ?? []);
  const [ruleTags, setRuleTags] = useState<string[]>(a.tags ?? []);
  const [priority, setPriority] = useState<InboxPriority | "">(a.priority ?? "");
  const [spam, setSpam] = useState(!!a.spam);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggleIn = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const actions: InboxRuleActions = {
      ...(mode === "person" && person ? { assignee: person } : {}),
      ...(mode === "rotate" && rotation.length ? { roundRobin: rotation } : {}),
      ...(ruleTags.length ? { tags: ruleTags } : {}),
      ...(priority ? { priority } : {}),
      ...(spam ? { spam: true } : {}),
    };
    const input: InboxRuleInput = {
      name: name.trim(),
      conditions: { keywords, networks: nets, kinds, languages: langs.map((l) => l.toLowerCase().slice(0, 3)), streams: streamIds, entities: c?.entities ?? [] },
      actions,
    };
    setBusy(true);
    setError(null);
    try {
      if (rule) await api.updateInboxRule(rule.id, input);
      else await api.createInboxRule(input);
      await onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ibx-rule-form" onSubmit={(e) => void save(e)}>
      <label className="field">
        <span className="field-label">Name</span>
        <input className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Wholesale to Sam" required />
      </label>
      <fieldset className="ibx-fieldset">
        <legend>When a new conversation…</legend>
        <ChipsInput id="rule-kw" label="Says any of these words" what="keyword" values={keywords} onChange={setKeywords} placeholder="refund, wholesale…" />
        {networks.length ? (
          <div className="ibx-chip-group" role="group" aria-label="Is on one of these networks">
            <span className="small">On</span>
            {networks.map((n) => (
              <button key={n} type="button" className={`chip${nets.includes(n) ? " chip-on" : ""}`} aria-pressed={nets.includes(n)} onClick={() => setNets(toggleIn(nets, n))}>
                {networkLabel(n)}
              </button>
            ))}
          </div>
        ) : null}
        <div className="ibx-chip-group" role="group" aria-label="Is one of these kinds">
          <span className="small">Is a</span>
          {RULE_KINDS.map((k) => (
            <button key={k} type="button" className={`chip${kinds.includes(k) ? " chip-on" : ""}`} aria-pressed={kinds.includes(k)} onClick={() => setKinds(toggleIn(kinds, k))}>
              {kindLabel(k)}
            </button>
          ))}
        </div>
        <ChipsInput id="rule-lang" label="Is written in (language codes)" what="language" values={langs} onChange={setLangs} placeholder="ja, es…" maxLength={3} />
        {streams.size ? (
          <div className="ibx-chip-group" role="group" aria-label="Matches one of these streams">
            <span className="small">Matches</span>
            {[...streams.entries()].map(([id, n]) => (
              <button key={id} type="button" className={`chip${streamIds.includes(id) ? " chip-on" : ""}`} aria-pressed={streamIds.includes(id)} onClick={() => setStreamIds(toggleIn(streamIds, id))}>
                {n}
              </button>
            ))}
          </div>
        ) : null}
        <p className="muted small">Leave everything empty to match every new conversation.</p>
      </fieldset>
      <fieldset className="ibx-fieldset">
        <legend>Then</legend>
        <div className="seg seg-small" role="radiogroup" aria-label="Assign">
          {(["none", "person", "rotate"] as AssignMode[]).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className="seg-btn" onClick={() => setMode(m)}>
              {m === "none" ? "Don't assign" : m === "person" ? "Assign one person" : "Take turns"}
            </button>
          ))}
        </div>
        {mode === "person" ? (
          <label className="ibx-inline">
            <span className="small">Assign</span>
            <select className="select select-small" value={person} onChange={(e) => setPerson(e.target.value)}>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name || m.email}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {mode === "rotate" ? (
          <div className="ibx-chip-group" role="group" aria-label="Take turns among">
            {members.map((m) => (
              <button key={m.userId} type="button" className={`chip${rotation.includes(m.userId) ? " chip-on" : ""}`} aria-pressed={rotation.includes(m.userId)} onClick={() => setRotation(toggleIn(rotation, m.userId))}>
                {m.name || m.email}
              </button>
            ))}
          </div>
        ) : null}
        {tags.length ? (
          <div className="ibx-chip-group" role="group" aria-label="Add labels">
            <span className="small">Label</span>
            {tags.map((t) => (
              <button key={t.name} type="button" className={`ibx-label ibx-label-btn ibx-c-${t.color}${ruleTags.includes(t.name) ? " ibx-label-on" : ""}`} aria-pressed={ruleTags.includes(t.name)} onClick={() => setRuleTags(toggleIn(ruleTags, t.name))}>
                {t.name}
              </button>
            ))}
          </div>
        ) : null}
        <label className="ibx-inline">
          <span className="small">Priority</span>
          <select className="select select-small" value={priority} onChange={(e) => setPriority(e.target.value as InboxPriority | "")}>
            <option value="">Leave as is</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="ibx-check-line">
          <input type="checkbox" checked={spam} onChange={(e) => setSpam(e.target.checked)} />
          <span>Mark spam</span>
        </label>
      </fieldset>
      {error ? (
        <div className="card-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="dsec-act">
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
          {busy ? "Saving…" : rule ? "Save rule" : "Add rule"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- saved replies

function RepliesSection({ replies, canEdit, onReplies }: { replies: SavedReply[]; canEdit: boolean; onReplies: (r: SavedReply[]) => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState<SavedReply | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = async () => onReplies(await api.savedReplies());
  return (
    <>
      <ul className="ibx-set-list">
        {replies.map((r) => (
          <li key={r.id} className="ibx-set-row ibx-reply-row">
            <div className="ibx-rule-body">
              <span className="strong">
                {r.name} {r.lang ? <span className="tag">{r.lang.toUpperCase()}</span> : null}
              </span>
              <span className="small muted ibx-saved-text">{r.text}</span>
            </div>
            {canEdit ? (
              <span className="ibx-rule-actions">
                <button type="button" className="btn btn-ghost btn-small" onClick={() => setEditing(r)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  onClick={() =>
                    void api.deleteSavedReply(r.id).then(
                      async () => (await reload(), toast(`Removed “${r.name}”.`)),
                      (e: unknown) => setError(errorText(e)),
                    )
                  }
                >
                  Remove
                </button>
              </span>
            ) : null}
          </li>
        ))}
        {!replies.length ? <li className="muted small">No saved replies yet.</li> : null}
      </ul>
      {error ? (
        <div className="card-error" role="alert">
          {error}
        </div>
      ) : null}
      {canEdit ? (
        editing ? (
          <ReplyForm
            key={editing === "new" ? "new" : editing.id}
            reply={editing === "new" ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await reload();
              toast("Saved reply saved.");
            }}
          />
        ) : (
          <button type="button" className="btn btn-small" onClick={() => setEditing("new")}>
            Add a saved reply
          </button>
        )
      ) : (
        <p className="muted small">Editors, approvers and owners can add saved replies.</p>
      )}
    </>
  );
}

function ReplyForm({ reply, onCancel, onSaved }: { reply: SavedReply | null; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(reply?.name ?? "");
  const [text, setText] = useState(reply?.text ?? "");
  const [lang, setLang] = useState(reply?.lang ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input = { name: name.trim(), text: text.trim(), lang: lang.trim() ? lang.trim().toLowerCase() : null };
      if (reply) await api.updateSavedReply(reply.id, input);
      else await api.createSavedReply(input);
      await onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="ibx-rule-form" onSubmit={(e) => void save(e)}>
      <div className="ibx-two">
        <label className="field">
          <span className="field-label">Name</span>
          <input className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Shipping: where we ship" required />
        </label>
        <label className="field ibx-lang-field">
          <span className="field-label">Language (optional)</span>
          <input className="input mono" value={lang} maxLength={3} onChange={(e) => setLang(e.target.value)} placeholder="es" />
        </label>
      </div>
      <label className="field">
        <span className="field-label">Text</span>
        <textarea className="textarea" rows={4} value={text} maxLength={5000} onChange={(e) => setText(e.target.value)} required />
      </label>
      <p className="muted small">
        Fills in: {SAVED_REPLY_VARIABLES.map((v) => `{{${v}}}`).join(", ")}. Write \{"{{"}…{"}}"} to keep the braces.
      </p>
      {error ? (
        <div className="card-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="dsec-act">
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || !text.trim()}>
          {busy ? "Saving…" : reply ? "Save" : "Add"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
