import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { buttonVariants } from "./ui/button";

export function Page({
  title,
  children,
  backToSettings = false,
}: {
  title: string;
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
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
    </div>
  );
}
