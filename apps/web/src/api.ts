import type {
  AcceptInviteInput,
  Account,
  AccountMetrics,
  Activity,
  AdaptInput,
  AdaptResult,
  Alert,
  Brief,
  ConnectCredentialsInput,
  ConnectStartInput,
  Connector,
  Conversion,
  CreateLinkInput,
  CreatePostInput,
  DecideInput,
  Discovery,
  AliasSuggestions,
  Entity,
  EntityInput,
  EntityMention,
  EntityPatch,
  EntityReport,
  FeedEvent,
  FeedQuery,
  InviteCreated,
  InviteInfo,
  LanguageSettings,
  LanguageSettingsPatch,
  LanguagesInfo,
  LiftByStage,
  LinkList,
  LinkReport,
  LinkSettingsPatch,
  LinkSettingsResponse,
  LiveStatus,
  MediaAsset,
  Me,
  Member,
  ModerateAction,
  OAuthStart,
  PendingInvite,
  Policy,
  PolicyCheckInput,
  PolicyDecision,
  PolicyVersion,
  PostDetail,
  PostFull,
  PostSummary,
  RadarEntry,
  ReplyInput,
  Role,
  Session,
  SignupInput,
  Stream,
  Summary,
  TopicDetail,
  TrackedLink,
  TrendSource,
  Workspace,
} from "./types";
// ---- inbox workflow
import type { InboxConversation, InboxEntry, InboxList, InboxNote, InboxPatch, InboxQuery, InboxRule, InboxRuleInput, InboxSettings, InboxSettingsPatch, SavedReply, SavedReplyInput } from "./types";
// ---- analytics & client reports
import type { AnalyticsPayload, AnalyticsQuery, Report, ReportInput, ReportSent, ReportShare } from "./types-analytics";
// ---- AI answer visibility
import type { VisAnswer, VisAnswersQuery, VisEngine, VisPrompt, VisPromptInput, VisReport, VisRunResult, VisSettingsPatch, VisSettingsResponse, VisSuggestion } from "./lib/visibility";
import { ApiError, setKeyMode } from "./lib/errors";

export { ApiError, isApiError, errorText, reasonOf, sentence } from "./lib/errors";

// "" by default: same origin, so the Vite dev/preview proxy forwards /v1 and /api to :4000.
const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

/** When true, every call is answered from src/dev/fixtures.ts and no network request is made. */
export const USE_FIXTURES = import.meta.env.VITE_USE_FIXTURES === "1";

export const API_KEY_STORAGE = "starsign.apiKey";

// Kept in memory too, so a private window (no storage) still works for this page load.
let memoryKey: string | null = null;

export function getApiKey(): string | null {
  try {
    const k = localStorage.getItem(API_KEY_STORAGE);
    const v = k && k.trim() ? k.trim() : memoryKey;
    setKeyMode(v !== null);
    return v;
  } catch {
    setKeyMode(memoryKey !== null);
    return memoryKey;
  }
}

export function setApiKey(key: string | null): void {
  memoryKey = key && key.trim() ? key.trim() : null;
  setKeyMode(memoryKey !== null);
  try {
    if (memoryKey) localStorage.setItem(API_KEY_STORAGE, memoryKey);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    // storage unavailable (private window); the key then lives only for this page load
  }
}

/**
 * Every request carries the session cookie (`credentials: "include"`); writes add the CSRF header the
 * server requires for cookie-authenticated changes. A pasted API key, when there is one, goes as a bearer.
 */
function authHeaders(method: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const key = getApiKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  if (method !== "GET" && method !== "HEAD") headers["x-starsign-csrf"] = "1";
  return headers;
}

function toApiError(status: number, statusText: string, text: string): ApiError {
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  return new ApiError(status, err?.code ?? `http_${status}`, err?.message ?? (statusText || "Request failed"), err?.details);
}

// A cookie session that lapses answers 401 (and the server clears the cookie). Whoever listens (the App)
// sends the person to Sign in. Auth endpoints and API-key mode handle their own 401s.
let unauthorizedListener: (() => void) | null = null;
export function onUnauthorized(fn: (() => void) | null): void {
  unauthorizedListener = fn;
}
const AUTH_PATHS = /^\/v1\/(auth\/|invites\/[^/]+$)/;

// Fixtures are a separate chunk; the production bundle never loads it unless VITE_USE_FIXTURES=1.
type Fixtures = typeof import("./dev/fixtures");
let fixturesPromise: Promise<Fixtures> | null = null;
function fixtures(): Promise<Fixtures> {
  fixturesPromise ??= import("./dev/fixtures");
  return fixturesPromise;
}

type Param = string | number | boolean | string[] | undefined | null;

function qs(params: Record<string, Param>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length) sp.set(k, v.join(","));
    } else {
      sp.set(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...authHeaders(method) };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "Couldn't reach Starsign.");
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 && !getApiKey() && !(AUTH_PATHS.test(path) && (method === "GET" || method === "POST"))) unauthorizedListener?.();
    throw toApiError(res.status, res.statusText, text);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

export interface UploadHandle {
  done: Promise<MediaAsset>;
  abort: () => void;
}

interface MediaLimits {
  maxUploadBytes: number;
  direct: boolean;
  types: string[];
}
let limitsPromise: Promise<MediaLimits | null> | null = null;
function mediaLimits(): Promise<MediaLimits | null> {
  limitsPromise ??= request<MediaLimits>("GET", "/v1/media/limits").catch(() => {
    limitsPromise = null; // try again next time
    return null;
  });
  return limitsPromise;
}

interface DirectUpload {
  uploadId: string;
  url: string;
  headers: Record<string, string>;
}

/**
 * Uploads one file. With S3 storage the file goes straight to the bucket (presign, PUT, complete), so big videos
 * never pass through the API; otherwise it is POSTed to /v1/media. XMLHttpRequest rather than fetch, because only
 * XHR reports upload progress. `onProgress` gets 0..1.
 */
function uploadLive(file: File, alt: string | undefined, onProgress: (p: number) => void): UploadHandle {
  let current: XMLHttpRequest | null = null;
  let aborted = false;
  const done = (async () => {
    const limits = await mediaLimits();
    if (aborted) throw new ApiError(0, "aborted", "Upload cancelled.");
    if (limits?.direct && limits.types.includes(file.type)) {
      const ticket = await request<DirectUpload>("POST", "/v1/media/uploads", { mime: file.type, bytes: file.size, filename: file.name });
      if (aborted) throw new ApiError(0, "aborted", "Upload cancelled.");
      await putToBucket(file, ticket, (p) => onProgress(p * 0.97), (x) => (current = x));
      const asset = await request<MediaAsset>("POST", "/v1/media/uploads/complete", { uploadId: ticket.uploadId, ...(alt && alt.trim() ? { alt: alt.trim() } : {}) });
      onProgress(1);
      return asset;
    }
    return multipart(file, alt, onProgress, (x) => (current = x));
  })();
  return {
    done,
    abort: () => {
      aborted = true;
      current?.abort();
    },
  };
}

/** The presigned PUT: no cookies, no API headers, only the headers the URL was signed with. */
function putToBucket(file: File, t: DirectUpload, onProgress: (p: number) => void, track: (x: XMLHttpRequest) => void): Promise<void> {
  const xhr = new XMLHttpRequest();
  track(xhr);
  return new Promise<void>((resolve, reject) => {
    xhr.open("PUT", t.url);
    for (const [k, v] of Object.entries(t.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, "storage", `The media storage refused the file (HTTP ${xhr.status}).`));
    // A CORS refusal looks like a network error from here; the bucket's CORS policy is the usual cause.
    xhr.onerror = () => reject(new ApiError(0, "network", "Couldn't reach the media storage. Check the bucket's CORS settings allow uploads from this site."));
    xhr.onabort = () => reject(new ApiError(0, "aborted", "Upload cancelled."));
    xhr.send(file);
  });
}

/** POST /v1/media as multipart. */
function multipart(file: File, alt: string | undefined, onProgress: (p: number) => void, track: (x: XMLHttpRequest) => void): Promise<MediaAsset> {
  const xhr = new XMLHttpRequest();
  track(xhr);
  return new Promise<MediaAsset>((resolve, reject) => {
    xhr.open("POST", `${BASE}/v1/media`);
    xhr.withCredentials = true;
    for (const [k, v] of Object.entries(authHeaders("POST"))) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          onProgress(1);
          resolve(JSON.parse(xhr.responseText) as MediaAsset);
        } catch {
          reject(new ApiError(xhr.status, "invalid", "The upload finished but the answer was unreadable."));
        }
      } else {
        if (xhr.status === 401 && !getApiKey()) unauthorizedListener?.();
        reject(toApiError(xhr.status, xhr.statusText, xhr.responseText));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "Couldn't reach Starsign."));
    xhr.onabort = () => reject(new ApiError(0, "aborted", "Upload cancelled."));
    const form = new FormData();
    form.append("file", file, file.name);
    if (alt && alt.trim()) form.append("alt", alt.trim());
    xhr.send(form);
  });
}

const get = <T,>(path: string) => request<T>("GET", path);
const post = <T,>(path: string, body?: unknown) => request<T>("POST", path, body);
const patch = <T,>(path: string, body?: unknown) => request<T>("PATCH", path, body);
const put = <T,>(path: string, body?: unknown) => request<T>("PUT", path, body);
const del = <T,>(path: string) => request<T>("DELETE", path);
const enc = encodeURIComponent;

/** Route a call to the live API or, in fixture mode, to the fixture implementation. */
function pick<T>(live: () => Promise<T>, mock: (f: Fixtures) => Promise<T>): Promise<T> {
  return USE_FIXTURES ? fixtures().then(mock) : live();
}

// ---- analytics & client reports: a rendered report comes back as an HTML document, not JSON.
async function requestHtml(method: "GET" | "POST", path: string, body?: unknown): Promise<string> {
  const headers: Record<string, string> = { Accept: "text/html", ...authHeaders(method) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, credentials: "include", body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "network", "Couldn't reach Starsign.");
  }
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 && !getApiKey()) unauthorizedListener?.();
    throw toApiError(res.status, res.statusText, text);
  }
  return text;
}
// ---- end analytics & client reports

export const api = {
  me: () => pick(() => get<Me>("/v1/me"), (f) => f.fixtureApi.me()),
  policy: () => pick(() => get<Policy>("/v1/policy"), (f) => f.fixtureApi.policy()),
  /** Replaces the whole policy with a new version (owners, people only). Send the full document. */
  updatePolicy: (policy: Policy) => pick(() => put<Policy>("/v1/policy", policy), (f) => f.fixtureApi.updatePolicy(policy)),
  /** Every version, newest first. */
  policyHistory: () => pick(() => get<PolicyVersion[]>("/v1/policy/history"), (f) => f.fixtureApi.policyHistory()),
  workspace: () => pick(() => get<Workspace>("/v1/workspace"), (f) => f.fixtureApi.workspace()),
  /** Replaces the profile (owner/approver/editor): merge with the current one first so unknown keys survive. */
  updateProfile: (profile: Record<string, unknown>) =>
    pick(() => patch<Workspace>("/v1/workspace/profile", { profile }), (f) => f.fixtureApi.updateProfile(profile)),
  accounts: () => pick(() => get<Account[]>("/v1/accounts"), (f) => f.fixtureApi.accounts()),
  streams: () => pick(() => get<Stream[]>("/v1/streams"), (f) => f.fixtureApi.streams()),

  queue: () => pick(() => get<PostSummary[]>("/v1/posts/queue"), (f) => f.fixtureApi.queue()),
  post: (id: string) => pick(() => get<PostFull>(`/v1/posts/${enc(id)}`), (f) => f.fixtureApi.post(id)),
  /** Saved drafts, newest first: they wait nowhere else in the room. */
  drafts: (limit = 20) => pick(() => get<PostSummary[]>(`/v1/posts${qs({ status: "draft", limit })}`), () => Promise.resolve([] as PostSummary[])),
  schedulePost: (id: string, at: string) => pick(() => post<PostDetail>(`/v1/posts/${enc(id)}/schedule`, { at }), (f) => f.fixtureApi.post(id)),
  publishNow: (id: string) => pick(() => post<PostDetail>(`/v1/posts/${enc(id)}/publish-now`), (f) => f.fixtureApi.post(id)),
  /** Re-queues the failed variants of a failed or partly published post to go out now. 409 when nothing failed. */
  retryPost: (id: string) => pick(() => post<PostDetail>(`/v1/posts/${enc(id)}/retry`), (f) => f.fixtureApi.retryPost(id)),
  cancelPost: (id: string) => pick(() => post<PostDetail>(`/v1/posts/${enc(id)}/cancel`), (f) => f.fixtureApi.post(id)),
  decide: (id: string, input: DecideInput) =>
    pick(
      () => post<PostDetail>(`/v1/posts/${enc(id)}/decide`, input),
      (f) => f.fixtureApi.decide(id, input),
    ),

  radar: () => pick(() => get<RadarEntry[]>("/v1/trends/radar"), (f) => f.fixtureApi.radar()),
  topic: (id: string) => pick(() => get<TopicDetail>(`/v1/trends/topics/${enc(id)}`), (f) => f.fixtureApi.topic(id)),

  feed: (q: FeedQuery = {}) =>
    pick(
      () =>
        get<Activity[]>(
          `/v1/feed${qs({
            stream: q.stream,
            networks: q.networks,
            kinds: q.kinds,
            account: q.account,
            since: q.since,
            before: q.before,
            limit: q.limit,
            q: q.q,
            languages: q.languages,
            conversation: q.conversation,
            entity: q.entity,
            children: q.entity && q.children ? 1 : undefined,
          })}`,
        ),
      (f) => f.fixtureApi.feed(q),
    ),

  summary: (from: string, to: string) =>
    pick(() => get<Summary>(`/v1/metrics/summary${qs({ from, to })}`), (f) => f.fixtureApi.summary(from, to)),
  liftByStage: (from: string, to: string) =>
    pick(() => get<LiftByStage[]>(`/v1/metrics/lift-by-stage${qs({ from, to })}`), (f) => f.fixtureApi.liftByStage(from, to)),

  alerts: () => pick(() => get<Alert[]>("/v1/alerts?unacknowledged=1&limit=50"), (f) => f.fixtureApi.alerts()),
  ackAlert: (id: string) => pick(() => post<void>(`/v1/alerts/${enc(id)}/ack`), (f) => f.fixtureApi.ackAlert(id)),
  latestBrief: () => pick(() => get<Brief | null>("/v1/briefs/latest"), (f) => f.fixtureApi.latestBrief()),

  // --- Compose, calendar, connect (v1.1) ---
  connectors: () => pick(() => get<Connector[]>("/v1/connectors"), (f) => f.fixtureApi.connectors()),
  deleteAccount: (id: string) => pick(() => del<void>(`/v1/accounts/${enc(id)}`), (f) => f.fixtureApi.deleteAccount(id)),

  adapt: (input: AdaptInput) => pick(() => post<AdaptResult>("/v1/compose/adapt", input), (f) => f.fixtureApi.adapt(input)),
  policyCheck: (input: PolicyCheckInput) => pick(() => post<PolicyDecision>("/v1/policy/check", input), (f) => f.fixtureApi.policyCheck(input)),
  createPost: (input: CreatePostInput) => pick(() => post<PostDetail>("/v1/posts", input), (f) => f.fixtureApi.createPost(input)),

  calendar: (from: string, to: string) => pick(() => get<PostSummary[]>(`/v1/calendar${qs({ from, to })}`), (f) => f.fixtureApi.calendar(from, to)),
  sources: () => pick(() => get<TrendSource[]>("/v1/sources"), (f) => f.fixtureApi.sources()),
  discoveries: (limit = 50) => pick(() => get<Discovery[]>(`/v1/trends/discoveries${qs({ limit })}`), (f) => f.fixtureApi.discoveries(limit)),

  // --- People, sign-in, teams (v1.2) ---
  session: () => pick(() => get<Session>("/v1/auth/session"), (f) => f.fixtureApi.session()),
  login: (email: string, password: string) => pick(() => post<Session>("/v1/auth/login", { email, password }), (f) => f.fixtureApi.login(email, password)),
  signup: (input: SignupInput) => pick(() => post<Session>("/v1/auth/signup", input), (f) => f.fixtureApi.signup(input)),
  logout: () => pick(() => post<void>("/v1/auth/logout"), (f) => f.fixtureApi.logout()),
  switchWorkspace: (workspaceId: string) => pick(() => post<Session>("/v1/auth/switch", { workspaceId }), (f) => f.fixtureApi.switchWorkspace(workspaceId)),
  forgot: (email: string) => pick(() => post<void>("/v1/auth/forgot", { email }), (f) => f.fixtureApi.forgot(email)),
  reset: (token: string, password: string) => pick(() => post<void>("/v1/auth/reset", { token, password }), (f) => f.fixtureApi.reset(token, password)),
  createWorkspace: (name: string, timezone?: string) => pick(() => post<Workspace>("/v1/workspaces", { name, ...(timezone ? { timezone } : {}) }), (f) => f.fixtureApi.createWorkspace(name)),
  members: () => pick(() => get<Member[]>("/v1/members"), (f) => f.fixtureApi.members()),
  setMemberRole: (id: string, role: Role) => pick(() => patch<Member>(`/v1/members/${enc(id)}`, { role }), (f) => f.fixtureApi.setMemberRole(id, role)),
  removeMember: (id: string) => pick(() => del<void>(`/v1/members/${enc(id)}`), (f) => f.fixtureApi.removeMember(id)),
  invite: (email: string, role: Role) => pick(() => post<InviteCreated>("/v1/invites", { email, role }), (f) => f.fixtureApi.invite(email, role)),
  /** Owners only. */
  invites: () => pick(() => get<PendingInvite[]>("/v1/invites"), (f) => f.fixtureApi.invites()),
  /** Owners only; the link stops working at once. */
  revokeInvite: (id: string) => pick(() => del<void>(`/v1/invites/${enc(id)}`), (f) => f.fixtureApi.revokeInvite(id)),
  inviteInfo: (token: string) => pick(() => get<InviteInfo>(`/v1/invites/${enc(token)}`), (f) => f.fixtureApi.inviteInfo(token)),
  acceptInvite: (input: AcceptInviteInput) => pick(() => post<Session>("/v1/auth/accept-invite", input), (f) => f.fixtureApi.acceptInvite(input)),

  // --- Integrations (v1.2) ---
  /** OAuth connectors: the caller sends the browser to `authorizeUrl`. 503 when the server isn't set up for it. */
  connectStart: (connector: string, input: ConnectStartInput) =>
    pick(() => post<OAuthStart>(`/v1/accounts/connect/${enc(connector)}/start`, input), (f) => f.fixtureApi.connectStart(connector, input)),
  /** Typed-credential connectors (app password, bot token, webhook URL): returns every account connected. */
  connectCredentials: (connector: string, input: ConnectCredentialsInput) =>
    pick(() => post<Account[]>(`/v1/accounts/connect/${enc(connector)}/credentials`, input), (f) => f.fixtureApi.connectCredentials(connector, input)),
  accountMetrics: (id: string, metric = "followers_total") =>
    pick(() => get<AccountMetrics>(`/v1/accounts/${enc(id)}/metrics${qs({ metric })}`), (f) => f.fixtureApi.accountMetrics(id, metric)),

  media: () => pick(() => get<MediaAsset[]>("/v1/media"), (f) => f.fixtureApi.media()),
  deleteMedia: (id: string) => pick(() => del<void>(`/v1/media/${enc(id)}`), (f) => f.fixtureApi.deleteMedia(id)),
  /** Upload one file with progress. Fixture mode simulates the progress and keeps the file in this tab. */
  uploadMedia: (file: File, onProgress: (p: number) => void, alt?: string): UploadHandle => {
    if (!USE_FIXTURES) return uploadLive(file, alt, onProgress);
    let abort = () => {};
    const done = fixtures().then((f) => {
      const h = f.fixtureUpload(file, onProgress, alt);
      abort = h.abort;
      return h.done;
    });
    return { done, abort: () => abort() };
  },

  reply: (activityId: string, input: ReplyInput) =>
    pick(() => post<PostDetail>(`/v1/feed/${enc(activityId)}/reply`, input), (f) => f.fixtureApi.reply(activityId, input)),
  moderate: (activityId: string, action: ModerateAction) =>
    pick(() => post<{ ok: boolean; action: ModerateAction }>(`/v1/feed/${enc(activityId)}/moderate`, { action }), (f) => f.fixtureApi.moderate(activityId, action)),

  // --- Links and conversions (v1.3) ---
  /** Clicks, people and conversions; `from`/`to` default to the last 30 days on the server. */
  linkReport: (from?: string, to?: string) =>
    pick(() => get<LinkReport>(`/v1/links/report${qs({ from, to })}`), (f) => f.fixtureApi.linkReport(from, to)),
  links: (limit = 100) => pick(() => get<LinkList>(`/v1/links${qs({ limit })}`), (f) => f.fixtureApi.links(limit)),
  /** 403 for viewers; 503 `unavailable` when the server has no short-link base. */
  createLink: (input: CreateLinkInput) => pick(() => post<TrackedLink>("/v1/links", input), (f) => f.fixtureApi.createLink(input)),
  /** Turns a link off (owner/approver). It 404s from then on. */
  disableLink: (id: string) => pick(() => del<void>(`/v1/links/${enc(id)}`), (f) => f.fixtureApi.disableLink(id)),
  linkSettings: () => pick(() => get<LinkSettingsResponse>("/v1/links/settings"), (f) => f.fixtureApi.linkSettings()),
  /** Owner only. */
  updateLinkSettings: (input: LinkSettingsPatch) =>
    pick(() => patch<LinkSettingsResponse>("/v1/links/settings", input), (f) => f.fixtureApi.updateLinkSettings(input)),
  conversions: (limit = 100) => pick(() => get<Conversion[]>(`/v1/conversions${qs({ limit })}`), (f) => f.fixtureApi.conversions(limit)),

  // --- Languages ---
  /** The team's language settings, the languages seen in the last 30 days, and whether translation is on here. */
  languages: () => pick(() => get<LanguagesInfo>("/v1/languages"), (f) => f.fixtureApi.languages()),
  /** Owner only; others get 403. */
  updateLanguageSettings: (input: LanguageSettingsPatch) =>
    pick(() => patch<LanguageSettings>("/v1/languages/settings", input), (f) => f.fixtureApi.updateLanguageSettings(input)),
  /** Translates one feed item now and returns the updated row. 503 `unavailable` without a model or past the spend cap. */
  translate: (activityId: string) => pick(() => post<Activity>(`/v1/feed/${enc(activityId)}/translate`), (f) => f.fixtureApi.translate(activityId)),
  /** Fills the stream's `query.translations` for these languages (replacing what was there for them). 503 as above. */
  expandStream: (streamId: string, languages: string[]) =>
    pick(() => post<Stream>(`/v1/streams/${enc(streamId)}/expand`, { languages }), (f) => f.fixtureApi.expandStream(streamId, languages)),

  // --- The tracker (v1.4) ---
  /** Organisations and people the team follows; `archived` includes the ones no longer tracked. */
  entities: (archived = false) =>
    pick(() => get<Entity[]>(`/v1/entities${qs({ archived: archived ? 1 : undefined })}`), (f) => f.fixtureApi.entities(archived)),
  /** 403 for viewers; 400 with a message for a person as parent or a cycle. The server rescans the last 90 days. */
  createEntity: (input: EntityInput) => pick(() => post<Entity>("/v1/entities", input), (f) => f.fixtureApi.createEntity(input)),
  /** Changing names, aliases, handles, context or exclude words rebuilds its mentions. */
  updateEntity: (id: string, input: EntityPatch) => pick(() => patch<Entity>(`/v1/entities/${enc(id)}`, input), (f) => f.fixtureApi.updateEntity(id, input)),
  /** Archives: it leaves lists and reports; its history stays. */
  archiveEntity: (id: string) => pick(() => del<void>(`/v1/entities/${enc(id)}`), (f) => f.fixtureApi.archiveEntity(id)),
  /** Defaults to the last 7 days on the server. */
  entityReport: (from?: string, to?: string) =>
    pick(() => get<EntityReport>(`/v1/entities/report${qs({ from, to })}`), (f) => f.fixtureApi.entityReport(from, to)),
  entityMentions: (id: string, opts: { children?: boolean; limit?: number } = {}) =>
    pick(
      () => get<EntityMention[]>(`/v1/entities/${enc(id)}/mentions${qs({ children: opts.children ? 1 : undefined, limit: opts.limit })}`),
      (f) => f.fixtureApi.entityMentions(id, opts),
    ),
  /** AI suggestions only; add the chosen ones with updateEntity. 503 `unavailable` without a model or past the spend cap. */
  suggestAliases: (id: string, languages?: string[]) =>
    pick(
      () => post<AliasSuggestions>(`/v1/entities/${enc(id)}/suggest-aliases`, languages?.length ? { languages } : {}),
      (f) => f.fixtureApi.suggestAliases(id, languages),
    ),

  // ---- inbox workflow: the shared inbox (fixtures in dev/inboxFixtures.ts) ----
  inbox: (q: InboxQuery = {}) =>
    pick(
      () =>
        get<InboxList>(
          `/v1/inbox${qs({ status: q.status, assignee: q.assignee, tag: q.tag, priority: q.priority, network: q.network, q: q.q, sort: q.sort, snoozed: q.snoozed ? 1 : undefined, limit: q.limit })}`,
        ),
      (f) => f.inboxFixtureApi.list(q),
    ),
  conversation: (activityId: string) => pick(() => get<InboxConversation>(`/v1/inbox/${enc(activityId)}`), (f) => f.inboxFixtureApi.conversation(activityId)),
  /** Viewers get 403; agents may only change status and labels. */
  patchInbox: (activityId: string, p: InboxPatch) => pick(() => patch<InboxEntry>(`/v1/inbox/${enc(activityId)}`, p), (f) => f.inboxFixtureApi.patch(activityId, p)),
  bulkInbox: (ids: string[], p: InboxPatch) => pick(() => patch<{ updated: number; items: InboxEntry[] }>("/v1/inbox", { ids, patch: p }), (f) => f.inboxFixtureApi.bulk(ids, p)),
  addInboxNote: (activityId: string, text: string, mentions?: string[]) =>
    pick(() => post<InboxNote>(`/v1/inbox/${enc(activityId)}/notes`, { text, ...(mentions?.length ? { mentions } : {}) }), (f) => f.inboxFixtureApi.addNote(activityId, text, mentions)),
  updateInboxNote: (noteId: string, text: string) => pick(() => patch<InboxNote>(`/v1/inbox/notes/${enc(noteId)}`, { text }), (f) => f.inboxFixtureApi.updateNote(noteId, text)),
  deleteInboxNote: (noteId: string) => pick(() => del<void>(`/v1/inbox/notes/${enc(noteId)}`), (f) => f.inboxFixtureApi.deleteNote(noteId)),
  savedReplies: () => pick(() => get<SavedReply[]>("/v1/saved-replies"), (f) => f.inboxFixtureApi.savedReplies()),
  createSavedReply: (input: SavedReplyInput) => pick(() => post<SavedReply>("/v1/saved-replies", input), (f) => f.inboxFixtureApi.createSavedReply(input)),
  updateSavedReply: (id: string, input: Partial<SavedReplyInput>) => pick(() => patch<SavedReply>(`/v1/saved-replies/${enc(id)}`, input), (f) => f.inboxFixtureApi.updateSavedReply(id, input)),
  deleteSavedReply: (id: string) => pick(() => del<void>(`/v1/saved-replies/${enc(id)}`), (f) => f.inboxFixtureApi.deleteSavedReply(id)),
  /** The saved reply with this conversation's variables filled in. Nothing is sent. */
  fillSavedReply: (id: string, activityId: string) =>
    pick(() => post<{ text: string; lang: string | null }>(`/v1/saved-replies/${enc(id)}/fill`, { activityId }), (f) => f.inboxFixtureApi.fillSavedReply(id, activityId)),
  inboxRules: () => pick(() => get<InboxRule[]>("/v1/inbox/rules"), (f) => f.inboxFixtureApi.rules()),
  createInboxRule: (input: InboxRuleInput) => pick(() => post<InboxRule>("/v1/inbox/rules", input), (f) => f.inboxFixtureApi.createRule(input)),
  updateInboxRule: (id: string, input: Partial<InboxRuleInput>) => pick(() => patch<InboxRule>(`/v1/inbox/rules/${enc(id)}`, input), (f) => f.inboxFixtureApi.updateRule(id, input)),
  deleteInboxRule: (id: string) => pick(() => del<void>(`/v1/inbox/rules/${enc(id)}`), (f) => f.inboxFixtureApi.deleteRule(id)),
  reorderInboxRules: (ids: string[]) => pick(() => post<InboxRule[]>("/v1/inbox/rules/reorder", { ids }), (f) => f.inboxFixtureApi.reorderRules(ids)),
  inboxSettings: () => pick(() => get<InboxSettings>("/v1/inbox/settings"), (f) => f.inboxFixtureApi.settings()),
  /** Owners and approvers. */
  updateInboxSettings: (input: InboxSettingsPatch) => pick(() => patch<InboxSettings>("/v1/inbox/settings", input), (f) => f.inboxFixtureApi.updateSettings(input)),
  /** Same as `reply` (POST /v1/feed/:id/reply, through the gate); in fixtures the inbox also hears about it. */
  replyInInbox: (activityId: string, input: ReplyInput) =>
    pick(
      () => post<PostDetail>(`/v1/feed/${enc(activityId)}/reply`, input),
      (f) =>
        f.fixtureApi.reply(activityId, input).then((d) => {
          f.inboxFixtureApi.recordReply(activityId, d);
          return d;
        }),
    ),
  // ---- end inbox workflow
  // ---- analytics & client reports (fixtures in dev/fixtures-analytics.ts) ----
  /** One payload for the Analytics view; anyone in the workspace. */
  analytics: (q: AnalyticsQuery) =>
    pick(() => get<AnalyticsPayload>(`/v1/analytics${qs({ from: q.from, to: q.to, networks: q.networks, accounts: q.accounts })}`), (f) => f.analyticsFixtureApi.analytics(q)),
  reports: () => pick(() => get<Report[]>("/v1/reports"), (f) => f.analyticsFixtureApi.reports()),
  /** Owners, approvers and editors. */
  createReport: (input: ReportInput) => pick(() => post<Report>("/v1/reports", input), (f) => f.analyticsFixtureApi.createReport(input)),
  /** Agents may change anything but the recipients; viewers nothing. */
  updateReport: (id: string, input: Partial<ReportInput>) => pick(() => patch<Report>(`/v1/reports/${enc(id)}`, input), (f) => f.analyticsFixtureApi.updateReport(id, input)),
  deleteReport: (id: string) => pick(() => del<void>(`/v1/reports/${enc(id)}`), (f) => f.analyticsFixtureApi.deleteReport(id)),
  /** The saved report as a self-contained HTML document. */
  renderReport: (id: string) => pick(() => requestHtml("GET", `/v1/reports/${enc(id)}/render?format=html`), (f) => f.analyticsFixtureApi.renderReport(id)),
  /** An unsaved definition, rendered for the editor's live preview. */
  previewReport: (input: ReportInput) => pick(() => requestHtml("POST", "/v1/reports/preview", input), (f) => f.analyticsFixtureApi.previewReport(input)),
  /** 503 when the server has no mail set up; 400 without recipients. */
  sendReport: (id: string) => pick(() => post<ReportSent>(`/v1/reports/${enc(id)}/send`), (f) => f.analyticsFixtureApi.sendReport(id)),
  /** A new read-only link; the URL is only ever shown now. */
  shareReport: (id: string) => pick(() => post<ReportShare>(`/v1/reports/${enc(id)}/share`), (f) => f.analyticsFixtureApi.shareReport(id)),
  /** Turns off every link to the report, the emailed ones too. */
  revokeReportShares: (id: string) => pick(() => del<void>(`/v1/reports/${enc(id)}/share`), (f) => f.analyticsFixtureApi.revokeReportShares(id)),
  // ---- end analytics & client reports
};

// ---- AI answer visibility (types in lib/visibility.ts, fixtures in dev/visibility-fixtures.ts)
export const visibilityApi = {
  engines: () => pick(() => get<VisEngine[]>("/v1/visibility/engines"), (f) => f.visibilityFixtureApi.engines()),
  settings: () => pick(() => get<VisSettingsResponse>("/v1/visibility/settings"), (f) => f.visibilityFixtureApi.settings()),
  /** Engines, cadences and the question limit: owners. Own domains: editors and up. */
  updateSettings: (p: VisSettingsPatch) => pick(() => patch<VisSettingsResponse>("/v1/visibility/settings", p), (f) => f.visibilityFixtureApi.updateSettings(p)),
  prompts: (archived = false) => pick(() => get<VisPrompt[]>(`/v1/visibility/prompts${qs({ archived: archived ? 1 : undefined })}`), (f) => f.visibilityFixtureApi.prompts(archived)),
  createPrompt: (input: VisPromptInput) => pick(() => post<VisPrompt>("/v1/visibility/prompts", input), (f) => f.visibilityFixtureApi.createPrompt(input)),
  updatePrompt: (id: string, input: Partial<VisPromptInput>) => pick(() => patch<VisPrompt>(`/v1/visibility/prompts/${enc(id)}`, input), (f) => f.visibilityFixtureApi.updatePrompt(id, input)),
  archivePrompt: (id: string) => pick(() => del<void>(`/v1/visibility/prompts/${enc(id)}`), (f) => f.visibilityFixtureApi.archivePrompt(id)),
  /** Asks every enabled engine now. 503 without an engine; answers past the spend cap come back as capped. */
  runPrompt: (id: string) => pick(() => post<VisRunResult>(`/v1/visibility/prompts/${enc(id)}/run`), (f) => f.visibilityFixtureApi.runPrompt(id)),
  /** Suggestions only; add the chosen ones with createPrompt. 503 without a model or past the spend cap. */
  suggest: (languages?: string[], count?: number) =>
    pick(() => post<{ languages: string[]; questions: VisSuggestion[] }>("/v1/visibility/suggest", { ...(languages?.length ? { languages } : {}), ...(count ? { count } : {}) }), (f) => f.visibilityFixtureApi.suggest(languages, count)),
  report: (from?: string, to?: string) => pick(() => get<VisReport>(`/v1/visibility/report${qs({ from, to })}`), (f) => f.visibilityFixtureApi.report(from, to)),
  answers: (q: VisAnswersQuery = {}) =>
    pick(
      () => get<VisAnswer[]>(`/v1/visibility/answers${qs({ promptId: q.promptId, engine: q.engine, entity: q.entity, mentioned: q.mentioned === false ? 0 : undefined, lang: q.lang, limit: q.limit })}`),
      (f) => f.visibilityFixtureApi.answers(q),
    ),
};
// ---- end AI answer visibility

export interface StreamHandlers {
  onEvent: (e: FeedEvent) => void;
  onStatus: (s: LiveStatus) => void;
}

const SSE_EVENTS = ["activity", "post", "alert", "forecast", "inbox"] as const; // "inbox": inbox workflow

/**
 * Opens the live stream (GET /v1/feed/stream, SSE). EventSource cannot send headers, so a single-use
 * stream token goes in the URL instead (never the key). Returns a function that closes it.
 */
export function openFeedStream(h: StreamHandlers): () => void {
  if (USE_FIXTURES) {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void fixtures().then((f) => {
      if (cancelled) return;
      stop = f.openFixtureStream(h);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }

  let es: EventSource | null = null;
  let closed = false;
  let retry: number | null = null;
  let backoff = 1_000;

  const connect = async () => {
    if (closed) return;
    h.onStatus("connecting");
    // The API key never travels in a URL: mint a 60-second single-use stream token first.
    let token: string | null = null;
    try {
      const res = await fetch(`${BASE}/v1/feed/stream-token`, { method: "POST", headers: authHeaders("POST"), credentials: "include" });
      if (res.ok) token = ((await res.json()) as { token: string }).token;
    } catch {
      token = null;
    }
    if (closed) return;
    if (!token) {
      retry = window.setTimeout(() => void connect(), backoff);
      backoff = Math.min(backoff * 2, 30_000);
      return;
    }
    const url = `${BASE}/v1/feed/stream?token=${enc(token)}`;
    const source = new EventSource(url, { withCredentials: true });
    es = source;
    source.onopen = () => {
      backoff = 1_000;
      h.onStatus("live");
    };
    for (const type of SSE_EVENTS) {
      source.addEventListener(type, (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent<string>).data) as never;
          h.onEvent({ type, data } as FeedEvent);
        } catch {
          // malformed frame: ignore, the next one will be fine
        }
      });
    }
    source.onerror = () => {
      h.onStatus("connecting");
      // EventSource reconnects on its own unless the connection was refused outright.
      if (source.readyState === EventSource.CLOSED) {
        source.close();
        if (es === source) es = null;
        if (!closed) {
          retry = window.setTimeout(() => void connect(), backoff);
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    };
  };

  void connect();
  return () => {
    closed = true;
    if (retry !== null) window.clearTimeout(retry);
    es?.close();
    es = null;
    h.onStatus("off");
  };
}
