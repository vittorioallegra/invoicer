import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** Bare full-page layout (no app shell) for the login and setup screens. */
export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-8 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
      <main className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-1">
          <div className="text-sm font-medium text-muted-foreground">{t("app.name")}</div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        </div>
        {children}
      </main>
    </div>
  );
}
