import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { fakeSocket, literal } from "../pec/fake-socket";
import { FETCH_SOURCE_TRANSCRIPT, GREETING, PEC_RECEIPT_SOURCE } from "../pec/imap.fixtures";
import { imapFetchParse, imapProbe, smtpSend } from "./pec";

const authed = { "X-Spike-Secret": "test-spike-secret", Origin: "http://localhost" };
const configured = { ...env, PEC_USERNAME: "owner@pec.example", PEC_PASSWORD: "s3cret-pw" };

function call(path: string, init: RequestInit, bindings: object) {
  return createApp().request(`http://localhost${path}`, { ...init, headers: authed }, bindings);
}

describe("PEC probe gating", () => {
  it("skips every probe with a message naming the PEC variables when they are unset", async () => {
    for (const path of ["imap-probe", "imap-fetch-parse", "smtp-send"]) {
      const res = await call(
        `/api/spike/pec/${path}`,
        { method: "POST" },
        { ...env, PEC_USERNAME: "", PEC_PASSWORD: "" },
      );
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toContain("PEC_USERNAME");
      expect(text).toContain("PEC_PASSWORD");
    }
  });

  it("reports configuration and servers without values", async () => {
    const res = await call("/api/spike/pec/status", {}, configured);
    const body = await res.json();
    expect(body).toMatchObject({
      configured: true,
      imapHost: "imaps.pec.aruba.it",
      imapPort: 993,
      smtpHost: "smtps.pec.aruba.it",
      smtpPort: 465,
    });
    expect(JSON.stringify(body)).not.toContain("s3cret-pw");
  });

  it("answers a connection failure as ok=false with the password scrubbed", async () => {
    // No network in tests: the real socket cannot reach the IMAP host, so this is a failure path.
    const res = await call(
      "/api/spike/pec/imap-probe",
      { method: "POST", body: "{}" },
      { ...configured, PEC_IMAP_HOST: "127.0.0.1", PEC_IMAP_PORT: "1" },
    );
    expect([502, 500]).toContain(res.status);
    expect(await res.text()).not.toContain("s3cret-pw");
  });
});

describe("IMAP probe", () => {
  const summary = (uid: number, id: string) =>
    `* ${uid} FETCH (UID ${uid} RFC822.SIZE 900 FLAGS () INTERNALDATE "02-Nov-2026 09:15:01 +0100" ` +
    `BODY[HEADER.FIELDS (MESSAGE-ID FROM SUBJECT DATE)] ${literal(`Message-ID: <${id}>\r\nFrom: a@b.example\r\nSubject: S${uid}\r\n\r\n`)})\r\n`;

  it("lists the latest headers newest first and reads the quota", async () => {
    const socket = fakeSocket(GREETING, [
      {
        expect: 'A1 LOGIN "owner@pec.example" "s3cret-pw"',
        reply: "A1 OK Logged in\r\n",
      },
      {
        expect: 'A2 EXAMINE "INBOX"',
        reply:
          "* 3 EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 4] ok\r\nA2 OK [READ-ONLY] done\r\n",
      },
      { expect: /^A3 UID SEARCH UID 1:\*/, reply: "* SEARCH 1 2 3\r\nA3 OK done\r\n" },
      {
        expect: /^A4 UID FETCH 2,3 \(/,
        reply: `${summary(2, "m2@x")}${summary(3, "m3@x")}A4 OK done\r\n`,
      },
      {
        expect: 'A5 GETQUOTAROOT "INBOX"',
        reply: '* QUOTAROOT "INBOX" ""\r\n* QUOTA "" (STORAGE 100 1000)\r\nA5 OK done\r\n',
      },
      { expect: "A6 LOGOUT", reply: "* BYE\r\nA6 OK done\r\n" },
    ]);
    const result = await imapProbe(configured, 2, () => socket);
    expect(result.messages.map((m) => [m.uid, m.subject, m.messageId])).toEqual([
      [3, "S3", "<m3@x>"],
      [2, "S2", "<m2@x>"],
    ]);
    expect(result.quota).toMatchObject({ usedKb: 100, limitKb: 1000, percentUsed: 10 });
    expect(result.uidValidity).toBe(7);
    expect(JSON.stringify(result)).not.toContain("s3cret-pw");
  });

  it("fetches and parses the newest PEC envelope", async () => {
    const socket = fakeSocket(GREETING, [
      FETCH_SOURCE_TRANSCRIPT[0] as never,
      {
        expect: 'A2 EXAMINE "INBOX"',
        reply: "* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 4391] ok\r\nA2 OK done\r\n",
      },
      { expect: /^A3 UID SEARCH/, reply: "* SEARCH 4390\r\nA3 OK done\r\n" },
      {
        expect: /^A4 UID FETCH 4390 \(UID RFC822\.SIZE/,
        reply: `* 1 FETCH (UID 4390 RFC822.SIZE ${PEC_RECEIPT_SOURCE.length})\r\nA4 OK done\r\n`,
      },
      {
        expect: "A5 UID FETCH 4390 (UID BODY.PEEK[])",
        reply: `* 1 FETCH (UID 4390 BODY[] ${literal(PEC_RECEIPT_SOURCE)})\r\nA5 OK done\r\n`,
      },
      { expect: "A6 LOGOUT", reply: "* BYE\r\nA6 OK done\r\n" },
    ]);
    const result = await imapFetchParse(configured, () => socket);
    expect(result).toMatchObject({ uid: 4390, hasDaticert: true });
    const attachments = "innerAttachments" in result ? (result.innerAttachments ?? []) : [];
    expect(attachments.join()).toContain("IT01234567890_00001_RC_001.xml");
  });
});

describe("SMTP test send", () => {
  it("sends one PEC to the mailbox's own address with a base64 XML attachment", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let options: Record<string, unknown> = {};
    const result = await smtpSend(configured, async (o) => {
      options = o as unknown as Record<string, unknown>;
      return {
        send: async (email) => void sent.push(email as never),
        close: async () => undefined,
      };
    });
    expect(options).toMatchObject({
      host: "smtps.pec.aruba.it",
      port: 465,
      secure: true,
      startTls: false,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: "owner@pec.example", to: "owner@pec.example" });
    const attachments = (sent[0]?.attachments ?? []) as Array<{
      filename: string;
      content: string;
    }>;
    const attachment = attachments[0];
    expect(attachment?.filename).toMatch(/^IT00000000000_\d+\.xml$/);
    expect(atob(attachment?.content ?? "")).toContain("<p:FatturaElettronica");
    expect(JSON.stringify(result)).not.toContain("owner@pec.example");
  });
});
