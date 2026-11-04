import { ApiError, ERROR_CODES, ERROR_TYPE_BASE, errorAnchor } from "../shared/errors";

/** Worker bindings, plain-text vars and secrets. See `.dev.vars.example` and wrangler.jsonc. */
export interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;

  // Plain vars (owner-specific, set in the deploy config or `.dev.vars`).
  APP_ORIGIN?: string;
  MAIL_FROM_ADDRESS?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_SUBJECT?: string;
  /** PEC server settings; defaults are the Aruba PEC hosts (`src/worker/pec/config.ts`). */
  PEC_IMAP_HOST?: string;
  PEC_IMAP_PORT?: string;
  PEC_SMTP_HOST?: string;
  PEC_SMTP_PORT?: string;
  /** `mock` serves local dev (no mail is sent); honoured only when APP_ORIGIN is localhost. */
  SEND_CHANNEL?: string;

  // Secrets (set with `wrangler secret put <NAME>`).
  BETTER_AUTH_SECRET?: string;
  SETUP_TOKEN?: string;
  /** PEC mailbox login: one password for IMAP, SMTP and webmail (no read/write split). */
  PEC_USERNAME?: string;
  PEC_PASSWORD?: string;
  RESEND_API_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
}

/**
 * Secrets required per route group. A missing one fails that group only, naming the variable
 * and the fix command, never a value.
 */
export const REQUIRED_SECRETS = {
  auth: ["BETTER_AUTH_SECRET", "SETUP_TOKEN"],
  pec: ["PEC_USERNAME", "PEC_PASSWORD"],
  // Courtesy email: required only by the actions that send one (the feature is otherwise off).
  email: ["RESEND_API_KEY"],
  // Push: required by the actions that subscribe or send (the feature is otherwise off).
  push: ["VAPID_PRIVATE_KEY", "VAPID_PUBLIC_KEY", "VAPID_SUBJECT"],
} as const satisfies Record<string, readonly (keyof Bindings)[]>;

/** Optional features: when their secrets are missing they are "off" (settings banner). */
export const OPTIONAL_FEATURES = {
  email: ["RESEND_API_KEY", "MAIL_FROM_ADDRESS"],
  push: ["VAPID_PRIVATE_KEY", "VAPID_PUBLIC_KEY", "VAPID_SUBJECT"],
} as const satisfies Record<string, readonly (keyof Bindings)[]>;

export type SecretGroup = keyof typeof REQUIRED_SECRETS;
export type OptionalFeature = keyof typeof OPTIONAL_FEATURES;

function isSet(env: Bindings, name: keyof Bindings): boolean {
  const value = env[name];
  return typeof value === "string" && value.length > 0;
}

export function missingSecrets(env: Bindings, group: SecretGroup): string[] {
  return REQUIRED_SECRETS[group].filter((name) => !isSet(env, name));
}

/** Throws a `missing_secret` ApiError naming each variable and the `wrangler secret put` fix. */
export function requireSecrets(env: Bindings, group: SecretGroup): void {
  const missing = missingSecrets(env, group);
  if (missing.length === 0) return;
  throw new ApiError({
    type: `${ERROR_TYPE_BASE}missing_secret`,
    title: ERROR_CODES.missing_secret.title,
    status: ERROR_CODES.missing_secret.status,
    code: "missing_secret",
    anchor: errorAnchor("missing_secret"),
    detail: `Missing configuration: ${missing.join(", ")}.`,
    missing,
    fix: missing.map((name) => `wrangler secret put ${name}`).join(" && "),
  });
}

/** Which optional features are configured; the UI shows a banner for the ones that are off. */
export function featureStatus(env: Bindings): Record<OptionalFeature, boolean> {
  const on = (names: readonly (keyof Bindings)[]) => names.every((name) => isSet(env, name));
  return { email: on(OPTIONAL_FEATURES.email), push: on(OPTIONAL_FEATURES.push) };
}

/** Whether each PEC credential is set; Settings shows this, never the values. */
export function pecCredentialStatus(env: Bindings): { username: boolean; password: boolean } {
  return { username: isSet(env, "PEC_USERNAME"), password: isSet(env, "PEC_PASSWORD") };
}

/** The mock channel is for local development only: it needs an explicit var and a localhost origin. */
export function isMockChannel(env: Bindings): boolean {
  if (env.SEND_CHANNEL !== "mock" || !env.APP_ORIGIN) return false;
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(env.APP_ORIGIN).hostname);
  } catch {
    return false;
  }
}
