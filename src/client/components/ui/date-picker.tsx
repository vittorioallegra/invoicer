import * as Popover from "@radix-ui/react-popover";
import { CalendarDays } from "lucide-react";
import { type ChangeEvent, type InputHTMLAttributes, type Ref, useState } from "react";
import { DayPicker } from "react-day-picker";
import { enIE } from "react-day-picker/locale/en-IE";
import { it } from "react-day-picker/locale/it";
import { useTranslation } from "react-i18next";
import { romeDateTime } from "../../../shared/cron";
import { formatDate, type UiLocale } from "../../../shared/format";
import { useNativeControls } from "../../lib/use-native-controls";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Input } from "./input";

export interface DatePickerProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> {
  ref?: Ref<HTMLInputElement>;
  /** `YYYY-MM-DD` on the Europe/Rome calendar, or empty. */
  value: string;
  /** Called with an event-like `{ target: { value } }`, as `Input` does; the value is `YYYY-MM-DD` or empty. */
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar date at local noon, so the day never shifts with the time zone or DST. */
function toDate(value: string): Date | undefined {
  const m = ISO.exec(value);
  if (!m) return undefined;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function toIso(date: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${p(date.getFullYear(), 4)}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

const box =
  "min-h-11 w-full min-w-0 rounded-control border border-border bg-surface px-3 py-2 text-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger";

const calendarClasses = {
  root: "text-foreground",
  months: "relative flex flex-col",
  month_caption: "flex h-9 items-center justify-center text-sm font-medium capitalize",
  nav: "absolute inset-x-0 top-0 flex h-9 items-center justify-between",
  button_previous:
    "flex size-9 items-center justify-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground",
  button_next:
    "flex size-9 items-center justify-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground",
  chevron: "size-4 fill-current",
  month_grid: "mt-1 border-collapse",
  weekday: "size-10 text-center text-xs font-normal capitalize text-muted-foreground",
  day: "p-0 text-center text-sm",
  day_button:
    "flex size-10 items-center justify-center rounded-control hover:bg-muted [&:disabled]:pointer-events-none",
  selected: "[&>button]:bg-primary [&>button]:text-primary-foreground [&>button:hover]:bg-primary",
  today: "[&>button]:border [&>button]:border-primary",
  outside: "opacity-50",
  disabled: "opacity-40",
};

/**
 * Date field with the box of `Input`. Touch-first devices (phones) get the native date input;
 * pointer devices get a button that opens a calendar popover with Today and Clear actions.
 * The value is always a `YYYY-MM-DD` string.
 */
export function DatePicker(props: DatePickerProps) {
  const native = useNativeControls();
  return native ? <NativeDate {...props} /> : <PopoverDate {...props} />;
}

function NativeDate({ ref, ...props }: DatePickerProps) {
  return <Input ref={ref} type="date" {...props} />;
}

function PopoverDate({
  className,
  ref: _ref,
  value,
  onChange,
  disabled,
  readOnly,
  id,
  name,
  required,
  onBlur,
  ...aria
}: DatePickerProps) {
  const { t, i18n } = useTranslation();
  const locale: UiLocale = i18n.language.startsWith("it") ? "it" : "en";
  const [open, setOpen] = useState(false);
  const selected = toDate(value);
  const emit = (next: string) => {
    const target = { value: next, name: name ?? "" };
    onChange?.({ target, currentTarget: target } as unknown as ChangeEvent<HTMLInputElement>);
  };
  const today = romeDateTime(new Date()).date;
  const label = selected ? formatDate(value, locale) : "";
  return (
    <Popover.Root open={open && !disabled && !readOnly} onOpenChange={setOpen}>
      <Popover.Trigger
        id={id}
        type="button"
        disabled={disabled}
        aria-readonly={readOnly || undefined}
        aria-label={aria["aria-label"]}
        aria-labelledby={aria["aria-labelledby"]}
        aria-describedby={aria["aria-describedby"]}
        aria-invalid={aria["aria-invalid"]}
        {...(onBlur ? { onBlur: onBlur as never } : {})}
        className={cn(
          "relative flex items-center pr-9 text-left",
          box,
          readOnly ? "cursor-default" : null,
          className,
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate", label ? null : "text-muted-foreground")}>
          {label || " "}
        </span>
        <CalendarDays
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
      </Popover.Trigger>
      {name !== undefined ? <input type="hidden" name={name} value={value} /> : null}
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="z-[60] rounded-card border border-border bg-surface p-3 text-foreground shadow-lg"
        >
          <DayPicker
            mode="single"
            {...(selected ? { selected } : {})}
            defaultMonth={selected ?? toDate(today) ?? new Date()}
            {...(toDate(today) ? { today: toDate(today) as Date } : {})}
            locale={locale === "it" ? it : enIE}
            weekStartsOn={1}
            classNames={calendarClasses}
            onSelect={(date) => {
              if (!date) return setOpen(false);
              emit(toIso(date));
              setOpen(false);
            }}
          />
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                emit(today);
                setOpen(false);
              }}
            >
              {t("common.today")}
            </Button>
            {required ? null : (
              <Button
                variant="secondary"
                size="sm"
                disabled={value === ""}
                onClick={() => {
                  emit("");
                  setOpen(false);
                }}
              >
                {t("common.clear")}
              </Button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
