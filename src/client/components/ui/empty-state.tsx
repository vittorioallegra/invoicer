import type { ComponentType, ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface EmptyStateProps {
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

/** Empty list / first-run placeholder with an optional call to action. */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-card border border-dashed border-border px-6 py-12 text-center",
        className,
      )}
    >
      {Icon ? <Icon aria-hidden className="size-10 text-muted-foreground" /> : null}
      <h2 className="text-base font-semibold">{title}</h2>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
