import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import {
  buildChecklist,
  type OnboardingFacts,
  type OnboardingStatus,
  type PecTestResult,
  type SendReadiness,
  sendReadiness,
} from "../shared/onboarding";
import { type Bindings, isMockChannel, pecCredentialStatus } from "./env";

/** The profile is usable for invoices when every field the XML needs is present. */
export function isProfileComplete(
  row: Pick<
    typeof schema.profile.$inferSelect,
    "name" | "vatNumber" | "address" | "postalCode" | "city" | "country" | "regimeFiscale"
  > | null,
): boolean {
  return Boolean(
    row?.name &&
      row.vatNumber &&
      row.address &&
      row.postalCode &&
      row.city &&
      row.country &&
      row.regimeFiscale,
  );
}

export function pecTestFromRow(
  row: Pick<
    typeof schema.settings.$inferSelect,
    "pecTestAt" | "pecTestOk" | "pecTestError" | "pecTestQuotaUsedKb" | "pecTestQuotaLimitKb"
  > | null,
): PecTestResult | null {
  if (!row?.pecTestAt || row.pecTestOk === null) return null;
  const quota =
    row.pecTestQuotaUsedKb !== null && row.pecTestQuotaLimitKb !== null
      ? { usedKb: row.pecTestQuotaUsedKb, limitKb: row.pecTestQuotaLimitKb }
      : null;
  return { ok: row.pecTestOk, at: row.pecTestAt.getTime(), error: row.pecTestError, quota };
}

async function loadFacts(env: Bindings, userId: string | null): Promise<OnboardingFacts> {
  const db = drizzle(env.DB, { schema });
  const [profileRow, settingsRow, passkeys, totp] = await Promise.all([
    db.select().from(schema.profile).where(eq(schema.profile.id, 1)).get(),
    db.select().from(schema.settings).where(eq(schema.settings.id, 1)).get(),
    userId
      ? db
          .select({ id: schema.passkey.id })
          .from(schema.passkey)
          .where(eq(schema.passkey.userId, userId))
      : Promise.resolve([]),
    userId
      ? db
          .select({ verified: schema.twoFactor.verified })
          .from(schema.twoFactor)
          .where(eq(schema.twoFactor.userId, userId))
          .get()
      : Promise.resolve(undefined),
  ]);
  return {
    passkeyCount: passkeys.length,
    totpEnabled: totp?.verified === true,
    profileComplete: isProfileComplete(profileRow ?? null),
    pecCredentials: pecCredentialStatus(env),
    pecTest: pecTestFromRow(settingsRow ?? null),
    adeGuideDone: Boolean(settingsRow?.adeGuideDoneAt),
    emailConfigured: Boolean(settingsRow?.emailConfiguredAt),
  };
}

/** Checklist items and the send gate for the Home screen. */
export async function loadOnboarding(env: Bindings, userId: string): Promise<OnboardingStatus> {
  const facts = await loadFacts(env, userId);
  const checklist = buildChecklist(facts);
  return {
    checklist,
    complete: checklist.every((item) => item.done),
    send: sendReadiness(facts, { mockChannel: isMockChannel(env) }),
    pecTest: facts.pecTest,
  };
}

/**
 * Whether sending is allowed and, if not, why. The invoice editor (step 9) shows the reasons and
 * the send flow (step 12) refuses to open any connection unless `ready`.
 */
export async function loadSendReadiness(env: Bindings): Promise<SendReadiness> {
  const facts = await loadFacts(env, null);
  return sendReadiness(facts, { mockChannel: isMockChannel(env) });
}
