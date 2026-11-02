# Invoicer

Single-user, self-hosted Italian e-invoicing (FatturaPA) PWA on Cloudflare (Worker + D1 + R2 +
Cron), sending through the Openapi SDI API. Spec: docs/specs/invoicer.md. Plan and progress:
docs/plans/invoicer.md.

## Commands

Commands are created in plan step 1 (scaffolding); keep this list in sync with `package.json`.

- Install: `pnpm install` (CI: `pnpm install --frozen-lockfile`)
- Dev server: `pnpm dev` (Vite + local Worker, D1 and R2; Openapi, Resend and push mocked)
- Build: `pnpm build`
- All unit/integration tests: `pnpm test`
- Single test file, failures only: `pnpm vitest run <path/to/file.test.ts> --reporter=dot`
- E2E: `pnpm test:e2e`
- Lint / format: `pnpm lint` (Biome)
- Typecheck: `pnpm typecheck`
- DB: `pnpm db:generate`, `pnpm db:migrate:local`, `pnpm db:migrate:remote`, `pnpm db:seed`
- Deploy: `pnpm deploy` (normally via GitHub Actions on push to `main`)

## Folders

- `src/client/` — React SPA (routes, components, shadcn/ui in `components/ui/`, PDF, i18n setup)
- `src/worker/` — Hono API, auth, send authorization, Openapi calls, webhooks, cron jobs, push, email
- `src/shared/` — pure domain code used by both: totals, FatturaPA XML, channel interface, fixtures
- `src/db/` — Drizzle schema; `migrations/` — D1 migrations
- `locales/{en,it}/` — i18n resources (UI, PDF, email)
- `assets/xsd/` — vendored official FatturaPA XSD
- `tests/` — Playwright E2E and recorded Openapi fixtures
- `docs/` — specs, plans, notes

## Conventions

- Everything in the repo is in English; user-facing text only through i18n (`en` base, `it`).
- Money is integer cents in domain code; dates for numbering use Europe/Rome.
- Unit/integration tests live next to the code as `*.test.ts`.
- Secrets (Openapi tokens, Resend key, VAPID key, webhook secret, setup token) are Worker
  secrets only: never in D1, tracked files or API responses. Owner-specific values (domain,
  sender, resource IDs) come from env or untracked config.
- Free-plan limits matter: 10 ms CPU per request; heavy work (XML/XSD, PDF, P7M) runs in the browser.
- No automated test talks to the real SdI; use the Openapi sandbox or recorded fixtures.
