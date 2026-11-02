import { Hono } from "hono";
import {
  ApiError,
  ERROR_CODES,
  ERROR_TYPE_BASE,
  type ErrorCode,
  errorAnchor,
} from "../shared/errors";
import { type Bindings, featureStatus } from "./env";
import { health } from "./routes/health";
import { originCheck, securityHeaders } from "./security";

export function problemResponse(error: ApiError): Response {
  return new Response(JSON.stringify(error.problem), {
    status: error.status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

export function makeError(code: ErrorCode, detail?: string): ApiError {
  const { status, title } = ERROR_CODES[code];
  return new ApiError({
    type: `${ERROR_TYPE_BASE}${code}`,
    title,
    status,
    code,
    anchor: errorAnchor(code),
    ...(detail ? { detail } : {}),
  });
}

export function createApp() {
  const app = new Hono<{ Bindings: Bindings }>();

  app.use("*", securityHeaders);
  app.use("/api/*", originCheck);

  app.route("/api/health", health);

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

export const app = createApp();
