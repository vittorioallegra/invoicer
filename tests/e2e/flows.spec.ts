// The two Testing Plan flows and the rejected -> resend flow, end to end in Chromium against the
// production build and the E2E Worker entry (tests/e2e/worker/entry.ts): a mock send channel, a
// fake PEC mailbox and a captured Resend. A virtual passkey authenticator answers the prompts.
// protects=the owner can set up, sign in, invoice, send with a passkey, see the SdI answer, get
// the PDF/XML and the courtesy email, and see a supplier invoice and mark it paid;
// fails_when=any step of those screens, the CSP, or the state machine breaks in a real browser;
// no_claim=nothing about the real SdI, the real PEC servers or Resend (all faked), or Safari.
import { readFileSync } from "node:fs";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  addVirtualAuthenticator,
  CLIENT,
  configureEmail,
  createClient,
  createOwner,
  deliver,
  fillProfile,
  finalizeWithPasskey,
  latestFileName,
  saveInvoice,
} from "./support";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let origin: string;
let firstInvoiceId = "";

test.beforeAll(async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "needs a Chromium virtual authenticator");
  origin = info.project.use.baseURL as string;
  context = await browser.newContext({ baseURL: origin });
  page = await context.newPage();
  await addVirtualAuthenticator(page);
});

test.afterAll(async () => {
  await context?.close();
});

async function download(trigger: string): Promise<Buffer> {
  await page.getByRole("button", { name: "More actions" }).click();
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: trigger }).click(),
  ]);
  return readFileSync(await file.path());
}

test("setup, then sign in again with the passkey", async () => {
  await createOwner(page);
  await fillProfile(page.request, origin);
  await configureEmail(page.request, origin);

  await context.clearCookies();
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
});

test("flow: client, invoice, send with the passkey, receipt, PDF and courtesy email", async () => {
  await createClient(page);
  firstInvoiceId = await saveInvoice(page, "Consulting");
  await finalizeWithPasskey(page);
  await expect(page.getByText("Delivered to the SdI mailbox")).toBeVisible();

  // The SdI's delivery receipt arrives through the polled mailbox.
  await deliver(page, origin, [
    { type: "RC", fileName: await latestFileName(page, firstInvoiceId) },
  ]);
  await page.reload();
  await expect(page.getByText("Delivered", { exact: true })).toBeVisible();

  const pdf = await download("Download PDF");
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  const xml = await download("Download XML");
  expect(xml.toString()).toContain("FatturaElettronica");

  // The automatic courtesy email went out through (captured) Resend with the PDF attached.
  await expect
    .poll(async () => (await (await page.request.get("/api/e2e/emails")).json()).length)
    .toBe(1);
  const [email] = (await (await page.request.get("/api/e2e/emails")).json()) as {
    to: string[];
    attachments: { filename: string }[];
  }[];
  expect(email?.to).toEqual([CLIENT.email]);
  expect(email?.attachments.some((a) => a.filename.endsWith(".pdf"))).toBe(true);
});

test("flow: a supplier invoice arrives through the mailbox, is listed and marked paid", async () => {
  await deliver(page, origin, [{ type: "received_invoice" }]);
  await page.goto("/received");
  await page.getByRole("link", { name: /ALPHA SRL/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: /ALPHA SRL/ })).toBeVisible();
  await expect(page.getByText("Unpaid", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mark as paid" }).click();
  await expect(page.getByText("Paid", { exact: true })).toBeVisible();
});

test("flow: rejected by the SdI, fixed and resent with a new file name, then delivered", async () => {
  const id = await saveInvoice(page, "Consulting, second invoice");
  await finalizeWithPasskey(page);
  const firstFile = await latestFileName(page, id);

  await deliver(page, origin, [{ type: "NS", fileName: firstFile }]);
  await page.reload();
  await expect(page.getByText("Rejected", { exact: true })).toBeVisible();
  await expect(page.getByText("SdI error 00311").first()).toBeVisible();

  await page.getByRole("button", { name: "Fix & resend" }).click();
  await page.getByRole("button", { name: "Finalize and send with passkey" }).click();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible();
  const secondFile = await latestFileName(page, id);
  expect(secondFile).not.toBe(firstFile);

  await deliver(page, origin, [{ type: "RC", fileName: secondFile }]);
  await page.reload();
  await expect(page.getByText("Delivered", { exact: true })).toBeVisible();
});
