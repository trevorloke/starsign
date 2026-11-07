import type { Hono } from "hono";
import { z } from "zod";
import { CoreError, slotFor, type Starsign, type VisibilityEngine, type VisibilityRuntime } from "@starsign/core";
import { answerEngineStatus, answerEnginesFromEnv, gatewayAnswerJudge, gatewayQuestionSuggester, type AnswerEngineStatus, type ModelGateway } from "@starsign/ai";
import type { Env } from "./app.ts";

export interface VisibilityRouteOptions {
  /** The judge and the question helper. Absent: answers are still checked for mentions; suggestions answer 503. */
  gateway?: ModelGateway | null;
  /** Engines to ask. Default: one per key in the environment. */
  answerEngines?: VisibilityEngine[];
  env?: NodeJS.ProcessEnv;
}

const DAY = 86_400_000;

function date(v: string | undefined, fallback: Date): Date {
  if (!v) return fallback;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new CoreError("invalid", `bad date: ${v}`);
  return d;
}

/**
 * AI answer visibility: the questions a workspace asks AI assistants, run now, the report and the answers.
 * Roles are checked in core (VisibilityService): viewers and agents read; editors and up manage questions and run
 * them; owners choose engines and cadence limits.
 */
export function registerVisibilityRoutes(app: Hono<Env>, m: Starsign, opts: VisibilityRouteOptions = {}) {
  const env = opts.env ?? process.env;
  let engines: VisibilityEngine[] | null = opts.answerEngines ?? null;
  const enginesNow = () => (engines ??= answerEnginesFromEnv(env));
  const runtime = (): VisibilityRuntime => ({ engines: enginesNow(), judge: opts.gateway ? gatewayAnswerJudge(opts.gateway) : null });

  /** Every engine Starsign knows: configured here (its key is set), and enabled for this workspace. */
  const engineList = async (workspaceId: string): Promise<(AnswerEngineStatus & { enabled: boolean })[]> => {
    const live = enginesNow();
    const settings = await m.visibility.settings(workspaceId);
    const known = answerEngineStatus(env).map((s) => {
      const e = live.find((x) => x.id === s.id);
      return { ...s, configured: !!e, model: e?.model ?? s.model };
    });
    for (const e of live) {
      if (!known.some((k) => k.id === e.id)) known.push({ id: e.id as AnswerEngineStatus["id"], label: e.label, configured: true, envVar: "STARSIGN_FAKE_AI", modelEnvVar: null, model: e.model, priced: true });
    }
    return known.map((k) => ({ ...k, enabled: k.configured && (settings.engines === null || settings.engines.includes(k.id)) }));
  };

  app.get("/v1/visibility/engines", async (c) => c.json(await engineList(c.get("principal").workspaceId)));

  app.get("/v1/visibility/settings", async (c) => {
    const ws = c.get("principal").workspaceId;
    return c.json({ settings: await m.visibility.settings(ws), engines: await engineList(ws), judge: Boolean(opts.gateway) });
  });
  app.patch("/v1/visibility/settings", async (c) => {
    const p = c.get("principal");
    const settings = await m.visibility.updateSettings(p, await c.req.json());
    return c.json({ settings, engines: await engineList(p.workspaceId), judge: Boolean(opts.gateway) });
  });

  // ---------------------------------------------------------------- questions
  const withDue = <T extends { cadence: "daily" | "weekly"; lastSlot: string | null; archivedAt: Date | null }>(row: T) => ({ ...row, due: !row.archivedAt && row.lastSlot !== slotFor(row.cadence, m.ctx.now()) });

  app.get("/v1/visibility/prompts", async (c) => {
    const p = c.get("principal");
    const rows = await m.visibility.listPrompts(p.workspaceId, { includeArchived: c.req.query("archived") === "1" });
    return c.json(rows.map(withDue));
  });
  app.post("/v1/visibility/prompts", async (c) => c.json(withDue(await m.visibility.createPrompt(c.get("principal"), await c.req.json())), 201));
  app.get("/v1/visibility/prompts/:id", async (c) => c.json(withDue(await m.visibility.getPrompt(c.get("principal").workspaceId, c.req.param("id")))));
  app.patch("/v1/visibility/prompts/:id", async (c) => c.json(withDue(await m.visibility.updatePrompt(c.get("principal"), c.req.param("id"), await c.req.json()))));
  app.delete("/v1/visibility/prompts/:id", async (c) => {
    await m.visibility.archivePrompt(c.get("principal"), c.req.param("id"));
    return c.body(null, 204);
  });
  /** Ask this question on every enabled engine now. Inside the spend cap; past it, answers are recorded as capped. */
  app.post("/v1/visibility/prompts/:id/run", async (c) => {
    const p = c.get("principal");
    if (enginesNow().length === 0) throw new CoreError("unavailable", "no answer engine is configured on this server; set ANTHROPIC_API_KEY, OPENAI_API_KEY, PERPLEXITY_API_KEY or GEMINI_API_KEY");
    const result = await m.visibility.runNow(p, c.req.param("id"), runtime());
    if (result.skipped) throw new CoreError("unavailable", `nothing was asked: ${result.skipped} for this workspace`);
    return c.json(result);
  });

  /** Suggestions only; nothing is saved until the person adds a question. */
  app.post("/v1/visibility/suggest", async (c) => {
    const p = c.get("principal");
    const body = z
      .object({ languages: z.array(z.string().min(2).max(12)).max(6).default([]), count: z.number().int().min(1).max(20).default(8) })
      .parse(await c.req.json().catch(() => ({})));
    if (!opts.gateway) throw new CoreError("unavailable", "no model is configured for this deployment, so suggestions are off");
    const policy = await m.policy.getActive(p.workspaceId);
    if ((await m.ops.modelSpendThisMonth(p.workspaceId, m.ctx.now())) >= policy.spendCaps.modelUsdMonthly) {
      throw new CoreError("unavailable", "this workspace has reached its monthly model spend cap; raise it in the policy for more suggestions");
    }
    const languages = body.languages.length ? body.languages : [(await m.translations.settings(p.workspaceId)).home];
    return c.json(await m.visibility.suggest(p, gatewayQuestionSuggester(opts.gateway), { languages, count: body.count }));
  });

  // ---------------------------------------------------------------- reading
  app.get("/v1/visibility/report", async (c) => {
    const p = c.get("principal");
    const now = m.ctx.now();
    const to = date(c.req.query("to"), now);
    const from = date(c.req.query("from"), new Date(to.getTime() - 28 * DAY));
    if (from >= to) throw new CoreError("invalid", "from must be before to");
    return c.json({ ...(await m.visibility.report(p.workspaceId, from, to)), engines: await engineList(p.workspaceId) });
  });
  app.get("/v1/visibility/answers", async (c) => {
    const p = c.get("principal");
    const q = c.req.query();
    return c.json(
      await m.visibility.answers(p.workspaceId, {
        ...(q.promptId ? { promptId: q.promptId } : {}),
        ...(q.engine ? { engine: q.engine } : {}),
        ...(q.entity ? { entityId: q.entity, mentioned: q.mentioned !== "0" } : {}),
        ...(q.lang ? { lang: q.lang } : {}),
        ...(q.from ? { from: date(q.from, m.ctx.now()) } : {}),
        ...(q.to ? { to: date(q.to, m.ctx.now()) } : {}),
        limit: q.limit ? Number(q.limit) : 50,
      }),
    );
  });
}
