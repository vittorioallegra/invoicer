import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { romeDateTime } from "../../shared/cron";
import { createRecurring, formToSchedule, newScheduleForm } from "../lib/recurring-api";
import { RecurringScheduleFields } from "./recurring-schedule-fields";
import { Button } from "./ui/button";
import { Sheet, SheetFooter } from "./ui/sheet";
import { toast } from "./ui/toast";

/**
 * "Repeat" on an invoice: asks for the schedule and creates a recurring template from the
 * invoice's client, settings and lines. The invoices it makes later are normal unsent ones.
 */
export function RecurringSheet({
  invoiceId,
  open,
  onOpenChange,
}: {
  invoiceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState(() => newScheduleForm(romeDateTime(new Date()).date));
  const schedule = formToSchedule(form);
  const create = useMutation({
    mutationFn: () => {
      if (!schedule) throw new Error("invalid_schedule");
      return createRecurring(invoiceId, schedule);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["recurring"] });
      onOpenChange(false);
      toast.success(t("recurring.created"));
      void navigate({ to: "/recurring" });
    },
    onError: () => toast.error(t("recurring.createFailed")),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="responsive"
      title={t("recurring.sheet.title")}
      description={t("recurring.sheet.body")}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (schedule) create.mutate();
        }}
      >
        <RecurringScheduleFields form={form} onChange={setForm} />
        {schedule ? null : (
          <p role="alert" className="text-sm text-danger">
            {t("recurring.invalid")}
          </p>
        )}
        <SheetFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!schedule || create.isPending}>
            {t("recurring.sheet.create")}
          </Button>
        </SheetFooter>
      </form>
    </Sheet>
  );
}
