import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { buttonVariants } from "./ui/button";

/** The "New invoice" button (sidebar, and the Invoices title row on phones). */
export function NewInvoiceLink({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Link to="/invoices/new" className={cn(buttonVariants(), className)}>
      <Plus aria-hidden />
      {t("nav.newInvoice")}
    </Link>
  );
}
