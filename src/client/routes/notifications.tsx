import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bell, Settings, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveLocale } from "../../shared/format";
import { displayValues, MAILBOX_NOTIFICATION_TYPES } from "../../shared/notifications";
import { Page } from "../components/page";
import { SwipeRow } from "../components/swipe-row";
import { Banner } from "../components/ui/banner";
import { Button, buttonVariants } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { Sheet, SheetFooter } from "../components/ui/sheet";
import { ListSkeleton } from "../components/ui/skeleton";
import { toast } from "../components/ui/toast";
import {
  dismissAllNotifications,
  dismissNotification,
  markNotificationsRead,
  type NotificationItem,
  type NotificationsResponse,
  notificationsQuery,
} from "../lib/notifications-api";
import { cn } from "../lib/utils";

function Item({
  item,
  onOpen,
  onDelete,
}: {
  item: NotificationItem;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const unread = item.readAt === null;
  const when = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(item.createdAt);
  const content = (
    <>
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          unread ? "bg-primary" : "bg-transparent",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm", unread ? "font-semibold" : "font-medium")}>
          {t(`notifications.${item.type}.title`, { defaultValue: item.type })}
          {unread ? <span className="sr-only"> ({t("notificationsPage.unread")})</span> : null}
        </span>
        <span className="block text-sm text-muted-foreground">
          {t(`notifications.${item.type}.body`, {
            ...displayValues(item.params, resolveLocale([i18n.language])),
            defaultValue: "",
          })}
        </span>
        <span className="block text-xs text-muted-foreground">{when}</span>
      </span>
    </>
  );
  const row = "flex min-w-0 flex-1 items-start gap-3 px-4 py-3";
  const link = "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none";
  // The courtesy email offer opens its invoice, where the Review and send / Skip card lives.
  let main = <div className={row}>{content}</div>;
  if (item.invoiceId) {
    main = (
      <Link
        to="/invoices/$invoiceId"
        params={{ invoiceId: item.invoiceId }}
        onClick={onOpen}
        className={cn(row, link)}
      >
        {content}
      </Link>
    );
  } else if (item.type === "received_invoice") {
    main = (
      <Link to="/received" onClick={onOpen} className={cn(row, link)}>
        {content}
      </Link>
    );
  } else if (MAILBOX_NOTIFICATION_TYPES.includes(item.type)) {
    // A mailbox problem is fixed in the PEC settings.
    main = (
      <Link to="/settings/pec" onClick={onOpen} className={cn(row, link)}>
        {content}
      </Link>
    );
  }
  const label = t("notificationsPage.deleteOne");
  return (
    <SwipeRow onDelete={onDelete} label={t("notificationsPage.swipeDelete")}>
      <div className="flex items-stretch">
        {main}
        {/* Mouse and keyboard: a delete button; on phones it appears only when focused (the swipe is the touch way). */}
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          title={label}
          onClick={onDelete}
          className="my-auto mr-1 shrink-0 max-md:sr-only max-md:focus-visible:not-sr-only"
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
    </SwipeRow>
  );
}

/** The in-app notification list: newest first, unread marked, each linking to its invoice. */
export function NotificationsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery(notificationsQuery);
  const read = useMutation({
    mutationFn: (ids?: string[]) => markNotificationsRead(ids),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const [confirmAll, setConfirmAll] = useState(false);
  const remove = useMutation({
    mutationFn: (id: string) => dismissNotification(id),
    onMutate: async (id) => {
      // The row goes at once; the list is refetched when the call settles.
      await queryClient.cancelQueries({ queryKey: ["notifications"] });
      queryClient.setQueryData<NotificationsResponse>(["notifications"], (current) => {
        if (!current) return current;
        const gone = current.notifications.find((item) => item.id === id);
        return {
          unread: Math.max(0, current.unread - (gone && gone.readAt === null ? 1 : 0)),
          notifications: current.notifications.filter((item) => item.id !== id),
        };
      });
    },
    onError: () => toast(t("common.error"), { variant: "error" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const removeAll = useMutation({
    mutationFn: dismissAllNotifications,
    onSuccess: () => {
      setConfirmAll(false);
      toast(t("notificationsPage.deletedAll"), { variant: "success" });
    },
    onError: () => toast(t("common.error"), { variant: "error" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const data = query.data;
  return (
    <Page
      title={t("notificationsPage.title")}
      bell={false}
      titleEnd={
        <Link
          to="/settings/notifications"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label={t("notificationsPage.settingsLink")}
        >
          <Settings aria-hidden />
        </Link>
      }
      aside={
        data && data.notifications.length > 0 ? (
          <>
            {data.unread > 0 ? (
              <Button
                variant="secondary"
                disabled={read.isPending}
                onClick={() => read.mutate(undefined)}
              >
                {t("notificationsPage.markAllRead")}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => setConfirmAll(true)}>
              {t("notificationsPage.deleteAll")}
            </Button>
          </>
        ) : undefined
      }
    >
      {query.isPending ? <ListSkeleton /> : null}
      {query.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {data && data.notifications.length === 0 ? (
        <EmptyState
          icon={Bell}
          title={t("notificationsPage.emptyTitle")}
          description={t("notificationsPage.emptyBody")}
        />
      ) : null}
      {data && data.notifications.length > 0 ? (
        <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
          {data.notifications.map((item) => (
            <li key={item.id}>
              <Item
                item={item}
                onOpen={() => {
                  if (item.readAt === null) read.mutate([item.id]);
                }}
                onDelete={() => remove.mutate(item.id)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <Sheet
        open={confirmAll}
        onOpenChange={setConfirmAll}
        side="responsive"
        title={t("notificationsPage.deleteAllTitle")}
        description={t("notificationsPage.deleteAllBody")}
      >
        <SheetFooter>
          <Button variant="secondary" onClick={() => setConfirmAll(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={removeAll.isPending}
            onClick={() => removeAll.mutate()}
          >
            {t("notificationsPage.deleteAllConfirm")}
          </Button>
        </SheetFooter>
      </Sheet>
    </Page>
  );
}
