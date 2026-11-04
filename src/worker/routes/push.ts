import { Hono } from "hono";
import { z } from "zod";
import { NOTIFICATION_TYPES } from "../../shared/notifications";
import type { SessionVariables } from "../auth/session";
import { type Bindings, featureStatus, requireSecrets } from "../env";
import { makeError } from "../problem";
import { MAX_DEVICES } from "../push/deliver";
import { loadPushPreferences } from "../push/settings";
import { validationDetail } from "../validation";

export const push = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

const subscriptionSchema = z.object({
  endpoint: z.url().refine((url) => url.startsWith("https://")),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});
const typesSchema = z.object({ disabled: z.array(z.enum(NOTIFICATION_TYPES)).max(50) });

/** Whether push is configured, the public VAPID key to subscribe with, and the types switched off. */
push.get("/", async (c) => {
  const configured = featureStatus(c.env).push;
  const { disabledTypes } = await loadPushPreferences(c.env.DB);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{
    n: number;
  }>();
  return c.json({
    configured,
    publicKey: configured ? (c.env.VAPID_PUBLIC_KEY ?? null) : null,
    disabledTypes: [...disabledTypes],
    devices: count?.n ?? 0,
  });
});

/** Registers (or refreshes) this device; the newest `MAX_DEVICES` subscriptions are kept. */
push.post("/subscriptions", async (c) => {
  requireSecrets(c.env, "push");
  const parsed = subscriptionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  const { endpoint, keys } = parsed.data;
  const userAgent = (c.req.header("User-Agent") ?? "").slice(0, 200) || null;
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user_agent, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = ?3, auth = ?4, user_agent = ?5`,
    ).bind(crypto.randomUUID(), endpoint, keys.p256dh, keys.auth, userAgent, Date.now()),
    c.env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE id NOT IN (
         SELECT id FROM push_subscriptions ORDER BY created_at DESC LIMIT ?)`,
    ).bind(MAX_DEVICES),
  ]);
  return c.json({ ok: true }, 201);
});

push.delete("/subscriptions", async (c) => {
  const parsed = z
    .object({ endpoint: z.string().min(1) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
    .bind(parsed.data.endpoint)
    .run();
  return c.body(null, 204);
});

/** The notification types push is switched off for (everything else is pushed). */
push.put("/types", async (c) => {
  const parsed = typesSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  const disabled = [...new Set(parsed.data.disabled)];
  await c.env.DB.prepare(
    `INSERT INTO settings (id, push_disabled_types, updated_at) VALUES (1, ?1, ?2)
     ON CONFLICT (id) DO UPDATE SET push_disabled_types = ?1, updated_at = ?2`,
  )
    .bind(JSON.stringify(disabled), Date.now())
    .run();
  return c.json({ disabledTypes: disabled });
});
