import { useCallback, useState } from "react";

/** Strings are trimmed, `undefined` and the ephemeral `key` of list items are dropped. */
function canonical(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined || key === "key") continue;
      out[key] = canonical(item);
    }
    return out;
  }
  return value;
}

/** True when two form states are the same after normalisation (trimmed text, no list keys). */
export function sameForm(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * Whether a form differs from what was loaded or last saved. The baseline starts as `initial`;
 * call `markSaved(value)` when the loaded data arrives (forms that load asynchronously) and after
 * a successful save. A new-item form passes its empty state as `initial`.
 */
export function useDirty<T>(
  initial: T,
  current: T,
): { dirty: boolean; markSaved: (value: T) => void } {
  const [baseline, setBaseline] = useState<T>(initial);
  const markSaved = useCallback((value: T) => setBaseline(value), []);
  return { dirty: !sameForm(baseline, current), markSaved };
}
