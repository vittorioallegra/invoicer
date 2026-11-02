import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { problemSchema } from "../../shared/errors";
import { hashPassword, PBKDF2_ITERATIONS, verifyPassword } from "./password";
import {
  applyMigrations,
  OWNER,
  setupOwner,
  signIn,
  TestClient,
  totpCode,
  VirtualAuthenticator,
} from "./test-helpers";

const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

type Totp = { totpURI: string; backupCodes: string[] };

beforeAll(() => applyMigrations(env.DB));

describe("password hashing", () => {
  it("hashes with PBKDF2 at the reduced iteration count and verifies", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored.startsWith(`pbkdf2-sha256$${PBKDF2_ITERATIONS}$`)).toBe(true);
    expect(stored).not.toContain("correct horse battery");
    expect(await verifyPassword(stored, "correct horse battery")).toBe(true);
    expect(await verifyPassword(stored, "wrong password")).toBe(false);
    expect(await verifyPassword("garbage", "x")).toBe(false);
    expect(await hashPassword("correct horse battery")).not.toBe(stored);
  });
});

describe("first-run setup (AC 2)", () => {
  it("is refused when SETUP_TOKEN is not configured, naming the variable and the fix", async () => {
    const client = new TestClient("10.0.0.1", { ...env, SETUP_TOKEN: "" } as never);
    const { status, body } = await setupOwner(client, "anything");
    const problem = problemSchema.parse(body);
    expect(status).toBe(503);
    expect(problem.code).toBe("missing_secret");
    expect(problem.missing).toEqual(["SETUP_TOKEN"]);
    expect(problem.fix).toBe("wrangler secret put SETUP_TOKEN");
    expect(await count("user")).toBe(0);
  });

  it("is refused with a wrong token", async () => {
    const { status, body } = await setupOwner(new TestClient("10.0.0.2"), "wrong-token");
    expect(status).toBe(403);
    expect(problemSchema.parse(body).code).toBe("forbidden");
    expect(await count("user")).toBe(0);
  });

  it("rejects a short password", async () => {
    const { status } = await new TestClient("10.0.0.3").json("/api/setup", {
      body: { token: "test-setup-token", ...OWNER, password: "short" },
    });
    expect(status).toBe(400);
    expect(await count("user")).toBe(0);
  });

  it("reports that no owner exists yet", async () => {
    const { body } = await new TestClient("10.0.0.4").json("/api/setup/status");
    expect(body).toEqual({ ownerExists: false });
  });

  it("lets exactly one concurrent request create the owner", async () => {
    const results = await Promise.all(
      [5, 6, 7].map((n) => setupOwner(new TestClient(`10.0.0.${n}`))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await count("user")).toBe(1);
    expect(await count("account")).toBe(1);
    const row = await env.DB.prepare("SELECT password FROM account").first<{ password: string }>();
    expect(row?.password.startsWith("pbkdf2-sha256$")).toBe(true);
  });

  it("closes sign-up once the owner exists", async () => {
    const client = new TestClient("10.0.1.1");
    const again = await setupOwner(client);
    expect(again.status).toBe(409);
    expect(problemSchema.parse(again.body).code).toBe("conflict");

    const signUp = await client.json("/api/auth/sign-up/email", {
      body: { name: "Intruder", email: "intruder@example.com", password: "another-long-password" },
    });
    expect(signUp.status).toBeGreaterThanOrEqual(400);
    expect(await count("user")).toBe(1);
    expect((await new TestClient("10.0.1.2").json("/api/setup/status")).body).toEqual({
      ownerExists: true,
    });
  });
});

describe("session middleware", () => {
  it("keeps health public and protects the other API routes", async () => {
    const client = new TestClient("10.0.2.1");
    expect((await client.json("/api/health")).status).toBe(200);
    const denied = await client.json("/api/features");
    expect(denied.status).toBe(401);
    expect(problemSchema.parse(denied.body).code).toBe("unauthorized");
    expect((await signIn(client)).status).toBe(200);
    expect((await client.json("/api/features")).status).toBe(200);
    await client.json("/api/auth/sign-out", { body: {} });
    expect((await client.json("/api/features")).status).toBe(401);
  });
});

describe("login with a passkey (AC 3)", () => {
  it("registers a passkey and signs in with it, refusing unknown or unverified ones", async () => {
    const device = new VirtualAuthenticator();
    const owner = new TestClient("10.0.4.1");
    await signIn(owner);

    const options = await owner.json<{ challenge: string; rp: { id: string } }>(
      "/api/auth/passkey/generate-register-options",
    );
    expect(options.status).toBe(200);
    const registered = await owner.json("/api/auth/passkey/verify-registration", {
      body: { response: await device.register(options.body), name: "Test device" },
    });
    expect(registered.status).toBe(200);
    expect(await count("passkey")).toBe(1);

    const sessionless = async (ip: string) => {
      const client = new TestClient(ip);
      const challenge = await client.json<{ challenge: string }>(
        "/api/auth/passkey/generate-authenticate-options",
      );
      return { client, challenge: challenge.body.challenge };
    };

    // Valid assertion: signed in, no password and no TOTP needed.
    const ok = await sessionless("10.0.4.2");
    const signedIn = await ok.client.json("/api/auth/passkey/verify-authentication", {
      body: { response: await device.assert({ challenge: ok.challenge }) },
    });
    expect(signedIn.status).toBe(200);
    expect((await ok.client.json("/api/features")).status).toBe(200);

    // An authenticator the server never saw.
    const stranger = await sessionless("10.0.4.3");
    const refused = await stranger.client.json("/api/auth/passkey/verify-authentication", {
      body: {
        response: await new VirtualAuthenticator().assert({ challenge: stranger.challenge }),
      },
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect((await stranger.client.json("/api/features")).status).toBe(401);

    // Presence without user verification is refused.
    const noUv = await sessionless("10.0.4.4");
    const unverified = await noUv.client.json("/api/auth/passkey/verify-authentication", {
      body: {
        response: await device.assert({ challenge: noUv.challenge }, { userVerified: false }),
      },
    });
    expect(unverified.status).toBeGreaterThanOrEqual(400);
    expect((await noUv.client.json("/api/features")).status).toBe(401);

    // A wrong challenge (replay of an old assertion) is refused.
    const replay = await sessionless("10.0.4.5");
    const wrongChallenge = await replay.client.json("/api/auth/passkey/verify-authentication", {
      body: { response: await device.assert({ challenge: ok.challenge }) },
    });
    expect(wrongChallenge.status).toBeGreaterThanOrEqual(400);
  });
});

describe("login with password and TOTP (AC 3)", () => {
  it("requires a valid TOTP once enrolled, and refuses a wrong one", async () => {
    const enroll = new TestClient("10.0.3.1");
    expect((await signIn(enroll)).status).toBe(200);
    const enabled = await enroll.json<Totp>("/api/auth/two-factor/enable", {
      body: { password: OWNER.password },
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.backupCodes.length).toBeGreaterThan(0);
    const verified = await enroll.json("/api/auth/two-factor/verify-totp", {
      body: { code: await totpCode(enabled.body.totpURI) },
    });
    expect(verified.status).toBe(200);

    // A fresh browser: the password alone no longer opens a session.
    const login = new TestClient("10.0.3.2");
    const first = await signIn(login);
    expect(first.body).toMatchObject({ twoFactorRedirect: true });
    expect((await login.json("/api/features")).status).toBe(401);

    const wrong = await login.json("/api/auth/two-factor/verify-totp", {
      body: { code: "000000" },
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect((await login.json("/api/features")).status).toBe(401);

    const right = await login.json("/api/auth/two-factor/verify-totp", {
      body: { code: await totpCode(enabled.body.totpURI) },
    });
    expect(right.status).toBe(200);
    expect((await login.json("/api/features")).status).toBe(200);

    // A recovery code also completes the login, once.
    const recovery = new TestClient("10.0.3.3");
    await signIn(recovery);
    const code = enabled.body.backupCodes[0];
    expect(
      (await recovery.json("/api/auth/two-factor/verify-backup-code", { body: { code } })).status,
    ).toBe(200);
    const replay = new TestClient("10.0.3.4");
    await signIn(replay);
    expect(
      (await replay.json("/api/auth/two-factor/verify-backup-code", { body: { code } })).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it("refuses a wrong password", async () => {
    const { status } = await signIn(new TestClient("10.0.3.9"), "not-the-password-1");
    expect(status).toBe(401);
  });
});

describe("login rate limit", () => {
  it("answers 429 problem+json after repeated failed logins from one address", async () => {
    const client = new TestClient("10.0.5.1");
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await signIn(client, "wrong-password-xx")).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.at(-1)).toBe(429);
    const limited = await client.request("/api/auth/sign-in/email", {
      body: { email: OWNER.email, password: "wrong-password-xx" },
    });
    expect(limited.headers.get("Content-Type")).toContain("application/problem+json");
    expect(problemSchema.parse(await limited.json()).code).toBe("rate_limited");
    // Another address is not affected.
    expect((await signIn(new TestClient("10.0.5.2"), "wrong-password-xx")).status).toBe(401);
  });
});
