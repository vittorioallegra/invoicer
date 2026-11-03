import * as ToastPrimitive from "@radix-ui/react-toast";
import { CircleCheck, CircleX, Info, X } from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

export type ToastVariant = "default" | "success" | "error";

export interface ToastOptions {
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss; defaults to 4 s (7 s for errors). */
  duration?: number;
}

interface ToastItem {
  id: number;
  message: ReactNode;
  variant: ToastVariant;
  duration: number;
}

const DEFAULT_DURATION = 4000;
const ERROR_DURATION = 7000;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(next: ToastItem[]) {
  items = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Show a transient confirmation. Use for save/action feedback, never for page content. */
export function toast(message: ReactNode, options: ToastOptions = {}): number {
  const variant = options.variant ?? "default";
  const id = nextId++;
  const duration = options.duration ?? (variant === "error" ? ERROR_DURATION : DEFAULT_DURATION);
  emit([...items, { id, message, variant, duration }].slice(-3));
  return id;
}

toast.success = (message: ReactNode, options: Omit<ToastOptions, "variant"> = {}) =>
  toast(message, { ...options, variant: "success" });
toast.error = (message: ReactNode, options: Omit<ToastOptions, "variant"> = {}) =>
  toast(message, { ...options, variant: "error" });

export function dismissToast(id: number) {
  emit(items.filter((item) => item.id !== id));
}

export function useToast() {
  const current = useSyncExternalStore(subscribe, () => items);
  return { toasts: current, toast, dismiss: dismissToast };
}

const VARIANTS = {
  default: {
    classes: "border-border bg-surface text-foreground",
    icon: Info,
    iconClass: "text-info",
  },
  success: {
    classes: "border-success/30 bg-success-soft text-success",
    icon: CircleCheck,
    iconClass: "",
  },
  error: { classes: "border-danger/30 bg-danger-soft text-danger", icon: CircleX, iconClass: "" },
} as const;

/** Mount once in the app shell. Radix provides the aria-live region and swipe handling. */
export function Toaster() {
  const { t } = useTranslation();
  const { toasts, dismiss } = useToast();
  return (
    <ToastPrimitive.Provider
      swipeDirection="right"
      duration={DEFAULT_DURATION}
      label={t("toast.label")}
    >
      {toasts.map((item) => {
        const { classes, icon: Icon, iconClass } = VARIANTS[item.variant];
        return (
          <ToastPrimitive.Root
            key={item.id}
            type={item.variant === "error" ? "foreground" : "background"}
            duration={item.duration}
            onOpenChange={(open) => {
              if (!open) dismiss(item.id);
            }}
            className={cn(
              "pointer-events-auto flex items-start gap-3 rounded-control border px-3 py-2.5 text-sm shadow-lg",
              "data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)]",
              classes,
            )}
          >
            <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", iconClass)} />
            <ToastPrimitive.Description className="min-w-0 flex-1">
              {item.message}
            </ToastPrimitive.Description>
            <ToastPrimitive.Close
              aria-label={t("toast.close")}
              className="-m-1 inline-flex size-6 shrink-0 items-center justify-center rounded-control opacity-70 hover:opacity-100"
            >
              <X aria-hidden className="size-4" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}
      {/* Top-center on phones (never hidden by the tab bar or the editor's totals bar),
          bottom-right on desktop. */}
      <ToastPrimitive.Viewport
        className={cn(
          "pointer-events-none fixed inset-x-0 top-[calc(0.75rem+env(safe-area-inset-top))] z-50 mx-auto flex w-full max-w-sm list-none flex-col gap-2 px-4 outline-none",
          "md:inset-x-auto md:top-auto md:right-4 md:bottom-4 md:mx-0 md:w-96 md:max-w-none md:px-0",
        )}
      />
    </ToastPrimitive.Provider>
  );
}
