import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REJECTION_WINDOW_DAYS } from "../../shared/invoice";
import { applyMigrations } from "../auth/test-helpers";
import { processOutbox } from "../outbox";
import { pollMailbox } from "./poll";
import { otherPecMail, plainMail, providerReceipt, sdiMessage } from "./receipt-fixtures";
import { pollEnv, resetPolling, seedInvoice, useMailbox } from "./test-support";

const SENT = "out-1@pec.example";
const FILE = "IT01234567890_0000A.xml";

const state = async (id: string) =>
  (
    await env.DB.prepare("SELECT state FROM invoices WHERE id = ?").bind(id).first<{
      state: string;
    }>()
  )?.state;
const all = async <T>(sql: string, ...bind: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...bind)
      .all<T>()
  ).results;
const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
const outcome = async (id: string) =>
  (
    await env.DB.prepare("SELECT send_outcome AS o FROM transmissions WHERE id = ?")
      .bind(id)
      .first<{ o: string }>()
  )?.o;

const receipt = (tipo: "accettazione" | "avvenuta-consegna" | "errore-consegna", id: string) =>
  providerReceipt({ tipo, id, sent: SENT, fileName: FILE });

beforeAll(async () => {
  await applyMigrations(env.DB);
});
beforeEach(async () => {
  await resetPolling(env.DB);
});

/** An invoice handed to the PEC server (`complete`), waiting for the delivery receipt. */
const sentInvoice = () =>
  seedInvoice(env.DB, { attempts: [{ fileName: FILE, messageId: `<${SENT}>` }] });

describe("AC 7: a sent invoice follows its receipts", () => {
  it("goes to sent on the PEC delivery receipt, then to delivered on the SdI's RC", async () => {
    const inv = await sentInvoice();
    const server = useMailbox([{ uid: 1, source: receipt("accettazione", "acc-1") }]);
    await pollMailbox(pollEnv);
    expect(await state(inv.id)).toBe("sending");

    server.add({ uid: 2, source: receipt("avvenuta-consegna", "del-1") });
    await pollMailbox(pollEnv);
    expect(await state(inv.id)).toBe("sent");

    server.add({ uid: 3, source: sdiMessage({ type: "RC", id: "rc-1", fileName: FILE }) });
    await pollMailbox(pollEnv);
    expect(await state(inv.id)).toBe("delivered");

    const events = await all<{ type: string }>(
      "SELECT type FROM events ORDER BY created_at, rowid",
    );
    expect(events.map((e) => e.type)).toEqual(["PEC_DELIVERY", "RC"]);
    // Delivered queues an in-app notification and the courtesy email; the notification is
    // delivered, the email is skipped here because the courtesy email is not configured.
    expect(
      (
        await all<{ kind: string; status: string }>("SELECT kind, status FROM outbox ORDER BY kind")
      ).map((r) => [r.kind, r.status]),
    ).toEqual([
      ["email", "skipped"],
      ["notification", "sent"],
    ]);
    expect(await all("SELECT type, title, body FROM notifications")).toEqual([
      {
        type: "invoice_delivered",
        title: "notifications.invoice_delivered.title",
        body: JSON.stringify({
          number: `${(await all<{ number_raw: string }>("SELECT number_raw FROM invoices"))[0]?.number_raw}/2026`,
        }),
      },
    ]);
  });

  it("an SdI receipt that arrives while the invoice is still sending moves it straight to delivered", async () => {
    const inv = await sentInvoice();
    const server = useMailbox([{ uid: 1, source: plainMail("seed") }]);
    server.add({ uid: 2, source: sdiMessage({ type: "RC", id: "rc-early", fileName: FILE }) });
    await pollMailbox(pollEnv);
    expect(await state(inv.id)).toBe("delivered");
    // The provider's delivery receipt shows up late and does not pull it back.
    server.add({ uid: 3, source: receipt("avvenuta-consegna", "del-late") });
    await pollMailbox(pollEnv);
    expect(await state(inv.id)).toBe("delivered");
  });

  it("MC moves the invoice to not_delivered and a later RC does not undo it", async () => {
    const inv = await sentInvoice();
    const server = useMailbox([
      { uid: 1, source: sdiMessage({ type: "MC", id: "mc-1", fileName: FILE }) },
    ]);
    await pollMailbox(pollEnv);
    expect(await state(inv.id)).toBe("not_delivered");
    server.add({ uid: 2, source: sdiMessage({ type: "RC", id: "rc-late", fileName: FILE }) });
    await pollMailbox(pollEnv);
    expect(await state(inv.id)).toBe("not_delivered");
    expect(
      (await all<{ kind: string }>("SELECT kind FROM outbox ORDER BY kind")).map((r) => r.kind),
    ).toEqual(["email", "notification"]);
  });

  it("an NS rejects the invoice and stores the SdI errors where the rejected flow reads them", async () => {
    const inv = await sentInvoice();
    useMailbox([
      {
        uid: 1,
        source: sdiMessage({
          type: "NS",
          id: "ns-1",
          fileName: FILE,
          date: "Mon, 02 Nov 2026 09:16:30 +0100",
        }),
      },
    ]);
    await pollMailbox(pollEnv);
    expect(await state(inv.id)).toBe("rejected");
    const [event] = await all<{ type: string; payload: string; occurred_at: number }>(
      "SELECT type, payload, occurred_at FROM events WHERE invoice_id = ?",
      inv.id,
    );
    expect(event?.type).toBe("NS");
    expect(JSON.parse(event?.payload ?? "{}")).toEqual({
      errors: [{ code: "00311", description: "Codice Destinatario non valido" }],
    });
    expect(event?.occurred_at).toBe(Date.parse("2026-11-02T08:16:30Z"));
    expect(REJECTION_WINDOW_DAYS).toBe(5);
    // No courtesy email for a rejection.
    expect((await all<{ kind: string }>("SELECT kind FROM outbox")).map((r) => r.kind)).toEqual([
      "notification",
    ]);
  });

  it("a PEC non-delivery reopens the attempt: same number and date, no deadline, no SdI event", async () => {
    const inv = await sentInvoice();
    useMailbox([{ uid: 1, source: receipt("errore-consegna", "err-1") }]);
    await pollMailbox(pollEnv);
    expect(await state(inv.id)).toBe("sending");
    expect(await outcome(inv.transmissionIds[0] as string)).toBe("none");
    expect((await all<{ type: string }>("SELECT type FROM events")).map((e) => e.type)).toEqual([
      "PEC_ERROR",
    ]);
    expect(await all("SELECT type FROM notifications")).toEqual([{ type: "pec_send_error" }]);
  });
});

describe("matching an unknown outcome", () => {
  it("resolves an unknown attempt from the provider's acceptance, by the stored Message-ID", async () => {
    const inv = await seedInvoice(env.DB, {
      attempts: [{ fileName: FILE, messageId: `<${SENT}>`, outcome: "unknown" }],
    });
    useMailbox([{ uid: 1, source: receipt("accettazione", "acc-u") }]);
    await pollMailbox(pollEnv);
    expect(await outcome(inv.transmissionIds[0] as string)).toBe("complete");
    expect(await state(inv.id)).toBe("sending");
  });

  it("resolves an unknown attempt from an SdI message, by the original file name alone", async () => {
    const inv = await seedInvoice(env.DB, {
      attempts: [{ fileName: FILE, outcome: "unknown" }],
    });
    useMailbox([{ uid: 1, source: sdiMessage({ type: "RC", id: "rc-n", fileName: FILE }) }]);
    await pollMailbox(pollEnv);
    expect(await outcome(inv.transmissionIds[0] as string)).toBe("complete");
    expect(await state(inv.id)).toBe("delivered");
  });
});

describe("stale, out-of-order and replayed messages", () => {
  it("a late SdI message for an earlier attempt never moves the invoice", async () => {
    const oldFile = "IT01234567890_0000B.xml";
    const inv = await seedInvoice(env.DB, {
      attempts: [
        { fileName: oldFile, messageId: "<old@pec.example>" },
        { fileName: FILE, messageId: `<${SENT}>` },
      ],
    });
    useMailbox([{ uid: 1, source: sdiMessage({ type: "NS", id: "ns-old", fileName: oldFile }) }]);
    await pollMailbox(pollEnv);
    expect(await state(inv.id)).toBe("sending");
    expect(await count("outbox")).toBe(0);
    // The message is still matched and recorded.
    expect((await all<{ type: string }>("SELECT type FROM events")).map((e) => e.type)).toEqual([
      "NS",
    ]);
  });

  it("replaying a processed message creates no second event, transition or outbox row", async () => {
    const inv = await sentInvoice();
    const server = useMailbox([
      { uid: 1, source: sdiMessage({ type: "RC", id: "rc-r", fileName: FILE }) },
    ]);
    await pollMailbox(pollEnv);
    const before = {
      events: await count("events"),
      outbox: await count("outbox"),
      notifications: await count("notifications"),
    };
    // Lose every trace of the message and the cursor, so the poller sees it as new again.
    await env.DB.prepare("DELETE FROM pec_messages").run();
    await env.DB.prepare("DELETE FROM files").run();
    await env.DB.prepare("UPDATE settings SET mailbox_last_uid = 0").run();
    await pollMailbox(pollEnv);
    expect(await count("pec_messages")).toBe(1);
    expect({
      events: await count("events"),
      outbox: await count("outbox"),
      notifications: await count("notifications"),
    }).toEqual(before);
    expect(await state(inv.id)).toBe("delivered");
    expect(server.mailbox.messages).toHaveLength(1);
  });

  it("a failed transition leaves nothing half-applied, and the next run ends in the right state", async () => {
    const inv = await sentInvoice();
    const server = useMailbox([
      { uid: 1, source: plainMail("seed") },
      { uid: 2, source: sdiMessage({ type: "RC", id: "rc-f", fileName: FILE }) },
    ]);
    await env.DB.exec(
      "CREATE TRIGGER fail_delivered BEFORE UPDATE OF state ON invoices WHEN NEW.state = 'delivered' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    try {
      const failed = await pollMailbox(pollEnv);
      expect(failed?.ok).toBe(false);
    } finally {
      await env.DB.exec("DROP TRIGGER fail_delivered");
    }
    // The batch rolled back: only the earlier message is stored; no event, no outbox, and the
    // cursor stays right behind the failed message.
    expect(await state(inv.id)).toBe("sending");
    expect(await count("pec_messages")).toBe(1);
    expect(await count("events")).toBe(0);
    expect(await count("outbox")).toBe(0);
    expect(await count("files")).toBe(0);
    expect((await all<{ u: number }>("SELECT mailbox_last_uid AS u FROM settings"))[0]?.u).toBe(1);

    const retried = await pollMailbox(pollEnv);
    expect(retried?.ok).toBe(true);
    expect(await state(inv.id)).toBe("delivered");
    expect(await count("pec_messages")).toBe(2);
    expect(await count("events")).toBe(1);
    expect(await count("outbox")).toBe(2);
    expect(server.mailbox.messages).toHaveLength(2);
  });

  it("retries an outbox row that failed to deliver on a later run", async () => {
    const inv = await sentInvoice();
    useMailbox([{ uid: 1, source: sdiMessage({ type: "RC", id: "rc-o", fileName: FILE }) }]);
    await env.DB.exec(
      "CREATE TRIGGER fail_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    try {
      await pollMailbox(pollEnv);
    } finally {
      await env.DB.exec("DROP TRIGGER fail_notification");
    }
    expect(await state(inv.id)).toBe("delivered");
    expect(await count("notifications")).toBe(0);
    expect(
      (
        await all<{ status: string; error: string | null }>(
          "SELECT status, error FROM outbox WHERE kind = 'notification'",
        )
      )[0],
    ).toMatchObject({ status: "pending" });
    // The next cron tick delivers it, once.
    await pollMailbox(pollEnv);
    expect(await count("notifications")).toBe(1);
    expect(await processOutbox(pollEnv)).toBe(0);
    expect(await count("notifications")).toBe(1);
  });
});

describe("what is not about our invoices", () => {
  it("ignores non-SdI mail and receipts of messages we did not send, with no notification", async () => {
    await sentInvoice();
    useMailbox([
      { uid: 1, source: plainMail("p1") },
      { uid: 2, source: otherPecMail("p2") },
      {
        uid: 3,
        source: providerReceipt({
          tipo: "avvenuta-consegna",
          id: "stranger",
          sent: "someone-else@pec.example",
          fileName: "IT99999999999_ZZZZZ.xml",
        }),
      },
    ]);
    await pollMailbox(pollEnv);
    expect(await count("pec_messages")).toBe(3);
    expect(await count("notifications")).toBe(0);
    expect(await count("outbox")).toBe(0);
    expect(await count("events")).toBe(0);
    expect(
      (await all<{ kind: string }>("SELECT kind FROM pec_messages ORDER BY uid")).map(
        (r) => r.kind,
      ),
    ).toEqual(["ignored", "ignored", "pec_receipt"]);
  });

  it("keeps an SdI message nobody claims, listed as unprocessed, never dropped", async () => {
    await sentInvoice();
    useMailbox([
      {
        uid: 1,
        source: sdiMessage({ type: "NS", id: "ns-x", fileName: "IT55555555555_00001.xml" }),
      },
    ]);
    await pollMailbox(pollEnv);
    const rows = await all<{
      kind: string;
      type: string;
      processed: number | null;
      raw: string | null;
    }>(
      "SELECT kind, sdi_message_type AS type, processed_at AS processed, raw_file_id AS raw FROM pec_messages",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "sdi_message", type: "NS", processed: null });
    expect(rows[0]?.raw).not.toBeNull();
    expect(await count("events")).toBe(0);
  });

  it("stores the SdI address from its first reply and keeps it", async () => {
    await sentInvoice();
    const server = useMailbox([
      {
        uid: 1,
        source: sdiMessage({
          type: "RC",
          id: "rc-a",
          fileName: FILE,
          from: "sdi11@pec.fatturapa.it",
        }),
      },
    ]);
    await pollMailbox(pollEnv);
    const address = () =>
      all<{ a: string | null }>("SELECT sdi_pec_address AS a FROM settings").then((r) => r[0]?.a);
    expect(await address()).toBe("sdi11@pec.fatturapa.it");
    server.add({
      uid: 2,
      source: sdiMessage({
        type: "MC",
        id: "mc-a",
        fileName: FILE,
        from: "sdi22@pec.fatturapa.it",
      }),
    });
    await pollMailbox(pollEnv);
    expect(await address()).toBe("sdi11@pec.fatturapa.it");
  });
});
