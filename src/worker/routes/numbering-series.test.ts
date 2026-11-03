import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, setupOwner, signIn, TestClient } from "../auth/test-helpers";
import type { Bindings } from "../env";

const bindings = env as unknown as Bindings;
let owner: TestClient;

interface Series {
  id: string;
  name: string;
  prefix: string | null;
  suffix: string | null;
  isDefault: boolean;
}

const list = async () =>
  (await owner.json<{ series: Series[] }>("/api/numbering-series")).body.series;

const create = (body: unknown) =>
  owner.json<{ series: Series; detail?: string }>("/api/numbering-series", { body });

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.14.0.1", bindings));
  owner = new TestClient("10.14.0.2", bindings);
  await signIn(owner);
});

describe("numbering series API", () => {
  it("needs a session", async () => {
    const anon = new TestClient("10.14.1.1", bindings);
    expect((await anon.json("/api/numbering-series")).status).toBe(401);
  });

  it("starts with the default series that has no prefix or suffix", async () => {
    expect(await list()).toMatchObject([
      { id: "default", prefix: null, suffix: null, isDefault: true },
    ]);
  });

  it("rejects bad characters, long affixes and a missing name with field codes", async () => {
    const res = await create({ name: "", prefix: "CH_", suffix: "ABCDEFGHIJKLM" });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("name: required");
    expect(res.body.detail).toContain("prefix: invalid_affix");
    expect(res.body.detail).toContain("suffix: ");
  });

  it("creates a series, never as the default, and refuses a duplicate prefix and suffix", async () => {
    const created = await create({ name: "Svizzera", prefix: "CH-", suffix: "" });
    expect(created.status).toBe(201);
    expect(created.body.series).toMatchObject({ name: "Svizzera", prefix: "CH-", suffix: null });
    expect(created.body.series.isDefault).toBe(false);
    const dup = await create({ name: "Altra", prefix: "CH-" });
    expect(dup.status).toBe(409);
    expect(dup.body.detail).toBe("series_affixes_taken");
    const none = await create({ name: "No affixes" });
    expect(none.status).toBe(409);
  });

  it("changes the default and keeps exactly one", async () => {
    const created = await create({ name: "Estero", suffix: "/EU" });
    const res = await owner.json<{ series: Series[] }>(
      `/api/numbering-series/${created.body.series.id}/default`,
      { body: {} },
    );
    expect(res.status).toBe(200);
    expect(res.body.series.filter((s) => s.isDefault)).toHaveLength(1);
    expect(res.body.series[0]?.name).toBe("Estero");
    await owner.json(`/api/numbering-series/default/default`, { body: {} });
  });

  it("refuses to delete the default series or a series used by a numbered invoice", async () => {
    const used = (await create({ name: "Usata", prefix: "U-" })).body.series;
    await env.DB.prepare(
      `INSERT INTO invoices (id, state, state_rank, year, number_int, number_raw, series_id, created_at)
       VALUES ('used-1', 'sent', 3, 2026, 1, 'U-1', ?, 0)`,
    )
      .bind(used.id)
      .run();
    const inUse = await owner.json<{ detail: string }>(`/api/numbering-series/${used.id}`, {
      method: "DELETE",
    });
    expect(inUse.status).toBe(409);
    expect(inUse.body.detail).toBe("series_in_use");
    const isDefault = await owner.json<{ detail: string }>("/api/numbering-series/default", {
      method: "DELETE",
    });
    expect(isDefault.status).toBe(409);
    expect(isDefault.body.detail).toBe("series_default");

    // Renaming and changing the affixes of a used series is fine, and the invoice keeps its number.
    const renamed = await owner.json<{ series: Series }>(`/api/numbering-series/${used.id}`, {
      method: "PUT",
      body: { name: "Usata 2", prefix: "V-", suffix: "" },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.series).toMatchObject({ name: "Usata 2", prefix: "V-" });
    const kept = await env.DB.prepare(
      "SELECT number_raw FROM invoices WHERE id = 'used-1'",
    ).first();
    expect(kept).toEqual({ number_raw: "U-1" });
  });

  it("deletes an unused series and moves its drafts to the default series", async () => {
    const series = (await create({ name: "Temporanea", prefix: "T-" })).body.series;
    await env.DB.prepare(
      "INSERT INTO invoices (id, state, state_rank, series_id, created_at) VALUES ('draft-t', 'draft', 0, ?, 0)",
    )
      .bind(series.id)
      .run();
    const res = await owner.json(`/api/numbering-series/${series.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await list()).some((s) => s.id === series.id)).toBe(false);
    const draft = await env.DB.prepare(
      "SELECT series_id FROM invoices WHERE id = 'draft-t'",
    ).first();
    expect(draft).toEqual({ series_id: "default" });
    expect(
      (await owner.json(`/api/numbering-series/${series.id}`, { method: "DELETE" })).status,
    ).toBe(404);
  });
});
