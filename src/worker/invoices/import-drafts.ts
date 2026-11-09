import type { ImportOutcome } from "../../shared/import";
import type { InvoiceBody } from "../../shared/invoice";
import type { DraftContext } from "../../shared/invoice-draft";
import { matchSeries } from "../../shared/numbering";
import { clientColumns, createImportClient } from "./import";
import { createInvoice } from "./store";

/**
 * Unsent invoices created by an import (the issued FatturaPA files that were never sent, or dated
 * after today). Each becomes a normal unsent
 * invoice created through `createInvoice`, the editor's save path, that the owner completes and
 * sends from Invoicer.
 *
 * The number is asked for as the requested number of its series, but only when the reservation
 * would accept it (above the highest number issued in that series and year). A number held by
 * another invoice is a `number_conflict` and nothing is created; a number that is free but not
 * above the highest, or free text, is created without a number (`numberNote`). The same
 * invoice twice (same series, year, requested number and invoice date) is a `duplicate`.
 */

export interface DraftCandidate {
  number: string;
  date: string;
  customer: {
    name: string;
    vatCountry: string | null;
    vatCode: string | null;
    taxCode: string | null;
  };
  /** A client record built from the source, created when no client matches and it is valid. */
  client?: unknown;
  build: (context: DraftContext) => InvoiceBody;
}

interface Held {
  id: string;
  planned_date: string | null;
  issue_date: string | null;
}

export async function importDrafts(
  db: D1Database,
  candidates: DraftCandidate[],
  now = new Date(),
): Promise<ImportOutcome[]> {
  const { results: seriesRows } = await db
    .prepare("SELECT id, prefix, suffix, is_default AS isDefault FROM numbering_series")
    .all<{ id: string; prefix: string | null; suffix: string | null; isDefault: number }>();
  const series = seriesRows.map((row) => ({ ...row, isDefault: row.isDefault === 1 }));
  const planned = candidates.map((candidate) => ({
    candidate,
    ...matchSeries(candidate.number, series),
    year: Number(candidate.date.slice(0, 4)),
  }));

  // One batch for everything the candidates need to know: the invoice holding the number (issued,
  // or an unsent one that asked for it), the highest issued number, a same-customer unsent
  // invoice (free text numbers) and the clients.
  const lookups: D1PreparedStatement[] = [];
  const shape = planned.map(({ candidate, seriesId, progressive, year }) => {
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
          .bind(candidate.date, candidate.customer.name),
      );
    }
    const columns = clientColumns(candidate.customer);
    const first = lookups.length;
    for (const [column, value] of columns) {
      lookups.push(db.prepare(`SELECT id FROM clients WHERE ${column} LIMIT 1`).bind(value));
    }
    return { at, first, columns };
  });
  const answers = lookups.length > 0 ? await db.batch<Record<string, unknown>>(lookups) : [];
  const first = <T>(index: number) => answers[index]?.results[0] as T | undefined;

  const outcomes: ImportOutcome[] = [];
  // Candidates of this request that already asked for a number or took the place of a free-text one.
  const seen = new Map<string, { id: string; date: string }>();
  // Clients created by this request, so a customer shared by two candidates is created once.
  const created = new Map<string, string>();

  for (const [index, { candidate, seriesId, progressive, year }] of planned.entries()) {
    const at = shape[index];
    if (!seriesId || !at) {
      outcomes.push({ outcome: "invalid" });
      continue;
    }
    const key =
      progressive !== null
        ? `${seriesId}|${year}|${progressive}`
        : `${candidate.date}|${candidate.customer.name}`;
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
          heldDate === candidate.date
            ? { outcome: "duplicate", id: holder.id }
            : { outcome: "number_conflict", id: holder.id, number: candidate.number },
        );
        continue;
      }
      if (earlier) {
        outcomes.push(
          earlier.date === candidate.date
            ? { outcome: "duplicate", id: earlier.id }
            : { outcome: "number_conflict", id: earlier.id, number: candidate.number },
        );
        continue;
      }
    }
    const highest =
      progressive === null ? 0 : (first<{ highest: number | null }>(at.at + 2)?.highest ?? 0);
    const accepted = progressive !== null && progressive > highest;
    let clientId: string | null = null;
    for (let i = 0; i < at.columns.length && clientId === null; i++) {
      clientId = first<{ id: string }>(at.first + i)?.id ?? null;
    }
    const keys = at.columns.map(([column, value]) => `${column}|${value}`);
    for (const known of keys) clientId ??= created.get(known) ?? null;
    try {
      if (clientId === null && candidate.client) {
        clientId = await createImportClient(db, candidate.client);
        if (clientId) for (const known of keys) created.set(known, clientId);
      }
      const id = await createInvoice(
        db,
        candidate.build({ clientId, seriesId, requestedNumber: accepted ? progressive : null }),
        { counterpartyName: candidate.customer.name },
        now,
      );
      seen.set(key, { id, date: candidate.date });
      outcomes.push({
        outcome: "imported",
        id,
        clientLinked: clientId !== null,
        ...(accepted ? {} : { numberNote: progressive === null ? "free_text" : "unavailable" }),
      } as ImportOutcome);
    } catch {
      outcomes.push({ outcome: "invalid" });
    }
  }
  return outcomes;
}
