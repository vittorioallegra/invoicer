import { Hono } from "hono";
import { z } from "zod";
import {
  MAX_RECURRING_LEAD_DAYS,
  type RecurringList,
  recurringScheduleSchema,
} from "../../shared/recurring";
import type { SessionVariables } from "../auth/session";
import type { Bindings } from "../env";
import { makeError } from "../problem";
import {
  createTemplateFromInvoice,
  deleteTemplate,
  listTemplates,
  loadLeadDays,
  saveLeadDays,
  setTemplatePaused,
  updateTemplateSchedule,
} from "../recurring";
import { validationDetail } from "../validation";

export const recurring = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

async function list(env: Bindings): Promise<RecurringList> {
  return { templates: await listTemplates(env.DB), leadDays: await loadLeadDays(env.DB) };
}

recurring.get("/", async (c) => c.json(await list(c.env)));

/** Creates a template from an existing invoice (its client, settings and lines) and a schedule. */
recurring.post("/", async (c) => {
  const parsed = recurringScheduleSchema
    .and(z.object({ invoiceId: z.string().min(1) }))
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  const { invoiceId, ...schedule } = parsed.data;
  const id = await createTemplateFromInvoice(c.env.DB, invoiceId, schedule);
  return c.json({ id }, 201);
});

/** Days ahead of an occurrence on which its invoice is created. */
recurring.put("/lead-days", async (c) => {
  const parsed = z
    .object({ days: z.number().int().min(0).max(MAX_RECURRING_LEAD_DAYS) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  await saveLeadDays(c.env.DB, parsed.data.days);
  return c.json(await list(c.env));
});

recurring.put("/:id", async (c) => {
  const parsed = recurringScheduleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  await updateTemplateSchedule(c.env.DB, c.req.param("id"), parsed.data);
  return c.json(await list(c.env));
});

recurring.put("/:id/paused", async (c) => {
  const parsed = z.object({ paused: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  await setTemplatePaused(c.env.DB, c.req.param("id"), parsed.data.paused);
  return c.json(await list(c.env));
});

/** Deleting a template keeps the invoices it already created. */
recurring.delete("/:id", async (c) => {
  await deleteTemplate(c.env.DB, c.req.param("id"));
  return c.json(await list(c.env));
});
