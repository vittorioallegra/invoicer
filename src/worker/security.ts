import { createMiddleware } from "hono/factory";
import { secureHeaders } from "hono/secure-headers";
import { ApiError, ERROR_CODES, ERROR_TYPE_BASE, errorAnchor } from "../shared/errors";
import type { Bindings } from "./env";

/** Safe headers on every Worker response. API responses are never framed, scripted or sniffed. */
export const securityHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
  },
  xContentTypeOptions: "nosniff",
  referrerPolicy: "no-referrer",
  strictTransportSecurity: "max-age=31536000; includeSubDomains",
  crossOriginOpenerPolicy: "same-origin",
  crossOriginResourcePolicy: "same-origin",
});

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Origin check for state-changing `/api/*` calls: the `Origin` header must equal the origin of
 * the request URL. The webhook is exempt (it is called by Openapi and uses a secret header).
 */
export const originCheck = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method) || c.req.path.startsWith("/api/webhooks/")) {
    return next();
  }
  const origin = c.req.header("Origin");
  if (origin !== new URL(c.req.url).origin) {
    throw new ApiError({
      type: `${ERROR_TYPE_BASE}origin_not_allowed`,
      title: ERROR_CODES.origin_not_allowed.title,
      status: ERROR_CODES.origin_not_allowed.status,
      code: "origin_not_allowed",
      anchor: errorAnchor("origin_not_allowed"),
    });
  }
  return next();
});

/** Headers for serving a stored original (XML, P7M, PDF): download only, never rendered. */
export function downloadHeaders(fileName: string, contentType: string): Headers {
  const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Headers({
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${safeName}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  });
}
