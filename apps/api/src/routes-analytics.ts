import type { Context, Hono } from "hono";
import { CoreError, type Starsign } from "@starsign/core";
import type { AppOptions, Env } from "./app.ts";

/**
 * Analytics and client reports.
 *   GET    /v1/analytics?from&to&networks=&accounts=
 *   GET    /v1/reports · POST /v1/reports · POST /v1/reports/preview
 *   GET    /v1/reports/:id · PATCH /v1/reports/:id · DELETE /v1/reports/:id
 *   GET    /v1/reports/:id/render?format=html
 *   POST   /v1/reports/:id/send
 *   POST   /v1/reports/:id/share · DELETE /v1/reports/:id/share
 *   GET    /r/:token   (public, read-only, no session)
 */

const DAY = 86_400_000;
const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
function date(v: string | undefined, fallback: Date): Date {
  if (!v) return fallback;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new CoreError("invalid", `bad date: ${v}`);
  return d;
}

/**
 * A rendered report is a document from Starsign, never an app page: no scripts run, nothing loads but inline styles
 * and images (the logo), and it is never framed by another site or indexed.
 */
const REPORT_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: http: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

export function registerAnalyticsRoutes(app: Hono<Env>, m: Starsign, opts: AppOptions = {}) {
  const base = (c: Context<Env>) => (opts.publicUrl ?? new URL(c.req.url).origin).replace(/\/+$/, "");

  app.get("/v1/analytics", async (c) => {
    const p = c.get("principal");
    const now = m.ctx.now();
    const to = date(c.req.query("to"), now);
    const from = date(c.req.query("from"), new Date(to.getTime() - 30 * DAY));
    return c.json(await m.analytics.get(p, { from, to, networks: list(c.req.query("networks")), accounts: list(c.req.query("accounts")) }));
  });

  app.get("/v1/reports", async (c) => c.json(await m.reports.list(c.get("principal"))));
  app.post("/v1/reports", async (c) => c.json(await m.reports.create(c.get("principal"), await c.req.json()), 201));
  app.post("/v1/reports/preview", async (c) => c.body(await m.reports.preview(c.get("principal"), await c.req.json()), 200, REPORT_HEADERS));
  app.get("/v1/reports/:id", async (c) => c.json(await m.reports.get(c.get("principal"), c.req.param("id"))));
  app.patch("/v1/reports/:id", async (c) => c.json(await m.reports.update(c.get("principal"), c.req.param("id"), await c.req.json())));
  app.delete("/v1/reports/:id", async (c) => {
    await m.reports.remove(c.get("principal"), c.req.param("id"));
    return c.body(null, 204);
  });
  app.get("/v1/reports/:id/render", async (c) => {
    const format = c.req.query("format") ?? "html";
    if (format !== "html") throw new CoreError("invalid", "format must be html");
    return c.body(await m.reports.render(c.get("principal"), c.req.param("id")), 200, REPORT_HEADERS);
  });
  app.post("/v1/reports/:id/send", async (c) => c.json(await m.reports.send(c.get("principal"), c.req.param("id"), base(c))));
  app.post("/v1/reports/:id/share", async (c) => c.json(await m.reports.share(c.get("principal"), c.req.param("id"), base(c)), 201));
  app.delete("/v1/reports/:id/share", async (c) => {
    await m.reports.revokeShares(c.get("principal"), c.req.param("id"));
    return c.body(null, 204);
  });

  // Public: anyone with the link reads the latest version. No session, no API key, nothing to change.
  app.get("/r/:token", async (c) => {
    const html = await m.reports.renderShared(c.req.param("token"));
    if (html === null) return c.text("This report link does not exist or has been turned off.", 404, { "cache-control": "no-store", "x-robots-tag": "noindex" });
    return c.body(html, 200, { ...REPORT_HEADERS, "content-security-policy": REPORT_HEADERS["content-security-policy"].replace("frame-ancestors 'self'", "frame-ancestors 'none'") });
  });
}
