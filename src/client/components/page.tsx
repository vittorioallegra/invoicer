import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { buttonVariants } from "./ui/button";

export function Page({
  title,
  aside,
  children,
  backToSettings = false,
}: {
  title: string;
  /** Right-aligned on the title row (for example a document number). */
  aside?: ReactNode;
  children: ReactNode;
  /** Settings sub-pages: show a "Settings" link above the title. */
  backToSettings?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-6">
      {backToSettings ? (
        <Link
          to="/settings"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-3 -mb-3 w-fit")}
        >
          <ChevronLeft aria-hidden />
          {t("pages.settings.title")}
        </Link>
      ) : null}
      {aside ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <div className="text-lg font-medium tabular-nums">{aside}</div>
        </div>
      ) : (
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      )}
      {children}
    </div>
  );
}
