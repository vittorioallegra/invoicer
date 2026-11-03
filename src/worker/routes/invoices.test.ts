import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { EMPTY_CLIENT_DEFAULTS } from "../../shared/client";
import { EMPTY_INVOICE_DATA, type InvoiceRecord } from "../../shared/invoice";
import { applyMigrations, setupOwner, signIn, TestClient } from "../auth/test-helpers";
import type { Bindings } from "../env";

// PEC credentials present and a passing connection test: the send gate opens once the profile is in.
const bindings = { ...env, PEC_USERNAME: "user", PEC_PASSWORD: "pass" } as unknown as Bindings;
let owner: TestClient;
let clientId: string;

const acme = {
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
};

const line = (over: Record<string, unknown> = {}) => ({
  description: "Consulting",
  quantityMilli: 2000,
  unit: "h",
  unitPriceCents: 5000,
  vatRateBp: 2200,
  natura: null,
  ...over,
});

const body = (over: Record<string, unknown> = {}) => ({
  documentType: "TD01",
  clientId,
  currency: "EUR",
  invoiceDate: null,
  dueDate: null,
  linkedInvoiceId: null,
  notes: null,
  lines: [line()],
  data: EMPTY_INVOICE_DATA,
  ...over,
});

type Invoice = { invoice: InvoiceRecord };
const create = async (over: Record<string, unknown> = {}) =>
  (await owner.json<Invoice>("/api/invoices", { body: body(over) })).body.invoice;

/** Moves an invoice to a state directly, as the send flow and polling steps will. */
const force = (id: string, state: string, rank: number) =>
  env.DB.prepare("UPDATE invoices SET state = ?, state_rank = ? WHERE id = ?")
    .bind(state, rank, id)
    .run();

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.8.0.1", bindings));
  owner = new TestClient("10.8.0.2", bindings);
  await signIn(owner);
  clientId = (await owner.json<{ client: { id: string } }>("/api/clients", { body: acme })).body
    .client.id;
});

describe("invoices API", () => {
  it("needs a session", async () => {
    const anon = new TestClient("10.8.1.1", bindings);
    expect((await anon.json("/api/invoices")).status).toBe(401);
  });

  it("creates a draft with its totals, plans it and lists it under to-issue", async () => {
    const draft = await create();
    expect(draft).toMatchObject({ state: "draft", number: null, totalCents: 12200 });

    const planned = await owner.json<Invoice>(`/api/invoices/${draft.id}`, {
      method: "PUT",
      body: body({ invoiceDate: "2030-01-31", notes: "Thanks" }),
    });
    expect(planned.body.invoice).toMatchObject({ state: "planned", notes: "Thanks" });

    const listed = await owner.json<{ invoices: { id: string; state: string }[] }>(
      "/api/invoices?scope=to_issue",
    );
    expect(listed.body.invoices.find((i) => i.id === draft.id)?.state).toBe("planned");

    const unplanned = await owner.json<Invoice>(`/api/invoices/${draft.id}`, {
      method: "PUT",
      body: body({ invoiceDate: null }),
    });
    expect(unplanned.body.invoice.state).toBe("draft");
  });

  it("rejects malformed content with the failing fields", async () => {
    const bad = await owner.json<{ detail: string }>("/api/invoices", {
      body: body({ invoiceDate: "2030-02-31", lines: [line({ quantityMilli: 0 })] }),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.detail).toContain("invoiceDate: invalid_date");
    expect(bad.body.detail).toContain("lines.0.quantityMilli");
    const unknownClient = await owner.json<{ detail: string }>("/api/invoices", {
      body: body({ clientId: "nope" }),
    });
    expect(unknownClient.body.detail).toBe("clientId: not_found");
  });

  it("duplicates into a new unnumbered draft", async () => {
    const original = await create({ dueDate: "2030-02-10" });
    const copy = (await owner.json<Invoice>(`/api/invoices/${original.id}/duplicate`, { body: {} }))
      .body.invoice;
    expect(copy.id).not.toBe(original.id);
    expect(copy).toMatchObject({
      state: "draft",
      number: null,
      dueDate: null,
      paymentFlag: "unpaid",
    });
    expect(copy.lines).toEqual(original.lines);
  });

  it("keeps its own copy of the bank details when the account is changed or deleted", async () => {
    const account = (
      await owner.json<{ paymentMethod: { id: string } }>("/api/payment-methods", {
        body: {
          label: "Fineco",
          iban: "IT60X0542811101000000123456",
          bic: "",
          bankName: "Fineco",
          accountHolder: "",
        },
      })
    ).body.paymentMethod;
    const payment = {
      method: "MP05",
      iban: "IT60X0542811101000000123456",
      bic: "",
      bankName: "Fineco",
      accountHolder: "",
    };
    const saved = await create({ data: { ...EMPTY_INVOICE_DATA, payment } });
    await owner.json(`/api/payment-methods/${account.id}`, {
      method: "PUT",
      body: {
        label: "Other",
        iban: "DE89370400440532013000",
        bic: "",
        bankName: "Other",
        accountHolder: "",
      },
    });
    await owner.request(`/api/payment-methods/${account.id}`, { method: "DELETE" });
    const again = (await owner.json<Invoice>(`/api/invoices/${saved.id}`)).body.invoice;
    expect(again.data.payment).toMatchObject({
      method: "MP05",
      iban: "IT60X0542811101000000123456",
      bankName: "Fineco",
    });
  });

  it("deletes a draft but never a numbered invoice", async () => {
    const draft = await create();
    expect((await owner.request(`/api/invoices/${draft.id}`, { method: "DELETE" })).status).toBe(
      204,
    );
    expect((await owner.json(`/api/invoices/${draft.id}`)).status).toBe(404);

    const numbered = await create();
    await env.DB.prepare(
      "UPDATE invoices SET state = 'sending', state_rank = 2, year = 2050, number_int = 1, number_raw = '1' WHERE id = ?",
    )
      .bind(numbered.id)
      .run();
    const refused = await owner.json<{ code: string; detail: string }>(
      `/api/invoices/${numbered.id}`,
      { method: "DELETE" },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toBe("numbered_invoice_undeletable");
    expect((await owner.json(`/api/invoices/${numbered.id}`)).status).toBe(200);
  });

  it("cannot return a numbered invoice to draft by saving it", async () => {
    const invoice = await create();
    await env.DB.prepare(
      "UPDATE invoices SET state = 'sending', state_rank = 2, year = 2051, number_int = 1, number_raw = '1' WHERE id = ?",
    )
      .bind(invoice.id)
      .run();
    const refused = await owner.json<{ detail: string }>(`/api/invoices/${invoice.id}`, {
      method: "PUT",
      body: body({ invoiceDate: null }),
    });
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toBe("invoice_locked");
    const after = (await owner.json<Invoice>(`/api/invoices/${invoice.id}`)).body.invoice;
    expect(after).toMatchObject({ state: "sending", number: "1" });
  });

  it("changes only the payment flag and notes once an invoice is out", async () => {
    const invoice = await create({ dueDate: "2000-01-01" });
    await force(invoice.id, "delivered", 4);
    const overdue = (await owner.json<Invoice>(`/api/invoices/${invoice.id}`)).body.invoice;
    expect(overdue.paymentFlag).toBe("overdue");
    const paid = await owner.json<Invoice>(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      body: { paymentFlag: "paid", paidDate: "2030-03-03", notes: "Paid by wire" },
    });
    expect(paid.body.invoice).toMatchObject({
      paymentFlag: "paid",
      paidDate: "2030-03-03",
      notes: "Paid by wire",
      state: "delivered",
    });
    const locked = await owner.json(`/api/invoices/${invoice.id}`, {
      method: "PUT",
      body: body(),
    });
    expect(locked.status).toBe(409);
  });

  it("creates a linked credit note only from an issued invoice", async () => {
    const invoice = await create();
    expect((await owner.json(`/api/invoices/${invoice.id}/credit-note`, { body: {} })).status).toBe(
      409,
    );
    await force(invoice.id, "delivered", 4);
    const note = (
      await owner.json<Invoice>(`/api/invoices/${invoice.id}/credit-note`, { body: {} })
    ).body.invoice;
    expect(note).toMatchObject({
      documentType: "TD04",
      state: "draft",
      linkedInvoiceId: invoice.id,
    });
    expect(note.lines).toEqual(invoice.lines);
  });
});

describe("reserving a number through the API", () => {
  it("is refused with the reasons while the send gate is closed", async () => {
    const invoice = await create();
    const refused = await owner.json<{ detail: string }>(
      `/api/invoices/${invoice.id}/reserve-number`,
      { body: {} },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toContain("profile_incomplete");
    expect(refused.body.detail).toContain("pec_test_missing");
  });

  it("reserves once the gate is open, validates the invoice and is repeatable", async () => {
    await owner.json("/api/profile", {
      method: "PUT",
      body: {
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
    await env.DB.prepare(
      "INSERT INTO settings (id, pec_test_at, pec_test_ok) VALUES (1, ?, 1) ON CONFLICT(id) DO UPDATE SET pec_test_at = excluded.pec_test_at, pec_test_ok = 1",
    )
      .bind(Date.now())
      .run();

    const empty = await create({ lines: [] });
    const incomplete = await owner.json<{ detail: string }>(
      `/api/invoices/${empty.id}/reserve-number`,
      { body: {} },
    );
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.detail).toContain("lines: required");

    const natura = await create({ lines: [line({ vatRateBp: null, natura: "N2.2" })] });
    const noText = await owner.json<{ detail: string }>(
      `/api/invoices/${natura.id}/reserve-number`,
      { body: {} },
    );
    expect(noText.body.detail).toContain("data.naturaTexts.N2.2: natura_text_required");

    const ready = await create();
    const reserved = await owner.json<{
      reservation: { number: number; reused: boolean; transmission: { fileName: string } };
      invoice: InvoiceRecord;
    }>(`/api/invoices/${ready.id}/reserve-number`, { body: {} });
    expect(reserved.status).toBe(200);
    expect(reserved.body.invoice).toMatchObject({
      state: "sending",
      numberReserved: true,
      releasable: true,
    });
    expect(reserved.body.reservation.transmission.fileName).toMatch(/^IT12345678903_\d{5}\.xml$/);

    const again = await owner.json<{ reservation: { number: number; reused: boolean } }>(
      `/api/invoices/${ready.id}/reserve-number`,
      { body: {} },
    );
    expect(again.body.reservation).toMatchObject({
      number: reserved.body.reservation.number,
      reused: true,
    });

    // Home lists it as "number reserved, not sent"; releasing it puts it back to draft.
    const reservedList = await owner.json<{ invoices: { id: string; releasable: boolean }[] }>(
      "/api/invoices?scope=reserved",
    );
    expect(reservedList.body.invoices.map((i) => i.id)).toContain(ready.id);
    expect(reservedList.body.invoices.find((i) => i.id === ready.id)?.releasable).toBe(true);
    const released = await owner.json<Invoice>(`/api/invoices/${ready.id}/release-number`, {
      body: {},
    });
    expect(released.body.invoice).toMatchObject({ state: "draft", number: null });
  });
});

describe("invoice number on the invoice", () => {
  const year = Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric" }).format(
      new Date(),
    ),
  );
  const nextNumber = async (query = "") =>
    (await owner.json<{ year: number; next: number }>(`/api/invoices/next-number${query}`)).body;
  const reserve = (id: string) =>
    owner.json<{ reservation: { number: number }; invoice: InvoiceRecord; detail?: string }>(
      `/api/invoices/${id}/reserve-number`,
      { body: {} },
    );

  it("proposes the highest issued number of the year plus one, imported ones included", async () => {
    const first = await nextNumber();
    expect(first.year).toBe(year);
    await env.DB.prepare(
      "INSERT INTO invoices (id, source, state, state_rank, year, number_int, number_raw, created_at) VALUES ('imp-1', 'imported', 'delivered', 4, ?, ?, ?, 1)",
    )
      .bind(year, first.next + 40, String(first.next + 40))
      .run();
    expect((await nextNumber()).next).toBe(first.next + 41);
    // Another year does not count, and the year can be asked for.
    expect(await nextNumber("?year=2001")).toEqual({ year: 2001, series: "default", next: 1 });
    expect((await owner.json("/api/invoices/next-number?year=abc")).status).toBe(400);
    expect((await owner.json("/api/invoices/next-number?year=99999")).status).toBe(400);
    const anon = new TestClient("10.8.1.9", bindings);
    expect((await anon.json("/api/invoices/next-number")).status).toBe(401);
  });

  it("numbers an invoice in its series: own progressive, printed with prefix and suffix", async () => {
    const created = await owner.json<{ series: { id: string } }>("/api/numbering-series", {
      body: { name: "Svizzera", prefix: "", suffix: "/CH" },
    });
    const seriesId = created.body.series.id;
    const unknown = await owner.json<{ detail: string }>("/api/invoices", {
      body: body({ seriesId: "nope" }),
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.detail).toContain("seriesId: not_found");
    expect((await owner.json("/api/invoices/next-number?series=nope")).status).toBe(400);

    const swiss = await create({ seriesId });
    const italian = await create();
    expect(swiss.seriesId).toBe(seriesId);
    expect(italian.seriesId).toBe("default");
    const fromChain = await nextNumber(`?year=${year}&series=${seriesId}`);
    expect(fromChain).toMatchObject({ series: seriesId, next: 1 });

    const reservedSwiss = await reserve(swiss.id);
    expect(reservedSwiss.body.invoice.number).toBe("1/CH");
    expect(reservedSwiss.body.reservation.number).toBe(1);
    const reservedItalian = await reserve(italian.id);
    expect(reservedItalian.body.invoice.number).toBe(
      String(reservedItalian.body.reservation.number),
    );
    expect((await nextNumber(`?year=${year}&series=${seriesId}`)).next).toBe(2);

    // The series is fixed once the number is reserved.
    const moved = await owner.json<Invoice>(`/api/invoices/${swiss.id}`, {
      method: "PUT",
      body: body({ seriesId: "default" }),
    });
    expect(moved.status).toBe(409);
  });

  it("stores the requested number on a draft, validates it and clears an empty one", async () => {
    const invoice = await create({ requestedNumber: 300 });
    expect(invoice.requestedNumber).toBe(300);
    const cleared = await owner.json<Invoice>(`/api/invoices/${invoice.id}`, {
      method: "PUT",
      body: body({ requestedNumber: null }),
    });
    expect(cleared.body.invoice.requestedNumber).toBeNull();
    for (const bad of [0, -2, 1.5, 1_000_000_000]) {
      const refused = await owner.json("/api/invoices", { body: body({ requestedNumber: bad }) });
      expect(refused.status).toBe(400);
    }
    // A duplicate never inherits the number.
    await owner.json(`/api/invoices/${invoice.id}`, {
      method: "PUT",
      body: body({ requestedNumber: 301 }),
    });
    const copy = await owner.json<Invoice>(`/api/invoices/${invoice.id}/duplicate`, { body: {} });
    expect(copy.body.invoice.requestedNumber).toBeNull();
  });

  it("reserves the requested number (a gap is allowed) and continues from it", async () => {
    const { next } = await nextNumber();
    const invoice = await create({ requestedNumber: next + 25 });
    const done = await reserve(invoice.id);
    expect(done.status).toBe(200);
    expect(done.body.reservation.number).toBe(next + 25);
    expect(done.body.invoice).toMatchObject({ number: String(next + 25), requestedNumber: null });
    expect((await nextNumber()).next).toBe(next + 26);
    const auto = await reserve((await create()).id);
    expect(auto.body.reservation.number).toBe(next + 26);
  });

  it("refuses a number that is no longer free with number_unavailable and the new proposal", async () => {
    const { next } = await nextNumber();
    const invoice = await create({ requestedNumber: next - 1 });
    const refused = await reserve(invoice.id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "number_unavailable",
      anchor: "error-number-unavailable",
    });
    expect(refused.body.detail).toContain(`next free number is ${next}`);
    const after = await owner.json<Invoice>(`/api/invoices/${invoice.id}`);
    expect(after.body.invoice).toMatchObject({
      state: "draft",
      number: null,
      requestedNumber: next - 1,
    });
    expect((await nextNumber()).next).toBe(next);
  });

  it("lets only one of two invoices with the same requested number through", async () => {
    const { next } = await nextNumber();
    const a = await create({ requestedNumber: next + 5 });
    const b = await create({ requestedNumber: next + 5 });
    const results = await Promise.all([reserve(a.id), reserve(b.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body).toMatchObject({
      code: "number_unavailable",
    });
  });
});

describe("rejected invoices", () => {
  let rejectedCount = 0;
  const reject = async (ageDays: number) => {
    const invoice = await create();
    await env.DB.prepare(
      `UPDATE invoices SET state = 'rejected', state_rank = 6, year = 2052, number_int = ?, number_raw = ?,
         issue_date = '2052-01-10' WHERE id = ?`,
    )
      .bind(++rejectedCount, "N", invoice.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO events (id, source_id, type, invoice_id, payload, occurred_at, created_at)
       VALUES (?, ?, 'NS', ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        crypto.randomUUID(),
        invoice.id,
        JSON.stringify({ errors: [{ code: "00300", description: "IdFiscaleIVA non valido" }] }),
        Date.now() - ageDays * 86_400_000,
        Date.now(),
      )
      .run();
    return invoice.id;
  };

  it("stays editable inside the window with number and date locked and the deadline shown", async () => {
    const id = await reject(2);
    const before = (await owner.json<Invoice>(`/api/invoices/${id}`)).body.invoice;
    expect(before.state).toBe("rejected");
    expect(before.rejection?.errors).toEqual([
      { code: "00300", description: "IdFiscaleIVA non valido" },
    ]);
    expect(before.rejection?.deadline).toBeGreaterThan(Date.now());

    const saved = await owner.json<Invoice>(`/api/invoices/${id}`, {
      method: "PUT",
      body: body({
        lines: [line({ description: "Fixed description" })],
        invoiceDate: "2052-05-05",
      }),
    });
    expect(saved.status).toBe(200);
    expect(saved.body.invoice).toMatchObject({
      state: "rejected",
      number: before.number,
      issueDate: "2052-01-10",
    });
    expect(saved.body.invoice.lines[0]?.description).toBe("Fixed description");

    const retype = await owner.json<{ detail: string }>(`/api/invoices/${id}`, {
      method: "PUT",
      body: body({ documentType: "TD04" }),
    });
    expect(retype.body.detail).toBe("document_type_locked");
    expect((await owner.json(`/api/invoices/${id}/reissue`, { body: {} })).status).toBe(409);
  });

  it("becomes rejected_expired after five days: read-only, reissued once as a new draft", async () => {
    const id = await reject(6);
    const expired = (await owner.json<Invoice>(`/api/invoices/${id}`)).body.invoice;
    expect(expired.state).toBe("rejected_expired");
    expect((await owner.json(`/api/invoices/${id}`, { method: "PUT", body: body() })).status).toBe(
      409,
    );

    const reissue = await owner.json<Invoice>(`/api/invoices/${id}/reissue`, { body: {} });
    expect(reissue.status).toBe(201);
    expect(reissue.body.invoice).toMatchObject({
      state: "draft",
      number: null,
      reissuesInvoiceId: id,
    });
    const again = await owner.json<Invoice>(`/api/invoices/${id}/reissue`, { body: {} });
    expect(again.status).toBe(200);
    expect(again.body.invoice.id).toBe(reissue.body.invoice.id);
    // The old number stays recorded on the rejected invoice.
    const old = (await owner.json<Invoice>(`/api/invoices/${id}`)).body.invoice;
    expect(old.number).toBe("N");
  });
});
