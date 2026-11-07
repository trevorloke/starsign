import { CoreContext, type CoreDeps } from "./context.ts";
import { AccountService } from "./services/accounts.ts";
import { ApprovalService } from "./services/approvals.ts";
import { ExportService } from "./services/export.ts";
import { ListeningService } from "./services/listening.ts";
import { MetricsService } from "./services/metrics.ts";
import { OpsService } from "./services/ops.ts";
import { PolicyService } from "./services/policy.ts";
import { PostService } from "./services/posts.ts";
import { PublishingService } from "./services/publishing.ts";
import { TrendService } from "./services/trends.ts";
import { WorkspaceService } from "./services/workspaces.ts";
import { BrandService } from "./services/brand.ts";
import { SourcesService } from "./services/sources.ts";
import { ExperimentService } from "./services/experiments.ts";
import { MediaService } from "./services/media.ts";
import { LinkService } from "./services/links.ts";
import { TranslationService } from "./services/translation.ts";
import { EntityService } from "./services/entities.ts";
import { EngagementService, WebhookService } from "./services/listening.ts";
import { storageFromEnv } from "./media/storage.ts";
import { AuthService } from "./services/auth.ts";
// ---- inbox workflow
import { InboxService } from "./services/inbox.ts";
// ---- AI answer visibility
import { VisibilityService } from "./services/visibility.ts";
// ---- analytics & client reports
import { AnalyticsService } from "./services/analytics.ts";
import { ReportService } from "./services/reports.ts";

/** The one object every front door (API, MCP, operators, workers) talks to. */
export class Starsign {
  readonly ctx: CoreContext;
  readonly workspaces: WorkspaceService;
  readonly accounts: AccountService;
  readonly policy: PolicyService;
  readonly posts: PostService;
  readonly approvals: ApprovalService;
  readonly publishing: PublishingService;
  readonly listening: ListeningService;
  readonly metrics: MetricsService;
  readonly trends: TrendService;
  readonly ops: OpsService;
  readonly exports: ExportService;
  readonly sources: SourcesService;
  readonly brand: BrandService;
  readonly experiments: ExperimentService;
  readonly media: MediaService;
  readonly links: LinkService;
  readonly translations: TranslationService;
  readonly entities: EntityService;
  readonly engagement: EngagementService;
  readonly webhooks: WebhookService;
  readonly auth: AuthService;
  // ---- inbox workflow
  readonly inbox: InboxService;
  // ---- AI answer visibility
  readonly visibility: VisibilityService;
  // ---- analytics & client reports
  readonly analytics: AnalyticsService;
  readonly reports: ReportService;

  constructor(deps: CoreDeps) {
    this.ctx = new CoreContext(deps);
    this.workspaces = new WorkspaceService(this.ctx);
    this.accounts = new AccountService(this.ctx);
    this.policy = new PolicyService(this.ctx);
    this.posts = new PostService(this.ctx, this.policy);
    this.approvals = new ApprovalService(this.ctx, this.posts, this.policy);
    this.links = new LinkService(this.ctx, deps.linkBaseUrl === undefined ? {} : { baseUrl: deps.linkBaseUrl });
    this.publishing = new PublishingService(this.ctx, this.accounts, this.links);
    this.listening = new ListeningService(this.ctx, this.accounts);
    this.metrics = new MetricsService(this.ctx, this.accounts, this.policy, this.links);
    this.trends = new TrendService(this.ctx);
    this.ops = new OpsService(this.ctx);
    this.translations = new TranslationService(this.ctx, this.ops);
    this.entities = new EntityService(this.ctx, this.trends, this.listening);
    // Every stored message and every new translation is scanned for tracked parties, brands and people.
    this.listening.afterIngest.push((ws, ids) => this.entities.scanActivities(ws, ids));
    this.translations.afterTranslate.push((ws, ids) => this.entities.scanActivities(ws, ids));
    this.exports = new ExportService(this.ctx);
    this.sources = new SourcesService(this.ctx, this.trends);
    this.brand = new BrandService(this.ctx, this.workspaces, this.policy, this.accounts);
    this.experiments = new ExperimentService(this.ctx);
    this.media = new MediaService(this.ctx, deps.mediaStorage ?? storageFromEnv());
    this.engagement = new EngagementService(this.ctx, this.posts, this.accounts);
    this.webhooks = new WebhookService(this.ctx, this.listening, this.accounts);
    this.auth = new AuthService(this.ctx, this.workspaces, deps.auth);
    // ---- inbox workflow: new messages become conversations after the tracker has scanned them (rules can match entities).
    this.inbox = new InboxService(this.ctx, this.policy);
    this.listening.afterIngest.push((ws, ids) => this.inbox.onIngest(ws, ids));
    // ---- end inbox workflow
    // ---- AI answer visibility
    this.visibility = new VisibilityService(this.ctx, this.entities, this.ops, this.policy);
    // ---- analytics & client reports (reports mail through the same mailer as invites)
    this.analytics = new AnalyticsService(this.ctx, this.policy, this.metrics, this.links);
    this.reports = new ReportService(
      this.ctx,
      { analytics: this.analytics, policy: this.policy, links: this.links, entities: this.entities, posts: this.posts },
      { mailer: deps.auth?.mailer, publicUrl: deps.auth?.publicUrl },
    );
    // ---- end analytics & client reports
    // Upload-style connectors read media bytes through the library.
    const fetcher = this.media.fetcher();
    for (const c of this.ctx.connectors.list()) c.media = fetcher;
  }

  get events() {
    return this.ctx.events;
  }
  get emitter() {
    return this.ctx.emitter;
  }
}
