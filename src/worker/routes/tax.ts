import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import * as schema from "../../db/schema";
import { cassaDefaultsSchema, ritenutaDefaultsSchema, taxInputSchema } from "../../shared/tax";
import type { SessionVariables } from "../auth/session";
import type { Bindings } from "../env";
import { makeError } from "../problem";
import { validationDetail } from "../validation";

export const tax = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

/** The regime lives on the profile row (null until the Company page is saved); cassa and ritenuta on settings. */
async function loadTax(env: Bindings) {
  const db = drizzle(env.DB, { schema });
  const [settings, profile] = await Promise.all([
    db.select().from(schema.settings).where(eq(schema.settings.id, 1)).get(),
    db
      .select({ regimeFiscale: schema.profile.regimeFiscale })
      .from(schema.profile)
      .where(eq(schema.profile.id, 1))
      .get(),
  ]);
  const cassa = cassaDefaultsSchema.safeParse(settings?.taxCassa);
  const ritenuta = ritenutaDefaultsSchema.safeParse(settings?.taxRitenuta);
  return {
    regimeFiscale: profile?.regimeFiscale ?? null,
    cassa: cassa.success ? cassa.data : null,
    ritenuta: ritenuta.success ? ritenuta.data : null,
  };
}

tax.get("/", async (c) => c.json({ tax: await loadTax(c.env) }));

tax.put("/", async (c) => {
  const parsed = taxInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  const { regimeFiscale, cassa, ritenuta } = parsed.data;
  const db = drizzle(c.env.DB, { schema });
  const now = new Date();
  const values = { taxCassa: cassa, taxRitenuta: ritenuta, updatedAt: now };
  await db.batch([
    db
      .insert(schema.settings)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: schema.settings.id, set: values }),
    // No profile row yet: the regime is stored with the Company page, which creates the row.
    db
      .update(schema.profile)
      .set({ regimeFiscale, updatedAt: now })
      .where(eq(schema.profile.id, 1)),
  ]);
  return c.json({ tax: await loadTax(c.env) });
});
