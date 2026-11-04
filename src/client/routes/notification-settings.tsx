import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NOTIFICATION_TYPES } from "../../shared/notifications";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { toast } from "../components/ui/toast";
import { SETTINGS_BACK } from "../lib/back-links";
import {
  pushStateQuery,
  registerPushDevice,
  removePushDevice,
  saveLanguage,
  savePushTypes,
} from "../lib/notifications-api";
import { useOnline } from "../lib/online";
import {
  currentPushSubscription,
  pushSupport,
  subscribeThisDevice,
  unsubscribeThisDevice,
} from "../lib/push";

type Device = "checking" | "on" | "off" | "denied" | "unsupported";

/** Web Push for this device (a click asks for permission) and the per-type switches. */
export function NotificationSettingsPage() {
  const { t, i18n } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const state = useQuery(pushStateQuery);
  const [device, setDevice] = useState<Device>("checking");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (pushSupport() === "unsupported") return setDevice("unsupported");
      if (Notification.permission === "denied") return setDevice("denied");
      const subscription = await currentPushSubscription().catch(() => null);
      if (!cancelled) setDevice(subscription ? "on" : "off");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["push"] });

  const turnOn = useMutation({
    mutationFn: async () => {
      const publicKey = state.data?.publicKey;
      if (!publicKey) throw new Error("push_off");
      const result = await subscribeThisDevice(publicKey);
      if (!result.ok) return result.reason;
      await registerPushDevice(result.subscription);
      await saveLanguage(i18n.language.startsWith("it") ? "it" : "en");
      return "on" as const;
    },
    onSuccess: async (outcome) => {
      if (outcome === "on") {
        setDevice("on");
        toast.success(t("notificationsPage.settings.enabled"));
      } else if (outcome === "denied") {
        setDevice("denied");
      } else {
        toast.error(t("notificationsPage.settings.noServiceWorker"));
      }
      await refresh();
    },
    onError: () => toast.error(t("common.error")),
  });

  const turnOff = useMutation({
    mutationFn: async () => {
      const endpoint = await unsubscribeThisDevice();
      if (endpoint) await removePushDevice(endpoint);
    },
    onSuccess: async () => {
      setDevice("off");
      await refresh();
    },
    onError: () => toast.error(t("common.error")),
  });

  const disabled = new Set<string>(state.data?.disabledTypes ?? []);
  const toggle = useMutation({
    mutationFn: ({ type, on }: { type: string; on: boolean }) => {
      const next = new Set(disabled);
      if (on) next.delete(type);
      else next.add(type);
      return savePushTypes([...next]);
    },
    onSuccess: refresh,
    onError: () => toast.error(t("common.error")),
  });

  const busy = turnOn.isPending || turnOff.isPending;
  return (
    <Page title={t("notificationsPage.settings.title")} back={SETTINGS_BACK}>
      <p className="max-w-2xl text-sm text-muted-foreground">
        {t("notificationsPage.settings.intro")}
      </p>
      {state.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {state.data && !state.data.configured ? (
        <Banner tone="info">{t("features.pushOff")}</Banner>
      ) : null}

      <section className="max-w-2xl space-y-3" aria-labelledby="push-device">
        <h2 id="push-device" className="text-base font-medium">
          {t("notificationsPage.settings.deviceTitle")}
        </h2>
        {device === "unsupported" ? (
          <Banner tone="warning">{t("notificationsPage.settings.unsupported")}</Banner>
        ) : null}
        {device === "denied" ? (
          <Banner tone="warning">{t("notificationsPage.settings.denied")}</Banner>
        ) : null}
        {device === "on" ? (
          <p className="text-sm text-muted-foreground">{t("notificationsPage.settings.on")}</p>
        ) : null}
        {device === "off" ? (
          <p className="text-sm text-muted-foreground">{t("notificationsPage.settings.off")}</p>
        ) : null}
        {device === "off" || device === "on" ? (
          <Button
            className="w-fit"
            variant={device === "on" ? "secondary" : "default"}
            disabled={!online || busy || !state.data?.configured}
            onClick={() => (device === "on" ? turnOff.mutate() : turnOn.mutate())}
          >
            {device === "on"
              ? t("notificationsPage.settings.turnOff")
              : t("notificationsPage.settings.turnOn")}
          </Button>
        ) : null}
        {state.data ? (
          <p className="text-sm text-muted-foreground">
            {t("notificationsPage.settings.devices", { count: state.data.devices })}
          </p>
        ) : null}
      </section>

      <section className="max-w-2xl space-y-3" aria-labelledby="push-types">
        <h2 id="push-types" className="text-base font-medium">
          {t("notificationsPage.settings.typesTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("notificationsPage.settings.typesHint")}</p>
        <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
          {NOTIFICATION_TYPES.map((type) => (
            <li key={type}>
              <label className="flex min-h-12 cursor-pointer items-center gap-3 px-4 py-2 text-sm">
                <input
                  type="checkbox"
                  className="size-5 shrink-0 accent-primary"
                  checked={!disabled.has(type)}
                  disabled={!online || !state.data || toggle.isPending}
                  onChange={(event) => toggle.mutate({ type, on: event.target.checked })}
                />
                {t(`notifications.${type}.title`)}
              </label>
            </li>
          ))}
        </ul>
      </section>
    </Page>
  );
}
