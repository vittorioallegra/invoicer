import { describe, expect, it } from "vitest";
import { fakeSocket, literal } from "./fake-socket";
import { ImapClient, ImapError, openMailbox, parseValues, quote } from "./imap";
import {
  EXAMINE_REPLY,
  FETCH_SOURCE_TRANSCRIPT,
  FETCH_SUMMARIES_TRANSCRIPT,
  GREETING,
  LOGIN_FAILED_TRANSCRIPT,
  PEC_RECEIPT_SOURCE,
  POLL_TRANSCRIPT,
  QUOTA_NO_SUPPORT_TRANSCRIPT,
  QUOTA_TRANSCRIPT,
} from "./imap.fixtures";

const credentials = { username: "owner@pec.example", password: "s3cret-pw" };
const decode = (bytes: Uint8Array | null | undefined) =>
  new TextDecoder().decode(bytes ?? new Uint8Array());

describe("IMAP client against a fake socket", () => {
  it("logs in, examines the mailbox and polls for new UIDs (transcript)", async () => {
    const socket = fakeSocket(GREETING, POLL_TRANSCRIPT);
    const client = await openMailbox(socket, credentials);
    const info = await client.select("INBOX");
    expect(info).toEqual({ uidValidity: 3857529045, uidNext: 4392, exists: 23 });
    // `UID n:*` returns the last message even when it is not newer: it must be filtered out.
    expect(await client.searchNewerThan(4391)).toEqual([]);
    expect(await client.searchNewerThan(4388)).toEqual([4389, 4390, 4391]);
    await client.logout();
    expect(socket.remaining()).toBe(0);
    expect(socket.closed).toBe(true);
    // Read-only: EXAMINE, never SELECT, STORE, EXPUNGE or DELETE.
    const sent = socket.received.join("\n");
    expect(sent).toContain("EXAMINE");
    expect(sent).not.toMatch(/\b(STORE|EXPUNGE|DELETE|COPY|APPEND)\b/);
  });

  it("fetches summaries with size, flags, date and selected headers", async () => {
    const socket = fakeSocket(GREETING, FETCH_SUMMARIES_TRANSCRIPT);
    const client = await openMailbox(socket, credentials);
    await client.select();
    const summaries = await client.fetchSummaries([4389, 4390]);
    expect(summaries.map((m) => [m.uid, m.size, m.flags])).toEqual([
      [4389, 5120, ["\\Seen"]],
      [4390, 48211, []],
    ]);
    expect(summaries[0]?.internalDate).toBe("02-Nov-2026 09:15:01 +0100");
    const headers = decode(
      summaries[1]?.sections["BODY[HEADER.FIELDS (MESSAGE-ID FROM SUBJECT DATE)]"],
    );
    expect(headers).toContain("Message-ID: <abc@sdi.fatturapa.it>");
    expect(socket.received.some((l) => l.includes("BODY.PEEK[HEADER.FIELDS"))).toBe(true);
  });

  it("fetches a full message source byte for byte, also from 1-byte chunks", async () => {
    for (const chunkSize of [Number.POSITIVE_INFINITY, 1, 7]) {
      const socket = fakeSocket(GREETING, FETCH_SOURCE_TRANSCRIPT, { chunkSize });
      const client = await openMailbox(socket, credentials);
      await client.select();
      expect(decode(await client.fetchSource(4390))).toBe(PEC_RECEIPT_SOURCE);
      await client.logout();
    }
  });

  it("reads STORAGE quota when supported and returns null when not", async () => {
    const withQuota = await openMailbox(fakeSocket(GREETING, QUOTA_TRANSCRIPT), credentials);
    expect(await withQuota.getQuota()).toEqual({ usedKb: 12288, limitKb: 1048576 });
    const without = await openMailbox(
      fakeSocket(GREETING, QUOTA_NO_SUPPORT_TRANSCRIPT),
      credentials,
    );
    expect(await without.getQuota()).toBeNull();
  });

  it("reports a rejected login without echoing the password", async () => {
    const socket = fakeSocket(GREETING, LOGIN_FAILED_TRANSCRIPT);
    const error = await openMailbox(socket, credentials).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImapError);
    expect((error as ImapError).code).toBe("login_failed");
    expect((error as ImapError).message).not.toContain(credentials.password);
    expect(socket.closed).toBe(true);
  });

  it("aborts on a literal bigger than the cap", async () => {
    const socket = fakeSocket(GREETING, FETCH_SOURCE_TRANSCRIPT);
    const client = new ImapClient(socket, { maxLiteralBytes: 100 });
    await client.greeting();
    await client.login(credentials.username, credentials.password);
    await client.select();
    const error = await client.fetchSource(4390).catch((e: unknown) => e);
    expect((error as ImapError).code).toBe("too_large");
  });

  it("fails clearly when the server closes the connection", async () => {
    const socket = fakeSocket("* OK ready\r\n", []);
    const client = new ImapClient(socket);
    await client.greeting();
    const pending = client.select().catch((e: unknown) => e);
    socket.close();
    expect(((await pending) as ImapError).code).toBe("closed");
  });

  it("rejects a bad greeting and non-ASCII or empty input before sending anything", async () => {
    const bad = fakeSocket("* BYE go away\r\n", []);
    await expect(new ImapClient(bad).greeting()).rejects.toMatchObject({ code: "protocol" });
    expect(() => quote("pässword")).toThrow(ImapError);
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
    const ok = fakeSocket(GREETING, []);
    await expect(new ImapClient(ok).fetchSummaries([])).rejects.toMatchObject({ code: "input" });
    expect(ok.received).toEqual([]);
  });
});

describe("response value parser", () => {
  it("parses nested lists, quoted strings, NIL and literals", () => {
    const values = parseValues('(UID 7 FLAGS (\\Seen \\Answered) X NIL "a \\"b\\"" \0 0\0)', [
      new TextEncoder().encode("raw"),
    ]);
    expect(values).toHaveLength(1);
    const list = values[0] as unknown[];
    expect(list.slice(0, 4)).toEqual(["UID", "7", "FLAGS", ["\\Seen", "\\Answered"]]);
    expect(list[5]).toBeNull();
    expect(list[6]).toBe('a "b"');
    expect(decode(list[7] as Uint8Array)).toBe("raw");
  });

  it("keeps section specifiers with spaces and parentheses as one key", () => {
    const [list] = parseValues("(BODY[HEADER.FIELDS (A B)] \0 0\0)", [new Uint8Array(0)]);
    expect((list as unknown[])[0]).toBe("BODY[HEADER.FIELDS (A B)]");
  });
});

describe("literal helper and examine reply", () => {
  it("counts bytes, not characters", () => {
    expect(literal("è")).toBe("{2}\r\nè");
    expect(EXAMINE_REPLY).toContain("UIDVALIDITY");
  });
});
