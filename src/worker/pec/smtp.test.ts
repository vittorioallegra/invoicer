import { describe, expect, it } from "vitest";
import { scrubSecrets } from "../../shared/channel/errors";
import { retryDecision } from "../../shared/channel/quiet-period";
import { sdiAddressFor } from "../../shared/channel/sdi-address";
import type { ChannelError } from "../../shared/channel/types";
import { PEC_DEFAULTS } from "./config";
import { type ConnectMailer, createPecChannel, smtpLogin } from "./smtp";
import { SMTP_ERRORS } from "./smtp.fixtures";

const servers = {
  imapHost: PEC_DEFAULTS.imapHost,
  imapPort: PEC_DEFAULTS.imapPort,
  smtpHost: PEC_DEFAULTS.smtpHost,
  smtpPort: PEC_DEFAULTS.smtpPort,
};
const credentials = { username: "owner@pec.example.it", password: "s3cret-pass-word" };
const input = {
  fileName: "IT12345678903_00001.xml",
  xml: new TextEncoder().encode("<a/>"),
  to: "sdi01@pec.fatturapa.it",
  messageId: "<m1@pec.example.it>",
  invoiceNumber: "1",
};

function mailer(sendError?: string, connectError?: string) {
  const sent: unknown[] = [];
  let closed = 0;
  const connect: ConnectMailer = async () => {
    if (connectError) throw new Error(connectError);
    return {
      async send(email) {
        if (sendError) throw new Error(sendError);
        sent.push(email);
      },
      async close() {
        closed++;
      },
    };
  };
  return { connect, sent, closed: () => closed };
}

describe("PEC SMTP channel", () => {
  it("sends the XML as an attachment with the chosen Message-ID", async () => {
    const m = mailer();
    const result = await createPecChannel(servers, credentials, m.connect).send(input);
    expect(result.messageId).toBe(input.messageId);
    expect(m.sent[0]).toMatchObject({
      from: credentials.username,
      to: input.to,
      headers: { "Message-ID": input.messageId },
      attachments: [{ filename: input.fileName, mimeType: "application/xml" }],
    });
    expect(m.closed()).toBe(1);
  });

  const failure = async (sendError?: string, connectError?: string) => {
    const m = mailer(sendError, connectError);
    return createPecChannel(servers, credentials, m.connect)
      .send(input)
      .catch((e: unknown) => e as ChannelError);
  };

  it("maps connect and auth failures to a definite refusal", async () => {
    expect(await failure(undefined, SMTP_ERRORS.authFailed)).toMatchObject({
      code: "auth_failed",
      outcome: "none",
    });
    expect(await failure(undefined, SMTP_ERRORS.greeting)).toMatchObject({
      code: "unavailable",
      outcome: "none",
    });
  });

  it("maps server replies on an open session to refusals", async () => {
    expect(await failure(SMTP_ERRORS.mailboxFull)).toMatchObject({
      code: "mailbox_full",
      outcome: "none",
    });
    expect(await failure(SMTP_ERRORS.rcptRefused)).toMatchObject({
      code: "sdi_address_missing",
      outcome: "none",
    });
    expect(await failure(SMTP_ERRORS.bodyRefused)).toMatchObject({
      code: "rejected",
      outcome: "none",
    });
  });

  it("treats a timeout or a closed connection after the session opened as unknown", async () => {
    expect(await failure(SMTP_ERRORS.timeout)).toMatchObject({ outcome: "unknown" });
    expect(await failure(SMTP_ERRORS.closed)).toMatchObject({ outcome: "unknown" });
  });

  it("never carries the password or AUTH lines in an error", async () => {
    const error = await failure(undefined, `${SMTP_ERRORS.authFailed} ${credentials.password}`);
    expect(JSON.stringify(error)).not.toContain(credentials.password);
    expect(
      scrubSecrets(`C: AUTH PLAIN AGZvbwBiYXI=\r\nS: 235 ok ${credentials.password}`, [
        credentials.password,
      ]),
    ).not.toMatch(/AGZvbw|s3cret/);
  });

  it("logs in without sending", async () => {
    const m = mailer();
    await smtpLogin(servers, credentials, m.connect);
    expect(m.sent).toHaveLength(0);
    expect(m.closed()).toBe(1);
    await expect(
      smtpLogin(servers, credentials, mailer(undefined, SMTP_ERRORS.authLogin).connect),
    ).rejects.toMatchObject({ code: "auth_failed" });
  });
});

describe("SdI address rule and quiet period", () => {
  it("uses sdi01 until the SdI assigns an address", () => {
    expect(sdiAddressFor(null)).toBe("sdi01@pec.fatturapa.it");
    expect(sdiAddressFor("  ")).toBe("sdi01@pec.fatturapa.it");
    expect(sdiAddressFor("sdi99@pec.fatturapa.it")).toBe("sdi99@pec.fatturapa.it");
  });

  it("decides retries from the attempts", () => {
    const t0 = 1_000_000;
    expect(retryDecision([{ outcome: "none", startedAt: t0 }], t0, null)).toEqual({
      allowed: true,
      mode: "same_attempt",
    });
    expect(retryDecision([{ outcome: "complete", startedAt: t0 }], t0 + 1e9, null)).toMatchObject({
      allowed: false,
      reason: "already_sent",
    });
    const unknown = [{ outcome: "unknown" as const, startedAt: t0 }];
    const quiet = t0 + 15 * 60_000;
    expect(retryDecision(unknown, t0 + 14 * 60_000, quiet)).toMatchObject({
      allowed: false,
      reason: "quiet_period",
    });
    // The quiet period is over, but no poll has completed since: still locked.
    expect(retryDecision(unknown, quiet, null)).toMatchObject({
      allowed: false,
      reason: "awaiting_poll",
    });
    expect(retryDecision(unknown, quiet + 60_000, quiet - 1)).toMatchObject({
      allowed: false,
      reason: "awaiting_poll",
    });
    // A poll that started after the quiet period found nothing for the attempt: unlocked.
    expect(retryDecision(unknown, quiet + 60_000, quiet)).toEqual({
      allowed: true,
      mode: "new_attempt",
    });
  });
});
