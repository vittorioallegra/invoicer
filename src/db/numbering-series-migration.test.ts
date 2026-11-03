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

describe("numbering series migration", () => {
  it("creates the default series and moves the existing invoices and counters into it", async () => {
    await apply((file) => !file.includes("0008_"));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO invoices (id, state, state_rank, source, year, number_int, number_raw, created_at)
         VALUES ('old-1', 'delivered', 4, 'app', 2026, 1, '1', 0),
                ('old-2', 'delivered', 4, 'imported', 2026, 2, '2', 0),
                ('old-draft', 'draft', 0, 'app', NULL, NULL, NULL, 0)`,
      ),
      env.DB.prepare("INSERT INTO number_sequences (year, last_number) VALUES (2026, 2)"),
    ]);

    await apply((file) => file.includes("0008_"));

    const series = await env.DB.prepare("SELECT * FROM numbering_series").all();
    expect(series.results).toHaveLength(1);
    expect(series.results[0]).toMatchObject({
      id: "default",
      prefix: null,
      suffix: null,
      is_default: 1,
    });
    const invoices = await env.DB.prepare(
      "SELECT id, series_id, number_int, number_raw FROM invoices ORDER BY id",
    ).all();
    expect(invoices.results).toEqual([
      { id: "old-1", series_id: "default", number_int: 1, number_raw: "1" },
      { id: "old-2", series_id: "default", number_int: 2, number_raw: "2" },
      { id: "old-draft", series_id: "default", number_int: null, number_raw: null },
    ]);
    const sequence = await env.DB.prepare("SELECT * FROM number_sequences").all();
    expect(sequence.results).toEqual([{ series_id: "default", year: 2026, last_number: 2 }]);

    // The same progressive may now exist once per series, but not twice in one.
    await env.DB.prepare(
      `INSERT INTO invoices (id, state, state_rank, year, number_int, number_raw, series_id, created_at)
       VALUES ('ch-1', 'sent', 3, 2026, 1, 'CH-1', 'ch', 0)`,
    ).run();
    await expect(
      env.DB.prepare(
        `INSERT INTO invoices (id, state, state_rank, year, number_int, number_raw, series_id, created_at)
         VALUES ('ch-dup', 'sent', 3, 2026, 1, 'CH-1', 'ch', 0)`,
      ).run(),
    ).rejects.toThrow();
  });
});
