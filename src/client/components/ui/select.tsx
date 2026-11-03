import { ChevronDown } from "lucide-react";
import type { Ref, SelectHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  ref?: Ref<HTMLSelectElement>;
}

/**
 * Native select (best on iPhone) with the same box as `Input`: `appearance-none` drops the
 * platform chrome (shorter, differently coloured in the dark theme) and a chevron replaces it.
 */
export function Select({ className, ref, ...props }: SelectProps) {
  return (
    <div className="relative w-full">
      <select
        ref={ref}
        className={cn(
          "block min-h-11 w-full appearance-none rounded-control border border-border bg-surface py-2 pr-9 pl-3 text-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger",
          className,
        )}
        {...props}
      />
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}
