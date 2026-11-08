import type { IssuedSummaryDraftRow, SummaryRowOutcome } from "../../shared/import";
import { buildSummaryDraft } from "../../shared/summary-draft";
import { cassaDefaultsSchema, ritenutaDefaultsSchema } from "../../shared/tax";
import { importDrafts } from "./import-drafts";

/**
 * Issued rows of a Fatture in Cloud account summary dated after today: not issued yet, so each
 * becomes a normal unsent invoice (see `importDrafts`). The summary has no lines, so
 * `buildSummaryDraft` rebuilds one from the amounts, with the owner's cassa and ritenuta from Tax
 * details when the row has them.
 */
export async function importSummaryDrafts(
  db: D1Database,
  rows: IssuedSummaryDraftRow[],
  now = new Date(),
): Promise<SummaryRowOutcome[]> {
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
  return importDrafts(
    db,
    rows.map((row) => ({
      number: row.number,
      date: row.date,
      customer: row.customer,
      build: (context) => buildSummaryDraft(row, { ...context, tax }),
    })),
    now,
  );
}
