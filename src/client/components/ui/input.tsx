import type { InputHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "../../lib/utils";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
  /** Text shown inside the field at its end, such as a unit ("%"). */
  suffix?: ReactNode;
}

export function Input({ className, ref, suffix, ...props }: InputProps) {
  const input = (
    <input
      ref={ref}
      className={cn(
        "min-h-11 w-full rounded-control border border-border bg-surface px-3 py-2 text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger",
        suffix ? "pe-9" : null,
        className,
      )}
      {...props}
    />
  );
  if (!suffix) return input;
  return (
    <div className="relative">
      {input}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-muted-foreground"
      >
        {suffix}
      </span>
    </div>
  );
}
