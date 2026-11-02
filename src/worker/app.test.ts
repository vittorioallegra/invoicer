import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { problemSchema } from "../shared/errors";
import { createApp } from "./app";
import { requireSecrets } from "./env";

describe("health route", () => {
  it("returns ok with safe headers", async () => {
    const res = await createApp().request("/api/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });
});

describe("problem+json contract", () => {
  it("returns a stable shape for unknown API routes", async () => {
    const res = await createApp().request("/api/nope", {}, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("application/problem+json");
    const problem = problemSchema.parse(await res.json());
    expect(problem.code).toBe("not_found");
    expect(problem.anchor).toBe("error-not-found");
  });

  it("hides the message of unexpected errors", async () => {
    const app = createApp();
    app.get("/api/boom", () => {
      throw new Error("sk-secret-token-value");
    });
    const res = await app.request("/api/boom", {}, env);
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain("sk-secret-token-value");
    expect(problemSchema.parse(JSON.parse(text)).code).toBe("internal_error");
  });

  it("rejects state-changing calls without a matching Origin", async () => {
    const app = createApp();
    app.post("/api/things", (c) => c.json({ ok: true }));
    const bad = await app.request("/api/things", { method: "POST" }, env);
    expect(bad.status).toBe(403);
    expect(problemSchema.parse(await bad.json()).code).toBe("origin_not_allowed");
    const good = await app.request(
      "http://localhost/api/things",
      { method: "POST", headers: { Origin: "http://localhost" } },
      env,
    );
    expect(good.status).toBe(200);
  });
});

describe("missing secret", () => {
  it("names the variable and the fix, never a value", async () => {
    const app = createApp();
    app.get("/api/pec-check", (c) => {
      requireSecrets(c.env, "pec");
      return c.json({ ok: true });
    });
    const res = await app.request(
      "/api/pec-check",
      {},
      { ...env, PEC_USERNAME: "set-value", PEC_PASSWORD: "" },
    );
    expect(res.status).toBe(503);
    const text = await res.text();
    const problem = problemSchema.parse(JSON.parse(text));
    expect(problem.code).toBe("missing_secret");
    expect(problem.missing).toEqual(["PEC_PASSWORD"]);
    expect(problem.fix).toBe("wrangler secret put PEC_PASSWORD");
    expect(text).not.toContain("set-value");
  });

  it("passes when the group is configured", () => {
    expect(() =>
      requireSecrets({ ...env, BETTER_AUTH_SECRET: "a", SETUP_TOKEN: "b" }, "auth"),
    ).not.toThrow();
  });
});
