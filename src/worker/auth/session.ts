import { createMiddleware } from "hono/factory";
import type { Bindings } from "../env";
import { makeError } from "../problem";
import { createAuth } from "./auth";

/** `/api/*` paths reachable without a session. Each has its own protection (see the owners). */
const PUBLIC_PATHS = [
  /^\/api\/health(\/|$)/,
  // Better Auth's own endpoints (login, passkey, TOTP) and first-run setup (SETUP_TOKEN).
  /^\/api\/auth(\/|$)/,
  /^\/api\/setup(\/|$)/,
  // Temporary risk spike, gated by SPIKE_SECRET (removed in step 21).
  /^\/api\/spike(\/|$)/,
];

export interface SessionVariables {
  userId: string;
}

/** Requires a valid session for every non-public `/api/*` route. */
export const requireSession = createMiddleware<{
  Bindings: Bindings;
  Variables: SessionVariables;
}>(async (c, next) => {
  if (PUBLIC_PATHS.some((pattern) => pattern.test(c.req.path))) return next();
  const current = await createAuth(c.env, c.req.url).api.getSession({ headers: c.req.raw.headers });
  if (!current) throw makeError("unauthorized");
  c.set("userId", current.user.id);
  return next();
});
