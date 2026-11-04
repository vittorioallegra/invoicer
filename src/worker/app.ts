import { Hono } from "hono";
import { ApiError } from "../shared/errors";
import { createAuth } from "./auth/auth";
import { sendAuthorization } from "./auth/send-authorization";
import { requireSession } from "./auth/session";
import { setup } from "./auth/setup";
import { type Bindings, featureStatus, pecCredentialStatus } from "./env";
import { makeError, problemResponse } from "./problem";
import { clients } from "./routes/clients";
import { courtesyEmail } from "./routes/courtesy-email";
import { exportData } from "./routes/export";
import { health } from "./routes/health";
import { invoices } from "./routes/invoices";
import { jobs } from "./routes/jobs";
import { mailbox } from "./routes/mailbox";
import { notifications } from "./routes/notifications";
import { numberingSeries } from "./routes/numbering-series";
import { onboarding } from "./routes/onboarding";
import { paymentMethods } from "./routes/payment-methods";
import { profile } from "./routes/profile";
import { push } from "./routes/push";
import { received } from "./routes/received";
import { send } from "./routes/send";
import { settings } from "./routes/settings";
import { tax } from "./routes/tax";
import { originCheck, securityHeaders } from "./security";

export function createApp() {
  const app = new Hono<{ Bindings: Bindings }>();

  app.use("*", securityHeaders);
  app.use("/api/*", originCheck);
  app.use("/api/*", requireSession);

  app.route("/api/health", health);
  app.route("/api/setup", setup);
  app.route("/api/invoices", sendAuthorization);
  app.route("/api/invoices", send);
  app.route("/api/invoices", courtesyEmail);
  app.route("/api/invoices", invoices);
  app.route("/api/profile", profile);
  app.route("/api/clients", clients);
  app.route("/api/payment-methods", paymentMethods);
  app.route("/api/numbering-series", numberingSeries);
  app.route("/api/settings", settings);
  app.route("/api/tax", tax);
  app.route("/api/mailbox", mailbox);
  app.route("/api/jobs", jobs);
  app.route("/api/received", received);
  app.route("/api/notifications", notifications);
  app.route("/api/push", push);
  app.route("/api/export", exportData);
  app.route("/api/onboarding", onboarding);
  // Better Auth: sign-in, passkeys, TOTP, sessions. Sign-up is disabled (owner only via /api/setup).
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const response = await createAuth(c.env, c.req.url).handler(c.req.raw);
    if (response.status !== 429) return response;
    const limited = problemResponse(makeError("rate_limited"));
    const retryAfter = response.headers.get("X-Retry-After");
    if (retryAfter) limited.headers.set("Retry-After", retryAfter);
    return limited;
  });

  // Which optional features and PEC credentials are configured (never returns values).
  app.get("/api/features", (c) =>
    c.json({ ...featureStatus(c.env), pec: pecCredentialStatus(c.env) }),
  );

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
