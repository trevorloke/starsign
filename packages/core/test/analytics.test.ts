import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "@starsign/db/test";
import { metrics, postOutcomes, type DbHandle } from "@starsign/db";
import { ConnectorRegistry, MockConnector } from "@starsign/connectors";
import {
  InMemoryScheduler,
  MIN_PER_SIDE,
  SecretBox,
  Starsign,
  bestTimesFrom,
  compareGroups,
  engagementsOf,
  hourRange,
  localDays,
  localSlot,
  median,
  pctChange,
  previousWindow,
  type Principal,
} from "../src/index.ts";

const HUMAN_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

describe("analytics math", () => {
  it("medians, changes and the previous equal period", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(pctChange(150, 100)).toBeCloseTo(0.5);
    expect(pctChange(50, 100)).toBeCloseTo(-0.5);
    expect(pctChange(0, 0)).toBe(0);
    expect(pctChange(10, 0)).toBeNull(); // no basis for a percentage
    expect(pctChange(null, 10)).toBeNull();
    const from = new Date("2026-11-01T00:00:00Z");
    const to = new Date("2026-11-08T00:00:00Z");
    const prev = previousWindow(from, to);
    expect(prev.to.getTime()).toBe(from.getTime() - 1);
    expect(prev.to.getTime() - prev.from.getTime()).toBe(to.getTime() - from.getTime()); // equal length, ending just before `from`
    expect(engagementsOf({ likes: 3, replies: 1, reposts: 2 })).toBe(6);
    expect(engagementsOf({ engagements: 9, likes: 3 })).toBe(9);
  });

  it("buckets by local weekday and hour across daylight saving changes", () => {
    const tz = "America/New_York";
    // 10am local on both sides of the March 8, 2026 spring-forward: different UTC hours, the same local hour.
    expect(localSlot(new Date("2026-03-07T15:00:00Z"), tz)).toEqual({ weekday: 5, hour: 10, day: "2026-03-07" });
    expect(localSlot(new Date("2026-03-08T14:00:00Z"), tz)).toEqual({ weekday: 6, hour: 10, day: "2026-03-08" });
    // And the November 1 fall-back: 14:00Z is 10am EDT on Oct 31 (Sat) and 9am EST on Nov 1 (Sun).
    expect(localSlot(new Date("2026-10-31T14:00:00Z"), tz).hour).toBe(10);
    expect(localSlot(new Date("2026-11-01T14:00:00Z"), tz)).toEqual({ weekday: 6, hour: 9, day: "2026-11-01" });
    // Tokyo is the next day already.
    expect(localSlot(new Date("2026-11-02T20:00:00Z"), "Asia/Tokyo")).toEqual({ weekday: 1, hour: 5, day: "2026-11-03" });

    const samples = ["2026-03-03T15:00:00Z", "2026-03-10T14:00:00Z", "2026-03-17T14:00:00Z"].map((s) => ({ at: new Date(s), rate: 0.05 }));
    const bt = bestTimesFrom(samples, tz, new Date("2026-03-01T00:00:00Z"), new Date("2026-03-31T00:00:00Z"));
    const tue10 = bt.cells.find((c) => c.weekday === 1 && c.hour === 10)!;
    expect(tue10).toMatchObject({ posts: 3, thin: false, medianRate: 0.05 }); // all three in one cell despite the clock change
    expect(bt.cells).toHaveLength(168);
  });

  it("marks thin cells and never recommends them", () => {
    const tz = "UTC";
    const at = (iso: string, rate: number) => ({ at: new Date(iso), rate });
    const two = bestTimesFrom([at("2026-11-03T09:00:00Z", 0.2), at("2026-11-10T09:00:00Z", 0.3)], tz, new Date("2026-11-01"), new Date("2026-11-30"));
    expect(two.cells.find((c) => c.weekday === 1 && c.hour === 9)).toMatchObject({ posts: 2, thin: true, medianRate: 0.25 });
    expect(two.best).toBeNull();
    expect(two.recommendation).toMatch(/^Not enough posts yet/);
    expect(bestTimesFrom([], tz, new Date("2026-11-01"), new Date("2026-11-30")).recommendation).toMatch(/^No posts with 24-hour numbers yet/);
  });

  it("recommends the strongest hours in a plain sentence", () => {
    const tz = "Europe/Berlin";
    const s: { at: Date; rate: number }[] = [];
    // Tuesdays and Thursdays at 9 and 10 local (CET = UTC+1 in November): strong. Mondays at 15: weak.
    for (const d of ["2026-11-03", "2026-11-10", "2026-11-17"]) for (const h of ["08", "09"]) s.push({ at: new Date(`${d}T${h}:00:00Z`), rate: 0.08 });
    for (const d of ["2026-11-05", "2026-11-12", "2026-11-19"]) for (const h of ["08", "09"]) s.push({ at: new Date(`${d}T${h}:00:00Z`), rate: 0.075 });
    for (const d of ["2026-11-02", "2026-11-09", "2026-11-16"]) s.push({ at: new Date(`${d}T14:00:00Z`), rate: 0.01 });
    // A single spectacular Sunday post: thin, so it does not win.
    s.push({ at: new Date("2026-11-08T12:00:00Z"), rate: 0.9 });
    const bt = bestTimesFrom(s, tz, new Date("2026-11-01"), new Date("2026-11-30"));
    expect(bt.best).toMatchObject({ weekdays: [1, 3], fromHour: 9, toHour: 11 });
    expect(bt.recommendation).toBe("Tuesdays and Thursdays 9–11am have done best; based on 16 posts.");
    expect(hourRange(11, 13)).toBe("11am–1pm");
  });

  it("never claims a difference with fewer than five posts a side", () => {
    const few = compareGroups("media", "Media", "Posts with images or video", "Posts without", [10, 20, 30, 40], [1, 2, 3, 4, 5, 6]);
    expect(few.verdict).toBe("not_enough");
    expect(few.ratio).toBeNull();
    expect(few.sentence).toMatch(/Not enough posts yet/);
    expect(few.sentence).toContain(`${MIN_PER_SIDE} each needed`);
    const ok = compareGroups("media", "Media", "Posts with images or video", "Posts without", [10, 20, 30, 40, 50], [5, 10, 15, 20, 25]);
    expect(ok).toMatchObject({ verdict: "better", ratio: 2 });
    expect(ok.sentence).toBe("Posts with images or video got 2.0× the median engagements of posts without (5 vs 5 posts).");
    expect(compareGroups("x", "x", "A", "B", [10, 10, 10, 10, 10], [10, 10, 10, 10, 10]).verdict).toBe("similar");
  });

  it("lists local days with their closing instants", () => {
    const days = localDays(new Date("2026-11-01T00:00:00Z"), new Date("2026-11-03T23:59:59Z"), "America/Los_Angeles");
    expect(days.map((d) => d.day)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
  });
});

describe("analytics from the ledger", () => {
  let h: DbHandle;
  let m: Starsign;
  let mock: MockConnector;
  let owner: Principal;
  let viewer: Principal;
  let acctX: string;
  let acctMasto: string;
  let clock = Date.parse("2026-11-02T12:00:00Z");
  const now = () => new Date(clock);

  async function publishAt(iso: string, accountId: string, text: string, extra: Record<string, unknown> = {}) {
    clock = Date.parse(iso);
    const r = await m.posts.create(owner, { body: text, variants: [{ socialAccountId: accountId, text }], scheduledAt: now().toISOString(), ...extra });
    await m.publishing.publishPost(r.post.id);
    const detail = await m.posts.get(owner.workspaceId, r.post.id);
    return { postId: r.post.id, variant: detail.variants[0]! };
  }
  async function capture(variantId: string, offset: string, values: Record<string, number>) {
    const [o] = await h.db
      .select()
      .from(postOutcomes)
      .where(and(eq(postOutcomes.variantId, variantId), eq(postOutcomes.offsetLabel, offset)));
    await m.ctx.outcomes.capture({ outcomeId: o!.id, metrics: values, capturedAt: now(), actor: { type: "system", id: "test" } });
  }

  beforeAll(async () => {
    h = await createTestDb();
    mock = new MockConnector();
    mock.now = now;
    m = new Starsign({ handle: h, connectors: new ConnectorRegistry().register(mock), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), now, linkBaseUrl: "https://go.acme.test" });
    const ws = await m.workspaces.create({ slug: "acme", name: "Acme", timezone: "UTC" }, { type: "human", id: "u1" });
    owner = { workspaceId: ws.id, actor: { type: "human", id: "u1" }, role: "owner" };
    viewer = { workspaceId: ws.id, actor: { type: "human", id: "u2" }, role: "viewer" };
    await m.policy.update(owner, { autonomy: { new_post: "autopost", reply: "autopost", dm: "suggest", repost: "draft", campaign: "suggest" }, redLines: [] });
    acctX = (await m.accounts.connect(owner, { network: "x", externalId: "1", handle: "acme", connector: "mock" })).id;
    acctMasto = (await m.accounts.connect(owner, { network: "mastodon", externalId: "2", handle: "acme@m.social", connector: "mock" })).id;

    // Previous week (Oct 26 – Nov 1): two posts.
    const a = await publishAt("2026-10-27T09:00:00Z", acctX, "Last week one");
    await capture(a.variant.id, "24h", { impressions: 1000, engagements: 40 });
    const b = await publishAt("2026-10-29T09:00:00Z", acctMasto, "Last week two");
    await capture(b.variant.id, "24h", { impressions: 1000, engagements: 20 });

    // This week (Nov 2 – Nov 8): three posts. One has 24h and 72h (72h wins), one only latest metrics, one 24h.
    const c = await publishAt("2026-11-02T09:00:00Z", acctX, "Big one with a link https://acme.example/sale");
    await capture(c.variant.id, "24h", { impressions: 2000, engagements: 100 });
    await capture(c.variant.id, "72h", { impressions: 3000, engagements: 150 });
    const d = await publishAt("2026-11-03T15:00:00Z", acctMasto, "Fresh one");
    await m.metrics.record([
      { entityType: "post_variant", entityId: d.variant.externalId!, metric: "impressions", value: 500, observedAt: now().toISOString(), source: "mock" },
      { entityType: "post_variant", entityId: d.variant.externalId!, metric: "likes", value: 7, observedAt: now().toISOString(), source: "mock" },
    ]);
    const e = await publishAt("2026-11-04T10:00:00Z", acctX, "Quiet one");
    await capture(e.variant.id, "24h", { impressions: 1000, engagements: 10 });

    // A short link clicked twice by people and once by a preview crawler, this week.
    clock = Date.parse("2026-11-05T10:00:00Z");
    const link = await m.links.create(owner, { url: "https://acme.example/sale", network: "x" });
    await m.links.click(link.slug, { userAgent: HUMAN_UA, ip: "1.1.1.1" });
    await m.links.click(link.slug, { userAgent: HUMAN_UA, ip: "2.2.2.2" });
    await m.links.click(link.slug, { userAgent: "facebookexternalhit/1.1", ip: "3.3.3.3" });

    // Followers on X: 100 before the week, 130 at its end.
    await m.metrics.record([
      { entityType: "social_account", entityId: acctX, metric: "followers_total", value: 100, observedAt: "2026-11-01T12:00:00Z", source: "mock" },
      { entityType: "social_account", entityId: acctX, metric: "followers_total", value: 118, observedAt: "2026-11-04T12:00:00Z", source: "mock" },
      { entityType: "social_account", entityId: acctX, metric: "followers_total", value: 130, observedAt: "2026-11-07T12:00:00Z", source: "mock" },
    ]);
    // Two mentions of the X account, one reply on Mastodon.
    await m.listening.ingestItems(owner.workspaceId, acctX, [
      { network: "x", kind: "mention", externalId: "m1", authorHandle: "fan", authorName: null, text: "@acme love it", url: null, parentExternalId: null, occurredAt: "2026-11-05T08:00:00Z", raw: {} },
      { network: "x", kind: "mention", externalId: "m2", authorHandle: "fan2", authorName: null, text: "@acme when is the sale", url: null, parentExternalId: null, occurredAt: "2026-11-06T08:00:00Z", raw: {} },
      { network: "x", kind: "like", externalId: "l1", authorHandle: "fan3", authorName: null, text: null, url: null, parentExternalId: null, occurredAt: "2026-11-06T08:00:00Z", raw: {} },
    ]);
    await m.listening.ingestItems(owner.workspaceId, acctMasto, [
      { network: "mastodon", kind: "reply", externalId: "r1", authorHandle: "pal", authorName: null, text: "Nice", url: null, parentExternalId: null, occurredAt: "2026-11-05T09:00:00Z", raw: {} },
    ]);
    clock = Date.parse("2026-11-09T00:00:00Z");
  });
  afterAll(() => h.close());

  const week = { from: new Date("2026-11-02T00:00:00Z"), to: new Date("2026-11-08T23:59:59.999Z") };

  it("totals the period against the previous equal period", async () => {
    const a = await m.analytics.get(viewer, week);
    expect(a.totals).toMatchObject({ posts: 3, impressions: 4500, engagements: 167, linkClicks: 2, followersGained: 30, mentions: 3 });
    expect(a.totals.engagementRate).toBeCloseTo(167 / 4500);
    expect(a.previous).toMatchObject({ posts: 2, impressions: 2000, engagements: 60 });
    expect(a.change.posts).toBeCloseTo(0.5);
    expect(a.change.impressions).toBeCloseTo(1.25);
    expect(a.measured).toEqual({ posts: 3, withNumbers: 3 });
    expect(a.window.timezone).toBe("UTC");
    expect(a.series).toHaveLength(7);
    expect(a.series.find((d) => d.day === "2026-11-02")).toMatchObject({ impressions: 3000, engagements: 150 });
    expect(a.series.find((d) => d.day === "2026-11-05")).toMatchObject({ clicks: 2 });
    expect(a.series.find((d) => d.day === "2026-11-08")?.followers).toBe(130);
    expect(a.series.find((d) => d.day === "2026-11-02")?.followers).toBe(100);
  });

  it("breaks down by network and account, and honours the filters", async () => {
    const a = await m.analytics.get(owner, week);
    const x = a.byNetwork.find((r) => r.network === "x")!;
    expect(x).toMatchObject({ posts: 2, impressions: 4000, engagements: 160, linkClicks: 2, mentions: 2, followersGained: 30 });
    expect(a.byAccount.find((r) => r.accountId === acctMasto)).toMatchObject({ handle: "acme@m.social", posts: 1, mentions: 1 });
    const onlyMasto = await m.analytics.get(owner, { ...week, networks: ["mastodon"] });
    expect(onlyMasto.totals).toMatchObject({ posts: 1, linkClicks: 0, mentions: 1, followersGained: null });
    const onlyX = await m.analytics.get(owner, { ...week, accounts: [acctX] });
    expect(onlyX.totals.posts).toBe(2);
  });

  it("ranks top posts by their best snapshot, falling back to the latest metrics", async () => {
    const a = await m.analytics.get(owner, week);
    expect(a.topPosts.map((p) => [p.text.split(" ")[0], p.basis, p.engagements])).toEqual([
      ["Big", "72h", 150],
      ["Quiet", "24h", 10],
      ["Fresh", "latest", 7],
    ]);
    expect(a.topPosts[0]!.url).toMatch(/^https:\/\/mock\.social\//);
    expect(a.topPosts[0]!.networks).toEqual(["x"]);
  });

  it("says when there are not enough posts to compare", async () => {
    const a = await m.analytics.get(owner, week);
    expect(a.whatWorked.minPerSide).toBe(5);
    for (const c of a.whatWorked.comparisons) expect(c.verdict).toBe("not_enough");
    expect(a.bestTimes.posts).toBe(4); // posts with a 24h rate in the 90-day lookback
    expect(a.bestTimes.best).toBeNull();
  });

  it("refuses an inverted or oversized window", async () => {
    await expect(m.analytics.get(owner, { from: week.to, to: week.from })).rejects.toThrow(/before/);
    await expect(m.analytics.get(owner, { from: new Date("2024-01-01"), to: week.to })).rejects.toThrow(/at most/);
  });

  it("reads follower series only from accounts in this workspace", async () => {
    const rows = await h.db.select().from(metrics).where(eq(metrics.entityId, acctX));
    expect(rows.length).toBe(3);
  });
});
