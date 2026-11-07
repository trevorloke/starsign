import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { Account, ComposePrefill, Connector, EntityKind, LanguagesInfo, LiftByStage, Me, Policy, PostSummary, RadarEntry, Role, Session, Stream, Summary, TrendSource } from "./types";
import { api, errorText, getApiKey, isApiError, onUnauthorized, setApiKey, USE_FIXTURES } from "./api";
import { AuthGate, stripAuthParams, type AuthScreen } from "./auth/AuthGate";
import { BigNumber } from "./components/BigNumber";
import { Menu } from "./components/Menu";
import { Tabs, type TabDef } from "./components/Tabs";
import { ToastProvider, useToast } from "./components/Toast";
import { ComposeDrawer } from "./drawers/ComposeDrawer";
import { ConnectionsDrawer } from "./drawers/ConnectionsDrawer";
import { PostDrawer } from "./drawers/PostDrawer";
import { TeamDrawer } from "./drawers/TeamDrawer";
import { LinksDrawer } from "./drawers/LinksDrawer";
import { LanguagesDrawer } from "./drawers/LanguagesDrawer";
import { TopicDrawer } from "./drawers/TopicDrawer";
import { EntityDrawer } from "./drawers/EntityDrawer";
import { VisibilityDrawer } from "./drawers/VisibilityDrawer"; // ---- AI answer visibility
import { SettingsDrawer } from "./drawers/SettingsDrawer";
import { AUTONOMY_LABEL, lift as formatLift, listOf, networkLabel, plural, roleLabel } from "./lib/format";
import type { SettingsSectionId } from "./lib/policy";
import { RoomProvider, type RoomRefs } from "./lib/room";
import { isoDaysAgo, isoNow } from "./lib/time";
import { readTrackerPeriod, rememberTrackerPeriod, type TrackerPeriod } from "./lib/tracker";
import { browserTz, safeTz } from "./lib/tz";
import { useLive } from "./lib/useLive";
import { Brief } from "./panels/Brief";
import { Calendar } from "./panels/Calendar";
import { Feed, type FeedEntityFilter } from "./panels/Feed";
import { Queue } from "./panels/Queue";
import { Radar } from "./panels/Radar";
import { Tracker } from "./panels/Tracker";
// ---- analytics & client reports
import { Analytics } from "./panels/Analytics";
import { ReportsDrawer } from "./drawers/ReportsDrawer";

type Theme = "light" | "dark";
const THEME_STORAGE = "starsign.theme";
const TAB_STORAGE = "starsign.tab";
const CENTER_STORAGE = "starsign.center";

type CenterView = "queue" | "calendar" | "tracker" | "analytics";
const CENTER_VIEWS: CenterView[] = ["queue", "calendar", "tracker", "analytics"];
const isCenterView = (v: string | null): v is CenterView => !!v && (CENTER_VIEWS as string[]).includes(v);

// --- Theme ---------------------------------------------------------------

function readStoredTheme(): Theme | null {
  try {
    const t = localStorage.getItem(THEME_STORAGE);
    return t === "dark" || t === "light" ? t : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Follows the system until the person picks; the pick is remembered in localStorage. */
function useTheme(): { theme: Theme; toggle: () => void } {
  const [stored, setStored] = useState<Theme | null>(readStoredTheme);
  const [system, setSystem] = useState<Theme>(systemTheme);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (stored) document.documentElement.setAttribute("data-theme", stored);
    else document.documentElement.removeAttribute("data-theme");
  }, [stored]);

  const theme = stored ?? system;
  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setStored(next);
    try {
      localStorage.setItem(THEME_STORAGE, next);
    } catch {
      // fine: the choice lasts for this page load
    }
  }, [theme]);

  return { theme, toggle };
}

// --- App -----------------------------------------------------------------

type Auth =
  | { kind: "checking" }
  | { kind: "gate"; screen: AuthScreen; signupAllowed: boolean | null; message: string | null; session: Session | null }
  | { kind: "session"; session: Session }
  | { kind: "key"; key: string };

function readParam(name: string): string | null {
  try {
    const v = new URL(window.location.href).searchParams.get(name);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** The server may say on a 401 from /v1/auth/session whether it takes sign-ups (`details.signupAllowed`). */
function signupHint(e: unknown): boolean | null {
  if (!isApiError(e) || !e.details || typeof e.details !== "object") return null;
  const v = (e.details as { signupAllowed?: unknown }).signupAllowed;
  return typeof v === "boolean" ? v : null;
}

function firstRunHint(e: unknown): boolean {
  if (!isApiError(e) || !e.details || typeof e.details !== "object") return false;
  return (e.details as { firstRun?: unknown }).firstRun === true;
}

export function App() {
  const { theme, toggle } = useTheme();
  const [inviteToken] = useState(() => readParam("invite"));
  const [resetToken] = useState(() => readParam("reset"));
  const [auth, setAuth] = useState<Auth>(() => {
    const key = getApiKey();
    if (key && !inviteToken && !resetToken) return { kind: "key", key };
    return { kind: "checking" };
  });

  // People sign in; the session cookie decides who they are. Ask once on load.
  useEffect(() => {
    if (auth.kind !== "checking") return;
    let cancelled = false;
    api
      .session()
      .then((session) => {
        if (cancelled) return;
        if (inviteToken) setAuth({ kind: "gate", screen: "invite", signupAllowed: null, message: null, session });
        else {
          if (resetToken) stripAuthParams();
          setAuth({ kind: "session", session });
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Nobody can sign in yet on this deployment: start on creating the first account.
        const screen: AuthScreen = inviteToken ? "invite" : resetToken ? "reset" : firstRunHint(e) ? "signup" : "signin";
        const message = isApiError(e) && e.status !== 401 ? errorText(e) : null;
        setAuth({ kind: "gate", screen, signupAllowed: signupHint(e), message, session: null });
      });
    return () => {
      cancelled = true;
    };
  }, [auth.kind, inviteToken, resetToken]);

  const signedOut = useCallback((message?: string) => {
    setApiKey(null);
    setAuth({ kind: "gate", screen: "signin", signupAllowed: null, message: message ?? null, session: null });
  }, []);

  // Any request that finds the session gone sends the person back to Sign in.
  const sessionActive = auth.kind === "session";
  useEffect(() => {
    if (!sessionActive) return;
    onUnauthorized(() => signedOut("You're signed out. Sign in again."));
    return () => onUnauthorized(null);
  }, [sessionActive, signedOut]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // the cookie may already be gone; the gate is the right place either way
    }
    signedOut();
  }, [signedOut]);

  const onSession = useCallback((session: Session) => {
    setApiKey(null);
    setAuth({ kind: "session", session });
  }, []);

  if (auth.kind === "checking") {
    return (
      <main className="gate">
        <span className="muted">Opening Starsign…</span>
      </main>
    );
  }

  if (auth.kind === "gate") {
    return (
      <AuthGate
        initial={auth.screen}
        inviteToken={inviteToken}
        resetToken={resetToken}
        session={auth.session}
        signupAllowed={auth.signupAllowed}
        message={auth.message}
        theme={theme}
        onToggleTheme={toggle}
        onSession={onSession}
        onApiKey={(key) => setAuth({ kind: "key", key })}
      />
    );
  }

  const roomKey = auth.kind === "key" ? `key:${auth.key}` : `ws:${auth.session.currentWorkspaceId}`;
  return (
    <ToastProvider>
      <Room
        key={roomKey}
        theme={theme}
        onToggleTheme={toggle}
        session={auth.kind === "session" ? auth.session : null}
        onSession={onSession}
        onSignOut={() => void signOut()}
        onSignedOut={signedOut}
      />
    </ToastProvider>
  );
}

// --- Coming back from a connect flow ---------------------------------------

function connectErrorText(reason: string, net: string): string {
  switch (reason) {
    case "expired":
      return "the sign-in took too long. Try again.";
    case "exchange_failed":
      return `${net} didn't hand over access. Try again.`;
    case "access_denied":
    case "missing_code":
      return `access wasn't granted on ${net}.`;
    case "state_mismatch":
    case "invalid_state":
    case "unknown_state":
      return "that sign-in link was already used. Start again from Connections.";
    case "no_accounts":
      return `this ${net} login doesn't manage any accounts Starsign can post as.`;
    default:
      return "something went wrong on the way back. Try again.";
  }
}

/**
 * Every OAuth connector ends with the server redirecting to "/?connected=<connector>&handle=a,b&count=n" or
 * "/?connect_error=<reason>&connector=<connector>". Say how it went once, in the network's name, then take
 * the params out of the address bar.
 */
function useConnectReturn(onConnected: () => void) {
  const toast = useToast();
  useEffect(() => {
    const url = new URL(window.location.href);
    const connected = url.searchParams.get("connected");
    const failed = url.searchParams.get("connect_error");
    if (!connected && !failed) return;
    const connectorName = connected ?? url.searchParams.get("connector") ?? "";
    const handles = (url.searchParams.get("handle") ?? "")
      .split(",")
      .map((h) => h.trim().replace(/^@/, ""))
      .filter(Boolean);
    const countParam = Number(url.searchParams.get("count"));
    const count = Number.isFinite(countParam) && url.searchParams.has("count") ? countParam : handles.length;
    for (const k of ["connected", "handle", "count", "connect_error", "connector"]) url.searchParams.delete(k);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);

    void api
      .connectors()
      .catch(() => [] as Connector[])
      .then((list) => {
        const c = list.find((k) => k.name === connectorName);
        const net = c ? listOf(c.networks.map(networkLabel)) : connectorName ? networkLabel(connectorName).replace(/_/g, " ") : "the network";
        if (connected) {
          if (count === 1 && handles[0]) toast(`Connected @${handles[0]} on ${net}`);
          else if (count > 0) toast(`Connected ${plural(count, "account")} on ${net}`);
          else toast(`${net} didn't have any new accounts to connect`, "bad");
          onConnected();
        } else if (failed) {
          toast(`${net} connection didn't finish: ${connectErrorText(failed, net)}`, "bad");
        }
      });
  }, [toast, onConnected]);
}

// --- The room ------------------------------------------------------------

type DrawerState =
  | { kind: "post"; id: string }
  | { kind: "topic"; id: string }
  | { kind: "compose"; prefill?: ComposePrefill }
  | { kind: "accounts" }
  | { kind: "team" }
  | { kind: "links" }
  | { kind: "languages" }
  | { kind: "settings"; section?: SettingsSectionId }
  /** id null: track a new name. */
  | { kind: "entity"; id: string | null; edit?: boolean; preset?: { parentId?: string; kind?: EntityKind } }
  // ---- AI answer visibility: entityId opens it on that name
  | { kind: "visibility"; entityId?: string | null }
  // ---- analytics & client reports
  | { kind: "reports" }
  | null;

function readCenter(): CenterView {
  try {
    const v = localStorage.getItem(CENTER_STORAGE);
    return isCenterView(v) ? v : "queue";
  } catch {
    return "queue";
  }
}

/** The center column's switch: "Queue · Calendar · Tracker" on desktop; the phone uses the bottom tabs instead. */
function CenterSwitch({ view, onChange, waiting, title }: { view: CenterView; onChange: (v: CenterView) => void; waiting: number | null; title: string }) {
  return (
    <>
      <h2 className="center-title">{title}</h2>
      <div className="seg center-seg" role="tablist" aria-label="Center column">
        <button type="button" role="tab" aria-selected={view === "queue"} className="seg-btn" onClick={() => onChange("queue")}>
          Queue
          {waiting ? <span className="tab-badge mono">{waiting}</span> : null}
        </button>
        <button type="button" role="tab" aria-selected={view === "calendar"} className="seg-btn" onClick={() => onChange("calendar")}>
          Calendar
        </button>
        <button type="button" role="tab" aria-selected={view === "tracker"} className="seg-btn" onClick={() => onChange("tracker")}>
          Tracker
        </button>
        <button type="button" role="tab" aria-selected={view === "analytics"} className="seg-btn" onClick={() => onChange("analytics")}>
          Analytics
        </button>
      </div>
    </>
  );
}

function Room({
  theme,
  onToggleTheme,
  session,
  onSession,
  onSignOut,
  onSignedOut,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  /** null in API-key mode. */
  session: Session | null;
  onSession: (s: Session) => void;
  onSignOut: () => void;
  onSignedOut: (message?: string) => void;
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [offline, setOffline] = useState<string | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [languages, setLanguages] = useState<LanguagesInfo | null>(null);
  const [people, setPeople] = useState<ReadonlyMap<string, string>>(() => new Map());

  const [radar, setRadar] = useState<RadarEntry[] | null>(null);
  const [radarLoading, setRadarLoading] = useState(true);
  const [radarError, setRadarError] = useState<string | null>(null);

  const [queue, setQueue] = useState<PostSummary[] | null>(null);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<PostSummary[]>([]);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [liftRows, setLiftRows] = useState<LiftByStage[] | null>(null);
  const [sources, setSources] = useState<TrendSource[] | null>(null);
  const [calendarTick, setCalendarTick] = useState(0);
  const [center, setCenter] = useState<CenterView>(readCenter);
  const [trackerPeriod, setTrackerPeriod] = useState<TrackerPeriod>(readTrackerPeriod);
  const [trackerTick, setTrackerTick] = useState(0);
  const [feedEntity, setFeedEntity] = useState<FeedEntityFilter | null>(null);

  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [tab, setTab] = useState<string>(() => {
    try {
      return localStorage.getItem(TAB_STORAGE) ?? "queue";
    } catch {
      return "queue";
    }
  });

  const live = useLive(true);

  // Identity doubles as the auth check: a lapsed session or a dead key sends the person back to the gate.
  const keyMode = session === null;
  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((m) => {
        if (cancelled) return;
        setMe(m);
        setOffline(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (isApiError(e) && (e.status === 401 || (keyMode && e.status === 403))) onSignedOut(errorText(e));
        else setOffline(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [onSignedOut, keyMode]);

  const loadRefs = useCallback(async () => {
    const [p, a, s, src, c, l, mem] = await Promise.allSettled([api.policy(), api.accounts(), api.streams(), api.sources(), api.connectors(), api.languages(), api.members()]);
    if (mem.status === "fulfilled") setPeople(new Map(mem.value.map((x) => [x.userId, x.name || x.email])));
    if (p.status === "fulfilled") setPolicy(p.value);
    if (l.status === "fulfilled") setLanguages(l.value);
    if (a.status === "fulfilled") setAccounts(a.value);
    if (s.status === "fulfilled") setStreams(s.value);
    if (src.status === "fulfilled") setSources(src.value);
    if (c.status === "fulfilled") setConnectors(c.value);
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await api.accounts());
    } catch {
      // the drawer that changed them shows its own error
    }
  }, []);

  const afterConnectReturn = useCallback(() => {
    void loadAccounts();
    setDrawer({ kind: "accounts" });
  }, [loadAccounts]);
  useConnectReturn(afterConnectReturn);

  const loadRadar = useCallback(async () => {
    setRadarLoading(true);
    try {
      setRadar(await api.radar());
      setRadarError(null);
    } catch (e) {
      setRadarError(errorText(e));
    } finally {
      setRadarLoading(false);
    }
  }, []);

  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    try {
      setQueue(await api.queue());
      setQueueError(null);
    } catch (e) {
      setQueueError(errorText(e));
    } finally {
      setQueueLoading(false);
    }
    // Saved drafts sit under the queue: nowhere else in the room lists them.
    api.drafts().then(setDrafts, () => undefined);
  }, []);

  const loadMetrics = useCallback(async () => {
    const from = isoDaysAgo(7);
    const to = isoNow();
    const [s, l] = await Promise.allSettled([api.summary(from, to), api.liftByStage(from, to)]);
    if (s.status === "fulfilled") setSummary(s.value);
    if (l.status === "fulfilled") setLiftRows(l.value);
  }, []);

  useEffect(() => {
    void loadRefs();
    void loadRadar();
    void loadQueue();
    void loadMetrics();
  }, [loadRefs, loadRadar, loadQueue, loadMetrics]);

  // Live: a post changed → queue and the numbers; a forecast landed → radar (debounced, they come in bursts).
  const postTick = live.counters.post;
  const forecastTick = live.counters.forecast;
  useEffect(() => {
    if (postTick === 0) return;
    void loadQueue();
    void loadMetrics();
    setCalendarTick((t) => t + 1);
  }, [postTick, loadQueue, loadMetrics]);
  useEffect(() => {
    if (forecastTick === 0) return;
    const t = window.setTimeout(() => void loadRadar(), 1200);
    return () => window.clearTimeout(t);
  }, [forecastTick, loadRadar]);

  const onDecided = useCallback((id: string) => {
    setQueue((q) => q?.filter((item) => item.post.id !== id) ?? null);
  }, []);

  const timezone = safeTz(policy?.timezone);
  const refs = useMemo<RoomRefs>(
    () => ({
      accountsById: new Map(accounts.map((a) => [a.id, a])),
      connectors,
      streamsById: new Map(streams.map((s) => [s.id, s])),
      topicsById: new Map((radar ?? []).map((r) => [r.topic.id, r.topic])),
      timezone,
      openPost: (id) => setDrawer({ kind: "post", id }),
      openTopic: (id) => setDrawer({ kind: "topic", id }),
      openCompose: (prefill) => setDrawer({ kind: "compose", prefill }),
      openAccounts: () => setDrawer({ kind: "accounts" }),
      openSettings: (section) => setDrawer({ kind: "settings", section }),
      people,
    }),
    [accounts, connectors, streams, radar, timezone, people],
  );

  const closeDrawer = useCallback(() => setDrawer(null), []);
  const onStream = useCallback((next: Stream) => setStreams((list) => list.map((s) => (s.id === next.id ? next : s))), []);
  const onPostCreated = useCallback(() => {
    void loadQueue();
    setCalendarTick((t) => t + 1);
  }, [loadQueue]);

  const remember = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // fine
    }
  };

  const changeCenter = (v: CenterView) => {
    setCenter(v);
    remember(CENTER_STORAGE, v);
    if (isCenterView(tab)) {
      setTab(v);
      remember(TAB_STORAGE, v);
    }
  };

  const changeTab = (id: string) => {
    setTab(id);
    remember(TAB_STORAGE, id);
    if (isCenterView(id)) {
      setCenter(id);
      remember(CENTER_STORAGE, id);
    }
  };

  const currentWorkspace = session?.workspaces.find((w) => w.id === session.currentWorkspaceId) ?? null;
  const myRole = currentWorkspace?.role ?? me?.role ?? null;
  const canDelete = myRole === "owner" || myRole === "approver";
  // Before the role is known (API-key mode, still loading) offer the controls; the server has the last word.
  const canEditTracker = myRole !== "viewer";

  const changeTrackerPeriod = (p: TrackerPeriod) => {
    setTrackerPeriod(p);
    rememberTrackerPeriod(p);
  };
  const showInFeed = (f: FeedEntityFilter) => {
    setFeedEntity(f);
    setDrawer(null);
    // On a phone the feed is its own tab; on a desktop it sits under the center view.
    if (window.matchMedia?.("(max-width: 1199px)").matches) {
      setTab("feed");
      remember(TAB_STORAGE, "feed");
    }
  };
  const waiting = queue?.length ?? null;
  const wentOut = summary ? summary.publishedByNetwork.reduce((n, g) => n + g.posts, 0) : null;
  const risingRow = liftRows?.find((r) => r.stage === "rising") ?? null;
  const risingLift = risingRow && risingRow.posts > 0 ? formatLift(risingRow.lift) : null;
  const newPostAutonomy = policy?.autonomy.new_post ?? null;

  const retryAll = () => {
    setOffline(null);
    void api
      .me()
      .then((m) => setMe(m))
      .catch((e: unknown) => setOffline(errorText(e)));
    void loadRefs();
    void loadRadar();
    void loadQueue();
    void loadMetrics();
  };

  const tabs: TabDef[] = [
    { id: "radar", label: "Radar" },
    { id: "queue", label: "Queue", badge: waiting ?? undefined },
    { id: "calendar", label: "Calendar" },
    { id: "tracker", label: "Tracker" },
    { id: "analytics", label: "Analytics" },
    { id: "feed", label: "Feed" },
    { id: "brief", label: "Brief" },
  ];

  return (
    <RoomProvider value={refs}>
      <div className="app">
        <header className="topbar">
          <div className="topbar-left">
            <div className="topbar-id">
              <span className="brand">Starsign</span>
              {session ? (
                <WorkspaceSwitcher session={session} onSession={onSession} />
              ) : (
                <span className="ws-name">{me?.workspace.name ?? (offline ? "Offline" : "")}</span>
              )}
            </div>
            {newPostAutonomy || USE_FIXTURES ? (
              <div className="topbar-chips">
                {newPostAutonomy ? (
                  <button
                    type="button"
                    className="chip chip-static chip-link"
                    title="What agents may do with new posts. Change it in Settings."
                    onClick={() => setDrawer({ kind: "settings", section: "autonomy" })}
                  >
                    New posts: {AUTONOMY_LABEL[newPostAutonomy].toLowerCase()}
                  </button>
                ) : null}
                {USE_FIXTURES ? <span className="chip chip-static chip-sample">Sample data</span> : null}
              </div>
            ) : null}
          </div>
          <div className="topbar-nums">
            <BigNumber value={waiting ?? "—"} label="waiting on you" muted={waiting === 0} />
            <BigNumber value={wentOut ?? "—"} label="went out this week" />
            <BigNumber
              value={risingLift ?? "—"}
              label={risingLift ? "lift on rising topics" : "no rising posts yet"}
              muted={!risingLift}
              title="Engagement on posts that rode a rising topic, against the baseline"
            />
          </div>
          <div className="topbar-right">
            <button type="button" className="btn btn-primary topbar-new" onClick={() => setDrawer({ kind: "compose" })}>
              New post
            </button>
            <button type="button" className={`btn btn-ghost${session ? " topbar-connections" : ""}`} onClick={() => setDrawer({ kind: "accounts" })}>
              Connections
            </button>
            <button
              type="button"
              className="btn btn-ghost topbar-theme"
              onClick={onToggleTheme}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              {theme === "dark" ? "Light" : "Dark"}
            </button>
            {session ? (
              <Menu
                align="right"
                className="user-menu"
                buttonClassName="btn btn-ghost user-btn"
                ariaLabel={`Account menu for ${session.user.name || session.user.email}`}
                label={
                  <>
                    <span className="avatar" aria-hidden="true">
                      {initials(session.user.name || session.user.email)}
                    </span>
                    <span className="user-name">{(session.user.name || session.user.email).split(" ")[0]}</span>
                  </>
                }
              >
                {(close) => (
                  <>
                    <div className="menu-head">
                      <span className="strong">{session.user.name}</span>
                      <span className="muted small">{session.user.email}</span>
                    </div>
                    <div className="menu-sep" />
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item menu-phone"
                      onClick={() => {
                        close();
                        setDrawer({ kind: "accounts" });
                      }}
                    >
                      Connections
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        close();
                        setDrawer({ kind: "settings" });
                      }}
                    >
                      Settings
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        close();
                        setDrawer({ kind: "team" });
                      }}
                    >
                      Team
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        close();
                        setDrawer({ kind: "links" });
                      }}
                    >
                      Links
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        close();
                        setDrawer({ kind: "reports" });
                      }}
                    >
                      Reports
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        close();
                        setDrawer({ kind: "languages" });
                      }}
                    >
                      Languages
                    </button>
                    {/* ---- AI answer visibility */}
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        close();
                        setDrawer({ kind: "visibility" });
                      }}
                    >
                      AI visibility
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item menu-theme"
                      onClick={() => {
                        close();
                        onToggleTheme();
                      }}
                    >
                      {theme === "dark" ? "Light theme" : "Dark theme"}
                    </button>
                    <div className="menu-sep" />
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        close();
                        onSignOut();
                      }}
                    >
                      Sign out
                    </button>
                  </>
                )}
              </Menu>
            ) : !USE_FIXTURES ? (
              <button type="button" className="btn btn-ghost" onClick={() => onSignedOut()}>
                Disconnect
              </button>
            ) : (
              <button type="button" className="btn btn-ghost" onClick={() => onSignedOut()}>
                Sign out
              </button>
            )}
          </div>
        </header>

        {offline ? (
          <div className="banner" role="alert">
            <span>{offline} Showing what loaded.</span>
            <button type="button" className="btn btn-small" onClick={retryAll}>
              Retry
            </button>
          </div>
        ) : null}

        <main className="room" data-tab={tab}>
          <div className="col col-radar" data-panel="radar">
            <Radar entries={radar} loading={radarLoading} error={radarError} onRetry={() => void loadRadar()} sources={sources} />
          </div>
          <div className="col col-center" data-view={center}>
            <div className="col-queue" data-panel="queue">
              <Queue
                items={queue}
                loading={queueLoading}
                error={queueError}
                onRetry={() => void loadQueue()}
                onDecided={onDecided}
                drafts={drafts}
                head={<CenterSwitch view="queue" onChange={changeCenter} waiting={waiting} title="Queue" />}
              />
            </div>
            <div className="col-queue col-calendar" data-panel="calendar">
              <Calendar refreshTick={calendarTick} head={<CenterSwitch view="calendar" onChange={changeCenter} waiting={waiting} title="Calendar" />} />
            </div>
            {center === "tracker" || tab === "tracker" ? (
              <div className="col-queue col-tracker" data-panel="tracker">
                <Tracker
                  head={<CenterSwitch view="tracker" onChange={changeCenter} waiting={waiting} title="Tracker" />}
                  period={trackerPeriod}
                  onPeriod={changeTrackerPeriod}
                  refreshTick={trackerTick}
                  canEdit={canEditTracker}
                  onOpen={(id) => setDrawer({ kind: "entity", id })}
                  onTrack={() => setDrawer({ kind: "entity", id: null })}
                />
              </div>
            ) : null}
            {center === "analytics" || tab === "analytics" ? (
              <div className="col-queue col-analytics" data-panel="analytics">
                <Analytics
                  head={<CenterSwitch view="analytics" onChange={changeCenter} waiting={waiting} title="Analytics" />}
                  refreshTick={postTick}
                  onOpenReports={() => setDrawer({ kind: "reports" })}
                />
              </div>
            ) : null}
            <div className="col-feed" data-panel="feed">
              <Feed
                accounts={accounts}
                liveTick={live.counters.activity}
                inboxTick={live.counters.inbox /* inbox workflow */}
                inboxEvent={live.last?.type === "inbox" ? live.last : null}
                liveStatus={live.status}
                canDelete={canDelete}
                languages={languages}
                entity={feedEntity}
                onClearEntity={() => setFeedEntity(null)}
              />
            </div>
          </div>
          <div className="col col-brief" data-panel="brief">
            <Brief policy={policy} alertTick={live.counters.alert} />
          </div>
        </main>

        <Tabs tabs={tabs} active={tab} onChange={changeTab} />

        {drawer?.kind === "post" ? <PostDrawer id={drawer.id} myRole={myRole as Role | null} onClose={closeDrawer} onChanged={onPostCreated} /> : null}
        {drawer?.kind === "topic" ? <TopicDrawer id={drawer.id} onClose={closeDrawer} /> : null}
        {drawer?.kind === "compose" ? (
          <ComposeDrawer
            prefill={drawer.prefill}
            reviewer={me?.actor.type === "human" ? me.actor.id : undefined}
            onClose={closeDrawer}
            onCreated={onPostCreated}
            onOpenAccounts={() => setDrawer({ kind: "accounts" })}
            onOpenLinks={() => setDrawer({ kind: "links" })}
          />
        ) : null}
        {drawer?.kind === "accounts" ? <ConnectionsDrawer onClose={closeDrawer} onChanged={() => void loadAccounts()} /> : null}
        {drawer?.kind === "team" ? (
          <TeamDrawer
            workspaceName={currentWorkspace?.name ?? me?.workspace.name ?? ""}
            myRole={(currentWorkspace?.role ?? (me?.role as Role | null | undefined)) ?? null}
            myUserId={session?.user.id ?? null}
            onClose={closeDrawer}
          />
        ) : null}
        {drawer?.kind === "reports" ? <ReportsDrawer myRole={(currentWorkspace?.role ?? (me?.role as Role | null | undefined)) ?? null} onClose={closeDrawer} /> : null}
        {drawer?.kind === "links" ? <LinksDrawer myRole={(currentWorkspace?.role ?? (me?.role as Role | null | undefined)) ?? null} onClose={closeDrawer} /> : null}
        {drawer?.kind === "entity" ? (
          <EntityDrawer
            key={drawer.id ?? "new"}
            id={drawer.id}
            startEditing={drawer.edit}
            preset={drawer.preset}
            period={trackerPeriod}
            canEdit={canEditTracker}
            canDelete={canDelete}
            home={languages?.settings.home ?? "en"}
            onClose={closeDrawer}
            onOpen={(id) => setDrawer({ kind: "entity", id })}
            onChanged={() => {
              setTrackerTick((t) => t + 1);
              // Tracking a name adds its momentum topic to the radar; archiving takes it off.
              void loadRadar();
            }}
            onShowInFeed={showInFeed}
            onAiVisibility={(entityId) => setDrawer({ kind: "visibility", entityId })} // ---- AI answer visibility
          />
        ) : null}
        {/* ---- AI answer visibility */}
        {drawer?.kind === "visibility" ? (
          <VisibilityDrawer key={drawer.entityId ?? "all"} myRole={(currentWorkspace?.role ?? (me?.role as Role | null | undefined)) ?? null} focusEntityId={drawer.entityId ?? null} onClose={closeDrawer} />
        ) : null}
        {drawer?.kind === "settings" ? (
          <SettingsDrawer
            myRole={(currentWorkspace?.role ?? (me?.role as Role | null | undefined)) ?? null}
            isHuman={!me || me.actor.type === "human"}
            workspaceName={currentWorkspace?.name ?? me?.workspace.name ?? ""}
            initial={drawer.section}
            onPolicy={setPolicy}
            onClose={closeDrawer}
          />
        ) : null}
        {drawer?.kind === "languages" ? (
          <LanguagesDrawer
            myRole={(currentWorkspace?.role ?? (me?.role as Role | null | undefined)) ?? null}
            streams={streams}
            onInfo={setLanguages}
            onStream={onStream}
            onClose={closeDrawer}
          />
        ) : null}
      </div>
    </RoomProvider>
  );
}

// --- Workspaces and people ---------------------------------------------------

function initials(name: string): string {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
}

/**
 * The workspace name doubles as a switcher: every workspace this person belongs to, with their role in it,
 * and "New workspace" (how an agency adds a client).
 */
function WorkspaceSwitcher({ session, onSession }: { session: Session; onSession: (s: Session) => void }) {
  const toast = useToast();
  const current = session.workspaces.find((w) => w.id === session.currentWorkspaceId) ?? session.workspaces[0] ?? null;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function switchTo(id: string, close: () => void) {
    if (id === session.currentWorkspaceId) {
      close();
      return;
    }
    setBusy(id);
    setError(null);
    try {
      const next = await api.switchWorkspace(id);
      close();
      onSession(next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function create(e: FormEvent, close: () => void) {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    setBusy("new");
    setError(null);
    try {
      const ws = await api.createWorkspace(clean, browserTz());
      const next = await api.switchWorkspace(ws.id);
      close();
      setName("");
      setCreating(false);
      toast(`Created ${ws.name}. Connect its accounts in Connections.`);
      onSession(next);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Menu
      className="ws-menu"
      buttonClassName="ws-switch"
      ariaLabel={`Workspace: ${current?.name ?? ""}. Switch workspace`}
      label={
        <>
          <span className="ws-name">{current?.name ?? "Workspace"}</span>
          <span className="ws-caret" aria-hidden="true">
            ▾
          </span>
        </>
      }
    >
      {(close) => (
        <>
          <div className="menu-h">Workspaces</div>
          {session.workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              role="menuitemradio"
              aria-checked={w.id === session.currentWorkspaceId}
              className={`menu-item ws-item${w.id === session.currentWorkspaceId ? " ws-item-on" : ""}`}
              disabled={busy !== null}
              onClick={() => void switchTo(w.id, close)}
            >
              <span className="ws-item-name">{w.name}</span>
              <span className="muted small">{busy === w.id ? "Opening…" : roleLabel(w.role)}</span>
            </button>
          ))}
          <div className="menu-sep" />
          {creating ? (
            <form className="ws-new" onSubmit={(e) => void create(e, close)}>
              <input
                className="input"
                placeholder="Client or brand name"
                aria-label="New workspace name"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
              />
              <div className="ws-new-actions">
                <button type="submit" className="btn btn-small" disabled={busy !== null || !name.trim()}>
                  {busy === "new" ? "Creating…" : "Create"}
                </button>
                <button type="button" className="btn btn-small btn-ghost" onClick={() => setCreating(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button type="button" role="menuitem" className="menu-item ws-new-item" onClick={() => setCreating(true)}>
              <span>New workspace</span>
              <span className="muted small">For a client or another brand</span>
            </button>
          )}
          {error ? (
            <div className="card-error menu-error" role="alert">
              {error}
            </div>
          ) : null}
        </>
      )}
    </Menu>
  );
}
