import { asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import * as schema from "../../db/schema";
import { type PaymentMethodRecord, paymentMethodInputSchema } from "../../shared/payment-method";
import type { SessionVariables } from "../auth/session";
import type { Bindings } from "../env";
import { makeError } from "../problem";
import { validationDetail } from "../validation";

/**
 * Bank accounts. Exactly one is the default while any exist. Invoices copy the account into
 * their own data, so changing or deleting an account here never touches an issued invoice.
 */
export const paymentMethods = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

type Row = typeof schema.paymentMethods.$inferSelect;

function toRecord(row: Row): PaymentMethodRecord {
  return {
    id: row.id,
    label: row.label,
    iban: row.iban,
    bic: row.bic,
    accountHolder: row.accountHolder,
    isDefault: row.isDefault,
  };
}

async function readBody(c: { req: { json: () => Promise<unknown> } }) {
  const parsed = paymentMethodInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  return parsed.data;
}

const oneDefault = sql`EXISTS (SELECT 1 FROM payment_methods WHERE is_default = 1)`;

paymentMethods.get("/", async (c) => {
  const rows = await drizzle(c.env.DB, { schema })
    .select()
    .from(schema.paymentMethods)
    .orderBy(desc(schema.paymentMethods.isDefault), asc(schema.paymentMethods.label));
  return c.json({ paymentMethods: rows.map(toRecord) });
});

/** The first account becomes the default. */
paymentMethods.post("/", async (c) => {
  const data = await readBody(c);
  const [row] = await drizzle(c.env.DB, { schema })
    .insert(schema.paymentMethods)
    .values({ ...data, isDefault: sql`NOT ${oneDefault}` as unknown as boolean })
    .returning();
  if (!row) throw makeError("internal_error");
  return c.json({ paymentMethod: toRecord(row) }, 201);
});

paymentMethods.put("/:id", async (c) => {
  const data = await readBody(c);
  const [row] = await drizzle(c.env.DB, { schema })
    .update(schema.paymentMethods)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(schema.paymentMethods.id, c.req.param("id")))
    .returning();
  if (!row) throw makeError("not_found");
  return c.json({ paymentMethod: toRecord(row) });
});

paymentMethods.post("/:id/default", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB, { schema });
  const exists = await db
    .select({ id: schema.paymentMethods.id })
    .from(schema.paymentMethods)
    .where(eq(schema.paymentMethods.id, id))
    .get();
  if (!exists) throw makeError("not_found");
  await db.batch([
    db
      .update(schema.paymentMethods)
      .set({ isDefault: false })
      .where(sql`${schema.paymentMethods.isDefault} = 1 AND ${schema.paymentMethods.id} <> ${id}`),
    db
      .update(schema.paymentMethods)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(schema.paymentMethods.id, id)),
  ]);
  const rows = await db
    .select()
    .from(schema.paymentMethods)
    .orderBy(desc(schema.paymentMethods.isDefault), asc(schema.paymentMethods.label));
  return c.json({ paymentMethods: rows.map(toRecord) });
});

/** Deleting the default promotes the oldest remaining account, or leaves none. */
paymentMethods.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB, { schema });
  const [deleted] = await db.batch([
    db.delete(schema.paymentMethods).where(eq(schema.paymentMethods.id, id)).returning(),
    db
      .update(schema.paymentMethods)
      .set({ isDefault: true })
      .where(
        sql`NOT ${oneDefault} AND ${schema.paymentMethods.id} = (SELECT id FROM payment_methods ORDER BY created_at, id LIMIT 1)`,
      ),
  ]);
  if (!deleted.length) throw makeError("not_found");
  return c.body(null, 204);
});
