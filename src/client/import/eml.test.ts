// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { receivedInvoiceMessage } from "../../worker/pec/receipt-fixtures";
import { invoiceAttachments } from "./eml";
import { parseInvoiceFile } from "./read";

const xml = readFileSync(
  new URL("../../shared/fatturapa/fixtures/IT01234567890_FPR01.xml", import.meta.url),
  "utf8",
);

describe("raw PEC message unpacking", () => {
  it("finds the invoice file inside the envelope, not the metadata file", async () => {
    const eml = new TextEncoder().encode(
      receivedInvoiceMessage({ id: "big", fileName: "IT09876543211_00007.xml", content: xml }),
    );
    const attachments = await invoiceAttachments(eml);
    expect(attachments.map((a) => a.name)).toEqual(["IT09876543211_00007.xml"]);
    const first = attachments[0];
    expect(
      parseInvoiceFile(first?.name ?? "", first?.bytes ?? new Uint8Array()).supplier.name,
    ).toBe("SOCIETA' ALPHA SRL");
  });

  it("returns nothing for a message without an invoice", async () => {
    expect(await invoiceAttachments(new TextEncoder().encode("Subject: hi\r\n\r\nbody"))).toEqual(
      [],
    );
  });
});
