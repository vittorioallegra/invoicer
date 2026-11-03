import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatDate, formatMoney, type UiLocale } from "../../shared/format";
import type { InvoiceListScope, InvoiceSummary } from "../../shared/invoice";
import { invoicesQuery, releaseNumber } from "../lib/invoices-api";
import { useOnline } from "../lib/online";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import { StatusBadge } from "./ui/status-badge";
import { toast } from "./ui/toast";

function useLocale(): UiLocale {
  const { i18n } = useTranslation();
  return i18n.language.startsWith("it") ? "it" : "en";
}

function Row({ invoice, extra }: { invoice: InvoiceSummary; extra?: ReactNode }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const credit = invoice.documentType === "TD04";
  const dateLine =
    invoice.issueDate !== null
      ? t("invoice.list.issued", { date: formatDate(invoice.issueDate, locale) })
      : invoice.plannedDate !== null
        ? t("invoice.list.planned", { date: formatDate(invoice.plannedDate, locale) })
        : null;
  const issuedOut = invoice.state !== "draft" && invoice.state !== "planned";
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <Link
        to="/invoices/$invoiceId"
        params={{ invoiceId: invoice.id }}
        className="flex min-h-14 items-start gap-3 hover:bg-muted"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">
            {invoice.number
              ? t(credit ? "invoice.list.creditNoteNumber" : "invoice.list.number", {
                  number: invoice.number,
                })
              : t(credit ? "invoice.list.creditNoteDraft" : "invoice.list.draft")}
            {" · "}
            {invoice.clientName ?? t("invoice.list.noClient")}
          </span>
          {dateLine ? (
            <span className="block text-sm text-muted-foreground">{dateLine}</span>
          ) : null}
          {invoice.state === "rejected" && invoice.rejectionDeadline !== null ? (
            <span className="block text-sm text-danger">
              {t("invoice.list.resendBy", {
                date: formatDate(new Date(invoice.rejectionDeadline), locale),
              })}
            </span>
          ) : null}
        </span>
        <span className="flex flex-col items-end gap-1">
          <span className="font-medium tabular-nums">
            {invoice.totalCents === null
              ? "–"
              : formatMoney(
                  credit ? -invoice.totalCents : invoice.totalCents,
                  locale,
                  invoice.currency,
                )}
          </span>
          <span className="flex flex-wrap justify-end gap-1">
            <StatusBadge status={invoice.state} />
            {issuedOut && invoice.paymentFlag !== "unpaid" ? (
              <StatusBadge status={invoice.paymentFlag} />
            ) : null}
          </span>
        </span>
      </Link>
      {extra}
    </li>
  );
}

export interface InvoiceListProps {
  scope: InvoiceListScope;
  /** Rendered when the list is empty (a screen may show a richer empty state instead). */
  empty: ReactNode;
}

/** Minimal invoice list with its loading, empty and error states (full dashboard: step 16). */
export function InvoiceList({ scope, empty }: InvoiceListProps) {
  const { t } = useTranslation();
  const query = useQuery(invoicesQuery(scope));
  if (query.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("common.loading")}
      </p>
    );
  }
  if (query.isError) {
    return (
      <Banner
        tone="danger"
        action={
          <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
            {t("common.retry")}
          </Button>
        }
      >
        {t("common.error")}
      </Banner>
    );
  }
  const invoices = query.data.invoices;
  if (invoices.length === 0) return <>{empty}</>;
  return (
    <ul className="flex flex-col divide-y divide-border rounded-card border border-border">
      {invoices.map((invoice) => (
        <Row key={invoice.id} invoice={invoice} />
      ))}
    </ul>
  );
}

/** "Number reserved, not sent": numbered invoices waiting for the send flow, releasable if highest. */
export function ReservedList() {
  const { t } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const query = useQuery(invoicesQuery("reserved"));
  const release = useMutation({
    mutationFn: (id: string) => releaseNumber(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      await queryClient.invalidateQueries({ queryKey: ["invoice"] });
    },
    onError: () => toast.error(t("invoice.reserved.releaseFailed")),
  });
  const invoices = query.data?.invoices ?? [];
  if (invoices.length === 0) return null;
  return (
    <section aria-labelledby="reserved-title" className="flex flex-col gap-2">
      <h2 id="reserved-title" className="text-base font-semibold">
        {t("invoice.reserved.title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("invoice.reserved.intro")}</p>
      <ul className="flex flex-col divide-y divide-border rounded-card border border-border">
        {invoices.map((invoice) => (
          <Row
            key={invoice.id}
            invoice={invoice}
            extra={
              invoice.releasable ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="w-fit"
                  disabled={!online || release.isPending}
                  onClick={() => release.mutate(invoice.id)}
                >
                  {t("invoice.reserved.release")}
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">{t("invoice.reserved.mustSend")}</p>
              )
            }
          />
        ))}
      </ul>
    </section>
  );
}
