import { describe, expect, it } from "vitest";
import {
  isInvoiceFileName,
  isSdiAddress,
  normalizeMessageId,
  parseDaticert,
  parseSdiAttachmentName,
  parseSdiReceiptXml,
} from "./sdi-messages";

describe("SdI file names", () => {
  it("maps a receipt name to its type and the original invoice file", () => {
    expect(parseSdiAttachmentName("IT01234567890_0000A_RC_001.xml")).toEqual({
      type: "RC",
      originalFileName: "IT01234567890_0000A.xml",
    });
    expect(parseSdiAttachmentName("it01234567890_0000a_ns_002.XML")?.type).toBe("NS");
    expect(parseSdiAttachmentName("IT01234567890_0000A.xml")).toBeNull();
  });

  it("tells invoice files from receipts and certification data", () => {
    expect(isInvoiceFileName("IT09876543211_00007.xml")).toBe(true);
    expect(isInvoiceFileName("IT09876543211_00007.xml.p7m")).toBe(true);
    expect(isInvoiceFileName("IT09876543211_00007_MT_001.xml")).toBe(false);
    expect(isInvoiceFileName("daticert.xml")).toBe(false);
    expect(isInvoiceFileName("postacert.eml")).toBe(false);
  });

  it("recognises SdI addresses and normalizes Message-IDs", () => {
    expect(isSdiAddress("SDI01@pec.fatturapa.it")).toBe(true);
    expect(isSdiAddress("sdi77@other.example", "sdi77@other.example")).toBe(true);
    expect(isSdiAddress("someone@pec.example")).toBe(false);
    expect(normalizeMessageId(" <Abc@Host> ")).toBe("abc@host");
  });
});

describe("SdI receipt XML", () => {
  it("reads an NS with its error list and an MC with its description", () => {
    const ns = parseSdiReceiptXml(
      '<?xml version="1.0"?><types:NotificaScarto xmlns:types="x"><NomeFile>IT1_0000A.xml</NomeFile><ListaErrori><Errore><Codice>00311</Codice><Descrizione>Bad &amp; wrong</Descrizione></Errore><Errore><Codice>00400</Codice><Descrizione>Natura</Descrizione></Errore></ListaErrori></types:NotificaScarto>',
    );
    expect(ns).toMatchObject({ type: "NS", fileName: "IT1_0000A.xml" });
    expect(ns.errors).toEqual([
      { code: "00311", description: "Bad & wrong" },
      { code: "00400", description: "Natura" },
    ]);
    const mc = parseSdiReceiptXml(
      "<NotificaMancataConsegna><NomeFile>IT1_0000A.xml</NomeFile><Descrizione>Unreachable</Descrizione></NotificaMancataConsegna>",
    );
    expect(mc).toMatchObject({ type: "MC", description: "Unreachable", errors: [] });
  });

  it("returns empty values for a document it does not know", () => {
    expect(parseSdiReceiptXml("not xml at all")).toEqual({
      type: null,
      fileName: null,
      errors: [],
      description: null,
    });
  });
});

describe("daticert.xml", () => {
  it("reads the type, sender, recipients and the original Message-ID", () => {
    const dati = parseDaticert(
      '<postacert tipo="avvenuta-consegna" errore="nessuno"><intestazione><mittente>Posta@Pec.Aruba.it</mittente><destinatari tipo="certificato">sdi01@pec.fatturapa.it</destinatari></intestazione><dati><msgid>&lt;Orig@host&gt;</msgid></dati></postacert>',
    );
    expect(dati).toEqual({
      tipo: "avvenuta-consegna",
      sender: "posta@pec.aruba.it",
      recipients: ["sdi01@pec.fatturapa.it"],
      messageId: "orig@host",
    });
  });
});
