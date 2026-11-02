import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";

/** "Download all data": a plain link, so the browser streams the JSON file to disk. */
export function DataExport({ online }: { online: boolean }) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2" aria-labelledby="export">
      <h2 id="export" className="text-base font-medium">
        {t("settings.export.title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("settings.export.intro")}</p>
      <a
        href="/api/export"
        download
        aria-disabled={!online}
        tabIndex={online ? undefined : -1}
        onClick={(event) => {
          if (!online) event.preventDefault();
        }}
        className="inline-flex min-h-11 items-center gap-2 rounded-control border border-border px-3 text-sm font-medium hover:bg-muted aria-disabled:pointer-events-none aria-disabled:opacity-50"
      >
        <Download aria-hidden className="size-4" />
        {t("settings.export.button")}
      </a>
      <p className="text-sm text-muted-foreground">{t("settings.export.excluded")}</p>
    </section>
  );
}
