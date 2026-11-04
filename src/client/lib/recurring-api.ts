import {
  type RecurringList,
  type RecurringSchedule,
  recurringScheduleSchema,
} from "../../shared/recurring";
import { api } from "./api";
import { putJson } from "./settings-api";

export const recurringQuery = {
  queryKey: ["recurring"],
  queryFn: () => api<RecurringList>("/api/recurring"),
};

export const createRecurring = (invoiceId: string, schedule: RecurringSchedule) =>
  api<{ id: string }>("/api/recurring", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invoiceId, ...schedule }),
  });

export const updateRecurring = (id: string, schedule: RecurringSchedule) =>
  putJson<RecurringList>(`/api/recurring/${id}`, schedule);

export const pauseRecurring = (id: string, paused: boolean) =>
  putJson<RecurringList>(`/api/recurring/${id}/paused`, { paused });

export const deleteRecurring = (id: string) =>
  api<RecurringList>(`/api/recurring/${id}`, { method: "DELETE" });

export const saveRecurringLeadDays = (days: number) =>
  putJson<RecurringList>("/api/recurring/lead-days", { days });

/** The schedule fields as typed (text), before they are checked. */
export interface ScheduleForm {
  intervalMonths: string;
  dayOfMonth: string;
  startDate: string;
  endDate: string;
  maxCount: string;
}

export const scheduleToForm = (schedule: RecurringSchedule): ScheduleForm => ({
  intervalMonths: String(schedule.intervalMonths),
  dayOfMonth: String(schedule.dayOfMonth),
  startDate: schedule.startDate,
  endDate: schedule.endDate ?? "",
  maxCount: schedule.maxCount === null ? "" : String(schedule.maxCount),
});

/** A form for a new template: monthly on the day of `start`, from that date, without a limit. */
export const newScheduleForm = (start: string): ScheduleForm =>
  scheduleToForm({
    intervalMonths: 1,
    dayOfMonth: Number(start.slice(8, 10)),
    startDate: start,
    endDate: null,
    maxCount: null,
  });

/** The checked schedule, or null while a field is empty or invalid. */
export function formToSchedule(form: ScheduleForm): RecurringSchedule | null {
  const parsed = recurringScheduleSchema.safeParse({
    intervalMonths: Number(form.intervalMonths),
    dayOfMonth: form.dayOfMonth.trim() === "" ? Number.NaN : Number(form.dayOfMonth),
    startDate: form.startDate,
    endDate: form.endDate === "" ? null : form.endDate,
    maxCount: form.maxCount.trim() === "" ? null : Number(form.maxCount),
  });
  return parsed.success ? parsed.data : null;
}
