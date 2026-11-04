import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { useTranslation } from "react-i18next";
import { notificationsQuery } from "../lib/notifications-api";
import { cn } from "../lib/utils";

/** Link to the notification list with the unread count (the same query keeps it fresh). */
export function NotificationsLink({ className }: { className?: string }) {
  const { t } = useTranslation();
  const unread = useQuery(notificationsQuery).data?.unread ?? 0;
  return (
    <Link
      to="/notifications"
      aria-label={
        unread > 0
          ? t("notificationsPage.linkUnread", { count: unread })
          : t("notificationsPage.title")
      }
      className={cn(
        "relative flex size-11 items-center justify-center rounded-control text-muted-foreground hover:bg-muted",
        className,
      )}
      activeProps={{ className: "bg-muted text-foreground", "aria-current": "page" }}
    >
      <Bell aria-hidden className="size-5" />
      {unread > 0 ? (
        <span
          aria-hidden
          className="absolute top-1 right-1 min-w-4 rounded-full bg-primary px-1 text-center text-[0.625rem] leading-4 font-semibold text-primary-foreground"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </Link>
  );
}
