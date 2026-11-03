import { z } from "zod";

/**
 * API error contract: every non-2xx `/api/*` response is `application/problem+json` (RFC 9457)
 * with a stable `code` and the README heading `anchor` that documents it (Troubleshooting).
 */
export const ERROR_CODES = {
  bad_request: { status: 400, title: "Bad request" },
  unauthorized: { status: 401, title: "Authentication required" },
  forbidden: { status: 403, title: "Forbidden" },
  origin_not_allowed: { status: 403, title: "Origin not allowed" },
  send_not_authorized: { status: 403, title: "Send not authorized" },
  not_found: { status: 404, title: "Not found" },
  conflict: { status: 409, title: "Conflict" },
  number_unavailable: { status: 409, title: "Invoice number not available" },
  payload_too_large: { status: 413, title: "Payload too large" },
  rate_limited: { status: 429, title: "Too many requests" },
  internal_error: { status: 500, title: "Internal error" },
  pec_auth_failed: { status: 502, title: "PEC login refused" },
  pec_mailbox_full: { status: 502, title: "PEC mailbox full" },
  pec_sdi_address_missing: { status: 502, title: "SdI address not accepted" },
  pec_unavailable: { status: 502, title: "PEC server unavailable" },
  pec_rejected: { status: 502, title: "PEC server refused the message" },
  send_outcome_unknown: { status: 504, title: "Send outcome unknown" },
  missing_secret: { status: 503, title: "Server configuration incomplete" },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ERROR_TYPE_BASE = "urn:invoicer:error:";

export function errorAnchor(code: ErrorCode): string {
  return `error-${code.replaceAll("_", "-")}`;
}

export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  /** README heading anchor documenting this code. */
  anchor: z.string(),
  detail: z.string().optional(),
  /** Names of missing configuration (variable names only, never values). */
  missing: z.array(z.string()).optional(),
  /** Command that fixes the problem, e.g. `wrangler secret put NAME`. */
  fix: z.string().optional(),
});

export type Problem = z.infer<typeof problemSchema>;

/** Typed error thrown by the API client for any problem+json response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = "ApiError";
    this.status = problem.status;
    this.code = problem.code;
    this.problem = problem;
  }
}

/** Parses a failed response into an ApiError; falls back to a generic problem. */
export async function readApiError(response: Response): Promise<ApiError> {
  try {
    const parsed = problemSchema.safeParse(await response.json());
    if (parsed.success) return new ApiError(parsed.data);
  } catch {
    // Body was not JSON.
  }
  return new ApiError({
    type: `${ERROR_TYPE_BASE}internal_error`,
    title: ERROR_CODES.internal_error.title,
    status: response.status,
    code: "internal_error",
    anchor: errorAnchor("internal_error"),
  });
}
