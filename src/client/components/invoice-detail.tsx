import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Send } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { InvoiceRecord } from "../../shared/invoice";
import { manualHandedOver, manualOutcome, transmissionsQuery } from "../lib/invoices-api";
import { useOnline } from "../lib/online";
import { SendError, SendSheet } from "./send-sheet";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

export interface InvoiceDetailProps {
  record: InvoiceRecord;
  clientName: string;
  totalLabel: string;
}

/**
 * State-aware panel of a numbered invoice: where it is in the SdI journey, the attempts, the
 * PDF/XML downloads (Worker attachments, so they work whatever the in-browser viewer does), the
 * manual AdE channel, and the primary action that follows the state.
 */
export function InvoiceDetail({ record, clientName, totalLabel }: InvoiceDetailProps) {
  const { t, i18n } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const info = useQuery(transmissionsQuery(record.id));
  const [sendOpen, setSendOpen] = useState(false);
  const [rejectCode, setRejectCode] = useState("");
  const [rejectText, setRejectText] = useState("");
  const [rejecting, setRejecting] = useState(false);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["invoices"] }),
      queryClient.invalidateQueries({ queryKey: ["invoice", record.id] }),
      queryClient.invalidateQueries({ queryKey: ["transmissions", record.id] }),
    ]);
  };
  const handover = useMutation({
    mutationFn: () => manualHandedOver(record.id),
    onSuccess: refresh,
  });
  const outcome = useMutation({
    mutationFn: (body: Parameters<typeof manualOutcome>[1]) => manualOutcome(record.id, body),
    onSuccess: refresh,
  });

  const attempts = info.data?.attempts ?? [];
  const latest = attempts.at(-1);
  const retry = info.data?.retry;
  const when = (ms: number) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(ms);
  const state = record.state;
  const manualSent = state === "sent" && latest?.channel === "manual";

  return (
    <section
      className="flex flex-col gap-3 rounded-card border border-border p-4"
      aria-labelledby="inv-detail"
    >
      <h2 id="inv-detail" className="text-base font-medium">
        {t("detail.title")}
      </h2>

      <div className="flex flex-wrap gap-3">
        <a
          className="inline-flex min-h-11 items-center gap-2 rounded-control border border-border px-3 text-sm font-medium hover:bg-muted"
          href={`/api/invoices/${record.id}/pdf`}
          download
        >
          <Download aria-hidden className="size-4" />
          {t("detail.downloadPdf")}
        </a>
        <a
          className="inline-flex min-h-11 items-center gap-2 rounded-control border border-border px-3 text-sm font-medium hover:bg-muted"
          href={`/api/invoices/${record.id}/xml`}
          download
        >
          <Download aria-hidden className="size-4" />
          {t("detail.downloadXml")}
        </a>
      </div>

      {state === "sending" ? (
        <div className="flex flex-col gap-2">
          {latest?.outcome === "complete" ? (
            <Banner tone="info">{t("detail.waitingReceipt")}</Banner>
          ) : null}
          {latest?.outcome === "unknown" ? (
            <Banner tone="warning">
              <p>{t("detail.unknown")}</p>
              {retry && !retry.allowed && retry.reason === "quiet_period" && retry.retryAt ? (
                <p>{t("detail.retryAt", { when: when(retry.retryAt) })}</p>
              ) : null}
            </Banner>
          ) : null}
          {latest?.outcome === "none" || (latest?.outcome === "unknown" && retry?.allowed) ? (
            <div className="flex flex-wrap gap-3">
              <Button disabled={!online} onClick={() => setSendOpen(true)}>
                <Send aria-hidden />
                {t(latest?.outcome === "unknown" ? "detail.resendNew" : "invoice.actions.send")}
              </Button>
              {latest?.outcome === "none" ? (
                <Button
                  variant="secondary"
                  disabled={!online || handover.isPending}
                  onClick={() => handover.mutate()}
                >
                  {t("detail.manualHandedOver")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {latest?.outcome === "none" ? (
            <p className="text-sm text-muted-foreground">{t("detail.manualHint")}</p>
          ) : null}
          {handover.isError ? <SendError error={handover.error} /> : null}
        </div>
      ) : null}

      {state === "sent" ? (
        <Banner tone="info">{t(manualSent ? "detail.manualWaiting" : "detail.waitingSdi")}</Banner>
      ) : null}

      {manualSent ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              disabled={!online || outcome.isPending}
              onClick={() => outcome.mutate({ outcome: "delivered" })}
            >
              {t("detail.markDelivered")}
            </Button>
            <Button
              variant="secondary"
              disabled={!online || outcome.isPending}
              onClick={() => outcome.mutate({ outcome: "not_delivered" })}
            >
              {t("detail.markNotDelivered")}
            </Button>
            <Button variant="secondary" onClick={() => setRejecting(!rejecting)}>
              {t("detail.markRejected")}
            </Button>
          </div>
          {rejecting ? (
            <div className="flex flex-col gap-3">
              <Field label={t("detail.errorCode")} className="max-w-xs">
                {(c) => (
                  <Input
                    {...c}
                    value={rejectCode}
                    onChange={(e) => setRejectCode(e.target.value)}
                  />
                )}
              </Field>
              <Field label={t("detail.errorText")}>
                {(c) => (
                  <Textarea
                    {...c}
                    value={rejectText}
                    onChange={(e) => setRejectText(e.target.value)}
                  />
                )}
              </Field>
              <Button
                className="w-fit"
                disabled={!online || outcome.isPending || rejectText.trim() === ""}
                onClick={() =>
                  outcome.mutate({
                    outcome: "rejected",
                    errors: [{ code: rejectCode.trim(), description: rejectText.trim() }],
                  })
                }
              >
                {t("detail.saveRejected")}
              </Button>
            </div>
          ) : null}
          {outcome.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
        </div>
      ) : null}

      {state === "rejected" ? <Banner tone="warning">{t("detail.fixAndResend")}</Banner> : null}

      {state === "delivered" || state === "not_delivered" ? (
        <div className="flex flex-wrap gap-3">
          {record.paymentFlag !== "paid" ? (
            <Button
              onClick={() =>
                document.getElementById("inv-paid")?.scrollIntoView({ behavior: "smooth" })
              }
            >
              {t("detail.markPaid")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {attempts.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">{t("detail.attempts")}</h3>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {attempts.map((a) => (
              <li key={a.id}>
                {t("detail.attempt", {
                  n: a.attempt,
                  file: a.fileName,
                  outcome: t(`detail.outcome.${a.outcome}`),
                  channel: t(`detail.channel.${a.channel}`),
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <SendSheet
        invoiceId={record.id}
        open={sendOpen}
        onOpenChange={setSendOpen}
        summary={{ client: clientName, number: record.number ?? "", total: totalLabel }}
        onSent={() => {
          setSendOpen(false);
          void refresh();
        }}
      />
    </section>
  );
}
