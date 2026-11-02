import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

const TONES = {
  info: { classes: "bg-info-soft text-info border-info/30", icon: Info },
  success: { classes: "bg-success-soft text-success border-success/30", icon: CircleCheck },
  warning: { classes: "bg-warning-soft text-warning border-warning/30", icon: TriangleAlert },
  danger: { classes: "bg-danger-soft text-danger border-danger/30", icon: CircleX },
} as const;

export interface BannerProps {
  tone?: keyof typeof TONES;
  children: ReactNode;
  /** Optional action, e.g. a Button. */
  action?: ReactNode;
  className?: string;
}

/** Inline message with icon. Warnings and errors are announced (`role="alert"`). */
export function Banner({ tone = "info", children, action, className }: BannerProps) {
  const { classes, icon: Icon } = TONES[tone];
  return (
    <div
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 rounded-control border px-3 py-2.5 text-sm",
        classes,
        className,
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
