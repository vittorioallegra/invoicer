import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../shared/errors";
import { describeXsdErrors } from "../lib/fatturapa-errors";
import { runSendFlow, SEND_STEPS, SendFlowError, type SendStep } from "../lib/send-flow";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { Sheet } from "./ui/sheet";

export interface SendSheetProps {
  invoiceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** One line for the review: who it goes to and the amount due. */
  summary: { client: string; total: string; number: string };
  onSent: () => void;
}

/** Review screen and progress of a send: the owner confirms once, the flow runs its steps. */
export function SendSheet({ invoiceId, open, onOpenChange, summary, onSent }: SendSheetProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<SendStep | null>(null);
  const [totp, setTotp] = useState("");
  const [useTotp, setUseTotp] = useState(false);

  const run = useMutation({
    mutationFn: () =>
      runSendFlow(invoiceId, {
        onStep: setStep,
        chooseAuthorization: async () =>
          useTotp && /^\d{6}$/.test(totp) ? { kind: "totp", code: totp } : { kind: "passkey" },
      }),
    onSettled: async () => {
      setStep(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["invoices"] }),
        queryClient.invalidateQueries({ queryKey: ["invoice", invoiceId] }),
        queryClient.invalidateQueries({ queryKey: ["transmissions", invoiceId] }),
      ]);
    },
    onSuccess: () => onSent(),
  });

  const error = run.error;
  const busy = run.isPending;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={t("send.title")}
      description={t("send.review", summary)}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("send.client")}</dt>
        <dd>{summary.client}</dd>
        <dt className="text-muted-foreground">{t("send.amountDue")}</dt>
        <dd className="font-medium">{summary.total}</dd>
      </dl>

      {busy ? (
        <ol className="space-y-1 text-sm" aria-label={t("send.progress")}>
          {SEND_STEPS.map((s) => {
            const done = step !== null && SEND_STEPS.indexOf(s) < SEND_STEPS.indexOf(step);
            return (
              <li key={s} className="flex items-center gap-2">
                {done ? (
                  <CircleCheck aria-hidden className="size-4 text-success" />
                ) : s === step ? (
                  <Loader2 aria-hidden className="size-4 animate-spin" />
                ) : (
                  <span aria-hidden className="size-4" />
                )}
                <span className={s === step ? "font-medium" : "text-muted-foreground"}>
                  {t(`send.steps.${s}`)}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}

      {error ? <SendError error={error} /> : null}

      {!busy ? (
        <>
          {useTotp ? (
            <Field label={t("send.totp")} hint={t("send.totpHint")} className="max-w-xs">
              {(c) => (
                <Input
                  {...c}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={totp}
                  onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))}
                />
              )}
            </Field>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => run.mutate()} disabled={useTotp && !/^\d{6}$/.test(totp)}>
              {t(useTotp ? "send.confirmTotp" : "send.confirm")}
            </Button>
            <Button variant="ghost" onClick={() => setUseTotp(!useTotp)}>
              {t(useTotp ? "send.usePasskey" : "send.useTotp")}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">{t("send.confirmNote")}</p>
        </>
      ) : null}
    </Sheet>
  );
}

/** Plain-language reason for a failed send, with what to do next. */
export function SendError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (error instanceof SendFlowError) {
    if (error.code === "invalid_xml") {
      const described = error.detail.mapped
        ? describeXsdErrors(t, error.detail.mapped)
        : { sentences: [], technical: [] };
      return (
        <Banner tone="danger">
          <p className="font-medium">{t("send.errors.invalid_xml")}</p>
          <ul className="list-disc pl-5">
            {described.sentences.map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
          {error.detail.released ? <p>{t("send.errors.numberReleased")}</p> : null}
          {error.detail.numberKept ? <p>{t("send.errors.numberKept")}</p> : null}
          {described.technical.length > 0 ? (
            <details>
              <summary>{t("fatturapa.technical")}</summary>
              <pre className="overflow-x-auto text-xs">{described.technical.join("\n")}</pre>
            </details>
          ) : null}
        </Banner>
      );
    }
    return <Banner tone="warning">{t(`send.errors.${error.code}`)}</Banner>;
  }
  if (error instanceof ApiError) {
    const key = `send.errors.${error.code}`;
    return (
      <Banner tone="danger">
        <p>{t(key, { defaultValue: t("common.error") })}</p>
        {error.code === "send_outcome_unknown" ? <p>{t("send.errors.unknownNote")}</p> : null}
      </Banner>
    );
  }
  return <Banner tone="danger">{t("common.error")}</Banner>;
}
