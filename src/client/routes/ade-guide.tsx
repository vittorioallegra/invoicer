import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { useOnline } from "../lib/online";
import { putJson, settingsQuery } from "../lib/settings-api";

const STEPS = ["portal", "register", "conservazione"] as const;

/** Static guide: what to do on the AdE portal. Done is confirmed by hand and stored server-side. */
export function AdeGuidePage() {
  const { t } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const query = useQuery(settingsQuery);
  const mark = useMutation({
    mutationFn: (done: boolean) => putJson("/api/settings/ade-guide", { done }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["onboarding"] }),
      ]);
    },
  });
  const done = query.data?.adeGuideDone ?? false;

  return (
    <Page title={t("ade.title")} backToSettings>
      <p className="max-w-2xl text-sm text-muted-foreground">{t("ade.intro")}</p>
      <ol className="flex max-w-2xl list-decimal flex-col gap-4 pl-5">
        {STEPS.map((step) => (
          <li key={step} className="space-y-1">
            <h2 className="text-base font-medium">{t(`ade.steps.${step}.title`)}</h2>
            <p className="text-sm text-muted-foreground">{t(`ade.steps.${step}.body`)}</p>
          </li>
        ))}
      </ol>
      <Banner tone="info" className="max-w-2xl">
        {t("ade.note")}
      </Banner>
      {mark.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {query.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      <Button
        className="w-fit"
        variant={done ? "secondary" : "default"}
        disabled={!online || query.isPending || mark.isPending}
        onClick={() => mark.mutate(!done)}
      >
        {done ? t("ade.undo") : t("ade.markDone")}
      </Button>
    </Page>
  );
}
