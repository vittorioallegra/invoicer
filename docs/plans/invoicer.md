# Invoicer — implementation plan

Goal and behaviour: see the spec (docs/specs/invoicer.md). This plan says how to build it.

## Implementation steps

Each step is one unit of work for one implementing agent, ends with green tests for what it
touched and one or more atomic commits, and ticks its line in Progress. Steps run in order.
Fixture letters (a)–(g) refer to acceptance criterion 6 of the spec.

Every UI step: screens are checked at 375 px and on desktop as part of the step (not only in
the hardening step), use the shared base components and status map from step 1, and define
their loading, empty and error states. Every step lists in its commit summary the exact
commands it ran green (e.g. `pnpm vitest run --project shared <file> --reporter=dot`).

### Milestone A — can issue real invoices

Steps 1–13 are the shortest path to a real invoice sent through the production Openapi
account (spec AC 21). Nothing from Milestone B blocks it. No calendar dates: before FiC's
renewal the owner decides, based on Milestone A, whether to cut over or renew FiC.

1. **Scaffolding.** `package.json` (pnpm, lockfile committed, CI uses
   `pnpm install --frozen-lockfile`), TypeScript strict, Vite 8 + `@cloudflare/vite-plugin`,
   React 19, TanStack Router + Query, Tailwind 4, Hono Worker serving the SPA as static assets
   and `/api/*`, `wrangler.jsonc` with D1, a cron trigger and documented secret names
   (no values; owner-specific values such as domain, sender address and resource IDs come
   from env / an untracked local config, never from tracked files), Vitest projects (`shared`
   in node, `worker` in `@cloudflare/vitest-pool-workers`, `client` in jsdom), Playwright
   config, Biome (exact version pinned) for lint/format, i18next + react-i18next with `en`
   (base) and `it` locale files, `vite-plugin-pwa` manifest and service worker shell
   (disabled in `dev`; tested in preview/E2E only).
   - Scripts: `dev`, `build`, `test`, `test:e2e`, `lint`, `typecheck`, `db:generate`,
     `db:migrate:local`, `db:migrate:remote`, `db:seed` (local demo data), `deploy`.
   - `.dev.vars.example` listing every secret/binding; local dev and `pnpm test` need no
     external account (Openapi, Resend and push are off or mocked by default).
   - API error contract: Hono `onError` returns problem+json with a stable `code` and a
     README anchor; typed client error in `src/shared`. Env validation per route group: a
     missing secret names the variable and the `wrangler secret put <NAME>` fix, never a
     value; optional features (email, push) degrade to "off" with a settings banner.
   - UI foundation: design tokens (colour, spacing, type scale, dark mode), base components
     built with shadcn/ui (components copied into `src/client/components/ui/`, Radix
     primitives underneath) and Tailwind
     (Button, Field, MoneyInput, StatusBadge, Banner, EmptyState, Sheet), a state →
     label/colour/icon table for draft/planned/sending/sent/delivered/not_delivered/rejected/
     rejected_expired and paid/unpaid/overdue (colour never the only signal), money and date formatting by UI
     locale via `Intl`.
   - App shell: route map; iPhone bottom tab bar (Home, Issued, Received, Clients, Settings)
     with a "New invoice" action, Mac sidebar; iOS standalone-PWA safe areas; offline banner
     (lists readable from the Query cache, send/import/settings disabled with a reason).
   - GitHub Actions deploy workflow: install, lint, typecheck, test, bundle check (Worker
     under 3 MB compressed; `@react-pdf/renderer`, `xmllint-wasm` and pkijs only in the client
     bundle), then `wrangler d1 migrations apply --remote`, then `wrangler deploy`
     (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and the D1 ID as repository
     secrets/vars that generate the deploy config).
   - Security baseline: strict CSP (no inline script; `connect-src` self only: the browser
     never calls Openapi), Origin check on state-changing `/api/*` calls, parsed external data rendered as
     text only, stored originals served with `Content-Disposition: attachment` and
     `X-Content-Type-Options: nosniff`.
   - One `scheduled` handler dispatching on `event.cron`, at most 2 cron triggers (the free
     plan allows 5 per account).
   - README skeleton (deploy section grown by every later step). Create `CLAUDE.md` with the
     commands, including the single-test failures-only command.
   - Tests: health route, one i18n render, problem+json shape, missing-secret error.
2. **Risk spike.** A hidden `/spike` page and routes, gated by a spike secret header (no auth
   exists yet), that check on real devices: a passkey assertion created on iPhone Safari and
   Mac Safari (same iCloud passkey) verifies in the Worker against a bound challenge; Web Push
   delivery with the app closed (iPhone Home screen PWA, Mac); CPU time per request, with a
   pass threshold below the 10 ms free-plan limit, for PBKDF2 password hashing at the reduced
   iteration count, a passkey assertion verification, an Openapi POST from the Worker, Web Push
   payload encryption (`@pushforge/builder`), a sample callback and the cron handlers
   (reconciliation, data export, subrequest count under the free-plan cap); one send + simulated
   receipt + simulated supplier invoice on the Openapi sandbox. Also record, from docs or the
   sandbox: exact Openapi scope strings for the read and send tokens, callback retry and
   signing behaviour, minimum top-up, `/simulate` behaviour, current codice destinatario,
   D1 Time Travel retention on the free plan, the FatturaPA schema version in force, and
   whether a non-EUR invoice needs an EUR equivalent (precondition for step 10, fixture d),
   whether Openapi keeps our XML file name or renames it and whose fiscal ID goes in
   `IT<id>`, and whether callbacks/list responses carry parsed fields of received P7M
   invoices. For each CPU check that fails, the named fallback (browser-side work,
   `waitUntil`) is chosen. Password hashing uses the highest PBKDF2 iteration count that fits
   the limit (decided: reduced count, compensated by mandatory TOTP, a login rate limit and a
   generated password, documented); moving to Workers Paid needs explicit owner approval. Results go to `docs/notes/spike.md`. **Manual checkpoint:** the owner
   deploys (README skeleton) and runs the device checks; the plan is revised if a check
   fails. Remove the spike page in step 20.
3. **Data model.** Drizzle schema + first D1 migration: `profile`, `settings`, `clients`,
   `invoices` (TD01/TD04, state including `sending` and `rejected_expired`, state rank,
   payment flag, `number_raw` + parsed `number_int`, year, issue date, source
   `app`/`imported`; partial UNIQUE index on year + `number_int` where not null, covering app
   and imported invoices), `transmissions` (one row per attempt: file progressive, file
   name, send-outcome `none`/`complete`/`unknown`, Openapi uuid, PDF/XML `files` ids, created
   before the POST), `number_sequences` (one counter row per year) and `file_sequence`
   (global file progressive counter), `invoice_lines`, `received_invoices` (unique on
   Openapi uuid, `parse_status`, original file as a `files` id), `files` (id, kind
   `xml`/`pdf`/`received`/`import`/`backup`, invoice / transmission or received-invoice
   reference, filename, content type, size, sha256, `content` BLOB, created_at; CHECK size
   <= 2 MB, larger files are refused with a clear error; all file access goes through one
   storage interface so R2 can be reintroduced later), `events` (callbacks, unique on source id, `processed_at`),
   `outbox` (email/push/notification side effects, UNIQUE on invoice + attempt + kind),
   `notifications`, `push_subscriptions`, `recurring_templates`, `recurring_occurrences`
   (unique on template + date), `email_log`, `job_runs` (job, started/finished, status,
   counts, error code), `send_challenges` (single-use WebAuthn challenges bound to an
   invoice and the hash of its final XML, short TTL). Tests: migration applies on a clean local D1; unique constraints hold.
4. **Auth.** Better Auth 1.7 on D1 via Drizzle: passkey plugin (login), twoFactor plugin
   (TOTP + recovery codes) for the email + password fallback, PBKDF2 (Web Crypto) password
   hashing per the step 2 decision, login rate limit, first-run owner creation only with the
   `SETUP_TOKEN` Worker secret (the deploy is public before onboarding) and sign-up closed in
   the same transaction, session middleware on `/api/*` except the webhook. Login and setup screens.
   Tests: AC 2, 3; first run without `SETUP_TOKEN` refused.
5. **Send authorization.** Both Openapi tokens are Worker secrets (`OPENAPI_READ_TOKEN`,
   `OPENAPI_SEND_TOKEN`), set with `wrangler secret put`, never stored in D1, never returned
   to the browser; Settings shows only whether each is configured. `src/worker/auth/send-
   authorization`: `POST /api/invoices/:id/send-challenge` issues a single-use challenge
   bound to the invoice id and the SHA-256 of its final XML (short TTL); the browser answers
   with a passkey assertion (fallback: a fresh TOTP code); the Worker verifies it against the
   owner's registered passkeys (`@simplewebauthn/server`, user verification required) before
   any Openapi call. Tests: valid assertion accepted once; replayed, expired, wrong-invoice
   and wrong-XML-hash assertions refused; TOTP fallback; tokens never present in any API
   response or log (AC 4 part).
6. **Totals engine.** `src/shared/totals` working in integer cents: lines, VAT per rate,
   natura with legal texts, cassa/rivalsa in `excluded` and `included` modes, ritenuta, bollo
   rule, rounding to the cent, TD04 sign. Money parsing shared with `MoneyInput`: accepts
   `1040,00`, `1.040,00` and `1,040.00`. Fixtures live in `src/shared/fixtures/`. Tests:
   fixtures (a)–(g) totals to the cent, including 1,040.00 and 999.99; money parsing cases.
7. **Profile, onboarding, settings.** Issuer profile (RF list), payment defaults, next
   invoice number for the current year, AdE guide screen, email settings (sender name/address,
   Reply-To, BCC, mode), language. Setup checklist on Home (passkey, fallback login,
   profile, Openapi setup, AdE guide, email): each item done/pending, persisted
   server-side, resumable; "Send" is blocked with a stated reason until profile and Openapi
   setup are done. First-run empty Home with a call to action.
8. **Clients.** CRUD with type rules (codice destinatario defaults, required fields,
   P.IVA / codice fiscale format), empty state, inline client creation from the invoice
   editor. Tests: type rules. (FiC CSV import is step 14.)
9. **Invoice editor.** TD01 and TD04 (linked or not) editor using the totals engine:
   drafts, planned date, duplicate, payment flag, minimal "To issue" and "Issued" lists (full
   dashboard in step 15). Layout: lines as stacked cards at 375 px and a table on desktop;
   sticky totals footer with amount due and an expandable breakdown; cassa mode chip next to
   the totals; bollo as a dismissible suggestion. Live inline validation with zod rules that
   mirror the XSD and client-type rules (codice destinatario, natura needs a legal text,
   P.IVA format). Operation date field and an issuance-term warning: an immediate invoice
   issued more than 12 days after the operation date, or a deferred invoice issued after the
   15th of the month following the operation (art. 21 DPR 633/72), shows a non-blocking
   warning. Invoices are read-only from `sending` on, except: `rejected` is editable
   with number and date locked (spec 3, 5-day window, deadline banner, SdI error text next to
   the matching field); after the 5-day window it becomes `rejected_expired`, whose action
   "Reissue as new invoice" creates a new number and date and references the rejected
   document (the old number stays recorded, never reused). Numbering in the Worker, one
   guarded D1 batch whose first statement fails on a constraint when the invoice is not in
   draft/planned/retryable state (a 0-row UPDATE does not roll a batch back): next number =
   max(configured next, highest app number + 1, highest imported number + 1) computed in SQL;
   year and issue date = today in Europe/Rome (the Worker runs in UTC), asserted not earlier
   than the date of the highest number already issued that year; allocate the file
   progressive; set `sending`. A numbered invoice can never be deleted or returned to draft:
   its number can be released only if it is still the highest of its year (sequence rolled
   back), otherwise it must be sent; Home lists such invoices as "number reserved, not
   sent". Tests: AC 11 (incl. two devices reserving the same invoice, concurrent sends,
   imported numbers, configured next below the highest imported), guard failure leaves the
   sequence unchanged, Europe/Rome year boundary, date monotonicity, delete/revert of a
   numbered invoice refused, release rule, rejected and rejected_expired rules.
10. **FatturaPA XML.** `src/shared/fatturapa`: builder (fast-xml-parser) for FPR12, file name
    `IT<id>_<progressive>.xml` with a new progressive per transmission attempt (a resend after
    rejection keeps number and date but not the file name), parser for received XML; XSD
    validation with `xmllint-wasm` (official XSD vendored in `assets/xsd/`, version recorded
    in `CLAUDE.md`) in the browser before send and in tests; plain-language mapping of
    validation errors to fields, unmapped errors under a "technical details" disclosure. EUR
    equivalent for non-EUR invoices per the step 2 finding. Tests: AC 6 for fixtures (a)–(g).
11. **PDF.** `@react-pdf/renderer` document in IT/EN from the same i18n files, all reader-
    relevant FatturaPA data and the legal note; "SANDBOX" watermark in sandbox mode.
    Generated in the browser after the number is reserved and stored in `files` per
    invoice and transmission attempt (regenerated on resend; the email always uses the
    latest). Tests: AC 13 (language and payment data present, via text extraction).
12. **Openapi channel and send flow.** `src/shared/channel` interface; Openapi implementation
    in the Worker (`POST /invoices` with `OPENAPI_SEND_TOKEN`), setup wizard (exact scope
    list for the two tokens and where to create them in the Openapi console; business
    registry configuration and callback registration with the webhook secret header, done by
    the Worker with a one-time admin token pasted in the wizard and used for that single
    request, never stored), sandbox switch (persistent "SANDBOX" bar on every screen;
    switching to production needs an explicit confirm screen).
    Send flow, in order: review screen → XSD validation with the provisional next number →
    Worker reserves the number and sets `sending` (step 9) → browser builds the final XML +
    PDF and uploads them → the final XML is XSD-validated again (a failure releases or keeps
    the number per step 9 and is a definite refusal) → send challenge bound to the final XML
    hash → passkey check (AC 5: cancelling before this point leaves the invoice unsent; the
    reserved number follows the release rule of step 9) → Worker verifies the assertion and
    POSTs to Openapi → stores the Openapi uuid → `sent`. The file name is stored in D1 on the
    transmission row before the POST. An invoice in `sending` with an unknown outcome
    (Worker timeout, Openapi 5xx) is reconciled with the read token (lookup by file name, or
    our own idempotency field if Openapi renames files) before any retry; "not found" unlocks a retry only after a quiet period (at least
    15 minutes after the reserve), and every retry uses a new file progressive. An Openapi
    error before the SdI (nothing transmitted) is retried with the same number and date and
    no deadline; an SdI NS follows the rejected rules of step 9. Openapi
    errors map to plain-language messages with a fix (top up credit, missing scope <name>,
    configuration suspended → Reactivate); `Authorization` headers and token strings are
    stripped from anything reported to the Worker or logged. Invoice detail page: state,
    SdI errors, PDF/XML download, payment flag, credit note, duplicate, with the primary
    action following the state (Send / Fix & resend / Mark paid). Tests: AC 5, AC 7 against
    recorded sandbox responses in `tests/fixtures/openapi/` (also served by a mock channel in
    `dev`); "POST ok, Worker fails before storing the uuid"; "Openapi 4xx after reserve";
    send refused without a valid assertion; "timeout after reserve";
    final-XML XSD failure after reserve; "not found" within the quiet period does not unlock
    a retry; rejected → fix → resend with same number/date and new file name; Openapi error
    vs SdI NS; one live sandbox test
    behind `OPENAPI_SANDBOX_LIVE=1`.
13. **Webhook and reconciliation.** `/api/webhooks/openapi` with secret header check (AC 8);
    constant-time secret comparison and a body size cap; the event row, its state transition
    and its side effects (outbox rows) commit in one D1 batch (dedupe only on processed
    events); transitions are guarded UPDATEs on the state rank, so replays and stale
    reconciliation results never move an invoice backwards; 2xx only after commit, 5xx on
    failure so Openapi retries; state transitions RC/MC/NS/error; callbacks for an invoice
    still in `sending` match by file name and move it forward; outbox processed in
    `waitUntil` and retried from cron; supplier invoices stored with their original file in
    `files`, with parsed fields from the callback if present, else `parse_status = pending` and
    parsed by the browser on next open (viewing in step 14); unmatched events stored and
    listed, never dropped. Daily reconciliation cron with the
    read token (AC 9), also resolving `sending` invoices with an unknown outcome; each run
    writes a `job_runs` row and a failure raises a notification. "Download all data" (JSON
    export of every table) in Settings, so Milestone A does not rely only on D1 Time Travel.
    Tests: AC 8, AC 9, "transition fails, retry ends in the correct state", out-of-order and
    stale transitions, replay creates no second outbox row, callback while `sending`.
    **Milestone A exit:** the owner sets the next number from FiC, sends one real invoice
    through the production Openapi account, records it (AC 21), and the cutover runbook
    (README, written in this step) is followed.

### Milestone B — complete v1

14. **Received invoices and imports.** Received invoice list and readable view (supplier,
    date, number, lines, totals, payment data, download of the original); P7M extraction
    (pkijs + asn1js); manual import of XML/P7M/ZIP (fflate) for received and historic issued
    invoices (stored `delivered`, read-only, "Imported" badge, numbers blocking reuse); FiC
    clients CSV import with preview and per-row errors (papaparse). Import result screen
    ("N imported, M skipped" with per-row/per-file reasons and duplicate-number conflicts),
    progress state for slow files. Tests: AC 10, AC 17.
15. **Lists and dashboard.** To issue / Issued / Received, top strip counts, yearly and
    monthly totals (TD04 subtracted), filters, search, mark paid, overdue derivation,
    skeleton loading, empty and no-result states.
16. **Courtesy email.** Resend from the Worker, driven by the outbox (exactly one email per
    invoice + attempt, Resend `Idempotency-Key`), with i18n subject/body templates, latest PDF +
    XML attached from `files`, From/Reply-To/BCC from settings; modes automatic (on delivered /
    not_delivered), ask (in-app card on the invoice and in the notification list opening an
    editable preview sheet with Send / Skip), manual resend; `email_log` shown as a timeline
    on the invoice detail; failure notification. Tests: AC 14 with Resend mocked.
17. **Push and notifications.** Web Push subscriptions and sender (`@pushforge/builder`,
    VAPID secret), service worker handler, deep link from a push to its invoice, per-type
    toggles, in-app notification list. Tests: AC 15 (push parts with mocks).
18. **Cron jobs, recurring, credit.** Daily cron: planned due, overdue unpaid, recurring
    drafts exactly once (AC 12), suspension check, each run in `job_runs` with the last run
    shown in Settings; recurring templates UI with empty state; credit section with an
    estimated balance (top-ups entered by the owner minus counted operations at a configurable
    unit price; the Openapi account credentials are never stored), a link to the Openapi
    console for the exact figure, threshold banner and push, suspension detection with a
    Reactivate action using the read token (AC 16). Tests: AC 12,
    15 (cron parts), 16.
19. **Backup.** Settings "Download backup" (reusing the step 13 export, JSON/ZIP including
    the `files` content) plus a monthly cron reminder notification to download it; restore
    procedure documented in the README next to D1 Time Travel. Test: export contains every
    table.
20. **Hardening and release.** Remove the spike page and drop its throwaway `spike_kv` D1 table (`DROP TABLE spike_kv`, created at runtime, no migration); responsive and accessibility pass at
    375 px; secrets audit test (AC 4 full, including browser-side error reports); README
    deploy guide (Cloudflare resources, secrets, GitHub auto-deploy, subdomain, Resend DNS
    SPF/DKIM/DMARC, Openapi and AdE setup, free-plan limits and the Workers Paid switch, owner
    hardening checklist, troubleshooting per error code) (AC 1, 19) with a timed fresh-account
    run; a check that the vendored XSD version still matches the AdE site; Playwright E2E for
    the two flows in the Testing Plan plus rejected → resend; update `CLAUDE.md`.

### Cutover runbook (README, written in step 13)
1. Import the FiC history (or at least set the next number for the year from FiC).
2. Stop issuing in FiC; never issue in both tools in the same period.
3. First real send through Invoicer (AC 21).
4. Switch the codice destinatario on the AdE portal to Openapi's only once received
   invoices are stored (step 13); rollback = switch it back to FiC's code while FiC is active.
5. Keep FiC until 2026-12-31 as the fallback.

### Risks
- December deadline → Milestone A first; FiC renewal stays the fallback.
- Send token on the server: Cloudflare secrets are write-only in the dashboard, but whoever
  can deploy code (Cloudflare or GitHub account) can use it → second factor on Cloudflare,
  GitHub and Openapi, minimum token scopes, token rotation, low Openapi credit; every send
  needs a passkey assertion verified by the Worker. A client-side vault was rejected: it
  protects only against a D1 leak, not against a compromised deploy, at 1–1.5 days of cost.
- Free-plan CPU limit (10 ms) → per-operation thresholds and fallbacks from step 2 (browser,
  `waitUntil`); Workers Paid (5 $/month) only with owner approval.
- Send interrupted after Openapi accepted it → `sending` state, IndexedDB pending report,
  reconciliation by file name before any retry (no duplicate transmission, no number gap).
- Webhook processed partially → event, transition and outbox in one batch, 5xx on failure.
- Number gaps or date-order breaks → guarded reserve batch, Europe/Rome dates, numbered
  invoices never deleted, release only of the highest number.
- Public deploy before onboarding → owner creation needs `SETUP_TOKEN`.
- XSS triggering actions as the owner → strict CSP, Origin checks, text-only rendering of
  external data; sends still need a fresh passkey assertion.
- Better Auth passkey plugin changes (fast release cadence) → pin exact versions.
- iOS Web Push reliability → in-app list and email-to-self stay as backups.
- FatturaPA schema/spec drift → XSD vendored with its version recorded; version check in
  step 20 and before each tax season.
- Openapi callback retries unknown → daily reconciliation covers missed callbacks.
- Data loss on D1 → Time Travel plus the downloadable backup and its monthly reminder (step 19).

## Architecture

**Shape:** one TypeScript repo, one Cloudflare Worker that serves the SPA (static assets) and
the API. The browser does the CPU-heavy work (XML, XSD validation, PDF, P7M); the Worker
does auth, data, send authorization, all Openapi calls, webhooks, cron jobs, push and email.

**Folders**
- `src/client/` — React SPA: `routes/`, `components/` (incl. `ui/` from shadcn/ui), `pdf/`, `i18n/`.
- `src/worker/` — Hono app: `routes/`, `auth/`, `jobs/` (cron), `webhooks/`, `push/`, `email/`.
- `src/shared/` — pure domain code used by both: `totals/`, `fatturapa/`, `channel/`, `fixtures/`, errors, types, zod schemas.
- `src/db/` — Drizzle schema; `migrations/` — D1 migrations.
- `locales/{en,it}/` — i18n resources (UI, PDF, email).
- `assets/xsd/` — official FatturaPA XSD.
- `tests/` — Playwright E2E and `fixtures/openapi/` recorded responses; unit/integration tests live next to the code as `*.test.ts`.
- `docs/` — specs, plans, notes.

**Libraries (versions checked 2026-11-02)**

| Area | Choice | Version |
|------|--------|---------|
| Build / dev | Vite + `@cloudflare/vite-plugin` | 8.3 / 1.67 |
| UI | React + TanStack Router + TanStack Query, Tailwind, shadcn/ui (Radix) | 19.3 / 1.170 / 5.105, 4.3, latest at step 1 |
| Send authorization | `@simplewebauthn/server` / `@simplewebauthn/browser` | 14.0 |
| PWA | `vite-plugin-pwa` | 2.0 |
| API | Hono | 4.13 |
| DB | Drizzle ORM + drizzle-kit on D1 | 0.45 / 0.31 |
| Auth | Better Auth + passkey and twoFactor plugins | 1.7 |
| Validation | zod | 4.6 |
| XML | fast-xml-parser; XSD via xmllint-wasm | 5.11; 5.3 |
| P7M | pkijs + asn1js | 4.0 / 4.0 |
| Import | fflate (ZIP), papaparse (CSV) | 0.8 / 5.7 |
| PDF | @react-pdf/renderer | 4.9 |
| i18n | i18next + react-i18next | 26.7 / 17.1 |
| Push | @pushforge/builder | 2.0 |
| Email | resend | 6.37 |
| Tests | Vitest + `@cloudflare/vitest-pool-workers`, Playwright | 5.0 / 0.23, 1.64 |
| Lint / format | Biome | exact version pinned at step 1 |

**Rejected alternatives**
- R2 for files: needs a payment card on the account; D1 BLOBs (2 MB per row, 5 GB total) cover the volume.
- Supabase backend: inactivity pause, weak free backups, 25 $/month paid tier.
- Netlify hosting: shared monthly credits with the portfolio could pause both sites.
- PEC channel: password with full mailbox rights on the server, polling, 2–3 more days of work.
- Cloudflare Email Sending: needs Workers Paid (5 $/month); Resend free covers the volume.
- Svelte / Preact: smaller bundles, but fewer ready libraries for PDF and i18n.
- Custom auth (SimpleWebAuthn + otpauth): about one more day and more security code to own.
- pdfmake: less integrated with React and i18n; pdf-lib: unmaintained since 2022.
- Paraglide: typed messages but less common; i18next also serves Worker-side email texts.
- Material (MUI): Google look out of place on iPhone/Mac, heavier, hard to restyle.
- Client-side vault for the send token (passkey PRF / send code): small real security gain,
  1–1.5 days of cost and the riskiest spike item.

## Progress

Phase: implementation
Branch: main
Base: 98f6037
Spec: docs/specs/invoicer.md
Architecture: agreed
Approved: yes (2026-11-02)

### Steps
- [x] 1. Scaffolding — `docs: sync CLAUDE.md commands and tick scaffolding step`
- [ ] 2. Risk spike (manual device checkpoint) — code ready, owner checklist in docs/notes/spike.md
- [ ] 3. Data model
- [ ] 4. Auth
- [ ] 5. Send authorization
- [ ] 6. Totals engine
- [ ] 7. Profile, onboarding, settings
- [ ] 8. Clients
- [ ] 9. Invoice editor
- [ ] 10. FatturaPA XML
- [ ] 11. PDF
- [ ] 12. Openapi channel and send flow
- [ ] 13. Webhook and reconciliation (Milestone A exit: real send, cutover)
- [ ] 14. Received invoices and imports
- [ ] 15. Lists and dashboard
- [ ] 16. Courtesy email
- [ ] 17. Push and notifications
- [ ] 18. Cron jobs, recurring, credit
- [ ] 19. Backup
- [ ] 20. Hardening and release

### Verification
- qa: pending
- review: pending

### Decisions
- Single-user, self-hosted deployment; generic public code, no owner data in the repo (2026-11-02).
- SdI channel: Openapi SDI API behind a channel interface; PEC considered and rejected for v1 (password would sit on the server with full mailbox rights, more code, polling) (2026-11-02).
- Hosting: everything on Cloudflare free plan (Worker static assets + Worker API, D1, Cron Triggers, secrets); Supabase rejected (inactivity pause, weak free backups, higher paid tier) (2026-11-02).
- Files: all files (invoice XML, PDF, received originals, imports) are stored in D1 BLOBs, not R2, which would need a payment card; D1 free plan 5 GB total, max 2 MB per file (a PDF is ~100 KB, an XML ~10 KB), larger files refused; files covered by Time Travel and the JSON export; R2 can come back behind the same storage interface (2026-11-02).
- Domain: `invoicer.vittorioallegra.com`; project and repo name `invoicer` (2026-11-02).
- Auth: passkey login, email + password + TOTP fallback, sign-up closed after the owner account (2026-11-02).
- Openapi tokens: read and send tokens as Worker secrets with minimum scopes; every send needs a passkey assertion (TOTP fallback) verified by the Worker and bound to the invoice and its XML hash; Openapi account credentials are never stored, credit is estimated (2026-11-02, replaces the client-side vault).
- Fallback password hashing: reduced PBKDF2 iteration count fitting the free-plan CPU limit, compensated by mandatory TOTP, login rate limit and a generated password (2026-11-02).
- No calendar dates in the plan: Milestone A first, owner decides on FiC renewal (2026-11-02).
- Rejection after the 5-day window becomes `rejected_expired` and is reissued with a new number; the editor warns on late issuance (12 days immediate, 15th of next month deferred) (2026-11-02).
- UI: Tailwind + shadcn/ui (Radix), not Material (2026-11-02).
- Courtesy email via Resend from `no-reply@invoicer.vittorioallegra.com`, configurable Reply-To and BCC, automatic on delivered / not delivered (2026-11-02).
- No end-to-end encryption of business data (owner's own server) (2026-11-02).
- UI and documents in English (base) and Italian via i18n (2026-10-31).
- Frontend React 19 + TanStack, Better Auth for auth, @react-pdf/renderer for PDF, i18next for i18n; all other library choices as in Architecture (2026-11-02).
- Courtesy email through Resend, not Cloudflare Email Sending (needs Workers Paid) (2026-11-02).

### Open questions
- See "Open questions for the architecture phase" in the spec; most are assigned to the step 2 spike.

### Next
Owner runs the spike checklist (docs/notes/spike.md), then the plan is revised if a check fails.
