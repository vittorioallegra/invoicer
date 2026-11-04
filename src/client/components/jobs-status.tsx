import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { Banner } from "./ui/banner";

interface LastRun {
  at: number;
  runDate: string | null;
  status: "success" | "failed";
  errorCode: string | null;
  counts: Record<string, number | string | boolean> | null;
}

interface JobsResponse {
  poll: LastRun | null;
  daily: LastRun | null;
}

/** Daily tasks in the order the run lists them; -1 means that task failed, 0 is not worth a line. */
const DAILY_TASKS = ["unsent", "overdue"] as const;

/** Last mailbox check and last daily run, from the Worker's `job_runs` records. */
export function JobsStatus() {
  const { t, i18n } = useTranslation();
  const query = useQuery({ queryKey: ["jobs"], queryFn: () => api<JobsResponse>("/api/jobs") });
  const when = (ms: number) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(ms);

  const state = (run: LastRun | null) => {
    if (!run) return t("settings.jobs.never");
    const base = t("settings.jobs.at", { when: when(run.at) });
    return run.status === "success"
      ? `${base} · ${t("settings.jobs.ok")}`
      : `${base} · ${t("settings.jobs.failed", { code: run.errorCode ?? "error" })}`;
  };
  const daily = query.data?.daily ?? null;
  const done = DAILY_TASKS.flatMap((task) => {
    const count = daily?.counts?.[task];
    return typeof count === "number" && count !== 0 ? [{ task, count }] : [];
  });

  return (
    <section className="space-y-2" aria-labelledby="jobs">
      <h2 id="jobs" className="text-base font-medium">
        {t("settings.jobs.title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("settings.jobs.intro")}</p>
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
      {query.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {query.data ? (
        <dl className="max-w-2xl divide-y divide-border rounded-card border border-border text-sm">
          <div className="px-4 py-2">
            <dt className="font-medium">{t("settings.jobs.poll")}</dt>
            <dd className="text-muted-foreground">{state(query.data.poll)}</dd>
          </div>
          <div className="px-4 py-2">
            <dt className="font-medium">{t("settings.jobs.daily")}</dt>
            <dd className="text-muted-foreground">{state(daily)}</dd>
            {done.length > 0 ? (
              <dd className="text-muted-foreground">
                {done
                  .map(({ task, count }) =>
                    count < 0
                      ? t("settings.jobs.taskFailed", { task: t(`settings.jobs.tasks.${task}`) })
                      : t(`settings.jobs.counts.${task}`, { count }),
                  )
                  .join(" · ")}
              </dd>
            ) : null}
          </div>
        </dl>
      ) : null}
    </section>
  );
}
