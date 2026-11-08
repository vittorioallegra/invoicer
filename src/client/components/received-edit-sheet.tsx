import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../shared/errors";
import { receivedSummarySchema } from "../../shared/import";
import type { ReceivedInvoiceRecord } from "../../shared/received";
import { parseMoney } from "../../shared/totals";
import { centsToText } from "../lib/invoice-form";
import { useOnline } from "../lib/online";
import { updateReceived } from "../lib/received-api";
import { Button } from "./ui/button";
import { DatePicker } from "./ui/date-picker";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { Sheet, SheetFooter } from "./ui/sheet";
import { toast } from "./ui/toast";

interface EditForm {
  supplierName: string;
  supplierVat: string;
  number: string;
  issueDate: string;
  documentType: string;
  currency: string;
  total: string;
}

const toForm = (record: ReceivedInvoiceRecord): EditForm => ({
  supplierName: record.supplierName ?? "",
  supplierVat: record.supplierVat ?? "",
  number: record.number ?? "",
  issueDate: record.issueDate ?? "",
  documentType: record.documentType ?? "TD01",
  currency: record.currency,
  total: record.totalCents === null ? "" : centsToText(record.totalCents),
});

/**
 * Edit sheet of a received invoice's summary (the fields the lists show). The original file, when
 * there is one, is never touched. Validated with the same schema the Worker applies.
 */
export function ReceivedEditSheet({
  record,
  open,
  onOpenChange,
}: {
  record: ReceivedInvoiceRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<EditForm>(() => toForm(record));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: keyof EditForm) => (event: { target: { value: string } }) => {
    setErrors({});
    setForm((current) => ({ ...current, [key]: event.target.value }));
  };

  const save = useMutation({
    mutationFn: (body: unknown) => updateReceived(record.id, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["received"] });
      toast.success(t("invoice.saved"));
      onOpenChange(false);
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.problem.detail === "duplicate"
      ) {
        setErrors({ number: t("received.edit.duplicate") });
      } else {
        toast.error(t("common.error"));
      }
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    const cents = form.total.trim() === "" ? null : parseMoney(form.total);
    if (form.total.trim() !== "" && cents === null) found.total = t("validation.invalid_amount");
    const candidate = {
      supplierName: form.supplierName,
      supplierVat: form.supplierVat.trim() || null,
      number: form.number,
      issueDate: form.issueDate,
      documentType: form.documentType.trim().toUpperCase(),
      currency: form.currency.replaceAll(/\s+/g, "").toUpperCase(),
      totalCents: cents,
    };
    const parsed = receivedSummarySchema.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
        if (key !== "" && key !== "totalCents") found[key] ??= t("validation.invalid");
        else if (key === "totalCents") found.total ??= t("validation.invalid_amount");
      }
    }
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    save.mutate(candidate);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="responsive"
      title={t("received.edit.title")}
      description={t("received.edit.body")}
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field label={t("received.edit.supplierName")} error={errors.supplierName}>
          {(c) => <Input {...c} value={form.supplierName} onChange={set("supplierName")} />}
        </Field>
        <Field label={t("received.edit.supplierVat")} error={errors.supplierVat}>
          {(c) => <Input {...c} value={form.supplierVat} onChange={set("supplierVat")} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("received.edit.number")} error={errors.number}>
            {(c) => <Input {...c} value={form.number} onChange={set("number")} />}
          </Field>
          <Field label={t("received.edit.issueDate")} error={errors.issueDate}>
            {(c) => <DatePicker {...c} value={form.issueDate} onChange={set("issueDate")} />}
          </Field>
          <Field label={t("received.edit.documentType")} error={errors.documentType}>
            {(c) => (
              <Input
                {...c}
                value={form.documentType}
                maxLength={10}
                onChange={set("documentType")}
              />
            )}
          </Field>
          <Field label={t("received.edit.currency")} error={errors.currency}>
            {(c) => (
              <Input
                {...c}
                value={form.currency}
                maxLength={3}
                autoCapitalize="characters"
                onChange={set("currency")}
              />
            )}
          </Field>
        </div>
        <Field label={t("received.edit.total")} error={errors.total}>
          {(c) => <Input {...c} value={form.total} inputMode="decimal" onChange={set("total")} />}
        </Field>
        <SheetFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!online || save.isPending}>
            {t("invoice.actions.save")}
          </Button>
        </SheetFooter>
      </form>
    </Sheet>
  );
}
