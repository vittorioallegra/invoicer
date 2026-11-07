import { beforeEach, vi } from "vitest";
import { resetFreshLaunchForTest } from "./lib/presence";

/** Node 26 ships an experimental `localStorage` global that shadows jsdom's: use a plain one. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

// Every test starts as a warm start of the app with no stored idle clock or open tabs.
beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  resetFreshLaunchForTest(false);
});
