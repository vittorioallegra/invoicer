import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatDate, formatMoney, type UiLocale } from "../../shared/format";
import type { InvoiceListScope, InvoiceSummary } from "../../shared/invoice";
import { formatNumberWithYear } from "../../shared/numbering";
import { invoicesQuery, releaseNumber } from "../lib/invoices-api";
import { useOnline } from "../lib/online";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import { ListSkeleton } from "./ui/skeleton";
import { CreditNoteBadge, ImportedBadge, StatusBadge } from "./ui/status-badge";
import { toast } from "./ui/toast";

function useLocale(): UiLocale {
  const { i18n } = useTranslation();
  return i18n.language.startsWith("it") ? "it" : "en";
}

function Row({ invoice, extra }: { invoice: InvoiceSummary; extra?: ReactNode }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const credit = invoice.documentType === "TD04";
  // The invoice date only (the issue date of a sent invoice is that same date, as in the XML).
  const date = invoice.issueDate ?? invoice.invoiceDate;
  const subtitle =
    [
      invoice.number
        ? t("invoice.list.number", { number: formatNumberWithYear(invoice.number, invoice.year) })
        : null,
      date !== null ? formatDate(date, locale) : null,
    ]
      .filter(Boolean)
      .join(" · ") || null;
  // Same rule as the editor chip: finalised, not rejected, not a credit note.
  const payable =
    invoice.state !== "draft" &&
    invoice.state !== "planned" &&
    invoice.state !== "rejected" &&
    invoice.state !== "rejected_expired" &&
    !credit;
  // A credit note is shown negative.
  const money = (cents: number) => formatMoney(credit ? -cents : cents, locale, invoice.currency);
  return (
    <li className="flex flex-col">
      <Link
        to="/invoices/$invoiceId"
        params={{ invoiceId: invoice.id }}
        className="flex min-h-14 items-start gap-3 px-4 py-3 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">
            {invoice.clientName ?? t("invoice.list.noClient")}
          </span>
          {subtitle ? (
            <span className="block text-sm text-muted-foreground">{subtitle}</span>
          ) : null}
          {invoice.state === "rejected" && invoice.rejectionDeadline !== null ? (
            <span className="block text-sm text-danger">
              {t("invoice.list.resendBy", {
                date: formatDate(new Date(invoice.rejectionDeadline), locale),
              })}
            </span>
          ) : null}
          <span className="mt-1 flex flex-wrap gap-1">
            {invoice.source === "imported" ? <ImportedBadge /> : null}
            {credit ? <CreditNoteBadge /> : null}
            <StatusBadge status={invoice.state} />
            {payable ? <StatusBadge status={invoice.paymentFlag} /> : null}
          </span>
        </span>
        <span className="flex flex-col items-end tabular-nums">
          <span className="font-medium">
            {invoice.totalCents === null ? "–" : money(invoice.totalCents)}
          </span>
          {invoice.totalCents !== null && invoice.contributionCents ? (
            <span className="text-sm text-muted-foreground">
              {t("invoice.list.contribution", { amount: money(invoice.contributionCents) })}
            </span>
          ) : null}
          {invoice.totalCents !== null && invoice.vatCents ? (
            <span className="text-sm text-muted-foreground">
              {t("invoice.list.vat", { amount: money(invoice.vatCents) })}
            </span>
          ) : null}
        </span>
      </Link>
      {extra ? <div className="px-4 pb-3">{extra}</div> : null}
    </li>
  );
}

export interface InvoiceListProps {
  scope: InvoiceListScope;
  /** Rendered when the list is empty (a screen may show a richer empty state instead). */
  empty: ReactNode;
}

/** Minimal invoice list with its skeleton, empty and error states. */
export function InvoiceList({ scope, empty }: InvoiceListProps) {
  const { t } = useTranslation();
  const query = useQuery(invoicesQuery(scope));
  if (query.isPending) {
    return <ListSkeleton rows={3} />;
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
  if (query.data.invoices.length === 0) return <>{empty}</>;
  return <InvoiceRows invoices={query.data.invoices} />;
}

/** The bordered rows of an already loaded list. */
export function InvoiceRows({ invoices }: { invoices: InvoiceSummary[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
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
      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
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
