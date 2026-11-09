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
  auditLayout,
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
const cspViolations: string[] = [];

test.beforeAll(async ({ browser }, info) => {
  origin = info.project.use.baseURL as string;
  context = await browser.newContext({ baseURL: origin });
  page = await context.newPage();
  page.on("console", (message) => {
    // Only blocked requests (connect-src): the dialogs' inline-style warnings are a known, separate issue.
    if (/connect-src|refused to connect/i.test(message.text())) cspViolations.push(message.text());
  });
  await addVirtualAuthenticator(page);
  // The app signs the owner out when it starts with no open tab (a cold start), and a full page
  // load of this tab empties the tab registry for an instant. The flows below load pages with
  // `goto`, so keep a tab registered; the last test checks the cold start rule itself.
  await page.addInitScript(() => {
    localStorage.setItem("invoicer.tabs", JSON.stringify({ e2e: Date.now() }));
  });
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
  // Finalizing rendered the PDF in the browser: its engine must not make a request the CSP blocks.
  expect(cspViolations).toEqual([]);
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
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Mark as paid" }).click();
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

// protects=every main screen is usable at 375 px: no horizontal scroll, every control has an
// accessible name, tap targets are at least 24 x 24 px (AC 18); fails_when=a screen overflows,
// an icon-only control has no name or a control is too small to tap; no_claim=nothing about
// real devices, Safari, safe areas or how the screens look (only these three measurable rules).
test("at 375 px every main screen has no overflow, named controls and tappable targets", async ({
  browser,
}) => {
  const phone = await browser.newContext({
    baseURL: origin,
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    storageState: await context.storageState(),
  });
  const view = await phone.newPage();
  const problems: string[] = [];
  const check = async (label: string) => {
    const found = await auditLayout(view);
    for (const [kind, list] of Object.entries(found)) {
      for (const item of list) problems.push(`${label} (${kind}): ${item}`);
    }
  };

  // Phone pointers get native selects and date inputs; an unsent invoice shows the editor.
  const draft = await saveInvoice(page, "Draft for the phone check");
  const screens = [
    "/",
    "/invoices",
    "/invoices/new",
    `/invoices/${draft}`,
    `/invoices/${firstInvoiceId}`,
    "/received",
    "/clients",
    "/import",
    "/notifications",
    "/settings",
    "/settings/company",
    "/settings/tax",
    "/settings/payment-methods",
    "/settings/numbering",
    "/settings/pec",
    "/settings/email",
    "/settings/ade-guide",
    "/settings/notifications",
  ];
  for (const path of screens) {
    await view.goto(path);
    await expect(view.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(view.getByText("Loading", { exact: true })).toHaveCount(0);
    await check(path);
  }

  await view.goto(`/invoices/${draft}`);
  await view.getByRole("button", { name: "More actions" }).click();
  await check("invoice menu");
  await view.keyboard.press("Escape");
  await view.getByRole("button", { name: "Finalize" }).click();
  await expect(view.getByRole("dialog", { name: "Finalize invoice" })).toBeVisible();
  await check("finalize dialog");
  await view.keyboard.press("Escape");

  await view.goto("/clients");
  await view
    .getByRole("button", { name: /add|new/i })
    .first()
    .click();
  await expect(view.getByRole("dialog", { name: "New client" })).toBeVisible();
  await check("client sheet");

  await phone.close();
  expect(problems).toEqual([]);
});

test("the session ends when the last tab is closed, and survives a second tab and a reload", async () => {
  // Another tab while the first is open: still signed in.
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await second.reload();
  await expect(second.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await second.close();

  // Every tab closed and the app opened again is a cold start: back to the login screen. A closed
  // browser cannot be scripted, so the last heartbeat is made 31 s old (a killed app sends no
  // "pagehide"; the unit tests cover the tab removing itself).
  await page.close();
  const reopened = await context.newPage();
  await reopened.addInitScript(() => {
    localStorage.setItem("invoicer.tabs", JSON.stringify({ gone: Date.now() - 31_000 }));
  });
  await reopened.goto("/");
  await expect(reopened).toHaveURL(/\/login\?reason=closed$/);
});
