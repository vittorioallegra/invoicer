import { useSyncExternalStore } from "react";

const COARSE = "(pointer: coarse)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(COARSE);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

function snapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(COARSE).matches;
}

/**
 * True on touch-first devices (phones, tablets), where the platform's own select and date wheel
 * are best. Without `matchMedia` (server, jsdom) it is true, so the native controls are the default.
 */
export function useNativeControls(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}
