import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, setupOwner, signIn, TestClient } from "../auth/test-helpers";
import type { Bindings } from "../env";

const bindings = env as unknown as Bindings;
let owner: TestClient;

const IBAN_A = "IT60X0542811101000000123456";
const IBAN_B = "DE89370400440532013000";

interface Account {
  id: string;
  label: string;
  iban: string;
  isDefault: boolean;
}

const body = (label: string, iban: string) => ({
  label,
  iban,
  bic: "",
  accountHolder: "",
});

const list = async () =>
  (await owner.json<{ paymentMethods: Account[] }>("/api/payment-methods")).body.paymentMethods;

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.12.0.1", bindings));
  owner = new TestClient("10.12.0.2", bindings);
  await signIn(owner);
});

describe("payment methods API", () => {
  it("needs a session", async () => {
    const anon = new TestClient("10.12.1.1", bindings);
    expect((await anon.json("/api/payment-methods")).status).toBe(401);
  });

  it("rejects an invalid IBAN and a missing label with field codes", async () => {
    const res = await owner.json<{ detail: string }>("/api/payment-methods", {
      body: body("", "IT00"),
    });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("label: required");
    expect(res.body.detail).toContain("iban: invalid_iban");
  });

  it("makes the first account the default and later ones not", async () => {
    expect(await list()).toEqual([]);
    const first = await owner.json<{ paymentMethod: Account }>("/api/payment-methods", {
      body: { ...body("Fineco", " it60 x054 2811 1010 0000 0123 456 "), bic: "fineitmm" },
    });
    expect(first.status).toBe(201);
    expect(first.body.paymentMethod).toMatchObject({
      label: "Fineco",
      iban: IBAN_A,
      bic: "FINEITMM",
      isDefault: true,
    });
    const second = await owner.json<{ paymentMethod: Account }>("/api/payment-methods", {
      body: body("Revolut", IBAN_B),
    });
    expect(second.body.paymentMethod.isDefault).toBe(false);
    expect((await list()).filter((a) => a.isDefault)).toHaveLength(1);
  });

  it("updates an account without changing which one is the default", async () => {
    const [def, other] = await list();
    const res = await owner.json<{ paymentMethod: Account }>(`/api/payment-methods/${other?.id}`, {
      method: "PUT",
      body: body("Revolut Business", IBAN_B),
    });
    expect(res.body.paymentMethod).toMatchObject({ label: "Revolut Business", isDefault: false });
    expect((await list())[0]?.id).toBe(def?.id);
    expect(
      (await owner.json("/api/payment-methods/missing", { method: "PUT", body: body("x", IBAN_A) }))
        .status,
    ).toBe(404);
  });

  it("moves the default to another account, keeping exactly one", async () => {
    const [, other] = await list();
    const res = await owner.json<{ paymentMethods: Account[] }>(
      `/api/payment-methods/${other?.id}/default`,
      { body: {} },
    );
    expect(res.status).toBe(200);
    expect(res.body.paymentMethods.filter((a) => a.isDefault).map((a) => a.id)).toEqual([
      other?.id,
    ]);
    expect((await owner.json("/api/payment-methods/missing/default", { body: {} })).status).toBe(
      404,
    );
    // The failed call must not have cleared the default.
    expect((await list()).filter((a) => a.isDefault)).toHaveLength(1);
  });

  it("cannot hold two defaults at the database level", async () => {
    const [def, other] = await list();
    await expect(
      env.DB.prepare("UPDATE payment_methods SET is_default = 1 WHERE id = ?")
        .bind(other?.isDefault ? def?.id : other?.id)
        .run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("promotes another account when the default is deleted, and leaves none after the last", async () => {
    const before = await list();
    const def = before.find((a) => a.isDefault);
    const res = await owner.request(`/api/payment-methods/${def?.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    const after = await list();
    expect(after).toHaveLength(1);
    expect(after[0]?.isDefault).toBe(true);
    expect(
      (await owner.request(`/api/payment-methods/${def?.id}`, { method: "DELETE" })).status,
    ).toBe(404);
    await owner.request(`/api/payment-methods/${after[0]?.id}`, { method: "DELETE" });
    expect(await list()).toEqual([]);
  });
});
