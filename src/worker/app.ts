import { Hono } from "hono";
import { ApiError } from "../shared/errors";
import { type Bindings, featureStatus } from "./env";
import { makeError, problemResponse } from "./problem";
import { health } from "./routes/health";
import { originCheck, securityHeaders } from "./security";
import { spike } from "./spike/routes";

export function createApp() {
  const app = new Hono<{ Bindings: Bindings }>();

  app.use("*", securityHeaders);
  app.use("/api/*", originCheck);

  app.route("/api/health", health);
  // Temporary risk-spike routes (gated by SPIKE_SECRET); removed in step 21.
  app.route("/api/spike", spike);

  // Which optional features are configured (never returns values).
  app.get("/api/features", (c) => c.json(featureStatus(c.env)));

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) return problemResponse(makeError("not_found"));
    return c.env.ASSETS.fetch(c.req.raw);
  });

  app.onError((error) => {
    if (error instanceof ApiError) return problemResponse(error);
    // Unknown errors: log the name only, never the message or request data (may hold secrets).
    console.error("unhandled_error", error instanceof Error ? error.name : typeof error);
    return problemResponse(makeError("internal_error"));
  });

  return app;
}

export { makeError, problemResponse };

export const app = createApp();
