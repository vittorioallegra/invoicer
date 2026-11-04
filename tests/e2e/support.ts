import { createHmac } from "node:crypto";
import { type APIRequestContext, expect, type Page } from "@playwright/test";

export const SETUP_TOKEN = "e2e-setup-token";
export const OWNER = {
  name: "E2E Owner",
  email: "owner@example.test",
  password: "e2e-owner-password-123",
};

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 6238 code (SHA-1, 6 digits, 30 s) for a base32 secret. */
export function totpCode(secret: string, at = Date.now()): string {
  let bits = "";
  for (const char of secret.toUpperCase().replace(/=+$/, "")) {
    bits += BASE32.indexOf(char).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = (hmac[19] as number) & 0xf;
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
}

/** A CTAP2 platform authenticator that answers every prompt (Chromium only). */
export async function addVirtualAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

/** First-run setup through the UI: owner, authenticator app, recovery codes, passkey. */
export async function createOwner(page: Page): Promise<void> {
  await page.goto("/setup");
  await page.getByLabel("Setup token").fill(SETUP_TOKEN);
  await page.getByLabel("Name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Create owner account" }).click();

  await page.getByRole("button", { name: "Set up authenticator" }).click();
  const secret = await page.getByRole("textbox", { name: "Setup key" }).inputValue();
  await page.getByRole("textbox", { name: "Authentication code" }).fill(totpCode(secret));
  await page.getByRole("button", { name: "Verify" }).click();

  await page.getByRole("button", { name: "I saved the codes" }).click();
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Fills the issuer profile through the API (the onboarding screens have their own checks). */
export async function fillProfile(request: APIRequestContext, origin: string): Promise<void> {
  const response = await request.put("/api/profile", {
    headers: { Origin: origin },
    data: {
      name: "Mario Rossi",
      vatNumber: "12345678903",
      taxCode: "",
      address: "Via Milano 2",
      postalCode: "20100",
      city: "Milano",
      province: "MI",
      country: "IT",
      regimeFiscale: "RF01",
      defaultPaymentTermsDays: null,
    },
  });
  expect(response.ok()).toBe(true);
}

export const CLIENT = { name: "Acme Srl", vat: "01234567897", email: "acme@example.test" };

/** Courtesy email sent automatically once the SdI delivered the invoice. */
export async function configureEmail(request: APIRequestContext, origin: string): Promise<void> {
  const response = await request.put("/api/settings/email", {
    headers: { Origin: origin },
    data: {
      senderName: "Mario Rossi",
      senderAddress: "invoices@example.test",
      replyTo: "",
      bcc: "",
      mode: "automatic",
    },
  });
  expect(response.ok()).toBe(true);
}

/** Adds the test client through the New client sheet on the Clients screen. */
export async function createClient(page: Page): Promise<void> {
  await page.goto("/clients");
  await page
    .getByRole("button", { name: /add|new/i })
    .first()
    .click();
  const sheet = page.getByRole("dialog", { name: "New client" });
  await sheet.getByRole("textbox", { name: "Company name" }).fill(CLIENT.name);
  await sheet.getByRole("textbox", { name: "Partita IVA" }).fill(CLIENT.vat);
  await sheet.getByRole("textbox", { name: "Street and number" }).fill("Via Roma 1");
  await sheet.getByRole("textbox", { name: "Postal code" }).fill("00100");
  await sheet.getByRole("textbox", { name: "City" }).fill("Roma");
  await sheet.getByRole("textbox", { name: "Province" }).fill("RM");
  await sheet.getByRole("textbox", { name: "Codice destinatario" }).fill("ABC1234");
  await sheet.getByRole("textbox", { name: "Email for the PDF copy" }).fill(CLIENT.email);
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(CLIENT.name)).toBeVisible();
}

/** Writes and saves an invoice of one line at 22% VAT; returns its id. */
export async function saveInvoice(page: Page, description: string): Promise<string> {
  await page.goto("/invoices/new");
  await page.getByRole("combobox", { name: "Client" }).click();
  await page.getByRole("option", { name: new RegExp(CLIENT.name) }).click();
  await page.getByRole("textbox", { name: "Description" }).fill(description);
  await page.getByRole("textbox", { name: "Unit price" }).fill("100,00");
  await page.getByRole("combobox", { name: "VAT" }).click();
  await page.getByRole("option", { name: /^22%/ }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Finalize" })).toBeVisible();
  return page.url().split("/").pop() as string;
}

/** Finalize with the passkey (the virtual authenticator answers the prompt). */
export async function finalizeWithPasskey(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Finalize" }).click();
  await page.getByRole("button", { name: "Finalize and send with passkey" }).click();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible();
}

/** The file name of the invoice's latest transmission attempt (what the SdI messages name). */
export async function latestFileName(page: Page, id: string): Promise<string> {
  const response = await page.request.get(`/api/invoices/${id}/transmissions`);
  const body = (await response.json()) as { attempts: { fileName: string }[] };
  return (body.attempts.at(-1) as { fileName: string }).fileName;
}

export type Delivery =
  | { type: "RC" | "NS" | "MC"; fileName: string }
  | { type: "received_invoice" };

/** Puts messages in the fake PEC mailbox and runs one poll (E2E Worker entry only). */
export async function deliver(page: Page, origin: string, deliveries: Delivery[]): Promise<void> {
  const response = await page.request.post("/api/e2e/mailbox", {
    headers: { Origin: origin },
    data: { deliveries },
  });
  expect(response.ok()).toBe(true);
}

export interface LayoutProblems {
  overflow: string[];
  unnamed: string[];
  small: string[];
}

/**
 * Looks at the current screen for what breaks at phone width: horizontal page overflow (and the
 * elements that stick out), interactive controls without an accessible name, and tap targets
 * under 24 x 24 px (WCAG 2.2 AA minimum; inline links inside a sentence are exempt).
 */
export async function auditLayout(page: Page): Promise<LayoutProblems> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const width = doc.clientWidth;
    const nameOf = (el: Element) => {
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
      const cls =
        typeof el.className === "string" ? el.className.split(" ").slice(0, 3).join(".") : "";
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${text ? ` "${text}"` : ""}`;
    };
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
    };
    const overflow: string[] = [];
    if (doc.scrollWidth > width) {
      overflow.push(`page scrollWidth ${doc.scrollWidth} > ${width}`);
      for (const el of document.body.querySelectorAll("*")) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.right > width + 1) overflow.push(nameOf(el));
        if (overflow.length > 8) break;
      }
    }
    const controls = document.querySelectorAll(
      "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=combobox], [role=menuitem], [role=radio], [role=checkbox], [role=switch]",
    );
    const unnamed: string[] = [];
    const small: string[] = [];
    for (const el of controls) {
      if (!visible(el) || el.closest("[aria-hidden=true]")) continue;
      const labelled = (el as HTMLInputElement).labels?.length;
      const name =
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        (el.getAttribute("aria-labelledby") &&
          document.getElementById(el.getAttribute("aria-labelledby") as string)?.textContent) ||
        labelled ||
        (el.textContent ?? "").trim();
      if (!name) unnamed.push(nameOf(el));
      // A checkbox or radio is tapped through its label row.
      const isToggle = el.matches("input[type=checkbox], input[type=radio]");
      const target = (isToggle && (el as HTMLInputElement).labels?.[0]) || el;
      const rect = target.getBoundingClientRect();
      const inline = el.tagName === "A" && getComputedStyle(el).display === "inline";
      if (!inline && (rect.width < 24 || rect.height < 24)) {
        small.push(`${Math.round(rect.width)}x${Math.round(rect.height)} ${nameOf(el)}`);
      }
    }
    return { overflow, unnamed, small };
  });
}
