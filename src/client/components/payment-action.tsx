import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { InvoiceRecord } from "../../shared/invoice";
import { patchInvoice } from "../lib/invoices-api";
import { useOnline } from "../lib/online";
import { Button } from "./ui/button";
import { DatePicker } from "./ui/date-picker";
import { Field } from "./ui/field";
import { Sheet, SheetFooter } from "./ui/sheet";
import { toast } from "./ui/toast";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The payment dialog of a finalised invoice, opened from its actions menu: "Record payment" (the
 * payment date, today by default) while it is unpaid, "Undo payment" (a confirmation) once paid.
 */
export function PaymentDialog({
  record,
  today,
  open,
  onOpenChange,
}: {
  record: InvoiceRecord;
  today: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const [date, setDate] = useState(today);
  const paid = record.paymentFlag === "paid";

  useEffect(() => {
    if (open) setDate(today);
  }, [open, today]);

  const save = useMutation({
    mutationFn: () =>
      patchInvoice(
        record.id,
        paid ? { paymentFlag: "unpaid" } : { paymentFlag: "paid", paidDate: date },
      ),
    onSuccess: async () => {
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      await queryClient.invalidateQueries({ queryKey: ["invoice", record.id] });
      toast.success(t(paid ? "invoice.paid.undone" : "invoice.paid.recorded"));
    },
    onError: () => toast.error(t("common.error")),
  });

  const valid = paid || DATE_ONLY.test(date);
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="responsive"
      title={t(paid ? "invoice.paid.undoTitle" : "invoice.paid.recordTitle")}
      {...(paid ? { description: t("invoice.paid.undoBody") } : {})}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && online && !save.isPending) save.mutate();
        }}
      >
        {paid ? null : (
          <Field label={t("invoice.paid.date")} className="max-w-xs">
            {(c) => <DatePicker {...c} value={date} onChange={(e) => setDate(e.target.value)} />}
          </Field>
        )}
        <SheetFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant={paid ? "destructive" : "default"}
            disabled={!online || !valid || save.isPending}
          >
            {t(paid ? "invoice.paid.undoConfirm" : "invoice.paid.save")}
          </Button>
        </SheetFooter>
      </form>
    </Sheet>
  );
}
