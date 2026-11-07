import { z } from "zod";
import { Actor, Id, Timestamp } from "./common.ts";

/**
 * Starsign Open Event Schema v0.
 *
 * Two append-only logs:
 *  - raw_events:    every payload received from any source, verbatim. Never updated, never deleted.
 *  - ledger_events: every domain fact Starsign asserts (a post was created, a policy blocked something,
 *                   an operator acted, an outcome was captured). Derived tables are rebuildable from these.
 */
export const RawEventInput = z.object({
  source: z.string().min(1),
  kind: z.string().min(1),
  workspaceId: Id.nullable(),
  externalId: z.string().nullable(),
  payload: z.unknown(),
  receivedAt: Timestamp.optional(),
});
export type RawEventInput = z.input<typeof RawEventInput>;

export const LedgerEventType = z.enum([
  "workspace.created",
  "apikey.created",
  "apikey.revoked",
  "user.signed_up",
  "member.added",
  "member.removed",
  "member.role_changed",
  "invite.created",
  "invite.accepted",
  "invite.revoked",
  "account.connected",
  "account.disconnected",
  "policy.updated",
  "policy.evaluated",
  "policy.blocked",
  "post.created",
  "post.updated",
  "post.approval_requested",
  "post.approval_decided",
  "post.scheduled",
  "post.publish_started",
  "variant.published",
  "variant.first_comment",
  "activity.moderated",
  "webhook.received",
  "link.created",
  "link.disabled",
  "conversion.recorded",
  "entity.created",
  "entity.updated",
  "entity.archived",
  "variant.failed",
  "post.published",
  "post.failed",
  "post.cancelled",
  "activity.ingested",
  "metric.observed",
  "outcome.scheduled",
  "outcome.captured",
  "trend.points_recorded",
  "trend.topic_created",
  "source.pulled",
  "trend.forecast_computed",
  "trend.action_recorded",
  "experiment.started",
  "experiment.concluded",
  "operator.run_started",
  "operator.run_finished",
  "operator.proposal",
  "operator.alert",
  "brief.written",
  "export.requested",
  // ---- inbox workflow
  "inbox.item_updated",
  "inbox.reopened",
  "inbox.responded",
  "inbox.note_added",
  "inbox.note_updated",
  "inbox.note_deleted",
  "inbox.mentioned",
  "inbox.rule_created",
  "inbox.rule_updated",
  "inbox.rule_deleted",
  "inbox.rule_applied",
  "inbox.saved_reply_created",
  "inbox.saved_reply_updated",
  "inbox.saved_reply_deleted",
  "inbox.settings_updated",
  // ---- end inbox workflow
  // ---- analytics & client reports
  "report.created",
  "report.updated",
  "report.deleted",
  "report.sent",
  "report.shared",
  "report.share_revoked",
  // ---- end analytics & client reports
  // ---- AI answer visibility
  "visibility.prompt_created",
  "visibility.prompt_updated",
  "visibility.prompt_archived",
  "visibility.settings_updated",
  "visibility.run_completed",
  // ---- end AI answer visibility
]);
export type LedgerEventType = z.infer<typeof LedgerEventType>;

export const LedgerEventInput = z.object({
  workspaceId: Id,
  type: LedgerEventType,
  subjectType: z.string().min(1),
  subjectId: Id,
  actor: Actor,
  data: z.record(z.string(), z.unknown()).default({}),
  occurredAt: Timestamp.optional(),
});
export type LedgerEventInput = z.input<typeof LedgerEventInput>;

export const LedgerEvent = LedgerEventInput.extend({
  id: Id,
  occurredAt: Timestamp,
  seq: z.number().int(),
});
export type LedgerEvent = z.infer<typeof LedgerEvent>;

export const SCHEMA_VERSION = "0.1.0";
