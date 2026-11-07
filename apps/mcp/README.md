# @starsign/mcp

Starsign's MCP server: the front door for agents.

Starsign is the system of record for attention. It observes every surface a brand owns, forecasts where attention is going (the trend radar), acts through operators inside the brand's red lines, and proves what moved (the outcome ledger). This package lets Claude (Desktop, Code), ChatGPT and any other MCP client see the radar, the live feed, the ledger and the red lines, and **propose** posts that land in the brand's approval queue.

Everything goes through Starsign's HTTP API (`docs/API.md`). The server holds no state and makes no decisions of its own, so authentication, policy and the ledger stay centralized in the API.

## Trust model

- **Agents propose; humans approve.** `create_post` runs the brand's red lines and autonomy dial on the server and lands the post where the dial says: usually `pending_approval` (the approval queue), otherwise `draft` or `scheduled`. Humans approve, edit or reject in the Starsign app. The result of every call states plainly where the post landed.
- **Red lines are enforced by the server, on every post, from every actor.** A block is final: the API still returns the post with `status: "blocked"` and the violations, and records the attempt. `check_policy` is a dry run of the same rules, so agents can fix text before proposing.
- **Everything is in the ledger.** The API key carries the actor it acts as (an `mcp` actor), so every post, every policy decision and every schedule or cancel request is attributed to that agent. Posts created here carry the disclosure `{ aiAssisted, aiContributions: ["text_drafted"], humanReviewed: false, model: "mcp-client" }`; `humanReviewed` flips when a human approves in the app.
- **Deliberately not exposed:** approving or rejecting posts (`POST /v1/posts/:id/decide`), publishing immediately, editing the policy or red lines, connecting or removing social accounts, acknowledging alerts. Those are human decisions made in the app. An agent that wants more latitude asks a human to move the autonomy dial.

## Getting a key

1. Start the API: `pnpm dev:api` (in dev it uses embedded PGlite; nothing to configure).
2. Run `pnpm seed`. It creates the demo workspace and prints a dev API key (`star_...`). Keys are per workspace and carry an actor and role; mint agent keys as `mcp` actors so the autonomy dial applies to them.
3. Check the key: `curl -H "Authorization: Bearer star_..." http://localhost:4000/v1/me` should return the workspace, the actor and the role.

Environment variables read by this server:

| Variable | Default | Meaning |
| --- | --- | --- |
| `STARSIGN_API_URL` | `http://localhost:4000` | Base URL of the Starsign API |
| `STARSIGN_API_KEY` | (none) | Workspace API key. Required in stdio mode (without it requests go out unauthenticated, which only works against a dev API running with `STARSIGN_DEV_WORKSPACE`). Ignored in HTTP mode: every HTTP request must carry its own bearer. |
| `STARSIGN_MCP_PORT` | `4001` | Port for `--http` when none is given on the command line |

## Running

### stdio (one workspace per process)

Claude Desktop (`claude_desktop_config.json`) and Claude Code (`.mcp.json` at the repo root) take the same shape:

```json
{
  "mcpServers": {
    "starsign": {
      "command": "pnpm",
      "args": ["--filter", "@starsign/mcp", "start"],
      "env": {
        "STARSIGN_API_URL": "http://localhost:4000",
        "STARSIGN_API_KEY": "star_..."
      }
    }
  }
}
```

`pnpm --filter` must run inside this repository. Claude Code's `.mcp.json` runs from the project root, so the snippet works as is. Claude Desktop does not set a working directory: add `"--dir", "/absolute/path/to/starsign"` as the first two `args`.

Or from the command line in Claude Code:

```sh
claude mcp add starsign -e STARSIGN_API_URL=http://localhost:4000 -e STARSIGN_API_KEY=star_... -- pnpm --filter @starsign/mcp start
```

Logs go to stderr; stdout is the protocol.

### Streamable HTTP (many workspaces per process)

```sh
pnpm --filter @starsign/mcp start -- --http 4001
```

Serves MCP at `http://localhost:4001/mcp` (stateless Streamable HTTP, POST only) plus `GET /health`. The workspace key is read from each request's `Authorization: Bearer star_...` header, so the key identifies the workspace and one process can serve many of them. A request without a bearer gets `401`; there is deliberately no process-wide fallback key.

Client configuration:

```json
{
  "mcpServers": {
    "starsign": {
      "type": "http",
      "url": "http://localhost:4001/mcp",
      "headers": { "Authorization": "Bearer star_..." }
    }
  }
}
```

```sh
claude mcp add --transport http starsign http://localhost:4001/mcp --header "Authorization: Bearer star_..."
```

Put TLS and a reverse proxy in front before exposing it beyond localhost; the server itself only checks that a bearer is present and forwards it to the API, which authenticates it.

## Tools

Call `get_brand_context` first; it is the only way to get account ids and the brand's voice, and it tells the agent how much autonomy it has.

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_brand_context` | read | Brand profile, autonomy and red lines in plain language, connected accounts (ids for `create_post`), voice examples (before → after human edits), recent top posts, active topics. Call first. |
| `get_radar` | read | The trend radar: topic, stage, confidence (%), hours to peak, acting window, times acted on; raw JSON second. |
| `get_topic` | read | One topic: forecast with band, per-source series, past actions with 24h outcomes. |
| `search_feed` | read | Live inbound activity across networks; filter by text, networks, kinds, stream, last N hours. |
| `get_queue` | read | What is waiting on a human in the approval queue. |
| `get_post` | read | One post with variants, approvals, policy decision and full ledger history. |
| `list_posts` | read | Posts newest first, filtered by status. |
| `get_metrics_summary` | read | Outcomes for the last N days (default 7): totals, by network / stage / hour / author / experiment, top posts with lift. |
| `get_lift_by_stage` | read | Avg engagements and lift by the trend stage posts were created in (default 30 days). |
| `check_policy` | read | Dry run of red lines and autonomy on draft text per network. Use before `create_post`. Nothing stored. |
| `create_post` | write | Propose a post (one idea, one variant per account). Server decides: approval queue, draft, scheduled, or blocked with violations. |
| `schedule_post` | write | Ask to schedule an existing post at a time; autonomy decides whether it waits for a human. |
| `cancel_post` | write (destructive) | Cancel an unpublished post. |
| `get_latest_brief` | read | The most recent operator brief (Markdown). |
| `list_alerts` | read | Operator alerts, unacknowledged only by default. |
| `get_policy` | read | The full active policy document: autonomy, every red line with parameters, caps, disclosure. |
| `get_ledger` | read | Query the append-only ledger by event type and subject. |
| `list_inbox` | read | The team inbox: conversations with status, owner, priority, labels and time left to a first reply (or how late); filter by status, assignee, label, priority, network, text. |
| `update_inbox_item` | write | Set a conversation's status, add or remove workspace labels, and leave an internal note (`@name` notifies a teammate). Assigning people, priority and rules stay with people. |

Every tool returns `content` with a readable summary first and the raw JSON second. Failures come back as results with `isError: true` and the API's `code` and `message` (and `details` when present); the server never surfaces raw exceptions. Input is validated against zod schemas before any request is made.

## Development

```sh
pnpm vitest run apps/mcp              # tests; fetch is mocked, nothing touches the network
pnpm tsc -p tsconfig.json --noEmit    # typecheck (whole repo)
pnpm --filter @starsign/mcp dev       # run over stdio
```

Layout:

- `src/client.ts`: `StarsignClient`, a typed `fetch` wrapper for every endpoint the tools use, plus `StarsignApiError` carrying the API's `{ code, message, details }` and HTTP status.
- `src/types.ts`: response shapes from `docs/API.md` (reusing `@starsign/schema` where it has them).
- `src/format.ts`: the readable summaries.
- `src/tools.ts`: input schemas, handlers and `registerTools(server, client)`.
- `src/server.ts`: `createServer(client)` with the server instructions.
- `src/main.ts`: stdio by default, `--http [port]` for Streamable HTTP.
