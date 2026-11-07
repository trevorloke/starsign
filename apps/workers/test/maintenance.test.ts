import { describe, expect, it, vi } from "vitest";
import type { Starsign } from "@starsign/core";
import { maintenanceJobs, startInProcessJobs } from "../src/maintenance.ts";

function fakeStarsign() {
  return {
    metrics: { captureAccountMetrics: vi.fn(async () => ({ accounts: 0, metrics: 0 })) },
    links: { rollup: vi.fn(async () => 0) },
    entities: { scanPublic: vi.fn(async () => ({ entities: 0, found: 0, stored: 0, errors: [] })) },
    reports: { sendDue: vi.fn(async () => ({ due: 0, sent: 0, failed: 0, skipped: 0 })) },
    ctx: { now: () => new Date() },
  };
}

describe("background jobs without Redis", () => {
  it("lists every job once with its cadence", () => {
    const jobs = maintenanceJobs({ ingestEveryMs: 1000 });
    expect(jobs.map((j) => j.name)).toEqual(["ingest", "outcomes", "account-metrics", "links", "tracker-scan", "sources", "forecasts", "reports", "ai-visibility"]);
    expect(jobs[0]!.everyMs).toBe(1000);
  });

  it("runs jobs on their timers after a staggered start", async () => {
    vi.useFakeTimers();
    const m = fakeStarsign();
    const log: string[] = [];
    const jobs = startInProcessJobs(m as unknown as Starsign, { firstRunAfterMs: 1000, log: (l) => log.push(l) });
    expect(log[0]).toMatch(/running 9 background jobs/);
    await vi.advanceTimersByTimeAsync(500);
    expect(m.metrics.captureAccountMetrics).not.toHaveBeenCalled(); // nothing before the server is up
    await vi.advanceTimersByTimeAsync(40_000);
    expect(m.metrics.captureAccountMetrics).toHaveBeenCalledTimes(1);
    expect(m.links.rollup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(m.links.rollup).toHaveBeenCalledTimes(2); // every 15 minutes
    jobs.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(m.links.rollup).toHaveBeenCalledTimes(2); // stopped
    vi.useRealTimers();
  });

  it("never runs two of the same job at once, and logs a failing job instead of throwing", async () => {
    const m = fakeStarsign();
    let release!: () => void;
    m.links.rollup.mockImplementationOnce(() => new Promise<number>((r) => (release = () => r(0))));
    const log: string[] = [];
    const jobs = startInProcessJobs(m as unknown as Starsign, { firstRunAfterMs: 3_600_000, log: (l) => log.push(l) });
    const first = jobs.runNow("links");
    expect(await jobs.runNow("links")).toBeNull(); // skipped while the first is running
    release();
    await first;
    expect(m.links.rollup).toHaveBeenCalledTimes(1);
    m.links.rollup.mockRejectedValueOnce(new Error("db down"));
    expect(await jobs.runNow("links")).toBeNull();
    expect(log.some((l) => l.includes("links failed: db down"))).toBe(true);
    jobs.stop();
  });
});
