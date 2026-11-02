import { Hono } from "hono";
import { z } from "zod";
import { type Bindings, requireSecrets } from "../env";
import { makeError } from "../problem";
import { MIN_PASSWORD_LENGTH } from "./auth";
import { safeEqual } from "./crypto";
import { hashPassword } from "./password";

const setupBody = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(128),
});

export async function ownerExists(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS found FROM user LIMIT 1").first();
  return row !== null;
}

/**
 * First-run owner creation. The deploy is public before onboarding, so it needs the
 * `SETUP_TOKEN` Worker secret. The user and its credential account are inserted in one D1 batch
 * (one transaction) and only while no user exists: whoever wins the race closes sign-up for
 * everyone else. Afterwards this route and Better Auth's sign-up both refuse.
 */
export const setup = new Hono<{ Bindings: Bindings }>();

setup.get("/status", async (c) => c.json({ ownerExists: await ownerExists(c.env.DB) }));

setup.post("/", async (c) => {
  requireSecrets(c.env, "auth");
  if (await ownerExists(c.env.DB)) throw makeError("conflict", "The owner account already exists.");

  const parsed = setupBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", "Invalid setup data.");
  const { token, name, email, password } = parsed.data;
  if (!(await safeEqual(token, c.env.SETUP_TOKEN as string))) {
    throw makeError("forbidden", "Invalid setup token.");
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const passwordHash = await hashPassword(password);
  const [created, linked] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO user (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
       SELECT ?1, ?2, ?3, 1, 0, ?4, ?4 WHERE NOT EXISTS (SELECT 1 FROM user)`,
    ).bind(id, name, email.toLowerCase(), now),
    c.env.DB.prepare(
      `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       SELECT ?1, ?2, 'credential', ?2, ?3, ?4, ?4 WHERE EXISTS (SELECT 1 FROM user WHERE id = ?2)`,
    ).bind(crypto.randomUUID(), id, passwordHash, now),
  ]);
  if (created?.meta.changes !== 1 || linked?.meta.changes !== 1) {
    throw makeError("conflict", "The owner account already exists.");
  }
  return c.json({ ok: true }, 201);
});
