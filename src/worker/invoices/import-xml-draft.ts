import type { SummaryRowOutcome, XmlDraft } from "../../shared/import";
import { PAYMENT_METHODS } from "../../shared/invoice";
import { assembleDraft } from "../../shared/invoice-draft";
import { importDrafts } from "./import-drafts";

/**
 * An issued FatturaPA file that was never sent, read in the browser: created as an unsent invoice
 * with the real content of the file (lines, cassa, ritenuta, bollo, note, payment). The bank
 * account is copied from the stored payment method with the same IBAN; without one it is left for
 * the owner. The original file is not stored.
 */
export async function importXmlDraft(
  db: D1Database,
  draft: XmlDraft,
  now = new Date(),
): Promise<SummaryRowOutcome> {
  const iban = draft.payment?.iban?.replaceAll(/\s+/g, "").toUpperCase() ?? null;
  const account = iban
    ? await db
        .prepare(
          "SELECT iban, bic, account_holder AS accountHolder FROM payment_methods WHERE iban = ? LIMIT 1",
        )
        .bind(iban)
        .first<{ iban: string; bic: string | null; accountHolder: string | null }>()
    : null;
  const method = PAYMENT_METHODS.find((code) => code === draft.payment?.method) ?? null;
  const [outcome] = await importDrafts(
    db,
    [
      {
        number: draft.number,
        date: draft.date,
        customer: draft.customer,
        client: draft.customer.client,
        build: (context) =>
          assembleDraft(
            {
              documentType: draft.documentType,
              currency: draft.currency,
              date: draft.date,
              lines: draft.lines,
              cassa: draft.cassa,
              ritenuta: draft.ritenuta,
              bollo: draft.bollo,
              note: draft.note,
              payment: draft.payment
                ? {
                    method,
                    account: account
                      ? {
                          iban: account.iban,
                          bic: account.bic,
                          accountHolder: account.accountHolder,
                          bankName: null,
                        }
                      : null,
                    dueDate: draft.payment.dueDate,
                  }
                : null,
            },
            context,
          ),
      },
    ],
    now,
  );
  return outcome ?? { outcome: "invalid" };
}
