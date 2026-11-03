import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import * as schema from "../../db/schema";
import { profileInputSchema } from "../../shared/profile";
import type { SessionVariables } from "../auth/session";
import type { Bindings } from "../env";
import { makeError } from "../problem";
import { validationDetail } from "../validation";

export const profile = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

function toResponse(row: typeof schema.profile.$inferSelect) {
  return {
    name: row.name,
    vatNumber: row.vatNumber,
    taxCode: row.taxCode,
    address: row.address,
    postalCode: row.postalCode,
    city: row.city,
    province: row.province,
    country: row.country,
    regimeFiscale: row.regimeFiscale,
  };
}

/** The issuer profile, or `{ profile: null }` before it is filled in. */
profile.get("/", async (c) => {
  const row = await drizzle(c.env.DB, { schema })
    .select()
    .from(schema.profile)
    .where(eq(schema.profile.id, 1))
    .get();
  return c.json({ profile: row ? toResponse(row) : null });
});

profile.put("/", async (c) => {
  const parsed = profileInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  const values = { ...parsed.data, updatedAt: new Date() };
  const db = drizzle(c.env.DB, { schema });
  const [row] = await db
    .insert(schema.profile)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: schema.profile.id, set: values })
    .returning();
  if (!row) throw makeError("internal_error");
  return c.json({ profile: toResponse(row) });
});
