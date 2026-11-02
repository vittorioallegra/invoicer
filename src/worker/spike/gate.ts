import { createMiddleware } from "hono/factory";
import { safeEqual } from "../auth/crypto";
import { type Bindings, requireSecrets } from "../env";
import { makeError } from "../problem";

export const SPIKE_HEADER = "X-Spike-Secret";

export { safeEqual };

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
