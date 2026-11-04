import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { EMPTY_CLIENT_DEFAULTS } from "../../shared/client";
import { EMPTY_INVOICE_DATA } from "../../shared/invoice";
import type { RecurringList } from "../../shared/recurring";
import { applyMigrations, setupOwner, signIn, TestClient } from "../auth/test-helpers";
import type { Bindings } from "../env";

const bindings = env as unknown as Bindings;
let owner: TestClient;
let clientId: string;
let invoiceId: string;

const schedule = {
  intervalMonths: 1,
  dayOfMonth: 1,
  startDate: "2999-01-01",
  endDate: null,
  maxCount: null,
};
const list = async () => (await owner.json<RecurringList>("/api/recurring")).body;

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.14.0.1", bindings));
  owner = new TestClient("10.14.0.2", bindings);
  await signIn(owner);
  clientId = (
    await owner.json<{ client: { id: string } }>("/api/clients", {
      body: {
        type: "it_company",
        name: "Acme S.r.l.",
        vatNumber: "12345678903",
        taxCode: "",
        foreignTaxId: "",
        countryCode: "IT",
        address: "Via Roma 1",
        postalCode: "00100",
        city: "Roma",
        province: "RM",
        recipientCode: "",
        pec: "",
        email: "",
        pdfLanguage: "it",
        currency: "EUR",
        defaults: EMPTY_CLIENT_DEFAULTS,
      },
    })
  ).body.client.id;
  invoiceId = (
    await owner.json<{ invoice: { id: string } }>("/api/invoices", {
      body: {
        documentType: "TD01",
        clientId,
        currency: "EUR",
        invoiceDate: null,
        dueDate: null,
        linkedInvoiceId: null,
        lines: [
          {
            description: "Retainer",
            quantityMilli: 1000,
            unit: null,
            unitPriceCents: 100_000,
            vatRateBp: 2200,
            natura: null,
          },
        ],
        data: EMPTY_INVOICE_DATA,
      },
    })
  ).body.invoice.id;
});

describe("recurring templates API", () => {
  it("needs a session", async () => {
    const anon = new TestClient("10.14.1.1", bindings);
    expect((await anon.json("/api/recurring")).status).toBe(401);
  });

  it("starts empty with the default lead time", async () => {
    expect(await list()).toEqual({ templates: [], leadDays: 3 });
  });

  it("rejects a bad schedule with field codes and a missing invoice", async () => {
    const bad = await owner.json<{ detail: string }>("/api/recurring", {
      body: { ...schedule, invoiceId, intervalMonths: 5, dayOfMonth: 40 },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.detail).toContain("intervalMonths");
    expect(bad.body.detail).toContain("dayOfMonth");
    expect(
      (await owner.json("/api/recurring", { body: { ...schedule, invoiceId: "nope" } })).status,
    ).toBe(404);
  });

  it("creates a template from an invoice, then edits, pauses and deletes it", async () => {
    const created = await owner.json<{ id: string }>("/api/recurring", {
      body: { ...schedule, invoiceId },
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await list()).templates[0]).toMatchObject({
      id,
      clientName: "Acme S.r.l.",
      intervalMonths: 1,
      paused: false,
      lineCount: 1,
      totalCents: 122_000,
      createdCount: 0,
      nextDate: "2999-01-01",
    });

    const edited = await owner.json<RecurringList>(`/api/recurring/${id}`, {
      method: "PUT",
      body: { ...schedule, intervalMonths: 3, dayOfMonth: 15, endDate: "3000-01-01", maxCount: 4 },
    });
    expect(edited.body.templates[0]).toMatchObject({
      intervalMonths: 3,
      dayOfMonth: 15,
      endDate: "3000-01-01",
      maxCount: 4,
      nextDate: "2999-01-15",
    });

    const paused = await owner.json<RecurringList>(`/api/recurring/${id}/paused`, {
      method: "PUT",
      body: { paused: true },
    });
    expect(paused.body.templates[0]?.paused).toBe(true);

    const lead = await owner.json<RecurringList>("/api/recurring/lead-days", {
      method: "PUT",
      body: { days: 7 },
    });
    expect(lead.body.leadDays).toBe(7);
    expect(
      (await owner.json("/api/recurring/lead-days", { method: "PUT", body: { days: 99 } })).status,
    ).toBe(400);

    // The source invoice is untouched by deleting the template.
    const removed = await owner.json<RecurringList>(`/api/recurring/${id}`, { method: "DELETE" });
    expect(removed.body.templates).toEqual([]);
    expect((await owner.json(`/api/invoices/${invoiceId}`)).status).toBe(200);
    expect((await owner.json(`/api/recurring/${id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("refuses a credit note and an invoice without a client", async () => {
    const credit = (
      await owner.json<{ invoice: { id: string } }>("/api/invoices", {
        body: {
          documentType: "TD04",
          clientId,
          currency: "EUR",
          invoiceDate: null,
          dueDate: null,
          linkedInvoiceId: null,
          lines: [],
          data: EMPTY_INVOICE_DATA,
        },
      })
    ).body.invoice.id;
    const res = await owner.json<{ detail: string }>("/api/recurring", {
      body: { ...schedule, invoiceId: credit },
    });
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("invoice_not_repeatable");
  });
});
