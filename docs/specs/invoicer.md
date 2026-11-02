---
title: Invoicer — simple, free, self-hosted Italian e-invoicing (FatturaPA) web app
status: draft
created: 2026-10-31
updated: 2026-11-02 (plan approved; SdI channel changed from Openapi to PEC)
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
The SdI is reached through the owner's existing PEC mailbox, at no cost.

**Why now:** the owner's FiC subscription ends on 2026-12-31. The tool must be usable for
real invoices in December 2026, so the owner can decide whether to cancel FiC.

**Keywords that settle every trade-off: simple and free.**

## Deployment model

- **Single-user, self-hosted.** One deployment serves one issuer (one partita IVA). The
  owner runs it at `invoicer.vittorioallegra.com` on their own Cloudflare account, with
  their own PEC mailbox. Nobody else's data or credentials ever reach it.
- **Generic code.** The repository is public and contains no owner data: issuer profile,
  domain, sender address and secrets are configuration. Anyone can deploy their own copy
  on their own Cloudflare account, PEC mailbox and domain by following the README.
- **Running cost:** 0 EUR (Cloudflare free plan, Resend free plan, and the owner's existing
  PEC mailbox, which the Ordine degli Ingegneri provides on Aruba infrastructure, tied to the
  partita IVA and used for nothing else). No intermediary, no top-up, no per-invoice fee.

## Architecture (agreed in discussion, details in the plan)

| Part | Technology | Role |
|------|------------|------|
| Frontend | PWA, served as static assets by a Cloudflare Worker | All UI; builds the FatturaPA XML and the PDF; never talks to the PEC servers |
| Backend | Cloudflare Worker (API) | Auth, data API, send authorization, PEC send (SMTP) and mailbox polling (IMAP), push sender, courtesy email sender |
| Database | Cloudflare D1 | Profile, clients, invoices, events, settings |
| Files | Cloudflare D1 (BLOBs, max 2 MB each) | Invoice XML, PDF, received invoice files, imports |
| Scheduled jobs | Cloudflare Cron Triggers | One `*/10 * * * *` trigger: mailbox polling every run; daily jobs (reminders, recurring drafts, quota) at 09:00 Europe/Rome |
| SdI channel | The owner's PEC mailbox: SMTP send and IMAP polling over `cloudflare:sockets` (`worker-mailer`, `postal-mime`, a minimal in-repo IMAP client); defaults are Aruba's `smtps.pec.aruba.it:465` and `imaps.pec.aruba.it:993` | Send, SdI receipts, received invoices |
| Email | Resend | Courtesy email from `no-reply@invoicer.vittorioallegra.com` (configurable) |
| Push | Web Push (VAPID) | Notifications on iPhone (Home screen PWA, iOS 16.4+) and Mac browsers |

The PEC mailbox is reached through a **channel interface**, so other channels can sit
behind it without touching invoices, lists or notifications. The manual AdE portal channel
("Fatture e Corrispettivi" upload) is part of v1 as an always-available fallback; Openapi
(a paid intermediary with a 50 EUR minimum top-up) and similar services are a possible future
channel, out of scope for v1.

Facts this design relies on, with their status (the step 2 spike and `docs/notes/spike.md`
settle the open ones):
- **Cloudflare Workers can open outbound TCP sockets** with implicit TLS (`cloudflare:sockets`),
  so SMTP on 465 and IMAP on 993 work from a Worker. Found (Cloudflare docs); to verify against
  Aruba in the spike.
- **First send goes to `sdi01@pec.fatturapa.it`**; the SdI answers (receipt or rejection) to the
  sending PEC address, and its first reply tells the sender the SdI PEC address to use for later
  sends. Found in secondary guides and older technical specifications; to re-check against the
  current AdE specifications (Allegato A) in the spike.
- **Receipt files** are named after the transmitted file (`<file>_RC_<nnn>.xml`, `_MC_`, `_NS_`,
  and `_NE_`/`_DT_`/`_AT_` for public administration only). Found (secondary); inferred from the
  specifications for the exact pattern; confirm on a real receipt.
- **Size limits:** a PEC message up to 30 MB and an invoice file up to 5 MB are the figures
  quoted by secondary sources; Aruba's own limit and the 2 MB per-blob cap of this app are
  separate (see Open questions).
- **PEC adds its own receipts** (acceptance by the sender's provider, delivery by the SdI mailbox)
  before any SdI message; the app tells them apart from SdI messages.
- **Same mailbox for sending and receiving:** the PEC registered on the AdE portal as the address
  for receiving invoices also receives the SdI's receipts for what the owner sends from it.
- **No read/write split:** the PEC mailbox has one password for IMAP, SMTP and webmail.

## Security model

- **Login:** passkey (WebAuthn, Face ID / Touch ID) as the normal way in; email + password +
  TOTP second factor as the fallback. Sign-up is possible only to create the first (owner)
  account; afterwards it is closed.
- **PEC credentials:** `PEC_USERNAME` and `PEC_PASSWORD` are Worker secrets (write-only in the
  Cloudflare dashboard), never in the database, never sent to the browser. All IMAP and SMTP
  traffic runs in the Worker. The mailbox has a single password for IMAP, SMTP and webmail, so
  no read-only credential exists. **If it is stolen, the thief can read the whole mailbox
  (including official notices sent to this domicilio digitale) and send PEC with legal value as
  the owner.** Accepted for a single-user app on the owner's own server, with these
  mitigations: a unique, long, generated PEC password used only by the app; a second factor on
  the Cloudflare and GitHub accounts; every send still needs a passkey assertion verified by the
  Worker (below); the app only ever reads (EXAMINE, PEEK) and never deletes mail.
- **Explicit confirmation on send:** every send to the SdI needs a fresh passkey check
  (Face ID; TOTP code as fallback), verified by the Worker against a single-use challenge
  bound to that invoice and its final XML, and gating the SMTP send. It doubles as a deliberate
  "yes, send it", so a stray click (or a script running as the owner) never sends an invoice.
- A client-side vault for the PEC password was considered and rejected: whoever can deploy
  code could capture it anyway, so it protected only against a database leak.
- There is no inbound webhook: the Worker only polls the mailbox, so no public endpoint receives
  SdI data. Polling is idempotent (the same message is never stored twice).
- Other Worker secrets: Resend API key (send-only), VAPID private key.
- The database holds business data in plaintext (owner's own server, same trust model as
  FiC). Owner-side hardening is documented in the README: second factor on the Cloudflare and
  GitHub accounts, a dedicated generated PEC password, rotating it after any suspicion.

## Proposed Change (behaviour)

### 1. Setup and onboarding

1. **Deploy (README):** create the Cloudflare resources (Worker, D1, cron), set the
   secrets, connect the GitHub repo for automatic deploys on push to `main`, add the
   subdomain, set the Resend DNS records (SPF, DKIM, DMARC) for the sender subdomain.
2. **First run:** create the owner account (requires the deploy's setup token) and register
   the passkey; set the fallback password + TOTP.
3. **Issuer profile:** name or company name, partita IVA, codice fiscale, address, regime
   fiscale (RF01 ordinario, RF19 forfettario, and the other RF codes in a list), default
   payment data (IBAN, BIC/SWIFT, account holder, bank name), default payment terms, next
   invoice number for the current year (to continue from FiC).
4. **PEC setup, guided:** set `PEC_USERNAME` and `PEC_PASSWORD` as Worker secrets (commands
   shown; use a generated password used only by the app); the settings screen offers presets
   for IMAP/SMTP hosts and ports (Aruba: `imaps.pec.aruba.it:993`, `smtps.pec.aruba.it:465`),
   editable, and a **connection test** (IMAP login + mailbox open + quota if supported, SMTP
   login without sending) that reports exactly what failed. The security trade-off of the
   single PEC password is shown here.
5. **AdE guide:** register the PEC address on the "Fatture e Corrispettivi" portal as the
   address for receiving invoices, so received invoices and SdI receipts reach the mailbox;
   join the free AdE conservazione service. The app does not do conservazione.
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
  - `sent` — handed to the SdI by PEC (the PEC delivery receipt from the SdI mailbox arrived),
    waiting for the SdI outcome.
  - `delivered` — SdI receipt RC.
  - `not_delivered` — SdI receipt MC: the invoice is issued and valid, the client finds it
    in their AdE area; the courtesy email matters most here.
  - `rejected` — SdI receipt NS, with the error codes and messages shown. The owner fixes
    it and resends with the same number and date (allowed within 5 days of the
    rejection); the app shows that deadline.
  - `rejected_expired` — the 5-day window passed: the invoice is reissued as a new
    invoice with a new number and date, referencing the rejected one; the old number
    stays recorded and is never reused.
  - A PEC error before the SdI (SMTP refusal, or a PEC non-delivery message "mancata
    consegna" from the provider) is not a rejection: nothing reached the SdI, so the invoice can
    be resent with the same number and date, with no deadline. It is distinct from an SdI NS.
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
- The daily job (09:00 Europe/Rome) creates a `planned` draft for each occurrence N days ahead (default 3,
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
  and stored → passkey check (Face ID) → the Worker verifies it and sends the XML as a PEC
  attachment over SMTP (implicit TLS, port 465), stores the result (message id, file name) and
  moves the invoice to `sent` once the PEC delivery receipt from the SdI mailbox arrives.
- File name `IT<idcodice>_<progressive>.xml`, which we control; a new progressive for every
  attempt. The first transmission goes to `sdi01@pec.fatturapa.it`; afterwards to the SdI PEC
  address given in the SdI's first reply, stored in settings (rule to re-check in the spike).
- The PDF is generated at send time and stored with the invoice, so the courtesy email can
  be sent later by the server without the browser.
- SdI outcomes arrive as PEC messages in the mailbox. A cron job every 10 minutes polls it
  over IMAP (new UIDs since the last one seen, resuming after any downtime), stores each
  message once, separates PEC receipts (acceptance, delivery, non-delivery) from SdI messages
  (RC, MC, NS and the first reply with the assigned address), matches SdI receipts to
  transmissions by the original file name and updates the state. Unmatched messages are
  listed, never dropped. Polling is the reconciliation: there is no separate job.
- **Manual AdE fallback channel**, always available: export the XML (and PDF) to upload on
  the portal, set the outcome by hand, and import receipts and received invoices from the
  portal's ZIP download (the import of section 5).

### 5. Received invoices

- Arrive as PEC messages found by the mailbox poll (XML or `.p7m` attachment, inside the PEC
  envelope `postacert.eml`). Stored with the original file, shown as a readable invoice
  (supplier, date, number, lines, totals, payment data) with download of the original XML/P7M.
  Each invoice is stored once (idempotent on Message-ID and UIDVALIDITY + UID); P7M parsing
  stays in the browser. Non-SdI PEC messages are ignored by the app (the owner reads them
  in the Aruba app); a message over the 2 MB blob cap is recorded as an error event with a
  notification.
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

### 9. Mailbox quota

- A quota section shows mailbox usage: IMAP `GETQUOTAROOT` when Aruba supports it, otherwise
  an estimate from the size of the stored messages. Below a configurable free-space threshold
  the app shows a banner and sends a push, because a full mailbox stops incoming invoices and
  receipts.
- A failing mailbox login (password changed or expired) is shown prominently with a push,
  since polling and sending both stop.

### 10. Notifications

- Web Push to every subscribed device (iPhone Home screen PWA, Mac browsers), plus an
  in-app list:
  - received invoice;
  - SdI outcome: delivered, not delivered, rejected, PEC send error (non-delivery before the
    SdI), arriving within about 10–15 minutes of the PEC;
  - planned invoice whose date has arrived and is not sent (daily job);
  - issued invoice past due date and still unpaid (daily job);
  - recurring draft created;
  - courtesy email failed;
  - mailbox quota low, mailbox login failing, or an oversize message skipped.
- No notification for PEC messages that are not SdI related.
- Push can be turned on/off per type.

### 11. Internationalisation

- UI base language English with an Italian translation through the i18n mechanism; default
  from the browser language, switchable in settings. PDF and email templates in IT and EN
  through the same mechanism; adding a language means adding a locale file.

## Acceptance Criteria

1. Following the README from a fresh clone, a new Cloudflare account and a PEC mailbox, a
   deployment is up and onboarding (including the PEC connection test) is complete in under
   45 minutes.
2. After the owner account exists, a sign-up attempt is refused.
3. Login works with a passkey, and with email + password + TOTP; a wrong TOTP is refused.
4. Secrets stay where the security model puts them: a test with a known PEC username and
   password asserts they appear in no D1 row, API response, stored message or log line, also
   when the IMAP or SMTP server echoes an error.
5. Sending requires a fresh passkey (or TOTP) check verified by the Worker; a replayed,
   expired or other-invoice assertion is refused, no SMTP connection is opened without it, and
   cancelling leaves the invoice unsent.
6. For each of these fixtures the generated XML passes the official FatturaPA XSD and the
   totals equal the expected values to the cent: (a) RF01 Italian company, 22% VAT,
   ritenuta 20%, rivalsa INPS 4%; (b) RF19 forfettario Italian private person, N2.2 with
   legal text, bollo 2.00; (c) EU company, services under art. 7-ter DPR 633/72, natura N2.1,
   codice destinatario XXXXXXX; (d) non-EU company, N2.1, currency USD;
   (e) cassa previdenziale TC04 with VAT on the contribution; (f) rivalsa INPS 4% in
   `included` mode, typed amount 1,040.00 → base 1,000.00 + contribution 40.00, and typed
   amount 999.99 → base + contribution = 999.99 exactly; (g) TD04 partial credit note
   linked to fixture (a) with DatiFattureCollegate.

   Fixture inputs and expected totals (source of truth, worked out by hand; implemented in
   `src/shared/fixtures/invoices.ts`). Rules: VAT per rate group on the rounded group taxable,
   the contribution takes the group's rate (or natura), ritenuta on lines + rivalsa INPS (not on
   a cassa contributo integrativo), bollo 2.00 added to the amount due, half-up rounding to the
   cent, TD04 amounts positive with the document type giving the sign. Amounts in cents/100.

   | Fix. | Inputs | Contribution | Taxable | VAT | Ritenuta | Stamp | Doc. total | Due |
   |------|--------|-------------:|--------:|----:|---------:|------:|-----------:|----:|
   | a | RF01, IT company; 1 x 1,200.00 + 7.5 x 65.30 (489.75), 22%; rivalsa INPS 4% excluded; ritenuta 20% | 67.59 | 1,757.34 | 386.61 | 351.47 | 0 | 2,143.95 | 1,792.48 |
   | b | RF19, IT private; 1 x 800.00 + 3 x 41.70, N2.2; bollo | 0 | 925.10 | 0 | 0 | 2.00 | 927.10 | 927.10 |
   | c | RF01, EU company (XXXXXXX); 12.5 x 87.30 (1,091.25) + 1 x 250.00, N2.1; bollo | 0 | 1,341.25 | 0 | 0 | 2.00 | 1,343.25 | 1,343.25 |
   | d | RF01, non-EU company (XXXXXXX), USD; 1 x 2,500.00 + 3 x 479.99, N2.1; no bollo (EUR amount, see step 10) | 0 | 3,939.97 | 0 | 0 | 0 | 3,939.97 | 3,939.97 |
   | e | RF01, IT company; 1 x 3,200.00 + 18.5 x 71.30 (1,319.05), 22%; cassa TC04 4% excluded, 22% on the contribution, not subject to ritenuta; ritenuta 20% on 4,519.05 | 180.76 | 4,699.81 | 1,033.96 | 903.81 | 0 | 5,733.77 | 4,829.96 |
   | f1 | RF01, IT company; typed 1,040.00 at 22%; rivalsa INPS 4% included (base 1,000.00 + 40.00) | 40.00 | 1,040.00 | 228.80 | 0 | 0 | 1,268.80 | 1,268.80 |
   | f2 | as f1, typed 999.99 (base 961.53 + 38.46) | 38.46 | 999.99 | 220.00 | 0 | 0 | 1,219.99 | 1,219.99 |
   | g | TD04 linked to (a) (no. 1, 2026-03-15); 3 x 65.30 (195.90), 22%; rivalsa INPS 4% excluded; ritenuta 20% | 7.84 | 203.74 | 44.82 | 40.75 | 0 | 248.56 | 207.81 (signed -207.81) |
7. Using recorded IMAP/SMTP fixtures and a fake socket (no network), a sent invoice goes to
   `sent` on the PEC delivery receipt and then to `delivered`, `not_delivered` or `rejected`
   from the matching SdI message; a rejection shows the SdI error text; a PEC non-delivery
   message leaves the invoice resendable with the same number and date and no deadline.
8. Polling the same mailbox twice creates no duplicate message, invoice, event or notification
   (idempotent on Message-ID and UIDVALIDITY + UID); non-SdI PEC messages are stored as ignored
   and raise no notification; an oversize message becomes an error event with a notification.
9. After simulated downtime (several SdI messages arrive while the cron does not run), the
   next poll resumes from the last seen UID, brings the sent invoice to its final state and
   stores the received invoice; a changed UIDVALIDITY triggers a safe rescan without
   duplicates.
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
    outcome (within 15 minutes of the PEC reaching the mailbox), a planned invoice whose date has arrived and
    an unpaid invoice past due date (within 24 h).
16. A mailbox quota below the threshold shows the banner and sends a push (quota from a
    GETQUOTAROOT fixture, and from the size estimate when the server has no QUOTA); a failing
    login shows the prominent warning.
17. The FiC clients CSV fixture imports all valid rows and lists each invalid row with its
    reason; a ZIP of issued invoice XMLs imports all invoices as `delivered` read-only.
18. The app works in Safari and Chrome on macOS without installing, installs as a PWA on
    iOS Safari (16.4+), and every screen is usable at 375 px width.
19. Hosting costs stay at 0 EUR on the Cloudflare and Resend free plans (limits documented
    in the README).
20. Each test in the Testing Plan states its card:
    `protects=<observable>; fails_when=<wrong result>; no_claim=<what green does not prove>`.
21. No real SdI transmission happens in automated tests (recorded IMAP/SMTP fixtures and a
    fake socket only); one manual end-to-end send of a real invoice through the production PEC
    mailbox, with its receipts, is done and recorded before calling v1 done.

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit | totals engine (VAT per rate, natura, cassa both modes, ritenuta, bollo, rounding) | +20 |
| Unit | XML builder per fixture + XSD validation | +7 |
| Unit | received invoice parsing (XML, P7M), PEC envelope and SdI message classification | +8 |
| Unit | numbering rules, client type rules, recurring schedule | +10 |
| Integration | send authorization: challenge binding, replay, expiry, TOTP fallback | +4 |
| Unit | FiC CSV mapping, ZIP import | +4 |
| Integration | Worker + local D1: auth (passkey, password + TOTP, closed sign-up) | +4 |
| Unit | minimal IMAP client against a fake socket and recorded transcripts | +10 |
| Integration | mailbox polling: idempotency, matching by file name, state transitions, catch-up after downtime, UIDVALIDITY change | +6 |
| Integration | cron jobs: planned due, overdue, recurring, exactly-once | +3 |
| Integration | courtesy email trigger and payload (Resend mocked) | +2 |
| Integration | secrets never stored or returned in plaintext | +2 |
| Integration | PEC send over a fake SMTP socket (attachment, file name, authorization gate) | +2 |
| E2E | login → client → invoice → send (passkey confirm) → receipt → PDF → email | +1 |
| E2E | received invoice via a polled PEC fixture → listed → mark paid | +1 |

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
| Project setup, Worker + D1, deploy pipeline, i18n, PWA shell | 1 day |
| Auth: passkey, password + TOTP fallback, closed sign-up | 1 day |
| Send authorization (passkey assertion verified by the Worker), PEC settings and connection test | 0.5 day |
| Profile, onboarding, AdE guide | 0.5 day |
| Clients + FiC CSV import | 0.5 day |
| Invoice editor + totals engine | 1.5 days |
| XML builder + XSD validation | 1 day |
| PEC channel: SMTP send, minimal IMAP client, mailbox polling, SdI receipts, received invoices, P7M, manual AdE channel | 3.5 days |
| Historic import (XML/P7M/ZIP) | 0.5 day |
| Lists, dashboard, payment flag | 1 day |
| PDF IT/EN + courtesy email (Resend) | 1 day |
| Web Push + cron jobs + mailbox quota section | 1 day |
| Credit notes (TD04) | 0.5 day |
| Recurring templates | 1 day |
| Total | ~14.5 days |

## Out of Scope

- Multi-user or multi-tenant hosting: one deployment, one issuer.
- Public administration invoices (FPA12, NE/DT/AT receipts, digital signature).
- Document types other than TD01 and TD04: advances (TD02), parcels (TD06), foreign
  supplier integration (TD17/18/19), self-invoices.
- Openapi and other paid intermediaries, and SDICoop/SFTP, in v1; the channel interface leaves
  room for them (Openapi needs a 50 EUR minimum top-up, so it is a possible future channel).
- Reading or managing PEC mail unrelated to the SdI (the owner uses the Aruba app).
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
- CPU time of the IMAP and MIME work within the 10 ms free-plan limit (fetch + `postal-mime`
  parse of a typical SdI receipt, a PEC envelope and a large invoice); fallback: smaller fetches,
  `waitUntil`, or Workers Paid with owner approval.
- Aruba: whether IMAP `GETQUOTAROOT` is supported and what the mailbox quota is; whether the
  username is the full PEC address; any SMTP/IMAP rate limit or connection policy.
- SdI address rule: whether every send after the first must go to the address in the SdI's
  first reply, and what that reply looks like (re-check against Allegato A and a real reply).
- Maximum message size accepted by Aruba and by the SdI, against the 2 MB per-blob cap.
- Web Push on iOS: delivery reliability for a Home screen PWA.
- D1 Time Travel retention on the free plan (7 days expected); there is no automatic backup, only the manual "Download all data" export.
- Decided (owner, 2026-11-02): non-EUR invoices keep their original currency in the XML
  (`Divisa` = invoice currency, all amounts in that currency); no EUR conversion.
