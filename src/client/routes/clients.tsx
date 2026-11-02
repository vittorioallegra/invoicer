import { useQuery } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClientRecord } from "../../shared/client";
import { ClientSheet } from "../components/client-form";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { clientsQuery } from "../lib/clients-api";

export function ClientsPage() {
  const { t } = useTranslation();
  const query = useQuery(clientsQuery);
  const [editing, setEditing] = useState<ClientRecord | "new" | null>(null);

  const open = (value: ClientRecord | "new" | null) => setEditing(value);
  const clients = query.data?.clients ?? [];
  const current = editing && editing !== "new" ? editing : undefined;

  const addButton = (
    <Button onClick={() => open("new")}>
      <Plus aria-hidden />
      {t("clients.add")}
    </Button>
  );

  return (
    <Page title={t("pages.clients.title")}>
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
      {query.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {query.data && clients.length === 0 ? (
        <EmptyState
          icon={Users}
          title={t("pages.clients.emptyTitle")}
          description={t("pages.clients.emptyBody")}
          action={addButton}
        />
      ) : null}
      {clients.length > 0 ? (
        <>
          <div>{addButton}</div>
          <ul className="flex flex-col divide-y divide-border rounded-card border border-border">
            {clients.map((client) => (
              <li key={client.id}>
                <button
                  type="button"
                  onClick={() => open(client)}
                  className="flex min-h-14 w-full flex-col items-start gap-0.5 px-4 py-3 text-left hover:bg-muted"
                >
                  <span className="font-medium">{client.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {t(`clients.types.${client.type}`)} ·{" "}
                    {client.vatNumber ??
                      client.taxCode ??
                      client.foreignTaxId ??
                      client.countryCode}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <ClientSheet
        open={editing !== null}
        onOpenChange={(value) => open(value ? (editing ?? "new") : null)}
        client={current}
        onSaved={() => open(null)}
        onDeleted={() => open(null)}
      />
    </Page>
  );
}
