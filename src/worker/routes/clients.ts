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
import type { SessionVariables } from "../auth/session";
import type { Bindings } from "../env";
import { makeError } from "../problem";
import { validationDetail } from "../validation";

export const clients = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

type Row = typeof schema.clients.$inferSelect;

function toRecord(row: Row): ClientRecord {
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
