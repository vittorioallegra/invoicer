// Browser-side part of the secrets audit (AC 4): there is no error-reporting channel in the app,
// and what the browser shows about a failed call is limited to the typed problem the Worker built.
//
// protects=the browser never sends error reports anywhere (no beacon, socket, XHR or telemetry
// SDK, no fetch to another origin), never reads build-time env values, and shows a generic problem
// instead of a raw non-problem response body; fails_when=a client source adds such an egress path
// or reads `import.meta.env` beyond the build mode flags, or `readApiError` relays an unparsed body;
// no_claim=nothing about what the Worker puts in a problem (src/worker/secrets-audit.test.ts does)
// and nothing about browser extensions or the user's own devtools.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readApiError } from "../src/shared/errors";

const root = new URL("..", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) return sources(path);
    return /\.(ts|tsx|js)$/.test(name) && !/\.(test|fixtures)\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = [...sources("src/client"), "public/push-sw.js"];

describe("the browser has no error-reporting channel", () => {
  it("scans the client sources and the push service worker", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("uses no beacon, socket, XHR, event source or telemetry SDK", () => {
    const banned =
      /sendBeacon|XMLHttpRequest|new WebSocket|new EventSource|@sentry|\bsentry\b|bugsnag|datadog|posthog|logrocket|rollbar|window\.onerror|addEventListener\(\s*["'](error|unhandledrejection)["']/i;
    const hits = files.filter((file) => banned.test(readFileSync(join(root, file), "utf8")));
    expect(hits).toEqual([]);
  });

  it("calls fetch only with a path on its own origin (the Worker API and the XSD/asset files)", () => {
    const hits = files.flatMap((file) =>
      [
        ...readFileSync(join(root, file), "utf8").matchAll(/\bfetch\(\s*(["'`])(https?:)?\/\//g),
      ].map(() => file),
    );
    expect(hits).toEqual([]);
  });

  it("reads no build-time environment values beyond the mode flags", () => {
    const hits = files.flatMap((file) =>
      [...readFileSync(join(root, file), "utf8").matchAll(/import\.meta\.env(?:\.(\w+))?/g)]
        .filter((match) => !["MODE", "PROD", "DEV", "BASE_URL", "SSR"].includes(match[1] ?? ""))
        .map((match) => `${file}: ${match[0]}`),
    );
    expect(hits).toEqual([]);
  });
});

describe("what the browser shows about a failed call", () => {
  it("turns a body that is not a problem into a generic one, never the raw text", async () => {
    const proxyPage = new Response("<html>Upstream error: token=AUDIT-secret-value</html>", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    });
    const error = await readApiError(proxyPage);
    expect(error.code).toBe("internal_error");
    expect(JSON.stringify(error)).not.toContain("AUDIT-secret-value");
    expect(`${error.message} ${error.stack ?? ""}`).not.toContain("AUDIT-secret-value");
  });

  it("drops unknown fields of a problem body", async () => {
    const error = await readApiError(
      Response.json(
        {
          type: "https://errors.invoicer.invalid/not_found",
          title: "Not found",
          status: 404,
          code: "not_found",
          anchor: "error-not-found",
          leaked: "AUDIT-secret-value",
        },
        { status: 404 },
      ),
    );
    expect(JSON.stringify(error)).not.toContain("AUDIT-secret-value");
  });
});
