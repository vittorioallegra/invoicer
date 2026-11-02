import { describe, expect, it } from "vitest";
import { ApiError, readApiError } from "./errors";

describe("readApiError", () => {
  it("turns a problem+json response into a typed ApiError", async () => {
    const body = {
      type: "urn:invoicer:error:conflict",
      title: "Conflict",
      status: 409,
      code: "conflict",
      anchor: "error-conflict",
      detail: "Already exists.",
    };
    const error = await readApiError(
      new Response(JSON.stringify(body), {
        status: 409,
        headers: { "Content-Type": "application/problem+json" },
      }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("conflict");
    expect(error.message).toBe("Already exists.");
  });

  it("falls back to internal_error for non-problem bodies", async () => {
    const error = await readApiError(new Response("<html>", { status: 502 }));
    expect(error.code).toBe("internal_error");
    expect(error.status).toBe(502);
  });
});
