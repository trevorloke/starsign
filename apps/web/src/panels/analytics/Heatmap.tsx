import { useId, useState, type KeyboardEvent } from "react";
import type { BestTimes, HeatCell } from "../../types-analytics";
import { WEEKDAYS, WEEKDAYS_SHORT, fmtRate, hourLabel } from "../../../../../packages/core/src/services/analytics-shared";

/** Five steps of one hue (the accent), light to dark by median engagement rate. */
const STEPS = [0.18, 0.36, 0.55, 0.75, 1];
function step(rate: number | null, max: number | null): number {
  if (rate === null || !max) return 0;
  const t = rate / max;
  return STEPS[Math.min(STEPS.length - 1, Math.floor(t * STEPS.length))] ?? STEPS[0]!;
}

function cellText(c: HeatCell, minPosts: number): string {
  const when = `${WEEKDAYS[c.weekday]} ${hourLabel(c.hour)}`;
  if (!c.posts) return `${when}: no posts`;
  const posts = `${c.posts} ${c.posts === 1 ? "post" : "posts"}`;
  return `${when}: ${fmtRate(c.medianRate)} median engagement rate, ${posts}${c.posts < minPosts ? ", too few to judge" : ""}`;
}

/**
 * When posts did best: a 7×24 grid of median engagement rate at 24 hours, by the local weekday and hour they went
 * out. Thin cells (fewer than three posts) are hatched and never recommended. One tab stop; arrow keys walk the grid
 * and each cell is read out. The strongest hours are also listed in words beneath.
 */
export function Heatmap({ data, timezoneName }: { data: BestTimes; timezoneName: string }) {
  const [active, setActive] = useState<{ weekday: number; hour: number } | null>(null);
  const id = useId();
  const cell = (w: number, h: number) => data.cells.find((c) => c.weekday === w && c.hour === h);
  const best = data.cells
    .filter((c) => !c.thin && c.medianRate !== null)
    .sort((a, b) => (b.medianRate ?? 0) - (a.medianRate ?? 0))
    .slice(0, 3);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = active ?? { weekday: best[0]?.weekday ?? 0, hour: best[0]?.hour ?? 9 };
    const moves: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    const mv = moves[e.key];
    if (mv) {
      e.preventDefault();
      setActive({ weekday: (cur.weekday + mv[0] + 7) % 7, hour: (cur.hour + mv[1] + 24) % 24 });
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive({ weekday: cur.weekday, hour: 0 });
    } else if (e.key === "End") {
      e.preventDefault();
      setActive({ weekday: cur.weekday, hour: 23 });
    } else if (e.key === "Escape") setActive(null);
  };
  const activeCell = active ? cell(active.weekday, active.hour) : undefined;

  return (
    <div className="hm">
      <p className="hm-rec" id={`${id}-rec`}>
        {data.recommendation}
      </p>
      <div
        className={`hm-grid${data.posts ? "" : " hm-grid-empty"}`}
        role="group"
        tabIndex={0}
        aria-label={`Best times to post, ${timezoneName}. Arrow keys move between hours and days.`}
        aria-describedby={`${id}-rec ${id}-live`}
        onKeyDown={onKey}
        onFocus={() => setActive((a) => a ?? { weekday: best[0]?.weekday ?? 0, hour: best[0]?.hour ?? 9 })}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        <span className="hm-corner" aria-hidden="true" />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={`h${h}`} className="hm-hour" aria-hidden="true">
            {h % 6 === 0 ? hourLabel(h) : ""}
          </span>
        ))}
        {WEEKDAYS_SHORT.map((d, w) => (
          <Row key={d} label={d} weekday={w} data={data} active={active} onHover={setActive} />
        ))}
      </div>
      <p id={`${id}-live`} className="hm-readout" aria-live="polite">
        {activeCell ? cellText(activeCell, data.minPosts) : best.length ? "Hover or use the arrow keys to read any hour." : ""}
      </p>
      <div className="hm-legend" aria-hidden="true">
        <span className="muted">Lower</span>
        {STEPS.map((s) => (
          <span key={s} className="hm-sw" style={{ ["--a" as string]: s }} />
        ))}
        <span className="muted">Higher</span>
        <span className="hm-sw hm-sw-thin" />
        <span className="muted">Fewer than {data.minPosts} posts</span>
        <span className="hm-sw hm-sw-none" />
        <span className="muted">None</span>
      </div>
      {best.length ? (
        <ol className="hm-best" aria-label="Strongest hours">
          {best.map((c) => (
            <li key={`${c.weekday}:${c.hour}`}>
              <span className="strong">
                {WEEKDAYS[c.weekday]} {hourLabel(c.hour)}
              </span>{" "}
              <span className="mono">{fmtRate(c.medianRate)}</span> <span className="muted">· {c.posts} posts</span>
            </li>
          ))}
        </ol>
      ) : null}
      <p className="muted small">
        Median engagement rate 24 hours after posting, by the hour posts went out in {timezoneName}. Based on {data.posts} {data.posts === 1 ? "post" : "posts"} from the last 90 days.
      </p>
    </div>
  );
}

function Row({
  label,
  weekday,
  data,
  active,
  onHover,
}: {
  label: string;
  weekday: number;
  data: BestTimes;
  active: { weekday: number; hour: number } | null;
  onHover: (a: { weekday: number; hour: number }) => void;
}) {
  return (
    <>
      <span className="hm-day" aria-hidden="true">
        {label}
      </span>
      {Array.from({ length: 24 }, (_, h) => {
        const c = data.cells.find((x) => x.weekday === weekday && x.hour === h);
        const on = active?.weekday === weekday && active.hour === h;
        const kind = !c || !c.posts ? "none" : c.thin ? "thin" : "solid";
        return (
          <span
            key={h}
            className={`hm-cell hm-${kind}${on ? " hm-on" : ""}`}
            style={kind === "solid" ? { ["--a" as string]: step(c!.medianRate, data.maxRate) } : undefined}
            title={c ? cellText(c, data.minPosts) : undefined}
            onPointerEnter={() => onHover({ weekday, hour: h })}
            aria-hidden="true"
          />
        );
      })}
    </>
  );
}
