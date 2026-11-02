import type { ChangeEvent, InputHTMLAttributes, Ref } from "react";
import { cn } from "../../lib/utils";
import { Input } from "./input";

export interface MoneyInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> {
  /** The text as typed (e.g. `1.040,00`). Parsing into cents belongs to the totals engine. */
  value: string;
  onValueChange: (value: string) => void;
  currency?: string;
  ref?: Ref<HTMLInputElement>;
}

const ALLOWED = /[^0-9.,\-\s]/g;

/** Decimal text input for amounts: numeric keyboard, right-aligned, currency suffix. */
export function MoneyInput({
  value,
  onValueChange,
  currency = "EUR",
  className,
  ref,
  ...props
}: MoneyInputProps) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onValueChange(event.target.value.replace(ALLOWED, ""));
  };
  return (
    <div className="relative">
      <Input
        ref={ref}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={handleChange}
        className={cn("pr-14 text-right tabular-nums", className)}
        {...props}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground"
      >
        {currency}
      </span>
    </div>
  );
}
