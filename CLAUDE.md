# Invoicer

Single-user, self-hosted Italian e-invoicing (FatturaPA) PWA on Cloudflare (Worker + D1 +
Cron), sending to the SdI through the owner's PEC mailbox (SMTP) and polling it (IMAP). Spec: docs/specs/invoicer.md. Plan and progress:
docs/plans/invoicer.md.

## Commands

Keep this list in sync with `package.json`. Requires Node 22+ and pnpm (see `packageManager`).

- Install: `pnpm install` (CI: `pnpm install --frozen-lockfile`); local secrets: `cp .dev.vars.example .dev.vars`
- Dev server: `pnpm dev` (Vite + local Worker, D1; PEC, Resend and push off or mocked)
- Build: `pnpm build`; preview the build (service worker on): `pnpm preview`
- All unit/integration tests (dot reporter): `pnpm test`
- One Vitest project: `pnpm vitest run --project shared|worker|client --reporter=dot`
- Single test file, failures only: `pnpm vitest run <path/to/file.test.ts> --reporter=dot`
- E2E: `pnpm test:e2e` (Playwright, builds and serves `vite preview`)
- Lint (Biome): `pnpm lint`; auto-fix and format: `pnpm format`
- Typecheck: `pnpm typecheck` (client, worker and node tsconfigs)
- Bundle check (Worker size, client-only libraries): `pnpm check:bundle` (after `pnpm build`)
- DB: `pnpm db:generate`, `pnpm db:migrate:local`, `pnpm db:migrate:remote`, `pnpm db:seed`
- Deploy: `pnpm run deploy` (`pnpm deploy` is a different built-in command); normally via GitHub Actions on push to `main`

## Folders

- `src/client/` — React SPA (`routes/`, `components/`, shadcn/ui in `components/ui/`, `lib/`, `i18n/`)
- `src/worker/` — Hono API (`app.ts`, `env.ts`, `security.ts`, `routes/`, `jobs/`); `spike/` (temporary step 2 risk spike, removed in step 20); `pec/` (IMAP client, PEC envelope parsing; later send and polling); later auth, push, email
- `src/shared/` — pure code used by both: errors (problem+json), CSP, formatting, invoice states; later totals, FatturaPA XML, channel
- `src/db/` — Drizzle schema and local seed; `migrations/` — D1 migrations
- `locales/{en,it}/` — i18n resources (UI, PDF, email)
- `public/` — static assets, icons, `_headers` (CSP for the SPA)
- `scripts/` — CI helpers (bundle check, wrangler config rendering)
- `assets/xsd/` — vendored official FatturaPA XSD (not yet added)
- `tests/` — Playwright E2E (`e2e/`), cross-cutting tests, PEC/IMAP fixtures live next to the code (`src/worker/pec/*fixtures.ts`)
- `docs/` — specs, plans, notes; `.github/workflows/` — CI and deploy

## Conventions

- Everything in the repo is in English; user-facing text only through i18n (`en` base, `it`).
- Money is integer cents in domain code; dates for numbering use Europe/Rome.
- Unit/integration tests live next to the code as `*.test.ts(x)`; Vitest projects: `shared` (node),
  `worker` (workerd via `@cloudflare/vitest-pool-workers`), `client` (jsdom).
- Errors: API failures are problem+json built with `ApiError` (`src/shared/errors.ts`); a missing
  secret names the variable and its `wrangler secret put` fix. Every error code has a README anchor.
- Routes are code-based TanStack Router in `src/client/router.tsx`; status label/colour/icon live
  only in `src/client/lib/status.ts`; use the base components in `components/ui/`.
- Security: the CSP in `src/shared/csp.ts` must equal `public/_headers` (tested); no inline script,
  `connect-src 'self'`; state-changing `/api/*` calls need a matching `Origin`.
- Secrets (`PEC_USERNAME`/`PEC_PASSWORD`, Resend key, VAPID key, setup token) are Worker
  secrets only: never in D1, tracked files or API responses. Owner-specific values (domain,
  sender, resource IDs) come from env or untracked config; `wrangler.jsonc` holds placeholders
  that CI fills (`scripts/render-wrangler-config.mjs`).
- Biome ignores Markdown; do not run it over `docs/`. Dependency versions are pinned exactly.
- The PEC password gives full mailbox access (one password for IMAP, SMTP, webmail); the IMAP client
  is read-only by design (EXAMINE, PEEK, no delete). Cron triggers: max 3 (`*/10 * * * *` polling,
  daily, weekly); Cloudflare day-of-week syntax is `SUN`, not `0`.
- Free-plan limits matter: 10 ms CPU per request; heavy work (XML/XSD, PDF, P7M) runs in the browser.
- No automated test talks to the real SdI; use recorded IMAP/SMTP fixtures and the fake socket (`src/worker/pec/fake-socket.ts`).
