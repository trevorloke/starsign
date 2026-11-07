# Building alongside other builders (read before editing shared files)

Several builders work in this checkout at the same time. Rules:

- Never run git, `pnpm install`, or switch branches. Never rewrite a whole shared file with Write.
- Shared files you may need: `apps/web/src/App.tsx`, `apps/web/src/api.ts`, `apps/web/src/types.ts`,
  `apps/web/src/dev/fixtures.ts`, `apps/web/src/styles.css`, `apps/api/src/app.ts`, `packages/core/src/starsign.ts`,
  `packages/core/src/index.ts`, `packages/db/src/schema.ts`, `packages/schema/src/events.ts`, `docs/API.md`.
  For these: Read the file right before each change, make small targeted Edit calls, and put your code in a clearly
  separated block with a comment naming your feature (e.g. `// ---- inbox workflow`). If an Edit fails because the
  file changed, Read again and retry. Prefer new files of your own (a new service, a new route module, a new drawer,
  a new fixtures module imported from fixtures.ts) over growing shared ones.
- Migrations are numbered per builder (use only yours): analytics/reports `0010_*`, inbox workflow `0011_*`,
  AI answer visibility `0012_*`. Large uploads need no migration.
- New ledger event types go at the end of the list in `packages/schema/src/events.ts`, in your own commented block.
- API routes: add them in your own file `apps/api/src/routes-<feature>.ts` exporting `register<Feature>Routes(app, m, opts)`,
  and register it with one line in `apps/api/src/app.ts` next to the others.
- Gates before you finish: `pnpm -s typecheck`, `pnpm -s --filter @starsign/web typecheck`,
  `pnpm --filter @starsign/web build`, and `pnpm vitest run` for your tests. If a failure is only in another
  builder's in-progress files, note it and move on.
- Follow the existing conventions: core services take `Principal` and check roles (viewers read only; agents never
  pass human role gates), every state change appends a ledger event, the web app uses the `pick(live, fixture)`
  pattern in `api.ts` with fixtures for every endpoint, copy is plain and short with no exclamation marks, inputs are
  labelled, buttons are `type="button"`, light and dark themes, no horizontal scroll at 390px.
