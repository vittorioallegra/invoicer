import { asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import * as schema from "../../db/schema";
import { type NumberingSeriesRecord, numberingSeriesInputSchema } from "../../shared/numbering";
import type { SessionVariables } from "../auth/session";
import type { Bindings } from "../env";
import { makeError } from "../problem";
import { validationDetail } from "../validation";

/**
 * Numbering series (sezionali). Exactly one is the default. A series used by a numbered invoice
 * cannot be deleted; renaming it, or changing its prefix and suffix, only affects invoices
 * numbered afterwards because every invoice stores its printed number.
 */
export const numberingSeries = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

type Row = typeof schema.numberingSeries.$inferSelect;

function toRecord(row: Row): NumberingSeriesRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    suffix: row.suffix,
    isDefault: row.isDefault,
  };
}

async function readBody(c: { req: { json: () => Promise<unknown> } }) {
  const parsed = numberingSeriesInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  return parsed.data;
}

/** Two series with the same prefix and suffix would print the same numbers. */
async function requireFreeAffixes(
  db: D1Database,
  data: { prefix: string | null; suffix: string | null },
  exceptId: string | null,
): Promise<void> {
  const taken = await db
    .prepare(
      `SELECT 1 AS hit FROM numbering_series
       WHERE COALESCE(prefix, '') = ? AND COALESCE(suffix, '') = ? AND id <> ?`,
    )
    .bind(data.prefix ?? "", data.suffix ?? "", exceptId ?? "")
    .first();
  if (taken) throw makeError("conflict", "series_affixes_taken");
}

const list = (db: D1Database) =>
  drizzle(db, { schema })
    .select()
    .from(schema.numberingSeries)
    .orderBy(desc(schema.numberingSeries.isDefault), asc(schema.numberingSeries.name));

numberingSeries.get("/", async (c) => {
  const rows = await list(c.env.DB);
  return c.json({ series: rows.map(toRecord) });
});

numberingSeries.post("/", async (c) => {
  const data = await readBody(c);
  await requireFreeAffixes(c.env.DB, data, null);
  const [row] = await drizzle(c.env.DB, { schema })
    .insert(schema.numberingSeries)
    .values({ ...data, isDefault: false })
    .returning();
  if (!row) throw makeError("internal_error");
  return c.json({ series: toRecord(row) }, 201);
});

numberingSeries.put("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await readBody(c);
  await requireFreeAffixes(c.env.DB, data, id);
  const [row] = await drizzle(c.env.DB, { schema })
    .update(schema.numberingSeries)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(schema.numberingSeries.id, id))
    .returning();
  if (!row) throw makeError("not_found");
  return c.json({ series: toRecord(row) });
});

numberingSeries.post("/:id/default", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB, { schema });
  const exists = await db
    .select({ id: schema.numberingSeries.id })
    .from(schema.numberingSeries)
    .where(eq(schema.numberingSeries.id, id))
    .get();
  if (!exists) throw makeError("not_found");
  await db.batch([
    db
      .update(schema.numberingSeries)
      .set({ isDefault: false })
      .where(
        sql`${schema.numberingSeries.isDefault} = 1 AND ${schema.numberingSeries.id} <> ${id}`,
      ),
    db
      .update(schema.numberingSeries)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(schema.numberingSeries.id, id)),
  ]);
  return c.json({ series: (await list(c.env.DB)).map(toRecord) });
});

/**
 * The default series and any series with a numbered invoice are kept. Drafts of a deleted
 * series move to the default series.
 */
numberingSeries.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT is_default FROM numbering_series WHERE id = ?")
    .bind(id)
    .first<{ is_default: number }>();
  if (!row) throw makeError("not_found");
  if (row.is_default) throw makeError("conflict", "series_default");
  const used = await c.env.DB.prepare(
    "SELECT 1 AS hit FROM invoices WHERE series_id = ? AND number_int IS NOT NULL LIMIT 1",
  )
    .bind(id)
    .first();
  if (used) throw makeError("conflict", "series_in_use");
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE invoices SET series_id = (SELECT id FROM numbering_series WHERE is_default = 1)
       WHERE series_id = ?1 AND number_int IS NULL`,
    ).bind(id),
    c.env.DB.prepare("DELETE FROM numbering_series WHERE id = ?1 AND is_default = 0").bind(id),
  ]);
  return c.body(null, 204);
});
