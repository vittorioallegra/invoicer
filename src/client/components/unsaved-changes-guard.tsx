import { useBlocker } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Sheet, SheetFooter } from "./ui/sheet";

/**
 * Asks before leaving a page with unsaved edits: in-app navigation shows a dialog (stay / leave
 * without saving), closing or reloading the tab shows the browser's own prompt. `shouldBlock` is
 * read at navigation time, so it can look at refs and the latest state.
 */
export function UnsavedChangesGuard({ shouldBlock }: { shouldBlock: () => boolean }) {
  const { t } = useTranslation();
  const blocker = useBlocker({
    shouldBlockFn: () => shouldBlock(),
    enableBeforeUnload: () => shouldBlock(),
    withResolver: true,
  });
  const open = blocker.status === "blocked";
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && open) blocker.reset();
      }}
      side="responsive"
      title={t("unsaved.title")}
      description={t("unsaved.body")}
    >
      <SheetFooter>
        <Button variant="secondary" onClick={() => blocker.reset?.()}>
          {t("unsaved.stay")}
        </Button>
        <Button variant="destructive" onClick={() => blocker.proceed?.()}>
          {t("unsaved.leave")}
        </Button>
      </SheetFooter>
    </Sheet>
  );
}
