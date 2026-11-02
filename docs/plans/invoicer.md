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

Steps 1–13 are the shortest path to a real invoice sent through the production PEC
mailbox (spec AC 21). Nothing from Milestone B blocks it. No calendar dates: before FiC's
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
     external account (the PEC mailbox, Resend and push are off or mocked by default).
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
     never talks to the PEC servers), Origin check on state-changing `/api/*` calls, parsed external data rendered as
     text only, stored originals served with `Content-Disposition: attachment` and
     `X-Content-Type-Options: nosniff`.
   - One `scheduled` handler for the single `*/10 * * * *` cron trigger: every run polls the mailbox
     and runs the daily jobs when `shouldRunDaily` says so (09:00 Europe/Rome or later, today's Rome
     date not completed yet; pure and tested, DST through `Intl`). Persisting the last completed
     Rome date comes with `job_runs` in step 3, which supplies the lookup the dispatcher takes.
   - README skeleton (deploy section grown by every later step). Create `CLAUDE.md` with the
     commands, including the single-test failures-only command.
   - Tests: health route, one i18n render, problem+json shape, missing-secret error.
2. **Risk spike.** A hidden `/spike` page and routes, gated by a spike secret header (no auth
   exists yet), that check on real devices: a passkey assertion created on iPhone Safari and
   Mac Safari (same iCloud passkey) verifies in the Worker against a bound challenge; Web Push
   delivery with the app closed (iPhone Home screen PWA, Mac); CPU time per request, with a
   pass threshold below the 10 ms free-plan limit, for PBKDF2 password hashing at the reduced
   iteration count, a passkey assertion verification, Web Push payload encryption
   (`@pushforge/builder`), `postal-mime` parsing of an SdI receipt, a PEC envelope and a large
   invoice message, and the cron handlers (mailbox polling, daily jobs, subrequest count under
   the free-plan cap). A **PEC probe** behind `PEC_USERNAME`/`PEC_PASSWORD` (skipped with a clear
   message when unset): IMAP login over `cloudflare:sockets`, list the latest N message headers,
   `GETQUOTAROOT`, IMAP fetch + `postal-mime` parse of the newest message with its CPU time, and
   an SMTP send of a test PEC (with a sample XML attachment) to the owner's own address through
   `worker-mailer`. Also record, from docs or the real mailbox: Aruba IMAP/SMTP hosts, ports and
   limits, whether QUOTA is supported, the SdI-by-PEC rules (first send address, assigned
   address reply, receipt file naming, message size limits), D1 Time Travel retention on the free
   plan, the FatturaPA schema version in force, and whether a non-EUR invoice needs an EUR
   equivalent (precondition for step 10, fixture d). For each CPU check that fails, the named
   fallback (browser-side work, `waitUntil`) is chosen. Password hashing uses the highest PBKDF2
   iteration count that fits the limit (decided: reduced count, compensated by mandatory TOTP, a
   login rate limit and a generated password, documented); moving to Workers Paid needs explicit
   owner approval. Results go to `docs/notes/spike.md`. **Manual checkpoint:** the owner
   deploys (README skeleton) and runs the device checks; the plan is revised if a check
   fails. Remove the spike page in step 20. Already built with the spike: the minimal IMAP client
   (`src/worker/pec/imap.ts`, final location, reused by step 13) and PEC envelope parsing
   (`src/worker/pec/envelope.ts`).
3. **Data model.** Drizzle schema + first D1 migration: `profile`, `settings` (including the
   mailbox cursor: UIDVALIDITY and last seen UID, and the SdI PEC address assigned by the SdI),
   `clients`,
   `invoices` (TD01/TD04, state including `sending` and `rejected_expired`, state rank,
   payment flag, `number_raw` + parsed `number_int`, year, issue date, source
   `app`/`imported`; partial UNIQUE index on year + `number_int` where not null, covering app
   and imported invoices), `transmissions` (one row per attempt: file progressive, file
   name, channel `pec`/`manual`, send-outcome `none`/`complete`/`unknown`, channel message id
   (the PEC Message-ID), SdI PEC address used, PDF/XML `files` ids, created before the SMTP send),
   `number_sequences` (one counter row per year) and `file_sequence`
   (global file progressive counter), `invoice_lines`, `pec_messages` (every stored PEC message:
   Message-ID, UIDVALIDITY, UID, kind `pec_receipt`/`sdi_message`/`received_invoice`/`ignored`,
   parsed SdI message type, original file name, size, raw message as a `files` id, `processed_at`;
   UNIQUE on Message-ID and on UIDVALIDITY + UID), `received_invoices` (unique on the source
   `pec_messages` id, `parse_status`, original file as a `files` id), `files` (id, kind
   `xml`/`pdf`/`received`/`import`/`pec_raw`, invoice / transmission or received-invoice
   reference, filename, content type, size, sha256, `content` BLOB, created_at; CHECK size
   <= 2 MB, larger files are refused with a clear error; all file access goes through one
   storage interface so R2 can be reintroduced later), `events` (SdI receipts and error events,
   unique on source id, `processed_at`),
   `outbox` (email/push/notification side effects, UNIQUE on invoice + attempt + kind),
   `notifications`, `push_subscriptions`, `recurring_templates`, `recurring_occurrences`
   (unique on template + date), `email_log`, `job_runs` (job, started/finished, status,
   counts, error code), `send_challenges` (single-use WebAuthn challenges bound to an
   invoice and the hash of its final XML, short TTL). Tests: migration applies on a clean local D1; unique constraints hold.
4. **Auth.** Better Auth 1.7 on D1 via Drizzle: passkey plugin (login), twoFactor plugin
   (TOTP + recovery codes) for the email + password fallback, PBKDF2 (Web Crypto) password
   hashing per the step 2 decision, login rate limit, first-run owner creation only with the
   `SETUP_TOKEN` Worker secret (the deploy is public before onboarding) and sign-up closed in
   the same transaction, session middleware on `/api/*`. Login and setup screens.
   Tests: AC 2, 3; first run without `SETUP_TOKEN` refused.
5. **Send authorization.** The PEC credentials are Worker secrets (`PEC_USERNAME`,
   `PEC_PASSWORD`), set with `wrangler secret put`, never stored in D1, never returned to the
   browser; Settings shows only whether each is configured (hosts and ports are plain vars,
   defaults `imaps.pec.aruba.it:993` and `smtps.pec.aruba.it:465`). The security model states
   that the single password gives full mailbox access. `src/worker/auth/send-
   authorization`: `POST /api/invoices/:id/send-challenge` issues a single-use challenge
   bound to the invoice id and the SHA-256 of its final XML (short TTL); the browser answers
   with a passkey assertion (fallback: a fresh TOTP code); the Worker verifies it against the
   owner's registered passkeys (`@simplewebauthn/server`, user verification required) before
   any SMTP connection is opened. Tests: valid assertion accepted once; replayed, expired,
   wrong-invoice and wrong-XML-hash assertions refused; TOTP fallback; PEC credentials never
   present in any API response or log (AC 4 part).
6. **Totals engine.** `src/shared/totals` working in integer cents: lines, VAT per rate,
   natura with legal texts, cassa/rivalsa in `excluded` and `included` modes, ritenuta, bollo
   rule, rounding to the cent, TD04 sign. Money parsing shared with `MoneyInput`: accepts
   `1040,00`, `1.040,00` and `1,040.00`. Fixtures live in `src/shared/fixtures/`. Tests:
   fixtures (a)–(g) totals to the cent, including 1,040.00 and 999.99; money parsing cases.
7. **Profile, onboarding, settings.** Issuer profile (RF list), payment defaults, next
   invoice number for the current year, AdE guide screen, email settings (sender name/address,
   Reply-To, BCC, mode), language. Setup checklist on Home (passkey, fallback login,
   profile, PEC setup, AdE guide, email): each item done/pending, persisted
   server-side, resumable; "Send" is blocked with a stated reason until profile and PEC
   setup (including a passing connection test) are done. First-run empty Home with a call to action.
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
    relevant FatturaPA data and the legal note.
    Generated in the browser after the number is reserved and stored in `files` per
    invoice and transmission attempt (regenerated on resend; the email always uses the
    latest). Tests: AC 13 (language and payment data present, via text extraction).
12. **PEC channel and send flow.** `src/shared/channel` interface; PEC implementation in the
    Worker: sends the FatturaPA XML as a PEC attachment over SMTP (implicit TLS 465, `worker-
    mailer` on `cloudflare:sockets`) with the secrets of step 5; file name
    `IT<idcodice>_<progressive>.xml`; first send to `sdi01@pec.fatturapa.it`, afterwards to the
    SdI PEC address stored in settings from the SdI's first reply (rule re-checked in the spike).
    PEC settings screen (replaces the setup wizard): host and port presets for Aruba, editable,
    where to set the secrets (commands shown), the security trade-off of the single password, and
    a **connection test** (IMAP login + EXAMINE + quota, SMTP login without sending) with a clear
    per-stage result. A **manual AdE channel** behind the same interface: export XML and PDF for
    the portal upload, set the outcome by hand (delivered / not delivered / rejected with
    error text), always available; receipts and received invoices from the portal ZIP come in
    through the step 14 import. The mock channel serves `dev`.
    Send flow, in order: review screen → XSD validation with the provisional next number →
    Worker reserves the number and sets `sending` (step 9) → browser builds the final XML +
    PDF and uploads them → the final XML is XSD-validated again (a failure releases or keeps
    the number per step 9 and is a definite refusal) → send challenge bound to the final XML
    hash → passkey check (AC 5: cancelling before this point leaves the invoice unsent; the
    reserved number follows the release rule of step 9) → Worker verifies the assertion and
    sends the PEC over SMTP → stores the PEC Message-ID → the invoice stays `sending` until the
    SdI mailbox's PEC delivery receipt arrives (step 13), then `sent`. The file name is stored
    in D1 on the transmission row before the SMTP send. An invoice in `sending` with an unknown
    outcome (Worker timeout, SMTP error after DATA) is resolved by the mailbox polling of step 13
    (the sent message and its receipts are matched by file name) before any retry; "not found"
    unlocks a retry only after a quiet period (at least 15 minutes after the reserve), and
    every retry uses a new file progressive. A PEC error before the SdI (SMTP refusal, or a PEC
    non-delivery message) is retried with the same number and date and no deadline; an SdI NS
    follows the rejected rules of step 9. SMTP and PEC errors map to plain-language messages
    with a fix (wrong password, mailbox full, SdI address missing); the password and SMTP
    `AUTH` lines are stripped from anything reported to the Worker or logged. Invoice detail
    page: state, SdI errors, PDF/XML download, payment flag, credit note, duplicate, with the
    primary action following the state (Send / Fix & resend / Mark paid). Tests: AC 5, AC 7
    against recorded SMTP/IMAP fixtures in `src/worker/pec/*fixtures.ts` and a fake socket; "SMTP ok,
    Worker fails before storing the Message-ID"; "SMTP refusal after reserve"; send refused
    without a valid assertion (no socket opened); "timeout after reserve"; final-XML XSD failure
    after reserve; "not found" within the quiet period does not unlock a retry; rejected → fix →
    resend with same number/date and new file name; PEC non-delivery vs SdI NS; one live test
    behind `PEC_LIVE=1` that sends to the owner's own address.
13. **Mailbox polling and SdI receipts.** The `*/10 * * * *` cron polls the mailbox with the
    minimal IMAP client of step 2 (`src/worker/pec/imap.ts`): EXAMINE INBOX, compare UIDVALIDITY
    with the stored cursor (a change triggers a safe rescan, deduplicated by Message-ID),
    `UID SEARCH` for UIDs above the last seen one, `UID FETCH` with PEEK, no deletion and no flag
    changes. Each new message is stored once (UNIQUE on Message-ID and on UIDVALIDITY + UID) as a
    `pec_messages` row with its raw bytes in `files` (2 MB cap; an oversize message is recorded
    as an error event with a notification, not fetched in full); the cursor advances only after
    the commit. `postal-mime` parses the PEC envelope (`postacert.eml`, `daticert.xml`) and the
    classifier separates PEC acceptance/delivery receipts and PEC non-delivery (mancata consegna)
    from SdI messages (RC, MC, NS, and the SdI's first reply carrying the assigned PEC address,
    which is stored in settings); anything else is stored as `ignored` with no notification.
    SdI receipts match transmissions by the original file name (`<file>_RC_<nnn>.xml` etc.); the
    PEC delivery receipt from the SdI mailbox moves `sending` to `sent`. The message row, its
    state transition and its side effects (outbox rows) commit in one D1 batch; transitions are
    guarded UPDATEs on the state rank, so replays and stale messages never move an invoice
    backwards; outbox processed in `waitUntil` and retried from cron; received invoices (XML or
    `.p7m`, attachments of `postacert.eml`) are stored with their original file in `files`,
    `parse_status = pending` and parsed by the browser on next open (viewing in step 14);
    unmatched SdI messages are stored and listed, never dropped. Polling is the reconciliation:
    after downtime it resumes from the last UID; each run writes a `job_runs` row and a failure
    (login, network, parse) raises a notification. Per run caps (messages and bytes) keep CPU and
    subrequests within the free plan, continuing on the next run. "Download all data" (JSON
    export of every table) in Settings, so Milestone A does not rely only on D1 Time Travel.
    Tests: AC 7, AC 8, AC 9 with the IMAP transcripts and fake socket, "transition fails, retry
    ends in the correct state", out-of-order and stale transitions, replay creates no second
    outbox row, SdI receipt while `sending`, non-SdI mail ignored without notification,
    UIDVALIDITY change.
    **Milestone A exit:** the owner sets the next number from FiC, sends one real invoice
    through the production PEC mailbox, records it (AC 21), and the cutover runbook
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
18. **Daily jobs, recurring, mailbox quota.** Daily jobs (09:00 Europe/Rome, from the 10-minute cron): planned due, overdue unpaid, recurring
    drafts exactly once (AC 12), mailbox quota check, each run in `job_runs` with the last run
    shown in Settings; recurring templates UI with empty state; mailbox quota section (IMAP
    `GETQUOTAROOT` when Aruba supports it, else an estimate from the stored messages' sizes;
    configurable threshold, banner and push) and a prominent warning with a push when the
    mailbox login starts failing (AC 16). Tests: AC 12, 15 (cron parts), 16.
19. **Restore documentation.** No automatic backup and no reminder. README section on restoring:
    D1 Time Travel point-in-time restore (7 days on the free plan) and the Settings "Download
    all data" export from step 13 for manual use.
20. **Hardening and release.** Remove the spike page and drop its throwaway `spike_kv` D1 table (`DROP TABLE spike_kv`, created at runtime, no migration); responsive and accessibility pass at
    375 px; secrets audit test (AC 4 full, including browser-side error reports); README
    deploy guide (Cloudflare resources, secrets, GitHub auto-deploy, subdomain, Resend DNS
    SPF/DKIM/DMARC, PEC and AdE setup, free-plan limits and the Workers Paid switch, owner
    hardening checklist, troubleshooting per error code) (AC 1, 19) with a timed fresh-account
    run; a check that the vendored XSD version still matches the AdE site; Playwright E2E for
    the two flows in the Testing Plan plus rejected → resend; update `CLAUDE.md`.

### Cutover runbook (README, written in step 13)
1. Import the FiC history (or at least set the next number for the year from FiC).
2. Stop issuing in FiC; never issue in both tools in the same period.
3. First real send through Invoicer (AC 21).
4. Register the PEC address on the AdE portal as the address for receiving invoices only once
   mailbox polling stores received invoices (step 13); rollback = switch it back to FiC's code
   while FiC is active.
5. Keep FiC until 2026-12-31 as the fallback.

### Risks
- December deadline → Milestone A first; FiC renewal stays the fallback.
- PEC password on the server: one password for IMAP, SMTP and webmail, so no read/write split
  exists. If stolen, someone can read the whole mailbox (including official notices sent to
  this domicilio digitale) and send PEC with legal value as the owner. Cloudflare secrets are
  write-only in the dashboard, but whoever can deploy code (Cloudflare or GitHub account) can
  use it → unique long generated PEC password used only by the app, second factor on
  Cloudflare and GitHub, rotation after any suspicion; every send needs a passkey assertion
  verified by the Worker. A client-side vault was rejected: it protects only against a D1 leak,
  not against a compromised deploy, at 1–1.5 days of cost.
- Free-plan CPU limit (10 ms) → per-operation thresholds and fallbacks from step 2 (browser,
  `waitUntil`); Workers Paid (5 $/month) only with owner approval.
- Send interrupted after the SMTP server accepted it → `sending` state, IndexedDB pending
  report, mailbox polling matches by file name before any retry (no duplicate transmission, no number gap).
- Message processed partially → message row, transition and outbox in one batch; the cursor
  advances only after the commit, so a failed run is retried.
- Number gaps or date-order breaks → guarded reserve batch, Europe/Rome dates, numbered
  invoices never deleted, release only of the highest number.
- Public deploy before onboarding → owner creation needs `SETUP_TOKEN`.
- XSS triggering actions as the owner → strict CSP, Origin checks, text-only rendering of
  external data; sends still need a fresh passkey assertion.
- Better Auth passkey plugin changes (fast release cadence) → pin exact versions.
- iOS Web Push reliability → in-app list and email-to-self stay as backups.
- FatturaPA schema/spec drift → XSD vendored with its version recorded; version check in
  step 20 and before each tax season.
- IMAP/MIME work over the 10 ms CPU limit, or Aruba behaving differently from the docs →
  step 2 probe; per-run caps, `waitUntil`, smaller fetches; manual AdE channel as fallback.
- Mailbox full or password changed → polling and sending stop → quota warning and login-failure
  notification (step 18); manual AdE channel stays available.
- Data loss on D1 → Time Travel (7 days) plus the manual "Download all data" export; no automatic backup (step 19 documents the restore).

## Architecture

**Shape:** one TypeScript repo, one Cloudflare Worker that serves the SPA (static assets) and
the API. The browser does the CPU-heavy work (XML, XSD validation, PDF, P7M); the Worker
does auth, data, send authorization, PEC send (SMTP) and mailbox polling (IMAP), cron jobs,
push and email.

**Folders**
- `src/client/` — React SPA: `routes/`, `components/` (incl. `ui/` from shadcn/ui), `pdf/`, `i18n/`.
- `src/worker/` — Hono app: `routes/`, `auth/`, `jobs/` (cron), `pec/` (IMAP client, envelope parsing, SMTP send, polling), `push/`, `email/`.
- `src/shared/` — pure domain code used by both: `totals/`, `fatturapa/`, `channel/`, `fixtures/`, errors, types, zod schemas.
- `src/db/` — Drizzle schema; `migrations/` — D1 migrations.
- `locales/{en,it}/` — i18n resources (UI, PDF, email).
- `assets/xsd/` — official FatturaPA XSD.
- `tests/` — Playwright E2E and `fixtures/pec/` recorded IMAP/SMTP transcripts and PEC messages; unit/integration tests live next to the code as `*.test.ts`.
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
| PEC send (SMTP over `cloudflare:sockets`) | worker-mailer | 1.3.0 |
| PEC mail parsing | postal-mime | 4.2.0 |
| PEC read (IMAP over `cloudflare:sockets`) | minimal in-repo client (`src/worker/pec/imap.ts`), no library | - |
| Tests | Vitest + `@cloudflare/vitest-pool-workers`, Playwright | 5.0 / 0.23, 1.64 |
| Lint / format | Biome | exact version pinned at step 1 |

**Rejected alternatives**
- R2 for files: needs a payment card on the account; D1 BLOBs (2 MB per row, 5 GB total) cover the volume.
- Supabase backend: inactivity pause, weak free backups, 25 $/month paid tier.
- Netlify hosting: shared monthly credits with the portfolio could pause both sites.
- Openapi (paid intermediary): 50 EUR minimum top-up, running cost; kept as a possible future channel behind the channel interface.
- `imapflow` for IMAP: relies on Node `net`/`tls` and heavy dependencies, risky on Workers; a minimal in-repo client covers the six commands needed.
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
- [ ] 12. PEC channel and send flow
- [ ] 13. Mailbox polling and SdI receipts (Milestone A exit: real send, cutover)
- [ ] 14. Received invoices and imports
- [ ] 15. Lists and dashboard
- [ ] 16. Courtesy email
- [ ] 17. Push and notifications
- [ ] 18. Cron jobs, recurring, mailbox quota
- [ ] 19. Restore documentation
- [ ] 20. Hardening and release

### Verification
- qa: pending
- review: pending

### Decisions
- Single-user, self-hosted deployment; generic public code, no owner data in the repo (2026-11-02).
- SdI channel: the owner's PEC mailbox behind a channel interface (SMTP send, IMAP polling every 10 minutes, manual AdE portal channel as fallback); Openapi was the first choice and is now a possible future channel (2026-11-02, superseded by the 2026-11-02 channel switch below).
- Hosting: everything on Cloudflare free plan (Worker static assets + Worker API, D1, Cron Triggers, secrets); Supabase rejected (inactivity pause, weak free backups, higher paid tier) (2026-11-02).
- Files: all files (invoice XML, PDF, received originals, imports) are stored in D1 BLOBs, not R2, which would need a payment card; D1 free plan 5 GB total, max 2 MB per file (a PDF is ~100 KB, an XML ~10 KB), larger files refused; files covered by Time Travel and the JSON export; R2 can come back behind the same storage interface (2026-11-02).
- Domain: `invoicer.vittorioallegra.com`; project and repo name `invoicer` (2026-11-02).
- Auth: passkey login, email + password + TOTP fallback, sign-up closed after the owner account (2026-11-02).
- Send authorization: every send needs a passkey assertion (TOTP fallback) verified by the Worker and bound to the invoice and its XML hash; it now gates the SMTP send (2026-11-02, replaces the client-side vault).
- Fallback password hashing: reduced PBKDF2 iteration count fitting the free-plan CPU limit, compensated by mandatory TOTP, login rate limit and a generated password (2026-11-02).
- No calendar dates in the plan: Milestone A first, owner decides on FiC renewal (2026-11-02).
- Rejection after the 5-day window becomes `rejected_expired` and is reissued with a new number; the editor warns on late issuance (12 days immediate, 15th of next month deferred) (2026-11-02).
- UI: Tailwind + shadcn/ui (Radix), not Material (2026-11-02).
- Courtesy email via Resend from `no-reply@invoicer.vittorioallegra.com`, configurable Reply-To and BCC, automatic on delivered / not delivered (2026-11-02).
- No end-to-end encryption of business data (owner's own server) (2026-11-02).
- UI and documents in English (base) and Italian via i18n (2026-10-31).
- Frontend React 19 + TanStack, Better Auth for auth, @react-pdf/renderer for PDF, i18next for i18n; all other library choices as in Architecture (2026-11-02).
- Courtesy email through Resend, not Cloudflare Email Sending (needs Workers Paid) (2026-11-02).
- Channel switch Openapi -> PEC (2026-11-02): Openapi needs a 50 EUR minimum top-up; the owner already has a free PEC mailbox (Aruba infrastructure, provided by the Ordine degli Ingegneri, used for nothing else, tied to the partita IVA), so cost goes to 0 EUR. `PEC_USERNAME`/`PEC_PASSWORD` are Worker secrets (one password for IMAP, SMTP and webmail: if stolen, the mailbox can be read and PEC sent as the owner; accepted for a single-user app, mitigated by a generated password, second factors and the per-send passkey). SMTP send via `worker-mailer` 1.3.0, MIME parsing via `postal-mime` 4.2.0, a minimal in-repo IMAP client; `imapflow` rejected (Node net/tls, heavy dependencies); polling cron `*/10 * * * *` (3 of 5 free cron triggers); credit section replaced by a mailbox quota warning; manual AdE portal channel kept as fallback; Openapi kept as a possible future channel (out of v1).
- No notifications for non-SdI PEC messages: the app ignores them and the owner reads them in the Aruba app (2026-11-02).

- Scheduling (2026-11-02): one cron trigger `*/10 * * * *` only; every run polls the mailbox and the daily jobs run once per Rome day from 09:00 Europe/Rome, tracked in `job_runs` with catch-up of missed ticks. No weekly job, no automatic backup and no monthly reminder: restore relies on D1 Time Travel and the manual "Download all data" export.

### Open questions
- See "Open questions for the architecture phase" in the spec; most are assigned to the step 2 spike.

### Next
Owner runs the spike checklist (docs/notes/spike.md), then the plan is revised if a check fails.
