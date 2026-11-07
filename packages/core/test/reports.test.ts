import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "@starsign/db/test";
import { mediaAssets, postOutcomes, reportShares, reports, type DbHandle } from "@starsign/db";
import { ConnectorRegistry, MockConnector } from "@starsign/connectors";
import { InMemoryScheduler, SecretBox, Starsign, duePeriod, lastOccurrence, nextOccurrence, reportPeriod, scheduleSummary, sha256, type MailMessage, type Principal } from "../src/index.ts";

describe("report periods and schedules", () => {
  const tz = "America/New_York";
  it("covers whole local days that have ended", () => {
    const at = new Date("2026-11-09T15:00:00Z"); // Monday 10am EST
    const w = reportPeriod("last_7_days", at, tz);
    expect(w.from.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-11-09T04:59:59.999Z");
    expect(w.label).toBe("Nov 2 – Nov 8, 2026");
    expect(w.key).toBe("last_7_days:2026-11-02");
    const mo = reportPeriod("calendar_month", at, tz);
    // October starts in daylight time (UTC-4) and ends after the fall-back.
    expect(mo.from.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(mo.to.toISOString()).toBe("2026-11-01T03:59:59.999Z");
    expect(mo).toMatchObject({ key: "calendar_month:2026-10", label: "October 2026" });
    expect(reportPeriod("calendar_month", new Date("2027-01-03T12:00:00Z"), tz).key).toBe("calendar_month:2026-12");
    expect(reportPeriod("last_30_days", at, tz).label).toBe("Oct 10 – Nov 8, 2026");
  });

  it("finds the last and next scheduled moment in local time", () => {
    const weekly = { kind: "weekly" as const, weekday: 0, hour: 8 };
    expect(lastOccurrence(weekly, new Date("2026-11-09T12:00:00Z"), tz)?.toISOString()).toBe("2026-11-02T13:00:00.000Z"); // 7am local: last week's
    expect(lastOccurrence(weekly, new Date("2026-11-09T13:00:00Z"), tz)?.toISOString()).toBe("2026-11-09T13:00:00.000Z");
    expect(nextOccurrence(weekly, new Date("2026-11-09T13:00:00Z"), tz)?.toISOString()).toBe("2026-11-16T13:00:00.000Z");
    const monthly = { kind: "monthly" as const, day: 1, hour: 9 };
    expect(lastOccurrence(monthly, new Date("2026-11-09T12:00:00Z"), tz)?.toISOString()).toBe("2026-11-01T14:00:00.000Z");
    expect(nextOccurrence(monthly, new Date("2026-11-09T12:00:00Z"), tz)?.toISOString()).toBe("2026-12-01T14:00:00.000Z");
    expect(scheduleSummary(weekly, 3)).toBe("Every Monday at 8:00 to 3 people");
    expect(scheduleSummary(monthly, 1)).toBe("Monthly on the 1st at 9:00 to 1 person");
    expect(scheduleSummary({ kind: "none" }, 2)).toBe("Not scheduled");
  });

  it("is due once per period, and never for a moment before the report existed", () => {
    const r = { schedule: { kind: "weekly" as const, weekday: 0, hour: 8 }, period: "last_7_days" as const, createdAt: new Date("2026-11-01T00:00:00Z"), lastSentPeriod: null };
    const due = duePeriod(r, new Date("2026-11-09T14:00:00Z"), tz);
    expect(due?.key).toBe("last_7_days:2026-11-02");
    expect(duePeriod({ ...r, lastSentPeriod: due!.key }, new Date("2026-11-09T20:00:00Z"), tz)).toBeNull();
    expect(duePeriod({ ...r, createdAt: new Date("2026-11-09T15:00:00Z") }, new Date("2026-11-09T16:00:00Z"), tz)).toBeNull();
  });
});

describe("client reports", () => {
  let h: DbHandle;
  let m: Starsign;
  let owner: Principal;
  let editor: Principal;
  let viewer: Principal;
  let agent: Principal;
  let other: Principal;
  let logoId: string;
  let foreignLogoId: string;
  const sent: MailMessage[] = [];
  let failNext = false;
  let clock = Date.parse("2026-11-04T12:00:00Z");
  const now = () => new Date(clock);

  beforeAll(async () => {
    h = await createTestDb();
    const mock = new MockConnector();
    mock.now = now;
    m = new Starsign({
      handle: h,
      connectors: new ConnectorRegistry().register(mock),
      scheduler: new InMemoryScheduler(),
      secrets: new SecretBox(randomBytes(32)),
      now,
      linkBaseUrl: null,
      auth: {
        publicUrl: "https://app.acme.test",
        mailer: {
          async send(msg) {
            if (failNext) {
              failNext = false;
              throw new Error("mail down");
            }
            sent.push(msg);
          },
        },
      },
    });
    const ws = await m.workspaces.create({ slug: "acme", name: "Acme Agency", timezone: "UTC" }, { type: "human", id: "u1" });
    const ws2 = await m.workspaces.create({ slug: "other", name: "Other", timezone: "UTC" }, { type: "human", id: "u9" });
    owner = { workspaceId: ws.id, actor: { type: "human", id: "u1" }, role: "owner" };
    editor = { workspaceId: ws.id, actor: { type: "human", id: "u3" }, role: "editor" };
    viewer = { workspaceId: ws.id, actor: { type: "human", id: "u2" }, role: "viewer" };
    agent = { workspaceId: ws.id, actor: { type: "mcp", id: "claude" } };
    other = { workspaceId: ws2.id, actor: { type: "human", id: "u9" }, role: "owner" };
    await m.policy.update(owner, { autonomy: { new_post: "autopost", reply: "autopost", dm: "suggest", repost: "draft", campaign: "suggest" }, redLines: [] });
    const acct = (await m.accounts.connect(owner, { network: "x", externalId: "1", handle: "acme", connector: "mock" })).id;
    // Published inside the report's week (Oct 28 – Nov 3) with a 24h snapshot, and one post scheduled ahead.
    clock = Date.parse("2026-10-30T10:00:00Z");
    const r = await m.posts.create(owner, { body: "Hello <b>world</b> & friends", variants: [{ socialAccountId: acct, text: "Hello <b>world</b> & friends" }], scheduledAt: now().toISOString() });
    await m.publishing.publishPost(r.post.id);
    const [o] = await h.db.select().from(postOutcomes).where(and(eq(postOutcomes.postId, r.post.id), eq(postOutcomes.offsetLabel, "24h")));
    await m.ctx.outcomes.capture({ outcomeId: o!.id, metrics: { impressions: 900, engagements: 45 }, capturedAt: now(), actor: { type: "system", id: "test" } });
    clock = Date.parse("2026-11-04T12:00:00Z");
    await m.posts.create(owner, { body: "Next week: <u>sale</u>", variants: [{ socialAccountId: acct, text: "Next week: <u>sale</u>" }], scheduledAt: "2026-11-06T15:00:00Z" });
    const asset = (id: string, workspaceId: string, url: string) => ({ id, workspaceId, storageKey: `k/${id}`, url, kind: "image" as const, mime: "image/png", bytes: 10, sha256: id, uploadedBy: { type: "human" as const, id: "u1" } });
    logoId = "med_logo";
    foreignLogoId = "med_foreign";
    await h.db.insert(mediaAssets).values([asset(logoId, ws.id, "https://cdn.acme.test/logo.png"), asset(foreignLogoId, ws2.id, "https://cdn.other.test/logo.png")]);
  });
  afterAll(() => h.close());

  it("lets editors manage, viewers read and render, and agents send but not change recipients", async () => {
    await expect(m.reports.create(viewer, { name: "Nope" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(m.reports.create(agent, { name: "Nope" })).rejects.toMatchObject({ code: "forbidden" });
    const r = await m.reports.create(editor, { name: "Weekly for Bloom", recipients: ["Client@Bloom.test", "client@bloom.test"], branding: { clientName: "Bloom", logoMediaId: logoId, accent: "#0f8b8d" } });
    expect(r.recipients).toEqual(["client@bloom.test"]);
    expect(r.sections).toContain("summary");
    expect(r.branding.logoUrl).toBe("https://cdn.acme.test/logo.png");
    expect((await m.reports.list(viewer)).map((x) => x.id)).toContain(r.id);
    expect(await m.reports.render(viewer, r.id)).toContain("<!doctype html>");
    await expect(m.reports.update(viewer, r.id, { name: "x" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(m.reports.send(viewer, r.id, "https://app.acme.test")).rejects.toMatchObject({ code: "forbidden" });
    await expect(m.reports.update(agent, r.id, { recipients: ["evil@x.test"] })).rejects.toMatchObject({ code: "forbidden" });
    expect((await m.reports.update(agent, r.id, { intro: "Notes from the agent" })).intro).toBe("Notes from the agent");
    await expect(m.reports.share(agent, r.id, "https://app.acme.test")).rejects.toMatchObject({ code: "forbidden" });
    const out = await m.reports.send(agent, r.id, "https://app.acme.test");
    expect(out.sent).toBe(1);
    expect(sent.at(-1)).toMatchObject({ to: "client@bloom.test" });
    expect(sent.at(-1)!.html).toContain("Read this report in your browser");
    expect(sent.at(-1)!.text).toMatch(/https:\/\/app\.acme\.test\/r\//);
    await expect(m.reports.get(other, r.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(m.reports.create(owner, { name: "Bad logo", branding: { logoMediaId: foreignLogoId } })).rejects.toMatchObject({ code: "invalid" });
    await expect(m.reports.create(owner, { name: "Bad accent", branding: { accent: "red;}" } })).rejects.toThrow();
    const ledger = await m.events.list({ workspaceId: owner.workspaceId, types: ["report.created", "report.updated", "report.sent"] });
    expect(ledger.map((e) => e.type).sort()).toEqual(["report.created", "report.sent", "report.updated"]);
  });

  it("renders every section, escapes every user-written word, and fetches nothing but the logo", async () => {
    const r = await m.reports.create(owner, {
      name: "<script>alert(1)</script>",
      intro: `Hi "team" <img src=x onerror=alert(2)>`,
      sections: ["summary", "by_network", "top_posts", "best_times", "links", "tracker", "mentions", "what_worked", "upcoming"],
      branding: { clientName: "Bloom & <Co>", logoMediaId: logoId, title: "Report <i>title</i>" },
    });
    const html = await m.reports.render(owner, r.id);
    for (const h2 of ["Summary", "By network", "Top posts", "Best times to post", "Links and conversions", "Share of voice", "Mentions and sentiment", "What worked", "Coming up"]) expect(html).toContain(`<h2>${h2}</h2>`);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<i>title</i>");
    expect(html).toContain("Report &lt;i&gt;title&lt;/i&gt;");
    expect(html).toContain("Bloom &amp; &lt;Co&gt;");
    expect(html).toContain("Hi &quot;team&quot; &lt;img src=x onerror=alert(2)&gt;");
    expect(html).toContain("Hello &lt;b&gt;world&lt;/b&gt; &amp; friends");
    expect(html).toContain("Next week: &lt;u&gt;sale&lt;/u&gt;");
    expect(html).toContain('href="https://mock.social/acme/'); // the top post links to itself on the network
    // Anything that would load: only the logo. No stylesheets, scripts, fonts or background images from elsewhere.
    const loads = [...html.matchAll(/\b(?:src|srcset|poster)\s*=\s*"([^"]*)"/gi)].map((x) => x[1]);
    expect(loads).toEqual(["https://cdn.acme.test/logo.png"]);
    expect(html).not.toMatch(/<link\b|@import|url\((?!#)/i);
    expect(html).toContain("@media print");
    expect(html).toContain("break-inside:avoid");
  });

  it("previews an unsaved definition without storing anything", async () => {
    const before = (await m.reports.list(owner)).length;
    const html = await m.reports.preview(viewer, { name: "Draft", sections: ["summary"] });
    expect(html).toContain("<h1>Draft</h1>");
    expect((await m.reports.list(owner)).length).toBe(before);
  });

  it("shares a read-only link stored only as a hash, and revokes it", async () => {
    const r = await m.reports.create(owner, { name: "Shared one" });
    const s = await m.reports.share(owner, r.id, "https://app.acme.test");
    const token = decodeURIComponent(s.url.split("/r/")[1]!);
    expect(token.length).toBeGreaterThanOrEqual(40);
    const rows = await h.db.select().from(reportShares).where(eq(reportShares.reportId, r.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(await m.reports.renderShared(token)).toContain("<h1>Shared one</h1>");
    expect(await m.reports.renderShared("nope")).toBeNull();
    expect((await m.reports.get(viewer, r.id)).shares.active).toBe(1);
    await expect(m.reports.revokeShares(viewer, r.id)).rejects.toMatchObject({ code: "forbidden" });
    expect(await m.reports.revokeShares(owner, r.id)).toEqual({ revoked: 1 });
    expect(await m.reports.renderShared(token)).toBeNull();
    const types = (await m.events.list({ workspaceId: owner.workspaceId, subjectType: "report", subjectId: r.id })).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["report.shared", "report.share_revoked"]));
    // Deleting a report turns its links off too.
    const s2 = await m.reports.share(owner, r.id, "https://app.acme.test");
    await m.reports.remove(owner, r.id);
    expect(await m.reports.renderShared(decodeURIComponent(s2.url.split("/r/")[1]!))).toBeNull();
  });

  it("sends a scheduled report once per period, and again after a failure", async () => {
    clock = Date.parse("2026-11-04T12:00:00Z"); // a Wednesday
    const r = await m.reports.create(owner, { name: "Mondays", recipients: ["a@bloom.test", "b@bloom.test"], schedule: { kind: "weekly", weekday: 0, hour: 8 } });
    expect(r.scheduleSummary).toBe("Every Monday at 8:00 to 2 people");
    expect(r.nextSendAt).toBe("2026-11-09T08:00:00.000Z");
    const only = (res: { sent: number }) => res.sent;
    expect(only(await m.reports.sendDue())).toBe(0); // last Monday was before the report existed

    clock = Date.parse("2026-11-09T08:05:00Z");
    sent.length = 0;
    expect(await m.reports.sendDue()).toMatchObject({ sent: 1, failed: 0 });
    expect(sent.map((s) => s.to)).toEqual(["a@bloom.test", "b@bloom.test"]);
    expect(sent[0]!.subject).toBe("Mondays · Nov 2 – Nov 8, 2026");
    clock = Date.parse("2026-11-09T08:20:00Z");
    expect(only(await m.reports.sendDue())).toBe(0); // the same period is never sent twice
    const [row] = await h.db.select().from(reports).where(eq(reports.id, r.id));
    expect(row!.lastSentPeriod).toBe("last_7_days:2026-11-02");

    clock = Date.parse("2026-11-16T08:01:00Z");
    failNext = true;
    expect(await m.reports.sendDue()).toMatchObject({ sent: 0, failed: 1 });
    expect(await m.reports.sendDue()).toMatchObject({ sent: 1, failed: 0 }); // released and retried
    const sends = (await m.events.list({ workspaceId: owner.workspaceId, types: ["report.sent"], subjectType: "report", subjectId: r.id })).map((e) => e.data.period);
    expect(sends.sort()).toEqual(["last_7_days:2026-11-02", "last_7_days:2026-11-09"]);
  });
});
