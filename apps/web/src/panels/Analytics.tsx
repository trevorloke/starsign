import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AnalyticsPayload, AnalyticsTotals, Comparison, TopPost, TotalKey } from "../types-analytics";
import { api, errorText } from "../api";
import { NetworkBadge } from "../components/NetworkBadge";
import { PanelState } from "../components/PanelState";
import { StagePill } from "../components/Pill";
import { networkLabel, plural, truncate } from "../lib/format";
import { PRESETS, readChoice, rememberChoice, windowOf, type AnalyticsChoice, type AnalyticsPreset } from "../lib/analytics";
import { useRoom } from "../lib/room";
import { formatDateTime } from "../lib/time";
import { tzName } from "../lib/tz";
import type { TrendStage } from "../types";
import { TOTAL_LABEL, fmtChange, fmtCompact, fmtMoney, fmtRate, fmtRatio, formatTotal } from "../../../../packages/core/src/services/analytics-shared";
import { Heatmap } from "./analytics/Heatmap";
import { LineChart, dayShort } from "./analytics/LineChart";
import "../styles-analytics.css";

const TILES: TotalKey[] = ["posts", "impressions", "engagements", "engagementRate", "linkClicks", "conversions", "followersGained", "mentions"];
type SeriesKey = "engagements" | "impressions" | "clicks" | "followers";
const SERIES: { id: SeriesKey; label: string }[] = [
  { id: "engagements", label: "Engagements" },
  { id: "impressions", label: "Impressions" },
  { id: "clicks", label: "Link clicks" },
  { id: "followers", label: "Followers" },
];
const BASIS_LABEL: Record<TopPost["basis"], string> = { "72h": "at 72 hours", "24h": "at 24 hours", latest: "latest numbers", none: "no numbers yet" };
const STAGES = new Set(["rising", "peaking", "plateau", "fading", "dormant"]);

/** "Oct 9 – Nov 7" in the workspace's time zone. */
function dateRange(fromIso: string, toIso: string, tz: string): string {
  try {
    const f = new Intl.DateTimeFormat(undefined, { timeZone: tz, month: "short", day: "numeric" });
    return `${f.format(new Date(fromIso))} – ${f.format(new Date(toIso))}`;
  } catch {
    return "";
  }
}

/**
 * How the work did: the period's numbers against the period before, by day, by network and account, the posts that
 * did best, when to post, and what made a difference. Every number comes from GET /v1/analytics.
 */
export function Analytics({ head, refreshTick, onOpenReports }: { head: ReactNode; refreshTick: number; onOpenReports: () => void }) {
  const { timezone, accountsById, openPost } = useRoom();
  const [choice, setChoice] = useState<AnalyticsChoice>(() => readChoice(timezone));
  const [data, setData] = useState<AnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [series, setSeries] = useState<SeriesKey>("engagements");
  const [breakdown, setBreakdown] = useState<"network" | "account">("network");

  const accounts = useMemo(() => [...accountsById.values()], [accountsById]);
  const networks = useMemo(() => [...new Set(accounts.map((a) => a.network))].sort(), [accounts]);
  const accountChoices = accounts.filter((a) => !choice.network || a.network === choice.network);

  const gen = useRef(0);
  const load = useCallback(async () => {
    const g = ++gen.current;
    setLoading(true);
    setError(null);
    const w = windowOf(choice, timezone);
    try {
      const a = await api.analytics({ from: w.from, to: w.to, networks: choice.network ? [choice.network] : undefined, accounts: choice.account ? [choice.account] : undefined });
      if (g === gen.current) setData(a);
    } catch (e) {
      if (g === gen.current) setError(errorText(e));
    } finally {
      if (g === gen.current) setLoading(false);
    }
  }, [choice, timezone]);
  useEffect(() => {
    void load();
  }, [load, refreshTick]);

  const change = (next: Partial<AnalyticsChoice>) => {
    const c = { ...choice, ...next };
    if (next.network !== undefined && c.account && accountsById.get(c.account)?.network !== c.network && c.network) c.account = "";
    setChoice(c);
    rememberChoice(c);
  };

  const preset = PRESETS.find((p) => p.id === choice.preset) ?? PRESETS[1]!;
  const prevLabel = choice.preset === "custom" ? "Previous period" : `Previous ${preset.days} days`;
  const w = windowOf(choice, timezone);
  const rangeText = data ? dateRange(data.window.from, data.window.to, timezone) : "";

  return (
    <section className="panel panel-analytics" aria-label="Analytics">
      <header className="panel-head">
        {head}
        <span className="panel-meta mono">{rangeText}</span>
      </header>
      <div className="an-bar" role="group" aria-label="Filters">
        <div className="seg" role="radiogroup" aria-label="Period">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={choice.preset === p.id} className="seg-btn" onClick={() => change({ preset: p.id as AnalyticsPreset })}>
              {p.id === "custom" ? "Custom" : p.id}
            </button>
          ))}
        </div>
        {choice.preset === "custom" ? (
          <span className="an-custom">
            <label className="an-inline">
              <span className="sr-only">From</span>
              <input className="input input-small" type="date" value={choice.customFrom} max={choice.customTo} onChange={(e) => e.target.value && change({ customFrom: e.target.value })} />
            </label>
            <span className="muted" aria-hidden="true">
              to
            </span>
            <label className="an-inline">
              <span className="sr-only">To</span>
              <input className="input input-small" type="date" value={choice.customTo} min={choice.customFrom} onChange={(e) => e.target.value && change({ customTo: e.target.value })} />
            </label>
          </span>
        ) : null}
        <label className="an-inline">
          <span className="sr-only">Network</span>
          <select className="select select-small" value={choice.network} onChange={(e) => change({ network: e.target.value })}>
            <option value="">All networks</option>
            {networks.map((n) => (
              <option key={n} value={n}>
                {networkLabel(n)}
              </option>
            ))}
          </select>
        </label>
        <label className="an-inline">
          <span className="sr-only">Account</span>
          <select className="select select-small" value={choice.account} onChange={(e) => change({ account: e.target.value })}>
            <option value="">All accounts</option>
            {accountChoices.map((a) => (
              <option key={a.id} value={a.id}>
                {a.handle} · {networkLabel(a.network)}
              </option>
            ))}
          </select>
        </label>
        {loading && data ? <span className="muted small">Updating…</span> : null}
        <button type="button" className="btn btn-small an-reports" onClick={onOpenReports}>
          Client reports
        </button>
      </div>
      <div className="panel-body an-body" data-busy={loading && data ? "1" : undefined}>
        <PanelState loading={loading && !data} error={error} onRetry={() => void load()} />
        {data ? (
          <>
            <Kpis data={data} prevLabel={prevLabel.toLowerCase()} />
            <section className="an-sec" aria-labelledby="an-daily">
              <div className="an-sec-head">
                <h3 id="an-daily" className="section-h">
                  By day
                </h3>
                <div className="seg seg-small" role="radiogroup" aria-label="Measure">
                  {SERIES.map((s) => (
                    <button key={s.id} type="button" role="radio" aria-checked={series === s.id} className="seg-btn" onClick={() => setSeries(s.id)}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              <Daily data={data} series={series} prevLabel={prevLabel} windowLabel={w.label} />
            </section>
            <section className="an-sec" aria-labelledby="an-break">
              <div className="an-sec-head">
                <h3 id="an-break" className="section-h">
                  {breakdown === "network" ? "By network" : "By account"}
                </h3>
                <div className="seg seg-small" role="radiogroup" aria-label="Break down by">
                  <button type="button" role="radio" aria-checked={breakdown === "network"} className="seg-btn" onClick={() => setBreakdown("network")}>
                    Network
                  </button>
                  <button type="button" role="radio" aria-checked={breakdown === "account"} className="seg-btn" onClick={() => setBreakdown("account")}>
                    Account
                  </button>
                </div>
              </div>
              <Breakdown data={data} by={breakdown} />
            </section>
            <section className="an-sec" aria-labelledby="an-top">
              <h3 id="an-top" className="section-h">
                Top posts
              </h3>
              <TopPosts posts={data.topPosts} timezone={timezone} onOpen={openPost} />
            </section>
            <section className="an-sec" aria-labelledby="an-times">
              <h3 id="an-times" className="section-h">
                Best times to post
              </h3>
              <Heatmap data={data.bestTimes} timezoneName={tzName(timezone)} />
            </section>
            <section className="an-sec" aria-labelledby="an-worked">
              <h3 id="an-worked" className="section-h">
                What worked
              </h3>
              <WhatWorked data={data} />
            </section>
          </>
        ) : null}
      </div>
    </section>
  );
}

function Kpis({ data, prevLabel }: { data: AnalyticsPayload; prevLabel: string }) {
  return (
    <ul className="an-kpis" aria-label="This period against the one before">
      {TILES.map((k) => {
        const ch = data.change[k];
        const dir = ch === null || Math.abs(ch) < 0.005 ? "flat" : ch > 0 ? "up" : "down";
        const value = k === "conversions" && data.totals.conversionValue ? `${formatTotal(k, data.totals, data.currency)}` : formatTotal(k, data.totals, data.currency);
        return (
          <li key={k} className="an-kpi">
            <span className="an-kpi-label">{TOTAL_LABEL[k]}</span>
            <span className="an-kpi-value">{value}</span>
            {k === "conversions" && data.totals.conversionValue ? <span className="an-kpi-sub muted">{fmtMoney(data.totals.conversionValue, data.currency)} in value</span> : null}
            <span className={`an-delta an-${dir}`} title={`${formatTotal(k, data.previous, data.currency)} in the ${prevLabel}`}>
              <span aria-hidden="true">{dir === "up" ? "▲" : dir === "down" ? "▼" : "•"}</span> {ch === null ? "no comparison" : fmtChange(ch)}
              <span className="muted"> vs {prevLabel}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Daily({ data, series, prevLabel, windowLabel }: { data: AnalyticsPayload; series: SeriesKey; prevLabel: string; windowLabel: string }) {
  const label = SERIES.find((s) => s.id === series)!.label;
  const points = data.series.map((d) => ({ day: d.day, value: d[series] }));
  const previous = data.previousSeries.map((d) => d[series]);
  const anything = points.some((p) => (p.value ?? 0) > 0);
  if (!anything) {
    const why: Record<SeriesKey, string> = {
      engagements: "No posts with numbers went out in this period. This fills as published posts get their 24-hour numbers.",
      impressions: "No posts with numbers went out in this period. This fills as published posts get their 24-hour numbers.",
      clicks: "Nobody clicked a tracked link in this period. Links in published posts are counted once link tracking is on.",
      followers: "None of these accounts reports followers yet. Connected accounts report them a few times a day.",
    };
    return <p className="an-empty">{why[series]}</p>;
  }
  return (
    <>
      <LineChart
        points={points}
        previous={previous}
        metricLabel={label}
        previousLabel={prevLabel}
        format={(n) => fmtCompact(n)}
        baselineZero={series !== "followers"}
      />
      <p className="muted small">
        {series === "clicks" ? "Clicks on Starsign's short links, by the day they happened." : series === "followers" ? "Followers across these accounts at the end of each day." : "By the day each post went out, at its 72-hour, 24-hour or latest numbers."}{" "}
        {windowLabel}.
      </p>
    </>
  );
}

function Breakdown({ data, by }: { data: AnalyticsPayload; by: "network" | "account" }) {
  const rows: (AnalyticsTotals & { key: string; label: ReactNode })[] =
    by === "network"
      ? data.byNetwork.map((r) => ({ ...r, key: r.network, label: <NetworkBadge network={r.network} /> }))
      : data.byAccount.map((r) => ({
          ...r,
          key: r.accountId,
          label: (
            <span className="an-acct">
              <NetworkBadge network={r.network} short />
              <span className="an-handle">{r.handle}</span>
            </span>
          ),
        }));
  if (!rows.length) return <p className="an-empty">Nothing went out or came in during this period. Rows appear for each network once posts are published or mentions arrive.</p>;
  const cols: { k: TotalKey; label: string }[] = [
    { k: "posts", label: "Posts" },
    { k: "impressions", label: "Impr." },
    { k: "engagements", label: "Eng." },
    { k: "engagementRate", label: "Rate" },
    { k: "linkClicks", label: "Clicks" },
    { k: "conversions", label: "Conv." },
    { k: "followersGained", label: "Followers" },
    { k: "mentions", label: "Mentions" },
  ];
  return (
    <div className="an-scroll" tabIndex={0} role="region" aria-label={`Numbers by ${by}`}>
      <table className="an-table">
        <thead>
          <tr>
            <th scope="col">{by === "network" ? "Network" : "Account"}</th>
            {cols.map((c) => (
              <th key={c.k} scope="col" title={TOTAL_LABEL[c.k]}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              {cols.map((c) => (
                <td key={c.k} className="mono">
                  {formatTotal(c.k, r, data.currency)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopPosts({ posts, timezone, onOpen }: { posts: TopPost[]; timezone: string; onOpen: (id: string) => void }) {
  if (!posts.length) return <p className="an-empty">Posts show up here once they have been out for a day and their numbers are in.</p>;
  return (
    <ol className="an-posts">
      {posts.map((p, i) => (
        <li key={p.postId} className="an-post">
          <span className="an-rank mono" aria-hidden="true">
            {i + 1}
          </span>
          <div className="an-post-main">
            <button type="button" className="linkish an-post-text" onClick={() => onOpen(p.postId)}>
              {truncate(p.text.replace(/\s+/g, " "), 160)}
            </button>
            <div className="an-post-meta">
              {p.networks.map((n) => (
                <NetworkBadge key={n} network={n} />
              ))}
              <span className="muted small">{formatDateTime(p.publishedAt, timezone, false)}</span>
              <span className="tag" title="Which snapshot these numbers come from">
                {BASIS_LABEL[p.basis]}
              </span>
              {p.url ? (
                <a className="small an-ext" href={p.url} target="_blank" rel="noreferrer">
                  View on {networkLabel(p.networks[0] ?? "")}
                </a>
              ) : null}
            </div>
            <div className="an-post-nums small">
              <span>
                <span className="mono strong">{fmtCompact(p.engagements)}</span> engagements
              </span>
              <span>
                <span className="mono strong">{fmtCompact(p.impressions)}</span> impressions
              </span>
              <span>
                <span className="mono strong">{fmtRate(p.engagementRate)}</span> rate
              </span>
              {p.linkClicks ? (
                <span>
                  <span className="mono strong">{fmtCompact(p.linkClicks)}</span> clicks
                </span>
              ) : null}
              {p.conversions ? (
                <span>
                  <span className="mono strong">{fmtCompact(p.conversions)}</span> {p.conversions === 1 ? "conversion" : "conversions"}
                </span>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function WhatWorked({ data }: { data: AnalyticsPayload }) {
  const w = data.whatWorked;
  const stages = w.stages.filter((s) => s.posts > 0);
  return (
    <>
      <ul className="an-ww">
        {w.comparisons.map((c) => (
          <ComparisonRow key={c.id} c={c} />
        ))}
      </ul>
      {stages.length ? (
        <div className="an-stages">
          <h4 className="an-h4">By trend stage when posted</h4>
          <ul className="an-stage-list">
            {stages.map((s) => (
              <li key={s.stage}>
                {STAGES.has(s.stage) ? <StagePill stage={s.stage as TrendStage} /> : <span className="tag">{s.stage === "no_trend" ? "No trend" : s.stage}</span>}
                <span className="mono strong">{s.posts >= w.minPerSide ? fmtRatio(s.lift) : "—"}</span>
                <span className="muted small">{s.posts >= w.minPerSide ? `the average · ${plural(s.posts, "post")}` : `not enough posts yet (${s.posts})`}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="muted small">
        Median engagements at 24 hours, posts from {dayShort(w.from.slice(0, 10))} on. A difference is only claimed with at least {w.minPerSide} posts on each side.
      </p>
    </>
  );
}

function ComparisonRow({ c }: { c: Comparison }) {
  return (
    <li className={`an-cmp an-cmp-${c.verdict}`}>
      <span className="an-cmp-ratio mono">{c.verdict === "not_enough" ? "Not enough yet" : fmtRatio(c.ratio)}</span>
      <span className="an-cmp-text">
        <span className="strong">{c.label}</span>
        <span className="muted small">{c.sentence}</span>
      </span>
    </li>
  );
}
