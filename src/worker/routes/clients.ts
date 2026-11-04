import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import * as schema from "../../db/schema";
import {
  type ClientData,
  type ClientRecord,
  clientDefaultsSchema,
  clientInputSchema,
  EMPTY_CLIENT_DEFAULTS,
} from "../../shared/client";
import { type ClientRowResult, clientsImportSchema } from "../../shared/import";
import type { SessionVariables } from "../auth/session";
import type { Bindings } from "../env";
import { makeError } from "../problem";
import { validationDetail } from "../validation";

export const clients = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

type Row = typeof schema.clients.$inferSelect;

export function toRecord(row: Row): ClientRecord {
  const defaults = clientDefaultsSchema.safeParse(row.defaults);
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    vatNumber: row.vatNumber,
    taxCode: row.taxCode,
    foreignTaxId: row.foreignTaxId,
    countryCode: row.countryCode,
    address: row.address ?? "",
    postalCode: row.postalCode ?? "",
    city: row.city ?? "",
    province: row.province,
    recipientCode: row.recipientCode ?? "",
    pec: row.pec,
    email: row.email,
    pdfLanguage: row.pdfLanguage,
    currency: row.currency,
    defaults: defaults.success ? defaults.data : EMPTY_CLIENT_DEFAULTS,
  };
}

const toValues = (data: ClientData) => ({ ...data, updatedAt: new Date() });

async function readBody(c: { req: { json: () => Promise<unknown> } }) {
  const parsed = clientInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  return parsed.data;
}

clients.get("/", async (c) => {
  const rows = await drizzle(c.env.DB, { schema })
    .select()
    .from(schema.clients)
    .orderBy(asc(schema.clients.name));
  return c.json({ clients: rows.map(toRecord) });
});

/**
 * Import of clients from a CSV the browser read and mapped (spec section 2). Each row is checked
 * with the client rules; a row that breaks them, or that matches a client already stored (same
 * VAT number, codice fiscale or foreign tax id, else the same name in the same country) or an
 * earlier row of the same file, is skipped with its reason. The answer has one entry per row.
 */
clients.post("/import", async (c) => {
  const parsed = clientsImportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", "rows: invalid");
  const db = drizzle(c.env.DB, { schema });
  const existing = await db
    .select({
      id: schema.clients.id,
      name: schema.clients.name,
      countryCode: schema.clients.countryCode,
      vatNumber: schema.clients.vatNumber,
      taxCode: schema.clients.taxCode,
      foreignTaxId: schema.clients.foreignTaxId,
    })
    .from(schema.clients);
  const seen = new Map<string, string>();
  const keysOf = (row: {
    name: string;
    countryCode: string;
    vatNumber: string | null;
    taxCode: string | null;
    foreignTaxId: string | null;
  }) => {
    const ids = [
      row.vatNumber && `vat:${row.vatNumber}`,
      row.taxCode && `tax:${row.taxCode}`,
      row.foreignTaxId && `foreign:${row.countryCode}:${row.foreignTaxId}`,
    ].filter((key): key is string => Boolean(key));
    return ids.length > 0 ? ids : [`name:${row.countryCode}:${row.name.trim().toLowerCase()}`];
  };
  for (const row of existing) for (const key of keysOf(row)) seen.set(key, row.id);

  const results: ClientRowResult[] = [];
  const inserts: { id: string; values: ReturnType<typeof toValues> }[] = [];
  for (const raw of parsed.data.rows) {
    const row = clientInputSchema.safeParse(raw);
    if (!row.success) {
      results.push({
        status: "skipped",
        reason: "invalid_row",
        problems: row.error.issues.map((issue) => ({
          field: issue.path.join("."),
          code: String(issue.message),
        })),
      });
      continue;
    }
    const keys = keysOf(row.data);
    const match = keys.map((key) => seen.get(key)).find((id) => id !== undefined);
    if (match) {
      results.push({ status: "skipped", reason: "duplicate", id: match });
      continue;
    }
    const id = crypto.randomUUID();
    for (const key of keys) seen.set(key, id);
    results.push({ status: "imported", id });
    inserts.push({ id, values: toValues(row.data) });
  }
  for (let start = 0; start < inserts.length; start += 50) {
    const chunk = inserts.slice(start, start + 50);
    const [first, ...rest] = chunk.map((item) =>
      db.insert(schema.clients).values({ ...item.values, id: item.id }),
    );
    if (first) await db.batch([first, ...rest]);
  }
  return c.json({ results });
});

clients.get("/:id", async (c) => {
  const row = await drizzle(c.env.DB, { schema })
    .select()
    .from(schema.clients)
    .where(eq(schema.clients.id, c.req.param("id")))
    .get();
  if (!row) throw makeError("not_found");
  return c.json({ client: toRecord(row) });
});

clients.post("/", async (c) => {
  const data = await readBody(c);
  const [row] = await drizzle(c.env.DB, { schema })
    .insert(schema.clients)
    .values(toValues(data))
    .returning();
  if (!row) throw makeError("internal_error");
  return c.json({ client: toRecord(row) }, 201);
});

clients.put("/:id", async (c) => {
  const data = await readBody(c);
  const [row] = await drizzle(c.env.DB, { schema })
    .update(schema.clients)
    .set(toValues(data))
    .where(eq(schema.clients.id, c.req.param("id")))
    .returning();
  if (!row) throw makeError("not_found");
  return c.json({ client: toRecord(row) });
});

/** Deleting is refused while invoices or recurring templates still point at the client. */
clients.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB, { schema });
  const used =
    (await db
      .select({ id: schema.invoices.id })
      .from(schema.invoices)
      .where(eq(schema.invoices.clientId, id))
      .get()) ??
    (await db
      .select({ id: schema.recurringTemplates.id })
      .from(schema.recurringTemplates)
      .where(eq(schema.recurringTemplates.clientId, id))
      .get());
  if (used) throw makeError("conflict", "client_in_use");
  const deleted = await db.delete(schema.clients).where(eq(schema.clients.id, id)).returning();
  if (!deleted.length) throw makeError("not_found");
  return c.body(null, 204);
});
