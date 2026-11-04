import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SPA_CSP } from "../src/shared/csp";

describe("static asset headers", () => {
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");

  it("serves the same CSP as src/shared/csp.ts", () => {
    expect(headers).toContain(`Content-Security-Policy: ${SPA_CSP}\n`);
  });

  it("keeps connect-src on self only and forbids inline scripts and eval", () => {
    expect(SPA_CSP).toContain("connect-src 'self';");
    // WebAssembly compilation only (xmllint-wasm): no 'unsafe-inline', no 'unsafe-eval'.
    expect(SPA_CSP).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(SPA_CSP).not.toContain("'unsafe-eval'");
    expect(SPA_CSP).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });
});
