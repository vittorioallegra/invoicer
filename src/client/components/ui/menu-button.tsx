import { ChevronDown } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/utils";
import { buttonVariants } from "./button";

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  /** Called when the item is chosen (not for a disabled one). */
  onSelect: () => void;
  /** A disabled item stays focusable and shows `reason` under its label. */
  disabled?: boolean;
  reason?: string | undefined;
  /** Draws a separator above the item. */
  separated?: boolean;
}

export interface MenuButtonProps {
  label: ReactNode;
  icon?: ReactNode;
  items: MenuItem[];
  disabled?: boolean;
  variant?: "default" | "secondary" | "ghost";
  /** Only the icon shows (e.g. the "⋯" actions menu); the label stays as the accessible name. */
  iconOnly?: boolean;
  /** Receives the trigger button, e.g. to move the focus back to it. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * A button that opens a menu (WAI-ARIA menu button): arrow keys, Home and End move between the
 * items, Enter or Space chooses one, Escape and a click outside close it and Escape returns the
 * focus to the button. Built here because no menu library is a dependency.
 */
export function MenuButton({
  label,
  icon,
  items,
  disabled = false,
  variant = "secondary",
  iconOnly = false,
  triggerRef,
}: MenuButtonProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [pendingFocus, setPendingFocus] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open && pendingFocus !== null) {
      itemRefs.current[pendingFocus]?.focus();
      setPendingFocus(null);
    }
  }, [open, pendingFocus]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  };

  function onTriggerKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setPendingFocus(event.key === "ArrowDown" ? 0 : items.length - 1);
    }
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    const current = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    } else if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (next !== null) {
      event.preventDefault();
      itemRefs.current[next]?.focus();
    }
  }

  return (
    <div ref={root} className="relative">
      <button
        ref={(el) => {
          trigger.current = el;
          if (triggerRef) triggerRef.current = el;
        }}
        type="button"
        id={`${id}-trigger`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        disabled={disabled}
        className={buttonVariants({ variant, ...(iconOnly ? { size: "icon" } : {}) })}
        onClick={() => {
          setOpen((value) => !value);
          setPendingFocus(null);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        {icon}
        {iconOnly ? <span className="sr-only">{label}</span> : label}
        {iconOnly ? null : <ChevronDown aria-hidden />}
      </button>
      {open ? (
        <div
          id={`${id}-menu`}
          role="menu"
          aria-labelledby={`${id}-trigger`}
          className="absolute right-0 z-30 mt-1 flex min-w-56 max-w-[calc(100vw-2rem)] flex-col rounded-card border border-border bg-surface p-1 shadow-lg"
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => (
            <div
              key={item.key}
              role="none"
              className={cn(item.separated && "mt-1 border-t border-border pt-1")}
            >
              <button
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role="menuitem"
                aria-disabled={item.disabled || undefined}
                aria-describedby={
                  item.disabled && item.reason ? `${id}-${item.key}-reason` : undefined
                }
                className={cn(
                  "flex min-h-11 w-full flex-col items-start justify-center rounded-control px-3 py-2 text-start text-sm font-medium hover:bg-muted focus-visible:bg-muted",
                  item.disabled && "cursor-not-allowed opacity-60",
                )}
                onClick={() => {
                  if (item.disabled) return;
                  close(false);
                  item.onSelect();
                }}
              >
                <span className="flex items-center gap-2 [&_svg]:size-4">
                  {item.icon}
                  {item.label}
                </span>
                {item.disabled && item.reason ? (
                  <span
                    id={`${id}-${item.key}-reason`}
                    className="mt-0.5 text-xs font-normal text-muted-foreground"
                  >
                    {item.reason}
                  </span>
                ) : null}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
