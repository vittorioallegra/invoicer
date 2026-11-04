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
- Errors: a failed poll (mailbox unreachable) leaves a failed `job_runs` row and one
  notification until you read it. With the PEC secrets unset the poll does nothing.
- A refused login (password changed or expired) stops polling and sending: the app shows a red
  warning on every screen and sends a push (`mailbox_login_failed`) until a poll works again. Update
  `PEC_PASSWORD` (`wrangler secret put PEC_PASSWORD`) and run the connection test.

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

A full deployment takes under 45 minutes from a fresh Cloudflare account and an existing PEC
mailbox (AC 1). Everything runs on the Cloudflare and Resend free plans (0 EUR). `<angle
brackets>` below are placeholders for your own values; nothing owner-specific is ever committed.

Time it as you go (the "timed run" in the plan): note the clock at the start of each step.

| Step | Target |
|------|--------|
| 1-2 Cloudflare account, repository, D1 database | 10 min |
| 3 Domain and GitHub secrets | 10 min |
| 4 First deploy (CI) | 5 min |
| 5 Worker secrets | 5 min |
| 6 First run: owner, authenticator, passkey | 5 min |
| 7-9 Company details, PEC connection test, AdE portal, email | 10 min (plus DNS propagation for Resend) |

### 1. Prerequisites

- A Cloudflare account (free), with Node 22+ and pnpm locally (`pnpm install`).
- A domain whose DNS is on Cloudflare, where the app gets its own subdomain (for example
  `invoices.<your-domain>`). Passkeys are bound to this host name, so decide it first and do not
  change it later.
- A PEC mailbox (the guide assumes Aruba), with its dedicated mail-client password (see
  [PEC setup](#pec-setup)).
- A GitHub repository holding a copy (fork) of this code.
- Optional: a Resend account (courtesy email to the client).

### 2. Cloudflare resources

```sh
pnpm install
pnpm exec wrangler login
pnpm exec wrangler d1 create invoicer      # prints the database_id: keep it
```

Resources are three: the Worker `invoicer` (created by the first deploy, serves the SPA as static
assets and the API), the D1 database `invoicer`, and the Cron Trigger `*/10 * * * *` declared in
`wrangler.jsonc` (created by the deploy; nothing to click). Migrations are applied by CI
(`pnpm db:migrate:remote`). Migrations are generated by `pnpm db:generate` and never edited by hand.
To run them from your machine, export the variables of step 3 and run
`node scripts/render-wrangler-config.mjs` first (it fills the database id into `wrangler.jsonc`;
never commit the result), then `pnpm db:migrate:remote`.

### 3. Subdomain and GitHub auto-deploy

1. In the GitHub repository add Actions **secrets** `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`, and **variables** `D1_DATABASE_ID`, `APP_DOMAIN` (`invoices.<your-domain>`),
   `APP_ORIGIN` (`https://invoices.<your-domain>`), `MAIL_FROM_ADDRESS` (the sender address, on a domain
   verified in Resend; may stay empty without email), `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT`
   (`mailto:<you>@<your-domain>`) for push (optional; see below).
2. The API token: Cloudflare dashboard > My Profile > API Tokens > Create Token, template "Edit
   Cloudflare Workers", plus the permission Account > D1 > Edit. Scope it to your account (and the
   zone of your domain, for the custom domain).
3. `APP_DOMAIN` makes the deploy attach the Worker to that hostname as a Custom Domain (Cloudflare
   creates the DNS record and the certificate) and switches `workers.dev` off, so the app is only
   reachable on your subdomain.
4. Push notifications (optional): `pnpm exec pushforge vapid` prints a key pair; the public key goes in
   `VAPID_PUBLIC_KEY`, the private one is a Worker secret (step 5).

### 4. First deploy

Push to `main` (or run the workflow). `.github/workflows/deploy.yml` runs lint, typecheck, tests,
build and the bundle check on every push; on `main` it then renders the Worker config from the
variables, applies the D1 migrations and deploys. Later pushes to `main` redeploy the same way. Open
`https://invoices.<your-domain>/api/health`: it answers `{"status":"ok"}`.

### 5. Worker secrets

Secrets are set once per Worker, from your machine (never in the repository or in CI logs):

```sh
pnpm exec wrangler secret put BETTER_AUTH_SECRET   # openssl rand -base64 32
pnpm exec wrangler secret put SETUP_TOKEN          # another random string, used once in step 6
pnpm exec wrangler secret put PEC_USERNAME         # the full PEC address
pnpm exec wrangler secret put PEC_PASSWORD         # the dedicated mail-client password
pnpm exec wrangler secret put RESEND_API_KEY       # optional: courtesy email
pnpm exec wrangler secret put VAPID_PRIVATE_KEY    # optional: push (one-line JWK)
```

The table under [Configuration](#configuration) lists what each one is for. A missing secret shows as
`missing_secret` naming the variable (see [Troubleshooting](#error-missing-secret)); optional ones
only switch their feature off.

### 6. First run

Open the app on your subdomain: on a fresh database it redirects to `/setup`.

- First run (the deploy is public before onboarding): the setup screen asks for `SETUP_TOKEN`,
  creates the owner account, enrols the authenticator app (TOTP, with recovery codes) and registers a
  passkey. Without `SETUP_TOKEN` the setup is refused, and once the owner exists sign-up is closed for
  good. `APP_ORIGIN` must be the public origin: the passkeys are bound to its host name.
- Login: passkey (Face ID / Touch ID) normally; email + password + authenticator code as the
  fallback. Password hashing uses 10,000 PBKDF2 iterations to fit the free-plan CPU limit
  (`docs/notes/spike.md`); the mandatory TOTP, the login rate limit and a generated password
  compensate.
- Scheduling: a single cron trigger (`*/10 * * * *`) in `wrangler.jsonc`. Every run polls the PEC
  mailbox; the daily jobs run once per day from the first run at or after 09:00 Europe/Rome
  (missed runs are caught up). There is no automatic backup: see [Restore](#restore).

Then follow the checklist on Home: company details, PEC connection test ([PEC setup](#pec-setup)),
the AdE portal guide, and the email settings.

### 7. Courtesy email: Resend DNS

Skip this if you do not want the PDF copy emailed to clients. In Resend, add a domain, preferably a
subdomain such as `mail.<your-domain>` (Resend recommends sending from a subdomain to isolate
reputation; source: <https://resend.com/docs/dashboard/domains/introduction>). Resend then shows the DNS
records to create in Cloudflare DNS (set them to "DNS only", not proxied): the **SPF** record (TXT, which
authorizes Resend to send for the domain) and the **DKIM** record (a TXT public key, which signs each
message), plus the return-path MX record it lists. Wait until the domain shows as verified.

Add **DMARC** after verification: a TXT record named `_dmarc.<domain>` with the value
`v=DMARC1; p=none; rua=mailto:<you>@<your-domain>;`. A message passes DMARC when SPF or DKIM passes;
start with `p=none` (monitor only) and tighten to `quarantine` and `reject` once your own invoices pass
(source: <https://resend.com/docs/dashboard/domains/dmarc>). Then create an API key in Resend (set it as
`RESEND_API_KEY`), put the sender address (on the verified domain) in `MAIL_FROM_ADDRESS` or in
Settings > Email, and choose when to send.

### PEC setup and AdE

See [PEC setup](#pec-setup) above for the mailbox (dedicated password, secrets, connection test).
On the Agenzia delle Entrate portal "Fatture e Corrispettivi", register the PEC address as the
address for receiving invoices: Settings > AdE guide in the app lists the steps. Do it only after the
first real invoice has gone through (see the [Cutover runbook](#cutover-runbook)).

### Free-plan limits and Workers Paid

Checked against the Cloudflare and Resend documentation on 2026-11-04.

| What | Free plan | Used by Invoicer |
|------|-----------|------------------|
| Worker requests | 100,000 per day | a single user: a few hundred; the cron adds 144 runs per day |
| Worker CPU | 10 ms per request and per cron run | heavy work (XML/XSD, PDF, P7M) runs in the browser; a poll reads at most 20 messages and 3 MB |
| Cron Triggers | 5 per account | one |
| Subrequests per invocation | 50 | a poll stays far below |
| D1 storage | 5 GB per account, 500 MB per database (paid: 10 GB) | invoices, PDF and XML as BLOBs; hundreds of invoices are a few tens of MB |
| D1 rows | 5 million read and 100,000 written per day | far below |
| D1 BLOB or row size | 2 MB | the app refuses files over the cap |
| D1 Time Travel | 7 days (paid: 30) | see [Restore](#restore) |
| Resend (free) | 100 emails per day, 3,000 per month, 3 domains | one email per invoice |

Sources: <https://developers.cloudflare.com/workers/platform/limits/>,
<https://developers.cloudflare.com/d1/platform/limits/>,
<https://developers.cloudflare.com/d1/platform/pricing/>,
<https://resend.com/docs/knowledge-base/account-quotas-and-limits>.

The 10 ms CPU limit is the one to watch. If the Worker log (`wrangler tail`) or the dashboard shows
"exceeded CPU" errors (for example a poll that fails over a large mailbox), switch the account to
**Workers Paid** ($5 per month minimum; it includes 10 million requests per month and 30 million CPU
milliseconds, with CPU limits of 30 s per request and per cron run; source:
<https://developers.cloudflare.com/workers/platform/pricing/>). No code or configuration change is needed:
the plan is an account setting. This is the only step that costs money, and it is optional.

### Owner hardening checklist

- `SETUP_TOKEN`: after the owner exists the setup is closed for good; you can delete the secret
  (`wrangler secret delete SETUP_TOKEN`) or leave it, it cannot create a second owner.
- Register a passkey on two devices, keep the recovery codes and the authenticator app backup offline.
- Use a generated, unique `PEC_PASSWORD` (it opens the whole mailbox, IMAP, SMTP and webmail alike) and
  change it on Aruba if a device or a log may have exposed it.
- The Cloudflare API token and GitHub repository secrets are the keys to the deployment: scope the
  token to this account, turn on two-factor on Cloudflare and GitHub, and review access once a year.
- Keep `workers.dev` off (the deploy does it when `APP_DOMAIN` is set) and the repository private if it
  holds anything you consider sensitive; it holds no secrets or owner values by design.
- Download all data (Settings) before risky changes and each year-end; store it encrypted.
- Check Settings now and then: the last poll and daily runs, and any banner.
- Dependency versions are pinned exactly; update them deliberately and let CI run the tests.

### Cleaning up the risk spike (existing deployments only)

A deployment made from the step 2 build created a throwaway table `spike_kv` at runtime, outside the
migrations (drizzle never knew it, so no migration can drop it). Remove it once, by hand:

```sh
pnpm exec wrangler d1 execute invoicer --remote --command "DROP TABLE IF EXISTS spike_kv"
```

A fresh deployment never has it. Also delete the obsolete `SPIKE_SECRET` secret if you set it:
`pnpm exec wrangler secret delete SPIKE_SECRET`.

### Updating the XSD

`assets/xsd/README.md` records the vendored FatturaPA schema version, source and SHA-256, and how to
update it.

## Restore

There is no automatic backup and no reminder to take one. Two things protect the data: D1 Time
Travel (an automatic point-in-time history kept by Cloudflare) and the manual "Download all data"
export in Settings.

### D1 Time Travel

Time Travel keeps the history of the database for 7 days on the Workers Free plan (30 days on
Workers Paid). A point older than that cannot be restored. It needs Wrangler 3.4.0 or later.
Source: <https://developers.cloudflare.com/d1/reference/time-travel/>.

```sh
# Bookmark of the current state (write it down before restoring: it is your undo point)
wrangler d1 time-travel info <DATABASE_NAME>
# Bookmark for a past moment (Unix timestamp or RFC3339)
wrangler d1 time-travel info <DATABASE_NAME> --timestamp="2026-01-15T09:30:00+00:00"
# Restore to a moment or to a bookmark
wrangler d1 time-travel restore <DATABASE_NAME> --timestamp=<UNIX_TIMESTAMP>
wrangler d1 time-travel restore <DATABASE_NAME> --bookmark=<BOOKMARK>
```

A restore is destructive: it overwrites the whole database in place and cancels queries in
flight. It prints the bookmark of the state just before, so a wrong restore can be undone by
restoring to that bookmark. Bookmarks are not deleted by restoring.

What a restore rolls back, all of it to the chosen moment:

- Every table: invoices, clients, settings, numbering, notifications and the mailbox cursor.
- The stored files too (XML, PDF, received originals, imports), because they are D1 BLOBs.
- The login: sessions, passkeys and the authenticator secret. A session created after the
  restore point is gone (sign in again); a passkey registered after it must be registered again.
  Push subscriptions made after it are gone too (subscribe again from Settings).

After a restore:

1. Open the app and check the latest invoices, their numbers and states, and the Settings job
   list.
2. The mailbox is the source of truth for SdI receipts and is never changed by the app (the
   IMAP client is read-only). The mailbox cursor (last UID) and the stored message rows were
   rolled back together, so the next poll (within 10 minutes) reads again every message above
   the restored cursor and applies it: receipts received after the restore point are processed
   again, and the invoices they belong to move to the right state. Messages already in the
   restored database are skipped (matched by Message-ID and by UID), so nothing is stored twice.
   Notifications for those messages are created again, as the first time.
3. An invoice sent after the restore point no longer exists in the app, but the SdI got it.
   Its receipts arrive as SdI messages that match no invoice and stay listed in Settings.
   Recreate the invoice with the same number and date (see the original in the PEC webmail
   "Sent" folder or the SdI portal) and do not send it again: it is already with the SdI. Check
   the Fatture e Corrispettivi area of the Agenzia delle Entrate for what the SdI actually holds.
4. Mail the provider already deleted from the mailbox (quota, retention) cannot be re-read.

### Download all data (manual export)

Settings has **Download all data**: a JSON file `{ exportedAt, tables }` with every business table
(invoices, lines, clients, settings, mailbox messages, notifications, jobs, and so on). Files are
included as hexadecimal text in `content_hex` columns (a stored PDF or XML is the hex of its bytes).

It leaves out on purpose the login and push tables (`user`, `session`, `account`, `verification`,
`two_factor`, `passkey`, `rate_limit`, `send_challenges`, `push_subscriptions`), because they are
secrets and a downloaded file is easier to lose than the database. The PEC, Resend and VAPID
secrets are Worker secrets and are never in the database or in the export.

The export is a copy for safekeeping and for reading the data elsewhere, not an automatic restore
path: the app has no import for it. To use it, extract what you need by hand (for example decode the
hex of an XML or PDF), or load the tables into a new D1 yourself, then create the owner again with
`SETUP_TOKEN` and register the passkey and authenticator app again.

Keep it safely: the file holds fiscal and personal data of you and your clients. Download it
before risky changes and at the end of each year, store it encrypted (an encrypted disk or
archive, a password manager attachment), and never in a shared or public folder. Delete old
copies you no longer need. Invoices must be kept for the legal retention period, and the SdI
keeps its own copy of what you sent.

## Troubleshooting

API errors are `application/problem+json` with a stable `code`; the `anchor` field points to
the matching heading below.

First checks for anything odd: `pnpm exec wrangler tail` (live Worker logs; they carry codes, never
secret values), Settings (last poll and daily runs, banners), and `https://<your-domain>/api/health`.

- **The app redirects to `/setup` or shows no owner:** the database is empty, or the D1 id in the
  deploy config points to another database. Check `D1_DATABASE_ID`.
- **Passkey fails with an origin or RP ID error:** `APP_ORIGIN` is not the exact public origin
  (scheme and host) you open the app on.
- **Deploy fails on migrations:** the API token lacks D1 Edit, or `D1_DATABASE_ID` is wrong.
- **Nothing polls the mailbox:** the PEC secrets are unset (the poll then does nothing), or the cron
  trigger was not created; check Settings > last runs and the Triggers tab of the Worker.
- **"Exceeded CPU" in the logs:** see Workers Paid under [Deploy](#free-plan-limits-and-workers-paid).
- **The Finalize check does nothing or fails with a WebAssembly error:** the CSP must allow
  `'wasm-unsafe-eval'` (`public/_headers` equals `src/shared/csp.ts`); do not add a proxy that rewrites
  headers.

Each code below says what happened and how to fix it.

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

### error-email-failed
Resend did not accept the courtesy email (the `detail` carries its status and error name, for
example `resend_422_validation_error`) or could not be reached. Nothing was sent. The failure is in
the invoice's email timeline and raises a notification. Check the sender address (its domain must be
verified in Resend) and `RESEND_API_KEY`, then send again from the invoice's "Send email" action.

### error-missing-secret
A required Worker secret is not set. The response lists the variable names in `missing` and the
fix in `fix`, for example `wrangler secret put PEC_PASSWORD`. Optional features (email,
push) stay off without their secrets and Settings shows a banner; only the "Send email" action
raises this error when `RESEND_API_KEY` is missing, and turning on push on a device raises it
when `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY` or `VAPID_SUBJECT` is missing.
