import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { Banner } from "./ui/banner";

interface Unmatched {
  messages: { id: string; type: string | null; fileName: string | null; receivedAt: number }[];
}

/**
 * SdI messages that match none of our transmissions (stored whole, never dropped). Rendered as
 * text only: file names come from the mailbox.
 */
export function UnmatchedMessages() {
  const { t, i18n } = useTranslation();
  const query = useQuery({
    queryKey: ["mailbox", "unmatched"],
    queryFn: () => api<Unmatched>("/api/mailbox/unmatched"),
  });
  const when = (ms: number) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(ms);

  return (
    <section className="space-y-2" aria-labelledby="unmatched">
      <h2 id="unmatched" className="text-base font-medium">
        {t("settings.unmatched.title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("settings.unmatched.intro")}</p>
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
      {query.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {query.data && query.data.messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("settings.unmatched.empty")}</p>
      ) : null}
      {query.data && query.data.messages.length > 0 ? (
        <ul className="max-w-2xl divide-y divide-border rounded-card border border-border">
          {query.data.messages.map((m) => (
            <li key={m.id} className="px-4 py-2 text-sm">
              <span className="font-medium">{m.type ?? "?"}</span>{" "}
              <span className="break-all">{m.fileName ?? t("settings.unmatched.noFile")}</span>
              <span className="block text-muted-foreground">{when(m.receivedAt)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
