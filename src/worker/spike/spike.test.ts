import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { checkChallenge, issueChallenge } from "./challenge";
import { ASSERTION_FIXTURE, PUSH_SUBSCRIPTION_FIXTURE } from "./fixtures";
import { verifyAssertion } from "./passkey";
import { buildSpikePush } from "./push";

const SECRET = "test-spike-secret";
const authed = { "X-Spike-Secret": SECRET, Origin: "http://localhost" };

function call(path: string, init: RequestInit = {}, bindings: object = env) {
  return createApp().request(`http://localhost${path}`, init, bindings);
}

describe("spike gate", () => {
  it("answers 503 naming the variable when SPIKE_SECRET is not configured", async () => {
    const res = await call("/api/spike/ping", { headers: authed }, { ...env, SPIKE_SECRET: "" });
    expect(res.status).toBe(503);
    expect((await res.json()) as { missing: string[] }).toMatchObject({
      missing: ["SPIKE_SECRET"],
    });
  });

  it("hides the routes (404) without the header or with a wrong one", async () => {
    expect((await call("/api/spike/ping")).status).toBe(404);
    const wrong = await call("/api/spike/ping", { headers: { "X-Spike-Secret": "nope" } });
    expect(wrong.status).toBe(404);
    expect(await wrong.text()).not.toContain(SECRET);
  });

  it("lets the right header through", async () => {
    const res = await call("/api/spike/ping", { headers: authed });
    expect(res.status).toBe(200);
  });
});

describe("bound challenge", () => {
  it("accepts only the binding it was issued for, and only before expiry", async () => {
    const now = Date.now();
    const bytes = await issueChallenge(SECRET, "authenticate", "invoice-1|hash-a", now);
    const challenge = btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    expect(await checkChallenge(SECRET, "authenticate", "invoice-1|hash-a", challenge, now)).toBe(
      true,
    );
    expect(await checkChallenge(SECRET, "authenticate", "invoice-1|hash-b", challenge, now)).toBe(
      false,
    );
    expect(await checkChallenge(SECRET, "register", "invoice-1|hash-a", challenge, now)).toBe(
      false,
    );
    expect(
      await checkChallenge(SECRET, "authenticate", "invoice-1|hash-a", challenge, now + 200_000),
    ).toBe(false);
    expect(
      await checkChallenge("other-secret", "authenticate", "invoice-1|hash-a", challenge, now),
    ).toBe(false);
  });
});

describe("assertion verification", () => {
  const f = ASSERTION_FIXTURE;
  const credential = { id: f.credentialID, publicKey: f.publicKey, counter: f.counter - 1 };
  const base = {
    response: f.response,
    credential,
    expectedChallenge: f.challenge,
    origin: f.origin,
    rpID: f.rpID,
  };

  it("verifies a valid synthetic ES256 assertion", async () => {
    expect((await verifyAssertion(base)).verified).toBe(true);
  });

  it("rejects a tampered signature, a wrong origin and a wrong challenge", async () => {
    const accepted = async (override: object) => {
      try {
        return (await verifyAssertion({ ...base, ...override })).verified;
      } catch {
        return false;
      }
    };
    const bad = {
      ...f.response,
      response: {
        ...f.response.response,
        signature: f.response.response.signature.replace(/.$/, "A"),
      },
    };
    expect(await accepted({ response: bad })).toBe(false);
    expect(await accepted({ origin: "https://evil.example" })).toBe(false);
    expect(await accepted({ expectedChallenge: "d3Jvbmc" })).toBe(false);
    expect(await accepted({ credential: { ...credential, counter: f.counter } })).toBe(false);
  });

  it("route rejects an assertion for a credential that is not registered", async () => {
    await call("/api/spike/passkey/credentials", { method: "DELETE", headers: authed });
    const res = await call("/api/spike/passkey/auth/verify", {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ response: f.response, bind: "invoice-1|hash-a" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ verified: false });
  });

  it("route issues options whose challenge is bound", async () => {
    const res = await call("/api/spike/passkey/auth/options", {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ bind: "invoice-9|abc" }),
    });
    const { options } = (await res.json()) as {
      options: { challenge: string; userVerification: string };
    };
    expect(options.userVerification).toBe("required");
    expect(await checkChallenge(SECRET, "authenticate", "invoice-9|abc", options.challenge)).toBe(
      true,
    );
    expect(await checkChallenge(SECRET, "authenticate", "invoice-9|zzz", options.challenge)).toBe(
      false,
    );
  });
});

describe("web push sender", () => {
  it("builds an encrypted, VAPID-signed request without sending it", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ])) as CryptoKeyPair;
    const jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
    const request = await buildSpikePush(
      { VAPID_PRIVATE_KEY: jwk, VAPID_SUBJECT: "mailto:me@example.invalid" },
      PUSH_SUBSCRIPTION_FIXTURE,
      { title: "t", body: "b", url: "/spike" },
    );
    expect(request.endpoint).toBe(PUSH_SUBSCRIPTION_FIXTURE.endpoint);
    const headers = new Headers(request.headers);
    // @pushforge/builder 2.0.5 uses the legacy "aesgcm" content encoding (see docs/notes/spike.md).
    expect(headers.get("Content-Encoding")).toBe("aesgcm");
    expect(headers.get("Authorization")).toMatch(/^vapid /i);
    expect(headers.get("TTL")).toBe("3600");
    expect(request.body.byteLength).toBeGreaterThan(21);
  });

  it("refuses without a VAPID private key", async () => {
    await expect(
      buildSpikePush({}, PUSH_SUBSCRIPTION_FIXTURE, { title: "t", body: "b", url: "/" }),
    ).rejects.toThrow();
  });
});

describe("cpu probes", () => {
  const run = (name: string, query = "", bindings: object = env) =>
    call(`/api/spike/cpu/${name}${query}`, { method: "POST", headers: authed }, bindings);

  it("runs the local probes", async () => {
    for (const [name, query] of [
      ["pbkdf2", "?iterations=1000"],
      ["passkey-verify", ""],
      ["push-encrypt", ""],
    ] as const) {
      const body = (await (await run(name, query)).json()) as { ok: boolean; error?: string };
      expect(body.error).toBeUndefined();
      expect(body.ok).toBe(true);
    }
  });

  it("runs the PEC parse probes on fixtures", async () => {
    for (const name of ["pec-parse-receipt", "pec-parse-envelope", "pec-parse-invoice"]) {
      const body = (await (await run(name)).json()) as { ok: boolean; error?: string };
      expect(body.error).toBeUndefined();
      expect(body.ok).toBe(true);
    }
  });
});
