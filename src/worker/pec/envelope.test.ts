import { describe, expect, it } from "vitest";
import { parsePecEnvelope } from "./envelope";
import { PEC_RECEIPT_SOURCE, pecInvoiceEnvelope, SDI_RECEIPT_SOURCE } from "./message-fixtures";

describe("PEC envelope parsing", () => {
  it("extracts daticert.xml and the SdI receipt carried by postacert.eml", async () => {
    const envelope = await parsePecEnvelope(PEC_RECEIPT_SOURCE);
    expect(envelope.messageId).toBe("<opec2-0001@pec.aruba.it>");
    expect(envelope.daticert).toContain("<postacert");
    expect(envelope.inner?.from).toBe("sdi01@pec.fatturapa.it");
    expect(envelope.inner?.subject).toBe("CONSEGNA: IT01234567890_00001.xml");
    const receipt = envelope.inner?.attachments.find((a) => a.filename.endsWith("_RC_001.xml"));
    expect(new TextDecoder().decode(receipt?.content)).toContain(
      "<NomeFile>IT01234567890_00001.xml</NomeFile>",
    );
  });

  it("parses a bare SdI message and a message without postacert.eml", async () => {
    const bare = await parsePecEnvelope(SDI_RECEIPT_SOURCE);
    expect(bare.inner).toBeNull();
    expect(bare.attachments.map((a) => a.filename)).toEqual(["IT01234567890_00001_RC_001.xml"]);
  });

  it("decodes a base64 invoice attachment byte for byte", async () => {
    const envelope = await parsePecEnvelope(pecInvoiceEnvelope(20_000));
    const invoice = envelope.inner?.attachments.find(
      (a) => a.filename === "IT09876543211_00007.xml",
    );
    const text = new TextDecoder().decode(invoice?.content);
    expect(text.startsWith("<?xml")).toBe(true);
    expect(text.endsWith("</p:FatturaElettronica>")).toBe(true);
    expect(invoice?.size).toBeGreaterThanOrEqual(20_000);
  });
});
