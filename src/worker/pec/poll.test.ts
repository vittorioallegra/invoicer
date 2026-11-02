import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../auth/test-helpers";
import type { Bindings } from "../env";
import { createD1FileStorage } from "../storage";
import { MAX_MESSAGES_PER_RUN, pollDeps, pollMailbox } from "./poll";
import { otherPecMail, plainMail, receivedInvoiceMessage, sdiMessage } from "./receipt-fixtures";
import { pollEnv, resetPolling, useMailbox } from "./test-support";

const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
const cursor = () =>
  env.DB.prepare("SELECT mailbox_uid_validity AS v, mailbox_last_uid AS u FROM settings").first<{
    v: number;
    u: number;
  }>();
const kinds = async () =>
  (
    await env.DB.prepare("SELECT uid, kind FROM pec_messages ORDER BY uid").all<{
      uid: number;
      kind: string;
    }>()
  ).results;

beforeAll(async () => {
  await applyMigrations(env.DB);
});
beforeEach(async () => {
  await resetPolling(env.DB);
});

describe("mailbox polling: cursor and storage", () => {
  it("starts at the head of the mailbox on the first run and ignores older mail", async () => {
    const server = useMailbox([
      { uid: 1, source: plainMail("old-1") },
      { uid: 2, source: plainMail("old-2") },
    ]);
    const first = await pollMailbox(pollEnv);
    expect(first?.ok).toBe(true);
    expect(await count("pec_messages")).toBe(0);
    expect(await cursor()).toEqual({ v: 1000, u: 2 });

    server.add({ uid: 3, source: plainMail("new-1") });
    await pollMailbox(pollEnv);
    expect(await kinds()).toEqual([{ uid: 3, kind: "ignored" }]);
    expect(await cursor()).toEqual({ v: 1000, u: 3 });
  });

  it("stores each message once with its raw bytes, and unrelated mail without bytes", async () => {
    const server = useMailbox([{ uid: 1, source: plainMail("seed") }]);
    await pollMailbox(pollEnv);
    const sdi = sdiMessage({ type: "RC", id: "rc-1", fileName: "IT01234567890_0000A.xml" });
    const invoice = receivedInvoiceMessage({ id: "inv-1" });
    server.add(
      { uid: 2, source: sdi },
      { uid: 3, source: invoice },
      { uid: 4, source: plainMail("junk") },
      { uid: 5, source: otherPecMail("pec-other") },
    );
    await pollMailbox(pollEnv);
    expect(await kinds()).toEqual([
      { uid: 2, kind: "sdi_message" },
      { uid: 3, kind: "received_invoice" },
      { uid: 4, kind: "ignored" },
      { uid: 5, kind: "ignored" },
    ]);
    const rows = await env.DB.prepare(
      `SELECT m.uid, m.sdi_message_type AS type, m.original_file_name AS file, m.size, f.size AS rawSize,
              f.kind AS fileKind, m.raw_file_id AS rawId
       FROM pec_messages m LEFT JOIN files f ON f.id = m.raw_file_id ORDER BY m.uid`,
    ).all<{
      uid: number;
      type: string | null;
      file: string | null;
      size: number;
      rawSize: number | null;
      fileKind: string | null;
      rawId: string | null;
    }>();
    const [rc, inv, junk, other] = rows.results;
    expect(rc).toMatchObject({ type: "RC", file: "IT01234567890_0000A.xml", fileKind: "pec_raw" });
    const stored = rc?.rawId ? await createD1FileStorage(env.DB).get(rc.rawId) : null;
    expect(new TextDecoder().decode(stored?.content)).toBe(sdi);
    expect(rc?.rawSize).toBe(rc?.size);
    expect(inv).toMatchObject({ file: "IT09876543211_00007.xml", fileKind: "pec_raw" });
    expect(junk?.rawSize).toBeNull();
    expect(other?.rawSize).toBeNull();
    expect(await count("files")).toBe(2);
  });

  it("is read-only: EXAMINE, UID SEARCH and PEEK fetches only", async () => {
    const server = useMailbox([{ uid: 1, source: plainMail("seed") }]);
    await pollMailbox(pollEnv);
    server.add({ uid: 2, source: sdiMessage({ type: "RC", id: "r", fileName: "IT1_0000A.xml" }) });
    await pollMailbox(pollEnv);
    const sent = server.sockets.flatMap((s) => s.received);
    expect(sent.some((l) => l.includes(" EXAMINE "))).toBe(true);
    expect(sent.some((l) => /UID FETCH \S+ \(UID BODY\.PEEK\[\]\)/.test(l))).toBe(true);
    for (const line of sent) {
      expect(line).not.toMatch(/\b(SELECT|STORE|EXPUNGE|DELETE|COPY|APPEND|MOVE)\b/);
      if (line.includes("UID FETCH")) expect(line).toContain("PEEK");
    }
    expect(server.mailbox.messages).toHaveLength(2);
  });

  it("polling the same mailbox twice stores nothing twice (AC 8)", async () => {
    const server = useMailbox([{ uid: 1, source: plainMail("seed") }]);
    await pollMailbox(pollEnv);
    server.add(
      { uid: 2, source: sdiMessage({ type: "RC", id: "r2", fileName: "IT1_0000A.xml" }) },
      { uid: 3, source: plainMail("junk") },
    );
    await pollMailbox(pollEnv);
    const before = [await count("pec_messages"), await count("files")];
    const again = await pollMailbox(pollEnv);
    expect(again?.counts.stored).toBe(0);
    expect([await count("pec_messages"), await count("files")]).toEqual(before);
    // A replayed UID range (cursor lost) is deduplicated by Message-ID and by UID.
    await env.DB.prepare("UPDATE settings SET mailbox_last_uid = 1").run();
    const replay = await pollMailbox(pollEnv);
    expect(replay?.counts.stored).toBe(0);
    expect(replay?.counts.duplicates).toBe(2);
    expect([await count("pec_messages"), await count("files")]).toEqual(before);
    expect((await cursor())?.u).toBe(3);
  });

  it("works off a backlog in capped runs, resuming from the cursor (AC 9)", async () => {
    const server = useMailbox([{ uid: 1, source: plainMail("seed") }]);
    await pollMailbox(pollEnv);
    const total = MAX_MESSAGES_PER_RUN + 5;
    for (let i = 0; i < total; i++) {
      server.add({ uid: 2 + i, source: plainMail(`backlog-${i}`) });
    }
    const first = await pollMailbox(pollEnv);
    expect(first?.counts).toMatchObject({ stored: MAX_MESSAGES_PER_RUN, more: true });
    const second = await pollMailbox(pollEnv);
    expect(second?.counts).toMatchObject({ stored: 5, more: false });
    expect(await count("pec_messages")).toBe(total);
  });

  it("rescans after a UIDVALIDITY change without duplicating stored messages (AC 9)", async () => {
    const server = useMailbox([{ uid: 1, source: plainMail("seed") }]);
    await pollMailbox(pollEnv);
    const receipt = sdiMessage({ type: "RC", id: "r3", fileName: "IT1_0000A.xml" });
    server.add({ uid: 2, source: receipt }, { uid: 3, source: plainMail("junk") });
    await pollMailbox(pollEnv);
    expect(await count("pec_messages")).toBe(2);

    // The server renumbers: same mail under a new UIDVALIDITY, plus one new message.
    server.mailbox.uidValidity = 2000;
    server.mailbox.messages = [
      { uid: 1, source: plainMail("seed") },
      { uid: 2, source: receipt },
      { uid: 3, source: plainMail("junk") },
      { uid: 4, source: plainMail("after-reset") },
    ];
    const result = await pollMailbox(pollEnv);
    // The old seed mail was never stored (first run), so it is new now; two are duplicates.
    expect(result?.counts).toMatchObject({ rescan: true, stored: 2, duplicates: 2 });
    expect(await count("pec_messages")).toBe(4);
    expect(await cursor()).toEqual({ v: 2000, u: 4 });
    // Back to normal afterwards.
    expect((await pollMailbox(pollEnv))?.counts).toMatchObject({ rescan: false, stored: 0 });
  });

  it("scans from the start on the first run when an invoice was already sent", async () => {
    await env.DB.prepare(
      "INSERT INTO invoices (id, document_type, state, state_rank, year, number_int, number_raw, created_at) VALUES ('inv', 'TD01', 'sending', 2, 2026, 1, '1', 1)",
    ).run();
    await env.DB.prepare(
      `INSERT INTO transmissions (id, invoice_id, attempt, file_progressive, file_name, channel, send_outcome, created_at)
       VALUES ('t1', 'inv', 1, 1, 'IT1_00001.xml', 'pec', 'complete', 1)`,
    ).run();
    useMailbox([
      { uid: 1, source: plainMail("early") },
      { uid: 2, source: sdiMessage({ type: "RC", id: "early-rc", fileName: "IT1_00001.xml" }) },
    ]);
    await pollMailbox(pollEnv);
    expect(await count("pec_messages")).toBe(2);
  });

  it("records a failed run with its code and keeps the cursor when the login is refused", async () => {
    const server = useMailbox([{ uid: 1, source: plainMail("seed") }]);
    await pollMailbox(pollEnv);
    server.mailbox.loginOk = false;
    server.add({ uid: 2, source: plainMail("waiting") });
    const failed = await pollMailbox(pollEnv);
    expect(failed).toMatchObject({ ok: false, errorCode: "login_failed" });
    expect(await count("pec_messages")).toBe(0);
    const runs = await env.DB.prepare(
      "SELECT status, error_code AS code, finished_at AS finished FROM job_runs WHERE job = 'poll' ORDER BY started_at, rowid",
    ).all<{ status: string; code: string | null; finished: number | null }>();
    expect(runs.results.map((r) => [r.status, r.code])).toEqual([
      ["success", null],
      ["failed", "login_failed"],
    ]);
    expect(runs.results.every((r) => r.finished !== null)).toBe(true);
    expect((await cursor())?.u).toBe(1);

    server.mailbox.loginOk = true;
    await pollMailbox(pollEnv);
    expect(await count("pec_messages")).toBe(1);
  });

  it("does nothing, and writes no run, while the PEC secrets are unset", async () => {
    useMailbox();
    const bare = { ...env } as unknown as Bindings;
    expect(await pollMailbox(bare)).toBeNull();
    expect(await count("job_runs")).toBe(0);
    expect(pollDeps.open).toBeTypeOf("function");
  });
});
