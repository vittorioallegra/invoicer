# Invoicer

Single-user, self-hosted Italian e-invoicing (FatturaPA) PWA on Cloudflare (Worker + D1 + R2 +
Cron), sending through the Openapi SDI API. Spec: `docs/specs/invoicer.md`. Plan and progress:
`docs/plans/invoicer.md`.

## Local development

Requirements: Node 22+ and pnpm. No external account is needed: D1 and R2 run locally, and
Openapi, Resend and push are off or mocked.

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
| `OPENAPI_READ_TOKEN`, `OPENAPI_SEND_TOKEN` | Openapi SDI calls (minimum scopes) |
| `WEBHOOK_SECRET` | authenticating Openapi callbacks |
| `RESEND_API_KEY` | courtesy email (optional) |
| `VAPID_PRIVATE_KEY` | push notifications (optional) |

Plain variables: `APP_ORIGIN`, `MAIL_FROM_ADDRESS`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`.

## Deploy

Skeleton: this section grows with every step; the complete guide is written in step 20.

- GitHub Actions (`.github/workflows/deploy.yml`) runs install, lint, typecheck, test, build and
  the bundle check on every push; on `main` it then applies D1 migrations and deploys.
- Repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Repository variables:
  `D1_DATABASE_ID`, `R2_BUCKET_NAME`, `APP_DOMAIN`, `APP_ORIGIN`, `MAIL_FROM_ADDRESS`,
  `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`.

## Troubleshooting

API errors are `application/problem+json` with a stable `code`; the `anchor` field points to
the matching heading below.

### error-bad-request
The request body or parameters were invalid. The `detail` field says which.

### error-unauthorized
You are not signed in, or the session expired. Sign in again.

### error-forbidden
The action is not allowed for this account.

### error-origin-not-allowed
A state-changing call came from a different origin. Use the app from its own address.

### error-not-found
The resource or route does not exist.

### error-conflict
The change conflicts with the current state (for example a number already used).

### error-payload-too-large
The request body exceeds the size limit.

### error-rate-limited
Too many attempts. Wait and try again.

### error-internal-error
Unexpected server error. Check the Worker logs (`wrangler tail`); no secret values are logged.

### error-missing-secret
A required Worker secret is not set. The response lists the variable names in `missing` and the
fix in `fix`, for example `wrangler secret put OPENAPI_SEND_TOKEN`. Optional features (email,
push) do not raise this error: they stay off and Settings shows a banner.
