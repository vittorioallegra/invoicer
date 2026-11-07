import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { authClient } from "./auth-client";
import { recordActivity, storedActivity, takeFreshLaunch } from "./presence";

/** A signed-in app with no user activity for this long is signed out (the server session agrees). */
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** While the owner is active the server session is renewed at most this often. */
export const KEEPALIVE_MS = 60 * 1000;

/** Why the login screen is shown after a sign-out the owner did not ask for. */
export type SignOutReason = "idle" | "closed";

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
 * Signs the owner out after `IDLE_TIMEOUT_MS` without activity, in any tab. The deadline is checked
 * against the clock, so an app resumed after a long sleep (timers frozen) signs out on the first
 * event, on `visibilitychange` or on focus, before that event counts as activity. Starting the
 * app cold (every tab and the installed app were closed) or after more than the timeout of
 * inactivity signs out at once. While active it renews the server session once a minute.
 */
export function useIdleSignOut(): void {
  const signOut = useSignOut();
  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;

  useEffect(() => {
    // Where the idle clock stands when the app starts: the last activity any tab recorded.
    let last = storedActivity() ?? Date.now();
    let fired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastKeepAlive = Date.now();

    const lastSeen = () => Math.max(last, storedActivity() ?? 0);
    const expired = () => Date.now() - lastSeen() >= IDLE_TIMEOUT_MS;
    const fire = (reason: SignOutReason = "idle") => {
      if (fired) return;
      fired = true;
      void signOutRef.current(reason);
    };
    const keepAlive = () => {
      if (Date.now() - lastKeepAlive < KEEPALIVE_MS) return;
      lastKeepAlive = Date.now();
      // A failed renewal must never break the page: the next activity tries again.
      void Promise.resolve()
        .then(() => authClient.getSession())
        .catch(() => {});
    };
    const arm = () => {
      timer = setTimeout(tick, Math.max(0, lastSeen() + IDLE_TIMEOUT_MS - Date.now()));
    };
    const tick = () => (expired() ? fire() : arm());
    const activity = () => {
      if (expired()) {
        fire();
        return;
      }
      last = Date.now();
      recordActivity();
      keepAlive();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") activity();
    };

    // Cold start (the app was closed) or the idle time ran out while it was closed.
    if (takeFreshLaunch()) {
      fire("closed");
      return;
    }
    if (expired()) {
      fire();
      return;
    }
    recordActivity();
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
