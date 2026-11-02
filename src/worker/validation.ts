import type { ZodError } from "zod";

/** `field: code` pairs for a failed body, so the UI can mark each field (codes are stable). */
export function validationDetail(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}
