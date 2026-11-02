---
title: Invoicer — simple, free, self-hosted Italian e-invoicing (FatturaPA) web app
status: draft
created: 2026-10-31
updated: 2026-11-02 (plan approved)
---

# Invoicer

## Context

Italian VAT-registered freelancers (partita IVA) must issue every invoice as a FatturaPA
XML file through the Agenzia delle Entrate (AdE) exchange system, the SdI. Today the
choice is between the free AdE portal ("Fatture e Corrispettivi"), which is hard to use,
and paid tools such as Fatture in Cloud (FiC), whose base plan bundles many unused
features. The owner issues about 2 invoices and receives about 5 a month, to and from
Italian and foreign clients, and pays for FiC only to do that.

**Goal:** a simple web app (PWA, usable from the browser or installed on Mac and iPhone)
where the owner issues FatturaPA invoices to Italian and foreign clients with any VAT /
exemption setup, sends them to the SdI, follows their delivery, reads received (purchase)
invoices, tracks drafts, planned, issued and paid invoices, gets push notifications, and
has a courtesy copy (PDF in the client's language) emailed to the client automatically.

**Why now:** the owner's FiC subscription ends on 2026-12-31. The tool must be usable for
real invoices in December 2026, so the owner can decide whether to cancel FiC.

**Keywords that settle every trade-off: simple and free.**

## Deployment model

- **Single-user, self-hosted.** One deployment serves one issuer (one partita IVA). The
  owner runs it at `invoicer.vittorioallegra.com` on their own Cloudflare account, with
  their own Openapi account. Nobody else's data or credentials ever reach it.
- **Generic code.** The repository is public and contains no owner data: issuer profile,
  domain, sender address and secrets are configuration. Anyone can deploy their own copy
  on their own Cloudflare account, Openapi account and domain by following the README.
- **Running cost:** 0 EUR for hosting (Cloudflare free plan, Resend free plan). The only
  cost is Openapi usage, pay-as-you-go, about 6 EUR/year at the owner's volume (send
  0.07 EUR, received invoice 0.07 EUR; to re-check at signup).

## Architecture (agreed in discussion, details in the plan)

| Part | Technology | Role |
|------|------------|------|
| Frontend | PWA, served as static assets by a Cloudflare Worker | All UI; builds the FatturaPA XML and the PDF; never calls Openapi |
| Backend | Cloudflare Worker (API) | Auth, data API, send authorization, all Openapi calls, webhook receiver, push sender, courtesy email sender |
| Database | Cloudflare D1 | Profile, clients, invoices, events, settings |
| Files | Cloudflare R2 | Invoice XML, PDF, received invoice files, imports |
| Scheduled jobs | Cloudflare Cron Triggers | Reminders, recurring drafts, reconciliation with Openapi |
| SdI channel | Openapi SDI API (`sdi.openapi.it`, sandbox `test.sdi.openapi.it`) | Send, receipts, received invoices |
| Email | Resend | Courtesy email from `no-reply@invoicer.vittorioallegra.com` (configurable) |
| Push | Web Push (VAPID) | Notifications on iPhone (Home screen PWA, iOS 16.4+) and Mac browsers |

Openapi is reached through a **channel interface**, so other channels (PEC, manual upload
on the AdE portal) can be added later without touching invoices, lists or notifications.

Verified facts this design relies on (2026-11-02):
- Openapi `sdi.openapi.it/invoices` and `oauth.openapi.it/credit` allow browser calls
  (CORS `access-control-allow-origin: *`).
- Openapi tokens carry per-method, per-endpoint scopes and a TTL of up to one year
  (`POST oauth.openapi.it/token`). The credit balance (`GET /credit`) needs the account
  credentials (Basic auth: account email + API key), which can also create tokens.
- Openapi callbacks (`POST /api_configurations`, one configuration per fiscal ID, each
  call overwrites the previous one) cover the events `supplier-invoice`,
  `customer-invoice`, `customer-notification`, `invoice-status-quarantena`,
  `invoice-status-invoice-error`; the callback carries the full invoice object and can
  include an authorization header chosen by us.
- If a callback arrives with no credit left, Openapi suspends the business configuration
  and emails the owner; it must be reactivated with
  `PATCH /business_registry_configurations/{fiscal_id}/activate` after a top-up.
- Openapi does not send courtesy emails to clients.

## Security model

- **Login:** passkey (WebAuthn, Face ID / Touch ID) as the normal way in; email + password +
  TOTP second factor as the fallback. Sign-up is possible only to create the first (owner)
  account; afterwards it is closed.
- **Openapi credentials:**
  1. **Read token** (scopes: list and download invoices, notifications, reactivation of the
     business configuration) and
  2. **Send token** (scope: `POST /invoices`): both stored as Worker secrets (write-only in
     the Cloudflare dashboard), never in the database, never sent to the browser. All
     Openapi calls run in the Worker.
  3. **Account credentials** (email + API key, which can create tokens): never stored by
     the app. A one-time admin token pasted in the setup wizard is used for a single
     configuration request and discarded.
- **Explicit confirmation on send:** every send to the SdI needs a fresh passkey check
  (Face ID; TOTP code as fallback), verified by the Worker against a single-use challenge
  bound to that invoice and its final XML. It doubles as a deliberate "yes, send it", so a
  stray click (or a script running as the owner) never sends an invoice.
- A client-side vault for the send token was considered and rejected: whoever can deploy
  code could capture it anyway, so it protected only against a database leak.
- Webhook endpoint: rejects any call without the configured secret header; replays of the
  same event are idempotent.
- Other Worker secrets: Resend API key (send-only), VAPID private key, webhook secret.
- The database holds business data in plaintext (owner's own server, same trust model as
  FiC). Owner-side hardening is documented in the README: second factor on the Cloudflare,
  GitHub and Openapi accounts, minimum token scopes, token rotation, low Openapi credit.

## Proposed Change (behaviour)

### 1. Setup and onboarding

1. **Deploy (README):** create the Cloudflare resources (Worker, D1, R2, cron), set the
   secrets, connect the GitHub repo for automatic deploys on push to `main`, add the
   subdomain, set the Resend DNS records (SPF, DKIM, DMARC) for the sender subdomain.
2. **First run:** create the owner account (requires the deploy's setup token) and register
   the passkey; set the fallback password + TOTP.
3. **Issuer profile:** name or company name, partita IVA, codice fiscale, address, regime
   fiscale (RF01 ordinario, RF19 forfettario, and the other RF codes in a list), default
   payment data (IBAN, BIC/SWIFT, account holder, bank name), default payment terms, next
   invoice number for the current year (to continue from FiC).
4. **Openapi setup, guided:** sign up on Openapi and top up (link and steps); create the
   read and send tokens with the exact scope list the app shows, and set them as Worker
   secrets (commands shown); with a one-time admin token, the app creates the business
   registry configuration for the partita IVA (no signature, no legal storage) and
   registers the callbacks pointing at its webhook URL. Sandbox mode for trying everything
   first.
5. **AdE guide:** register Openapi's codice destinatario (`JKKZDGR`, re-check at setup) on
   the "Fatture e Corrispettivi" portal so received invoices reach Openapi; join the free
   AdE conservazione service. The app does not do conservazione.
6. **Email settings:** sender name (default the issuer name), sender address, Reply-To
   address (owner's personal email), optional BCC to the owner, courtesy email mode
   (automatic / ask / off).

### 2. Clients

- CRUD for clients: type (Italian company, Italian private person, EU company, non-EU
  company), name, partita IVA and/or codice fiscale, foreign VAT/tax ID with country code,
  address, codice destinatario (7 chars) and/or PEC, email for courtesy copies, PDF
  language (IT or EN), default currency, default VAT/exemption, default rivalsa / cassa /
  ritenuta / bollo settings, default payment terms.
- Field rules derived from type: Italian company needs partita IVA and codice
  destinatario or PEC (default "0000000"); Italian private person needs codice fiscale and
  gets codice destinatario "0000000"; foreign clients get codice destinatario "XXXXXXX".
- Import from a Fatture in Cloud clients CSV export (columns mapped on an import preview;
  rows with errors are shown and skipped, not silently dropped).

### 3. Invoices (TD01)

- Editor with lines (description, quantity, unit price, unit of measure, VAT rate or
  exemption natura per line). Natura codes: N1, N2.1, N2.2, N3.1–N3.6, N4, N5, N6.1–N6.9,
  N7, each with a mandatory or suggested legal reference text (e.g. forfettario:
  "Operazione effettuata ai sensi dell'art. 1, commi 54-89, L. 190/2014").
- Optional per invoice, prefilled from client/profile defaults: rivalsa INPS 4% or a cassa
  previdenziale (TipoCassa TC01–TC22, rate, VAT/natura on the contribution, subject to
  ritenuta or not), with an **amount mode**:
  - `excluded` (default): line amounts exclude the contribution; contribution =
    round(taxable × rate) is added on top. Example: 1,000.00 at 4% → contribution 40.00.
  - `included`: line amounts are agreed "cassa inclusa"; the app splits each amount into
    taxable base = round(amount / (1 + rate)) and contribution = amount − base, so base +
    contribution always equals the typed amount to the cent. Example: 1,040.00 at 4% →
    base 1,000.00, contribution 40.00. The XML and PDF show the base and the contribution,
    never the typed gross amount as a line price.
  - The mode is a client default and can be changed per invoice; the editor shows which
    mode is active next to the totals.
- ritenuta d'acconto (type, rate, causale pagamento); bollo virtuale (2.00 EUR, suggested
  automatically when exempt amounts exceed 77.47 EUR); currency (default EUR); payment
  data (method, IBAN, BIC/SWIFT, holder, due date).
- Totals (taxable per rate, VAT, contribution, withholding, stamp, amount due) are computed
  live and shown before sending.
- States:
  - `draft` — saved, editable, no number assigned.
  - `planned` — draft with a planned issue date; listed under "To issue".
  - `sent` — accepted by Openapi, waiting for the SdI outcome.
  - `delivered` — SdI receipt RC.
  - `not_delivered` — SdI receipt MC: the invoice is issued and valid, the client finds it
    in their AdE area; the courtesy email matters most here.
  - `rejected` — SdI receipt NS, with the error codes and messages shown. The owner fixes
    it and resends with the same number and date (allowed within 5 days of the
    rejection); the app shows that deadline.
  - `rejected_expired` — the 5-day window passed: the invoice is reissued as a new
    invoice with a new number and date, referencing the rejected one; the old number
    stays recorded and is never reused.
  - An Openapi error before the SdI (nothing transmitted) is not a rejection: the invoice
    can be resent with the same number and date, with no deadline.
- Issuance-term warning: the editor has an operation date and warns (without blocking)
  when an immediate invoice is issued more than 12 days after the operation, or a
  deferred invoice after the 15th of the following month (art. 21 DPR 633/72).
  - Payment flag, independent of the above: `unpaid` / `paid` (with paid date), set by hand.
    `overdue` is derived: unpaid and due date passed.
- Numbering: progressive per calendar year, assigned when the invoice is sent; no
  duplicates within a year, also with two devices sending at once; configurable next
  number.
- Sent, delivered and not_delivered invoices are read-only (only payment flag and notes
  change).
- Duplicate an existing invoice into a new draft.

### 3a. Credit notes (TD04)

- "Create credit note" on any issued invoice (delivered or not_delivered): prefilled with
  the original lines, editable for a partial credit; links the original invoice
  (DatiFattureCollegate: number and date). Same states, numbering sequence, transmission,
  PDF and email as invoices. A credit note can also be created without a linked invoice.
- Amounts in a TD04 are positive (the document type gives the sign); totals on the
  dashboard subtract them.

### 3b. Recurring invoices

- A recurring template stores client, lines, settings and a schedule: every N months
  (monthly, quarterly, yearly), day of month, start date, optional end date or count.
- A daily cron job creates a `planned` draft for each occurrence N days ahead (default 3,
  configurable) and notifies the owner. Drafts are never sent automatically.
- Editing a template affects future occurrences only; pausing and deleting a template
  keeps the drafts already created.
- Each occurrence is created exactly once, also if the job runs twice.

### 4. FatturaPA XML and sending

- Generates FatturaPA XML, format FPR12 (B2B/B2C), using the schema version currently in
  force on the AdE site at implementation time (1.2.3 per specifiche tecniche 1.9, to be
  re-checked), validated against the official XSD before sending; validation errors block
  sending and are shown in plain language next to the field.
- Send flow: review screen with totals → "Send" → number reserved, final XML and PDF built
  and stored → passkey check (Face ID) → the Worker verifies it, posts the XML to Openapi,
  stores the result (Openapi uuid, file name) and moves the invoice to `sent`.
- The PDF is generated at send time and stored with the invoice, so the courtesy email can
  be sent later by the server without the browser.
- SdI outcomes arrive through the `customer-notification` and error callbacks and update the
  state. A daily reconciliation job lists recent invoices and notifications from Openapi
  with the read token and fixes any state a missed callback left behind. Unmatched events
  are listed, never dropped.

### 5. Received invoices

- Arrive through the `supplier-invoice` callback (and the daily reconciliation). Stored
  with the original file, shown as a readable invoice (supplier, date, number, lines,
  totals, payment data) with download of the original XML/P7M. Each invoice is stored
  once (idempotent on the Openapi uuid).
- Manual import of received invoice files (XML, P7M, or the ZIP bulk download from the
  AdE portal) for invoices received before the app was set up.
- Payment flag on received invoices as well (paid / unpaid by hand).

### 6. Import of historic issued invoices

- Import of issued invoice files (XML / P7M / ZIP, e.g. the FiC or AdE export). Imported
  invoices are stored with state `delivered`, read-only, and count for numbering checks
  (an imported number blocks reuse of the same number in that year).

### 7. Lists and dashboard

- Home: "To issue" (drafts and planned, planned sorted by date, past planned dates
  highlighted), "Issued" (with state and payment flag), "Received", and a top strip with
  counts: to issue, rejected, overdue unpaid; yearly and monthly invoiced totals.
- Filters: year, month, client/supplier, state, payment flag. Text search on client name
  and invoice number.

### 8. PDF and courtesy email

- PDF of each issued invoice in the client's language (IT or EN), with all FatturaPA data
  relevant to the reader: issuer and client data, lines, VAT/natura and its legal
  reference, contribution, withholding, stamp, totals, currency, payment data (IBAN,
  BIC/SWIFT, holder, due date), and the note that the legally valid invoice is the
  electronic one sent to SdI.
- Courtesy email with the PDF (and the XML) attached, subject and body template per
  language, sent through Resend from the configured sender with the configured Reply-To
  and optional BCC to the owner:
  - mode `automatic`: sent by the Worker as soon as the invoice becomes `delivered` or
    `not_delivered`;
  - mode `ask`: the app proposes it with an editable preview;
  - "Send email" by hand on any issued invoice, also to resend.
- Each send is recorded on the invoice (date, recipient, Resend message id, failure if
  any). A failure raises a notification.

### 9. Openapi credit

- Credit section: estimated balance (top-ups entered by the owner minus counted
  operations at a configurable unit price), recent consumption and an estimate of the
  remaining months, with a link to the Openapi console for the exact figure. The account
  credentials needed for Openapi's balance API are never stored.
- Below a configurable threshold (default 2 EUR) the app shows a banner and sends a push.
- If Openapi suspended the business configuration (detected from Openapi errors or the
  reconciliation job), the app shows it prominently with a "Reactivate" button (calls the
  activate endpoint) and a push notification.

### 10. Notifications

- Web Push to every subscribed device (iPhone Home screen PWA, Mac browsers), plus an
  in-app list:
  - received invoice;
  - SdI outcome: delivered, not delivered, rejected, Openapi error;
  - planned invoice whose date has arrived and is not sent (daily job);
  - issued invoice past due date and still unpaid (daily job);
  - recurring draft created;
  - courtesy email failed;
  - Openapi credit low or configuration suspended.
- Push can be turned on/off per type.

### 11. Internationalisation

- UI base language English with an Italian translation through the i18n mechanism; default
  from the browser language, switchable in settings. PDF and email templates in IT and EN
  through the same mechanism; adding a language means adding a locale file.

## Acceptance Criteria

1. Following the README from a fresh clone, a new Cloudflare account and an Openapi sandbox
   account, a deployment is up and onboarding is complete in under 45 minutes.
2. After the owner account exists, a sign-up attempt is refused.
3. Login works with a passkey, and with email + password + TOTP; a wrong TOTP is refused.
4. Secrets stay where the security model puts them: a test with known token strings
   asserts that the read and send tokens and the one-time admin token appear in no D1 row,
   R2 object, API response or log line.
5. Sending requires a fresh passkey (or TOTP) check verified by the Worker; a replayed,
   expired or other-invoice assertion is refused, and cancelling leaves the invoice unsent.
6. For each of these fixtures the generated XML passes the official FatturaPA XSD and the
   totals equal the expected values to the cent: (a) RF01 Italian company, 22% VAT,
   ritenuta 20%, rivalsa INPS 4%; (b) RF19 forfettario Italian private person, N2.2 with
   legal text, bollo 2.00; (c) EU company, services under art. 7-ter DPR 633/72, natura N2.1,
   codice destinatario XXXXXXX; (d) non-EU company, N2.1, currency USD;
   (e) cassa previdenziale TC04 with VAT on the contribution; (f) rivalsa INPS 4% in
   `included` mode, typed amount 1,040.00 → base 1,000.00 + contribution 40.00, and typed
   amount 999.99 → base + contribution = 999.99 exactly; (g) TD04 partial credit note
   linked to fixture (a) with DatiFattureCollegate.
7. Against the Openapi sandbox, a sent invoice reaches `delivered`, `not_delivered` or
   `rejected` from the matching callback fixture; a rejection shows the SdI error text.
8. The webhook refuses a call without the secret header (401, no state change), and
   replaying the same callback twice creates no duplicate invoice, event or notification.
9. With callbacks disabled, the daily reconciliation job brings a sent invoice to its
   final state and stores a received invoice.
10. A received invoice delivered as `.p7m` is listed with supplier, number, date and total
    matching the source XML.
11. Two invoices in the same year can never get the same number, including two concurrent
    sends and imported numbers; the configured next number is respected.
12. A monthly recurring template on day 1 creates exactly one planned draft per month across
    12 simulated months, also when the job runs twice for the same date.
13. The PDF of fixture (c) is in English and of fixture (b) in Italian, and both show IBAN,
    BIC/SWIFT, holder and due date.
14. In `automatic` mode, an invoice reaching `delivered` and one reaching `not_delivered`
    each trigger exactly one courtesy email (Resend test mode) with the PDF attached and
    the configured From, Reply-To and BCC.
15. With the app closed, push notifications arrive for: a received invoice and an SdI
    outcome (within minutes of the callback), a planned invoice whose date has arrived and
    an unpaid invoice past due date (within 24 h).
16. A credit below the threshold shows the banner; a suspended configuration shows the
    "Reactivate" action, which calls the activate endpoint.
17. The FiC clients CSV fixture imports all valid rows and lists each invalid row with its
    reason; a ZIP of issued invoice XMLs imports all invoices as `delivered` read-only.
18. The app works in Safari and Chrome on macOS without installing, installs as a PWA on
    iOS Safari (16.4+), and every screen is usable at 375 px width.
19. Hosting costs stay at 0 EUR on the Cloudflare and Resend free plans (limits documented
    in the README).
20. Each test in the Testing Plan states its card:
    `protects=<observable>; fails_when=<wrong result>; no_claim=<what green does not prove>`.
21. No real SdI transmission happens in automated tests (Openapi sandbox and recorded
    fixtures only); one manual end-to-end send of a real invoice through the production
    Openapi account is done and recorded before calling v1 done.

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit | totals engine (VAT per rate, natura, cassa both modes, ritenuta, bollo, rounding) | +20 |
| Unit | XML builder per fixture + XSD validation | +7 |
| Unit | received invoice parsing (XML, P7M), Openapi callback payload mapping | +6 |
| Unit | numbering rules, client type rules, recurring schedule | +10 |
| Integration | send authorization: challenge binding, replay, expiry, TOTP fallback | +4 |
| Unit | FiC CSV mapping, ZIP import | +4 |
| Integration | Worker + local D1: auth (passkey, password + TOTP, closed sign-up) | +4 |
| Integration | webhook auth, idempotency, state transitions, reconciliation job | +5 |
| Integration | cron jobs: planned due, overdue, recurring, exactly-once | +3 |
| Integration | courtesy email trigger and payload (Resend mocked) | +2 |
| Integration | secrets never stored or returned in plaintext | +2 |
| Sandbox | send to Openapi sandbox, simulate receipts and a supplier invoice | +2 |
| E2E | login → client → invoice → send (passkey confirm) → receipt → PDF → email | +1 |
| E2E | received invoice via callback → listed → mark paid | +1 |

## Rules for the implementing agent

1. Acceptance criteria are the `protects / fails_when / no_claim` profile of each test: the
   observable it protects, the wrong result it rejects, and what green does not prove.
   Never "make the tests pass".
2. Real code and real tests land in the same change; a placeholder, a stub assertion or a
   test deferred to a follow-up is not done.
3. Any change to a test, validator, CI step, timeout, tolerance, threshold, snapshot or
   suppression pragma is reported on its own line in your summary with its justification,
   before any other result.
4. A reported command names the command and its observed result (exit status, counts, the
   failing line); a command you did not run is not reported, and stderr is never silenced
   in a command you cite.
5. Your report is a claim until the parent re-executes it: say what you verified, what you
   reused, and what you could not check.

## Rollback Plan

New app, no existing users. Rollback = redeploy the previous Worker version (Cloudflare
keeps versions). Database changes go through versioned D1 migrations; a migration that
loses data needs an explicit down step, and D1 Time Travel allows a point-in-time restore.
The owner keeps FiC active until 2026-12-31, so a failed v1 costs no lost invoicing.

## Effort Estimate (CC-assisted)

| Component | Estimate |
|-----------|----------|
| Project setup, Worker + D1 + R2, deploy pipeline, i18n, PWA shell | 1 day |
| Auth: passkey, password + TOTP fallback, closed sign-up | 1 day |
| Send authorization (passkey assertion verified by the Worker), Openapi setup wizard | 0.5 day |
| Profile, onboarding, AdE guide | 0.5 day |
| Clients + FiC CSV import | 0.5 day |
| Invoice editor + totals engine | 1.5 days |
| XML builder + XSD validation | 1 day |
| Openapi channel: send, callbacks, reconciliation, received invoices, P7M | 1.5 days |
| Historic import (XML/P7M/ZIP) | 0.5 day |
| Lists, dashboard, payment flag | 1 day |
| PDF IT/EN + courtesy email (Resend) | 1 day |
| Web Push + cron jobs + credit section | 1 day |
| Credit notes (TD04) | 0.5 day |
| Recurring templates | 1 day |
| Total | ~12.5 days |

## Out of Scope

- Multi-user or multi-tenant hosting: one deployment, one issuer.
- Public administration invoices (FPA12, NE/DT/AT receipts, digital signature).
- Document types other than TD01 and TD04: advances (TD02), parcels (TD06), foreign
  supplier integration (TD17/18/19), self-invoices.
- Other SdI channels in v1 (PEC, AdE manual upload, SDICoop/SFTP); the channel interface
  leaves room for them.
- Courtesy email through the owner's own SMTP account.
- Conservazione a norma (handled by the owner on the AdE portal).
- Accounting, VAT settlement, F24, tax estimates, bank sync, payment reminders to clients.
- Native mobile apps, end-to-end encryption of business data.
- PDF/UI languages other than IT and EN (the i18n mechanism allows adding them later).
- Sending recurring invoices automatically without the owner confirming the send.

## Open questions for the architecture phase

- Cloudflare free plan: 10 ms CPU per request; check password hashing (fallback login),
  Web Push payload encryption and P7M parsing fit, or move them to the browser.
- Passkey library on Workers + D1 (Better Auth with passkey and TOTP plugins): maturity,
  and verifying a send assertion against the passkeys it stores.
- Openapi: callback retries and signing, the exact scope strings for the read and send
  tokens, minimum top-up, sandbox behaviour of `/simulate`.
- Web Push on iOS: delivery reliability for a Home screen PWA.
- D1 Time Travel retention on the free plan, and an extra periodic export (backup to R2 or
  download).
- Whether FatturaPA amounts in a non-EUR currency need an EUR equivalent on the XML or PDF;
  check the current AdE specification.
