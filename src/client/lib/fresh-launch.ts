import { useEffect } from "react";

const KEY = "invoicer.launched";

/** True when the app runs as an installed home-screen app (iOS `navigator.standalone` or PWA mode). */
export function isStandalone(): boolean {
  try {
    return (
      (navigator as { standalone?: boolean }).standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches
    );
  } catch {
    return false;
  }
}

/**
 * `sessionStorage` lives as long as the app process: it survives a reload and the app going to
 * the background, but not the app being killed. A missing marker therefore means a cold start.
 */
function readAndMark(): boolean {
  try {
    const seen = sessionStorage.getItem(KEY) === "1";
    sessionStorage.setItem(KEY, "1");
    return !seen;
  } catch {
    return false;
  }
}

let fresh = readAndMark();

/** Returns whether this page load is a cold start, once: later calls return false. */
export function takeFreshLaunch(): boolean {
  const value = fresh;
  fresh = false;
  return value;
}

/** Test seam: pretend the app was just launched. */
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

/**
 * Whether a session found at mount should be dropped: the installed app was killed and
 * relaunched, so the owner signs in again (a passkey makes that one tap).
 */
export function shouldSignOutOnLaunch(): boolean {
  return takeFreshLaunch() && isStandalone();
}
