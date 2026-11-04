import { describe, expect, it } from "vitest";
import { buildChecklist, type OnboardingFacts, sendReadiness, stagesFromTest } from "./onboarding";

const done: OnboardingFacts = {
  passkeyCount: 1,
  totpEnabled: true,
  profileComplete: true,
  pecCredentials: { username: true, password: true },
  pecTest: { ok: true, at: 1, error: null },
  adeGuideDone: true,
  emailConfigured: true,
};

describe("sendReadiness", () => {
  it("is ready with a profile, credentials and a passing test", () => {
    expect(sendReadiness(done)).toEqual({ ready: true, reasons: [] });
  });

  it("lists every reason in the order to fix them", () => {
    expect(
      sendReadiness({
        ...done,
        profileComplete: false,
        pecCredentials: { username: true, password: false },
      }),
    ).toEqual({ ready: false, reasons: ["profile_incomplete", "pec_credentials_missing"] });
  });

  it("asks for a test, and for a new one after a failure", () => {
    expect(sendReadiness({ ...done, pecTest: null }).reasons).toEqual(["pec_test_missing"]);
    expect(
      sendReadiness({ ...done, pecTest: { ok: false, at: 1, error: "login_failed" } }).reasons,
    ).toEqual(["pec_test_failed"]);
  });
});

describe("sendReadiness with the mock channel", () => {
  it("needs only the profile: credentials and the connection test are satisfied", () => {
    const noMailbox = {
      ...done,
      pecCredentials: { username: false, password: false },
      pecTest: null,
    };
    expect(sendReadiness(noMailbox, { mockChannel: true })).toEqual({ ready: true, reasons: [] });
    expect(sendReadiness(noMailbox).reasons).toEqual(["pec_credentials_missing"]);
    expect(
      sendReadiness({ ...noMailbox, profileComplete: false }, { mockChannel: true }).reasons,
    ).toEqual(["profile_incomplete"]);
  });
});

describe("buildChecklist", () => {
  it("marks each item from its own fact", () => {
    expect(buildChecklist(done).every((item) => item.done)).toBe(true);
    const pending = buildChecklist({
      ...done,
      passkeyCount: 0,
      pecTest: { ok: false, at: 1, error: "connection_failed" },
      adeGuideDone: false,
    });
    expect(pending.filter((item) => !item.done).map((item) => item.id)).toEqual([
      "passkey",
      "pec",
      "ade_guide",
    ]);
  });

  it("keeps the PEC item independent of the profile", () => {
    const items = buildChecklist({ ...done, profileComplete: false });
    expect(items.find((i) => i.id === "pec")?.done).toBe(true);
    expect(items.find((i) => i.id === "profile")?.done).toBe(false);
  });
});

describe("stagesFromTest", () => {
  it("marks the quota stage ok only when the stored test kept the mailbox space", () => {
    const quota = { usedKb: 12288, limitKb: 1048576 };
    expect(stagesFromTest({ ok: true, error: null, quota }).quota).toBe("ok");
    expect(stagesFromTest({ ok: true, error: null, quota: null }).quota).toBe("skipped");
    expect(stagesFromTest({ ok: true, error: null }).quota).toBe("skipped");
  });
});
