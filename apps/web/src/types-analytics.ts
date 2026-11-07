// Analytics and client reports. The payload types come from the core's import-free report module, so the web app and
// the API can never disagree about the shape (type-only: nothing from the core ends up in the bundle from here).
export type {
  AnalyticsPayload,
  AnalyticsTotals,
  AccountRow as AnalyticsAccountRow,
  BestTimes,
  Comparison,
  DailyPoint,
  HeatCell,
  NetworkRow as AnalyticsNetworkRow,
  OutcomeBasis,
  ReportScheduleSpec,
  ReportSection,
  StageLift,
  TopPost,
  TotalKey,
} from "../../../packages/core/src/services/analytics-shared";

import type { ReportScheduleSpec, ReportSection } from "../../../packages/core/src/services/analytics-shared";

export interface AnalyticsQuery {
  from: string;
  to: string;
  networks?: string[];
  accounts?: string[];
}

export type ReportPeriod = "last_7_days" | "last_30_days" | "calendar_month";

export interface ReportBranding {
  title?: string;
  clientName?: string;
  logoMediaId?: string | null;
  accent?: string;
}

/** What POST /v1/reports and POST /v1/reports/preview take; PATCH takes any part of it. */
export interface ReportInput {
  name: string;
  period?: ReportPeriod;
  sections?: ReportSection[];
  branding?: ReportBranding;
  recipients?: string[];
  schedule?: ReportScheduleSpec;
  filters?: { networks?: string[]; accounts?: string[] };
  intro?: string | null;
}

export interface Report {
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
  createdBy: { type: string; id: string };
  createdAt: string;
  updatedAt: string;
}

export interface ReportSent {
  sent: number;
  period: string;
  periodLabel: string;
  viewUrl: string | null;
}

export interface ReportShare {
  id: string;
  url: string;
  createdAt: string;
}
