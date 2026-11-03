import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureToFatturaInput } from "../../shared/fixtures/fatturapa";
import { INVOICE_FIXTURES } from "../../shared/fixtures/invoices";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  check: vi.fn(),
  pdf: vi.fn(),
  start: vi.fn(),
  reserve: vi.fn(),
  release: vi.fn(),
  newAttempt: vi.fn(),
  upload: vi.fn(),
  challenge: vi.fn(),
  send: vi.fn(),
  calls: [] as string[],
}));

vi.mock("./api", () => ({ api: mocks.api }));
vi.mock("./xsd", () => ({ checkFatturaXml: mocks.check }));
vi.mock("../pdf/generate", () => ({ generateAndStoreInvoicePdf: mocks.pdf }));
vi.mock("@simplewebauthn/browser", () => ({ startAuthentication: mocks.start }));
vi.mock("./invoices-api", () => ({
  reserveNumber: mocks.reserve,
  releaseNumber: mocks.release,
  newAttempt: mocks.newAttempt,
  uploadXml: mocks.upload,
  requestSendChallenge: mocks.challenge,
  sendInvoice: mocks.send,
}));

import { runSendFlow, type SendFlowError } from "./send-flow";

const fixture = INVOICE_FIXTURES[0];
if (!fixture) throw new Error("no fixture");
const input = fixtureToFatturaInput(fixture, 1);
const invoice = {
  ...input.invoice,
  id: "inv-1",
  state: "draft",
  clientId: "c-1",
  number: null,
  issueDate: null,
  linked: null,
};
const client = { ...input.client, id: "c-1" };
const profile = { ...input.issuer, paymentDefaults: {} };
const valid = { valid: true, mapped: { problems: [], technical: [] } };
const invalid = {
  valid: false,
  mapped: {
    problems: [{ field: "client.address", index: null, kind: "required", raw: "x" }],
    technical: [],
  },
};

const hooks = { chooseAuthorization: vi.fn(async () => ({ kind: "passkey" as const })) };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.api.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/invoices/")) return { invoice };
    if (path === "/api/clients") return { clients: [client] };
    if (path === "/api/profile") return { profile };
    if (path === "/api/settings") return { invoiceNumber: { year: 2026, next: 2, minimum: 1 } };
    throw new Error(`unexpected ${path}`);
  });
  mocks.check.mockResolvedValue(valid);
  mocks.reserve.mockImplementation(async () => {
    mocks.calls.push("reserve");
    return {
      reservation: {
        number: 2,
        year: 2026,
        issueDate: "2026-11-02",
        reused: false,
        transmission: {
          id: "t1",
          attempt: 1,
          fileProgressive: 7,
          fileName: "IT12345678903_00007.xml",
        },
      },
    };
  });
  mocks.release.mockImplementation(async () => {
    mocks.calls.push("release");
  });
  mocks.pdf.mockImplementation(async () => {
    mocks.calls.push("pdf");
  });
  mocks.upload.mockImplementation(async (_id: string, bytes: Uint8Array) => {
    mocks.calls.push("upload");
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return {
      file: {
        sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
      },
    };
  });
  mocks.challenge.mockImplementation(async () => {
    mocks.calls.push("challenge");
    return { challengeId: "ch1", options: {}, passkeyAvailable: true, totpAvailable: true };
  });
  mocks.start.mockResolvedValue({ id: "cred" });
  mocks.send.mockImplementation(async () => {
    mocks.calls.push("send");
    return {
      messageId: "<m@x>",
      fileName: "IT12345678903_00007.xml",
      to: "sdi01@pec.fatturapa.it",
    };
  });
});

describe("browser send flow", () => {
  it("validates, reserves, builds, uploads, authorizes and sends, in order", async () => {
    const steps: string[] = [];
    const result = await runSendFlow("inv-1", { ...hooks, onStep: (s) => steps.push(s) });
    expect(result.fileName).toBe("IT12345678903_00007.xml");
    expect(steps).toEqual(["validate", "reserve", "build", "upload", "authorize", "send"]);
    expect(mocks.calls).toEqual(["reserve", "pdf", "upload", "challenge", "send"]);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    // The provisional XML uses the next number, the final one the reserved number and progressive.
    const [provisional, final] = mocks.check.mock.calls.map((c) => c[0] as string);
    expect(provisional).toContain("<Numero>2</Numero>");
    expect(final).toContain("<ProgressivoInvio>00007</ProgressivoInvio>");
    // The challenge is bound to the hash of the exact bytes that were uploaded.
    const uploaded = mocks.upload.mock.calls[0]?.[1] as Uint8Array;
    const digest = await crypto.subtle.digest("SHA-256", uploaded as BufferSource);
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(mocks.challenge).toHaveBeenCalledWith("inv-1", hash);
    expect(mocks.send).toHaveBeenCalledWith("inv-1", {
      challengeId: "ch1",
      passkey: { id: "cred" },
    });
  });

  it("manual channel reserves, builds and stores the files, then stops before any authorization", async () => {
    const steps: string[] = [];
    const result = await runSendFlow("inv-1", { onStep: (s) => steps.push(s) }, "manual");
    expect(result).toEqual({ messageId: null, fileName: "IT12345678903_00007.xml" });
    expect(steps).toEqual(["validate", "reserve", "build", "upload"]);
    expect(mocks.calls).toEqual(["reserve", "pdf", "upload"]);
    expect(mocks.challenge).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("stops before reserving when the provisional XML fails the XSD", async () => {
    mocks.check.mockResolvedValueOnce(invalid);
    const error = await runSendFlow("inv-1", hooks).catch((e: unknown) => e as SendFlowError);
    expect(error).toMatchObject({ code: "invalid_xml" });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("final-XML XSD failure after reserve releases the number and sends nothing", async () => {
    mocks.check.mockResolvedValueOnce(valid).mockResolvedValueOnce(invalid);
    const error = await runSendFlow("inv-1", hooks).catch((e: unknown) => e as SendFlowError);
    expect(error).toMatchObject({ code: "invalid_xml", detail: { released: true } });
    expect(mocks.calls).toEqual(["reserve", "release"]);
    expect(mocks.challenge).not.toHaveBeenCalled();
  });

  it("keeps the number when it cannot be released", async () => {
    mocks.check.mockResolvedValueOnce(valid).mockResolvedValueOnce(invalid);
    mocks.release.mockRejectedValueOnce(new Error("number_not_highest"));
    const error = await runSendFlow("inv-1", hooks).catch((e: unknown) => e as SendFlowError);
    expect(error).toMatchObject({ detail: { released: false, numberKept: true } });
  });

  it("cancelling the passkey prompt leaves the invoice unsent and the number reserved", async () => {
    mocks.start.mockRejectedValueOnce(new DOMException("cancelled", "NotAllowedError"));
    const error = await runSendFlow("inv-1", hooks).catch((e: unknown) => e as SendFlowError);
    expect(error).toMatchObject({ code: "cancelled" });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("answers with a TOTP code when the owner chooses it", async () => {
    await runSendFlow("inv-1", {
      chooseAuthorization: async () => ({ kind: "totp", code: "123456" }),
    });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledWith("inv-1", { challengeId: "ch1", totp: "123456" });
  });

  it("resends an already numbered invoice with a new attempt and its own file name", async () => {
    const numbered = { ...invoice, state: "rejected", number: "2", issueDate: "2026-11-02" };
    mocks.api.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/invoices/")) return { invoice: numbered };
      if (path === "/api/clients") return { clients: [client] };
      if (path === "/api/profile") return { profile };
      if (path === "/api/settings") return { invoiceNumber: { year: 2026, next: 3, minimum: 1 } };
      throw new Error(`unexpected ${path}`);
    });
    mocks.newAttempt.mockResolvedValue({
      transmission: { id: "t2", attempt: 2, fileName: "IT12345678903_00009.xml" },
    });
    await runSendFlow("inv-1", hooks);
    expect(mocks.reserve).not.toHaveBeenCalled();
    const final = mocks.check.mock.calls.at(-1)?.[0] as string;
    expect(final).toContain("<ProgressivoInvio>00009</ProgressivoInvio>");
    expect(final).toContain("<Numero>2</Numero>");
  });
});
