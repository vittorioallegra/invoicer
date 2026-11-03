import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { AuthLayout } from "./auth-layout";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";

/**
 * Renders its children only with a valid session; otherwise goes to the login screen, or to the
 * first-run setup while no owner account exists yet.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { data, isPending, error, refetch } = authClient.useSession();
  const anonymous = !isPending && !data && !(error && error.status !== 401);
  const setup = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => api<{ ownerExists: boolean }>("/api/setup/status"),
    enabled: anonymous,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  if (isPending || (anonymous && setup.isPending)) {
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
  if (!data) {
    // A failed status lookup falls back to the login screen, which stays the default.
    const firstRun = setup.data?.ownerExists === false;
    return <Navigate to={firstRun ? "/setup" : "/login"} replace />;
  }
  return children;
}
