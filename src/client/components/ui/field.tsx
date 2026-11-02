import * as Label from "@radix-ui/react-label";
import { type ReactNode, useId } from "react";
import { cn } from "../../lib/utils";

export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
}

export interface FieldProps {
  label: string;
  hint?: string;
  /** Inline validation message; shown with `role="alert"` and the invalid state. */
  error?: string | undefined;
  className?: string;
  /** Render the control with the generated id and aria attributes. */
  children: (control: FieldControlProps) => ReactNode;
}

/** Label + control + hint + error with correct ARIA wiring. */
export function Field({ label, hint, error, className, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label.Root htmlFor={id} className="text-sm font-medium">
        {label}
      </Label.Root>
      {children({
        id,
        "aria-describedby": describedBy || undefined,
        "aria-invalid": error ? true : undefined,
      })}
      {hint ? (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
