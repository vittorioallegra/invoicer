import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleCheck, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../shared/errors";
import { describeXsdErrors } from "../lib/fatturapa-errors";
import type { FinalizeProblem } from "../lib/finalize-checks";
import {
  MANUAL_STEPS,
  runSendFlow,
  SEND_STEPS,
  type SendChannel,
  SendFlowError,
  type SendStep,
} from "../lib/send-flow";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { Sheet } from "./ui/sheet";

/** What `preflight` of a finalize sheet decides: stop with the problems, or go on with the invoice. */
export type Preflight =
  | { ok: true; invoiceId: string }
  | { ok: false; problems: FinalizeProblem[] };

export interface SendSheetProps {
  /** The invoice to send; with `preflight` it is the one the preflight returns. */
  invoiceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** One line for the review: who it goes to and the amount due. */
  summary: { client: string; total: string; number: string };
  onSent: (invoiceId: string) => void;
  /** Called with the failure of a send, so the page can react (for example a taken number). */
  onError?: (error: unknown) => void;
  /** `manual` (finalize only) stores the files for the AdE portal instead of sending by PEC. */
  channel?: SendChannel;
  /**
   * Turns the sheet into the Finalize dialog: the checks run first (and the editor saves what is
   * on screen), and only when none fails the send flow goes on. A failure lists the problems and
   * nothing else happens.
   */
  preflight?: () => Promise<Preflight>;
  /** Called when the owner picks a problem of the list (to move the focus to its field). */
  onProblem?: (problem: FinalizeProblem) => void;
}

/** Review screen and progress of a send: the owner confirms once, the flow runs its steps. */
export function SendSheet({
  invoiceId,
  open,
  onOpenChange,
  summary,
  onSent,
  onError,
  channel = "pec",
  preflight,
  onProblem,
}: SendSheetProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<SendStep | null>(null);
  const [totp, setTotp] = useState("");
  const [useTotp, setUseTotp] = useState(false);
  const [problems, setProblems] = useState<FinalizeProblem[]>([]);
  const finalizing = preflight !== undefined;
  const current = useRef<string | null>(invoiceId);

  const run = useMutation({
    mutationFn: async () => {
      let id = invoiceId;
      if (preflight) {
        setProblems([]);
        setStep("validate");
        const checked = await preflight();
        if (!checked.ok) {
          setProblems(checked.problems);
          return null;
        }
        id = checked.invoiceId;
      }
      if (!id) throw new SendFlowError("missing_data");
      current.current = id;
      await runSendFlow(
        id,
        {
          onStep: setStep,
          chooseAuthorization: async () =>
            useTotp && /^\d{6}$/.test(totp) ? { kind: "totp", code: totp } : { kind: "passkey" },
        },
        channel,
      );
      return id;
    },
    onSettled: async () => {
      setStep(null);
      const id = current.current;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["invoices"] }),
        queryClient.invalidateQueries({ queryKey: ["invoice", id] }),
        queryClient.invalidateQueries({ queryKey: ["transmissions", id] }),
      ]);
    },
    onSuccess: (id) => {
      if (id) onSent(id);
    },
    onError: (failure) => onError?.(failure),
  });

  const error = run.error;
  const busy = run.isPending;
  const manual = channel === "manual";
  const steps = manual ? SEND_STEPS.filter((s) => MANUAL_STEPS.includes(s)) : SEND_STEPS;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={t(finalizing ? "finalize.title" : "send.title")}
      description={
        finalizing
          ? t(manual ? "finalize.reviewManual" : "finalize.reviewPec")
          : t(`send.review${summary.number ? "Reserved" : "New"}`, summary)
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("send.client")}</dt>
        <dd>{summary.client}</dd>
        <dt className="text-muted-foreground">{t("send.amountDue")}</dt>
        <dd className="font-medium">{summary.total}</dd>
      </dl>

      {busy ? (
        <ol className="space-y-1 text-sm" aria-label={t("send.progress")}>
          {steps.map((s) => {
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

      {!busy && problems.length > 0 ? (
        <Banner tone="danger">
          <p className="font-medium">{t("finalize.problems")}</p>
          <ul className="list-disc pl-5">
            {problems.map((problem) => (
              <li key={problem.key}>
                {problem.to ? (
                  <Link to={problem.to} className="font-medium underline">
                    {problem.label}
                  </Link>
                ) : problem.field ? (
                  <button
                    type="button"
                    className="min-h-8 text-left font-medium underline"
                    onClick={() => onProblem?.(problem)}
                  >
                    {problem.label}
                  </button>
                ) : (
                  <span className="font-medium">{problem.label}</span>
                )}
                {problem.message ? `: ${problem.message}` : null}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}

      {error ? <SendError error={error} /> : null}

      {!busy && manual ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => run.mutate()}>{t("finalize.confirmManual")}</Button>
          </div>
          <p className="text-sm text-muted-foreground">{t("finalize.manualNote")}</p>
        </>
      ) : null}

      {!busy && !manual ? (
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
              {t(
                finalizing
                  ? useTotp
                    ? "finalize.confirmTotp"
                    : "finalize.confirm"
                  : useTotp
                    ? "send.confirmTotp"
                    : "send.confirm",
              )}
            </Button>
            <Button variant="ghost" onClick={() => setUseTotp(!useTotp)}>
              {t(useTotp ? "send.usePasskey" : "send.useTotp")}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {t(finalizing ? "finalize.confirmNote" : "send.confirmNote")}
          </p>
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
