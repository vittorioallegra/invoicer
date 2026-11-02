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
  open the app, and the setup screen creates the owner account (it asks for the token), enrols
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

### error-not-found
The resource or route does not exist.

### error-conflict
The change conflicts with the current state (for example a number already used). On the setup
screen it means the owner account already exists: setup and sign-up are closed, sign in instead.

### error-payload-too-large
The request body exceeds the size limit.

### error-rate-limited
Too many attempts. Wait and try again. Logins are limited per IP address: five password or TOTP
attempts and ten passkey attempts per minute.

### error-internal-error
Unexpected server error. Check the Worker logs (`wrangler tail`); no secret values are logged.

### error-missing-secret
A required Worker secret is not set. The response lists the variable names in `missing` and the
fix in `fix`, for example `wrangler secret put PEC_PASSWORD`. Optional features (email,
push) do not raise this error: they stay off and Settings shows a banner.
