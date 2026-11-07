import { passkey as passkeyPlugin } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import * as authSchema from "../../db/schema";
import { type Bindings, requireSecrets } from "../env";
import { hashPassword, verifyPassword } from "./password";

const { user, session, account, verification, twoFactor: twoFactorTable } = authSchema;
const schema = {
  user,
  session,
  account,
  verification,
  twoFactor: twoFactorTable,
  passkey: authSchema.passkey,
  rateLimit: authSchema.rateLimit,
};

export const AUTH_BASE_PATH = "/api/auth";
export const MIN_PASSWORD_LENGTH = 12;
const APP_NAME = "Invoicer";
/**
 * A session lasts this long after the last renewal. Only the app's own keepalive (`GET
 * /api/auth/get-session`, sent while the owner is active) renews it: API calls and background
 * polling read the session with `disableRefresh`, so an idle or closed app signs itself out.
 */
export const SESSION_IDLE_SECONDS = 10 * 60;
/** A renewal is written at most this often. */
export const SESSION_RENEW_AFTER_SECONDS = 30;

/**
 * Login rate limit per client IP, kept in D1 (Worker isolates share no memory). Better Auth
 * adds its own stricter limit for `/two-factor/*` and locks a TOTP after repeated failures.
 */
const RATE_LIMIT_RULES = {
  "/sign-in/email": { window: 60, max: 5 },
  "/passkey/generate-authenticate-options": { window: 60, max: 10 },
  "/passkey/verify-authentication": { window: 60, max: 10 },
  "/two-factor/verify-totp": { window: 60, max: 5 },
  "/two-factor/verify-backup-code": { window: 60, max: 5 },
  // Frequent and harmless: do not spend a D1 write on it.
  "/get-session": false,
} as const;

/** The origin the app is served from: `APP_ORIGIN` when set, otherwise the request's. */
export function appOrigin(env: Bindings, requestUrl: string): string {
  return env.APP_ORIGIN || new URL(requestUrl).origin;
}

/**
 * Better Auth bound to this request's D1 binding. Sign-up is disabled for good: the only way
 * to create the owner is `POST /api/setup` (src/worker/auth/setup.ts), which needs `SETUP_TOKEN`.
 */
export function createAuth(env: Bindings, requestUrl: string) {
  requireSecrets(env, "auth");
  const origin = appOrigin(env, requestUrl);
  const db = drizzle(env.DB, { schema });
  return betterAuth({
    appName: APP_NAME,
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET as string,
    trustedOrigins: [origin],
    logger: { level: "error" },
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: 128,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) => verifyPassword(hash, password),
      },
    },
    session: { expiresIn: SESSION_IDLE_SECONDS, updateAge: SESSION_RENEW_AFTER_SECONDS },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: RATE_LIMIT_RULES,
    },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    databaseHooks: {
      user: {
        create: {
          // Belt and braces: whatever path creates a user, a second user is refused.
          before: async () => {
            const [existing] = await db.select({ id: user.id }).from(user).limit(1);
            if (existing) throw new APIError("FORBIDDEN", { message: "Sign-up is closed." });
          },
        },
      },
    },
    plugins: [
      twoFactor({ issuer: APP_NAME }),
      passkeyPlugin({
        rpID: new URL(origin).hostname,
        rpName: APP_NAME,
        origin,
        // Discoverable credential with user verification (Face ID / Touch ID).
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        authentication: {
          afterVerification: ({ verification: result }) => {
            if (!result.authenticationInfo.userVerified) {
              throw new APIError("UNAUTHORIZED", { message: "User verification is required." });
            }
          },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
