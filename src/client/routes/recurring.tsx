import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDate, formatMoney, type UiLocale } from "../../shared/format";
import {
  MAX_RECURRING_LEAD_DAYS,
  type RecurringList,
  type RecurringTemplateRecord,
} from "../../shared/recurring";
import { Page } from "../components/page";
import { RecurringScheduleFields } from "../components/recurring-schedule-fields";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Sheet, SheetFooter } from "../components/ui/sheet";
import { ListSkeleton } from "../components/ui/skeleton";
import { toast } from "../components/ui/toast";
import { SETTINGS_BACK } from "../lib/back-links";
import { useOnline } from "../lib/online";
import {
  deleteRecurring,
  formToSchedule,
  pauseRecurring,
  recurringQuery,
  type ScheduleForm,
  saveRecurringLeadDays,
  scheduleToForm,
  updateRecurring,
} from "../lib/recurring-api";
import { useDirty } from "../lib/use-dirty";

/** Replaces the cached list with the one a change answered. */
function useListUpdate() {
  const queryClient = useQueryClient();
  return (list: RecurringList) => queryClient.setQueryData(recurringQuery.queryKey, list);
}

function EditSheet({
  template,
  onClose,
}: {
  template: RecurringTemplateRecord;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const update = useListUpdate();
  const initial = scheduleToForm(template);
  const [form, setForm] = useState<ScheduleForm>(initial);
  const { dirty } = useDirty(initial, form);
  const schedule = formToSchedule(form);
  const save = useMutation({
    mutationFn: () => {
      if (!schedule) throw new Error("invalid_schedule");
      return updateRecurring(template.id, schedule);
    },
    onSuccess: (list) => {
      update(list);
      toast.success(t("recurring.saved"));
      onClose();
    },
    onError: () => toast.error(t("recurring.saveFailed")),
  });
  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      side="responsive"
      title={t("recurring.edit.title", { client: template.clientName ?? "" })}
      description={t("recurring.edit.body")}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (schedule) save.mutate();
        }}
      >
        <RecurringScheduleFields form={form} onChange={setForm} />
        {schedule ? null : (
          <p role="alert" className="text-sm text-danger">
            {t("recurring.invalid")}
          </p>
        )}
        <SheetFooter>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!dirty || !schedule || save.isPending}>
            {t("recurring.edit.save")}
          </Button>
        </SheetFooter>
      </form>
    </Sheet>
  );
}

function DeleteSheet({
  template,
  onClose,
}: {
  template: RecurringTemplateRecord;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const update = useListUpdate();
  const remove = useMutation({
    mutationFn: () => deleteRecurring(template.id),
    onSuccess: (list) => {
      update(list);
      toast.success(t("recurring.deleted"));
      onClose();
    },
    onError: () => toast.error(t("common.error")),
  });
  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      side="responsive"
      title={t("recurring.delete.title")}
      description={t("recurring.delete.body", { client: template.clientName ?? "" })}
    >
      <SheetFooter>
        <Button variant="secondary" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {t("recurring.delete.confirm")}
        </Button>
      </SheetFooter>
    </Sheet>
  );
}

function TemplateCard({
  template,
  online,
  locale,
  onEdit,
  onDelete,
}: {
  template: RecurringTemplateRecord;
  online: boolean;
  locale: UiLocale;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const update = useListUpdate();
  const pause = useMutation({
    mutationFn: () => pauseRecurring(template.id, !template.paused),
    onSuccess: update,
    onError: () => toast.error(t("common.error")),
  });
  const finished = template.nextDate === null;
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">{template.clientName ?? "-"}</p>
        {template.totalCents !== null ? (
          <p className="tabular-nums">
            {formatMoney(template.totalCents, locale, template.currency)}
          </p>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {t("recurring.cadence", { count: template.intervalMonths, day: template.dayOfMonth })}
        {template.endDate
          ? ` · ${t("recurring.until", { date: formatDate(template.endDate, locale) })}`
          : ""}
        {template.maxCount ? ` · ${t("recurring.limit", { count: template.maxCount })}` : ""}
      </p>
      <p className="text-sm text-muted-foreground">
        {template.paused
          ? t("recurring.paused")
          : finished
            ? t("recurring.finished")
            : t("recurring.next", { date: formatDate(template.nextDate as string, locale) })}
        {" · "}
        {t("recurring.createdCount", { count: template.createdCount })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={!online} onClick={onEdit}>
          {t("recurring.actions.edit")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!online || pause.isPending}
          onClick={() => pause.mutate()}
        >
          {template.paused ? t("recurring.actions.resume") : t("recurring.actions.pause")}
        </Button>
        <Button size="sm" variant="ghost" disabled={!online} onClick={onDelete}>
          {t("recurring.actions.delete")}
        </Button>
      </div>
    </li>
  );
}

function LeadDays({ days, online }: { days: number; online: boolean }) {
  const { t } = useTranslation();
  const update = useListUpdate();
  const [value, setValue] = useState(String(days));
  const { dirty, markSaved } = useDirty(String(days), value);
  useEffect(() => {
    setValue(String(days));
    markSaved(String(days));
  }, [days, markSaved]);
  const n = Number(value);
  const valid =
    value.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= MAX_RECURRING_LEAD_DAYS;
  const save = useMutation({
    mutationFn: () => saveRecurringLeadDays(n),
    onSuccess: (list) => {
      update(list);
      markSaved(String(n));
      toast.success(t("recurring.lead.saved"));
    },
    onError: () => toast.error(t("common.error")),
  });
  return (
    <form
      className="flex max-w-sm flex-wrap items-end gap-3"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (valid) save.mutate();
      }}
    >
      <div className="min-w-0 flex-1">
        <Field
          label={t("recurring.lead.label")}
          hint={t("recurring.lead.hint", { max: MAX_RECURRING_LEAD_DAYS })}
        >
          {(c) => (
            <Input
              {...c}
              inputMode="numeric"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </Field>
      </div>
      <Button type="submit" disabled={!online || !dirty || !valid || save.isPending}>
        {t("recurring.lead.save")}
      </Button>
    </form>
  );
}

/** Recurring templates: when each repeats, what is next, pause, edit the schedule, delete. */
export function RecurringPage() {
  const { t, i18n } = useTranslation();
  const online = useOnline();
  const locale: UiLocale = i18n.language.startsWith("it") ? "it" : "en";
  const query = useQuery(recurringQuery);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const templates = query.data?.templates ?? [];
  const editTemplate = templates.find((template) => template.id === editing);
  const deleteTemplate = templates.find((template) => template.id === deleting);

  return (
    <Page title={t("recurring.title")} back={SETTINGS_BACK}>
      <div className="max-w-2xl space-y-6">
        <p className="text-sm text-muted-foreground">{t("recurring.intro")}</p>
        {!online ? <Banner tone="warning">{t("offline.reason")}</Banner> : null}
        {query.isPending ? <ListSkeleton /> : null}
        {query.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
        {query.data && templates.length === 0 ? (
          <EmptyState title={t("recurring.emptyTitle")} description={t("recurring.emptyBody")} />
        ) : null}
        {templates.length > 0 ? (
          <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
            {templates.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                online={online}
                locale={locale}
                onEdit={() => setEditing(template.id)}
                onDelete={() => setDeleting(template.id)}
              />
            ))}
          </ul>
        ) : null}
        {query.data ? <LeadDays days={query.data.leadDays} online={online} /> : null}
      </div>
      {editTemplate ? <EditSheet template={editTemplate} onClose={() => setEditing(null)} /> : null}
      {deleteTemplate ? (
        <DeleteSheet template={deleteTemplate} onClose={() => setDeleting(null)} />
      ) : null}
    </Page>
  );
}
