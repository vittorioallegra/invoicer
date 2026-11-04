import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../shared/errors";
import type { InvoiceRecord } from "../../shared/invoice";
import {
  type CourtesyLogEntry,
  courtesyEmailQuery,
  sendCourtesyEmail,
  skipCourtesyEmail,
} from "../lib/courtesy-email-api";
import { useOnline } from "../lib/online";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { Sheet, SheetFooter } from "./ui/sheet";
import { Textarea } from "./ui/textarea";
import { toast } from "./ui/toast";

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Whether an invoice can have a courtesy email: issued by the app, so it has a stored PDF. */
export function canSendCourtesyEmail(record: InvoiceRecord): boolean {
  return (
    record.source === "app" &&
    record.number !== null &&
    record.state !== "draft" &&
    record.state !== "planned"
  );
}

function Timeline({ log }: { log: CourtesyLogEntry[] }) {
  const { t, i18n } = useTranslation();
  const when = (ms: number) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(ms);
  return (
    <section aria-labelledby="courtesy-history" className="flex flex-col gap-2">
      <h2 id="courtesy-history" className="text-sm font-medium">
        {t("courtesy.history")}
      </h2>
      <ol className="flex flex-col gap-2 border-l border-border pl-4 text-sm">
        {log.map((entry) => (
          <li key={entry.id} className="flex flex-col">
            <span className={entry.status === "failed" ? "text-danger" : undefined}>
              {entry.status === "sent"
                ? t("courtesy.sentTo", { recipient: entry.recipient })
                : t("courtesy.failedTo", {
                    recipient: entry.recipient,
                    code: entry.error ?? "error",
                  })}
            </span>
            <span className="text-muted-foreground">
              {when(entry.at)}
              {entry.trigger ? ` · ${t(`courtesy.trigger.${entry.trigger}`)}` : ""}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The courtesy email of an issued invoice: the "ask" offer card (Review and send / Skip), the
 * `email_log` timeline, and the editable preview sheet shared by the offer and the manual
 * "Send email" action in the invoice menu. Nothing renders until there is something to show.
 */
export function CourtesyEmail({
  record,
  open,
  onOpenChange,
}: {
  record: InvoiceRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const query = useQuery(courtesyEmailQuery(record.id));
  const data = query.data;
  const [form, setForm] = useState({ to: "", subject: "", body: "" });
  const [requestId, setRequestId] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Each opening starts from the draft as the Worker composes it and gets a fresh request id.
  useEffect(() => {
    if (open && data?.draft) {
      setForm({ to: data.draft.to, subject: data.draft.subject, body: data.draft.body });
      setRequestId(crypto.randomUUID());
      setError(null);
    }
  }, [open, data?.draft]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["courtesy-email", record.id] }),
      queryClient.invalidateQueries({ queryKey: ["notifications"] }),
    ]);

  const send = useMutation({
    mutationFn: () =>
      sendCourtesyEmail(record.id, {
        requestId,
        ...form,
        ...(data?.ask ? { outboxId: data.ask.id } : {}),
      }),
    onSuccess: async () => {
      onOpenChange(false);
      toast.success(t("courtesy.sent"));
      await refresh();
    },
    onError: async (e) => {
      setError(
        t("courtesy.failed", {
          code: e instanceof ApiError ? (e.problem.detail ?? e.code) : "error",
        }),
      );
      await refresh();
    },
  });
  const skip = useMutation({
    mutationFn: (outboxId: string) => skipCourtesyEmail(record.id, outboxId),
    onSuccess: async () => {
      toast.success(t("courtesy.skipped"));
      await refresh();
    },
    onError: () => toast.error(t("common.error")),
  });

  const recipientOk = EMAIL.test(form.to.trim());
  const canSend =
    online &&
    recipientOk &&
    form.subject.trim() !== "" &&
    form.body.trim() !== "" &&
    data?.ready === true &&
    !send.isPending;
  const draft = data?.draft;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (canSend) send.mutate();
  }

  return (
    <>
      {data?.ask ? (
        <Banner
          tone="info"
          action={
            <div className="flex gap-2">
              <Button size="sm" disabled={!online} onClick={() => onOpenChange(true)}>
                {t("courtesy.review")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!online || skip.isPending}
                onClick={() => skip.mutate(data.ask?.id ?? "")}
              >
                {t("courtesy.skip")}
              </Button>
            </div>
          }
        >
          <p>{t("courtesy.askBody", { client: record.clientName ?? "" })}</p>
        </Banner>
      ) : null}
      {data && data.log.length > 0 ? <Timeline log={data.log} /> : null}

      <Sheet
        open={open}
        onOpenChange={onOpenChange}
        side="responsive"
        title={t("courtesy.sheetTitle")}
        description={t("courtesy.sheetBody")}
      >
        {query.isError || (data && !draft) ? (
          <Banner tone="danger">{t("courtesy.loadFailed")}</Banner>
        ) : null}
        {data && !data.ready ? <Banner tone="warning">{t("courtesy.notReady")}</Banner> : null}
        {draft ? (
          <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
            <Field
              label={t("courtesy.to")}
              {...(form.to.trim() === "" ? { hint: t("courtesy.noRecipient") } : {})}
            >
              {(c) => (
                <Input
                  {...c}
                  type="email"
                  value={form.to}
                  onChange={(e) => setForm({ ...form, to: e.target.value })}
                />
              )}
            </Field>
            <Field label={t("courtesy.subject")}>
              {(c) => (
                <Input
                  {...c}
                  value={form.subject}
                  onChange={(e) => setForm({ ...form, subject: e.target.value })}
                />
              )}
            </Field>
            <Field label={t("courtesy.body")}>
              {(c) => (
                <Textarea
                  {...c}
                  rows={10}
                  value={form.body}
                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                />
              )}
            </Field>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {draft.from ? (
                <>
                  <dt>{t("courtesy.from")}</dt>
                  <dd className="break-all">{draft.from}</dd>
                </>
              ) : null}
              {draft.replyTo ? (
                <>
                  <dt>{t("courtesy.replyTo")}</dt>
                  <dd className="break-all">{draft.replyTo}</dd>
                </>
              ) : null}
              {draft.bcc ? (
                <>
                  <dt>{t("courtesy.bcc")}</dt>
                  <dd className="break-all">{draft.bcc}</dd>
                </>
              ) : null}
              <dt>{t("courtesy.attachments")}</dt>
              <dd className="break-all">{draft.attachments.map((a) => a.filename).join(", ")}</dd>
            </dl>
            {error ? <Banner tone="danger">{error}</Banner> : null}
            <SheetFooter>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!canSend}>
                <Mail aria-hidden />
                {t(send.isPending ? "courtesy.sending" : "courtesy.send")}
              </Button>
            </SheetFooter>
          </form>
        ) : null}
      </Sheet>
    </>
  );
}
