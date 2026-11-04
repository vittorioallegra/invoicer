import { useTranslation } from "react-i18next";
import { MAX_RECURRING_COUNT, RECURRING_INTERVALS } from "../../shared/recurring";
import type { ScheduleForm } from "../lib/recurring-api";
import { DatePicker } from "./ui/date-picker";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

/** The schedule of a recurring template: how often, which day, from when, until when. */
export function RecurringScheduleFields({
  form,
  onChange,
}: {
  form: ScheduleForm;
  onChange: (form: ScheduleForm) => void;
}) {
  const { t } = useTranslation();
  const set = (key: keyof ScheduleForm) => (event: { target: { value: string } }) =>
    onChange({ ...form, [key]: event.target.value });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t("recurring.fields.every")}>
        {(c) => (
          <Select {...c} value={form.intervalMonths} onChange={set("intervalMonths")}>
            {RECURRING_INTERVALS.map((months) => (
              <option key={months} value={months}>
                {t(`recurring.intervals.m${months}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t("recurring.fields.day")} hint={t("recurring.fields.dayHint")}>
        {(c) => (
          <Input {...c} inputMode="numeric" value={form.dayOfMonth} onChange={set("dayOfMonth")} />
        )}
      </Field>
      <Field label={t("recurring.fields.start")}>
        {(c) => <DatePicker {...c} value={form.startDate} onChange={set("startDate")} />}
      </Field>
      <Field label={t("recurring.fields.end")} hint={t("recurring.fields.optional")}>
        {(c) => <DatePicker {...c} value={form.endDate} onChange={set("endDate")} />}
      </Field>
      <Field
        label={t("recurring.fields.count")}
        hint={t("recurring.fields.countHint", { max: MAX_RECURRING_COUNT })}
      >
        {(c) => (
          <Input {...c} inputMode="numeric" value={form.maxCount} onChange={set("maxCount")} />
        )}
      </Field>
    </div>
  );
}
