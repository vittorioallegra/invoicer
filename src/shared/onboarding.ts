/**
 * Setup checklist and the "can the owner send?" gate. Pure: the Worker gathers the facts, this
 * decides. The invoice editor (step 9) and the send flow (step 12) use `sendReadiness`.
 */

export const CHECKLIST_ITEMS = [
  "passkey",
  "fallback_login",
  "profile",
  "pec",
  "ade_guide",
  "email",
] as const;
export type ChecklistItemId = (typeof CHECKLIST_ITEMS)[number];

export interface PecTestResult {
  ok: boolean;
  /** Epoch milliseconds of the last connection test. */
  at: number;
  /** Failure code (`connection_failed`, `login_failed`, `mailbox_failed`); null when ok. */
  error: string | null;
}

export interface OnboardingFacts {
  passkeyCount: number;
  totpEnabled: boolean;
  profileComplete: boolean;
  pecCredentials: { username: boolean; password: boolean };
  pecTest: PecTestResult | null;
  adeGuideDone: boolean;
  emailConfigured: boolean;
}

export interface ChecklistItem {
  id: ChecklistItemId;
  done: boolean;
}

export type SendBlockReason =
  | "profile_incomplete"
  | "pec_credentials_missing"
  | "pec_test_missing"
  | "pec_test_failed";

export interface SendReadiness {
  ready: boolean;
  /** Why sending is blocked, in the order the owner should fix them. Empty when ready. */
  reasons: SendBlockReason[];
}

export function sendReadiness(
  facts: Pick<OnboardingFacts, "profileComplete" | "pecCredentials" | "pecTest">,
): SendReadiness {
  const reasons: SendBlockReason[] = [];
  if (!facts.profileComplete) reasons.push("profile_incomplete");
  if (!facts.pecCredentials.username || !facts.pecCredentials.password) {
    reasons.push("pec_credentials_missing");
  } else if (!facts.pecTest) {
    reasons.push("pec_test_missing");
  } else if (!facts.pecTest.ok) {
    reasons.push("pec_test_failed");
  }
  return { ready: reasons.length === 0, reasons };
}

export function buildChecklist(facts: OnboardingFacts): ChecklistItem[] {
  const done: Record<ChecklistItemId, boolean> = {
    passkey: facts.passkeyCount > 0,
    fallback_login: facts.totpEnabled,
    profile: facts.profileComplete,
    pec: sendReadiness({ ...facts, profileComplete: true }).ready,
    ade_guide: facts.adeGuideDone,
    email: facts.emailConfigured,
  };
  return CHECKLIST_ITEMS.map((id) => ({ id, done: done[id] }));
}

export interface OnboardingStatus {
  checklist: ChecklistItem[];
  /** Every item is done: Home hides the checklist. */
  complete: boolean;
  send: SendReadiness;
  pecTest: PecTestResult | null;
}
