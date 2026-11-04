import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "../../db/schema";
import { applyMigrations } from "../auth/test-helpers";
import { pollDeps, pollMailbox } from "./poll";
import { plainMail } from "./receipt-fixtures";
import { pollEnv, resetPolling, useMailbox } from "./test-support";

const all = async <T>(sql: string) => (await env.DB.prepare(sql).all<T>()).results;
const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;

beforeAll(async () => {
  await applyMigrations(env.DB);
});
beforeEach(async () => {
  await resetPolling(env.DB);
});

describe("oversize messages", () => {
  it("records an error event and one notification, and never fetches the message (AC 8)", async () => {
    const server = useMailbox([{ uid: 1, source: plainMail("seed") }]);
    await pollMailbox(pollEnv);
    const big = `${plainMail("big")}${"x".repeat(MAX_FILE_BYTES + 100)}`;
    server.add({ uid: 2, source: big }, { uid: 3, source: plainMail("after") });
    const run = await pollMailbox(pollEnv);
    expect(run?.counts).toMatchObject({ oversize: 1, stored: 2 });
    // Only the headers of the big message were fetched: its UID is never fetched whole.
    const fetches = server.sockets.flatMap((s) => s.received).filter((l) => l.includes("FETCH"));
    expect(fetches.some((l) => /^A\d+ UID FETCH 2 \(UID BODY\.PEEK\[\]\)$/.test(l))).toBe(false);
    expect(fetches.some((l) => /UID FETCH 3 \(UID BODY\.PEEK\[\]\)/.test(l))).toBe(true);

    expect(await all("SELECT type FROM events")).toEqual([{ type: "pec_oversize" }]);
    expect(await all("SELECT type, title, body FROM notifications")).toEqual([
      {
        type: "message_oversize",
        title: "notifications.message_oversize.title",
        body: JSON.stringify({ size: big.length }),
      },
    ]);
    expect(await all("SELECT kind, raw_file_id AS raw FROM pec_messages WHERE uid = 2")).toEqual([
      { kind: "ignored", raw: null },
    ]);
    // Polling again records and notifies nothing more.
    await pollMailbox(pollEnv);
    expect(await count("events")).toBe(1);
    expect(await count("notifications")).toBe(1);
  });
});

describe("a failing poll raises a notification", () => {
  it("notifies once per problem until the owner has read it", async () => {
    const server = useMailbox([{ uid: 1, source: plainMail("seed") }]);
    await pollMailbox(pollEnv);
    server.mailbox.loginOk = false;
    await pollMailbox(pollEnv);
    await pollMailbox(pollEnv);
    expect(await all("SELECT type, body FROM notifications")).toEqual([
      { type: "mailbox_login_failed", body: "{}" },
    ]);
    // Read, and it fails again: a new notification.
    await env.DB.prepare("UPDATE notifications SET read_at = 1").run();
    await pollMailbox(pollEnv);
    expect(await count("notifications")).toBe(2);
    // A different failure is a different notification.
    pollDeps.open = () => {
      throw new Error("tls handshake failed");
    };
    const dropped = await pollMailbox(pollEnv);
    expect(dropped).toMatchObject({ ok: false, errorCode: "connection_failed" });
    expect(await count("notifications")).toBe(3);
  });

  it("does not notify on a successful run", async () => {
    useMailbox([{ uid: 1, source: plainMail("seed") }]);
    expect((await pollMailbox(pollEnv))?.ok).toBe(true);
    expect(await count("notifications")).toBe(0);
  });
});
