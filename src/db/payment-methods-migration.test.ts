/// <reference types="vite/client" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const migrations = import.meta.glob("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

async function apply(predicate: (file: string) => boolean) {
  for (const file of Object.keys(migrations).sort().filter(predicate)) {
    const statements = (migrations[file] ?? "").split("--> statement-breakpoint");
    await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
  }
}

describe("payment methods migration", () => {
  it("turns the profile's payment data into the first default account and drops the column", async () => {
    await apply((file) => !file.includes("0003_") && !file.includes("0005_"));
    await env.DB.prepare(
      `INSERT INTO profile (id, name, vat_number, country, regime_fiscale, payment_defaults)
       VALUES (1, 'Mario Rossi', '12345678903', 'IT', 'RF19', ?)`,
    )
      .bind(
        JSON.stringify({
          iban: "IT60X0542811101000000123456",
          bic: null,
          accountHolder: "Mario Rossi",
          bankName: "Fineco",
        }),
      )
      .run();

    await apply((file) => file.includes("0003_"));

    const { results } = await env.DB.prepare("SELECT * FROM payment_methods").all();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      label: "Fineco",
      iban: "IT60X0542811101000000123456",
      bic: null,
      bank_name: "Fineco",
      account_holder: "Mario Rossi",
      is_default: 1,
    });

    await apply((file) => file.includes("0005_"));
    const kept = await env.DB.prepare("SELECT * FROM payment_methods").first<
      Record<string, unknown>
    >();
    expect(kept).toMatchObject({ label: "Fineco", account_holder: "Mario Rossi", is_default: 1 });
    expect(kept).not.toHaveProperty("bank_name");
    const columns = await env.DB.prepare("PRAGMA table_info(profile)").all<{ name: string }>();
    expect(columns.results.map((c) => c.name)).not.toContain("payment_defaults");
    const profile = await env.DB.prepare("SELECT name FROM profile").first<{ name: string }>();
    expect(profile?.name).toBe("Mario Rossi");
  });
});
