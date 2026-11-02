import * as Dialog from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

const sheetVariants = cva("fixed z-50 flex flex-col gap-4 bg-surface p-4 shadow-xl outline-none", {
  variants: {
    side: {
      // Bottom sheet on iPhone: respects the home-indicator safe area.
      bottom:
        "inset-x-0 bottom-0 max-h-[90dvh] overflow-y-auto rounded-t-card border-t border-border pb-[calc(1rem+env(safe-area-inset-bottom))]",
      right: "inset-y-0 right-0 w-full max-w-md border-l border-border",
    },
  },
  defaultVariants: { side: "bottom" },
});

export interface SheetProps extends VariantProps<typeof sheetVariants> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}

/** Modal sheet built on Radix Dialog (focus trap, Escape, scroll lock). */
export function Sheet({ open, onOpenChange, title, description, side, children }: SheetProps) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-foreground/40" />
        <Dialog.Content className={cn(sheetVariants({ side }))}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="text-sm text-muted-foreground">
                  {description}
                </Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{title}</Dialog.Description>
              )}
            </div>
            <Dialog.Close
              aria-label={t("common.close")}
              className="flex size-11 shrink-0 items-center justify-center rounded-control hover:bg-muted"
            >
              <X aria-hidden className="size-5" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
