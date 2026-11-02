import type { Ref, SelectHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  ref?: Ref<HTMLSelectElement>;
}

/** Native select (best on iPhone); same box as `Input`. */
export function Select({ className, ref, ...props }: SelectProps) {
  return (
    <select
      ref={ref}
      className={cn(
        "min-h-11 w-full rounded-control border border-border bg-surface px-3 py-2 text-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger",
        className,
      )}
      {...props}
    />
  );
}
