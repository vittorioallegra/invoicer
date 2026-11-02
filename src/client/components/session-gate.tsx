import { Navigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../lib/auth-client";
import { AuthLayout } from "./auth-layout";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";

/** Renders its children only with a valid session; otherwise goes to the login screen. */
export function SessionGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { data, isPending, error, refetch } = authClient.useSession();
  if (isPending) {
    return (
      <AuthLayout title={t("common.loading")}>
        <div role="status" aria-label={t("common.loading")} />
      </AuthLayout>
    );
  }
  // A network failure is not "signed out": offer a retry instead of bouncing to the login.
  if (error && error.status !== 401) {
    return (
      <AuthLayout title={t("auth.sessionError")}>
        <Banner
          tone="warning"
          action={
            <Button size="sm" variant="secondary" onClick={() => void refetch()}>
              {t("common.retry")}
            </Button>
          }
        >
          {t("auth.sessionErrorBody")}
        </Banner>
      </AuthLayout>
    );
  }
  if (!data) return <Navigate to="/login" replace />;
  return children;
}
