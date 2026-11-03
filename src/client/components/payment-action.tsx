import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleX } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { InvoiceRecord } from "../../shared/invoice";
import { patchInvoice } from "../lib/invoices-api";
import { useOnline } from "../lib/online";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { Sheet, SheetFooter } from "./ui/sheet";
import { toast } from "./ui/toast";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The payment action of a finalised invoice, for the title row: "Record payment" (a small dialog
 * with the payment date) while it is unpaid, "Undo payment" (after a confirmation) once it is paid.
 */
export function PaymentAction({ record, today }: { record: InvoiceRecord; today: string }) {
  const { t } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today);
  const paid = record.paymentFlag === "paid";

  const save = useMutation({
    mutationFn: () =>
      patchInvoice(
        record.id,
        paid ? { paymentFlag: "unpaid" } : { paymentFlag: "paid", paidDate: date },
      ),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      await queryClient.invalidateQueries({ queryKey: ["invoice", record.id] });
      toast.success(t(paid ? "invoice.paid.undone" : "invoice.paid.recorded"));
    },
    onError: () => toast.error(t("common.error")),
  });

  const valid = paid || DATE_ONLY.test(date);
  return (
    <>
      <Button
        variant="secondary"
        disabled={!online}
        title={online ? undefined : t("offline.reason")}
        onClick={() => {
          setDate(today);
          setOpen(true);
        }}
      >
        {paid ? <CircleX aria-hidden /> : <CircleCheck aria-hidden />}
        {t(paid ? "invoice.paid.undo" : "invoice.paid.record")}
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
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
              {(c) => (
                <Input {...c} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              )}
            </Field>
          )}
          <SheetFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>
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
    </>
  );
}
