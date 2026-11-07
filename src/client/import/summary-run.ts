import type {
  ImportItemResult,
  IssuedSummaryRow,
  ReceivedSummaryRow,
  SummaryImportResponse,
  SummaryRowOutcome,
} from "../../shared/import";
import type { NumberingSeriesData } from "../../shared/numbering";
import { api } from "../lib/api";
import type { FicInvalidRow, FicSummary } from "./fic-summary";

/**
 * Sends a Fatture in Cloud account summary to the Worker once the owner confirmed the preview:
 * first the numbering series the numbers need, then the issued rows, then the received rows, in
 * chunks (the Worker answers one outcome per row; a chunk is small enough for its CPU limit).
 * Never throws: a failed chunk marks its rows `server_error` and the others go on.
 */

/** Rows per request (the Worker accepts up to `SUMMARY_CHUNK_ROWS`). */
const CHUNK = 20;

export interface SummaryProgress {
  /** Rows answered so far, and all rows to send. */
  done: number;
  total: number;
}

export interface SummaryRunOptions {
  markPaid: boolean;
  series: NumberingSeriesData[];
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

const chunks = <T>(rows: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
};

function toItem(
  kind: "issued" | "received",
  label: string,
  outcome: SummaryRowOutcome | undefined,
): SummaryItem {
  const base = { kind, label };
  if (outcome?.outcome === "imported") return { ...base, status: "imported", id: outcome.id };
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
        body: JSON.stringify(series),
      });
    } catch {
      // Keep importing.
    }
  }

  const issued: IssuedSummaryRow[] = summary.issued.map(({ row }) => ({
    ...row,
    paid: options.markPaid,
  }));
  const received: ReceivedSummaryRow[] = summary.received.map(({ row }) => ({
    ...row,
    paid: options.markPaid,
  }));
  const total = issued.length + received.length;
  let done = 0;
  options.onProgress?.({ done, total });

  const items: SummaryItem[] = [];
  const send = async <Row>(
    kind: "issued" | "received",
    path: string,
    rows: Row[],
    labelOf: (row: Row) => string,
  ) => {
    for (const part of chunks(rows)) {
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
        items.push(toItem(kind, labelOf(row), results[index]));
      });
      done += part.length;
      options.onProgress?.({ done, total });
    }
  };
  await send("issued", "/api/invoices/import-summary", issued, (row) =>
    options.label("issued", row.number, row.date, row.customer.name),
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
