import { afterEach, describe, expect, it, vi } from "vitest";
import { resetFreshLaunchForTest, shouldSignOutOnLaunch, takeFreshLaunch } from "./fresh-launch";

function standalone(value: boolean) {
  vi.stubGlobal("matchMedia", () => ({ matches: value }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetFreshLaunchForTest(false);
});

describe("cold start", () => {
  it("is reported once", () => {
    resetFreshLaunchForTest(true);
    expect(takeFreshLaunch()).toBe(true);
    expect(takeFreshLaunch()).toBe(false);
  });

  it("signs the owner out on a cold start of the installed app", () => {
    standalone(true);
    resetFreshLaunchForTest(true);
    expect(shouldSignOutOnLaunch()).toBe(true);
    expect(shouldSignOutOnLaunch()).toBe(false);
  });

  it("leaves a normal browser tab alone", () => {
    standalone(false);
    resetFreshLaunchForTest(true);
    expect(shouldSignOutOnLaunch()).toBe(false);
  });

  it("leaves a resumed or reloaded app alone", () => {
    standalone(true);
    resetFreshLaunchForTest(false);
    expect(shouldSignOutOnLaunch()).toBe(false);
  });
});
