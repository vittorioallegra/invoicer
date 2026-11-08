import type { IssuedSummaryDraftRow, SummaryRowOutcome } from "../../shared/import";
import { matchSeries } from "../../shared/numbering";
import { buildSummaryDraft } from "../../shared/summary-draft";
import { cassaDefaultsSchema, ritenutaDefaultsSchema } from "../../shared/tax";
import { clientColumns } from "./import";
import { createInvoice } from "./store";

/**
 * Issued rows of a Fatture in Cloud account summary dated after today: not issued yet, so each
 * becomes a normal unsent invoice (created through `createInvoice`, the editor's save path) that
 * the owner completes and sends from Invoicer. See `buildSummaryDraft` for what it contains.
 *
 * The summary number is asked for as the requested number of its series, but only when the
 * reservation would accept it (above the highest number issued in that series and year). A number
 * held by another invoice is a `number_conflict` and nothing is created; a number that is free
 * but not above the highest, or free text, is created without a number (`numberNote`). The same
 * row twice (same series, year, requested number and invoice date) is a `duplicate`.
 */

interface Held {
  id: string;
  planned_date: string | null;
  issue_date: string | null;
}

export async function importSummaryDrafts(
  db: D1Database,
  rows: IssuedSummaryDraftRow[],
  now = new Date(),
): Promise<SummaryRowOutcome[]> {
  const { results: seriesRows } = await db
    .prepare("SELECT id, prefix, suffix, is_default AS isDefault FROM numbering_series")
    .all<{ id: string; prefix: string | null; suffix: string | null; isDefault: number }>();
  const series = seriesRows.map((row) => ({ ...row, isDefault: row.isDefault === 1 }));
  const settings = await db
    .prepare("SELECT tax_cassa AS cassa, tax_ritenuta AS ritenuta FROM settings WHERE id = 1")
    .first<{ cassa: string | null; ritenuta: string | null }>();
  const parseJson = (text: string | null | undefined) => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };
  const cassa = cassaDefaultsSchema.safeParse(parseJson(settings?.cassa));
  const ritenuta = ritenutaDefaultsSchema.safeParse(parseJson(settings?.ritenuta));
  const tax = {
    cassa: cassa.success ? cassa.data : null,
    ritenuta: ritenuta.success ? ritenuta.data : null,
  };

  const planned = rows.map((row) => ({
    row,
    ...matchSeries(row.number, series),
    year: Number(row.date.slice(0, 4)),
  }));

  // One batch for everything the rows need to know: the invoice holding the number (issued, or an
  // unsent one that asked for it), the highest issued number, a same-customer unsent invoice (free
  // text numbers) and the clients.
  const lookups: D1PreparedStatement[] = [];
  const shape = planned.map(({ row, seriesId, progressive, year }) => {
    const at = lookups.length;
    if (progressive !== null) {
      lookups.push(
        db
          .prepare(
            `SELECT id, planned_date, issue_date FROM invoices
             WHERE series_id = ?1 AND year = ?2 AND number_int = ?3 LIMIT 1`,
          )
          .bind(seriesId, year, progressive),
        db
          .prepare(
            `SELECT id, planned_date, issue_date FROM invoices
             WHERE series_id = ?1 AND number_int IS NULL AND requested_number_int = ?3
               AND substr(planned_date, 1, 4) = ?2 AND state IN ('draft', 'planned') LIMIT 1`,
          )
          .bind(seriesId, String(year), progressive),
        db
          .prepare(
            "SELECT MAX(number_int) AS highest FROM invoices WHERE series_id = ? AND year = ?",
          )
          .bind(seriesId, year),
      );
    } else {
      lookups.push(
        db
          .prepare(
            `SELECT id, planned_date, issue_date FROM invoices
             WHERE number_int IS NULL AND requested_number_int IS NULL AND source = 'app'
               AND state IN ('draft', 'planned') AND planned_date = ? AND counterparty_name = ?
             LIMIT 1`,
          )
          .bind(row.date, row.customer.name),
      );
    }
    const columns = clientColumns(row.customer);
    const first = lookups.length;
    for (const [column, value] of columns) {
      lookups.push(db.prepare(`SELECT id FROM clients WHERE ${column} = ? LIMIT 1`).bind(value));
    }
    return { at, first, count: columns.length };
  });
  const answers = lookups.length > 0 ? await db.batch<Record<string, unknown>>(lookups) : [];
  const first = <T>(index: number) => answers[index]?.results[0] as T | undefined;

  const outcomes: SummaryRowOutcome[] = [];
  // Rows of this request that already asked for a number or took the place of a free-text one.
  const seen = new Map<string, { id: string; date: string }>();

  for (const [index, { row, seriesId, progressive, year }] of planned.entries()) {
    const at = shape[index];
    if (!seriesId || !at) {
      outcomes.push({ outcome: "invalid" });
      continue;
    }
    const key =
      progressive !== null
        ? `${seriesId}|${year}|${progressive}`
        : `${row.date}|${row.customer.name}`;
    const earlier = seen.get(key);
    if (progressive === null) {
      const held = first<Held>(at.at);
      if (held ?? earlier) {
        outcomes.push({ outcome: "duplicate", id: (held?.id ?? earlier?.id) as string });
        continue;
      }
    } else {
      const issued = first<Held>(at.at);
      const unsent = first<Held>(at.at + 1);
      const holder = issued ?? unsent;
      const heldDate = issued ? issued.issue_date : (unsent?.planned_date ?? null);
      if (holder) {
        outcomes.push(
          heldDate === row.date
            ? { outcome: "duplicate", id: holder.id }
            : { outcome: "number_conflict", id: holder.id, number: row.number },
        );
        continue;
      }
      if (earlier) {
        outcomes.push(
          earlier.date === row.date
            ? { outcome: "duplicate", id: earlier.id }
            : { outcome: "number_conflict", id: earlier.id, number: row.number },
        );
        continue;
      }
    }
    const highest =
      progressive === null ? 0 : (first<{ highest: number | null }>(at.at + 2)?.highest ?? 0);
    const accepted = progressive !== null && progressive > highest;
    let clientId: string | null = null;
    for (let i = 0; i < at.count && clientId === null; i++) {
      clientId = first<{ id: string }>(at.first + i)?.id ?? null;
    }
    try {
      const id = await createInvoice(
        db,
        buildSummaryDraft(row, {
          tax,
          clientId,
          seriesId,
          requestedNumber: accepted ? progressive : null,
        }),
        { counterpartyName: row.customer.name },
        now,
      );
      seen.set(key, { id, date: row.date });
      outcomes.push({
        outcome: "imported",
        id,
        clientLinked: clientId !== null,
        ...(accepted ? {} : { numberNote: progressive === null ? "free_text" : "unavailable" }),
      } as SummaryRowOutcome);
    } catch {
      outcomes.push({ outcome: "invalid" });
    }
  }
  return outcomes;
}
