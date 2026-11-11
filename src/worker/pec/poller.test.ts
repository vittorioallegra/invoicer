import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../env";
import { POLLER_LOCATION_HINT, POLLER_NAME, pollerDeps, pollMailboxPlaced } from "./poller";

const realStub = pollerDeps.stub;

afterEach(() => {
  pollerDeps.stub = realStub;
  vi.restoreAllMocks();
});

describe("pollMailboxPlaced", () => {
  it("polls through the Durable Object and returns its outcome", async () => {
    const outcome = { ok: true, counts: { stored: 2 } } as never;
    const poll = vi.fn().mockResolvedValue(outcome);
    pollerDeps.stub = () => ({ poll }) as never;
    expect(await pollMailboxPlaced(env as Bindings)).toBe(outcome);
    expect(poll).toHaveBeenCalledOnce();
  });

  it("polls in place when there is no binding (local dev)", async () => {
    pollerDeps.stub = () => null;
    // No PEC secrets in the test env: the in-place poll skips silently.
    expect(await pollMailboxPlaced({ ...env, PEC_USERNAME: "", PEC_PASSWORD: "" })).toBeNull();
  });

  it("polls in place when the Durable Object call fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    pollerDeps.stub = () => ({ poll: () => Promise.reject(new Error("boom")) }) as never;
    expect(await pollMailboxPlaced({ ...env, PEC_USERNAME: "", PEC_PASSWORD: "" })).toBeNull();
    expect(error).toHaveBeenCalledWith("poller_unavailable", "Error");
  });

  it("asks for the same named object, hinted to Western Europe", () => {
    const get = vi.fn().mockReturnValue("stub");
    const idFromName = vi.fn().mockReturnValue("id");
    const stub = pollerDeps.stub({ ...env, PEC_POLLER: { get, idFromName } } as never);
    expect(stub).toBe("stub");
    expect(idFromName).toHaveBeenCalledWith(POLLER_NAME);
    expect(get).toHaveBeenCalledWith("id", { locationHint: POLLER_LOCATION_HINT });
    expect(POLLER_LOCATION_HINT).toBe("weur");
  });
});
