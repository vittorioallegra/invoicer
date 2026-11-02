# Step 2 — risk spike

Status: code and desk research done (2026-11-02); device checks pending (owner checklist below).
The spike page and routes are temporary and are removed in step 20 (`src/worker/spike/`,
`src/client/routes/spike.tsx`, the `/spike` route, `SPIKE_SECRET`, `OPENAPI_SANDBOX_TOKEN`).
`public/push-sw.js` (push and notification-click handlers) stays: step 17 builds on it.

## What was built

| Piece | Where |
|-------|-------|
| Gate: `X-Spike-Secret` header must equal the `SPIKE_SECRET` secret (503 naming the variable if unset, 404 if wrong, so the routes stay hidden) | `src/worker/spike/gate.ts` |
| Passkey: register + assertion verified with `@simplewebauthn/server` 14.0.3, `userVerification: required`, discoverable credential, challenge bound to a caller string (stand-in for invoice id + XML hash) by an HMAC; credential stored in R2 (`spike/credentials.json`) so a passkey created on iPhone can be used from Mac | `passkey.ts`, `challenge.ts` |
| Web Push: subscribe, send now / after 20 s with `@pushforge/builder` 2.0.5, VAPID from secrets, subscriptions in R2 | `push.ts`, `public/push-sw.js` |
| CPU probes (one per request): PBKDF2 at 1k–200k iterations, passkey assertion verification (synthetic ES256 fixture), push payload encryption, sample callback parse, Openapi POST dry run | `cpu.ts`, `fixtures.ts` |
| Openapi sandbox: send + `/simulate` receipt + simulated supplier invoice + GET back; callback recorder (headers, retries; can answer 500 on demand) | `openapi.ts` |
| Page | `src/client/routes/spike.tsx` (hidden route `/spike`) |

Design notes and limits of the spike:

- **Timing.** Deployed Workers freeze the clock during pure CPU work, so the in-Worker `clockMs`
  usually reads 0 there. Real CPU time per request comes from `wrangler tail` or the dashboard
  (checklist step 7). The page also shows client wall time (includes network, an upper bound only).
- **Challenge.** Stateless (nonce + expiry + HMAC), 120 s TTL, not single-use. Step 5 stores
  single-use challenges in D1 (`send_challenges`); the spike only proves a signature over a
  server challenge bound to a given string verifies, and that a different binding is refused.
- **Cron handlers** (reconciliation, data export) do not exist yet; their CPU and subrequest
  counts are measured when steps 13, 18 and 19 are built (the plan keeps `waitUntil` / browser-side
  work as the fallback). Not covered here.
- **`@pushforge/builder` 2.0.5 encrypts with the legacy `aesgcm` content encoding**
  (`Content-Encoding: aesgcm`, `Crypto-Key`/`Encryption` headers), not RFC 8291 `aes128gcm`.
  Whether Apple's push service accepts it is exactly what the iPhone check decides. If Apple
  answers 4xx or the notification never shows, the fallback is a small in-repo `aes128gcm`
  encryptor (Web Crypto, ~60 lines) plus the library's VAPID signing, or another library; revise
  the plan then.
- The spike page text is English only and bypasses i18n on purpose (throwaway).

## Desk research ("also record" list)

Status: `found (source)`, `inferred`, or `unknown – needs sandbox/support`.

| Item | Status | Finding |
|------|--------|---------|
| Scope strings, read token | found (console.openapi.com/apis/sdi/documentation; format inferred from the OAuth OAS `/scopes` example) | Scopes are `METHOD:host/resource`. Production host `sdi.openapi.it`, sandbox `test.sdi.openapi.it`. Read token: `GET:sdi.openapi.it/invoices`, `GET:sdi.openapi.it/invoices_download`, `GET:sdi.openapi.it/invoices_notifications` (optionally `GET:sdi.openapi.it/invoices_stats`). Exact string form inside `POST /token` is inferred from the OAuth OAS examples (`POST:domains.altravia.com/domain`); confirm in the console when creating the token. |
| Scope strings, send token | found (same page) | `POST:sdi.openapi.it/invoices` (plain send; `invoices_signature`, `invoices_legal_storage` variants not needed). Setup actions need separate, owner-only scopes (`POST/GET/DELETE api_configurations`, `business_registry_configurations`); they must not be in the Worker tokens. Sandbox simulation scope is listed as `POST:test.sdi.openapi.it/simulate`. Production lists 21 scopes, sandbox 20. |
| Callback signing | found (SDI OAS `ApiConfiguration-write`) | No payload signature. A callback config has `event`, `url`, `auth_header` ("name of the header that will contain your authorization token") and `field`. So authentication is a shared secret in a header; whether `auth_header` is the header name or the full value (the OAS example shows `Bearer 123456789`) is ambiguous: `unknown – needs sandbox` (the spike callback recorder lists the real header names). |
| Callback retry behaviour | unknown – needs sandbox/support | Not documented in the OAS, console docs or FAQ. Test: set the recorder to answer 500, trigger a simulate, watch arrival times (checklist step 9). Reconciliation by polling (`GET /invoices`) stays the safety net regardless. |
| Callback events | found (SDI OAS) | `supplier-invoice`, `customer-invoice`, `customer-notification`, `invoice-status-quarantena`, `invoice-status-invoice-error`, `legal-storage-missing-vat`, `legal-storage-receipt`. A new `POST /api_configurations` replaces the previous one, so all events go in a single call. Callback body: `{event, data: {invoice: {uuid, created_at, filename, file_id, payload}}}`. |
| Minimum top-up | unknown – needs support | Not stated on the console info/FAQ pages. Pricing seen on the console: EUR 0.025 per invoice on subscription, EUR 0.07 per single request (secondary reading; confirm). Credit exhaustion makes `POST /invoices` return 402 (OAS) and stops incoming invoices (FAQ). |
| `/simulate` behaviour | found (SDI OAS) | Sandbox only. `POST /simulate/customer-notification` with `{uuid, notification}` (`NS`, `RC`, `MC`, `NE`, `DT`, `AT`; uuid from a real `POST /invoices`) fires the `customer-notification` callback. `POST /simulate/supplier-invoice` with a JSON invoice (`cessionario_committente...id_codice` = the business fiscal id; codice destinatario irrelevant) fires the `supplier-invoice` callback. Also `legal-storage-receipt`. Whether it works with no callback configured: `unknown – needs sandbox`. |
| Current codice destinatario (to register with AdE to receive) | found (console.openapi.com/apis/sdi/faq) | `JKKZDGR` per the FAQ at the time of reading; re-check in the console before onboarding. Private individuals use `0000000`. |
| D1 Time Travel retention, free plan | found (developers.cloudflare.com/d1/reference/time-travel) | 7 days on Workers Free, 30 days on Workers Paid (point-in-time restore, in place). |
| FatturaPA schema version in force | found (fatturapa.gov.it formato page; ipsoa.it / edotto.com for the dates; agenziaentrate.gov.it Allegato A) | XSD (FPR12, namespace `.../fatture/v1.2`) version **1.2.3**, valid since 2025-04-01. Technical specifications (Allegato A) **1.9.1**, published 2026-03-31, usable from 2026-05-15; secondary sources say the XSD did not change with 1.9.1. The Agenzia PDF could not be text-extracted here: step 10 vendors the XSD from fatturapa.gov.it and checks its version header. |
| Non-EUR invoice, EUR equivalent | found (secondary: ntplusfisco.ilsole24ore.com "operazioni estere imponibile solo euro", older Allegato A) | For resident issuers `Divisa` is expected to be `EUR` and taxable base, VAT and total are in euro; the foreign-currency amount is shown only for management purposes (`AltriDatiGestionali`, PDF copy). So fixture (d) needs an EUR conversion at a stated rate. Not confirmed in the 1.9.1 text itself; verify in step 10 against Allegato A section 2.1.1.2 and the SdI controls. |
| Does Openapi keep our XML file name? | inferred: no | The SDI OAS exposes `sdi_file_name` and callbacks carry `filename`; the OAS sample has filename `IT10442360961ACB24_005EY.xml` for `ProgressivoInvio` `0000001aH8`, so the name is generated by Openapi/SdI, not derived from our value. Confirm: the sandbox flow prints `sdi_file_name` from `GET /invoices/{uuid}`. |
| Whose fiscal ID is in `IT<id>` of the file name | unknown – needs sandbox | Not documented. The OAS example puts the sender's own id in `IdTrasmittente`; check `sdi_file_name` / `filename` in the sandbox output against the fiscal id used (checklist step 8). |
| Parsed fields for received P7M | found for callbacks and list shape; `unknown – needs sandbox` for real P7M | Callbacks (`supplier-invoice`, `customer-invoice`) carry `data.invoice.payload` as parsed JSON (snake_case `fattura_elettronica_header` / `fattura_elettronica_body`). `GET /invoices` items have `payload` (string), `sender`, `recipient`, `sdi_file_name`, `signed`, `marking`, and filters by number, date, VAT id. `GET /invoices_download/{uuid}` returns the raw P7M/XML with `Accept: application/octet-stream`. Whether `payload` is filled for a real signed P7M (the simulated supplier invoice is plain JSON) is unknown; step 14 still parses the P7M in the browser as the plan says. |
| Workers PBKDF2 ceiling | inferred | Cloudflare documents a 100,000 iteration maximum for PBKDF2 in Workers; the 200000 probe shows what the deployed runtime does. |

OpenAPI/OAuth spec locations used: `https://console.openapi.com/oas/en/sdi.openapi.json`,
`https://console.openapi.com/oas/en/oauth.openapi.json`.

## Owner checklist

Prerequisites: a Cloudflare account (free plan), `pnpm install` done, an iPhone (iOS 16.4+) and a
Mac signed in to the same Apple ID with iCloud Keychain on. Nothing below touches the repo's
tracked files permanently (the temporary config edit is reverted in step 3).

1. **Log in and create resources** (once):
   ```sh
   pnpm exec wrangler login
   pnpm exec wrangler d1 create invoicer          # copy the printed database_id
   pnpm exec wrangler r2 bucket create invoicer-files
   ```
2. **Generate the values:**
   ```sh
   openssl rand -base64 32          # -> SPIKE_SECRET (keep it, you type it on each device)
   pnpm exec pushforge vapid        # prints a public key and a one-line private JWK
   ```
3. **Deploy** (manual path; the GitHub workflow works too once its repository secrets/variables
   are set, but it also runs D1 migrations that do not exist yet). Public values are plain vars,
   the private key is a secret:
   ```sh
   D1_DATABASE_ID=<database_id> \
   VAPID_PUBLIC_KEY=<public key printed by pushforge> \
   VAPID_SUBJECT=mailto:<your email> \
   node scripts/render-wrangler-config.mjs
   pnpm run deploy
   git checkout wrangler.jsonc        # drop the local edit afterwards
   ```
   The output prints the Worker URL (`https://invoicer.<account>.workers.dev`). Passkeys are bound
   to that host name; the production domain needs its own registration later.
4. **Set the secrets** (after the first deploy; each prompts for the value, then paste):
   ```sh
   pnpm exec wrangler secret put SPIKE_SECRET
   pnpm exec wrangler secret put VAPID_PRIVATE_KEY      # the one-line JWK JSON
   ```
   Optional, for the Openapi checks (steps 8–9), after creating a sandbox token:
   `pnpm exec wrangler secret put OPENAPI_SANDBOX_TOKEN`.
5. **Mac Safari:** open `<Worker URL>/spike`, paste `SPIKE_SECRET`, tap **Check gate**: expect
   `PASS Gate / ping`. A wrong secret gives 404, an unset secret 503 naming `SPIKE_SECRET`.
6. **iPhone:** open the URL in Safari, Share > **Add to Home Screen**, then open the app from the
   Home screen icon (push only works there). Paste the secret, tap **Check gate**.
   Passkey checks (record every device in the table below):
   - iPhone PWA: **Register passkey** (Face ID, store in iCloud Keychain) then **Sign in with
     passkey** then **Wrong binding must be refused**. Pass: `PASS` on all three.
   - Mac Safari (a normal tab; also try the Dock web app if you like): **Sign in with passkey**
     must offer the iCloud passkey made on the iPhone without a QR code or "other device" step.
     Pass: `PASS`. Optionally register on the Mac and sign in from the iPhone (reverse).
   - Web Push, iPhone PWA and Mac: **Subscribe this device** (allow notifications), **Send push
     now** (banner appears while the app is open), then **Send push in 20 s**, fully close the
     app (iPhone: swipe it away in the app switcher and lock the phone; Mac: quit the web app or
     close the tab), and wait up to 30 s. Pass: a notification appears with the app closed, and
     tapping it opens `/spike`. On failure tap **Show subscriptions / last send**: HTTP 201 from
     the push host means it was accepted (then the problem is delivery); 400/403/410 means it was
     refused (note the status; see the `aesgcm` note above).
7. **CPU time.** In a terminal run `pnpm exec wrangler tail invoicer --format json`. In the page
   tap **Run all probes** (and each PBKDF2 button three times). For every request, read the CPU
   time from the tail output (field `cpuTime` when present); if your wrangler version does not
   print it, open Cloudflare dashboard > Workers & Pages > invoicer > Observability (invocation
   logs show CPU time per request) or Metrics (CPU time percentiles). An `1102` error means the
   10 ms limit was exceeded. Pass thresholds (free plan limit is 10 ms): each probe under 8 ms
   including request overhead; the PBKDF2 iteration count to adopt is the highest count whose
   three runs all stay under 8 ms. If `passkey-verify`, `push-encrypt` or `callback-parse` fail,
   the plan's named fallback applies (`waitUntil` or browser-side work). The `openapi-dry-run`
   probe posts a deliberately invalid invoice (expected HTTP 400, no credit used) and is skipped
   with a clear message while `OPENAPI_SANDBOX_TOKEN` is unset.
8. **Openapi sandbox flow** (only when you have a sandbox token): in the console create a sandbox
   token whose scopes cover `test.sdi.openapi.it` invoices (GET and POST), `invoices_notifications`,
   `invoices_download` and `simulate`, plus a setup token (or use the console UI) for
   `business_registry_configurations` and `api_configurations`. With the setup token as `$TOKEN`:
   ```sh
   curl -X POST https://test.sdi.openapi.it/business_registry_configurations \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"fiscal_id":"<11-digit test id>","name":"Spike","email":"<you>","apply_signature":false,"apply_legal_storage":false}'
   ```
   Then on the page enter that fiscal id (and keep codice destinatario `0000000`) and tap
   **Send + simulate receipt + supplier invoice**. Pass: `POST /invoices` returns a uuid, the
   `RC` simulation returns success, `GET /invoices/{uuid}` shows the invoice (note `marking` and
   `sdi_file_name`), the supplier-invoice simulation returns success. Copy the raw output into
   your notes: it answers the file-name and `IT<id>` questions above.
9. **Callbacks** (optional but answers the retry and header questions): register the recorder as
   the callback target in a single call (a new config replaces the old one):
   ```sh
   curl -X POST https://test.sdi.openapi.it/api_configurations \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"fiscal_id":"<same id>","callbacks":[
       {"event":"customer-notification","url":"<Worker URL>/api/webhooks/spike-callback","auth_header":"Bearer <SPIKE_SECRET>"},
       {"event":"supplier-invoice","url":"<Worker URL>/api/webhooks/spike-callback","auth_header":"Bearer <SPIKE_SECRET>"}]}'
   ```
   Re-run the sandbox flow, then **Show recorded callbacks**: the header names Openapi sent
   (does `Authorization` arrive, or a header literally named after the value?) and the payload.
   For retry behaviour tap **Callback answers 500**, run the flow again, and re-read the records
   after a few minutes to see whether and when Openapi re-sends; then **Callback answers 200**.
   If nothing is recorded, `rejected` counts calls that failed the secret and
   `lastRejectedHeaderNames` shows what they carried.
10. **Clean up:** `pnpm exec wrangler secret delete SPIKE_SECRET` (this switches the spike off) when
    done, or leave it until step 20.

### Results (owner fills in)

| Check | iPhone Home screen PWA | Mac Safari | Notes |
|-------|------------------------|------------|-------|
| Gate (step 5/6) | | | |
| Passkey register | | | |
| Passkey assertion verifies | | | |
| Wrong binding refused | | | |
| iCloud passkey from the other device (no QR) | | | |
| Push subscribe | | | |
| Push shown with app open | | | |
| Push shown with app closed (20 s test) | | | |
| Push service status (last send) | | | |

| CPU probe | CPU ms run 1 | run 2 | run 3 | Pass (< 8 ms)? |
|-----------|--------------|-------|-------|----------------|
| PBKDF2 1,000 | | | | |
| PBKDF2 5,000 | | | | |
| PBKDF2 10,000 | | | | |
| PBKDF2 20,000 | | | | |
| PBKDF2 50,000 | | | | |
| PBKDF2 100,000 | | | | |
| PBKDF2 200,000 (limit check) | | | | |
| passkey-verify | | | | |
| push-encrypt | | | | |
| callback-parse | | | | |
| openapi-dry-run | | | | |

Chosen PBKDF2 iteration count: ______ (highest passing). Fallbacks chosen for failing probes: ______

| Openapi sandbox | Result |
|-----------------|--------|
| POST /invoices (uuid, status) | |
| RC simulation | |
| `sdi_file_name` / `filename` and the id used in `IT<id>` | |
| Supplier invoice simulation and callback payload | |
| Callback headers received | |
| Callback retry behaviour (500 test) | |
| Minimum top-up (console or support) | |
