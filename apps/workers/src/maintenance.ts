import type { Starsign } from "@starsign/core";
import { createMentionSearches } from "@starsign/sources";
import { captureOutcomes, ingestAll, pullSources, refreshForecasts } from "./jobs.ts";
// ---- AI answer visibility
import { runVisibility } from "./visibility.ts";

/** A background job: what it does and how often. One table for the Redis workers and the single-process runner. */
export interface MaintenanceJob {
  name: string;
  everyMs: number;
  run(m: Starsign): Promise<unknown>;
}

export interface MaintenanceOptions {
  ingestEveryMs?: number;
  outcomesEveryMs?: number;
  forecastEveryMs?: number;
  sourcesEveryMs?: number;
}

const MIN = 60_000;

export function maintenanceJobs(opts: MaintenanceOptions = {}): MaintenanceJob[] {
  return [
    { name: "ingest", everyMs: opts.ingestEveryMs ?? 5 * MIN, run: (m) => ingestAll(m) },
    { name: "outcomes", everyMs: opts.outcomesEveryMs ?? 10 * MIN, run: (m) => captureOutcomes(m) },
    { name: "account-metrics", everyMs: 6 * 60 * MIN, run: (m) => m.metrics.captureAccountMetrics() },
    // Cumulative values, so overlapping windows are harmless; 20 minutes covers a late or skipped run.
    { name: "links", everyMs: 15 * MIN, run: async (m) => ({ metrics: await m.links.rollup(new Date(m.ctx.now().getTime() - 20 * MIN)) }) },
    {
      name: "tracker-scan",
      everyMs: 30 * MIN,
      // Public posts and news naming tracked parties, brands and people.
      run: async (m) => {
        const r = await m.entities.scanPublic(createMentionSearches());
        for (const e of r.errors.slice(0, 10)) console.warn(`[tracker] ${e}`);
        return { entities: r.entities, found: r.found, stored: r.stored, errors: r.errors.length };
      },
    },
    { name: "sources", everyMs: opts.sourcesEveryMs ?? 60 * MIN, run: (m) => pullSources(m) },
    { name: "forecasts", everyMs: opts.forecastEveryMs ?? 60 * MIN, run: async (m) => ({ topics: await refreshForecasts(m) }) },
    // Scheduled client reports; each period is sent once (reports.last_sent_period), so a late or repeated run is harmless.
    { name: "reports", everyMs: 15 * MIN, run: (m) => m.reports.sendDue() },
    // ---- AI answer visibility: ask every due question on every configured answer engine (daily/weekly per question).
    { name: "ai-visibility", everyMs: 60 * MIN, run: (m) => runVisibility(m) },
  ];
}

export interface InProcessJobs {
  stop(): void;
  /** Run one job now (tests, "refresh" buttons). */
  runNow(name: string): Promise<unknown>;
}

/**
 * The same jobs on timers inside one process, for deployments without Redis (the Dockerfile's single-container
 * mode). Without this the feed, radar, metrics and brief would never fill. Each job runs at most once at a time;
 * first runs are staggered so the server is up before any of them start.
 */
export function startInProcessJobs(m: Starsign, opts: MaintenanceOptions & { firstRunAfterMs?: number; log?: (line: string) => void } = {}): InProcessJobs {
  const log = opts.log ?? ((line: string) => console.log(line));
  const jobs = maintenanceJobs(opts);
  const running = new Set<string>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const run = async (job: MaintenanceJob): Promise<unknown> => {
    if (running.has(job.name)) return null;
    running.add(job.name);
    try {
      return await job.run(m);
    } catch (e) {
      log(`[jobs] ${job.name} failed: ${(e as Error).message}`);
      return null;
    } finally {
      running.delete(job.name);
    }
  };
  const first = opts.firstRunAfterMs ?? 30_000;
  jobs.forEach((job, i) => {
    const start = setTimeout(() => {
      void run(job);
      const every = setInterval(() => void run(job), job.everyMs);
      every.unref?.();
      timers.push(every);
    }, first + i * 10_000);
    start.unref?.();
    timers.push(start);
  });
  log(`[jobs] running ${jobs.length} background jobs in this process (no REDIS_URL): ${jobs.map((j) => j.name).join(", ")}`);
  return {
    stop: () => {
      for (const t of timers) clearTimeout(t as ReturnType<typeof setTimeout>);
      for (const t of timers) clearInterval(t as ReturnType<typeof setInterval>);
    },
    runNow: (name) => {
      const job = jobs.find((j) => j.name === name);
      if (!job) throw new Error(`no job named ${name}`);
      return run(job);
    },
  };
}
