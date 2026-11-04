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
   equivalent (answered by the owner, see Decisions). For each CPU check that fails, the named
   fallback (browser-side work, `waitUntil`) is chosen. Password hashing uses the highest PBKDF2
   iteration count that fits the limit (decided: reduced count, compensated by mandatory TOTP, a
   login rate limit and a generated password, documented); moving to Workers Paid needs explicit
   owner approval. Results go to `docs/notes/spike.md`. **Manual checkpoint:** the owner
   deploys (README skeleton) and runs the device checks; the plan is revised if a check
   fails. Remove the spike page in step 21. Already built with the spike: the minimal IMAP client
   (`src/worker/pec/imap.ts`, final location, reused by step 13) and PEC envelope parsing
   (`src/worker/pec/envelope.ts`).
3. **Data model.** Drizzle schema + first D1 migration: `profile`, `settings` (including the
   mailbox cursor: UIDVALIDITY and last seen UID, and the SdI PEC address assigned by the SdI),
   `clients`,
   `invoices` (TD01/TD04, state including `sending` and `rejected_expired`, state rank,
   payment flag, `number_raw` + parsed `number_int`, year, issue date, source
   `app`/`imported`, `series_id`; partial UNIQUE index on series + year + `number_int` where
   not null, covering app and imported invoices), `numbering_series` (name, prefix, suffix,
   one default), `transmissions` (one row per attempt: file progressive, file
   name, channel `pec`/`manual`, send-outcome `none`/`complete`/`unknown`, channel message id
   (the PEC Message-ID), SdI PEC address used, PDF/XML `files` ids, created before the SMTP send),
   `number_sequences` (one counter row per series and year) and `file_sequence`
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
7. **Profile, onboarding, settings.** Issuer profile (RF list), payment defaults, AdE
   guide screen, email settings (sender name/address,
   Reply-To, BCC, mode), language. Setup checklist on Home (passkey, fallback login,
   profile, PEC setup, AdE guide, email): each item done/pending, persisted
   server-side, resumable; "Send" is blocked with a stated reason until profile and PEC
   setup (including a passing connection test) are done. First-run empty Home with a call to action.
8. **Clients.** CRUD with type rules (codice destinatario defaults, required fields,
   P.IVA / codice fiscale format), empty state, inline client creation from the invoice
   editor. Tests: type rules. (FiC CSV import is step 15.)
9. **Invoice editor.** TD01 and TD04 (linked or not) editor using the totals engine:
   drafts, planned date, duplicate, payment flag, minimal "To issue" and "Issued" lists (full
   dashboard in step 16). Layout: lines as stacked cards at 375 px and a table on desktop;
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
   highest number issued in the series and year (app and imported) + 1 computed in SQL, or the number the
   owner requested on the draft (`requested_number_int`) when it is above that highest (a gap is
   allowed), else `number_unavailable` and nothing is reserved;
   year and issue date = today in Europe/Rome (the Worker runs in UTC), asserted not earlier
   than the date of the highest number already issued that year; allocate the file
   progressive; set `sending`. A numbered invoice can never be deleted or returned to draft:
   its number can be released only if it is still the highest of its year (sequence rolled
   back), otherwise it must be sent; Home lists such invoices as "number reserved, not
   sent". Tests: AC 11 (incl. two devices reserving the same invoice, concurrent sends,
   imported numbers, a requested number accepted, refused at or below the highest, refused for
   the loser of a race, gaps allowed), guard failure leaves the
   sequence unchanged, Europe/Rome year boundary, date monotonicity, delete/revert of a
   numbered invoice refused, release rule, rejected and rejected_expired rules.
10. **FatturaPA XML.** `src/shared/fatturapa`: builder (fast-xml-parser) for FPR12, file name
    `IT<id>_<progressive>.xml` with a new progressive per transmission attempt (a resend after
    rejection keeps number and date but not the file name), parser for received XML; XSD
    validation with `xmllint-wasm` (official XSD vendored in `assets/xsd/`, version recorded
    in `CLAUDE.md`) in the browser before send and in tests; plain-language mapping of
    validation errors to fields, unmapped errors under a "technical details" disclosure. Non-EUR
    invoices stay in their own currency. Tests: AC 6 for fixtures (a)–(g).
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
    through the step 15 import. The mock channel serves `dev`.
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
    `parse_status = pending` and parsed by the browser on next open (viewing in step 15);
    unmatched SdI messages are stored and listed, never dropped. Polling is the reconciliation:
    after downtime it resumes from the last UID; each run writes a `job_runs` row and a failure
    (login, network, parse) raises a notification. Per run caps (messages and bytes) keep CPU and
    subrequests within the free plan, continuing on the next run. "Download all data" (JSON
    export of every table) in Settings, so Milestone A does not rely only on D1 Time Travel.
    Tests: AC 7, AC 8, AC 9 with the IMAP transcripts and fake socket, "transition fails, retry
    ends in the correct state", out-of-order and stale transitions, replay creates no second
    outbox row, SdI receipt while `sending`, non-SdI mail ignored without notification,
    UIDVALIDITY change.
    **Milestone A exit:** the owner sets the number on the first invoice, sends one real invoice
    through the production PEC mailbox, records it (AC 21), and the cutover runbook
    (README, written in this step) is followed.

### Milestone B — complete v1

14. **UI polish: Liquid Glass.** Done once the real screens exist (after Milestone A), not
    before. iOS 26-style floating translucent tab bar (rounded pill inset from the screen
    edges, `backdrop-filter` blur + saturation, subtle highlight border, safe-area aware) and
    the same glass treatment for sheets and the sticky totals footer, built from shared
    tokens/utilities so every surface looks alike. Fallbacks: `prefers-reduced-transparency`
    and no `backdrop-filter` support get an opaque surface; `prefers-reduced-motion` removes
    transitions. Text contrast checked in light and dark over real screen content (WCAG AA).
    Tests: a DOM test for the fallbacks' classes/media queries, plus a manual iPhone check.
15. **Received invoices and imports.** Received invoice list and readable view (supplier,
    date, number, lines, totals, payment data, download of the original); P7M extraction
    (pkijs + asn1js); manual import of XML/P7M/ZIP (fflate) for received and historic issued
    invoices (stored `delivered`, read-only, "Imported" badge, numbers blocking reuse); FiC
    clients CSV import with preview and per-row errors (papaparse). Import result screen
    ("N imported, M skipped" with per-row/per-file reasons and duplicate-number conflicts),
    progress state for slow files. Tests: AC 10, AC 17.
16. **Lists and dashboard.** To issue / Issued / Received, top strip counts, yearly and
    monthly totals (TD04 subtracted), filters, search, mark paid, overdue derivation,
    skeleton loading, empty and no-result states.
17. **Courtesy email.** Resend from the Worker, driven by the outbox (exactly one email per
    invoice + attempt, Resend `Idempotency-Key`), with i18n subject/body templates, latest PDF +
    XML attached from `files`, From/Reply-To/BCC from settings; modes automatic (on delivered /
    not_delivered), ask (in-app card on the invoice and in the notification list opening an
    editable preview sheet with Send / Skip), manual resend; `email_log` shown as a timeline
    on the invoice detail; failure notification. Tests: AC 14 with Resend mocked.
18. **Push and notifications.** Web Push subscriptions and sender (`@pushforge/builder`,
    VAPID secret), service worker handler, deep link from a push to its invoice, per-type
    toggles, in-app notification list. Tests: AC 15 (push parts with mocks).
19. **Daily jobs, recurring, mailbox quota.** Daily jobs (09:00 Europe/Rome, from the 10-minute cron): unsent invoice due (done), overdue unpaid, recurring
    invoices exactly once (AC 12, out of scope for now: removed 2026-11-04, see Decisions), mailbox quota check, each run in `job_runs` with the last run
    shown in Settings; recurring templates UI with empty state; mailbox quota section (IMAP
    `GETQUOTAROOT` when Aruba supports it, else an estimate from the stored messages' sizes;
    configurable threshold, banner and push) and a prominent warning with a push when the
    mailbox login starts failing (AC 16). Tests: AC 12 (deferred), 15 (cron parts), 16.
20. **Restore documentation.** No automatic backup and no reminder. README section on restoring:
    D1 Time Travel point-in-time restore (7 days on the free plan) and the Settings "Download
    all data" export from step 13 for manual use.
21. **Hardening and release.** Remove the spike page and drop its throwaway `spike_kv` D1 table (`DROP TABLE spike_kv`, created at runtime, no migration) and the temporary "Diagnostics" link at the bottom of the Settings screen (`pages.settings.diagnostics` in both locales) that leads to it; responsive and accessibility pass at
    375 px; secrets audit test (AC 4 full, including browser-side error reports); README
    deploy guide (Cloudflare resources, secrets, GitHub auto-deploy, subdomain, Resend DNS
    SPF/DKIM/DMARC, PEC and AdE setup, free-plan limits and the Workers Paid switch, owner
    hardening checklist, troubleshooting per error code) (AC 1, 19) with a timed fresh-account
    run; a check that the vendored XSD version still matches the AdE site; Playwright E2E for
    the two flows in the Testing Plan plus rejected → resend; update `CLAUDE.md`.

### Cutover runbook (README, written in step 13)
1. Import the FiC history (or at least set the number on the first invoice to the one FiC would issue next).
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
  step 21 and before each tax season.
- IMAP/MIME work over the 10 ms CPU limit, or Aruba behaving differently from the docs →
  step 2 probe; per-run caps, `waitUntil`, smaller fetches; manual AdE channel as fallback.
- Mailbox full or password changed → polling and sending stop → login-failure warning and
  notification (step 19); the PEC provider itself warns about a full mailbox (see the 2026-11-04
  decision "mailbox quota warning removed"); manual AdE channel stays available.
- Data loss on D1 → Time Travel (7 days) plus the manual "Download all data" export; no automatic backup (step 20 documents the restore).

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
| Toasts | `@radix-ui/react-toast` (no runtime style injection) | 1.3.1 |
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
| QR code (TOTP enrolment, client-only) | uqr | 0.1.3 |
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

Phase: done
Branch: main
Base: 98f6037
Spec: docs/specs/invoicer.md
Architecture: agreed
Approved: yes (2026-11-02)

### Steps
- [x] 1. Scaffolding — `docs: sync CLAUDE.md commands and tick scaffolding step`
- [x] 2. Risk spike (manual device checkpoint) — `docs: record spike results and decisions`
- [x] 3. Data model — `feat(db): add the Drizzle schema, first D1 migration and file storage`
- [x] 4. Auth — `feat(auth): add login and setup screens`
- [x] 5. Send authorization — `feat(auth): add send authorization with passkey and TOTP challenges`
- [x] 6. Totals engine — `feat(totals): add the totals engine, money parsing, natura texts and fixtures a-g`
- [x] 7. Profile, onboarding, settings — `feat(onboarding): add profile, settings, setup checklist and AdE guide screens`
- [x] 8. Clients — `feat(clients): add client CRUD with type rules, defaults and a reusable client sheet`
- [x] 9. Invoice editor — `feat(invoices): add the rejected and rejected_expired editor flows with deadline, SdI errors and reissue`
- [x] 10. FatturaPA XML — `feat(fatturapa): map XSD errors to fields in plain language and verify the SdI error codes`
- [x] 11. PDF — `feat(pdf): render the invoice PDF in IT/EN in the browser and store it per transmission attempt`
- [x] 12. PEC channel and send flow — `feat(invoices): add the invoice detail page with downloads, manual AdE channel actions and a state-driven primary action`
- [x] 13. Mailbox polling and SdI receipts — `docs: write the cutover runbook and tick the mailbox polling step`
- [ ] 14. UI polish: Liquid Glass (deferred to a later phase, after step 21)
- [x] 15. Received invoices and imports — `feat(import): import clients from a Fatture in Cloud CSV with a preview, per-row problems and a result screen`
- [x] 16. Lists and dashboard — `feat(dashboard): add the Home top strip with counts and yearly and monthly totals, an overdue filter and skeleton loading`
- [x] 17. Courtesy email — `feat(email): send the courtesy email through Resend from the outbox, with ask and manual modes and a history timeline`
- [x] 18. Push and notifications — `feat(push): notification list, bell, push settings with per-type switches and the service worker deep link`
- [x] 19. Cron jobs, recurring, mailbox quota — `feat(recurring): create recurring invoices exactly once from the daily job, with a templates page and a Repeat action`
- [x] 20. Restore documentation — `docs: document restore with D1 Time Travel and the manual data export`
- [x] 21. Hardening and release — `docs: record hardening and release results and move to verification`

### Verification
- qa: done
  - dialogs and sheets did not lock the page scroll: the CSP blocks the inline style react-remove-scroll injects — `fix(client): keep the page from scrolling behind a dialog despite the CSP blocking the scroll lock style`
  - courtesy email ask banner squeezed its text into a narrow column beside the buttons at 375 px — `fix(ui): let a banner's action wrap under its text so the courtesy email ask is readable at 375 px`
  - notification texts showed dates as 2026-10-01 (list and push) unlike every other date in the app — `fix(notifications): write the dates in a notification in the reader's language instead of as stored`
- review: done
  - a retry after an unknown send unlocked after a poll that hit its per-run caps and left the mailbox (maybe the attempt's receipt) unread, risking a duplicate transmission — `fix(send): unlock a retry after an unknown send only after a poll that drained the mailbox`
  - an XML upload racing a send could swap the attempt's stored XML after the Worker hashed and sent another one (the stored record would differ from what reached the SdI) — `fix(send): bind the send claim to the hashed XML file and refuse an XML upload once an attempt is claimed`
  - the TOTP fallback of the send authorization had no lockout (Better Auth applies neither rate limit nor lockout to a session's verifyTOTP), so a stolen session could guess codes one challenge at a time — `fix(auth): lock the send TOTP fallback after repeated wrong codes with the sign-in lockout counter`
- walkthrough (2026-11-03): done
  - mock channel could not send — `fix(send): treat the mock channel as ready to send`
  - manual AdE channel only reachable after a PEC failure — `fix(send): offer the manual AdE channel from the editor without a PEC failure`
  - send dialog wording for new and reserved numbers — `fix(send): word the send dialog for a new invoice and for a reserved number`
  - rejected-invoice error line had a space before the colon — `fix(invoices): drop the empty code slot from the SdI error line`
  - totals breakdown label wrong in excluded mode — `fix(invoices): label the contribution row after the active cassa mode`
  - fresh DB: login has no way to reach setup — `fix(auth): send a first-run visitor to the setup screen`
  - setup showed the blank create form after the owner was created — `fix(auth): keep the setup flow on its step after the owner account is created`
  - PEC settings said every send needs the passkey — `fix(settings): say a send needs a passkey or an authenticator code`
  - Preview PDF appeared to do nothing — `fix(pdf): make the PDF preview reliable with a download fallback`
- owner follow-ups (2026-11-04): done
  - invoice number showed as 1/2026 on the invoice page and receipts but as 1 in lists, emails, PDF and other notifications — `fix(invoices): show the invoice number as number/year everywhere`
  - PDF engine logged a CSP console error on every Finalize and preview (yoga-layout fetched its inlined WebAssembly as a `data:` URL that `connect-src 'self'` blocks) — `fix(pdf): stop the PDF layout engine fetching a data: URL so the CSP stays strict`
  - the import page's back link always led to Settings, even when opened from Invoices, Received or Clients — `fix(import): return from the import page to the page it was opened from`

### Decisions
- Notification bell on phones (2026-11-04, owner): the strip above the page is gone; below `md` the bell (`components/notifications-link.tsx`, unread badge and count in its accessible name) ends the `Page` title row and the page actions wrap onto their own row under it, so it never collides with Finalize / "⋯" at 375 px. The sidebar keeps its bell on wide screens.
- Clients are listed alphabetically (2026-11-04, owner): `GET /api/clients` sorts by name ignoring case and accents with an Italian `Intl.Collator` (`compareClientNames` in `src/shared/client.ts`; SQLite's `ORDER BY` would put uppercase first and accents last), so the Clients page, the Invoices filter and the editor's client picker all get the same order.
- Import entry only in Settings (2026-11-04, owner): the "Import files"/"Import" buttons on Invoices, Received and Clients are gone; the `from` search param of `/import` and `importBackLink` (commit 879c42a) are removed, so the import page always goes back to Settings.
- Sign out and idle timeout (2026-11-04, owner): a "Sign out" button (Better Auth `signOut`, then `/login`) in the sidebar and at the bottom of Settings (`components/sign-out-button.tsx`); the app shell signs the owner out after `IDLE_TIMEOUT_MS` (10 minutes, `lib/sign-out.ts`) without pointer, key, touch, scroll or focus activity (polling does not count), also checked against the clock on `visibilitychange`/focus so a resumed phone tab signs out at once, and `/login?reason=idle` explains why. The bare `/setup` and `/login` screens have no timer.
- No floating "New invoice" button on phones (2026-11-04, owner): a "New invoice" button (`components/new-invoice-link.tsx`) sits in the title row of Home and Invoices below `md`; the sidebar keeps it on wide screens.
- Setup checklist is a full-width, collapsible `Disclosure` (2026-11-04, owner): open while items remain by default; the open/closed choice is kept per device in `localStorage` (`invoicer.setupChecklistOpen`, always in try/catch).
- The import page goes back to the page it was opened from (2026-11-04, owner): superseded the same day, see the next entry.
- PDF engine and the CSP (2026-11-04, owner): `connect-src` stays `'self'`. yoga-layout (the layout engine of `@react-pdf/renderer`) ships only a base64-inlined WebAssembly and Emscripten fetched that `data:` URL; the `yogaWasmFromBytes` Vite plugin (`vite.config.ts`) hands it the decoded bytes (`wasmBinary`) so it never fetches. The E2E flow fails on any blocked `connect-src` request.
- Invoice numbers are shown as number/year (2026-11-04, owner): the printed number plus the numbering year (`formatNumberWithYear` in `src/shared/numbering.ts`, from `number_raw` and `invoices.year`) in the invoice page, lists, send dialog, courtesy emails (subject, body), notifications and push text, the PDF download name and the number printed on the PDF. The FatturaPA XML `Numero` and file name, received invoices (supplier numbers) and the credit note reference keep the bare number. Imported historic invoices use the same helper.
- A deploy shows on the next refresh (2026-11-04, owner): with `registerType: "autoUpdate"` vite-plugin-pwa 2 no longer adds `skipWaiting`/`clientsClaim` itself (the generated `sw.js` only skipped waiting on a message), so a new worker waited until every tab closed and a refresh kept serving the old precached shell. `workbox.skipWaiting` and `clientsClaim` are now set, the page reloads once when the new worker activates (`reloadForNewVersion` in `src/client/main.tsx`; if a field is focused it waits until the tab is hidden, so a typed form is not lost). `public/_headers`: `no-cache` for `/`, `/index.html`, `/sw.js`, `/push-sw.js` and the manifest, `immutable` for `/assets/*`.
- Company email and phone: optional, sent in CedentePrestatore/Contatti and printed under the sender (owner's choice). The phone is kept as typed; the XML value is its digits (no +/00, Italian 39 dropped if over 12 digits).
- View-mode actions in a "⋯" menu (Edit, Duplicate, Credit note, Payment, Download PDF/XML, Delete); Finalize stays a button (owner's choice).
- Invoice page has a view mode (actions: Duplicate, Delete, Edit, Finalize) and an edit mode (Cancel, Save at the bottom); new and duplicated invoices open in edit mode (owner's choice, 2026-11-03).
- Custom Radix Select and react-day-picker DatePicker on desktop, native controls on phones (owner's choice, 2026-11-03); `@radix-ui/react-select`, `@radix-ui/react-popover` and `react-day-picker` pinned. The Radix Select omits `Select.Viewport` because it injects an inline `<style>` the CSP blocks.
- PDF: From/To parties, no regime, no VAT summary, payment and totals at the bottom of the last page; PDF download named `invoice-<number>-<client>.pdf`, XML keeps the SdI name (owner's choice, 2026-11-03).
- Sent invoices keep their stored PDF; unsent invoices have a Preview (current data and layout, marked PREVIEW, never stored) (owner's choice).
- Bollo charged to the client = a 2.00 line following the no-VAT lines' natura (largest total, first on a tie), in the taxable base, like any line; or borne by the issuer (no line, totals unchanged); `DatiBollo` BolloVirtuale=SI in both cases. Not an N1 line: AdE Circ. 5/E 2021 and Interpello 428/2022 exclude art. 15 for the rebilled stamp. Stored invoices read as `legacy` (2.00 in the total, no line) so their totals do not change. Sources in docs/notes/bollo.md (owner's choice, 2026-11-03).
- Finalised invoices (2026-11-03, owner): no disabled controls (no add-line, no client new/edit buttons); the extras disclosure toggles and shows its fields read-only, so the form is split into fieldsets around it instead of one disabled fieldset.
- Invoices list (2026-11-03, owner): each finalised payable row shows the payment chip (Paid/Unpaid) next to the state badge, with the editor's rule (no chip on unsent, rejected or credit notes); the free-text search filter is removed (URL param, API param, SQL and locale keys).
- Duplicate (2026-11-03, owner): a duplicate is a normal unsent invoice, so its document type stays editable (the select was disabled for every stored record); it is locked only once finalised or rejected.
- Responsive dialogs (centered on desktop, bottom sheet on phones) for finalize/payment; per-invoice language prefilled from the client; payment row: terms or custom days, computed due date, no manual due date (owner's choice, 2026-11-03).
- Options show code + description; due date computed at reservation unless set by hand (2026-11-03, owner).
- Ritenuta base and causale (2026-11-03, owner): the ritenuta rate applies to a configurable share of the amount subject to it (`baseBp`, default 100%, stored in the JSON columns; rows without it read as 100%); the reduced base is rounded to the cent, then the rate; the XML keeps the rate and writes the reduced `ImportoRitenuta`; the causale pagamento is a select of the XSD codes (Z left out, retired in 2021).
- Payment terms: select of invoice date, 15/30/60 gg FM DF (30/60 = last day of the 1st/2nd month after), custom days from invoice date; owner's choice (2026-11-03).
- Client form (2026-11-03, owner): kind as a segmented choice (see the Company/Private line below), only the fields the type needs, fixed codici destinatario not shown as inputs, invoice defaults (cassa and ritenuta flags, terms, PDF language, currency) in a collapsed optional section.
- Client form: Company/Private + country, the type is derived; foreign private persons are supported (IdCodice 99999999999 when no tax ID) (owner's choice, 2026-11-03).
- Fiscal options (regime, cassa, ritenuta) live in Settings > Tax details; clients only flag whether cassa/ritenuta apply; VAT is chosen per line with no default; bollo is a manual invoice checkbox with a hint above 77.47 EUR (owner's choice, 2026-11-03). Cassa and ritenuta are JSON columns of `settings` (`tax_cassa`, `tax_ritenuta`); the regime stays on the profile row, edited from Tax details (`/api/tax`). New clients default to cassa on, ritenuta on for Italian companies only. Older client defaults are read into the flags and are not copied into Tax details.
- Invoice number on the invoice (2026-11-03, owner): the editor prefills the next free number of the year (highest issued app/imported + 1) and the owner may change it before sending; the Worker accepts a requested number only if it is above the highest issued that year and unique; the Settings 'next number' was removed.
- Invoice editor feedback (2026-11-03, owner): single invoice date ("Data fattura", stored in `planned_date`, drives numbering year, due date, XML `Data` and PDF; the operation date is gone); no deferred flag (TD01 only, a past date is allowed, non-blocking warning when sent more than 12 days after the invoice date, art. 21 DPR 633/72); line notes (`invoice_lines.note`, appended to `Descrizione`, 1000 characters together) and an invoice note (`data.note`, `Causale` elements of at most 200 characters, before the natura texts); contribution, ritenuta and bollo in an accordion before the lines; totals show the contribution percentage, the taxable amount without an included contribution and how the ritenuta was computed.
- Editor feedback, lines and actions (2026-11-03, owner): lines are cards with reorder; no drafts for the user: saved invoices are "To send", reminder on the invoice date; actions: Download (PDF/XML) + Send at the top, Delete / Duplicate / Save at the bottom (owner's choice). The AdE "Prepare" path is the last item of the Download menu. `draft`/`planned` stay as stored states and render the same. The reminder is the daily job `src/worker/jobs/invoice-due.ts` (idempotent per invoice and day, 14 days after the date at most); the daily run is now recorded in `job_runs` so it runs once per Rome day. Step 19 builds the other daily jobs on the same hook (`handlers.daily`).
- Numbering series (sezionali) with optional prefix/suffix, yearly progressive per series, client default series; see docs/notes/invoice-numbering.md (2026-11-03, owner).
- Transient confirmations are toasts (@radix-ui/react-toast 1.3.1, CSP-safe; sonner rejected because it injects a runtime style element blocked by style-src 'self'); persistent page messages stay inline (2026-11-03, owner).
- Single-user, self-hosted deployment; generic public code, no owner data in the repo (2026-11-02).
- SdI channel: the owner's PEC mailbox behind a channel interface (SMTP send, IMAP polling every 10 minutes, manual AdE portal channel as fallback); Openapi was the first choice and is now a possible future channel (2026-11-02, superseded by the 2026-11-02 channel switch below).
- Hosting: everything on Cloudflare free plan (Worker static assets + Worker API, D1, Cron Triggers, secrets); Supabase rejected (inactivity pause, weak free backups, higher paid tier) (2026-11-02).
- Files: all files (invoice XML, PDF, received originals, imports) are stored in D1 BLOBs, not R2, which would need a payment card; D1 free plan 5 GB total, max 2 MB per file (a PDF is ~100 KB, an XML ~10 KB), larger files refused; files covered by Time Travel and the JSON export; R2 can come back behind the same storage interface (2026-11-02).
- Domain: the owner's own subdomain (a GitHub Actions variable, never in the repo); project and repo name `invoicer` (2026-11-02).
- Auth: passkey login, email + password + TOTP fallback, sign-up closed after the owner account (2026-11-02).
- Send authorization: every send needs a passkey assertion (TOTP fallback) verified by the Worker and bound to the invoice and its XML hash; it now gates the SMTP send (2026-11-02, replaces the client-side vault).
- Fallback password hashing: reduced PBKDF2 iteration count fitting the free-plan CPU limit, compensated by mandatory TOTP, login rate limit and a generated password (2026-11-02).
- No calendar dates in the plan: Milestone A first, owner decides on FiC renewal (2026-11-02).
- Rejection after the 5-day window becomes `rejected_expired` and is reissued with a new number; the editor warns on late issuance (superseded by the invoice editor feedback line below) (2026-11-02).
- UI: Tailwind + shadcn/ui (Radix), not Material (2026-11-02).
- Courtesy email via Resend from `no-reply@<app-domain>`, configurable Reply-To and BCC, automatic on delivered / not delivered (2026-11-02).
- No end-to-end encryption of business data (owner's own server) (2026-11-02).
- UI and documents in English (base) and Italian via i18n (2026-10-31).
- Frontend React 19 + TanStack, Better Auth for auth, @react-pdf/renderer for PDF, i18next for i18n; all other library choices as in Architecture (2026-11-02).
- TOTP enrolment shows the otpauth URI as a QR code, rendered as inline SVG with `uqr` 0.1.3 (zero dependencies); `qrcode` rejected for its dependencies (2026-11-03, owner request).
- Courtesy email through Resend, not Cloudflare Email Sending (needs Workers Paid) (2026-11-02).
- Channel switch Openapi -> PEC (2026-11-02): Openapi needs a 50 EUR minimum top-up; the owner already has a free PEC mailbox (Aruba infrastructure, provided by a professional association, used for nothing else, tied to the partita IVA), so cost goes to 0 EUR. `PEC_USERNAME`/`PEC_PASSWORD` are Worker secrets (one password for IMAP, SMTP and webmail: if stolen, the mailbox can be read and PEC sent as the owner; accepted for a single-user app, mitigated by a generated password, second factors and the per-send passkey). SMTP send via `worker-mailer` 1.3.0, MIME parsing via `postal-mime` 4.2.0, a minimal in-repo IMAP client; `imapflow` rejected (Node net/tls, heavy dependencies); polling cron `*/10 * * * *` (3 of 5 free cron triggers); credit section replaced by a mailbox quota warning; manual AdE portal channel kept as fallback; Openapi kept as a possible future channel (out of v1).
- Step 12 send handler must compute the SHA-256 of the stored final XML itself and pass it to `verifySendAuthorization`; that check is what binds the authorization to the XML (2026-11-02).
- Totals rules (2026-11-02, owner): VAT on the contribution at the lines' rate; ritenuta on taxable + rivalsa INPS, not on cassa contributo integrativo TC01-TC21 (per-cassa flag; TC22 = INPS, subject); bollo 2.00 only when the invoice's bollo checkbox is on (a hint is shown when natura lines exceed 77.47, the engine's `bolloSuggested`); `included` split per line; half-up rounding to the cent; fixture amounts chosen in step 6 and recorded in the spec; natura legal texts as Italian constants in src/shared; totals in document currency, EUR conversion verified in step 10.
- No notifications for non-SdI PEC messages: the app ignores them and the owner reads them in the Aruba app (2026-11-02).
- Company page (2026-11-03, owner): no default payment terms on the profile (set per invoice; client defaults unchanged); no 'Issuer' heading; the regime fiscale moved to Tax details.

- Liquid Glass styling after Milestone A, as a dedicated step 14 once the real screens exist (2026-11-02, owner request).
- Settings feedback (2026-11-03, owner): issuer profile renamed Company; payment data moved to a Payment methods page holding a list of bank accounts (MP05), one default; invoices snapshot the chosen account and start from the default; no per-client account; back link on every Settings page.
- Payment methods hold no bank name (owner, 2026-11-03); IstitutoFinanziario is omitted from new invoices.
- Step 14 (Liquid Glass) deferred to a later phase; the owner tests the app locally first, then work continues with step 15 (2026-11-03, owner).
- Scheduling (2026-11-02): one cron trigger `*/10 * * * *` only; every run polls the mailbox and the daily jobs run once per Rome day from 09:00 Europe/Rome, tracked in `job_runs` with catch-up of missed ticks. No weekly job, no automatic backup and no monthly reminder: restore relies on D1 Time Travel and the manual "Download all data" export.

- Spike results (docs/notes/spike.md): passkey and Web Push pass on iPhone (iOS 27) and Mac; PBKDF2 at 10,000 iterations; Aruba needs a dedicated mail-client password; the mailbox poll fetches only small MIME parts in the Worker and leaves full invoice/P7M parsing to the browser (2026-11-02).
- FatturaPA XML (step 10, 2026-11-02): XSD v1.2.3 (FPR12; the same file covers FPA12) vendored from fatturapa.gov.it with its SHA-256 in `assets/xsd/README.md`, plus the W3C xmldsig schema it imports; `validateFatturaXml` rewrites the import location in memory because xmllint-wasm does no network access. File names are `IT<idCodice>_<5 base-36 digits>.xml` (upper case), the counter is `file_sequence`, one new value per transmission attempt (`addTransmissionAttempt` for resends), the same string is the `ProgressivoInvio`. Parties are written with `Denominazione` only (the profile and client have a single name field); foreign clients get CAP 00000, no province, and a non-EU client without a tax id gets `IdCodice` 0000000.
- Natura legal text placement (step 10): `RiferimentoNormativo` is limited to 100 characters, so a text that fits goes there whole; a longer one is shortened to its citation (from "art." on, cut at a word boundary with "..." if still too long) and the complete text is written in `Causale` (200-character pieces). The PDF always prints the full text. Free `notes` stay internal and never go into the XML.
- Non-EUR invoices (2026-11-02, owner): the XML uses Divisa = invoice currency with amounts in that currency, as Allegato A allows; no EUR conversion.
- SdI error codes (step 10): the codes of `SDI_ERROR_FIELDS` were checked against Allegato A v1.6 (00305 IdCodice, 00306 CodiceFiscale, 00417 no fiscal id of the cessionario; 00311 CodiceDestinatario; 00400/00401 Natura against AliquotaIVA); the mapping was already right and is now documented and tested.

- PEC channel and send flow (step 12, 2026-11-02): the send handler hashes the stored XML itself, verifies the assertion, and only then creates the channel (no socket before). The attempt is claimed as `send_outcome = unknown` with a pre-generated Message-ID and the SdI address before the SMTP session; success sets `complete`, a definite server refusal (auth, MAIL/RCPT/DATA/body reply) sets it back to `none`, anything else (timeout, closed connection) stays `unknown`, so a crash at any point leaves a state the polling resolves. Retries: latest attempt `none` -> same attempt and file name; `unknown` -> new attempt (new progressive) 15 minutes after the attempt start; `rejected` -> new attempt within the 5-day window, then `sending`. The invoice stays `sending` until step 13 sees the PEC delivery receipt; only the mock channel (`SEND_CHANNEL=mock`, localhost origin only) and the manual channel move it to `sent` directly. Manual AdE: `handed-over` (channel `manual`, outcome `complete`, state `sent`), then `outcome` (delivered / not delivered / rejected with text, written as RC/MC/NS events). PEC settings: the `settings` host/port columns win over the env vars, then the Aruba defaults; saving them clears the last connection test. The connection test has four stages (IMAP login, EXAMINE, quota, SMTP login) and stores the first failing stage's code. Error codes `pec_auth_failed`, `pec_mailbox_full`, `pec_sdi_address_missing`, `pec_unavailable`, `pec_rejected`, `send_outcome_unknown` have README anchors. PDF/XML downloads are `Content-Disposition: attachment`. Browser XSD validation loads the vendored schema with Vite `?raw`; xmllint-wasm bundles for the client only (checked with `pnpm build` and `pnpm check:bundle`).

- Mailbox polling (step 13, 2026-11-02): the first run records the head of the mailbox and ignores older mail, unless a PEC attempt was already sent (then it scans everything once); a UIDVALIDITY change resets the cursor and rescans, deduplicated by Message-ID and UID. Per run caps: 20 messages and 3 MB. Each message is one D1 batch: `pec_messages` row, events, the guarded transition, outbox rows and the cursor. The Worker fetches the whole message (I/O only, raw bytes kept for mail that matters) and runs `postal-mime` only on messages up to 256 KB; larger ones are classified from headers and attachment names and a large received invoice keeps the raw `.eml` as its original (`files.kind = pec_raw`), which the browser unpacks. This replaces the BODYSTRUCTURE part-by-part fetch noted in the spike results: simpler, and the CPU cost it avoided is the parse. Unrelated mail is stored as a bare `ignored` row without bytes (privacy and space); only messages from an SdI address count as SdI messages or received invoices.
- Receipts and transitions (step 13): matching is by the Message-ID we sent (`daticert` `msgid` / `X-Riferimento-Message-ID`) then by invoice file name (SdI messages by the name in the receipt). The PEC delivery receipt must name an SdI recipient to move `sending` to `sent`; RC, MC and NS move to `delivered`, `not_delivered`, `rejected`; each UPDATE is guarded on the state rank and on the message belonging to the invoice's latest attempt, so replays and stale messages change nothing. A matched message resolves an `unknown` attempt to `complete`. A PEC non-delivery or non-acceptance sets the latest attempt's `send_outcome` back to `none` and writes a `PEC_ERROR` event: the retry reuses that attempt's file name (nothing reached the SdI, so the name is unused), contrary to the "new file progressive" in the step 12 carry-over wording; change `retryDecision` if the SdI turns out to reject it. An NS event stores `{ errors: [{ code, description }] }` and `occurred_at` from the PEC message's `Date`. The address stored in `settings.sdi_pec_address` is the sender of the first SdI message that matches one of our files (to confirm at AC 21). The retry after an unknown outcome needs the 15-minute quiet period and a successful poll that started after it (`job_runs`).
- Outbox and notifications (step 13): the outbox delivers `notification` rows into `notifications` on every tick (title = i18n key `notifications.<type>.title`, body = JSON interpolation values), retried from cron; `email` rows (delivered / not_delivered) are queued for step 17 and nothing else consumes them yet. Notifications without an invoice (received invoice, failed poll, oversize or unreadable message) are written in the message's batch; a failed poll raises one notification per code until it is read.
- No internal invoice notes; only the printed invoice note and line notes (owner's choice).
- Save and Finalize (2026-11-03, owner): Save never validates; Finalize runs all checks then numbers and sends (manual channel: XML for the AdE portal); Save disabled until changes everywhere (owner's choice). Implementation: `parseInvoiceDraft` (`src/shared/invoice.ts`) reads a save leniently and the raw editor form is stored in `invoices.editor_form` (migration 0011) and restored for draft and planned invoices; Finalize is the `SendSheet` with a `preflight` (client checks, then save, then `runSendFlow`). There is no channel setting: the PEC when `send.ready`, else the manual channel, which needs only the company details, so `reserve-number` now gates on `profile_incomplete` only and the PEC send route keeps its own readiness gate and the passkey/TOTP authorization. The "Prepare for the AdE portal" menu item is gone. Duplicates of an unsent invoice copy the structured (not the raw) content.
- Invoice page: Duplicate first in the title row; payment recorded from a title-row action with a Paid/Unpaid chip; no transmission or payment sections; line controls only with 2+ lines and before finalisation (owner's choice, 2026-11-03).
- Download all data (step 13): a streamed JSON of every table except the login and push tables (`user`, `session`, `account`, `verification`, `two_factor`, `passkey`, `rate_limit`, `send_challenges`, `push_subscriptions`), which are secrets; files appear as `content_hex`. This narrows "every table" in the plan on purpose.
- "Issued" becomes "Invoices" at `/invoices` listing all invoices, with filters in the URL and a recap: invoiced, to collect, to send (owner's choice, 2026-11-03).

- Received invoices and imports (step 15, 2026-11-04): the Worker never parses an invoice file. The Received page reads each `pending` polled invoice in the browser (XML, P7M with pkijs/asn1js, or the raw PEC message, `pec_raw`, unpacked with postal-mime) and reports the summary with `PUT /api/received/:id/parsed` (or `failed`); the readable view re-reads the original the same way, and "Download original" saves the XML/P7M (unpacked from the `.eml` when needed). Migration 0013 adds `supplier_vat`, `document_type` and `currency` to `received_invoices`. Received invoices are paid/unpaid by hand (no due date, so no overdue). Manual imports send the original as the raw request body with a JSON summary in the `X-Invoicer-Meta` header (`POST /api/received/import`, `POST /api/invoices/import`, 2 MB cap); stored as `files.kind = import`. A received import is a duplicate when the file bytes (SHA-256) or supplier VAT + number + date already exist; an issued import is a duplicate for the same bytes or the same number, date and total in the same series and year, and a `number_conflict` when the number is taken by a different invoice. Imported issued invoices: `source = imported`, state `delivered`, series from `matchSeries`, year from the invoice date, shown read-only from their original file with an "Imported" badge; Edit, Delete, Duplicate and credit note are refused; only the payment flag changes. Only TD01 and TD04 can be imported, files with several documents and files whose supplier is not the owner (issued) or is the owner (received) are skipped with a reason; the import page offers "mark as paid" (default on) because historic invoices are usually settled (owner to confirm); the customer links to an existing client by VAT number, codice fiscale or foreign tax id, else a client is created from the file when it passes the client rules (otherwise none is linked and the result says so). ZIP entries named like SdI receipts and metadata (`_MT_`, `_RC_`, ...) are ignored. Clients CSV: columns matched by header name (Fatture in Cloud export names guessed, each match changeable on the preview), rows checked with the client rules, invalid and duplicate rows (same VAT number, codice fiscale, foreign tax id, else same name and country) skipped with reasons on the result screen. The P7M signature is not verified (the file came through the SdI). `@types/papaparse` 5.5.2 added as a dev dependency for the papaparse typings; `fflate` and `papaparse` are added to the bundle check's client-only markers (`asn1js` cannot be one: the Worker already bundles it through the passkey library).

- Courtesy email (step 17, 2026-11-04): Resend through plain `fetch` (`src/worker/email/`), plain-text body from the `courtesy` keys of `locales/{en,it}/email.json` (the Worker fills `{{name}}` itself, no i18n library) in the invoice's language, From = sender name (else company name) + sender address (else `MAIL_FROM_ADDRESS`), Reply-To and BCC from settings, attachments = the attempt's stored PDF (named `invoice-<number>-<client>.pdf`) and XML, base64 in 32 KB chunks. Polling's `email` outbox row is settled by `processEmailOutbox` right after the notification rows (3 per run): off, not configured (no `email_configured_at`, no `RESEND_API_KEY`, no sender), queued before `email_configured_at` (so rows older than the activation are never sent late) or a client without an email -> `skipped` with the reason in `error`; `ask` -> `asked` plus a `courtesy_email_ask` notification; `automatic` -> sent with `Idempotency-Key: outbox-<row id>`, so a crash after Resend accepted the call retries to the same message. Migration 0014 adds the outbox statuses `asked` and `skipped` and `attempt`, `trigger`, `subject` to `email_log`. A failure (Resend 4xx/5xx or unreachable) writes a failed `email_log` row and a `courtesy_email_failed` notification, is never retried automatically and is answered with `email_failed` (502, README anchor); manual sends use `manual-<requestId>` as key (a retried click reuses it). Manual "Send email" is in the invoice "⋯" menu for any issued app invoice with a stored PDF and answers a pending offer when there is one; the offer card (Review and send / Skip), the editable preview sheet (To, Subject, Message) and the history timeline are `components/courtesy-email.tsx` on the invoice page. The client's address is a prefill only: the sheet lets the owner type one. (owner to confirm: skipped-by-owner offers are not re-offered; saving Email settings restarts the "queued before enabled" cutoff.)

- Push and notifications (step 18, 2026-11-04): `@pushforge/builder` 2.0.5 (exact, as proven in the spike) builds the encrypted, VAPID-signed request in `src/worker/push/send.ts` (seam `pushDeps.fetch`). No push outbox: `processPushNotifications` runs at the end of every cron tick (after the poll, and after the daily jobs) and pushes the `notifications` rows created in the last hour whose new `push_sent_at` is empty (migration 0015), at most 3 rows per tick to at most 5 devices (the subscribe route keeps the newest 5), so the CPU stays bounded. A row is settled when one device took it, when no device is left, or when its type is off; 404/410 deletes the subscription; if every push service failed it stays open and the next tick retries (at-least-once; `tag` = notification id so a device replaces a repeat). Text is written in the Worker from the `notifications.<type>` locale keys (named JSON imports, tree-shaken) in the owner's language, now stored as `settings.ui_language` (the client PUTs it on language change and when it subscribes; default English); per-type switches are `settings.push_disabled_types` (`PUT /api/push/types`, UI in `/settings/notifications`, one checkbox per type, on by default). The deep link is `/invoices/<id>` when the notification has an invoice (the courtesy email offer card lives there), `/received` for a received invoice, else `/notifications`; `public/push-sw.js` (from the spike) handles push and click. The in-app list is `GET /api/notifications` (latest 100, unread count) and `POST /api/notifications/read`; the page `/notifications` and a bell with the unread count (sidebar, and a strip on phones) render every type with a link to its invoice. A missing VAPID secret on subscribe answers `missing_secret` (existing README anchor); the CSP is unchanged. `push_subscriptions` stays out of the data export. (owner to confirm: pushes older than 1 hour are dropped; the bell polls every 60 s; English push text until a language is saved from Settings or a device subscribes.)

- Daily jobs, recurring, mailbox quota (step 19, 2026-11-04): the daily run (`jobs/scheduled.ts` `dailyTasks`: unsent, overdue, recurring, quota) runs each task on its own and records their counts in the `job_runs` row of job `daily` (`-1` = the task failed; any failure makes the run `failed` and the next tick retries, so every task is idempotent). Overdue: one `invoice_overdue` notification per invoice, the first day it is found overdue (same rule as the Home count and filter via `overdueCondition`), app invoices only (imported historic ones are excluded), at most 50 per run. Quota (`pec/quota.ts`): `GETQUOTAROOT` through the read-only IMAP client, else an estimate from `pec_messages` sizes against an assumed 1,024,000 KiB (the Aruba figure of the step 2 probe); each check is a `job_runs` row of job `quota` (counts: used, limit, source), the banner reads the last successful one and compares it with the current threshold (`settings.mail_quota_threshold_kb`, default 50 MB free, set in the PEC settings); only the daily job notifies (`mailbox_quota_low`, none while an unread one exists), "Check now" does not. A poll refused at login raises `mailbox_login_failed` (instead of `poll_failed`) once until read; the red banner (`GET /api/mailbox/status`, `MailboxAlerts` in the app shell) shows while the latest finished poll failed with `login_failed`. Recurring: templates are made from an existing invoice ("Repeat on a schedule" in its menu: its client, lines and settings are copied; the schedule is every 1/2/3/4/6/12 months, a day 1-31 clamped to the month end, a start date, an optional end date and an optional count); the daily job creates an occurrence when its date is within `recurring_lead_days` (default 3, set on the Recurring page, reached from Settings), in one conditional D1 batch (invoice, lines, `recurring_occurrences` row unique on template + date, `recurring_created` notification), so a repeat or a race creates nothing; the invoice is a normal draft or planned one with its due date from the payment terms, never sent. Dates before today are never made up: a new, resumed or edited template records them as skipped occurrences (a row without an invoice), a deleted occurrence invoice stays skipped, only a missed daily run catches up (at most 50 per run). The count limit counts the invoices that exist from the template. Editing a template changes the schedule only (its content is the invoice it was made from; to change it, delete the template and repeat the corrected invoice). `deleteInvoice` now also removes the invoice's notifications and detaches its occurrence (the foreign keys blocked deleting an unsent invoice that had a notification). Owner to confirm: the 50 MB default threshold, one overdue notification per invoice (not daily), and template content not editable.
- Restore documentation (step 20, 2026-11-04): README "Restore" covers D1 Time Travel (7 days free, 30 paid; commands checked against the Cloudflare docs) and the manual export. After a restore the mailbox cursor and `pec_messages` roll back together, so the next poll re-applies receipts newer than the restore point; an invoice sent after the restore point is gone from the app and its receipts show as unmatched SdI messages (recreate it, do not resend). No code changed.
- Hardening and release (step 21, 2026-11-04): spike removed (routes, `/spike` page, viewport diagnostics, `SPIKE_SECRET`, Diagnostics link; `docs/notes/spike.md` stays as history). `spike_kv` was created at runtime and drizzle never knew it, so no migration can drop it and none was hand-written: README "Cleaning up the risk spike" gives the one-off `wrangler d1 execute invoicer --remote --command "DROP TABLE IF EXISTS spike_kv"` (a fresh deploy never has it; the schema test asserts the table is absent). E2E runs against an E2E-only Worker entry (`tests/e2e/worker/entry.ts`, selected by `E2E_WORKER=1` in `vite.config.ts`, never in the production bundle): mock channel, fake IMAP mailbox and captured Resend behind `/api/e2e/*` (404 unless the origin is localhost), fixed secrets, throwaway D1 in `.wrangler/e2e-state`; a Chromium virtual passkey authenticator signs in and authorizes sends. The flows project runs after the smoke projects (they need the empty first-run DB); the smoke test now expects `/` to redirect to `/setup` on an empty DB. Real bug found by the E2E and fixed: the CSP blocked WebAssembly, so the XSD check in Finalize could never run in a browser; `script-src` is now `'self' 'wasm-unsafe-eval'` (no eval, no inline). 375 px pass: no overflow, unnamed control or small tap target on any main screen or dialog (native controls on a coarse pointer), so no source fix; it is an E2E test now. Secrets audit (`src/worker/secrets-audit.test.ts`): sentinel secrets, IMAP/SMTP/Resend/push echoing them, then a search of every API response (headers and body), every D1 table (files as text), the export and all log lines, plus `tests/browser-error-reports.test.ts` (the browser has no error-reporting channel; a non-problem response body is never shown). XSD check: AdE still lists FatturaPA schema 1.2.3 (valid since 2025-04-01, specifications 1.4) and the downloaded file matches the vendored SHA-256; recorded in `assets/xsd/README.md`. Free-plan limits and Workers Paid ($5/month) checked against the Cloudflare and Resend docs (URLs in the README).

- Migration reset (2026-11-04, owner): the remote D1 never had migrations applied and the local data was disposable, so the 16 migrations were replaced by a generated baseline `0000_init` plus a custom `0001_default_series` (the default numbering series row, `Principale`); the data-migration tests of the old 0003/0005/0008 were removed. Migration numbers mentioned in older Decisions refer to the pre-reset history. Compatibility code for older stored shapes (bollo `legacy`, older payment terms) is kept.
- Mailbox quota warning removed (2026-11-04, owner): the PEC provider already warns about a full mailbox, so the app's own warning is not needed. Removed: the "Mailbox space" section of the PEC settings (usage, "Check now", threshold), the daily `quota` task and its `job_runs` records, the low-quota banner, the `mailbox_quota_low` notification (and its push text and locale keys), the threshold setting (`PUT /api/mailbox/quota-threshold`, `POST /api/mailbox/quota`, `settings.mail_quota_threshold_kb`, dropped by migration `0002_ancient_legion`), the stored-message size estimate, and their tests and README text. Kept: the connection test's quota stage and its "Space used" line (step 12), the `pec_mailbox_full` error code (a real SMTP/IMAP refusal), and the mailbox login-failure warning (`GET /api/mailbox/status`, `MailboxAlerts`, `mailbox_login_failed`). The step 19 entry above stays as history.

- Recurring invoices removed for now (2026-11-04, owner: "start light; add it later if needed"): acceptance criterion 12 is out of scope until the feature comes back, and the step 19 recurring parts (and the "Recurring" lines in the entries above, kept as history) no longer apply. Removed: the `recurring_templates` and `recurring_occurrences` tables, `invoices.recurring_template_id` and `settings.recurring_lead_days` (migration `0003_nappy_boomerang`, generated by drizzle; the remote D1 has 0000-0002 applied), the `recurring` daily task, the `/api/recurring` routes, the Recurring page, its Settings link, the "Repeat on a schedule" action in the invoice menu, the `recurring_created` notification type, the shared schedule helpers, their locale keys and tests. Kept: the `deleteInvoice` fix that also deletes the notifications of an unsent invoice (the foreign keys blocked it) with its test, the daily run (unsent, overdue) and everything else from step 19. To bring it back, start from commit d76d680.

### Open questions
- See "Open questions for the architecture phase" in the spec; most are assigned to the step 2 spike.
- Bollo on non-EUR invoices (fixture d): the stamp is a EUR amount; the editor suggests nothing for a non-EUR invoice and fixture d keeps bollo off. The builder writes 2.00 in `DatiBollo` whenever `data.bollo` is set. Decide in step 12 how the editor/PDF handle it.
- Step 15 (from step 13), closed: a large received invoice stored as `pec_raw` is unpacked in the browser (`src/client/import/eml.ts`); `parse_status` moves from `pending` once the Received page reports it.
- Step 17 (from step 13), closed: `email` outbox rows queued before the courtesy email is configured or enabled are marked `skipped`, never sent late (decision below).
- Step 18 (from step 13), closed: push is derived from the delivered `notification` rows (decision below).
- Step 19 (from step 13), closed: the last poll and daily runs are shown in Settings (`GET /api/jobs`), and a poll that failed with `login_failed` feeds the app-wide login warning (decision below).
- SdI details to confirm with the first real messages (AC 21): which address the SdI names in its first reply and whether the sender of its message is that address; the receipt file names (`_RC_001.xml`, `_NS_`, `_MC_`); the real provider receipts replace the hand-written `receipt-fixtures.ts`.
- Step 14+ (from step 12): `xmllint-wasm` adds a 779 KB WASM file to the client precache; consider excluding it from the service worker precache and caching it at first use.
- Test instance (deferred by the owner, 2026-11-04): a separate Worker `invoicer-test` with its own D1, no PEC secrets and the mock channel enabled by an explicit var (today `SEND_CHANNEL=mock` is honoured only on a localhost origin, `isMockChannel` in `src/worker/env.ts`), with a visible TEST band; never mock on production.
- Milestone A exit pending the owner: set the number on the first invoice, send one real invoice through the production PEC mailbox (AC 21), follow the cutover runbook in README.
- Lists and dashboard (step 16, 2026-11-04): most of the step already existed (Invoices list with URL filters, recap, paid/overdue chips, empty and no-result states, mark paid in the invoice menu and on the received detail). Added: Home top strip from `GET /api/invoices/dashboard` (SQL aggregates: to send, rejected incl. expired, overdue unpaid; invoiced this Rome year and month per currency, credit notes subtracted, rejected and unsent excluded; each count links to the Invoices list with `status` and `year=all`); a status filter `overdue` (finalised, not paid, credit notes excluded, due date before today) so the strip's count has a target; `Skeleton`/`ListSkeleton` replace "Loading" text on Home, Invoices and Received lists. Decided not to add mark-paid buttons to list rows (the spec puts it in the invoice menu and the received detail) and no free-text search (owner's removal stands); Home keeps "To send" only, since "Issued" and "Received" are the Invoices and Received pages. Owner to confirm: overdue count and filter ignore credit notes; the strip is hidden on the first-run empty Home.
- Owner tasks (step 21): (1) the timed fresh-account run of the README Deploy guide (target under 45 minutes, AC 1; cannot be done without a new Cloudflare account); (2) the real PEC send of one invoice through the production mailbox with its receipts (AC 21, see the cutover runbook); (3) a real-device push check on the iPhone PWA with the deployed build; (4) on the existing production Worker run the one-off `DROP TABLE IF EXISTS spike_kv` and delete the `SPIKE_SECRET` secret.
- Review findings for the owner (2026-11-04, not fixed): (1) the file progressive starts at `00001`; if files named `IT<vat>_<progressive>.xml` with the owner's VAT number were ever sent to the SdI by other software, the same name is refused as a duplicate (SdI 00002): decide whether to set a starting value before the first real send; (2) the password login works without TOTP until the owner finishes the TOTP step of setup (the UI does not let it be skipped, the Worker does not enforce it); (3) a TOTP code is not remembered once used, so the same code can authorize a second send within its 30-second window; (4) a PDF upload racing a send can still replace the attempt's PDF (courtesy copy only, the XML is guarded); (5) in "ask" mode two overlapping cron ticks could write the courtesy email offer notification twice.
- Known, not fixed: Radix Dialog and Select scroll lock injects an inline `<style>` that the CSP blocks (console warning; the page behind a dialog may still scroll). The `iphone` (WebKit) Playwright project could not run in this environment (browser not installed): run `pnpm exec playwright install webkit` once.

### Next
Verification is done (qa, review, walkthrough); step 14 (Liquid Glass UI polish) stays deferred. Owner tasks: decide whether to publish and deploy (production still runs the step 2 spike build); for the deploy set `BETTER_AUTH_SECRET` and `SETUP_TOKEN`, apply the migrations remotely (`0000_init` and `0001_default_series`, on a remote D1 that has never had migrations), then email (`RESEND_API_KEY`, verified Resend domain) and push (`VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`), following the README Deploy guide; on production Finalize sends for real through the PEC mailbox. Then the owner tasks in Open questions: the step 21 list (timed fresh-account deploy, real PEC send with receipts AC 21, real-device push, `spike_kv` and `SPIKE_SECRET` cleanup), the SdI details to confirm with the first real messages, the review findings (file progressive start value first) and the "owner to confirm" items in Decisions.
