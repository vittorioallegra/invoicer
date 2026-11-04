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
  defaults: { ...EMPTY_CLIENT_DEFAULTS, applyCassa: true, terms: { kind: "eom_30" } },
};

interface Record_ {
  id: string;
  name: string;
  recipientCode: string;
  pdfLanguage: string;
  defaults: {
    applyCassa: boolean;
    applyRitenuta: boolean;
    terms: { kind: string; days?: number } | null;
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
      defaults: { applyCassa: true, applyRitenuta: false, terms: { kind: "eom_30" } },
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
    expect(read.body.client.defaults.terms).toEqual({ kind: "custom", days: 50 });
    await owner.json(`/api/clients/${id}`, { method: "DELETE" });
  });

  it("reads the older stored defaults as flags and drops VAT and bollo", async () => {
    const created = await owner.json<{ client: Record_ }>("/api/clients", { body: acme });
    const { id } = created.body.client;
    const stored = {
      vatRateBp: 2200,
      natura: null,
      cassa: null,
      ritenuta: { type: "RT01", rateBp: 2000, baseBp: 10000, causale: "A" },
      bollo: true,
      terms: null,
    };
    await env.DB.prepare("UPDATE clients SET defaults = ? WHERE id = ?")
      .bind(JSON.stringify(stored), id)
      .run();
    const read = await owner.json<{ client: Record_ }>(`/api/clients/${id}`);
    expect(read.body.client.defaults).toEqual({
      applyCassa: false,
      applyRitenuta: true,
      terms: null,
      seriesId: null,
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

describe("POST /api/clients/import", () => {
  const importRows = (rows: unknown[]) =>
    owner.json<{
      results: { status: string; reason?: string; id?: string; problems?: unknown[] }[];
    }>("/api/clients/import", { body: { rows } });

  it("stores the valid rows and skips each other row with its reason (AC 17)", async () => {
    const beta = { ...acme, name: "Beta S.p.A.", vatNumber: "01234567897" };
    const stored = await owner.json<{ client: { id: string } }>("/api/clients", { body: acme });
    const res = await importRows([
      beta,
      { ...beta, name: "Beta again" },
      acme,
      { ...acme, name: "No VAT", vatNumber: "" },
      { ...acme, name: "Gamma", vatNumber: "12345678904" },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => [r.status, r.reason])).toEqual([
      ["imported", undefined],
      ["skipped", "duplicate"],
      ["skipped", "duplicate"],
      ["skipped", "invalid_row"],
      ["skipped", "invalid_row"],
    ]);
    // A duplicate of a stored client points at it; the invalid rows say which rule they break.
    expect(res.body.results[2]?.id).toBe(stored.body.client.id);
    expect(res.body.results[3]?.problems).toEqual([{ field: "vatNumber", code: "required" }]);
    expect(res.body.results[4]?.problems).toEqual([
      { field: "vatNumber", code: "invalid_vat_number" },
    ]);
    const names = await owner.json<{ clients: { name: string }[] }>("/api/clients");
    expect(names.body.clients.map((c) => c.name)).toContain("Beta S.p.A.");
    expect(names.body.clients.filter((c) => c.name.startsWith("Beta"))).toHaveLength(1);
  });

  it("matches clients without a tax id by name and country, and refuses a bad body", async () => {
    const swiss = {
      type: "foreign_private",
      name: "Hans Muster",
      vatNumber: "",
      taxCode: "",
      foreignTaxId: "",
      countryCode: "CH",
      address: "Bahnhofstrasse 1",
      postalCode: "8001",
      city: "Zurich",
      province: "",
      recipientCode: "",
      pec: "",
      email: "",
      pdfLanguage: "en",
      currency: "CHF",
      defaults: {},
    };
    const first = await importRows([swiss]);
    expect(first.body.results[0]?.status).toBe("imported");
    const again = await importRows([{ ...swiss, name: "  HANS muster " }]);
    expect(again.body.results[0]).toMatchObject({ status: "skipped", reason: "duplicate" });
    expect((await owner.json("/api/clients/import", { body: { rows: [] } })).status).toBe(400);
    expect((await owner.json("/api/clients/import", { body: {} })).status).toBe(400);
  });
});
