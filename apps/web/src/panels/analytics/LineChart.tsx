import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export interface LinePoint {
  /** YYYY-MM-DD */
  day: string;
  value: number | null;
}

/** "2026-11-03" → "Nov 3", read at midday UTC so it never slips a day. */
export function dayShort(day: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${day}T12:00:00Z`));
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/**
 * One measure over days, with the previous period as a quiet gray line on the same axis. Inline SVG, drawn at the
 * container's real width so text never scales. Hover or arrow keys move a crosshair; the readout is announced, and
 * the numbers are in a table under "Show the numbers".
 */
export function LineChart({
  points,
  previous,
  metricLabel,
  previousLabel,
  format,
  height = 200,
  baselineZero = true,
}: {
  points: LinePoint[];
  previous: (number | null)[];
  metricLabel: string;
  previousLabel: string;
  format: (n: number) => string;
  height?: number;
  /** Followers sit far from zero; their axis starts near the data. */
  baselineZero?: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const id = useId();

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && Math.abs(w - width) > 1) setWidth(Math.max(240, Math.round(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  const n = points.length;
  const values = [...points.map((p) => p.value), ...previous.slice(0, n)].filter((v): v is number => v !== null && Number.isFinite(v));
  const dataMax = values.length ? Math.max(...values) : 0;
  const dataMin = values.length ? Math.min(...values) : 0;
  const lo = baselineZero ? 0 : Math.max(0, Math.floor((dataMin - (dataMax - dataMin) * 0.15) / 10) * 10);
  const hi = baselineZero ? niceMax(dataMax) : lo + niceMax(Math.max(1, dataMax - lo));
  const padL = 46;
  const padR = 12;
  const padT = 10;
  const padB = 26;
  const x = (i: number) => padL + (n <= 1 ? (width - padL - padR) / 2 : (i / (n - 1)) * (width - padL - padR));
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo || 1)) * (height - padT - padB);
  const path = (vals: (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  const ticks = hi - lo < 4 ? [lo, hi] : [lo, lo + (hi - lo) / 2, hi];
  const xTicks = n ? [...new Set([0, Math.floor((n - 1) / 2), n - 1])] : [];

  const summary = useMemo(() => {
    const vals = points.filter((p) => p.value !== null) as { day: string; value: number }[];
    if (!vals.length) return `${metricLabel}: no numbers in this period`;
    const peak = vals.reduce((b, p) => (p.value > b.value ? p : b));
    const last = vals[vals.length - 1]!;
    return `${metricLabel} from ${dayShort(points[0]!.day)} to ${dayShort(points[n - 1]!.day)}: highest ${format(peak.value)} on ${dayShort(peak.day)}, latest ${format(last.value)}.`;
  }, [points, n, metricLabel, format]);

  const readout = (i: number) => {
    const p = points[i];
    if (!p) return "";
    const prev = previous[i];
    return `${dayShort(p.day)}: ${p.value === null ? "no number" : format(p.value)} ${metricLabel.toLowerCase()}${prev !== null && prev !== undefined ? `; ${format(prev)} the same day of the previous period` : ""}`;
  };

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!n) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.round(((px - padL) / Math.max(1, width - padL - padR)) * (n - 1));
    setActive(Math.min(n - 1, Math.max(0, i)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!n) return;
    const cur = active ?? n - 1;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "ArrowRight") next = Math.min(n - 1, cur + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Escape") setActive(null);
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };

  const a = active !== null ? points[active] : null;
  const prevA = active !== null ? previous[active] : null;
  const tipLeft = active !== null ? Math.min(Math.max(x(active), 80), width - 80) : 0;

  return (
    <div className="lc">
      <div className="lc-legend" aria-hidden="true">
        <span className="lc-key">
          <span className="lc-swatch lc-swatch-cur" />
          {metricLabel}
        </span>
        <span className="lc-key">
          <span className="lc-swatch lc-swatch-prev" />
          {previousLabel}
        </span>
      </div>
      <div
        ref={wrap}
        className="lc-plot"
        tabIndex={0}
        role="group"
        aria-label={`${summary} Use the left and right arrow keys to read each day.`}
        aria-describedby={`${id}-live`}
        onKeyDown={onKey}
        onFocus={() => setActive((v) => v ?? (n ? n - 1 : null))}
        onBlur={() => setActive(null)}
      >
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} onPointerMove={onMove} onPointerLeave={() => setActive(null)} aria-hidden="true">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} className="lc-grid" />
              <text x={padL - 6} y={y(t) + 4} className="lc-tick" textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          {xTicks.map((i) => (
            <text key={i} x={x(i)} y={height - 8} className="lc-tick" textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
              {points[i] ? dayShort(points[i]!.day) : ""}
            </text>
          ))}
          <path d={path(previous.slice(0, n))} className="lc-prev" fill="none" />
          <path d={path(points.map((p) => p.value))} className="lc-line" fill="none" />
          {active !== null && a ? (
            <>
              <line x1={x(active)} x2={x(active)} y1={padT} y2={height - padB} className="lc-cross" />
              {prevA !== null && prevA !== undefined ? <circle cx={x(active)} cy={y(prevA)} r={4} className="lc-dot-prev" /> : null}
              {a.value !== null ? <circle cx={x(active)} cy={y(a.value)} r={4.5} className="lc-dot" /> : null}
            </>
          ) : null}
          {/* The pointer only needs to be near a day: one wide transparent target across the whole plot. */}
          <rect x={padL} y={padT} width={Math.max(0, width - padL - padR)} height={height - padT - padB} fill="transparent" />
        </svg>
        {active !== null && a ? (
          <div className="lc-tip" style={{ left: tipLeft }} aria-hidden="true">
            <div className="lc-tip-day">{dayShort(a.day)}</div>
            <div className="lc-tip-row">
              <span className="lc-swatch lc-swatch-cur" />
              <strong>{a.value === null ? "—" : format(a.value)}</strong>
              <span className="muted">{metricLabel}</span>
            </div>
            {prevA !== null && prevA !== undefined ? (
              <div className="lc-tip-row">
                <span className="lc-swatch lc-swatch-prev" />
                <strong>{format(prevA)}</strong>
                <span className="muted">{previousLabel}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <p id={`${id}-live`} className="sr-only" aria-live="polite">
        {active !== null ? readout(active) : ""}
      </p>
      <details className="lc-table">
        <summary>Show the numbers</summary>
        <div className="an-scroll">
          <table className="an-table">
            <caption className="sr-only">{metricLabel} by day</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">{metricLabel}</th>
                <th scope="col">{previousLabel}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={p.day}>
                  <th scope="row">{dayShort(p.day)}</th>
                  <td className="mono">{p.value === null ? "—" : format(p.value)}</td>
                  <td className="mono">{previous[i] === null || previous[i] === undefined ? "—" : format(previous[i]!)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
