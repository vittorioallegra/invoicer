import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TABS = "invoicer.tabs";

async function load() {
  vi.resetModules();
  return import("./presence");
}

function reloadNavigation(type: string) {
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([
    { type } as unknown as PerformanceEntry,
  ]);
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("cold start detection", () => {
  it("is a cold start when no tab is open", async () => {
    const presence = await load();
    expect(presence.takeFreshLaunch()).toBe(true);
    expect(presence.takeFreshLaunch()).toBe(false);
  });

  it("is not a cold start while another tab is open", async () => {
    localStorage.setItem(TABS, JSON.stringify({ other: Date.now() - 4000 }));
    const presence = await load();
    expect(presence.takeFreshLaunch()).toBe(false);
  });

  it("is a cold start when the last heartbeat is old (the app was killed without a signal)", async () => {
    localStorage.setItem(TABS, JSON.stringify({ gone: Date.now() - 31_000 }));
    const presence = await load();
    expect(presence.takeFreshLaunch()).toBe(true);
  });

  it("is not a cold start on a reload, when the tab has just removed itself", async () => {
    reloadNavigation("reload");
    const presence = await load();
    expect(presence.takeFreshLaunch()).toBe(false);
  });

  it("is a cold start when the page is opened by navigation", async () => {
    reloadNavigation("navigate");
    const presence = await load();
    expect(presence.takeFreshLaunch()).toBe(true);
  });
});

function Probe({ use }: { use: () => void }) {
  use();
  return null;
}

describe("usePresence", () => {
  const tabs = () => Object.keys(JSON.parse(localStorage.getItem(TABS) ?? "{}"));

  it("keeps the tab registered with a heartbeat and removes it when the page is hidden for good", async () => {
    const presence = await load();
    render(<Probe use={presence.usePresence} />);
    expect(tabs()).toHaveLength(1);
    const first = JSON.parse(localStorage.getItem(TABS) ?? "{}");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(presence.HEARTBEAT_MS + 1);
    });
    const second = JSON.parse(localStorage.getItem(TABS) ?? "{}");
    const id = tabs()[0] as string;
    expect(second[id]).toBeGreaterThan(first[id]);

    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(tabs()).toHaveLength(0);
  });

  it("lets a second tab see the first one as open", async () => {
    const first = await load();
    render(<Probe use={first.usePresence} />);
    const second = await load();
    expect(second.takeFreshLaunch()).toBe(false);
  });
});

describe("idle clock", () => {
  it("writes the last activity at most every few seconds unless forced", async () => {
    const presence = await load();
    presence.recordActivity();
    const first = presence.storedActivity();
    vi.advanceTimersByTime(1000);
    presence.recordActivity();
    expect(presence.storedActivity()).toBe(first);
    presence.recordActivity(true);
    expect(presence.storedActivity()).toBeGreaterThan(first ?? 0);
  });
});
