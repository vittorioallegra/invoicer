import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelError } from "../../shared/channel/types";
import type { Bindings } from "../env";
import {
  createPlacedChannel,
  POLLER_LOCATION_HINT,
  POLLER_NAME,
  pecConnectionTestPlaced,
  placedStub,
  pollerDeps,
  pollMailboxPlaced,
} from "./poller";

const realStub = pollerDeps.stub;
const noSecrets = { ...env, PEC_USERNAME: "", PEC_PASSWORD: "" } as Bindings;
const withSecrets = { ...env, PEC_USERNAME: "user@pec.test", PEC_PASSWORD: "pw" } as Bindings;
const servers = { imapHost: "i", imapPort: 993, smtpHost: "s", smtpPort: 465 };
const input = {
  fileName: "IT01_00001.xml",
  xml: new Uint8Array([1, 2, 3]),
  to: "sdi@pec.test",
  messageId: "<m@test>",
  invoiceNumber: "1/2026",
};

function fakeStub(methods: Record<string, unknown>) {
  pollerDeps.stub = () => methods as never;
}

afterEach(() => {
  pollerDeps.stub = realStub;
  vi.restoreAllMocks();
});

describe("placedStub", () => {
  it("asks for the same named object, hinted to Western Europe", () => {
    const get = vi.fn().mockReturnValue("stub");
    const idFromName = vi.fn().mockReturnValue("id");
    expect(placedStub({ ...env, PEC_POLLER: { get, idFromName } } as never)).toBe("stub");
    expect(idFromName).toHaveBeenCalledWith(POLLER_NAME);
    expect(get).toHaveBeenCalledWith("id", { locationHint: POLLER_LOCATION_HINT });
    expect(POLLER_LOCATION_HINT).toBe("weur");
  });

  it("is null without the binding (local dev)", () => {
    expect(placedStub({ ...env, PEC_POLLER: undefined } as never)).toBeNull();
  });
});

describe("pollMailboxPlaced", () => {
  it("polls through the object and returns its outcome", async () => {
    const outcome = { ok: true, counts: { stored: 2 } } as never;
    const poll = vi.fn().mockResolvedValue(outcome);
    fakeStub({ poll });
    expect(await pollMailboxPlaced(env as Bindings)).toBe(outcome);
    expect(poll).toHaveBeenCalledOnce();
  });

  it("polls in place without an object", async () => {
    pollerDeps.stub = () => null;
    // No PEC secrets: the in-place poll skips silently.
    expect(await pollMailboxPlaced(noSecrets)).toBeNull();
  });

  it("never polls from elsewhere when the object call fails: it waits for the next tick", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fakeStub({ poll: () => Promise.reject(new Error("boom")) });
    expect(await pollMailboxPlaced(withSecrets)).toBeNull();
    expect(error).toHaveBeenCalledWith("poller_unavailable", "Error");
  });
});

describe("pecConnectionTestPlaced", () => {
  it("runs the test in the object", async () => {
    const outcome = { ok: true, error: null, stages: {}, quota: null };
    fakeStub({ connectionTest: vi.fn().mockResolvedValue(outcome) });
    expect(await pecConnectionTestPlaced(withSecrets)).toBe(outcome);
  });

  it("reports a failed object call as a connection failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fakeStub({ connectionTest: () => Promise.reject(new Error("boom")) });
    const result = await pecConnectionTestPlaced(withSecrets);
    expect(result).toMatchObject({ ok: false, error: "connection_failed" });
  });

  it("still names a missing secret", async () => {
    fakeStub({ connectionTest: vi.fn() });
    await expect(pecConnectionTestPlaced(noSecrets)).rejects.toMatchObject({
      code: "missing_secret",
    });
  });
});

describe("createPlacedChannel", () => {
  it("has no channel without an object, so the caller sends in place", () => {
    pollerDeps.stub = () => null;
    expect(createPlacedChannel(withSecrets, servers)).toBeNull();
  });

  it("sends through the object and returns the message id", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, messageId: "<m@test>" });
    fakeStub({ send });
    const channel = createPlacedChannel(withSecrets, servers);
    expect(await channel?.send(input)).toEqual({ messageId: "<m@test>" });
    expect(send).toHaveBeenCalledWith(servers, input);
  });

  it("rebuilds the ChannelError the object reported", async () => {
    fakeStub({ send: () => Promise.resolve({ ok: false, code: "auth_failed", outcome: "none" }) });
    const failure = await createPlacedChannel(withSecrets, servers)
      ?.send(input)
      .catch((e) => e);
    expect(failure).toBeInstanceOf(ChannelError);
    expect(failure).toMatchObject({ code: "auth_failed", outcome: "none" });
  });

  it("treats a failed object call as an unknown outcome (the message may have gone out)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fakeStub({ send: () => Promise.reject(new Error("boom")) });
    const failure = await createPlacedChannel(withSecrets, servers)
      ?.send(input)
      .catch((e) => e);
    expect(failure).toMatchObject({ code: "unknown_outcome", outcome: "unknown" });
  });
});
