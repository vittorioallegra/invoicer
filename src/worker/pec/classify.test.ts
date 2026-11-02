import { describe, expect, it } from "vitest";
import { classifyEnvelope, classifyLarge, PARSE_LIMIT_BYTES } from "./classify";
import { parsePecEnvelope } from "./envelope";
import { PEC_RECEIPT_SOURCE } from "./message-fixtures";
import {
  otherPecMail,
  plainMail,
  providerReceipt,
  receivedInvoiceMessage,
  sdiMessage,
} from "./receipt-fixtures";

const classify = async (source: string) => classifyEnvelope(await parsePecEnvelope(source));

describe("PEC message classification", () => {
  it("separates the PEC acceptance, delivery and non-delivery receipts", async () => {
    const base = { id: "p1", sent: "out-1@pec.example", fileName: "IT01234567890_0000A.xml" };
    const acceptance = await classify(providerReceipt({ ...base, tipo: "accettazione" }));
    expect(acceptance).toMatchObject({ kind: "pec_receipt", receipt: "acceptance" });
    const delivery = await classify(providerReceipt({ ...base, tipo: "avvenuta-consegna" }));
    expect(delivery).toMatchObject({
      kind: "pec_receipt",
      receipt: "delivery",
      refMessageId: "out-1@pec.example",
      fileNames: ["IT01234567890_0000A.xml"],
      recipients: ["sdi01@pec.fatturapa.it"],
    });
    const failed = await classify(providerReceipt({ ...base, tipo: "errore-consegna" }));
    expect(failed).toMatchObject({ kind: "pec_receipt", receipt: "non_delivery" });
  });

  it("reads RC, NS and MC from the SdI with the original file name", async () => {
    const fileName = "IT01234567890_0000A.xml";
    expect(await classify(sdiMessage({ type: "RC", id: "s1", fileName }))).toMatchObject({
      kind: "sdi_message",
      type: "RC",
      fileName,
      sender: "sdi01@pec.fatturapa.it",
    });
    const ns = await classify(
      sdiMessage({
        type: "NS",
        id: "s2",
        fileName,
        xml: undefined,
      }),
    );
    expect(ns).toMatchObject({ kind: "sdi_message", type: "NS" });
    if (ns.kind === "sdi_message") {
      expect(ns.receipt.errors).toEqual([
        { code: "00311", description: "Codice Destinatario non valido" },
      ]);
    }
    expect(await classify(sdiMessage({ type: "MC", id: "s3", fileName }))).toMatchObject({
      type: "MC",
    });
  });

  it("reports the sender of the SdI's reply", async () => {
    const reply = await classify(
      sdiMessage({
        type: "RC",
        id: "s4",
        fileName: "IT01234567890_0000A.xml",
        from: "sdi11@pec.fatturapa.it",
      }),
    );
    expect(reply).toMatchObject({ kind: "sdi_message", sender: "sdi11@pec.fatturapa.it" });
  });

  it("finds a received invoice (XML or P7M) from the SdI and not its metadata file", async () => {
    const xml = await classify(receivedInvoiceMessage({ id: "i1" }));
    expect(xml).toMatchObject({
      kind: "received_invoice",
      fileName: "IT09876543211_00007.xml",
    });
    const p7m = await classify(
      receivedInvoiceMessage({ id: "i2", fileName: "IT09876543211_00008.xml.p7m" }),
    );
    expect(p7m).toMatchObject({
      kind: "received_invoice",
      fileName: "IT09876543211_00008.xml.p7m",
    });
    if (p7m.kind === "received_invoice") {
      expect(p7m.attachment?.content.byteLength).toBeGreaterThan(0);
    }
  });

  it("ignores non-SdI mail: plain mail, other PEC senders and the old probe envelope", async () => {
    expect((await classify(plainMail("n1"))).kind).toBe("ignored");
    expect((await classify(otherPecMail("o1"))).kind).toBe("ignored");
    // The spike's envelope carries an SdI receipt, so it is an SdI message.
    expect((await classify(PEC_RECEIPT_SOURCE)).kind).toBe("sdi_message");
  });

  it("classifies a message too large to parse from its headers and attachment names", () => {
    const encoder = new TextEncoder();
    const big = encoder.encode(
      receivedInvoiceMessage({ id: "big", padding: PARSE_LIMIT_BYTES + 10 }),
    );
    expect(classifyLarge(big)).toMatchObject({
      kind: "received_invoice",
      attachment: null,
      fileName: "IT09876543211_00007.xml",
      messageId: "<big>",
    });
    expect(classifyLarge(encoder.encode(plainMail("big2"))).kind).toBe("ignored");
    expect(
      classifyLarge(
        encoder.encode(
          providerReceipt({
            tipo: "avvenuta-consegna",
            id: "r",
            sent: "x@y",
            fileName: "IT1_0000A.xml",
          }),
        ),
      ),
    ).toMatchObject({ kind: "pec_receipt", receipt: "delivery", refMessageId: "x@y" });
  });
});
