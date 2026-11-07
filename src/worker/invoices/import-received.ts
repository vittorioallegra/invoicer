import type { ReceivedSummaryRow, SummaryRowOutcome } from "../../shared/import";

/**
 * Import of the received rows of a Fatture in Cloud account summary: no original file. A row is a
 * duplicate of a received invoice with the same supplier (VAT id, or name when the supplier has
 * none) number and date, whether it came from an earlier import or through the PEC mailbox (the
 * mailbox writes the VAT id with its country, the summary without). One batch reads the matches,
 * one batch writes the rest.
 */

/** The ways the same VAT id can be stored: as written, and with the `IT` country prefix. */
const vatVariants = (vat: string | null): [string | null, string | null] => [
  vat,
  vat !== null && /^\d{11}$/.test(vat) ? `IT${vat}` : null,
];

export async function importReceivedSummary(
  db: D1Database,
  rows: ReceivedSummaryRow[],
): Promise<SummaryRowOutcome[]> {
  const lookups = rows.map((row) => {
    const [plain, prefixed] = vatVariants(row.supplierVat);
    return db
      .prepare(
        `SELECT id FROM received_invoices
         WHERE number = ?1 AND issue_date = ?2
           AND (supplier_vat IN (?3, ?4) OR lower(supplier_name) = lower(?5))
         LIMIT 1`,
      )
      .bind(row.number, row.issueDate, plain, prefixed, row.supplierName);
  });
  const answers = await db.batch<{ id: string }>(lookups);

  const outcomes: SummaryRowOutcome[] = [];
  const inserts: { index: number; id: string; row: ReceivedSummaryRow }[] = [];
  const taken = new Map<string, string>();
  rows.forEach((row, index) => {
    const found = answers[index]?.results[0];
    if (found) {
      outcomes.push({ outcome: "duplicate", id: found.id });
      return;
    }
    // The same invoice twice in one file.
    const key = `${row.supplierVat ?? row.supplierName.toLowerCase()}|${row.number}|${row.issueDate}`;
    const earlier = taken.get(key);
    if (earlier) {
      outcomes.push({ outcome: "duplicate", id: earlier });
      return;
    }
    const id = crypto.randomUUID();
    taken.set(key, id);
    outcomes.push({ outcome: "imported", id });
    inserts.push({ index, id, row });
  });

  if (inserts.length > 0) {
    const now = Date.now();
    await db.batch(
      inserts.map(({ id, row }) =>
        db
          .prepare(
            `INSERT INTO received_invoices (id, pec_message_id, parse_status, file_id, supplier_name,
               supplier_vat, number, issue_date, document_type, currency, total_cents, payment_flag,
               paid_date, created_at)
             VALUES (?, NULL, 'parsed', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            row.supplierName,
            row.supplierVat,
            row.number,
            row.issueDate,
            row.documentType,
            row.currency,
            row.totalCents,
            row.paid ? "paid" : "unpaid",
            row.paid ? row.issueDate : null,
            now,
          ),
      ),
    );
  }
  return outcomes;
}
