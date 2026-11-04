import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { kbToMb, MAX_QUOTA_THRESHOLD_MB } from "../../shared/mailbox-quota";
import { checkMailboxQuota, mailboxStatusQuery, saveQuotaThreshold } from "../lib/mailbox-api";
import { useDirty } from "../lib/use-dirty";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { toast } from "./ui/toast";

/**
 * Mailbox space: usage from the server's quota (or an estimate from the stored messages), the
 * free-space threshold below which the banner and the push appear, and a check on demand.
 */
export function MailboxQuota({ online, configured }: { online: boolean; configured: boolean }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery(mailboxStatusQuery);
  const status = query.data;
  const [threshold, setThreshold] = useState("");
  const { dirty, markSaved } = useDirty("", threshold);
  const loaded = status ? String(kbToMb(status.thresholdKb)) : null;
  useEffect(() => {
    if (loaded !== null) {
      setThreshold(loaded);
      markSaved(loaded);
    }
  }, [loaded, markSaved]);

  const refresh = (next: unknown) => queryClient.setQueryData(mailboxStatusQuery.queryKey, next);
  const check = useMutation({
    mutationFn: checkMailboxQuota,
    onSuccess: refresh,
    onError: () => toast.error(t("mailbox.quota.checkFailed")),
  });
  const save = useMutation({
    mutationFn: (mb: number) => saveQuotaThreshold(mb),
    onSuccess: (next, mb) => {
      refresh(next);
      markSaved(String(mb));
      toast.success(t("mailbox.quota.saved"));
    },
    onError: () => toast.error(t("mailbox.quota.invalid", { max: MAX_QUOTA_THRESHOLD_MB })),
  });

  const quota = status?.quota ?? null;
  const when = quota
    ? new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(
        quota.checkedAt,
      )
    : "";
  const mb = Number(threshold);
  const valid = Number.isInteger(mb) && mb >= 1 && mb <= MAX_QUOTA_THRESHOLD_MB;

  return (
    <section className="space-y-3" aria-labelledby="mailbox-quota">
      <h2 id="mailbox-quota" className="text-base font-medium">
        {t("mailbox.quota.title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("mailbox.quota.intro")}</p>
      {query.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {status && !quota ? <Banner tone="info">{t("mailbox.quota.never")}</Banner> : null}
      {quota ? (
        <div className="space-y-2">
          {quota.low ? (
            <Banner tone="warning">
              {t("mailbox.quota.low", {
                free: kbToMb(quota.freeKb),
                threshold: kbToMb(status?.thresholdKb ?? 0),
              })}
            </Banner>
          ) : null}
          <p className="text-sm">
            {t("mailbox.quota.usage", {
              used: kbToMb(quota.usedKb),
              limit: kbToMb(quota.limitKb),
              free: kbToMb(quota.freeKb),
            })}
          </p>
          <p className="text-sm text-muted-foreground">
            {t(`mailbox.quota.source.${quota.source}`)} {t("mailbox.quota.checked", { when })}
          </p>
        </div>
      ) : null}
      <Button
        variant="secondary"
        className="w-fit"
        disabled={!online || !configured || check.isPending}
        onClick={() => check.mutate()}
      >
        {check.isPending ? t("mailbox.quota.checking") : t("mailbox.quota.check")}
      </Button>
      <form
        className="flex max-w-sm flex-wrap items-end gap-3"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (valid) save.mutate(mb);
        }}
      >
        <div className="min-w-0 flex-1">
          <Field label={t("mailbox.quota.threshold")} hint={t("mailbox.quota.thresholdHint")}>
            {(c) => (
              <Input
                {...c}
                inputMode="numeric"
                value={threshold}
                onChange={(event) => setThreshold(event.target.value)}
              />
            )}
          </Field>
        </div>
        <Button type="submit" disabled={!online || !dirty || !valid || save.isPending}>
          {t("mailbox.quota.save")}
        </Button>
      </form>
    </section>
  );
}
