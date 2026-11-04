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

describe("scroll lock under the CSP", () => {
  // protects=a dialog or sheet stops the page behind it from scrolling; fails_when=the stylesheet
  // loses the `body[data-scroll-locked]` rule (react-remove-scroll's own <style> is blocked by
  // `style-src 'self'`); no_claim=nothing about how the browser renders the lock (source check).
  it("keeps the scroll lock rule in the stylesheet", () => {
    const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
    expect(SPA_CSP).toContain("style-src 'self';");
    expect(css).toMatch(/body\[data-scroll-locked\]\s*\{\s*overflow:\s*hidden;/);
  });
});
