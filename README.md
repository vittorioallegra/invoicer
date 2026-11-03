# Invoicer

Single-user, self-hosted Italian e-invoicing (FatturaPA) PWA on Cloudflare (Worker + D1 +
Cron), sending to the SdI through the owner's PEC mailbox (SMTP) and polling it (IMAP). Spec: `docs/specs/invoicer.md`. Plan and progress:
`docs/plans/invoicer.md`.

## Local development

Requirements: Node 22+ and pnpm. No external account is needed: D1 runs locally, and
the PEC mailbox, Resend and push are off or mocked.

```sh
pnpm install
cp .dev.vars.example .dev.vars   # local-only values, git-ignored
pnpm dev                         # Vite + local Worker on http://localhost:5173
```

Other commands: `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test:e2e`.
See `CLAUDE.md` for the complete list.

## Configuration

Tracked files contain no owner-specific values. Resource IDs, domain and sender come from
repository variables (CI generates the deploy config from them with
`scripts/render-wrangler-config.mjs`) or from local untracked files.

Worker secrets (set with `wrangler secret put <NAME>`, never committed):

| Name | Needed for |
|------|------------|
| `BETTER_AUTH_SECRET` | sessions |
| `SETUP_TOKEN` | creating the owner account on first run |
| `PEC_USERNAME`, `PEC_PASSWORD` | PEC mailbox (IMAP polling, SMTP send); one password for everything, so it can read the whole mailbox and send PEC: use a unique generated one |
| `RESEND_API_KEY` | courtesy email (optional) |
| `VAPID_PRIVATE_KEY` | push notifications (optional); one-line JWK from `pnpm exec pushforge vapid` |
| `SPIKE_SECRET` | temporary risk-spike page `/spike` (step 2, removed in step 21) |

Plain variables: `APP_ORIGIN`, `MAIL_FROM_ADDRESS`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, and the
optional PEC server overrides `PEC_IMAP_HOST`/`PEC_IMAP_PORT` (default `imaps.pec.aruba.it`:993) and
`PEC_SMTP_HOST`/`PEC_SMTP_PORT` (default `smtps.pec.aruba.it`:465).

`SEND_CHANNEL=mock` (a plain var, `.dev.vars` only) swaps the PEC channel for a mock that sends
nothing and marks the invoice sent; it is ignored unless `APP_ORIGIN` is a localhost address.

### PEC setup

1. In the Aruba PEC panel ("Manage PEC account") generate the dedicated mail-client password;
   the webmail password is refused by IMAP/SMTP.
2. `wrangler secret put PEC_USERNAME` (the full PEC address) and `wrangler secret put PEC_PASSWORD`.
3. Open Settings > PEC mailbox: the Aruba hosts and ports are the presets (editable, stored in
   the `settings` table; a field left empty falls back to the `PEC_*_HOST/PORT` vars, then to the
   defaults). Run the **connection test**: IMAP login, EXAMINE INBOX, mailbox quota (if the server
   has it) and SMTP login, each with its own result. Nothing is sent and no message is read.
   A passing test is required before the first send.
4. The first transmission goes to `sdi01@pec.fatturapa.it`; once the SdI's first reply names an
   address (the sender of its first message about one of our files) it is stored in settings and
   used from then on.
5. The manual AdE channel is always available on a numbered invoice: download the XML and PDF
   from the invoice page, upload them on the Agenzia delle Entrate portal, then record the outcome.

A live check against the real SMTP server exists but is off: set `PEC_LIVE=1` in `.dev.vars` and run
`pnpm vitest run src/worker/pec/live.test.ts --reporter=dot` to send one sample message to your
own PEC address (never to the SdI).

The PEC credentials are never stored in D1 and never returned by the API (Settings only shows
whether each is set). Because the one password gives full mailbox access, every send needs proof
of presence: a passkey assertion with user verification (fallback: a fresh TOTP code), bound to
the invoice and the SHA-256 of its XML and checked by the Worker before any SMTP connection.

### Mailbox polling

Every cron run (every 10 minutes) reads the PEC mailbox over IMAP, read-only: it opens the INBOX
with EXAMINE, fetches only messages above the last UID it processed (with PEEK), and never marks,
moves or deletes anything. The first run starts at the current end of the mailbox (older mail is
ignored), unless an invoice was already sent, in which case the whole mailbox is scanned once. If
the server renumbers the mailbox (UIDVALIDITY changes) it rescans, without storing anything twice.
Each message is stored once; mail that is not about e-invoicing is kept as a bare row (no
content) and never notifies you. Per run at most 20 messages and 3 MB are read; a backlog is
worked off over the next runs. A message over 2 MB is recorded as an error with a notification
and not fetched in full.

- A PEC acceptance receipt only confirms the send. The PEC **delivery receipt from the SdI
  mailbox** moves the invoice from `sending` to `sent`; the SdI's RC, MC and NS messages (matched
  by the invoice file name) move it to `delivered`, `not_delivered` or `rejected`. A rejection
  keeps the SdI error list and its time (the 5-day window starts there). An invoice never moves
  backwards, and only messages about its latest attempt move it.
- A PEC non-delivery message ("mancata consegna" from the provider) means nothing reached the SdI:
  the attempt is open again, to be sent with the same number and date and no deadline.
- Received invoices (XML or `.p7m`) are stored with their original file and are parsed by the
  browser when opened. SdI messages that match no invoice are kept and listed in Settings.
- Settings has **Download all data**, a JSON export of every business table (files as hex; the
  login and push keys are left out).
- Errors: a failed poll (wrong password, mailbox unreachable) leaves a failed `job_runs` row and one
  notification until you read it. With the PEC secrets unset the poll does nothing.

### Cutover runbook

Moving from the previous invoicing tool (FiC) to Invoicer. Milestone A ends with step 3.

1. Import the FiC history (the import arrives with the received-invoices step), or at least set
   the number of the first invoice to the one FiC would issue next (the Number field in the
   invoice editor, prefilled with the next free number of the year; later invoices continue
   from the highest issued number).
2. Stop issuing in FiC. Never issue in both tools in the same period.
3. Send the first real invoice through Invoicer, with the production PEC mailbox, and check that
   it goes `sending` > `sent` > `delivered` (or note the SdI's answer). This is the first
   real test of the SdI rules the code assumes: the address the SdI names in its first reply
   and the receipt file names (`<file>_RC_001.xml`, `_NS_`, `_MC_`).
4. Register the PEC address on the Agenzia delle Entrate portal as the address for receiving
   invoices only once mailbox polling stores received invoices (it does, from this step). To roll
   back, switch the registered address back to FiC's code while FiC is still active.
5. Keep FiC until 2026-12-31 as the fallback.

## Deploy

Skeleton: this section grows with every step; the complete guide is written in step 21.

- GitHub Actions (`.github/workflows/deploy.yml`) runs install, lint, typecheck, test, build and
  the bundle check on every push; on `main` it then applies D1 migrations and deploys.
- Repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Repository variables:
  `D1_DATABASE_ID`, `APP_DOMAIN`, `APP_ORIGIN`, `MAIL_FROM_ADDRESS`,
  `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`.
- First manual deploy (before CI is set up) and the step 2 device checks: follow the owner
  checklist in `docs/notes/spike.md` (create D1, set secrets, generate VAPID keys, deploy, open
  `/spike`). The Worker is served on the custom domain (workers.dev is disabled), e.g.
  `https://invoicer.vittorioallegra.com/spike`.
- First run (the deploy is public before onboarding): set `BETTER_AUTH_SECRET` (a long random
  string, `openssl rand -base64 32`) and `SETUP_TOKEN` (another one) with `wrangler secret put`,
  open the app (on a fresh database it redirects to `/setup`; locally `pnpm dev`
  serves it on http://localhost:5173), and the setup screen creates the owner account (it asks for the token), enrols
  the authenticator app (TOTP, with recovery codes) and registers a passkey. Without
  `SETUP_TOKEN` the setup is refused, and once the owner exists sign-up is closed for good.
  Set `APP_ORIGIN` to the public origin: the passkeys are bound to its host name.
- Login: passkey (Face ID / Touch ID) normally; email + password + authenticator code as the
  fallback. Password hashing uses 10,000 PBKDF2 iterations to fit the free-plan CPU limit
  (`docs/notes/spike.md`); the mandatory TOTP, the login rate limit and a generated password
  compensate.
- Scheduling: a single cron trigger (`*/10 * * * *`) in `wrangler.jsonc`. Every run polls the PEC
  mailbox; the daily jobs run once per day from the first run at or after 09:00 Europe/Rome
  (missed runs are caught up). There is no automatic backup: restore with D1 Time Travel (step 20
  documents it).

## Troubleshooting

API errors are `application/problem+json` with a stable `code`; the `anchor` field points to
the matching heading below.

### error-bad-request
The request body or parameters were invalid. The `detail` field says which.

### error-unauthorized
You are not signed in, or the session expired. Sign in again.

### error-forbidden
The action is not allowed for this account. On the setup screen it means the setup token is
not the value of the `SETUP_TOKEN` Worker secret.

### error-origin-not-allowed
A state-changing call came from a different origin. Use the app from its own address.

### error-send-not-authorized
A send was refused because the passkey assertion or TOTP code was missing, wrong, expired, already
used, or bound to a different invoice or XML. Request a new challenge and answer it again.

### error-not-found
The resource or route does not exist.

### error-conflict
The change conflicts with the current state (for example a number already used). On the setup
screen it means the owner account already exists: setup and sign-up are closed, sign in instead.

### error-number-unavailable
The invoice number you asked for cannot be used: it is not above the highest number already
issued this year (by Invoicer or imported), for example because another device sent an invoice
meanwhile. Nothing was reserved. The editor shows the next free number next to the Number field:
pick it (or a higher one, a gap is allowed) and send again.

### error-payload-too-large
The request body exceeds the size limit.

### error-rate-limited
Too many attempts. Wait and try again. Logins are limited per IP address: five password or TOTP
attempts and ten passkey attempts per minute.

### error-internal-error
Unexpected server error. Check the Worker logs (`wrangler tail`); no secret values are logged.

### error-pec-auth-failed
The PEC server refused the username or password. Aruba needs the dedicated mail-client password
(generated under "Manage PEC account"), not the webmail one. Set it again with
`wrangler secret put PEC_PASSWORD`, then run the connection test in Settings > PEC mailbox.
Nothing was sent.

### error-pec-mailbox-full
The PEC mailbox is over its quota, so the server refused the message. Free space in the mailbox
(the Aruba webmail) and send again. Nothing was sent; the invoice keeps its number and date.

### error-pec-sdi-address-missing
The PEC server did not accept the SdI address. The first send goes to `sdi01@pec.fatturapa.it`;
later sends go to the address the SdI named in its first reply. Check the address and the PEC
setup, then send again. Nothing was sent.

### error-pec-unavailable
The PEC SMTP server could not be reached or refused the connection. Check the hosts and ports in
Settings > PEC mailbox, then retry. Nothing was sent; the manual AdE channel stays available.

### error-pec-rejected
The PEC server refused the message with a permanent reply. Nothing was sent; retry, or use the
manual AdE channel. The invoice keeps its number and date.

### error-send-outcome-unknown
The connection broke while the message was being handed over, so it may or may not have reached
the SdI. The invoice stays in `sending`; the mailbox polling matches the sent message and its
receipts by file name. If nothing is found, a resend (with a new file name) unlocks 15 minutes
after the attempt.

### error-missing-secret
A required Worker secret is not set. The response lists the variable names in `missing` and the
fix in `fix`, for example `wrangler secret put PEC_PASSWORD`. Optional features (email,
push) do not raise this error: they stay off and Settings shows a banner.
