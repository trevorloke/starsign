import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { MediaAsset, Role } from "../types";
import type { Report, ReportInput, ReportPeriod, ReportScheduleSpec, ReportSection } from "../types-analytics";
import { api, errorText, isApiError } from "../api";
import { ChipsInput } from "../components/ChipsInput";
import { Drawer } from "../components/Drawer";
import { PanelState } from "../components/PanelState";
import { RelativeTime } from "../components/RelativeTime";
import { useToast } from "../components/Toast";
import { useRoom } from "../lib/room";
import { formatDateTime } from "../lib/time";
import { tzName } from "../lib/tz";
import { DEFAULT_ACCENT, REPORT_SECTIONS, SECTION_LABEL, WEEKDAYS, scheduleSummary } from "../../../../packages/core/src/services/analytics-shared";
import "../styles-analytics.css";

const PERIOD_LABEL: Record<ReportPeriod, string> = { last_7_days: "Last 7 days", last_30_days: "Last 30 days", calendar_month: "Last calendar month" };
const SECTION_HINT: Record<ReportSection, string> = {
  summary: "Totals against the period before, and engagements by day",
  by_network: "The same numbers for each network",
  top_posts: "The five posts that did best",
  best_times: "When posts have done best, by weekday and hour",
  links: "Clicks and conversions from tracked links",
  tracker: "Share of voice for tracked names",
  mentions: "What came in, and its tone",
  what_worked: "Trends, media, length and post kinds compared",
  upcoming: "Posts scheduled for the next two weeks",
};
const DEFAULT_SECTIONS: ReportSection[] = ["summary", "by_network", "top_posts", "links", "what_worked", "upcoming"];

interface Draft {
  name: string;
  title: string;
  clientName: string;
  logoMediaId: string;
  accent: string;
  period: ReportPeriod;
  sections: ReportSection[];
  intro: string;
  recipients: string[];
  schedule: ReportScheduleSpec;
}

function draftOf(r: Report | null): Draft {
  return {
    name: r?.name ?? "",
    title: r?.branding.title ?? "",
    clientName: r?.branding.clientName ?? "",
    logoMediaId: r?.branding.logoMediaId ?? "",
    accent: r?.branding.accent ?? DEFAULT_ACCENT,
    period: r?.period ?? "last_7_days",
    sections: r?.sections ?? DEFAULT_SECTIONS,
    intro: r?.intro ?? "",
    recipients: r?.recipients ?? [],
    schedule: r?.schedule ?? { kind: "none" },
  };
}

function inputOf(d: Draft): ReportInput {
  return {
    name: d.name.trim() || "Untitled report",
    period: d.period,
    sections: REPORT_SECTIONS.filter((s) => d.sections.includes(s)),
    branding: { title: d.title.trim(), clientName: d.clientName.trim(), logoMediaId: d.logoMediaId || null, accent: d.accent },
    recipients: d.recipients,
    schedule: d.schedule,
    intro: d.intro.trim() || null,
  };
}

/** Opens HTML in a new tab without a server round trip, so "print / save as PDF" works the same everywhere. */
function openHtml(html: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  window.open(url, "_blank", "noopener");
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Client reports: saved, branded summaries of the workspace's numbers that can be emailed now or on a schedule, or
 * read through a link. Owners, approvers and editors manage them; everyone can read and print them.
 */
export function ReportsDrawer({ myRole, onClose }: { myRole: Role | null; onClose: () => void }) {
  const canManage = myRole === "owner" || myRole === "approver" || myRole === "editor";
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Report | "new" | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.reports().then(
      (r) => setReports(r),
      (e: unknown) => setError(errorText(e)),
    );
  }, []);
  useEffect(load, [load]);

  if (open) {
    return (
      <ReportEditor
        report={open === "new" ? null : open}
        canManage={canManage}
        onBack={() => {
          setOpen(null);
          load();
        }}
        onSaved={(r) => {
          setOpen(r);
          setReports((list) => (list ? [r, ...list.filter((x) => x.id !== r.id)] : [r]));
        }}
        onClose={onClose}
      />
    );
  }

  return (
    <Drawer
      title="Client reports"
      subtitle={<span className="muted">Branded summaries to email, schedule or share as a link</span>}
      onClose={onClose}
      footer={
        canManage ? (
          <div className="dsec-act">
            <button type="button" className="btn btn-primary" onClick={() => setOpen("new")}>
              New report
            </button>
          </div>
        ) : undefined
      }
    >
      <PanelState loading={!reports && !error} error={error} onRetry={load} />
      {reports && !reports.length ? (
        <section className="dsec">
          <p>A report pulls this workspace's numbers for a period into one page you can hand a client: totals against the period before, top posts, best times, clicks and conversions, share of voice and what is coming up.</p>
          <p className="muted small">{canManage ? "Make one, then send it now, put it on a schedule, or share a link." : "Ask an editor or owner to make the first one."}</p>
        </section>
      ) : null}
      {reports && reports.length ? (
        <ul className="rp-list">
          {reports.map((r) => (
            <li key={r.id} className="rp-item">
              <span className="rp-swatch" style={{ background: r.branding.accent }} aria-hidden="true" />
              <div className="rp-main">
                <button type="button" className="linkish rp-name" onClick={() => setOpen(r)}>
                  {r.name}
                </button>
                <div className="muted small">
                  {[r.branding.clientName, PERIOD_LABEL[r.period], `${r.sections.length} ${r.sections.length === 1 ? "section" : "sections"}`].filter(Boolean).join(" · ")}
                </div>
                <div className="small">{r.scheduleSummary}</div>
                <div className="muted small rp-meta">
                  {r.lastSentAt ? (
                    <span>
                      Last sent <RelativeTime iso={r.lastSentAt} />
                    </span>
                  ) : (
                    <span>Not sent yet</span>
                  )}
                  {r.shares.active ? <span>{r.shares.active === 1 ? "1 link on" : `${r.shares.active} links on`}</span> : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </Drawer>
  );
}

function ReportEditor({
  report,
  canManage,
  onBack,
  onSaved,
  onClose,
}: {
  report: Report | null;
  canManage: boolean;
  onBack: () => void;
  onSaved: (r: Report) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const { timezone } = useRoom();
  const [saved, setSaved] = useState<Report | null>(report);
  const [draft, setDraft] = useState<Draft>(() => draftOf(report));
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [html, setHtml] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "save" | "send" | "share" | "revoke" | "delete" | "open">(null);
  const [error, setError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "revoke" | "delete" | "send">(null);

  useEffect(() => {
    api.media().then((m) => setMedia(m.filter((x) => x.kind === "image")), () => undefined);
  }, []);

  const input = useMemo(() => inputOf(draft), [draft]);
  const dirty = useMemo(() => JSON.stringify(input) !== JSON.stringify(inputOf(draftOf(saved))) || !saved, [input, saved]);

  // Live preview: the unsaved draft, rendered by the server a moment after the last change.
  const gen = useRef(0);
  useEffect(() => {
    const g = ++gen.current;
    setPreviewing(true);
    const t = window.setTimeout(() => {
      api.previewReport(input).then(
        (h) => {
          if (g !== gen.current) return;
          setHtml(h);
          setPreviewError(null);
          setPreviewing(false);
        },
        (e: unknown) => {
          if (g !== gen.current) return;
          setPreviewError(errorText(e));
          setPreviewing(false);
        },
      );
    }, 450);
    return () => window.clearTimeout(t);
  }, [input]);

  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const toggleSection = (s: ReportSection, on: boolean) => set({ sections: on ? [...draft.sections, s] : draft.sections.filter((x) => x !== s) });

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!draft.name.trim()) {
      setError("Give the report a name.");
      return;
    }
    if (!draft.sections.length) {
      setError("Pick at least one section.");
      return;
    }
    setBusy("save");
    setError(null);
    try {
      const r = saved ? await api.updateReport(saved.id, input) : await api.createReport(input);
      setSaved(r);
      setDraft(draftOf(r));
      onSaved(r);
      toast(saved ? "Report saved" : "Report created");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    if (!saved) return;
    setBusy("send");
    setError(null);
    try {
      const out = await api.sendReport(saved.id);
      setConfirm(null);
      toast(`Sent ${out.periodLabel} to ${out.sent === 1 ? "1 person" : `${out.sent} people`}`);
      setSaved({ ...saved, lastSentAt: new Date().toISOString(), shares: { ...saved.shares, active: saved.shares.active + (out.viewUrl ? 1 : 0) } });
    } catch (err) {
      setError(isApiError(err) && err.status === 503 ? "Email isn't set up on this server yet (RESEND_API_KEY and MAIL_FROM). Share a link instead." : errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function share() {
    if (!saved) return;
    setBusy("share");
    setError(null);
    try {
      const s = await api.shareReport(saved.id);
      setShareUrl(s.url);
      setSaved({ ...saved, shares: { active: saved.shares.active + 1, lastCreatedAt: s.createdAt } });
      try {
        await navigator.clipboard.writeText(s.url);
        toast("Copied the link");
      } catch {
        toast("Link made. Copy it from the box.");
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    if (!saved) return;
    setBusy("revoke");
    setError(null);
    try {
      await api.revokeReportShares(saved.id);
      setSaved({ ...saved, shares: { active: 0, lastCreatedAt: saved.shares.lastCreatedAt } });
      setShareUrl(null);
      setConfirm(null);
      toast("Turned off every link to this report");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!saved) return;
    setBusy("delete");
    try {
      await api.deleteReport(saved.id);
      toast(`Deleted ${saved.name}`);
      onBack();
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  }

  async function openPrintable() {
    setBusy("open");
    try {
      openHtml(saved && !dirty ? await api.renderReport(saved.id) : (html ?? (await api.previewReport(input))));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  const s = draft.schedule;
  const summary = scheduleSummary(s, draft.recipients.length);
  const logo = media.find((m) => m.id === draft.logoMediaId);

  const footer = (
    <>
      {error ? (
        <div className="card-error" role="alert">
          {error}
        </div>
      ) : null}
      {shareUrl ? (
        <div className="rp-share">
          <label className="field">
            <span>Read-only link (shown once; anyone with it can read the latest version)</span>
            <input className="input mono" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
          </label>
        </div>
      ) : null}
      {confirm === "revoke" ? (
        <div className="acct-confirm" role="group" aria-label="Turn off every link?">
          <span>Turn off {saved?.shares.active === 1 ? "the link" : `all ${saved?.shares.active} links`}, including emailed ones?</span>
          <button type="button" className="btn btn-small btn-danger" disabled={busy !== null} onClick={() => void revoke()}>
            {busy === "revoke" ? "…" : "Turn off"}
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirm(null)}>
            Keep
          </button>
        </div>
      ) : confirm === "delete" ? (
        <div className="acct-confirm" role="group" aria-label="Delete this report?">
          <span>Delete this report? Its links stop working.</span>
          <button type="button" className="btn btn-small btn-danger" disabled={busy !== null} onClick={() => void remove()}>
            {busy === "delete" ? "…" : "Delete"}
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirm(null)}>
            Keep
          </button>
        </div>
      ) : confirm === "send" ? (
        <div className="acct-confirm" role="group" aria-label="Send now?">
          <span>Email it now to {saved?.recipients.length === 1 ? saved.recipients[0] : `${saved?.recipients.length} people`}?</span>
          <button type="button" className="btn btn-small btn-primary" disabled={busy !== null} onClick={() => void send()}>
            {busy === "send" ? "Sending…" : "Send"}
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirm(null)}>
            Not now
          </button>
        </div>
      ) : null}
      <div className="dsec-act rp-actions">
        {canManage ? (
          <button type="submit" form="rp-form" className="btn btn-primary" disabled={busy !== null || (!dirty && !!saved)}>
            {busy === "save" ? "Saving…" : saved ? "Save" : "Create report"}
          </button>
        ) : null}
        {canManage && saved ? (
          <button
            type="button"
            className="btn"
            disabled={busy !== null || dirty || !saved.recipients.length}
            title={dirty ? "Save your changes first" : !saved.recipients.length ? "Add a recipient first" : undefined}
            onClick={() => setConfirm("send")}
          >
            Send now
          </button>
        ) : null}
        {canManage && saved ? (
          <button type="button" className="btn" disabled={busy !== null || dirty} title={dirty ? "Save your changes first" : undefined} onClick={() => void share()}>
            {busy === "share" ? "Making link…" : "Copy share link"}
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void openPrintable()}>
          Open to print
        </button>
        {canManage && saved && saved.shares.active ? (
          <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => setConfirm("revoke")}>
            Turn off links ({saved.shares.active})
          </button>
        ) : null}
        {canManage && saved ? (
          <button type="button" className="btn btn-ghost rp-delete" disabled={busy !== null} onClick={() => setConfirm("delete")}>
            Delete
          </button>
        ) : null}
      </div>
    </>
  );

  return (
    <Drawer
      title={saved ? saved.name : "New report"}
      subtitle={
        <>
          <button type="button" className="linkish small" onClick={onBack}>
            All reports
          </button>
          {saved?.lastSentAt ? <span className="muted">Last sent {formatDateTime(saved.lastSentAt, timezone, false)}</span> : null}
        </>
      }
      onClose={onClose}
      className="drawer-reports"
      footer={footer}
    >
      <div className="rp-edit">
        <form id="rp-form" className="rp-form" onSubmit={(e) => void save(e)}>
          <fieldset disabled={!canManage} className="rp-fieldset">
            {!canManage ? <p className="muted small">You can read and print reports. Editors and owners change them.</p> : null}
            <label className="field">
              <span>Report name</span>
              <input className="input" required maxLength={120} value={draft.name} placeholder="Weekly for Bloom" onChange={(e) => set({ name: e.target.value })} />
            </label>
            <div className="rp-two">
              <label className="field">
                <span>Client name</span>
                <input className="input" maxLength={120} value={draft.clientName} placeholder="Bloom Florists" onChange={(e) => set({ clientName: e.target.value })} />
              </label>
              <label className="field">
                <span>Title on the report</span>
                <input className="input" maxLength={120} value={draft.title} placeholder={draft.name || "Same as the name"} onChange={(e) => set({ title: e.target.value })} />
              </label>
            </div>
            <div className="rp-two">
              <label className="field">
                <span>Logo (from the media library)</span>
                <select className="select" value={draft.logoMediaId} onChange={(e) => set({ logoMediaId: e.target.value })}>
                  <option value="">No logo</option>
                  {media.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.originalName ?? m.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Accent colour</span>
                <span className="rp-colour">
                  <input type="color" value={draft.accent} onChange={(e) => set({ accent: e.target.value })} aria-label="Accent colour" />
                  <span className="mono small">{draft.accent}</span>
                </span>
              </label>
            </div>
            {logo ? <img className="rp-logo" src={logo.url} alt={logo.alt ?? "Logo"} /> : null}
            <label className="field">
              <span>Period</span>
              <select className="select" value={draft.period} onChange={(e) => set({ period: e.target.value as ReportPeriod })}>
                {(Object.keys(PERIOD_LABEL) as ReportPeriod[]).map((p) => (
                  <option key={p} value={p}>
                    {PERIOD_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="rp-sections">
              <legend className="field-label">Sections</legend>
              {REPORT_SECTIONS.map((sec) => (
                <label key={sec} className="check">
                  <input type="checkbox" checked={draft.sections.includes(sec)} onChange={(e) => toggleSection(sec, e.target.checked)} />
                  <span>
                    {SECTION_LABEL[sec]} <span className="muted small">· {SECTION_HINT[sec]}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="field">
              <span>Note at the top (optional)</span>
              <textarea className="textarea" rows={3} maxLength={2000} value={draft.intro} placeholder="A line or two for the client about the period." onChange={(e) => set({ intro: e.target.value })} />
            </label>
            <ChipsInput
              id="rp-recipients"
              label="Recipients"
              what="recipient"
              values={draft.recipients}
              onChange={(v) => set({ recipients: v.map((x) => x.toLowerCase()) })}
              placeholder="name@client.com"
              help="Email addresses. Press Enter or a comma after each."
              max={25}
              maxLength={254}
            />
            <div className="rp-schedule">
              <label className="field">
                <span>Schedule</span>
                <select
                  className="select"
                  value={s.kind}
                  onChange={(e) => {
                    const kind = e.target.value as ReportScheduleSpec["kind"];
                    set({ schedule: kind === "weekly" ? { kind, weekday: 0, hour: 8 } : kind === "monthly" ? { kind, day: 1, hour: 9 } : { kind: "none" } });
                  }}
                >
                  <option value="none">Not scheduled</option>
                  <option value="weekly">Every week</option>
                  <option value="monthly">Every month</option>
                </select>
              </label>
              {s.kind === "weekly" ? (
                <label className="field">
                  <span>On</span>
                  <select className="select" value={s.weekday} onChange={(e) => set({ schedule: { ...s, weekday: Number(e.target.value) } })}>
                    {WEEKDAYS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {s.kind === "monthly" ? (
                <label className="field">
                  <span>On day</span>
                  <select className="select" value={s.day} onChange={(e) => set({ schedule: { ...s, day: Number(e.target.value) } })}>
                    {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {s.kind !== "none" ? (
                <label className="field">
                  <span>At</span>
                  <select className="select" value={s.hour} onChange={(e) => set({ schedule: { ...s, hour: Number(e.target.value) } })}>
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>
                        {h}:00
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            <p className="small rp-summary">
              {summary}
              {s.kind !== "none" ? <span className="muted"> · {tzName(timezone)} · each period is sent once</span> : null}
            </p>
          </fieldset>
        </form>
        <div className="rp-preview">
          <div className="rp-preview-head">
            <span className="section-h">Preview</span>
            <span className="muted small" aria-live="polite">
              {previewing ? "Updating…" : dirty && saved ? "Unsaved changes" : ""}
            </span>
          </div>
          {previewError ? <PanelState error={previewError} /> : null}
          {html ? <iframe className="rp-frame" title="Report preview" sandbox="allow-popups" srcDoc={html} /> : <div className="rp-frame rp-frame-empty muted">Drawing the preview…</div>}
        </div>
      </div>
    </Drawer>
  );
}
