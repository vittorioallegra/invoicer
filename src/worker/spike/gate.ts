import { createMiddleware } from "hono/factory";
import { type Bindings, requireSecrets } from "../env";
import { makeError } from "../problem";

export const SPIKE_HEADER = "X-Spike-Secret";

const encoder = new TextEncoder();

/** Constant-time string comparison (hashes first so the lengths do not leak). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

/**
 * Gate for the temporary spike routes (no auth exists yet): `X-Spike-Secret` must equal the
 * `SPIKE_SECRET` Worker secret. Without the secret configured the routes answer 503 naming the
 * variable; with a missing or wrong header they answer 404 so the routes stay hidden.
 */
export const spikeGate = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  requireSecrets(c.env, "spike");
  const given = c.req.header(SPIKE_HEADER) ?? "";
  if (!(await safeEqual(given, c.env.SPIKE_SECRET as string))) throw makeError("not_found");
  return next();
});
