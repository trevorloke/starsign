import { eq, inArray } from "drizzle-orm";
import * as t from "@starsign/db";
import { SCHEMA_VERSION } from "@starsign/schema";
import type { CoreContext, Principal } from "../context.ts";

/** Everything a workspace owns, as one JSON document. Portability is a feature, not a risk. */
export class ExportService {
  constructor(private readonly ctx: CoreContext) {}

  async workspace(p: Principal) {
    const ws = p.workspaceId;
    const db = this.ctx.db;
    const postRows = await db.select().from(t.posts).where(eq(t.posts.workspaceId, ws));
    const postIds = postRows.map((r) => r.id);
    const variants = postIds.length ? await db.select().from(t.postVariants).where(inArray(t.postVariants.postId, postIds)) : [];
    // metrics rows are keyed by the network's external post id, not the variant id
    const variantIds = variants.map((v) => v.externalId).filter((x): x is string => !!x);
    const accounts = (await db.select().from(t.socialAccounts).where(eq(t.socialAccounts.workspaceId, ws))).map(({ authCiphertext, ...rest }) => ({ ...rest, hasCredentials: !!authCiphertext }));
    const topics = await db.select().from(t.trendTopics).where(eq(t.trendTopics.workspaceId, ws));
    const topicIds = topics.map((x) => x.id);
    await this.ctx.events.append({ workspaceId: ws, type: "export.requested", subjectType: "workspace", subjectId: ws, actor: p.actor });
    return {
      starsign: { schemaVersion: SCHEMA_VERSION, exportedAt: this.ctx.now().toISOString() },
      workspace: (await db.select().from(t.workspaces).where(eq(t.workspaces.id, ws)))[0] ?? null,
      policies: await db.select().from(t.policies).where(eq(t.policies.workspaceId, ws)),
      policyDecisions: await db.select().from(t.policyDecisions).where(eq(t.policyDecisions.workspaceId, ws)),
      socialAccounts: accounts,
      posts: postRows,
      postVariants: variants,
      approvals: await db.select().from(t.approvals).where(eq(t.approvals.workspaceId, ws)),
      approvalDiffs: await db.select().from(t.approvalDiffs).where(eq(t.approvalDiffs.workspaceId, ws)),
      experiments: await db.select().from(t.experiments).where(eq(t.experiments.workspaceId, ws)),
      streams: await db.select().from(t.streams).where(eq(t.streams.workspaceId, ws)),
      activities: await db.select().from(t.activities).where(eq(t.activities.workspaceId, ws)),
      metrics: variantIds.length ? await db.select().from(t.metrics).where(inArray(t.metrics.entityId, variantIds)) : [],
      postOutcomes: await db.select().from(t.postOutcomes).where(eq(t.postOutcomes.workspaceId, ws)),
      trendTopics: topics,
      trendPoints: topicIds.length ? await db.select().from(t.trendPoints).where(inArray(t.trendPoints.topicId, topicIds)) : [],
      trendForecasts: topicIds.length ? await db.select().from(t.trendForecasts).where(inArray(t.trendForecasts.topicId, topicIds)) : [],
      trendActions: await db.select().from(t.trendActions).where(eq(t.trendActions.workspaceId, ws)),
      mediaAssets: await db.select().from(t.mediaAssets).where(eq(t.mediaAssets.workspaceId, ws)),
      trackedLinks: await db.select().from(t.trackedLinks).where(eq(t.trackedLinks.workspaceId, ws)),
      linkClicks: await db.select().from(t.linkClicks).where(eq(t.linkClicks.workspaceId, ws)),
      conversions: await db.select().from(t.conversions).where(eq(t.conversions.workspaceId, ws)),
      alerts: await db.select().from(t.alerts).where(eq(t.alerts.workspaceId, ws)),
      briefs: await db.select().from(t.briefs).where(eq(t.briefs.workspaceId, ws)),
      operatorRuns: await db.select().from(t.operatorRuns).where(eq(t.operatorRuns.workspaceId, ws)),
      // ---- analytics & client reports (share links without their token hashes)
      reports: await db.select().from(t.reports).where(eq(t.reports.workspaceId, ws)),
      reportShares: (await db.select().from(t.reportShares).where(eq(t.reportShares.workspaceId, ws))).map(({ tokenHash, ...rest }) => rest),
      // ---- AI answer visibility
      visibilitySettings: await db.select().from(t.visibilitySettings).where(eq(t.visibilitySettings.workspaceId, ws)),
      visibilityPrompts: await db.select().from(t.visibilityPrompts).where(eq(t.visibilityPrompts.workspaceId, ws)),
      visibilityAnswers: await db.select().from(t.visibilityAnswers).where(eq(t.visibilityAnswers.workspaceId, ws)),
      visibilityMentions: await db.select().from(t.visibilityMentions).where(eq(t.visibilityMentions.workspaceId, ws)),
      // ---- end AI answer visibility
      ledgerEvents: await db.select().from(t.ledgerEvents).where(eq(t.ledgerEvents.workspaceId, ws)).orderBy(t.ledgerEvents.seq),
      rawEvents: await db.select().from(t.rawEvents).where(eq(t.rawEvents.workspaceId, ws)).orderBy(t.rawEvents.seq),
    };
  }
}
