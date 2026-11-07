import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createTestDb } from "@starsign/db/test";
import { activities, type DbHandle } from "@starsign/db";
import { ConnectorRegistry, type Connector, type ConnectorCapabilities, type WebhookHandler } from "@starsign/connectors";
import type { ActivityInput, Network } from "@starsign/schema";
import { InMemoryScheduler, SecretBox, Starsign, type Principal } from "../src/index.ts";

/** Like WeCom customer service: the callback only says "new messages waiting"; the messages come from a pull. */
class Announcer implements Connector {
  readonly name = "announcer";
  readonly networks: readonly Network[] = ["wecom"];
  readonly connectMethod = "api_key" as const;
  pulls = 0;
  waiting: string[] = [];
  /** Held open to show that bursts collapse into one follow-up pull. */
  gate: Promise<void> = Promise.resolve();
  capabilities(): ConnectorCapabilities {
    return { publish: false, fetchActivity: true, fetchMetrics: false, meteredReads: false, webhooks: true };
  }
  async publish(): Promise<never> {
    throw new Error("no");
  }
  async fetchActivity(): Promise<ActivityInput[]> {
    this.pulls++;
    await this.gate;
    const texts = this.waiting.splice(0);
    return texts.map((text, i) => ({ network: "wecom", kind: "dm", externalId: `${this.pulls}-${i}`, authorHandle: "cust", authorName: null, text, url: null, parentExternalId: null, occurredAt: new Date().toISOString(), raw: {}, conversation: { id: "cust", type: "direct" } }));
  }
  async fetchMetrics() {
    return [];
  }
  readonly webhook: WebhookHandler = {
    verify: () => false,
    route: (_raw, query) => (query.account ? { network: "wecom", accountExternalId: query.account } : null),
    verifyAccount: (account, headers) => headers["x-token"] === account.auth?.token,
    parse: () => [],
    pullNow: (body) => (body as { event?: string }).event === "new_messages",
    ack: { body: "", contentType: "text/plain" },
  };
}

let h: DbHandle;
let m: Starsign;
let ws: Principal;
const conn = new Announcer();
const deliver = (event: string) => m.webhooks.receive("announcer", { "x-token": "t1" }, JSON.stringify({ event }), { account: "corp-1" });

beforeAll(async () => {
  h = await createTestDb();
  m = new Starsign({ handle: h, connectors: new ConnectorRegistry().register(conn), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)) });
  const w = await m.workspaces.create({ slug: "acme", name: "Acme" }, { type: "human", id: "u" });
  ws = { workspaceId: w.id, actor: { type: "human", id: "u" }, role: "owner" };
  await m.accounts.connect(ws, { network: "wecom", externalId: "corp-1", handle: "acme_kf", connector: "announcer", auth: { token: "t1" } });
});
afterAll(() => h.close());

describe("webhooks that only announce new items", () => {
  it("answers at once, then pulls the account so the messages land without waiting for the poll", async () => {
    conn.waiting.push("你好，请问外套什么时候到货？");
    const r = await deliver("new_messages");
    expect(r).toEqual({ accepted: true, items: 0, ack: { body: "", contentType: "text/plain" } });
    await m.webhooks.lastPull;
    const rows = await m.ctx.db.select().from(activities).where(eq(activities.network, "wecom"));
    expect(rows.map((x) => x.text)).toEqual(["你好，请问外套什么时候到货？"]);
    expect(conn.pulls).toBe(1);
  });

  it("collapses a burst of announcements into one follow-up pull, and ignores other events", async () => {
    let open!: () => void;
    conn.gate = new Promise((res) => (open = res));
    conn.waiting.push("first");
    await deliver("new_messages");
    const running = m.webhooks.lastPull;
    conn.waiting.push("second");
    await deliver("new_messages");
    await deliver("new_messages");
    await deliver("something_else");
    open();
    await running;
    expect(conn.pulls).toBe(3); // the first test's pull, the running one, and a single follow-up
    const texts = (await m.ctx.db.select().from(activities).where(eq(activities.network, "wecom"))).map((x) => x.text).sort();
    expect(texts).toEqual(["first", "second", "你好，请问外套什么时候到货？"].sort());
  });

  it("refuses an announcement that does not verify, and pulls nothing", async () => {
    const before = conn.pulls;
    await expect(m.webhooks.receive("announcer", { "x-token": "wrong" }, JSON.stringify({ event: "new_messages" }), { account: "corp-1" })).rejects.toMatchObject({ code: "forbidden" });
    await m.webhooks.lastPull;
    expect(conn.pulls).toBe(before);
  });
});
