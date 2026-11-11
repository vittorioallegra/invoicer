// Worker entry used only by the E2E build (`E2E_WORKER=1`, see vite.config.ts and
// playwright.config.ts): the production app, plus a few `/api/e2e/*` routes that stand in for
// the outside world. It is never part of the production bundle. Nothing here opens a socket:
// the mailbox is the in-memory fake IMAP server of the unit tests and Resend is captured.

import supplierInvoice from "../../../src/shared/fatturapa/fixtures/IT01234567890_FPR01.xml?raw";
import { app } from "../../../src/worker/app";
import { resendDeps } from "../../../src/worker/email/resend";
import { type Bindings, isMockChannel } from "../../../src/worker/env";
import { lastCompletedDailyDate } from "../../../src/worker/jobs/job-runs";
import { runScheduled } from "../../../src/worker/jobs/scheduled";
import { type FakeMailbox, fakeMailbox } from "../../../src/worker/pec/fake-mailbox";
import { pollDeps, pollMailbox } from "../../../src/worker/pec/poll";
import { receivedInvoiceMessage, sdiMessage } from "../../../src/worker/pec/receipt-fixtures";

/** Fixed values so the run does not depend on a local `.dev.vars`; support.ts repeats the token. */
const E2E_SETUP_TOKEN = "e2e-setup-token";
const E2E_SECRETS = {
  BETTER_AUTH_SECRET: "e2e-auth-secret-0123456789abcdef0123456789abcdef",
  SETUP_TOKEN: E2E_SETUP_TOKEN,
  RESEND_API_KEY: "re_e2e_test_key",
  MAIL_FROM_ADDRESS: "invoices@example.test",
  // Only the poll sees these; the fake mailbox accepts any login.
  PEC_USERNAME: "e2e@pec.example.test",
  PEC_PASSWORD: "e2e-pec-password",
};

const mailbox: FakeMailbox = { uidValidity: 4242, messages: [] };
const emails: unknown[] = [];
let uid = 0;

pollDeps.open = () => fakeMailbox(mailbox);
resendDeps.fetch = async (_url, init) => {
  emails.push(JSON.parse(String(init.body)));
  return Response.json({ id: `re_e2e_${emails.length}` });
};

type Delivery =
  | { type: "RC" | "NS" | "MC"; fileName: string }
  | { type: "received_invoice"; fileName?: string };

async function deliver(env: Bindings, deliveries: Delivery[]) {
  // The first poll of an empty install starts at the end of the mailbox and ignores older mail,
  // so an empty first poll comes before the first delivery.
  if (uid === 0) await pollMailbox(env);
  // The messages are stamped with the current time: a fixed date would let the 5-day resend
  // window of a rejected invoice run out as the calendar moves on.
  for (const item of deliveries) {
    uid += 1;
    const id = `e2e-${uid}`;
    const source =
      item.type === "received_invoice"
        ? receivedInvoiceMessage({ id, fileName: item.fileName, content: supplierInvoice })
        : sdiMessage({
            type: item.type,
            id,
            fileName: item.fileName,
            date: new Date().toUTCString(),
          });
    mailbox.messages.push({ uid, source });
  }
  return pollMailbox(env);
}

async function e2eRoute(request: Request, env: Bindings): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/api/e2e/mailbox" && request.method === "POST") {
    const body = (await request.json()) as { deliveries: Delivery[] };
    return Response.json(await deliver(env, body.deliveries));
  }
  if (path === "/api/e2e/emails" && request.method === "GET") return Response.json(emails);
  return new Response("Not found", { status: 404 });
}

// The class named in wrangler.jsonc must be exported by whatever entry is the Worker's main.
export { PecPoller } from "../../../src/worker/pec/poller";

export default {
  async fetch(request, env, ctx) {
    const origin = new URL(request.url).origin;
    // The mock channel and the test routes only exist on a localhost origin.
    const e2eEnv = {
      ...env,
      ...E2E_SECRETS,
      APP_ORIGIN: origin,
      SEND_CHANNEL: "mock",
    } as Bindings;
    if (new URL(request.url).pathname.startsWith("/api/e2e/")) {
      return isMockChannel(e2eEnv)
        ? e2eRoute(request, e2eEnv)
        : new Response(null, { status: 404 });
    }
    return app.fetch(request, e2eEnv, ctx);
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(event, env, lastCompletedDailyDate));
  },
} satisfies ExportedHandler<Bindings>;
