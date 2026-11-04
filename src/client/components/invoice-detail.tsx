import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { InvoiceRecord } from "../../shared/invoice";
import { formatNumberWithYear } from "../../shared/numbering";
import { manualHandedOver, manualOutcome, transmissionsQuery } from "../lib/invoices-api";
import { useOnline } from "../lib/online";
import { SendError, SendSheet } from "./send-sheet";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { toast } from "./ui/toast";

export interface InvoiceDetailProps {
  record: InvoiceRecord;
  clientName: string;
  totalLabel: string;
}

/**
 * What a numbered invoice still waits for, with the action that follows: a send that was not
 * completed or whose outcome is unknown, the SdI outcome, the manual AdE channel. It renders
 * nothing once the invoice is delivered or not delivered.
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
    onError: () => toast.error(t("common.error")),
  });

  const attempts = info.data?.attempts ?? [];
  const latest = attempts.at(-1);
  const retry = info.data?.retry;
  const when = (ms: number) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(ms);
  const state = record.state;
  const manualSent = state === "sent" && latest?.channel === "manual";

  if (state !== "sending" && state !== "sent" && state !== "rejected") return null;

  return (
    <div className="flex flex-col gap-3">
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
              {retry && !retry.allowed && retry.reason === "awaiting_poll" ? (
                <p>{t("detail.awaitingPoll")}</p>
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
        </div>
      ) : null}

      {state === "rejected" ? <Banner tone="warning">{t("detail.fixAndResend")}</Banner> : null}

      <SendSheet
        invoiceId={record.id}
        open={sendOpen}
        onOpenChange={setSendOpen}
        summary={{
          client: clientName,
          number: record.number ? formatNumberWithYear(record.number, record.year) : "",
          total: totalLabel,
        }}
        onSent={() => {
          setSendOpen(false);
          void refresh();
        }}
      />
    </div>
  );
}
