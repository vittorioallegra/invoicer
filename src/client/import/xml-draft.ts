import type { ReceivedDocument, ReceivedInvoice, ReceivedLine } from "../../shared/fatturapa";
import { decimalToCents, type IssuedImportMeta, type XmlDraft } from "../../shared/import";
import type { InvoiceLine } from "../../shared/invoice";
import { type CassaDefaults, RITENUTA_TYPES, type RitenutaDefaults } from "../../shared/tax";
import {
  CASSA_TYPE_CODES,
  CAUSALE_PAGAMENTO_CODES,
  NATURA_CODES,
  NATURA_TEXTS,
  STAMP_CENTS,
  STAMP_LINE_DESCRIPTION,
} from "../../shared/totals";

/**
 * The content of an issued FatturaPA file that was never sent, mapped onto what the invoice
 * editor models (lines, cassa, ritenuta, bollo, note, payment). Pure: the Worker validates the
 * result again and creates the unsent invoice. What the editor cannot hold is left out; the
 * owner checks the invoice before sending it.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A decimal as basis points ("22.00" -> 2200); null when not a number. */
function toBasisPoints(value: string | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

const toMilli = (value: string | null): number | null => {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(1, Math.round(number * 1000)) : null;
};

function mapLine(line: ReceivedLine): InvoiceLine {
  const totalCents = decimalToCents(line.total) ?? 0;
  const quantityMilli = toMilli(line.quantity) ?? 1000;
  let unitPriceCents = line.unitPrice === null ? totalCents : (decimalToCents(line.unitPrice) ?? 0);
  // A discount or a surcharge changes the line total: keep the total by adjusting the unit price.
  const expected = Math.round((quantityMilli * unitPriceCents) / 1000);
  if (line.total !== "" && Math.abs(expected - totalCents) > 1) {
    unitPriceCents = Math.round((totalCents * 1000) / quantityMilli);
  }
  const rateBp = toBasisPoints(line.vatRate);
  const natura = NATURA_CODES.find((code) => code === line.natura) ?? null;
  return {
    description: line.description.slice(0, 1000),
    note: "",
    quantityMilli,
    unit: line.unit ? line.unit.slice(0, 10) : null,
    unitPriceCents: Math.max(0, unitPriceCents),
    vatRateBp: rateBp !== null && rateBp > 0 && rateBp <= 10000 ? rateBp : null,
    natura: rateBp !== null && rateBp > 0 ? null : natura,
  };
}

function mapCassa(document: ReceivedDocument): CassaDefaults | null {
  const block = document.cassa[0];
  const rateBp = toBasisPoints(block?.rate ?? null);
  if (!block || rateBp === null || rateBp < 1 || rateBp > 10000) return null;
  const type =
    block.type === "TC22" ? "rivalsa_inps" : CASSA_TYPE_CODES.find((code) => code === block.type);
  return type ? { type, rateBp, mode: "excluded", subjectToRitenuta: block.withholding } : null;
}

function mapRitenuta(document: ReceivedDocument): RitenutaDefaults | null {
  const item = document.withholding[0];
  const rateBp = toBasisPoints(item?.rate ?? null);
  const type = RITENUTA_TYPES.find((code) => code === item?.type);
  const causale = CAUSALE_PAGAMENTO_CODES.find((code) => code === item?.reason);
  if (!item || !type || !causale || rateBp === null || rateBp < 1 || rateBp > 10000) return null;
  // The share of the subject amount the rate applies to, found back from the withheld amount.
  const subject =
    document.lines
      .filter((line) => line.withholding)
      .reduce((sum, line) => sum + (decimalToCents(line.total) ?? 0), 0) +
    document.cassa
      .filter((block) => block.withholding)
      .reduce((sum, block) => sum + (decimalToCents(block.amount) ?? 0), 0);
  const withheld = decimalToCents(item.amount);
  let baseBp = 10000;
  if (subject > 0 && withheld !== null) {
    const found = Math.round((withheld * 1e8) / (subject * rateBp));
    if (found >= 1 && found < 9990) baseBp = found;
  }
  return { type, rateBp, baseBp, causale };
}

/** Notes of the invoice: the `Causale` elements, without the natura legal texts the XML adds itself. */
function mapNote(document: ReceivedDocument): string {
  const legal = new Set(Object.values(NATURA_TEXTS).map((entry) => entry.text));
  return document.causali
    .filter((text) => !legal.has(text))
    .join("\n")
    .slice(0, 2000);
}

export function xmlDraftFromInvoice(
  invoice: ReceivedInvoice,
  customer: IssuedImportMeta["customer"],
): XmlDraft | null {
  const document = invoice.documents[0];
  if (!document || (document.documentType !== "TD01" && document.documentType !== "TD04")) {
    return null;
  }
  if (!DATE_ONLY.test(document.date) || document.number === "") return null;
  let lines = document.lines;
  let bollo: XmlDraft["bollo"] = "none";
  if (document.stamp) {
    // A bollo charged to the client is a generated line the editor adds itself.
    const generated = lines.findIndex(
      (line) =>
        line.description === STAMP_LINE_DESCRIPTION && decimalToCents(line.total) === STAMP_CENTS,
    );
    bollo = generated >= 0 ? "client" : "issuer";
    if (generated >= 0) lines = lines.filter((_, index) => index !== generated);
  }
  const payment = document.payments[0];
  const mapped = lines.map(mapLine);
  return {
    documentType: document.documentType,
    number: document.number,
    date: document.date,
    currency: /^[A-Z]{3}$/.test(document.currency) ? document.currency : "EUR",
    customer,
    lines:
      mapped.length > 0
        ? mapped
        : [
            {
              description: "",
              note: "",
              quantityMilli: 1000,
              unit: null,
              unitPriceCents: 0,
              vatRateBp: null,
              natura: null,
            },
          ],
    cassa: mapCassa(document),
    ritenuta: mapRitenuta(document),
    bollo,
    note: mapNote(document),
    payment: payment
      ? {
          method: payment.method || null,
          iban: payment.iban,
          dueDate: payment.dueDate && DATE_ONLY.test(payment.dueDate) ? payment.dueDate : null,
        }
      : null,
  };
}
