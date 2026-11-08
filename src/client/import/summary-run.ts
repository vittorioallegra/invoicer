import type {
  ImportItemResult,
  IssuedSummaryDraftRow,
  IssuedSummaryRow,
  ReceivedSummaryRow,
  SummaryImportResponse,
  SummaryRowOutcome,
} from "../../shared/import";
import { type NumberingSeriesData, seriesRequestBody } from "../../shared/numbering";
import { api } from "../lib/api";
import type { FicInvalidRow, FicSummary } from "./fic-summary";

/**
 * Sends a Fatture in Cloud account summary to the Worker once the owner confirmed the preview:
 * first the numbering series the numbers need, then the issued rows, then the issued rows dated
 * after today (created as unsent invoices, never as delivered ones), then the received rows, in
 * chunks (the Worker answers one outcome per row; a chunk is small enough for its CPU limit).
 * Never throws: a failed chunk marks its rows `server_error` and the others go on.
 */

/** Rows per request (the Worker accepts up to `SUMMARY_CHUNK_ROWS`, and `SUMMARY_DRAFT_CHUNK_ROWS` of drafts). */
const CHUNK = 20;
const DRAFT_CHUNK = 10;

export interface SummaryProgress {
  /** Rows answered so far, and all rows to send. */
  done: number;
  total: number;
}

export interface SummaryRunOptions {
  /** Paid by default; `paidFor` decides row by row when the owner changed some. */
  markPaid: boolean;
  /** Whether an invoice is stored as paid, by its row in the sheet; defaults to `markPaid`. */
  paidFor?: (kind: "issued" | "received", line: number) => boolean;
  series: NumberingSeriesData[];
  /** Today (Europe/Rome, `YYYY-MM-DD`): an issued row dated after it becomes an unsent invoice. */
  today: string;
  /** The text of one row on the result screen ("Issued 3/CH, 2025-03-31, Acme"). */
  label: (kind: "issued" | "received", number: string, date: string, name: string) => string;
  /** The title and the reason of a row that could not be read from the file. */
  invalidLabel: (row: FicInvalidRow) => string;
  invalidDetail: (row: FicInvalidRow) => string;
  onProgress?: (progress: SummaryProgress) => void;
}

export interface SummaryItem extends ImportItemResult {
  kind: "issued" | "received";
}

const chunks = <T>(rows: T[], size = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};

function toItem(
  kind: "issued" | "received",
  label: string,
  outcome: SummaryRowOutcome | undefined,
  draft = false,
): SummaryItem {
  const base = { kind, label };
  if (outcome?.outcome === "imported") {
    if (!draft) return { ...base, status: "imported", id: outcome.id };
    return {
      ...base,
      status: "imported",
      id: outcome.id,
      draft: true,
      ...(outcome.numberNote ? { detail: `draft_number_${outcome.numberNote}` } : {}),
    };
  }
  if (outcome?.outcome === "duplicate") {
    return { ...base, status: "skipped", reason: "duplicate", id: outcome.id };
  }
  if (outcome?.outcome === "number_conflict") {
    return {
      ...base,
      status: "skipped",
      reason: "number_conflict",
      detail: outcome.number,
      id: outcome.id,
    };
  }
  return { ...base, status: "skipped", reason: "server_error" };
}

export async function runSummaryImport(
  summary: FicSummary,
  options: SummaryRunOptions,
): Promise<SummaryItem[]> {
  // A series that cannot be created (taken meanwhile) only means those numbers block nothing.
  for (const series of options.series) {
    try {
      await api("/api/numbering-series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(seriesRequestBody(series)),
      });
    } catch {
      // Keep importing.
    }
  }

  const paidFor = options.paidFor ?? (() => options.markPaid);
  const future = (date: string) => date > options.today;
  const issued: IssuedSummaryRow[] = summary.issued
    .filter(({ row }) => !future(row.date))
    .map(({ line, row: { amounts: _amounts, ...row } }) => ({
      ...row,
      paid: paidFor("issued", line),
    }));
  // Not issued yet: an unsent invoice, never paid, whatever the "mark as paid" boxes say.
  const drafts: IssuedSummaryDraftRow[] = summary.issued
    .filter(({ row }) => future(row.date))
    .map(({ row }) => row);
  const received: ReceivedSummaryRow[] = summary.received.map(({ line, row }) => ({
    ...row,
    paid: paidFor("received", line),
  }));
  const total = issued.length + drafts.length + received.length;
  let done = 0;
  options.onProgress?.({ done, total });

  const items: SummaryItem[] = [];
  const send = async <Row>(
    kind: "issued" | "received",
    path: string,
    rows: Row[],
    labelOf: (row: Row) => string,
    size = CHUNK,
    draft = false,
  ) => {
    for (const part of chunks(rows, size)) {
      let results: SummaryRowOutcome[] = [];
      try {
        results = (
          await api<SummaryImportResponse>(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows: part }),
          })
        ).results;
      } catch {
        // Every row of the chunk is reported as failed below.
      }
      part.forEach((row, index) => {
        items.push(toItem(kind, labelOf(row), results[index], draft));
      });
      done += part.length;
      options.onProgress?.({ done, total });
    }
  };
  await send("issued", "/api/invoices/import-summary", issued, (row) =>
    options.label("issued", row.number, row.date, row.customer.name),
  );
  await send(
    "issued",
    "/api/invoices/import-summary-drafts",
    drafts,
    (row) => options.label("issued", row.number, row.date, row.customer.name),
    DRAFT_CHUNK,
    true,
  );
  await send("received", "/api/received/import-summary", received, (row) =>
    options.label("received", row.number, row.issueDate, row.supplierName),
  );
  for (const row of summary.invalid) {
    items.push({
      kind: row.kind,
      label: options.invalidLabel(row),
      status: "skipped",
      reason: "invalid_row",
      detail: options.invalidDetail(row),
    });
  }
  return items;
}
