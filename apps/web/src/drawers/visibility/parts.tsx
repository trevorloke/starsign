import type { VisAnswer, VisEntityRow } from "../../lib/visibility";
import { engineLabel, highlightPieces, positionLabel, sharePct, toneClass, toneLabel } from "../../lib/visibility";
import { languageName } from "../../lib/lang";
import { formatDateShort } from "../../lib/time";
import { truncate } from "../../lib/format";

/** Share of answers per day as a small line; the summary is the accessible name and the hover title. */
export function ShareSpark({ trend, width = 96, height = 26 }: { trend: VisEntityRow["trend"]; width?: number; height?: number }) {
  const pts = trend.filter((d) => d.share !== null) as (VisEntityRow["trend"][number] & { share: number })[];
  if (pts.length < 2) {
    return (
      <span className="dayspark dayspark-empty vis-spark" style={{ width, height }} role="img" aria-label="Not enough runs for a trend yet">
        too few runs
      </span>
    );
  }
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const summary = `Share of answers naming it, ${formatDateShort(`${first.day}T12:00:00Z`)} to ${formatDateShort(`${last.day}T12:00:00Z`)}: from ${sharePct(first.share)} to ${sharePct(last.share)}`;
  const pad = 2;
  const sx = (i: number) => pad + (i / (pts.length - 1)) * (width - 2 * pad);
  const sy = (v: number) => height - pad - v * (height - 2 * pad);
  const f = (n: number) => n.toFixed(1);
  // A rolling mean of three runs: single answers are noisy, the line should show the drift.
  const smooth = pts.map((_, i) => {
    const w = pts.slice(Math.max(0, i - 1), i + 2);
    return w.reduce((n, d) => n + d.share, 0) / w.length;
  });
  const line = smooth.map((v, i) => `${i ? "L" : "M"}${f(sx(i))},${f(sy(v))}`).join(" ");
  const area = `${line} L${f(sx(pts.length - 1))},${height - pad} L${f(sx(0))},${height - pad} Z`;
  return (
    <svg className="dayspark vis-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
      <title>{summary}</title>
      <path d={area} className="dayspark-area" />
      <path d={line} className="dayspark-line" fill="none" />
      <circle cx={sx(pts.length - 1)} cy={sy(smooth[smooth.length - 1]!)} r={2} className="dayspark-dot" />
    </svg>
  );
}

/** A horizontal share bar with its number, for by-engine and by-language breakdowns. */
export function ShareBar({ label, share, answers, sub }: { label: string; share: number | null; answers: number; sub?: string | null }) {
  return (
    <li className="vis-bar-row">
      <span className="vis-bar-label">{label}</span>
      <span className="vis-bar" aria-hidden="true">
        <span className="vis-bar-fill" style={{ width: `${Math.round((share ?? 0) * 100)}%` }} />
      </span>
      <span className="vis-bar-num mono">{sharePct(share)}</span>
      <span className="vis-bar-sub muted small">
        of {answers}
        {sub ? ` · ${sub}` : ""}
      </span>
    </li>
  );
}

export function Tone({ value }: { value: number | null }) {
  return (
    <span className={`vis-tone ${toneClass(value)}`} title={value === null ? "Not scored" : `Tone ${value > 0 ? "+" : ""}${value.toFixed(2)} on a scale from −1 to 1`}>
      {toneLabel(value)}
    </span>
  );
}

const MARK_CLASS: Record<string, string> = { own: "vis-mark-own", client: "vis-mark-own", competitor: "vis-mark-rival", opponent: "vis-mark-rival" };

/** The answer text with tracked names marked; colours follow the name's relation (yours, a rival, anyone else). */
export function HighlightedText({ answer, relationOf, clamp }: { answer: VisAnswer; relationOf: (entityId: string) => string | undefined; clamp?: number }) {
  if (!answer.text) return null;
  const full = answer.text;
  const text = clamp && full.length > clamp ? `${full.slice(0, clamp)}…` : full;
  const spans = answer.highlights.filter((h) => h.end <= text.length);
  return (
    <p className={`vis-answer-text${clamp ? " vis-answer-clamp" : ""}`}>
      {highlightPieces(text, spans).map((p, i) =>
        p.entityId ? (
          <mark key={i} className={`vis-mark ${MARK_CLASS[relationOf(p.entityId) ?? ""] ?? "vis-mark-other"}`}>
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
}

/** One answer in a list: engine, language, the question, who it named, a snippet. The whole card opens it. */
export function AnswerCard({ answer, relationOf, onOpen }: { answer: VisAnswer; relationOf: (entityId: string) => string | undefined; onOpen: () => void }) {
  const named = answer.mentions.filter((m) => m.mentioned);
  return (
    <li className="vis-answer-card">
      <div className="vis-answer-meta">
        <span className="tag vis-engine-tag">{engineLabel(answer.engine)}</span>
        <span className="tag">{languageName(answer.lang)}</span>
        {answer.region ? <span className="tag">{answer.region}</span> : null}
        <span className="muted small mono">{formatDateShort(answer.askedAt)}</span>
      </div>
      <button type="button" className="linkish vis-answer-q" onClick={onOpen}>
        {truncate(answer.question, 120)}
      </button>
      {answer.status === "ok" ? (
        <>
          <div className="vis-answer-named small">
            {named.length ? (
              named.map((m) => (
                <span key={m.entityId} className="vis-named">
                  <span className="mono">{positionLabel(m.position)}</span> {m.name}
                </span>
              ))
            ) : (
              <span className="muted">Named none of your tracked names</span>
            )}
          </div>
          <HighlightedText answer={answer} relationOf={relationOf} clamp={220} />
        </>
      ) : (
        <p className="muted small">{answer.status === "capped" ? "Not asked: the monthly model spend cap was reached." : `The engine failed: ${answer.error ?? "unknown error"}`}</p>
      )}
    </li>
  );
}
