import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { and, asc, count, desc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { invites, members, passwordResets, sessions, users, workspaces } from "@starsign/db";
import { newId } from "@starsign/ledger";
import type { Actor } from "@starsign/schema";
import type { MemberRole } from "@starsign/policy";
import { z } from "zod";
import type { CoreContext, Principal } from "../context.ts";
import { sha256 } from "../crypto.ts";
import { CoreError } from "../errors.ts";
import type { WorkspaceService } from "./workspaces.ts";

// ---------------------------------------------------------------- password hashing

/** scrypt cost. N=2^15, r=8, p=1 needs 32 MiB per hash; the params travel with every stored hash so they can change. */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, keyLength: 64, saltLength: 16 } as const;

function scryptAsync(password: string, salt: Buffer, keyLength: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, keyLength, opts, (e, key) => (e ? reject(e) : resolve(key))));
}
const scryptOpts = (N: number, r: number, p: number): ScryptOptions => ({ N, r, p, maxmem: 256 * N * r + 1024 * 1024 });

/** Hash a password: `scrypt$N$r$p$<salt b64url>$<key b64url>`, fresh 16-byte salt per hash. */
export async function hashPassword(password: string): Promise<string> {
  const { N, r, p, keyLength, saltLength } = SCRYPT_PARAMS;
  const salt = randomBytes(saltLength);
  const key = await scryptAsync(password.normalize("NFKC"), salt, keyLength, scryptOpts(N, r, p));
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

function parseHash(encoded: string) {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const salt = Buffer.from(parts[4]!, "base64url");
  const key = Buffer.from(parts[5]!, "base64url");
  // Bounds keep a corrupted row from asking for gigabytes.
  const powerOfTwo = Number.isInteger(N) && N >= 2 ** 10 && N <= 2 ** 20 && (N & (N - 1)) === 0;
  if (!powerOfTwo || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  if (salt.length < 8 || key.length < 16 || key.length > 128) return null;
  return { N, r, p, salt, key };
}

/** Constant-time check of a password against an encoded hash. Malformed hashes never match. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const h = parseHash(encoded);
  if (!h) return false;
  const key = await scryptAsync(password.normalize("NFKC"), h.salt, h.key.length, scryptOpts(h.N, h.r, h.p));
  return key.length === h.key.length && timingSafeEqual(key, h.key);
}

/** True when the hash was made with weaker (or different) parameters than today's. */
export function needsRehash(encoded: string): boolean {
  const h = parseHash(encoded);
  return !h || h.N !== SCRYPT_PARAMS.N || h.r !== SCRYPT_PARAMS.r || h.p !== SCRYPT_PARAMS.p || h.key.length !== SCRYPT_PARAMS.keyLength;
}

// ---------------------------------------------------------------- attempt limiting

/**
 * Sliding-window counter per key (an email). In memory: limits hold per process and reset on restart.
 * Run one API process, or put a shared limiter in front, if that matters for your deployment.
 */
export class AttemptLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  private live(key: string): number[] {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (arr.length) this.hits.set(key, arr);
    else this.hits.delete(key);
    return arr;
  }
  /** 0 when allowed; otherwise how long until the oldest counted attempt ages out. */
  retryAfterMs(key: string): number {
    const arr = this.live(key);
    if (arr.length < this.max) return 0;
    return Math.max(1, arr[arr.length - this.max]! + this.windowMs - this.now());
  }
  hit(key: string): void {
    const arr = this.live(key);
    arr.push(this.now());
    this.hits.set(key, arr);
    if (this.hits.size > 10_000) for (const k of [...this.hits.keys()]) this.live(k);
  }
  reset(key: string): void {
    this.hits.delete(key);
  }
}

// ---------------------------------------------------------------- mail

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML body (client reports); `text` stays the plain-text alternative. */
  html?: string;
}
export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** Resend over HTTPS when RESEND_API_KEY and MAIL_FROM are set; otherwise null (links are only returned / logged). */
export function resendMailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer | null {
  const key = env.RESEND_API_KEY;
  const from = env.MAIL_FROM;
  if (!key || !from) return null;
  return {
    async send(msg) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}) }),
      });
      if (!res.ok) throw new Error(`resend answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
  };
}

// ---------------------------------------------------------------- inputs and shapes

const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const Password = z.string().min(10, "password must be at least 10 characters").max(1024);
const Role = z.enum(["owner", "approver", "editor", "viewer"]);
const Timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "unknown timezone");

/** `timezone`: the new workspace's (the browser's own, from the web app); red lines and schedules read in it. Default UTC. */
export const SignupInput = z.object({ email: Email, password: Password, name: z.string().trim().min(1).max(200), workspaceName: z.string().trim().min(1).max(200), timezone: Timezone.optional().catch(undefined) });
export const LoginInput = z.object({ email: Email, password: z.string().min(1).max(1024) });
export const CreateWorkspaceInput = z.object({ name: z.string().trim().min(1).max(200), slug: z.string().trim().min(1).max(60).optional(), timezone: Timezone.optional() });
export const InviteInput = z.object({ email: Email, role: Role });
export const AcceptInviteInput = z.object({ token: z.string().min(1).max(200), name: z.string().trim().min(1).max(200).optional(), password: z.string().max(1024).optional() });
export const ResetInput = z.object({ token: z.string().min(1).max(200), password: Password });

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}
export interface SessionView {
  user: SessionUser;
  workspaces: { id: string; slug: string; name: string; role: MemberRole }[];
  currentWorkspaceId: string | null;
}
export interface ResolvedSession {
  sessionId: string;
  user: SessionUser;
  currentWorkspaceId: string | null;
  /** Null when the user belongs to no workspace (removed from all); only sign-in routes work then. */
  principal: Principal | null;
  /** True when this lookup slid the expiry forward (the cookie should be re-issued). */
  refreshed: boolean;
}
export interface RequestMeta {
  userAgent?: string | null;
  ip?: string | null;
}
export interface MemberView {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: MemberRole;
  createdAt: Date;
}

/** A pending invite as owners see it. The token (and its hash) is never shown again. */
export interface InviteView {
  id: string;
  email: string;
  role: MemberRole;
  invitedBy: { id: string; name: string | null; email: string | null };
  expiresAt: string;
  createdAt: string;
}

export interface AuthOptions {
  /** Whether people may sign up once a first user exists. Default: STARSIGN_ALLOW_SIGNUP=1, read on each call. */
  allowSignup?: () => boolean;
  /** Undefined: Resend from env when configured. Null: never send mail. */
  mailer?: Mailer | null;
  /** Base for invite and reset links. Default: STARSIGN_PUBLIC_URL. */
  publicUrl?: string;
  /** Print reset links to the console when no mailer is configured. Default: outside production. */
  logLinks?: boolean;
}

export const SESSION_TTL_MS = 30 * 86_400_000;
export const INVITE_TTL_MS = 7 * 86_400_000;
export const RESET_TTL_MS = 3_600_000;
const SESSION_TOUCH_MS = 5 * 60_000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;
const BAD_CREDENTIALS = "email or password is incorrect";

const newToken = () => randomBytes(32).toString("base64url");
const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "workspace";

/**
 * People: email + password sign-in, browser sessions, teams (members, roles, invites), workspace switching, password reset.
 * Tokens (session, invite, reset) are 32 random bytes handed to the person once; only their sha256 is stored.
 */
export class AuthService {
  private readonly logins: AttemptLimiter;
  private readonly resets: AttemptLimiter;
  private readonly mailer: Mailer | null;
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly ctx: CoreContext,
    private readonly workspaces: WorkspaceService,
    private readonly opts: AuthOptions = {},
  ) {
    const clock = () => this.ctx.now().getTime();
    this.logins = new AttemptLimiter(LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, clock);
    this.resets = new AttemptLimiter(5, LOGIN_WINDOW_MS, clock);
    this.mailer = opts.mailer === undefined ? resendMailerFromEnv() : opts.mailer;
  }

  get mailConfigured(): boolean {
    return this.mailer !== null;
  }

  private signupOpen(): boolean {
    return this.opts.allowSignup ? this.opts.allowSignup() : process.env.STARSIGN_ALLOW_SIGNUP === "1";
  }
  private link(baseUrl: string | undefined, param: string, token: string): string {
    const base = (baseUrl ?? this.opts.publicUrl ?? process.env.STARSIGN_PUBLIC_URL ?? "").replace(/\/+$/, "");
    return `${base}/?${param}=${encodeURIComponent(token)}`;
  }
  private sendLater(msg: MailMessage): void {
    if (!this.mailer) return;
    this.mailer.send(msg).catch((e) => console.error("[auth] mail failed:", e instanceof Error ? e.message : e));
  }

  // ------------------------------------------------------------ users

  private async userByEmail(email: string) {
    const [u] = await this.ctx.db.select().from(users).where(eq(users.email, email)).limit(1);
    return u ?? null;
  }
  private async userById(id: string) {
    const [u] = await this.ctx.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!u) throw new CoreError("not_found", `user ${id}`);
    return u;
  }
  /** Spend the same scrypt time when there is no hash to check, so unknown emails do not answer faster. */
  private async burnHash(password: string): Promise<void> {
    this.dummyHash ??= hashPassword(newToken());
    await verifyPassword(password, await this.dummyHash);
  }
  private loginBlocked(email: string): void {
    const wait = this.logins.retryAfterMs(email);
    if (wait > 0) {
      throw new CoreError("rate_limited", `too many failed sign-ins; try again in ${Math.ceil(wait / 60_000)} minute(s)`, { retryAfterSeconds: Math.ceil(wait / 1000) });
    }
  }
  /** Check a password for an email, counting failures. Throws the same 401 for unknown email and wrong password. */
  private async checkPassword(email: string, password: string) {
    this.loginBlocked(email);
    const u = await this.userByEmail(email);
    const ok = u?.passwordHash ? await verifyPassword(password, u.passwordHash) : (await this.burnHash(password), false);
    if (!u || !ok) {
      this.logins.hit(email);
      throw new CoreError("unauthorized", BAD_CREDENTIALS);
    }
    this.logins.reset(email);
    if (needsRehash(u.passwordHash!)) await this.ctx.db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, u.id));
    return u;
  }

  /** Set a password outright (seed, admin tooling). Revokes the user's sessions. */
  async setPassword(userId: string, password: string): Promise<void> {
    Password.parse(password);
    await this.ctx.db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, userId));
    await this.revokeAllSessions(userId);
  }

  // ------------------------------------------------------------ sessions

  private async createSession(userId: string, workspaceId: string | null, meta: RequestMeta): Promise<string> {
    const token = newToken();
    const now = this.ctx.now();
    await this.ctx.db.insert(sessions).values({
      id: sha256(token),
      userId,
      currentWorkspaceId: workspaceId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      ip: meta.ip?.slice(0, 64) ?? null,
    });
    return token;
  }

  private async memberships(userId: string) {
    return this.ctx.db
      .select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name, role: members.role })
      .from(members)
      .innerJoin(workspaces, eq(members.workspaceId, workspaces.id))
      .where(eq(members.userId, userId))
      .orderBy(asc(members.createdAt));
  }

  /** Where a fresh session lands: the workspace the user's last session was in, else their first membership. */
  private async landingWorkspace(userId: string): Promise<string | null> {
    const mine = await this.memberships(userId);
    if (!mine.length) return null;
    const [last] = await this.ctx.db
      .select({ ws: sessions.currentWorkspaceId })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.lastSeenAt))
      .limit(1);
    return mine.find((w) => w.id === last?.ws)?.id ?? mine[0]!.id;
  }

  async view(userId: string, currentWorkspaceId: string | null): Promise<SessionView> {
    const u = await this.userById(userId);
    return { user: { id: u.id, email: u.email, name: u.name }, workspaces: await this.memberships(userId), currentWorkspaceId };
  }

  private async start(userId: string, workspaceId: string | null, meta: RequestMeta) {
    const ws = workspaceId ?? (await this.landingWorkspace(userId));
    const token = await this.createSession(userId, ws, meta);
    return { token, view: await this.view(userId, ws) };
  }

  /**
   * Look a cookie token up. Null when unknown, expired or revoked. Slides the expiry (at most every five minutes)
   * and re-checks membership on every call: a removed member falls back to another workspace or to none.
   */
  async resolveSession(token: string | undefined | null): Promise<ResolvedSession | null> {
    if (!token || token.length > 200) return null;
    const now = this.ctx.now();
    const [s] = await this.ctx.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sha256(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
      .limit(1);
    if (!s) return null;
    const [u] = await this.ctx.db.select().from(users).where(eq(users.id, s.userId)).limit(1);
    if (!u) return null;
    let wsId = s.currentWorkspaceId;
    let role = wsId ? await this.workspaces.memberRole(wsId, u.id) : null;
    if (!role) {
      const fallback = (await this.memberships(u.id))[0];
      wsId = fallback?.id ?? null;
      role = fallback?.role ?? null;
      if (wsId !== s.currentWorkspaceId) await this.ctx.db.update(sessions).set({ currentWorkspaceId: wsId }).where(eq(sessions.id, s.id));
    }
    let refreshed = false;
    if (now.getTime() - s.lastSeenAt.getTime() >= SESSION_TOUCH_MS) {
      await this.ctx.db.update(sessions).set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) }).where(eq(sessions.id, s.id));
      refreshed = true;
    }
    return {
      sessionId: s.id,
      user: { id: u.id, email: u.email, name: u.name },
      currentWorkspaceId: wsId,
      principal: wsId && role ? { workspaceId: wsId, actor: { type: "human", id: u.id }, role } : null,
      refreshed,
    };
  }

  async logout(token: string | undefined | null): Promise<void> {
    if (!token || token.length > 200) return;
    await this.ctx.db.update(sessions).set({ revokedAt: this.ctx.now() }).where(and(eq(sessions.id, sha256(token)), isNull(sessions.revokedAt)));
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.ctx.db.update(sessions).set({ revokedAt: this.ctx.now() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }

  async switchWorkspace(session: ResolvedSession, workspaceId: string): Promise<SessionView> {
    const role = await this.workspaces.memberRole(workspaceId, session.user.id);
    if (!role) throw new CoreError("forbidden", "you are not a member of that workspace");
    // Bumping last_seen_at makes this the workspace the person's next sign-in lands in.
    await this.ctx.db.update(sessions).set({ currentWorkspaceId: workspaceId, lastSeenAt: this.ctx.now() }).where(eq(sessions.id, session.sessionId));
    return this.view(session.user.id, workspaceId);
  }

  // ------------------------------------------------------------ sign up / sign in

  /** People who can sign in. Users without a password (seeded, or from before sign-in existed) do not count. */
  private async accountsWithPassword(): Promise<number> {
    const [{ n }] = (await this.ctx.db.select({ n: count() }).from(users).where(isNotNull(users.passwordHash))) as [{ n: number }];
    return Number(n);
  }

  /** For the sign-in screen: whether a sign-up would be accepted, and whether nobody can sign in yet. */
  async signupStatus(): Promise<{ signupAllowed: boolean; firstRun: boolean; mail: boolean }> {
    const firstRun = (await this.accountsWithPassword()) === 0;
    // `mail`: whether reset links can be emailed at all, so "Forgot password?" can say so instead of promising one.
    return { signupAllowed: firstRun || this.signupOpen(), firstRun, mail: this.mailConfigured };
  }

  /**
   * The first account always; after that only when sign-up is open. Creates the user, their workspace and owner
   * membership. "First" means nobody can sign in yet: a deployment whose only users have no password (seeded, or
   * created before sign-in existed) is still open, and signing up with such a user's email claims that user.
   */
  async signup(raw: unknown, meta: RequestMeta = {}) {
    const input = SignupInput.parse(raw);
    const firstRun = (await this.accountsWithPassword()) === 0;
    if (!firstRun && !this.signupOpen()) throw new CoreError("forbidden", "sign-up is closed on this deployment; ask an owner for an invite");
    const existing = await this.userByEmail(input.email);
    if (existing && firstRun && !existing.passwordHash) {
      await this.ctx.db.update(users).set({ passwordHash: await hashPassword(input.password), name: existing.name ?? input.name }).where(eq(users.id, existing.id));
      const mine = await this.memberships(existing.id);
      const ws = mine[0] ? null : await this.newWorkspace({ type: "human", id: existing.id }, { name: input.workspaceName, timezone: input.timezone });
      const workspaceId = ws?.id ?? mine[0]!.id;
      await this.ctx.events.append({ workspaceId, type: "user.signed_up", subjectType: "user", subjectId: existing.id, actor: { type: "human", id: existing.id }, data: { via: "claim" } });
      return this.start(existing.id, workspaceId, meta);
    }
    if (existing) throw new CoreError("conflict", "an account with this email exists; sign in or reset your password");
    const [u] = await this.ctx.db
      .insert(users)
      .values({ id: newId("usr"), email: input.email, name: input.name, passwordHash: await hashPassword(input.password) })
      .returning();
    const actor: Actor = { type: "human", id: u!.id };
    const ws = await this.newWorkspace(actor, { name: input.workspaceName, timezone: input.timezone });
    await this.ctx.events.append({ workspaceId: ws.id, type: "user.signed_up", subjectType: "user", subjectId: u!.id, actor, data: { via: "signup" } });
    return this.start(u!.id, ws.id, meta);
  }

  async login(raw: unknown, meta: RequestMeta = {}) {
    const input = LoginInput.parse(raw);
    const u = await this.checkPassword(input.email, input.password);
    return this.start(u.id, null, meta);
  }

  // ------------------------------------------------------------ workspaces

  private async uniqueSlug(base: string): Promise<string> {
    const root = slugify(base);
    if (!(await this.workspaces.bySlug(root))) return root;
    for (let i = 0; i < 8; i++) {
      const s = `${root}-${randomBytes(3).toString("hex")}`;
      if (!(await this.workspaces.bySlug(s))) return s;
    }
    throw new CoreError("conflict", "could not find a free workspace slug; pass one");
  }

  private async newWorkspace(actor: Actor, input: { name: string; slug?: string; timezone?: string }) {
    const slug = input.slug ? input.slug : await this.uniqueSlug(input.name);
    const ws = await this.workspaces.create({ slug, name: input.name, timezone: input.timezone }, actor);
    const m = await this.workspaces.addMember(ws.id, actor.id, "owner");
    await this.ctx.events.append({ workspaceId: ws.id, type: "member.added", subjectType: "member", subjectId: m.id, actor, data: { userId: actor.id, role: "owner" } });
    return ws;
  }

  /** Any signed-in user may create a workspace (an agency adding a client); they become its owner. */
  async createWorkspace(userId: string, raw: unknown) {
    const input = CreateWorkspaceInput.parse(raw);
    await this.userById(userId);
    return this.newWorkspace({ type: "human", id: userId }, input);
  }

  // ------------------------------------------------------------ members

  private requireMember(p: Principal): void {
    this.workspaces.requireRole(p, ["owner", "approver", "editor", "viewer"]);
  }

  async listMembers(p: Principal): Promise<MemberView[]> {
    this.requireMember(p);
    return this.memberRows(p.workspaceId);
  }

  private async memberRows(workspaceId: string, memberId?: string): Promise<MemberView[]> {
    return this.ctx.db
      .select({ id: members.id, userId: members.userId, email: users.email, name: users.name, role: members.role, createdAt: members.createdAt })
      .from(members)
      .innerJoin(users, eq(members.userId, users.id))
      .where(memberId ? and(eq(members.workspaceId, workspaceId), eq(members.id, memberId)) : eq(members.workspaceId, workspaceId))
      .orderBy(asc(members.createdAt));
  }

  private async target(p: Principal, memberId: string): Promise<MemberView> {
    const [row] = await this.memberRows(p.workspaceId, memberId);
    if (!row) throw new CoreError("not_found", `member ${memberId}`);
    return row;
  }

  private async ownerCount(workspaceId: string): Promise<number> {
    const [r] = await this.ctx.db.select({ n: count() }).from(members).where(and(eq(members.workspaceId, workspaceId), eq(members.role, "owner")));
    return Number(r?.n ?? 0);
  }

  async updateMemberRole(p: Principal, memberId: string, rawRole: unknown): Promise<MemberView> {
    this.workspaces.requireRole(p, ["owner"]);
    const role = Role.parse(rawRole);
    const t = await this.target(p, memberId);
    if (t.role === role) return t;
    if (t.role === "owner" && (await this.ownerCount(p.workspaceId)) <= 1) throw new CoreError("conflict", "a workspace needs at least one owner; make someone else an owner first");
    await this.ctx.db.update(members).set({ role }).where(eq(members.id, t.id));
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "member.role_changed", subjectType: "member", subjectId: t.id, actor: p.actor, data: { userId: t.userId, from: t.role, to: role } });
    return { ...t, role };
  }

  async removeMember(p: Principal, memberId: string): Promise<void> {
    this.workspaces.requireRole(p, ["owner"]);
    const t = await this.target(p, memberId);
    if (t.role === "owner" && (await this.ownerCount(p.workspaceId)) <= 1) throw new CoreError("conflict", "cannot remove the last owner of a workspace");
    await this.ctx.db.delete(members).where(eq(members.id, t.id));
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "member.removed", subjectType: "member", subjectId: t.id, actor: p.actor, data: { userId: t.userId, role: t.role } });
  }

  // ------------------------------------------------------------ invites

  /** Owners invite by email. The link is always returned; it is also emailed when mail is configured. */
  async createInvite(p: Principal, raw: unknown, baseUrl?: string) {
    this.workspaces.requireRole(p, ["owner"]);
    const input = InviteInput.parse(raw);
    const existing = await this.userByEmail(input.email);
    if (existing && (await this.workspaces.memberRole(p.workspaceId, existing.id))) throw new CoreError("conflict", `${input.email} is already a member`);
    const ws = await this.workspaces.get(p.workspaceId);
    const token = newToken();
    const expiresAt = new Date(this.ctx.now().getTime() + INVITE_TTL_MS);
    const id = newId("inv");
    await this.ctx.db.insert(invites).values({ id, tokenHash: sha256(token), workspaceId: p.workspaceId, email: input.email, role: input.role, invitedBy: p.actor.id, expiresAt, createdAt: this.ctx.now() });
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "invite.created", subjectType: "invite", subjectId: id, actor: p.actor, data: { email: input.email, role: input.role } });
    const inviteUrl = this.link(baseUrl, "invite", token);
    this.sendLater({
      to: input.email,
      subject: `You're invited to ${ws.name} on Starsign`,
      text: `You've been invited to join ${ws.name} on Starsign as ${input.role}.\n\nAccept the invite: ${inviteUrl}\n\nThe link works once and expires ${expiresAt.toUTCString()}.`,
    });
    return { inviteUrl, expiresAt: expiresAt.toISOString(), emailed: this.mailer !== null };
  }

  /**
   * Pending invites for this workspace, newest first: not accepted and not yet expired (a revoked invite is expired
   * on the spot, so it drops out too). Owners only. Never returns the token hash.
   */
  async listInvites(p: Principal): Promise<InviteView[]> {
    this.workspaces.requireRole(p, ["owner"]);
    const rows = await this.ctx.db
      .select({
        id: invites.id,
        email: invites.email,
        role: invites.role,
        invitedBy: invites.invitedBy,
        inviterName: users.name,
        inviterEmail: users.email,
        expiresAt: invites.expiresAt,
        createdAt: invites.createdAt,
      })
      .from(invites)
      .leftJoin(users, eq(users.id, invites.invitedBy))
      .where(and(eq(invites.workspaceId, p.workspaceId), isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, this.ctx.now())))
      .orderBy(desc(invites.createdAt));
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      invitedBy: { id: r.invitedBy, name: r.inviterName ?? null, email: r.inviterEmail ?? null },
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Revoke a pending invite: its link stops working at once. Owners only. The invites table has no revoked flag, so a
   * revoked invite is one whose expiry was moved to now (the row stays, so who invited whom is not lost).
   */
  async revokeInvite(p: Principal, inviteId: string): Promise<void> {
    this.workspaces.requireRole(p, ["owner"]);
    const at = this.ctx.now();
    const [row] = await this.ctx.db
      .update(invites)
      .set({ revokedAt: at })
      .where(and(eq(invites.id, inviteId), eq(invites.workspaceId, p.workspaceId), isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, at)))
      .returning({ id: invites.id, email: invites.email, role: invites.role });
    if (!row) throw new CoreError("not_found", "invite not found, already used, expired or revoked");
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "invite.revoked", subjectType: "invite", subjectId: row.id, actor: p.actor, data: { email: row.email, role: row.role } });
  }

  private async liveInvite(token: string) {
    const [row] = await this.ctx.db
      .select({ invite: invites, workspaceName: workspaces.name })
      .from(invites)
      .innerJoin(workspaces, eq(invites.workspaceId, workspaces.id))
      .where(and(eq(invites.tokenHash, sha256(token)), isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, this.ctx.now())))
      .limit(1);
    if (!row) throw new CoreError("not_found", "invite not found, already used, revoked, or expired");
    return row;
  }

  async viewInvite(token: string) {
    const { invite, workspaceName } = await this.liveInvite(token);
    const u = await this.userByEmail(invite.email);
    return { workspaceName, email: invite.email, role: invite.role, expiresAt: invite.expiresAt.toISOString(), userExists: !!u?.passwordHash };
  }

  /**
   * Accept an invite. Signed in: the account's email must match. Not signed in: an existing account proves itself with
   * its password; a new person sets one (and becomes a user). The previous session, if any, is revoked.
   */
  async acceptInvite(raw: unknown, current: ResolvedSession | null, meta: RequestMeta = {}) {
    const input = AcceptInviteInput.parse(raw);
    const { invite } = await this.liveInvite(input.token);
    let userId: string;
    let created = false;
    if (current) {
      if (current.user.email !== invite.email) throw new CoreError("forbidden", `this invite is for ${invite.email}; sign in with that email to accept it`);
      userId = current.user.id;
    } else {
      const existing = await this.userByEmail(invite.email);
      if (existing?.passwordHash) {
        if (!input.password) throw new CoreError("unauthorized", "an account with this email exists; enter its password to accept");
        userId = (await this.checkPassword(invite.email, input.password)).id;
      } else {
        const password = Password.parse(input.password ?? "");
        const passwordHash = await hashPassword(password);
        if (existing) {
          await this.ctx.db.update(users).set({ passwordHash, name: input.name ?? existing.name }).where(eq(users.id, existing.id));
          userId = existing.id;
        } else {
          const [u] = await this.ctx.db.insert(users).values({ id: newId("usr"), email: invite.email, name: input.name ?? null, passwordHash }).returning();
          userId = u!.id;
        }
        created = true;
      }
    }
    // Claim the invite atomically: two tabs cannot both accept it.
    const [claimed] = await this.ctx.db
      .update(invites)
      .set({ acceptedAt: this.ctx.now(), acceptedBy: userId })
      .where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt)))
      .returning();
    if (!claimed) throw new CoreError("not_found", "invite not found, already used, or expired");
    // Holding the token proves control of the address it was sent to.
    await this.ctx.db.update(users).set({ emailVerifiedAt: this.ctx.now() }).where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
    const actor: Actor = { type: "human", id: userId };
    if (created) await this.ctx.events.append({ workspaceId: invite.workspaceId, type: "user.signed_up", subjectType: "user", subjectId: userId, actor, data: { via: "invite", inviteId: invite.id } });
    // An existing member keeps their role: accepting a viewer invite must never demote an owner.
    if (!(await this.workspaces.memberRole(invite.workspaceId, userId))) {
      const m = await this.workspaces.addMember(invite.workspaceId, userId, invite.role);
      await this.ctx.events.append({ workspaceId: invite.workspaceId, type: "member.added", subjectType: "member", subjectId: m.id, actor, data: { userId, role: invite.role, inviteId: invite.id } });
    }
    await this.ctx.events.append({ workspaceId: invite.workspaceId, type: "invite.accepted", subjectType: "invite", subjectId: invite.id, actor, data: { userId, role: invite.role, newUser: created } });
    if (current) await this.ctx.db.update(sessions).set({ revokedAt: this.ctx.now() }).where(eq(sessions.id, current.sessionId));
    return this.start(userId, invite.workspaceId, meta);
  }

  // ------------------------------------------------------------ password reset

  /**
   * Start a reset. Callers answer 204 whatever happens, so this never says whether the email exists.
   * Returns the token for tests and tooling; the HTTP layer drops it.
   */
  async requestPasswordReset(rawEmail: unknown, baseUrl?: string): Promise<{ token: string } | null> {
    const parsed = Email.safeParse(rawEmail);
    if (!parsed.success) return null;
    const email = parsed.data;
    if (this.resets.retryAfterMs(email) > 0) return null;
    this.resets.hit(email);
    const u = await this.userByEmail(email);
    if (!u) return null;
    const token = newToken();
    const now = this.ctx.now();
    await this.ctx.db.insert(passwordResets).values({ id: newId("pwr"), tokenHash: sha256(token), userId: u.id, expiresAt: new Date(now.getTime() + RESET_TTL_MS), createdAt: now });
    const url = this.link(baseUrl, "reset", token);
    if (this.mailer) {
      this.sendLater({ to: email, subject: "Reset your Starsign password", text: `Someone asked to reset the password for ${email} on Starsign.\n\nChoose a new password: ${url}\n\nThe link works once and expires in an hour. If this wasn't you, ignore this email.` });
    } else if (this.opts.logLinks ?? process.env.NODE_ENV !== "production") {
      console.info(`[auth] no mail configured (RESEND_API_KEY + MAIL_FROM); password reset link for ${email}: ${url}`);
    }
    return { token };
  }

  /**
   * A reset link made by someone with shell access to the server (the `admin reset-link` command), for deployments
   * without mail. No rate limit and no email; the caller prints it.
   */
  async adminResetLink(rawEmail: string, baseUrl?: string): Promise<string> {
    const u = await this.userByEmail(Email.parse(rawEmail));
    if (!u) throw new CoreError("not_found", `no user with email ${rawEmail}`);
    const token = newToken();
    const now = this.ctx.now();
    await this.ctx.db.insert(passwordResets).values({ id: newId("pwr"), tokenHash: sha256(token), userId: u.id, expiresAt: new Date(now.getTime() + RESET_TTL_MS), createdAt: now });
    return this.link(baseUrl, "reset", token);
  }

  /** Everyone on the deployment, for the admin command. */
  async listUsers() {
    const rows = await this.ctx.db.select({ id: users.id, email: users.email, name: users.name, passwordHash: users.passwordHash, createdAt: users.createdAt }).from(users).orderBy(asc(users.createdAt));
    return rows.map(({ passwordHash, ...u }) => ({ ...u, canSignIn: Boolean(passwordHash) }));
  }

  /** Finish a reset: single use, one hour. Signs the user out everywhere. */
  async resetPassword(raw: unknown): Promise<void> {
    const input = ResetInput.parse(raw);
    const now = this.ctx.now();
    const [row] = await this.ctx.db
      .update(passwordResets)
      .set({ usedAt: now })
      .where(and(eq(passwordResets.tokenHash, sha256(input.token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, now)))
      .returning();
    if (!row) throw new CoreError("invalid", "this reset link is invalid, already used, or expired");
    const u = await this.userById(row.userId);
    await this.ctx.db.update(users).set({ passwordHash: await hashPassword(input.password), emailVerifiedAt: u.emailVerifiedAt ?? now }).where(eq(users.id, u.id));
    // Any other outstanding links for this user die with this one.
    await this.ctx.db.update(passwordResets).set({ usedAt: now }).where(and(eq(passwordResets.userId, u.id), isNull(passwordResets.usedAt)));
    await this.revokeAllSessions(u.id);
    this.logins.reset(u.email);
  }
}
