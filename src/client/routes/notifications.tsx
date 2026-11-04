import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bell, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MAILBOX_NOTIFICATION_TYPES } from "../../shared/notifications";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { Button, buttonVariants } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { ListSkeleton } from "../components/ui/skeleton";
import {
  markNotificationsRead,
  type NotificationItem,
  notificationsQuery,
} from "../lib/notifications-api";
import { cn } from "../lib/utils";

function Item({ item, onOpen }: { item: NotificationItem; onOpen: () => void }) {
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
          {t(`notifications.${item.type}.body`, { ...item.params, defaultValue: "" })}
        </span>
        <span className="block text-xs text-muted-foreground">{when}</span>
      </span>
    </>
  );
  const row = "flex items-start gap-3 px-4 py-3";
  // The courtesy email offer opens its invoice, where the Review and send / Skip card lives.
  if (item.invoiceId) {
    return (
      <Link
        to="/invoices/$invoiceId"
        params={{ invoiceId: item.invoiceId }}
        onClick={onOpen}
        className={cn(row, "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none")}
      >
        {content}
      </Link>
    );
  }
  if (item.type === "received_invoice") {
    return (
      <Link
        to="/received"
        onClick={onOpen}
        className={cn(row, "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none")}
      >
        {content}
      </Link>
    );
  }
  // A mailbox problem is fixed in the PEC settings.
  if (MAILBOX_NOTIFICATION_TYPES.includes(item.type)) {
    return (
      <Link
        to="/settings/pec"
        onClick={onOpen}
        className={cn(row, "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none")}
      >
        {content}
      </Link>
    );
  }
  return <div className={row}>{content}</div>;
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
  const data = query.data;
  return (
    <Page
      title={t("notificationsPage.title")}
      aside={
        <>
          {data && data.unread > 0 ? (
            <Button
              variant="secondary"
              disabled={read.isPending}
              onClick={() => read.mutate(undefined)}
            >
              {t("notificationsPage.markAllRead")}
            </Button>
          ) : null}
          <Link
            to="/settings/notifications"
            className={buttonVariants({ variant: "ghost", size: "icon" })}
            aria-label={t("notificationsPage.settingsLink")}
          >
            <Settings aria-hidden />
          </Link>
        </>
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
              />
            </li>
          ))}
        </ul>
      ) : null}
    </Page>
  );
}
