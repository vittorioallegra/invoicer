import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { authClient } from "./auth-client";

/** A signed-in tab with no user activity for this long is signed out. */
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** Why the login screen is shown after a sign-out the owner did not ask for. */
export type SignOutReason = "idle";

/** Signs out through Better Auth, drops the cached data and goes to the login screen. */
export function useSignOut(): (reason?: SignOutReason) => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useCallback(
    async (reason) => {
      try {
        await authClient.signOut();
      } catch {
        // Offline: leave anyway; the session cookie expires on its own and the gate re-checks it.
      }
      queryClient.clear();
      await navigate({ to: "/login", search: reason ? { reason } : {}, replace: true });
    },
    [queryClient, navigate],
  );
}

/** Events that count as user activity (timers and background polling are not events). */
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "touchstart", "scroll", "wheel"];

/**
 * Signs the owner out after `IDLE_TIMEOUT_MS` without activity. The deadline is checked against the
 * clock, so a phone tab resumed after a long sleep (timers frozen) signs out on the first event,
 * on `visibilitychange` or on focus, before that event counts as activity.
 */
export function useIdleSignOut(): void {
  const signOut = useSignOut();
  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;

  useEffect(() => {
    let last = Date.now();
    let fired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const expired = () => Date.now() - last >= IDLE_TIMEOUT_MS;
    const fire = () => {
      if (fired) return;
      fired = true;
      void signOutRef.current("idle");
    };
    const arm = () => {
      timer = setTimeout(tick, Math.max(0, last + IDLE_TIMEOUT_MS - Date.now()));
    };
    const tick = () => (expired() ? fire() : arm());
    const activity = () => {
      if (expired()) fire();
      else last = Date.now();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") activity();
    };

    arm();
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, activity, { capture: true, passive: true });
    }
    window.addEventListener("focus", activity);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      for (const name of ACTIVITY_EVENTS) {
        window.removeEventListener(name, activity, { capture: true });
      }
      window.removeEventListener("focus", activity);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}
