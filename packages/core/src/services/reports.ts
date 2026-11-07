import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { mediaAssets, reports, reportShares, workspaces } from "@starsign/db";
import { newId } from "@starsign/ledger";
import type { Actor } from "@starsign/schema";
import type { CoreContext, Principal } from "../context.ts";
import { sha256 } from "../crypto.ts";
import { CoreError } from "../errors.ts";
import type { AnalyticsService } from "./analytics.ts";
import { resendMailerFromEnv, type Mailer } from "./auth.ts";
import type { EntityService } from "./entities.ts";
import type { LinkService } from "./links.ts";
import type { PolicyService } from "./policy.ts";
import type { PostService } from "./posts.ts";
import {
  DEFAULT_ACCENT,
  REPORT_SECTIONS,
  renderReportHtml,
  scheduleSummary,
  type ReportDocument,
  type ReportScheduleSpec,
  type ReportSection,
  type ReportTrackerRow,
} from "./analytics-shared.ts";

/**
 * Client reports: a saved definition (period, sections, branding, recipients, schedule) rendered on demand into a
 * self-contained HTML document from the same numbers as Analytics. Reports can be emailed now, emailed on a schedule
 * (once per period: `last_sent_period`), or read through a public, read-only share link whose token is stored only
 * as its sha256. Every send and every share is in the ledger.
 *
 * Roles: owners, approvers and editors manage reports; viewers read and render them; agents (API keys acting as
 * mcp/operator) can read, render, send and change a report, but never its recipients.
 */

export const ReportPeriod = z.enum(["last_7_days", "last_30_days", "calendar_month"]);
export type ReportPeriod = z.infer<typeof ReportPeriod>;

export const ReportSchedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  /** weekday 0 = Monday … 6 = Sunday; hour in the workspace's time zone. */
  z.object({ kind: z.literal("weekly"), weekday: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23) }),
  /** day 1-28 so every month has it. */
  z.object({ kind: z.literal("monthly"), day: z.number().int().min(1).max(28), hour: z.number().int().min(0).max(23) }),
]);

const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const Text = (max: number) => z.string().trim().max(max);

export const ReportBranding = z.object({
  title: Text(120).optional(),
  clientName: Text(120).optional(),
  /** An image from the workspace's media library. */
  logoMediaId: z.string().max(64).nullable().optional(),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, "accent must be a colour like #1f5eff").optional(),
});

const Fields = {
  name: Text(120).min(1),
  period: ReportPeriod,
  sections: z.array(z.enum(REPORT_SECTIONS)).min(1).max(REPORT_SECTIONS.length),
  branding: ReportBranding,
  recipients: z.array(Email).max(25),
  schedule: ReportSchedule,
  filters: z.object({ networks: z.array(z.string().max(40)).max(40).optional(), accounts: z.array(z.string().max(64)).max(100).optional() }),
  intro: Text(2000).nullable(),
};
export const ReportInput = z.object({
  name: Fields.name,
  period: Fields.period.optional(),
  sections: Fields.sections.optional(),
  branding: Fields.branding.optional(),
  recipients: Fields.recipients.optional(),
  schedule: Fields.schedule.optional(),
  filters: Fields.filters.optional(),
  intro: Fields.intro.optional(),
});
export const ReportPatch = ReportInput.partial();
export type ReportInput = z.input<typeof ReportInput>;

export const DEFAULT_SECTIONS: ReportSection[] = ["summary", "by_network", "top_posts", "links", "what_worked", "upcoming"];

type ReportRow = typeof reports.$inferSelect;

export interface ReportView {
  id: string;
  name: string;
  period: ReportPeriod;
  sections: ReportSection[];
  branding: { title: string | null; clientName: string | null; logoMediaId: string | null; logoUrl: string | null; accent: string };
  recipients: string[];
  schedule: ReportScheduleSpec;
  scheduleSummary: string;
  nextSendAt: string | null;
  filters: { networks: string[]; accounts: string[] };
  intro: string | null;
  lastSentAt: string | null;
  lastSentPeriod: string | null;
  shares: { active: number; lastCreatedAt: string | null };
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
}

export interface ReportOptions {
  /** Undefined: Resend from the environment when configured. Null: never send mail. */
  mailer?: Mailer | null;
  /** Base for share links in scheduled emails. Default: STARSIGN_PUBLIC_URL. */
  publicUrl?: string;
}

// ---------------------------------------------------------------- time, in the workspace's zone (pure; exported for tests)

function wall(at: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at))) p[x.type] = x.value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}
function offsetMs(at: number, tz: string): number {
  const w = wall(at, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(at / 1000) * 1000;
}
/** The instant a local wall-clock time happens in `tz` (two passes settle the offset across DST). */
export function zonedTime(y: number, m: number, d: number, h: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h);
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz);
  return new Date(t);
}
/** Local calendar date `days` away from (y, m, d). */
function shiftDate(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const x = new Date(Date.UTC(y, m - 1, d + days));
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() };
}
const iso = (x: { y: number; m: number; d: number }) => `${x.y}-${String(x.m).padStart(2, "0")}-${String(x.d).padStart(2, "0")}`;
const weekdayOf = (x: { y: number; m: number; d: number }) => (new Date(Date.UTC(x.y, x.m - 1, x.d)).getUTCDay() + 6) % 7;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = (x: { y: number; m: number; d: number }) => `${MONTHS[x.m - 1]!.slice(0, 3)} ${x.d}`;

/** The period a report covers when produced at `at`: always whole local days that have ended. */
export function reportPeriod(period: ReportPeriod, at: Date, tz: string): { from: Date; to: Date; key: string; label: string } {
  const now = wall(at.getTime(), tz);
  const today = { y: now.y, m: now.m, d: now.d };
  if (period === "calendar_month") {
    const first = { y: now.m === 1 ? now.y - 1 : now.y, m: now.m === 1 ? 12 : now.m - 1, d: 1 };
    const from = zonedTime(first.y, first.m, 1, 0, tz);
    const to = new Date(zonedTime(now.y, now.m, 1, 0, tz).getTime() - 1);
    return { from, to, key: `calendar_month:${first.y}-${String(first.m).padStart(2, "0")}`, label: `${MONTHS[first.m - 1]} ${first.y}` };
  }
  const days = period === "last_30_days" ? 30 : 7;
  const start = shiftDate(today.y, today.m, today.d, -days);
  const last = shiftDate(today.y, today.m, today.d, -1);
  const from = zonedTime(start.y, start.m, start.d, 0, tz);
  const to = new Date(zonedTime(today.y, today.m, today.d, 0, tz).getTime() - 1);
  const label = `${SHORT(start)}${start.y !== last.y ? `, ${start.y}` : ""} – ${SHORT(last)}, ${last.y}`;
  return { from, to, key: `${period}:${iso(start)}`, label };
}

/** The most recent scheduled moment at or before `now`. */
export function lastOccurrence(s: ReportScheduleSpec, now: Date, tz: string): Date | null {
  if (s.kind === "none") return null;
  const w = wall(now.getTime(), tz);
  if (s.kind === "weekly") {
    for (let k = 0; k <= 7; k++) {
      const day = shiftDate(w.y, w.m, w.d, -k);
      if (weekdayOf(day) !== s.weekday) continue;
      const t = zonedTime(day.y, day.m, day.d, s.hour, tz);
      if (t.getTime() <= now.getTime()) return t;
    }
    return null;
  }
  const thisMonth = zonedTime(w.y, w.m, s.day, s.hour, tz);
  if (thisMonth.getTime() <= now.getTime()) return thisMonth;
  const pm = w.m === 1 ? { y: w.y - 1, m: 12 } : { y: w.y, m: w.m - 1 };
  return zonedTime(pm.y, pm.m, s.day, s.hour, tz);
}

/** The next scheduled moment after `now`. */
export function nextOccurrence(s: ReportScheduleSpec, now: Date, tz: string): Date | null {
  if (s.kind === "none") return null;
  const w = wall(now.getTime(), tz);
  if (s.kind === "weekly") {
    for (let k = 0; k <= 8; k++) {
      const day = shiftDate(w.y, w.m, w.d, k);
      if (weekdayOf(day) !== s.weekday) continue;
      const t = zonedTime(day.y, day.m, day.d, s.hour, tz);
      if (t.getTime() > now.getTime()) return t;
    }
    return null;
  }
  const thisMonth = zonedTime(w.y, w.m, s.day, s.hour, tz);
  if (thisMonth.getTime() > now.getTime()) return thisMonth;
  const nm = w.m === 12 ? { y: w.y + 1, m: 1 } : { y: w.y, m: w.m + 1 };
  return zonedTime(nm.y, nm.m, s.day, s.hour, tz);
}

/**
 * The period a scheduled report owes right now, or null. Due when its latest scheduled moment has passed, came after
 * the report was created, and the period that moment covers has not been sent yet.
 */
export function duePeriod(r: { schedule: ReportScheduleSpec; period: ReportPeriod; createdAt: Date; lastSentPeriod: string | null }, now: Date, tz: string) {
  const occ = lastOccurrence(r.schedule, now, tz);
  if (!occ || occ.getTime() < r.createdAt.getTime()) return null;
  const period = reportPeriod(r.period, occ, tz);
  return r.lastSentPeriod === period.key ? null : { ...period, occurrence: occ };
}

// ---------------------------------------------------------------- the service

const newToken = () => randomBytes(32).toString("base64url");
const SENDER: Actor = { type: "system", id: "reports" };

function isAgent(p: Principal): boolean {
  return p.actor.type === "mcp" || p.actor.type === "operator";
}
function canManage(p: Principal): boolean {
  return p.actor.type === "human" && !!p.role && ["owner", "approver", "editor"].includes(p.role);
}

export class ReportService {
  private readonly mailer: Mailer | null;

  constructor(
    private readonly ctx: CoreContext,
    private readonly deps: { analytics: AnalyticsService; policy: PolicyService; links: LinkService; entities: EntityService; posts: PostService },
    private readonly opts: ReportOptions = {},
  ) {
    this.mailer = opts.mailer === undefined ? resendMailerFromEnv() : opts.mailer;
  }

  get mailConfigured(): boolean {
    return this.mailer !== null;
  }

  private requireManager(p: Principal) {
    if (!canManage(p)) throw new CoreError("forbidden", "only owners, approvers and editors manage reports");
  }

  private async tz(workspaceId: string): Promise<string> {
    return (await this.deps.policy.getActive(workspaceId)).timezone || "UTC";
  }

  private async row(workspaceId: string, id: string): Promise<ReportRow> {
    const [r] = await this.ctx.db
      .select()
      .from(reports)
      .where(and(eq(reports.id, id), eq(reports.workspaceId, workspaceId), isNull(reports.deletedAt)))
      .limit(1);
    if (!r) throw new CoreError("not_found", `report ${id}`);
    return r;
  }

  private async logoUrl(workspaceId: string, mediaId: string | null | undefined): Promise<string | null> {
    if (!mediaId) return null;
    const [m] = await this.ctx.db
      .select({ url: mediaAssets.url, kind: mediaAssets.kind })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.id, mediaId), eq(mediaAssets.workspaceId, workspaceId)))
      .limit(1);
    return m && (m.kind === "image" || m.kind === "gif") ? m.url : null;
  }

  private async checkLogo(workspaceId: string, mediaId: string | null | undefined) {
    if (mediaId && !(await this.logoUrl(workspaceId, mediaId))) throw new CoreError("invalid", "the logo must be an image from this workspace's media library");
  }

  private async view(r: ReportRow, tz: string, shares?: { active: number; lastCreatedAt: Date | null }): Promise<ReportView> {
    const branding = r.branding as z.infer<typeof ReportBranding>;
    const schedule = ReportSchedule.catch({ kind: "none" }).parse(r.schedule) as ReportScheduleSpec;
    const filters = r.filters as { networks?: string[]; accounts?: string[] };
    const s = shares ?? (await this.shareStats([r.id])).get(r.id) ?? { active: 0, lastCreatedAt: null };
    const next = nextOccurrence(schedule, this.ctx.now(), tz);
    return {
      id: r.id,
      name: r.name,
      period: r.period,
      sections: r.sections as ReportSection[],
      branding: { title: branding.title || null, clientName: branding.clientName || null, logoMediaId: branding.logoMediaId ?? null, logoUrl: await this.logoUrl(r.workspaceId, branding.logoMediaId), accent: branding.accent ?? DEFAULT_ACCENT },
      recipients: r.recipients,
      schedule,
      scheduleSummary: scheduleSummary(schedule, r.recipients.length),
      nextSendAt: next && r.recipients.length ? next.toISOString() : null,
      filters: { networks: filters.networks ?? [], accounts: filters.accounts ?? [] },
      intro: r.intro,
      lastSentAt: r.lastSentAt?.toISOString() ?? null,
      lastSentPeriod: r.lastSentPeriod,
      shares: { active: s.active, lastCreatedAt: s.lastCreatedAt?.toISOString() ?? null },
      createdBy: r.createdBy as Actor,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private async shareStats(ids: string[]): Promise<Map<string, { active: number; lastCreatedAt: Date | null }>> {
    const out = new Map<string, { active: number; lastCreatedAt: Date | null }>();
    if (!ids.length) return out;
    const rows = await this.ctx.db
      .select({ reportId: reportShares.reportId, n: sql<number>`count(*)`, last: sql<Date | string | null>`max(${reportShares.createdAt})` })
      .from(reportShares)
      .where(and(inArray(reportShares.reportId, ids), isNull(reportShares.revokedAt)))
      .groupBy(reportShares.reportId);
    for (const r of rows) out.set(r.reportId, { active: Number(r.n), lastCreatedAt: r.last ? new Date(r.last) : null });
    return out;
  }

  // ------------------------------------------------------------ CRUD

  async list(p: Principal): Promise<ReportView[]> {
    const rows = await this.ctx.db
      .select()
      .from(reports)
      .where(and(eq(reports.workspaceId, p.workspaceId), isNull(reports.deletedAt)))
      .orderBy(desc(reports.updatedAt));
    const tz = await this.tz(p.workspaceId);
    const stats = await this.shareStats(rows.map((r) => r.id));
    return Promise.all(rows.map((r) => this.view(r, tz, stats.get(r.id) ?? { active: 0, lastCreatedAt: null })));
  }

  async get(p: Principal, id: string): Promise<ReportView> {
    return this.view(await this.row(p.workspaceId, id), await this.tz(p.workspaceId));
  }

  async create(p: Principal, raw: unknown): Promise<ReportView> {
    this.requireManager(p);
    const input = ReportInput.parse(raw);
    await this.checkLogo(p.workspaceId, input.branding?.logoMediaId);
    const now = this.ctx.now();
    const id = newId("rpt");
    const [r] = await this.ctx.db
      .insert(reports)
      .values({
        id,
        workspaceId: p.workspaceId,
        name: input.name,
        period: input.period ?? "last_7_days",
        sections: dedupe(input.sections ?? DEFAULT_SECTIONS),
        branding: input.branding ?? {},
        recipients: dedupe(input.recipients ?? []),
        schedule: input.schedule ?? { kind: "none" },
        filters: input.filters ?? {},
        intro: input.intro || null,
        createdBy: p.actor,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "report.created", subjectType: "report", subjectId: id, actor: p.actor, data: { name: input.name, recipients: r!.recipients.length, schedule: r!.schedule } });
    return this.view(r!, await this.tz(p.workspaceId));
  }

  async update(p: Principal, id: string, raw: unknown): Promise<ReportView> {
    if (!canManage(p) && !isAgent(p)) throw new CoreError("forbidden", "only owners, approvers and editors change reports");
    const patch = ReportPatch.parse(raw);
    if (isAgent(p) && patch.recipients !== undefined) throw new CoreError("forbidden", "agents cannot change who a report goes to");
    const current = await this.row(p.workspaceId, id);
    if (patch.branding?.logoMediaId) await this.checkLogo(p.workspaceId, patch.branding.logoMediaId);
    const set: Partial<typeof reports.$inferInsert> = { updatedAt: this.ctx.now() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.period !== undefined) set.period = patch.period;
    if (patch.sections !== undefined) set.sections = dedupe(patch.sections);
    if (patch.branding !== undefined) set.branding = { ...(current.branding as object), ...patch.branding };
    if (patch.recipients !== undefined) set.recipients = dedupe(patch.recipients);
    if (patch.schedule !== undefined) set.schedule = patch.schedule;
    if (patch.filters !== undefined) set.filters = patch.filters;
    if (patch.intro !== undefined) set.intro = patch.intro || null;
    const [r] = await this.ctx.db.update(reports).set(set).where(eq(reports.id, current.id)).returning();
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "report.updated", subjectType: "report", subjectId: id, actor: p.actor, data: { fields: Object.keys(patch) } });
    return this.view(r!, await this.tz(p.workspaceId));
  }

  /** Deleting also turns off every share link at once. */
  async remove(p: Principal, id: string): Promise<void> {
    this.requireManager(p);
    const r = await this.row(p.workspaceId, id);
    const now = this.ctx.now();
    await this.ctx.db.update(reports).set({ deletedAt: now, updatedAt: now }).where(eq(reports.id, r.id));
    await this.ctx.db.update(reportShares).set({ revokedAt: now }).where(and(eq(reportShares.reportId, r.id), isNull(reportShares.revokedAt)));
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "report.deleted", subjectType: "report", subjectId: id, actor: p.actor, data: { name: r.name } });
  }

  // ------------------------------------------------------------ rendering

  /** Everything the renderer needs, gathered for the report's period as of `at`. */
  async document(workspaceId: string, def: Pick<ReportRow, "name" | "period" | "sections" | "branding" | "filters" | "intro">, at = this.ctx.now(), viewUrl: string | null = null): Promise<ReportDocument> {
    const tz = await this.tz(workspaceId);
    const period = reportPeriod(def.period, at, tz);
    const branding = def.branding as z.infer<typeof ReportBranding>;
    const filters = def.filters as { networks?: string[]; accounts?: string[] };
    const sections = (def.sections as ReportSection[]).filter((s) => (REPORT_SECTIONS as readonly string[]).includes(s));
    const [ws] = await this.ctx.db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    const analytics = await this.deps.analytics.forWorkspace(workspaceId, { from: period.from, to: period.to, networks: filters.networks, accounts: filters.accounts });

    let links: ReportDocument["links"] = null;
    if (sections.includes("links")) {
      const l = await this.deps.links.report(workspaceId, period.from, period.to, tz);
      const currencies = l.totals.valueByCurrency.filter((c) => c.value);
      links = {
        configured: l.configured,
        clicks: l.totals.clicks,
        uniqueVisitors: l.totals.uniqueVisitors,
        conversions: l.totals.conversions,
        conversionValue: currencies[0]?.value ?? l.totals.conversionValue,
        currency: currencies.length === 1 ? (currencies[0]!.currency ?? null) : null,
        top: l.topLinks.map((t) => ({ shortUrl: t.shortUrl, destination: t.destination, network: t.network, clicks: t.clicksInRange, conversions: t.conversions })),
      };
    }

    let tracker: ReportTrackerRow[] | null = null;
    if (sections.includes("tracker")) {
      const rep = await this.deps.entities.report(workspaceId, period.from, period.to, tz);
      const byId = new Map(rep.entities.map((e) => [e.id, e]));
      const depth = (e: (typeof rep.entities)[number]) => {
        let d = 0;
        let cur = e;
        while (cur.parentId && byId.has(cur.parentId) && d < 4) {
          cur = byId.get(cur.parentId)!;
          d++;
        }
        return d;
      };
      const top = rep.entities.filter((e) => !e.parentId || !byId.has(e.parentId)).sort((a, b) => b.familyMentions - a.familyMentions);
      const ordered: typeof rep.entities = [];
      const walk = (e: (typeof rep.entities)[number]) => {
        if (ordered.includes(e)) return;
        ordered.push(e);
        for (const k of rep.entities.filter((x) => x.parentId === e.id).sort((a, b) => b.mentions - a.mentions)) walk(k);
      };
      top.forEach(walk);
      tracker = ordered.map((e) => ({ name: e.name, kind: e.kind, relation: e.relation, depth: depth(e), mentions: e.mentions, people: e.people, shareOfVoice: depth(e) === 0 ? e.shareOfVoice : e.shareWithinParent, sentiment: e.sentiment }));
    }

    let upcoming: ReportDocument["upcoming"] = null;
    if (sections.includes("upcoming")) {
      const now = this.ctx.now();
      const rows = await this.deps.posts.calendar(workspaceId, now, new Date(now.getTime() + 14 * 86_400_000));
      upcoming = rows
        .filter((r) => ["scheduled", "approved", "pending_approval"].includes(r.post.status) && r.post.scheduledAt)
        .map((r) => ({ at: r.post.scheduledAt!.toISOString(), networks: [...new Set(r.variants.map((v) => v.network))], text: r.post.body, status: r.post.status }));
    }

    return {
      title: branding.title || def.name,
      clientName: branding.clientName || null,
      workspaceName: ws?.name ?? "",
      logoUrl: await this.logoUrl(workspaceId, branding.logoMediaId),
      accent: branding.accent ?? DEFAULT_ACCENT,
      intro: def.intro,
      periodLabel: period.label,
      generatedAt: this.ctx.now().toISOString(),
      timezone: tz,
      sections,
      analytics,
      links,
      tracker,
      upcoming,
      viewUrl,
    };
  }

  /** Viewers, editors and agents may all render. */
  async render(p: Principal, id: string): Promise<string> {
    const r = await this.row(p.workspaceId, id);
    return renderReportHtml(await this.document(p.workspaceId, r));
  }

  /** The editor's live preview: renders a definition without saving it. */
  async preview(p: Principal, raw: unknown): Promise<string> {
    const input = ReportInput.parse(raw);
    return renderReportHtml(
      await this.document(p.workspaceId, {
        name: input.name,
        period: input.period ?? "last_7_days",
        sections: dedupe(input.sections ?? DEFAULT_SECTIONS),
        branding: input.branding ?? {},
        filters: input.filters ?? {},
        intro: input.intro || null,
      }),
    );
  }

  // ------------------------------------------------------------ share links

  private shareUrl(base: string, token: string): string {
    return `${base.replace(/\/+$/, "")}/r/${encodeURIComponent(token)}`;
  }

  private async mintShare(workspaceId: string, reportId: string, actor: Actor, purpose: "link" | "email") {
    const token = newToken();
    const id = newId("rsh");
    await this.ctx.db.insert(reportShares).values({ id, reportId, workspaceId, tokenHash: sha256(token), purpose, createdBy: actor, createdAt: this.ctx.now() });
    await this.ctx.events.append({ workspaceId, type: "report.shared", subjectType: "report", subjectId: reportId, actor, data: { shareId: id, purpose } });
    return { id, token };
  }

  /** A new read-only link. The token is shown once; only its sha256 is kept. */
  async share(p: Principal, id: string, baseUrl: string): Promise<{ id: string; url: string; createdAt: string }> {
    this.requireManager(p);
    const r = await this.row(p.workspaceId, id);
    const s = await this.mintShare(p.workspaceId, r.id, p.actor, "link");
    return { id: s.id, url: this.shareUrl(baseUrl, s.token), createdAt: this.ctx.now().toISOString() };
  }

  /** Turns off every link to the report, including the ones in emails already sent. */
  async revokeShares(p: Principal, id: string): Promise<{ revoked: number }> {
    this.requireManager(p);
    const r = await this.row(p.workspaceId, id);
    const rows = await this.ctx.db
      .update(reportShares)
      .set({ revokedAt: this.ctx.now() })
      .where(and(eq(reportShares.reportId, r.id), isNull(reportShares.revokedAt)))
      .returning({ id: reportShares.id });
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "report.share_revoked", subjectType: "report", subjectId: r.id, actor: p.actor, data: { revoked: rows.length } });
    return { revoked: rows.length };
  }

  /** The public view: the latest numbers for the report's period, read-only. Null for an unknown or revoked token. */
  async renderShared(token: string): Promise<string | null> {
    if (!token || token.length > 200) return null;
    const [s] = await this.ctx.db
      .select({ id: reportShares.id, reportId: reportShares.reportId, workspaceId: reportShares.workspaceId })
      .from(reportShares)
      .where(and(eq(reportShares.tokenHash, sha256(token)), isNull(reportShares.revokedAt)))
      .limit(1);
    if (!s) return null;
    const [r] = await this.ctx.db
      .select()
      .from(reports)
      .where(and(eq(reports.id, s.reportId), eq(reports.workspaceId, s.workspaceId), isNull(reports.deletedAt)))
      .limit(1);
    if (!r) return null;
    await this.ctx.db.update(reportShares).set({ lastViewedAt: this.ctx.now() }).where(eq(reportShares.id, s.id));
    return renderReportHtml(await this.document(r.workspaceId, r));
  }

  // ------------------------------------------------------------ sending

  private async deliver(r: ReportRow, actor: Actor, baseUrl: string | null, trigger: "manual" | "schedule", at: Date) {
    if (!this.mailer) throw new CoreError("unavailable", "email isn't set up on this server (RESEND_API_KEY and MAIL_FROM)");
    if (!r.recipients.length) throw new CoreError("invalid", "add at least one recipient first");
    const share = baseUrl ? await this.mintShare(r.workspaceId, r.id, actor, "email") : null;
    const viewUrl = share && baseUrl ? this.shareUrl(baseUrl, share.token) : null;
    const doc = await this.document(r.workspaceId, r, at, viewUrl);
    const html = renderReportHtml(doc);
    const subject = `${doc.title} · ${doc.periodLabel}`;
    const text = `${doc.title}${doc.clientName ? ` for ${doc.clientName}` : ""}, ${doc.periodLabel}.\n\n${viewUrl ? `Read it in your browser: ${viewUrl}\n\n` : ""}Sent by ${doc.workspaceName} with Starsign.`;
    for (const to of r.recipients) await this.mailer.send({ to, subject, text, html });
    const period = reportPeriod(r.period, at, doc.timezone);
    await this.ctx.events.append({ workspaceId: r.workspaceId, type: "report.sent", subjectType: "report", subjectId: r.id, actor, data: { trigger, recipients: r.recipients, period: period.key, shareId: share?.id ?? null } });
    return { sent: r.recipients.length, period: period.key, periodLabel: period.label, viewUrl };
  }

  /** Email the report now. Editors and up, and agents; viewers cannot. */
  async send(p: Principal, id: string, baseUrl: string | null) {
    if (!canManage(p) && !isAgent(p)) throw new CoreError("forbidden", "only owners, approvers, editors and agents send reports");
    const r = await this.row(p.workspaceId, id);
    const now = this.ctx.now();
    const out = await this.deliver(r, p.actor, baseUrl, "manual", now);
    await this.ctx.db.update(reports).set({ lastSentAt: now }).where(eq(reports.id, r.id));
    return out;
  }

  /**
   * The workers' job: send every scheduled report whose moment has passed, once per period. The period is claimed
   * with a conditional update before mailing, so two runners never both send it; a failed send releases it.
   */
  async sendDue(now = this.ctx.now()): Promise<{ due: number; sent: number; failed: number; skipped: number }> {
    const out = { due: 0, sent: 0, failed: 0, skipped: 0 };
    const rows = await this.ctx.db
      .select()
      .from(reports)
      .where(and(isNull(reports.deletedAt), sql`${reports.schedule}->>'kind' IN ('weekly', 'monthly')`));
    const tzs = new Map<string, string>();
    const base = (this.opts.publicUrl ?? process.env.STARSIGN_PUBLIC_URL ?? "").trim() || null;
    for (const r of rows) {
      const schedule = ReportSchedule.safeParse(r.schedule);
      if (!schedule.success) continue;
      const tz = tzs.get(r.workspaceId) ?? (await this.tz(r.workspaceId));
      tzs.set(r.workspaceId, tz);
      const due = duePeriod({ schedule: schedule.data, period: r.period, createdAt: r.createdAt, lastSentPeriod: r.lastSentPeriod }, now, tz);
      if (!due) continue;
      out.due++;
      if (!this.mailer || !r.recipients.length) {
        out.skipped++;
        continue;
      }
      const claimed = await this.ctx.db
        .update(reports)
        .set({ lastSentPeriod: due.key, lastSentAt: now })
        .where(and(eq(reports.id, r.id), r.lastSentPeriod === null ? isNull(reports.lastSentPeriod) : eq(reports.lastSentPeriod, r.lastSentPeriod)))
        .returning({ id: reports.id });
      if (!claimed.length) continue;
      try {
        await this.deliver({ ...r, lastSentPeriod: due.key }, SENDER, base, "schedule", due.occurrence);
        out.sent++;
      } catch (e) {
        out.failed++;
        console.error(`[reports] ${r.id} failed:`, e instanceof Error ? e.message : e);
        await this.ctx.db.update(reports).set({ lastSentPeriod: r.lastSentPeriod, lastSentAt: r.lastSentAt }).where(and(eq(reports.id, r.id), eq(reports.lastSentPeriod, due.key)));
      }
    }
    return out;
  }
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

