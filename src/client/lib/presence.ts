import { useEffect } from "react";

/**
 * What the sign-out rules need to know beyond one page's memory, kept in `localStorage` so every
 * tab and the installed app share it:
 * - the time of the owner's last activity (the 10-minute idle clock),
 * - which tabs are open right now (a heartbeat per tab), so that opening the app when none was
 *   open means the previous one was closed: a cold start, and the session ends.
 */
export const ACTIVITY_KEY = "invoicer.lastActivity";
export const TABS_KEY = "invoicer.tabs";
/** A tab proves it is open this often... */
export const HEARTBEAT_MS = 5_000;
/** ...and counts as closed after this long without a heartbeat (iOS kills an app without a signal). */
export const TAB_STALE_MS = 30_000;
const ACTIVITY_WRITE_MS = 5_000;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked (private mode): the in-page idle timer still works on its own.
  }
}

// --- Idle clock ------------------------------------------------------------------------------

let lastWrite = 0;

/** Records user activity now (written at most every few seconds unless `force`). */
export function recordActivity(force = false): void {
  const now = Date.now();
  if (!force && now - lastWrite < ACTIVITY_WRITE_MS) return;
  lastWrite = now;
  write(ACTIVITY_KEY, String(now));
}

/** When the owner last did something, in any tab; null when unknown. */
export function storedActivity(): number | null {
  const value = Number(read(ACTIVITY_KEY));
  return Number.isFinite(value) && value > 0 ? value : null;
}

// --- Open tabs -------------------------------------------------------------------------------

function liveTabs(now: number): Record<string, number> {
  try {
    const parsed = JSON.parse(read(TABS_KEY) ?? "{}") as Record<string, unknown>;
    const live: Record<string, number> = {};
    for (const [id, beat] of Object.entries(parsed)) {
      if (typeof beat === "number" && now - beat < TAB_STALE_MS) live[id] = beat;
    }
    return live;
  } catch {
    return {};
  }
}

function wasReload(): boolean {
  try {
    const entry = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return entry?.type === "reload";
  } catch {
    return false;
  }
}

/** A reload empties the registry for an instant, so it is not a cold start. */
let fresh = Object.keys(liveTabs(Date.now())).length === 0 && !wasReload();

/** Returns whether this page load is a cold start, once: later calls return false. */
export function takeFreshLaunch(): boolean {
  const value = fresh;
  fresh = false;
  return value;
}

/** Test seam: pretend the app was (or was not) just launched. */
export function resetFreshLaunchForTest(value: boolean): void {
  fresh = value;
}

/**
 * Login and setup screens call this so a cold start that ends in a sign-in does not sign the
 * owner out again the moment the app shell mounts.
 */
export function useConsumeFreshLaunch(): void {
  useEffect(() => {
    takeFreshLaunch();
  }, []);
}

/** Mounted once at the root: keeps this tab in the registry while it is open. */
export function usePresence(): void {
  useEffect(() => {
    const id = Math.random().toString(36).slice(2);
    const beat = () => {
      const now = Date.now();
      write(TABS_KEY, JSON.stringify({ ...liveTabs(now), [id]: now }));
    };
    const leave = () => {
      const tabs = liveTabs(Date.now());
      delete tabs[id];
      write(TABS_KEY, JSON.stringify(tabs));
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", beat);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", beat);
      leave();
    };
  }, []);
}
