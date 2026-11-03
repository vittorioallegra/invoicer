import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface DisclosureProps {
  /** Unique id prefix for the button and the panel. */
  id: string;
  title: ReactNode;
  /** One line shown under the title while the panel is closed. */
  summary?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/**
 * A collapsible section in one bordered box: a heading with a full-width button (aria-expanded)
 * and, when open, the panel inside the same border.
 */
export function Disclosure({ id, title, summary, open, onToggle, children }: DisclosureProps) {
  const panelId = `${id}-panel`;
  return (
    <section className="rounded-card border border-border">
      <h2 className="text-base font-medium">
        <button
          type="button"
          id={`${id}-button`}
          aria-expanded={open}
          {...(open ? { "aria-controls": panelId } : {})}
          onClick={onToggle}
          className="flex min-h-11 w-full items-center justify-between gap-3 rounded-card px-4 py-3 text-start"
        >
          <span className="min-w-0">
            <span className="block">{title}</span>
            {!open && summary ? (
              <span className="block break-words text-sm font-normal text-muted-foreground">
                {summary}
              </span>
            ) : null}
          </span>
          <ChevronDown
            aria-hidden
            className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")}
          />
        </button>
      </h2>
      {open ? (
        <div id={panelId} className="flex flex-col gap-4 border-t border-border p-4">
          {children}
        </div>
      ) : null}
    </section>
  );
}
