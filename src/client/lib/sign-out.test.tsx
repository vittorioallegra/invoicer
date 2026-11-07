import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_KEY, resetFreshLaunchForTest } from "./presence";
import { IDLE_TIMEOUT_MS, KEEPALIVE_MS, useIdleSignOut, useSignOut } from "./sign-out";

const mocks = vi.hoisted(() => ({ signOut: vi.fn(), getSession: vi.fn(), navigate: vi.fn() }));

vi.mock("./auth-client", () => ({
  authClient: { signOut: mocks.signOut, getSession: mocks.getSession },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));

function Idle() {
  useIdleSignOut();
  return null;
}

function Manual() {
  const signOut = useSignOut();
  return (
    <button type="button" onClick={() => void signOut()}>
      out
    </button>
  );
}

function mount(node: React.ReactNode) {
  render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
}

const flush = () => act(async () => {});

beforeEach(() => {
  vi.useFakeTimers();
  mocks.signOut.mockReset().mockResolvedValue({ data: { success: true }, error: null });
  mocks.getSession.mockReset().mockResolvedValue({ data: null, error: null });
  mocks.navigate.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSignOut", () => {
  it("signs out and goes to the login screen", async () => {
    mount(<Manual />);
    await act(async () => {
      document.querySelector("button")?.click();
    });
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/login", search: {}, replace: true });
  });
});

describe("useIdleSignOut", () => {
  it("signs out after the idle timeout and tells the login screen why", async () => {
    mount(<Idle />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1000);
    });
    expect(mocks.signOut).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/login",
      search: { reason: "idle" },
      replace: true,
    });
  });

  it("counts pointer, key, touch and scroll activity and restarts the countdown", async () => {
    mount(<Idle />);
    for (const event of [
      new Event("pointerdown"),
      new Event("keydown"),
      new Event("touchstart"),
      new Event("scroll"),
    ]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 60_000);
      });
      act(() => void window.dispatchEvent(event));
    }
    expect(mocks.signOut).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    });
    expect(mocks.signOut).toHaveBeenCalledOnce();
  });

  it("does not count timers or background requests as activity", async () => {
    mount(<Idle />);
    const poll = setInterval(() => void fetch("/api/notifications").catch(() => {}), 30_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    });
    clearInterval(poll);
    vi.unstubAllGlobals();
    expect(mocks.signOut).toHaveBeenCalledOnce();
  });

  it("signs out at once when a tab is resumed after the timeout", async () => {
    mount(<Idle />);
    // The device slept: the clock moved on but no timer ran.
    vi.setSystemTime(Date.now() + IDLE_TIMEOUT_MS + 5000);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(mocks.signOut).toHaveBeenCalledOnce();
  });

  it("signs out on focus after the timeout, and not before it", async () => {
    mount(<Idle />);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(mocks.signOut).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + IDLE_TIMEOUT_MS + 1);
    act(() => void window.dispatchEvent(new Event("focus")));
    await flush();
    expect(mocks.signOut).toHaveBeenCalledOnce();
  });

  it("signs out at once on a cold start of the app (every tab and the installed app were closed)", async () => {
    resetFreshLaunchForTest(true);
    mount(<Idle />);
    await flush();
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/login",
      search: { reason: "closed" },
      replace: true,
    });
  });

  it("signs out at once when the last activity, in any tab, is older than the timeout", async () => {
    localStorage.setItem(ACTIVITY_KEY, String(Date.now() - IDLE_TIMEOUT_MS - 1000));
    mount(<Idle />);
    await flush();
    expect(mocks.signOut).toHaveBeenCalledOnce();
  });

  it("keeps the session while another tab is active", async () => {
    mount(<Idle />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1000);
    });
    // Another tab recorded activity: this one must not sign out.
    localStorage.setItem(ACTIVITY_KEY, String(Date.now()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("renews the server session while active, at most once a minute, and never when idle", async () => {
    mount(<Idle />);
    act(() => void window.dispatchEvent(new Event("pointerdown")));
    expect(mocks.getSession).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    });
    act(() => void window.dispatchEvent(new Event("keydown")));
    act(() => void window.dispatchEvent(new Event("keydown")));
    await flush();
    expect(mocks.getSession).toHaveBeenCalledOnce();
    mocks.getSession.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1000);
    });
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("stops watching once unmounted", async () => {
    mount(<Idle />);
    cleanup();
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 2);
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});
