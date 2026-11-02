import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PEC_DEFAULTS } from "./config";
import { createPecChannel } from "./smtp";

/**
 * LIVE test, off by default. Set `PEC_LIVE=1` (plus PEC_USERNAME and PEC_PASSWORD) in `.dev.vars`
 * to send ONE real PEC through the production SMTP server. The recipient is the mailbox's own
 * address, never the SdI, and the attachment is a sample file, so nothing reaches the tax
 * authority. Written for the owner to run by hand; no automated run does.
 */
const vars = env as unknown as Record<string, string | undefined>;
const live = vars.PEC_LIVE === "1" && Boolean(vars.PEC_USERNAME && vars.PEC_PASSWORD);

describe.skipIf(!live)("live PEC send to the owner's own address (PEC_LIVE=1)", () => {
  it("hands a sample XML to the SMTP server", async () => {
    const username = vars.PEC_USERNAME as string;
    const stamp = String(Date.now()).slice(-5);
    const channel = createPecChannel(
      {
        imapHost: vars.PEC_IMAP_HOST || PEC_DEFAULTS.imapHost,
        imapPort: Number(vars.PEC_IMAP_PORT) || PEC_DEFAULTS.imapPort,
        smtpHost: vars.PEC_SMTP_HOST || PEC_DEFAULTS.smtpHost,
        smtpPort: Number(vars.PEC_SMTP_PORT) || PEC_DEFAULTS.smtpPort,
      },
      { username, password: vars.PEC_PASSWORD as string },
    );
    const messageId = `<live-${stamp}@${username.split("@").pop()}>`;
    const result = await channel.send({
      fileName: `IT00000000000_${stamp}.xml`,
      xml: new TextEncoder().encode('<?xml version="1.0"?><Sample/>'),
      to: username,
      messageId,
      invoiceNumber: "live-test",
    });
    expect(result.messageId).toBe(messageId);
  });
});
