import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { BackLink } from "../lib/back-links";
import { rememberedInvoiceFilters, rememberedReceivedFilters } from "../lib/list-memory";
import { cn } from "../lib/utils";
import { NotificationsLink } from "./notifications-link";
import { buttonVariants } from "./ui/button";

export function Page({
  title,
  subtitle,
  aside,
  children,
  back,
  titleEnd,
  bell = back === undefined,
}: {
  title: string;
  /** Under the title (for example a document number). */
  subtitle?: ReactNode;
  /** Right-aligned on the title row (for example the page actions). */
  aside?: ReactNode;
  children: ReactNode;
  /** A link above the title that leads back to where the user came from (see `back-links.ts`). */
  back?: BackLink;
  /** Fixed at the end of the title row at every width (for example a settings icon). */
  titleEnd?: ReactNode;
  /**
   * The notification bell that ends the title row on phones. Shown by default on top-level pages;
   * pages with a back link (settings sub-pages, invoices) and the notification list hide it.
   */
  bell?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-6">
      {back ? (
        back.to === "/invoices" ? (
          // The Invoices list comes back with the filters it had.
          <Link
            to="/invoices"
            search={rememberedInvoiceFilters()}
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-3 -mb-3 w-fit")}
          >
            <ChevronLeft aria-hidden />
            {t(back.labelKey)}
          </Link>
        ) : back.to === "/received" ? (
          <Link
            to="/received"
            search={rememberedReceivedFilters()}
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-3 -mb-3 w-fit")}
          >
            <ChevronLeft aria-hidden />
            {t(back.labelKey)}
          </Link>
        ) : (
          <Link
            to={back.to}
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-3 -mb-3 w-fit")}
          >
            <ChevronLeft aria-hidden />
            {t(back.labelKey)}
          </Link>
        )
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? (
            <p className="mt-1 text-lg font-medium tabular-nums text-muted-foreground">
              {subtitle}
            </p>
          ) : null}
        </div>
        {/* Phones: the bell ends the title row; the page actions wrap onto their own row. */}
        {bell ? <NotificationsLink className="-mt-1.5 -mr-2 shrink-0 md:hidden" /> : null}
        {titleEnd ? <div className="-mt-1.5 -mr-2 shrink-0">{titleEnd}</div> : null}
        {aside ? (
          <div className="flex w-full flex-wrap items-center gap-2 md:w-auto">{aside}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
