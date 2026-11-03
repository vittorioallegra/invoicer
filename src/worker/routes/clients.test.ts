import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { EMPTY_CLIENT_DEFAULTS } from "../../shared/client";
import { applyMigrations, setupOwner, signIn, TestClient } from "../auth/test-helpers";
import type { Bindings } from "../env";

const bindings = env as unknown as Bindings;
let owner: TestClient;

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
  pdfLanguage: "en",
  currency: "EUR",
  defaults: {
    ...EMPTY_CLIENT_DEFAULTS,
    vatRateBp: 2200,
    cassa: { type: "TC22", rateBp: 400, mode: "included", subjectToRitenuta: true },
    terms: { days: 30, basis: "end_of_month" },
  },
};

interface Record_ {
  id: string;
  name: string;
  recipientCode: string;
  pdfLanguage: string;
  defaults: {
    vatRateBp: number;
    cassa: { type: string };
    terms: { days: number; basis: string; extraDays: number } | null;
  };
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.9.0.1", bindings));
  owner = new TestClient("10.9.0.2", bindings);
  await signIn(owner);
});

describe("clients API", () => {
  it("needs a session", async () => {
    const anon = new TestClient("10.9.1.1", bindings);
    expect((await anon.json("/api/clients")).status).toBe(401);
  });

  it("creates, lists, reads, updates and deletes a client with its defaults", async () => {
    expect((await owner.json<{ clients: unknown[] }>("/api/clients")).body.clients).toEqual([]);

    const created = await owner.json<{ client: Record_ }>("/api/clients", {
      body: acme,
    });
    expect(created.status).toBe(201);
    expect(created.body.client).toMatchObject({
      recipientCode: "0000000",
      pdfLanguage: "en",
      defaults: {
        vatRateBp: 2200,
        cassa: { type: "TC22" },
        terms: { days: 30, basis: "end_of_month" },
      },
    });
    const { id } = created.body.client;

    const list = await owner.json<{ clients: Record_[] }>("/api/clients");
    expect(list.body.clients.map((c) => c.name)).toEqual(["Acme S.r.l."]);
    expect((await owner.json(`/api/clients/${id}`)).status).toBe(200);

    const updated = await owner.json<{ client: Record_ }>(`/api/clients/${id}`, {
      method: "PUT",
      body: { ...acme, name: "Acme Group", recipientCode: "abc1234" },
    });
    expect(updated.body.client).toMatchObject({ name: "Acme Group", recipientCode: "ABC1234" });

    expect((await owner.json(`/api/clients/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await owner.json(`/api/clients/${id}`)).status).toBe(404);
  });

  it("reads the older numeric payment terms of a stored client as terms from the invoice date", async () => {
    const created = await owner.json<{ client: Record_ }>("/api/clients", { body: acme });
    const { id } = created.body.client;
    const stored = {
      vatRateBp: 2200,
      natura: null,
      cassa: null,
      ritenuta: null,
      bollo: false,
      paymentTermsDays: 50,
    };
    await env.DB.prepare("UPDATE clients SET defaults = ? WHERE id = ?")
      .bind(JSON.stringify(stored), id)
      .run();
    const read = await owner.json<{ client: Record_ }>(`/api/clients/${id}`);
    expect(read.body.client.defaults.terms).toEqual({
      days: 50,
      basis: "invoice_date",
      extraDays: 0,
    });
    await owner.json(`/api/clients/${id}`, { method: "DELETE" });
  });

  it("rejects type rule violations with field codes", async () => {
    const bad = await owner.json<{ detail: string }>("/api/clients", {
      body: { ...acme, vatNumber: "", postalCode: "12" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.detail).toContain("vatNumber: required");
    expect(bad.body.detail).toContain("postalCode: invalid_postal_code");
    expect((await owner.json("/api/clients/missing", { method: "PUT", body: acme })).status).toBe(
      404,
    );
  });

  it("refuses to delete a client that has invoices", async () => {
    const created = await owner.json<{ client: Record_ }>("/api/clients", { body: acme });
    const { id } = created.body.client;
    await env.DB.prepare("INSERT INTO invoices (id, client_id, created_at) VALUES ('inv-1', ?, 0)")
      .bind(id)
      .run();
    const refused = await owner.json(`/api/clients/${id}`, { method: "DELETE" });
    expect(refused.status).toBe(409);
  });
});
