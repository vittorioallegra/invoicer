import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../auth/test-helpers";
import { createD1FileStorage } from "../storage";
import { PARSE_LIMIT_BYTES } from "./classify";
import { pollMailbox } from "./poll";
import { plainMail, providerReceipt, receivedInvoiceMessage, sdiMessage } from "./receipt-fixtures";
import { pollEnv, resetPolling, seedInvoice, useMailbox } from "./test-support";

const all = async <T>(sql: string) => (await env.DB.prepare(sql).all<T>()).results;
const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

beforeAll(async () => {
  await applyMigrations(env.DB);
});
beforeEach(async () => {
  await resetPolling(env.DB);
});

const SENT = "out-9@pec.example";
const FILE = "IT01234567890_0000C.xml";

describe("received invoices", () => {
  it("stores the XML original, with parse_status pending, and notifies once", async () => {
    useMailbox([{ uid: 1, source: plainMail("seed") }]);
    await pollMailbox(pollEnv);
    const body =
      '<?xml version="1.0"?><p:FatturaElettronica versione="FPR12"><x>1</x></p:FatturaElettronica>';
    const server = useMailbox([{ uid: 1, source: plainMail("seed") }]);
    server.add({ uid: 2, source: receivedInvoiceMessage({ id: "i1", content: body }) });
    await pollMailbox(pollEnv);
    const rows = await all<{ status: string; fileId: string; messageId: string; kind: string }>(
      `SELECT r.parse_status AS status, r.file_id AS fileId, r.pec_message_id AS messageId, m.kind
       FROM received_invoices r JOIN pec_messages m ON m.id = r.pec_message_id`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", kind: "received_invoice" });
    const file = await createD1FileStorage(env.DB).get(rows[0]?.fileId ?? "");
    expect(file).toMatchObject({ kind: "received", filename: "IT09876543211_00007.xml" });
    expect(file?.contentType).toBe("application/xml");
    expect(text(file?.content)).toBe(body);
    // The notification is written in the message's batch, without an invoice.
    expect(await all("SELECT type, title, body, invoice_id AS inv FROM notifications")).toEqual([
      {
        type: "received_invoice",
        title: "notifications.received_invoice.title",
        body: JSON.stringify({ file: "IT09876543211_00007.xml" }),
        inv: null,
      },
    ]);
  });

  it("keeps a .p7m byte for byte, parsed later in the browser", async () => {
    useMailbox([
      {
        uid: 1,
        source: receivedInvoiceMessage({
          id: "p1",
          fileName: "IT09876543211_00008.xml.p7m",
          content: "SIGNED-BYTES",
        }),
      },
    ]);
    await env.DB.prepare(
      "INSERT INTO settings (id, mailbox_uid_validity, mailbox_last_uid) VALUES (1, 1000, 0)",
    ).run();
    await pollMailbox(pollEnv);
    const [row] = await all<{ fileId: string }>("SELECT file_id AS fileId FROM received_invoices");
    const file = await createD1FileStorage(env.DB).get(row?.fileId ?? "");
    expect(file).toMatchObject({
      filename: "IT09876543211_00008.xml.p7m",
      contentType: "application/pkcs7-mime",
    });
    expect(file?.size).toBe(new TextEncoder().encode("SIGNED-BYTES").length);
    expect(text(file?.content)).toBe("SIGNED-BYTES");
  });

  it("keeps the raw message as the original of an invoice too large to parse in the Worker", async () => {
    await env.DB.prepare(
      "INSERT INTO settings (id, mailbox_uid_validity, mailbox_last_uid) VALUES (1, 1000, 0)",
    ).run();
    useMailbox([
      { uid: 1, source: receivedInvoiceMessage({ id: "big", padding: PARSE_LIMIT_BYTES }) },
    ]);
    await pollMailbox(pollEnv);
    const [row] = await all<{ fileId: string; rawId: string }>(
      `SELECT r.file_id AS fileId, m.raw_file_id AS rawId
       FROM received_invoices r JOIN pec_messages m ON m.id = r.pec_message_id`,
    );
    expect(row?.fileId).toBe(row?.rawId);
    const file = await createD1FileStorage(env.DB).get(row?.fileId ?? "");
    expect(file).toMatchObject({ kind: "pec_raw", filename: "1.eml" });
    expect(text(file?.content)).toContain("IT09876543211_00007.xml");
  });

  it("creates no second invoice or notification when the mailbox is polled again (AC 8)", async () => {
    await env.DB.prepare(
      "INSERT INTO settings (id, mailbox_uid_validity, mailbox_last_uid) VALUES (1, 1000, 0)",
    ).run();
    useMailbox([{ uid: 1, source: receivedInvoiceMessage({ id: "dup" }) }]);
    await pollMailbox(pollEnv);
    await pollMailbox(pollEnv);
    await env.DB.prepare("UPDATE settings SET mailbox_last_uid = 0").run();
    await pollMailbox(pollEnv);
    expect(await count("received_invoices")).toBe(1);
    expect(await count("notifications")).toBe(1);
    expect(await count("files")).toBe(2);
  });
});

describe("AC 9: after downtime the next poll resumes from the last UID", () => {
  it("brings the sent invoice to its final state and stores the received invoice", async () => {
    const inv = await seedInvoice(env.DB, {
      attempts: [{ fileName: FILE, messageId: `<${SENT}>` }],
    });
    // The cron did not run: several messages piled up.
    const server = useMailbox([{ uid: 1, source: plainMail("before") }]);
    server.add(
      {
        uid: 2,
        source: providerReceipt({ tipo: "accettazione", id: "a", sent: SENT, fileName: FILE }),
      },
      {
        uid: 3,
        source: providerReceipt({
          tipo: "avvenuta-consegna",
          id: "d",
          sent: SENT,
          fileName: FILE,
        }),
      },
      { uid: 4, source: sdiMessage({ type: "RC", id: "rc", fileName: FILE }) },
      { uid: 5, source: receivedInvoiceMessage({ id: "supplier" }) },
      { uid: 6, source: plainMail("noise") },
    );
    const result = await pollMailbox(pollEnv);
    expect(result?.ok).toBe(true);
    expect(
      (await all<{ state: string }>(`SELECT state FROM invoices WHERE id = '${inv.id}'`))[0]?.state,
    ).toBe("delivered");
    expect(await count("received_invoices")).toBe(1);
    expect(
      (await all<{ type: string }>("SELECT type FROM notifications ORDER BY type")).map(
        (n) => n.type,
      ),
    ).toEqual(["invoice_delivered", "received_invoice"]);
    expect(await count("pec_messages")).toBe(6);
    expect((await all<{ u: number }>("SELECT mailbox_last_uid AS u FROM settings"))[0]?.u).toBe(6);
  });
});
