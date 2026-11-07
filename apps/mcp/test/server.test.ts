import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StarsignClient } from "../src/client.ts";
import { INSTRUCTIONS, SERVER_NAME, SERVER_VERSION, createServer } from "../src/server.ts";
import { TOOL_NAMES } from "../src/tools.ts";
import { NOW, fakeApi, pendingDetail, radar, textOf } from "./helpers.ts";

const WRITE_TOOLS = new Set(["create_post", "schedule_post", "cancel_post", "create_experiment", "create_link", "track_entity", /* inbox workflow */ "update_inbox_item"]);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function connect(api: ReturnType<typeof fakeApi>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(new StarsignClient({ baseUrl: "http://api.test", apiKey: "star_t", fetch: api.fetch }), { now: () => NOW });
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  cleanup = async () => {
    await client.close();
    await server.close();
  };
  return client;
}

describe("starsign MCP server", () => {
  it("identifies itself and carries instructions that say to call get_brand_context first", async () => {
    const client = await connect(fakeApi([]));
    expect(client.getServerVersion()).toMatchObject({ name: SERVER_NAME, version: SERVER_VERSION });
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS).toContain("get_brand_context first");
    expect(INSTRUCTIONS).toContain("approval queue");
    expect(INSTRUCTIONS).toContain("Red lines are enforced server-side");
  });

  it("lists exactly the documented tools, with read-only annotations on everything but the write tools", async () => {
    const client = await connect(fakeApi([]));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(!WRITE_TOOLS.has(tool.name));
    }
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("cancel_post")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("create_post")?.annotations?.destructiveHint).toBe(false);
    expect(byName.get("get_brand_context")?.description).toMatch(/Call this FIRST/);
    expect(byName.get("check_policy")?.description).toMatch(/before create_post/);
    expect(byName.get("create_post")?.inputSchema.required).toEqual(expect.arrayContaining(["body", "variants"]));
    expect(byName.get("create_post")?.inputSchema.required).not.toContain("aiAssisted");
    expect(byName.get("get_brand_context")?.inputSchema).toMatchObject({ type: "object" });
    expect(byName.get("search_feed")?.inputSchema.properties).toHaveProperty("sinceHours");
  });

  it("calls get_radar end to end: summary text first, raw JSON second", async () => {
    const api = fakeApi([{ path: "/v1/trends/radar", body: radar }]);
    const client = await connect(api);
    const result = await client.callTool({ name: "get_radar", arguments: {} });
    expect(result.isError).toBeFalsy();
    const content = result.content as unknown[];
    expect(content).toHaveLength(2);
    expect(textOf({ content })).toMatch(/Vancouver snow day\s+top_1\s+rising\s+72%/);
    expect(JSON.parse(textOf({ content }, 1))).toEqual(radar);
    expect(api.last().headers.authorization).toBe("Bearer star_t");
  });

  it("calls create_post end to end, applying schema defaults and the disclosure", async () => {
    const api = fakeApi([{ method: "POST", path: "/v1/posts", status: 201, body: pendingDetail }]);
    const client = await connect(api);
    const result = await client.callTool({
      name: "create_post",
      arguments: { body: "Snow day", variants: [{ socialAccountId: "acc_x", text: "Snow day in Vancouver." }] },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf({ content: result.content as unknown[] })).toContain("landed in the approval queue");
    expect(api.last().body).toMatchObject({
      actionClass: "new_post",
      disclosure: { aiAssisted: true, aiContributions: ["text_drafted"], humanReviewed: false, model: "mcp-client" },
    });
  });

  it("rejects bad arguments and surfaces API errors as isError results, never protocol errors", async () => {
    const api = fakeApi([{ path: "/v1/context", status: 401, body: { error: { code: "unauthorized", message: "unknown api key" } } }]);
    const client = await connect(api);

    const invalid = await client.callTool({ name: "get_topic", arguments: {} });
    expect(invalid.isError).toBe(true);
    expect(textOf({ content: invalid.content as unknown[] })).toMatch(/topicId/);

    const unauthorized = await client.callTool({ name: "get_brand_context", arguments: {} });
    expect(unauthorized.isError).toBe(true);
    expect(textOf({ content: unauthorized.content as unknown[] })).toContain("401 (unauthorized)");
    expect(textOf({ content: unauthorized.content as unknown[] })).toContain("unknown api key");
  });
});

describe("new tools", () => {
  it("formats the calendar and an experiment readout", async () => {
    const client = await connect(
      fakeApi([
        { method: "GET", path: "/v1/calendar", body: [{ post: { id: "pst_1", status: "scheduled", scheduledAt: "2026-11-03T16:00:00.000Z", publishedAt: null, body: "Trail report", experimentArm: "named" }, variants: [{ network: "x" }, { network: "bluesky" }] }] },
        { method: "GET", path: "/v1/experiments/exp_1", body: { experiment: { id: "exp_1", name: "Hook", hypothesis: "Naming the trail wins", status: "running", arms: [], primaryMetric: "engagements@24h" }, readout: { verdict: "not_enough_data", summary: "Not enough measured posts yet.", arms: [{ key: "named", posts: 2, measured: 1, mean: 40 }] } } },
      ]),
    );
    const cal = await client.callTool({ name: "get_calendar", arguments: { days: 7 } });
    expect((cal.content as { text: string }[])[0]!.text).toMatch(/2026-11-03 16:00Z · scheduled · x\+bluesky · arm named · "Trail report" · pst_1/);
    const exp = await client.callTool({ name: "get_experiment", arguments: { experimentId: "exp_1" } });
    expect((exp.content as { text: string }[])[0]!.text).toMatch(/Verdict: not_enough_data[\s\S]*named: 1\/2 measured, mean 40\.0/);
  });

  it("reports what posts drove from owned link data", async () => {
    const client = await connect(
      fakeApi([
        {
          method: "GET",
          path: "/v1/links/report",
          body: {
            configured: true,
            totals: { clicks: 40, uniqueVisitors: 31, previews: 12, conversions: 3, attributedConversions: 2, conversionValue: 147, valueByCurrency: [{ currency: "USD", value: 147 }] },
            byNetwork: [{ network: "linkedin", clicks: 30, uniqueVisitors: 24, conversions: 2, value: 98 }],
            topLinks: [{ slug: "Ab3dE9x", shortUrl: "https://go.acme.test/Ab3dE9x", destination: "https://acme.test/sale", network: "linkedin", postId: "pst_9", uniqueVisitors: 24, conversions: 2, conversionValue: 98, clicksInRange: 30 }],
          },
        },
      ]),
    );
    const r = await client.callTool({ name: "get_link_report", arguments: { days: 7 } });
    const text = (r.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/Last 7 days: 31 people clicked \(40 clicks; 12 link-preview fetches not counted\)\. 3 conversions \(2 traced to a post\), worth 147\.00 USD/);
    expect(text).toMatch(/linkedin: 24 people, 2 conversions/);
    expect(text).toMatch(/go\.acme\.test\/Ab3dE9x → https:\/\/acme\.test\/sale: 30 clicks, 2 conversions \(post pst_9\)/);
  });
});
