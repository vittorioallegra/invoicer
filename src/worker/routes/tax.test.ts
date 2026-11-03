import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, setupOwner, signIn, TestClient } from "../auth/test-helpers";
import type { Bindings } from "../env";

const bindings = env as unknown as Bindings;

const profile = {
  name: "Mario Rossi",
  vatNumber: "12345678903",
  taxCode: "",
  address: "Via Roma 1",
  postalCode: "00100",
  city: "Roma",
  province: "RM",
  country: "IT",
};
const cassa = { type: "TC04", rateBp: 400, mode: "included", subjectToRitenuta: false };
const ritenuta = { type: "RT01", rateBp: 2000, baseBp: 5000, causale: "A" };

interface TaxBody {
  tax: { regimeFiscale: string | null; cassa: unknown; ritenuta: unknown };
}

let owner: TestClient;

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.9.0.1", bindings));
  owner = new TestClient("10.9.0.2", bindings);
  await signIn(owner);
});

describe("tax details", () => {
  it("needs a session", async () => {
    const anonymous = new TestClient("10.9.0.3", bindings);
    expect((await anonymous.json("/api/tax")).status).toBe(401);
  });

  it("is empty at first, with no regime until the Company page exists", async () => {
    const read = await owner.json<TaxBody>("/api/tax");
    expect(read.body.tax).toEqual({ regimeFiscale: null, cassa: null, ritenuta: null });
  });

  it("stores cassa and ritenuta before the Company page, without inventing a profile", async () => {
    const saved = await owner.json<TaxBody>("/api/tax", {
      method: "PUT",
      body: { regimeFiscale: "RF19", cassa, ritenuta },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.tax).toEqual({ regimeFiscale: null, cassa, ritenuta });
    expect((await owner.json("/api/profile")).body).toEqual({ profile: null });
  });

  it("rejects bad fields with codes", async () => {
    const bad = await owner.json<{ detail: string }>("/api/tax", {
      method: "PUT",
      body: { regimeFiscale: "RF03", cassa: { ...cassa, rateBp: 0 }, ritenuta },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.detail).toContain("regimeFiscale");
    expect(bad.body.detail).toContain("cassa.rateBp");
  });

  it("updates the regime on the profile row and keeps it when the Company page is saved", async () => {
    await owner.json("/api/profile", { method: "PUT", body: profile });
    const saved = await owner.json<TaxBody>("/api/tax", {
      method: "PUT",
      body: { regimeFiscale: "RF19", cassa: null, ritenuta },
    });
    expect(saved.body.tax).toEqual({ regimeFiscale: "RF19", cassa: null, ritenuta });

    await owner.json("/api/profile", { method: "PUT", body: { ...profile, name: "Mario R." } });
    expect((await owner.json<TaxBody>("/api/tax")).body.tax.regimeFiscale).toBe("RF19");
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM settings").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});
