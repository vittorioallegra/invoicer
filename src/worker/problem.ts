import {
  ApiError,
  ERROR_CODES,
  ERROR_TYPE_BASE,
  type ErrorCode,
  errorAnchor,
} from "../shared/errors";

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
