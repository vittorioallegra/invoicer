# Step 2 — risk spike

Status: code and desk research done (2026-11-02, revised for PEC); device checks pending (owner checklist below).
The spike page and routes are temporary and are removed in step 20 (`src/worker/spike/`,
`src/client/routes/spike.tsx`, the `/spike` route, `SPIKE_SECRET`). The PEC IMAP client
(`src/worker/pec/imap.ts`), `envelope.ts` and `message-fixtures.ts` are not spike code: step 13 builds on
them. The SdI channel is the owner's PEC mailbox (decision 2026-11-02, replacing Openapi); the app is
reachable at `https://invoicer.vittorioallegra.com/spike` (custom domain, no workers.dev).
`public/push-sw.js` (push and notification-click handlers) stays: step 17 builds on it.

## What was built

| Piece | Where |
|-------|-------|
| Gate: `X-Spike-Secret` header must equal the `SPIKE_SECRET` secret (503 naming the variable if unset, 404 if wrong, so the routes stay hidden) | `src/worker/spike/gate.ts` |
| Passkey: register + assertion verified with `@simplewebauthn/server` 14.0.3, `userVerification: required`, discoverable credential, challenge bound to a caller string (stand-in for invoice id + XML hash) by an HMAC; credential stored in the throwaway D1 table `spike_kv` so a passkey created on iPhone can be used from Mac | `passkey.ts`, `challenge.ts` |
| Web Push: subscribe, send now / after 20 s with `@pushforge/builder` 2.0.5, VAPID from secrets, subscriptions in `spike_kv` | `push.ts`, `public/push-sw.js` |
| CPU probes (one per request): PBKDF2 at 1k–200k iterations, passkey assertion verification (synthetic ES256 fixture), push payload encryption, `postal-mime` parse of an SdI receipt (~1 KB), a PEC envelope (~3 KB) and a ~100 KB invoice message | `cpu.ts`, `fixtures.ts`, `../pec/message-fixtures.ts` |
| PEC probe (gated, skipped with a clear message while `PEC_USERNAME`/`PEC_PASSWORD` are unset): IMAP login + EXAMINE + latest 10 headers + `GETQUOTAROOT`; IMAP fetch + parse of the newest message; SMTP test send of a PEC with a sample XML attachment to the own address only | `src/worker/spike/pec.ts`, `../pec/imap.ts`, `../pec/envelope.ts` |
| Page | `src/client/routes/spike.tsx` (hidden route `/spike`) |

Design notes and limits of the spike:

- **Timing.** Deployed Workers freeze the clock during pure CPU work, so the in-Worker `clockMs`
  usually reads 0 there. Real CPU time per request comes from `wrangler tail` or the dashboard
  (checklist step 7). The page also shows client wall time (includes network, an upper bound only).
- **Challenge.** Stateless (nonce + expiry + HMAC), 120 s TTL, not single-use. Step 5 stores
  single-use challenges in D1 (`send_challenges`); the spike only proves a signature over a
  server challenge bound to a given string verifies, and that a different binding is refused.
- **Cron handlers** (mailbox polling, daily jobs) do not exist yet (the single `*/10 * * * *` trigger is
  registered; the daily jobs run from it at 09:00 Europe/Rome and dispatch to nothing yet); their CPU
  and subrequest counts are measured when steps 13 and 18 are built (the plan keeps `waitUntil` / browser-side
  work as the fallback). Not covered here.
- **`@pushforge/builder` 2.0.5 encrypts with the legacy `aesgcm` content encoding**
  (`Content-Encoding: aesgcm`, `Crypto-Key`/`Encryption` headers), not RFC 8291 `aes128gcm`.
  Whether Apple's push service accepts it is exactly what the iPhone check decides. If Apple
  answers 4xx or the notification never shows, the fallback is a small in-repo `aes128gcm`
  encryptor (Web Crypto, ~60 lines) plus the library's VAPID signing, or another library; revise
  the plan then.
- **IMAP fixtures are hand-written**, modelled on RFC 3501 and PEC/SdI message shapes, not recordings:
  the unit tests of the IMAP client use them with a fake socket. Replace or extend them with real,
  anonymised transcripts and messages from the PEC probe output.
- The spike page text is English only and bypasses i18n on purpose (throwaway).

## Desk research ("also record" list)

Status: `found (source)`, `inferred`, or `unknown – needs the PEC probe/real message`.

| Item | Status | Finding |
|------|--------|---------|
| First send address | found (secondary: informazionefiscale.it, fiscozen.it guides; Allegato A technical specifications, older versions) | The first PEC with an invoice goes to `sdi01@pec.fatturapa.it`. Re-check against Allegato A 1.9.1 (the AdE PDF could not be text-extracted here). |
| Address for later sends | found (secondary, same guides) / inferred for the exact rule | The SdI's first reply (receipt or rejection) tells the sender the PEC address to use for the following sends, sent to the same PEC address the invoice came from. Unknown: whether using `sdi01` again is still accepted, and what that reply looks like; read it in the first real reply (AC 21). |
| Receipt file naming | inferred (Allegato A / SdI message schemas; secondary) | `<NomeFile>_RC_<nnn>.xml` (ricevuta di consegna), `_MC_` (mancata consegna), `_NS_` (notifica di scarto), `_NE_`/`_DT_`/`_AT_` only for public administration. `<NomeFile>` is our file name without extension, which is why we control it. Confirm the exact pattern on the first real receipts. |
| Message size limits | found (secondary) / unknown for Aruba | Quoted figures: PEC message up to 30 MB, one invoice file up to 5 MB. Aruba's own limit and its IMAP/SMTP limits: unknown, check the Aruba docs or the probe. Against our 2 MB per-blob cap in D1. |
| PEC receipts around an SdI send | found (PEC rules, DPR 68/2005) | The sender's provider returns a ricevuta di accettazione; the SdI mailbox returns a ricevuta di avvenuta consegna. Only then do SdI messages (RC/MC/NS) follow. The app treats the PEC delivery receipt as `sent`. A "mancata consegna" PEC message means nothing reached the SdI. |
| PEC envelope shape | inferred | `postacert.eml` carries the original message and `daticert.xml` the certification data. Needs a real sample (the PEC probe lists the attachment names of the newest message). |
| Aruba hosts and ports | found (Aruba help pages, to re-check) | IMAP `imaps.pec.aruba.it:993` (SSL), SMTP `smtps.pec.aruba.it:465` (SSL). Username is believed to be the full PEC address: unknown, the probe settles it. |
| IMAP QUOTA on Aruba | unknown – needs the PEC probe | The probe reports whether `GETQUOTAROOT` works and the numbers; otherwise the app estimates from stored message sizes. |
| Workers outbound TCP with TLS | found (Cloudflare docs `cloudflare:sockets`) | `connect()` with `secureTransport: "on"` gives implicit TLS; port 25 is blocked, 465 and 993 are fine. Needs verification against Aruba in the probe. |
| CPU of IMAP fetch + MIME parse | unknown – needs the deployed probe | Measured per request with `wrangler tail`; pass threshold below 8 ms. |
| D1 Time Travel retention, free plan | found (developers.cloudflare.com/d1/reference/time-travel) | 7 days on Workers Free, 30 days on Workers Paid (point-in-time restore, in place). |
| FatturaPA schema version in force | found (fatturapa.gov.it formato page; ipsoa.it / edotto.com for the dates; agenziaentrate.gov.it Allegato A) | XSD (FPR12, namespace `.../fatture/v1.2`) version **1.2.3**, valid since 2025-04-01. Technical specifications (Allegato A) **1.9.1**, published 2026-03-31, usable from 2026-05-15; secondary sources say the XSD did not change with 1.9.1. The Agenzia PDF could not be text-extracted here: step 10 vendors the XSD from fatturapa.gov.it and checks its version header. |
| Non-EUR invoice, EUR equivalent | found (secondary: ntplusfisco.ilsole24ore.com "operazioni estere imponibile solo euro", older Allegato A) | For resident issuers `Divisa` is expected to be `EUR` and taxable base, VAT and total are in euro; the foreign-currency amount is shown only for management purposes (`AltriDatiGestionali`, PDF copy). So fixture (d) needs an EUR conversion at a stated rate. Not confirmed in the 1.9.1 text itself; verify in step 10 against Allegato A section 2.1.1.2 and the SdI controls. |
| Workers PBKDF2 ceiling | inferred | Cloudflare documents a 100,000 iteration maximum for PBKDF2 in Workers; the 200000 probe shows what the deployed runtime does. |

Sources: informazionefiscale.it (invio fattura elettronica tramite PEC), fiscozen.it (PEC nelle fatture
elettroniche), AdE Allegato A (specifiche tecniche) via informazionefiscale.it, developers.cloudflare.com
(sockets, D1 Time Travel). Secondary sources only; treat every `found (secondary)` row as to be
confirmed with the first real send.

## Owner checklist

Prerequisites: a Cloudflare account (free plan), `pnpm install` done, an iPhone (iOS 16.4+) and a
Mac signed in to the same Apple ID with iCloud Keychain on. Nothing below touches the repo's
tracked files permanently (the temporary config edit is reverted in step 3).

1. **Log in and create resources** (once):
   ```sh
   pnpm exec wrangler login
   pnpm exec wrangler d1 create invoicer          # copy the printed database_id
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
   The Worker is served at the custom domain, `https://invoicer.vittorioallegra.com` (workers.dev is
   disabled). Passkeys are bound to that host name, so they already match the production domain.
4. **Set the secrets** (after the first deploy; each prompts for the value, then paste):
   ```sh
   pnpm exec wrangler secret put SPIKE_SECRET
   pnpm exec wrangler secret put VAPID_PRIVATE_KEY      # the one-line JWK JSON
   ```
   For the PEC checks (step 8), typed by you at the prompt, never pasted in chat or into a file. Use
   a unique, long, generated password for the PEC mailbox, used only by the app:
   ```sh
   pnpm exec wrangler secret put PEC_USERNAME     # the full PEC address
   pnpm exec wrangler secret put PEC_PASSWORD
   ```
   Hosts and ports default to Aruba's (`imaps.pec.aruba.it:993`, `smtps.pec.aruba.it:465`); override
   with the vars `PEC_IMAP_HOST`, `PEC_IMAP_PORT`, `PEC_SMTP_HOST`, `PEC_SMTP_PORT` only if needed.
   The single PEC password reads the whole mailbox and sends PEC as you: see the security model.
5. **Mac Safari:** open `https://invoicer.vittorioallegra.com/spike`, paste `SPIKE_SECRET`, tap **Check gate**: expect
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
   three runs all stay under 8 ms. If `passkey-verify`, `push-encrypt` or a `pec-parse-*` probe fail,
   the plan's named fallback applies (`waitUntil`, smaller fetches or browser-side work). The
   `pec-parse-*` probes parse fixtures and need no PEC secrets; also read the CPU time of the two
   IMAP requests of step 8.
8. **PEC probe** (needs `PEC_USERNAME` and `PEC_PASSWORD`; each button reports `SKIP` with the missing
   variable names otherwise). On the page, section 4:
   - **IMAP login + latest 10 headers + quota.** Pass: `ok: true`, the greeting, `uidValidity`/`uidNext`,
     the latest messages (UID, size, flags, date, Message-ID, from, subject) newest first, and the
     quota (`quotaSupported: true` with used/limit KiB) or `quotaSupported: false`. A failure shows the
     stage (`login_failed`, `closed`, protocol) without the password. Copy the raw output into your
     notes: it answers the greeting, quota and username (full address?) questions.
   - **IMAP fetch + parse newest message.** Pass: `ok: true` with `hasDaticert`, attachment names,
     and `fetchWallMs`/`parseWallMs`. Run it when the newest message is a PEC envelope; a message
     over 512 KB is skipped. Read the request's CPU time (step 7).
   - **SMTP test send to own address.** Pass: `ok: true`, then the message (with `IT00000000000_<n>.xml`
     attached, a sample invoice that is NOT sent to the SdI) shows up in the mailbox, followed by the
     provider's acceptance and delivery receipts. Run the IMAP probe again to see them and their
     senders/subjects (this is the shape step 13 classifies).
   - Pass criteria overall: IMAP and SMTP both connect from the Worker with implicit TLS; each of the
     two IMAP requests and the SMTP request stays under 8 ms CPU; the quota behaviour is known.
   - Optional, for the SdI rules: the first real send happens at cutover (AC 21); until then the
     address and receipt-naming rows of the research table stay `found (secondary)`.
9. **Record real messages:** from the output of step 8 note (anonymised) the PEC receipt subjects and
   sender addresses; they replace the hand-written fixtures in `src/worker/pec/message-fixtures.ts`
   and `imap.fixtures.ts` when step 13 starts.
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
| pec-parse-receipt | | | | |
| pec-parse-envelope | | | | |
| pec-parse-invoice (100 KB) | | | | |

Chosen PBKDF2 iteration count: ______ (highest passing). Fallbacks chosen for failing probes: ______

| PEC probe | Result |
|-----------|--------|
| IMAP greeting, UIDVALIDITY, mailbox size | |
| Username is the full PEC address? | |
| `GETQUOTAROOT` supported (used / limit KiB) | |
| IMAP login + headers: CPU ms (3 runs) | |
| IMAP fetch + parse newest message: CPU ms (3 runs), message bytes | |
| SMTP test send: accepted? CPU ms (3 runs) | |
| PEC acceptance / delivery receipts received (senders, subjects) | |
| Aruba message size limit (docs or support) | |
