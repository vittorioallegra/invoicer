import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { Hono } from "hono";
import type { Bindings } from "../env";
import { makeError } from "../problem";
import { checkChallenge, issueChallenge } from "./challenge";
import { fromBase64Url, readJson, timed, toBase64Url, writeJson } from "./util";

export interface StoredCredential {
  id: string;
  /** COSE public key, base64url. */
  publicKey: string;
  counter: number;
  transports?: string[];
  deviceType: string;
  backedUp: boolean;
  registeredAt: string;
}

const KEY = "credentials";

export function relyingParty(requestUrl: string) {
  const url = new URL(requestUrl);
  return { rpID: url.hostname, origin: url.origin };
}

/** Verifies one assertion against a stored credential; the challenge must carry `bind`. */
export async function verifyAssertion(opts: {
  response: AuthenticationResponseJSON;
  credential: Pick<StoredCredential, "id" | "publicKey" | "counter">;
  expectedChallenge: string | ((challenge: string) => boolean | Promise<boolean>);
  origin: string;
  rpID: string;
}) {
  return verifyAuthenticationResponse({
    response: opts.response,
    expectedChallenge: opts.expectedChallenge,
    expectedOrigin: opts.origin,
    expectedRPID: opts.rpID,
    requireUserVerification: true,
    credential: {
      id: opts.credential.id,
      publicKey: fromBase64Url(opts.credential.publicKey),
      counter: opts.credential.counter,
    },
  });
}

export const passkey = new Hono<{ Bindings: Bindings }>();

passkey.get("/credentials", async (c) => {
  const list = await readJson<StoredCredential[]>(c.env, KEY, []);
  return c.json({ credentials: list.map(({ publicKey: _omit, ...rest }) => rest) });
});

passkey.delete("/credentials", async (c) => {
  await writeJson(c.env, KEY, []);
  return c.json({ ok: true });
});

passkey.post("/register/options", async (c) => {
  const { rpID } = relyingParty(c.req.url);
  const existing = await readJson<StoredCredential[]>(c.env, KEY, []);
  const challenge = await issueChallenge(c.env.SPIKE_SECRET as string, "register", "register");
  const options = await generateRegistrationOptions({
    rpName: "Invoicer spike",
    rpID,
    userName: "spike-owner",
    userID: Uint8Array.from(new TextEncoder().encode("spike-owner")),
    challenge,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: existing.map((cred) => ({
      id: cred.id,
      transports: cred.transports as never,
    })),
  });
  return c.json(options);
});

passkey.post("/register/verify", async (c) => {
  const response = (await c.req.json()) as RegistrationResponseJSON;
  const { rpID, origin } = relyingParty(c.req.url);
  const secret = c.env.SPIKE_SECRET as string;
  const { value: verification, clockMs } = await timed(async () => {
    try {
      return await verifyRegistrationResponse({
        response,
        expectedChallenge: (challenge) => checkChallenge(secret, "register", "register", challenge),
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch (error) {
      return { verified: false as const, error: error instanceof Error ? error.message : "error" };
    }
  });
  if (
    !verification.verified ||
    !("registrationInfo" in verification) ||
    !verification.registrationInfo
  ) {
    return c.json(
      {
        verified: false,
        error: "error" in verification ? verification.error : "not verified",
        clockMs,
      },
      400,
    );
  }
  const info = verification.registrationInfo;
  const stored: StoredCredential = {
    id: info.credential.id,
    publicKey: toBase64Url(info.credential.publicKey),
    counter: info.credential.counter,
    ...(info.credential.transports ? { transports: info.credential.transports } : {}),
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    registeredAt: new Date().toISOString(),
  };
  const list = await readJson<StoredCredential[]>(c.env, KEY, []);
  await writeJson(c.env, KEY, [...list.filter((cred) => cred.id !== stored.id), stored]);
  return c.json({
    verified: true,
    credentialId: stored.id,
    deviceType: stored.deviceType,
    backedUp: stored.backedUp,
    clockMs,
  });
});

passkey.post("/auth/options", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { bind?: string };
  const bind = typeof body.bind === "string" ? body.bind : "invoice-1|sha256-of-xml";
  const { rpID } = relyingParty(c.req.url);
  const challenge = await issueChallenge(c.env.SPIKE_SECRET as string, "authenticate", bind);
  const options = await generateAuthenticationOptions({
    rpID,
    challenge,
    userVerification: "required",
  });
  return c.json({ options, bind });
});

passkey.post("/auth/verify", async (c) => {
  const body = (await c.req.json()) as { response?: AuthenticationResponseJSON; bind?: string };
  if (!body.response || typeof body.bind !== "string") throw makeError("bad_request");
  const list = await readJson<StoredCredential[]>(c.env, KEY, []);
  const credential = list.find((cred) => cred.id === body.response?.id);
  if (!credential) {
    return c.json({ verified: false, error: "credential not registered on the server" }, 400);
  }
  const { rpID, origin } = relyingParty(c.req.url);
  const secret = c.env.SPIKE_SECRET as string;
  const bind = body.bind;
  const { value, clockMs } = await timed(async () => {
    try {
      const result = await verifyAssertion({
        response: body.response as AuthenticationResponseJSON,
        credential,
        expectedChallenge: (challenge) => checkChallenge(secret, "authenticate", bind, challenge),
        origin,
        rpID,
      });
      return { verified: result.verified, newCounter: result.authenticationInfo.newCounter };
    } catch (error) {
      return { verified: false, error: error instanceof Error ? error.message : "error" };
    }
  });
  if (value.verified && "newCounter" in value) {
    await writeJson(
      c.env,
      KEY,
      list.map((cred) =>
        cred.id === credential.id ? { ...cred, counter: value.newCounter } : cred,
      ),
    );
  }
  return c.json({ ...value, clockMs }, value.verified ? 200 : 400);
});
