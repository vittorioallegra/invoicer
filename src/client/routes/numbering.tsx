import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListOrdered, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../shared/errors";
import {
  formatInvoiceNumber,
  MAX_AFFIX_LENGTH,
  type NumberingSeriesRecord,
  numberingSeriesInputSchema,
} from "../../shared/numbering";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Sheet } from "../components/ui/sheet";
import { toast } from "../components/ui/toast";
import { useOnline } from "../lib/online";
import {
  createNumberingSeries,
  deleteNumberingSeries,
  fieldErrors,
  fieldErrorsFromDetail,
  numberingSeriesQuery,
  setDefaultNumberingSeries,
  updateNumberingSeries,
} from "../lib/settings-api";

interface FormState {
  name: string;
  prefix: string;
  suffix: string;
}

const EMPTY: FormState = { name: "", prefix: "", suffix: "" };

const fromRecord = (s: NumberingSeriesRecord): FormState => ({
  name: s.name,
  prefix: s.prefix ?? "",
  suffix: s.suffix ?? "",
});

function SeriesForm({
  series,
  onDone,
}: {
  series: NumberingSeriesRecord | undefined;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(series ? fromRecord(series) : EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [makeDefault, setMakeDefault] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["numbering-series"] });
  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.code === "bad_request") {
      setErrors(fieldErrorsFromDetail(error.problem.detail));
    } else if (error instanceof ApiError && error.code === "conflict") {
      toast.error(
        t(`numbering.conflict_${error.problem.detail}`, { defaultValue: t("common.error") }),
      );
    } else {
      toast.error(t("common.error"));
    }
  };
  const save = useMutation({
    mutationFn: async (body: unknown) => {
      const saved = series
        ? await updateNumberingSeries(series.id, body)
        : await createNumberingSeries(body);
      if (makeDefault) await setDefaultNumberingSeries(saved.series.id);
    },
    onSuccess: async () => {
      await refresh();
      onDone();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteNumberingSeries(id),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
    onError: (error) => {
      setConfirmDelete(false);
      fail(error);
    },
  });

  const err = (field: string) => {
    const code = errors[field];
    return code
      ? t(`validation.${code}`, { defaultValue: t("validation.invalid"), max: MAX_AFFIX_LENGTH })
      : undefined;
  };
  const set = (key: keyof FormState) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = numberingSeriesInputSchema.safeParse(form);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    save.mutate(form);
  }

  const example = formatInvoiceNumber(
    { prefix: form.prefix.trim() || null, suffix: form.suffix.trim() || null },
    1,
  );

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <Field label={t("numbering.name")} hint={t("numbering.nameHint")} error={err("name")}>
        {(c) => <Input {...c} value={form.name} onChange={set("name")} maxLength={40} />}
      </Field>
      <Field label={t("numbering.prefix")} error={err("prefix")}>
        {(c) => (
          <Input
            {...c}
            value={form.prefix}
            onChange={set("prefix")}
            maxLength={MAX_AFFIX_LENGTH}
            autoCapitalize="characters"
            placeholder="CH-"
          />
        )}
      </Field>
      <Field
        label={t("numbering.suffix")}
        hint={t("numbering.example", { example })}
        error={err("suffix")}
      >
        {(c) => (
          <Input
            {...c}
            value={form.suffix}
            onChange={set("suffix")}
            maxLength={MAX_AFFIX_LENGTH}
            autoCapitalize="characters"
            placeholder="/CH"
          />
        )}
      </Field>
      {series?.isDefault ? null : (
        <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
          <input
            type="checkbox"
            className="size-5"
            checked={makeDefault}
            onChange={(e) => setMakeDefault(e.target.checked)}
          />
          {t("numbering.makeDefault")}
        </label>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {series && !series.isDefault && !confirmDelete ? (
          <Button
            type="button"
            variant="ghost"
            className="text-danger hover:text-danger"
            onClick={() => setConfirmDelete(true)}
          >
            {t("numbering.delete")}
          </Button>
        ) : null}
        {series && confirmDelete ? (
          <Button
            type="button"
            variant="destructive"
            disabled={!online || remove.isPending}
            onClick={() => remove.mutate(series.id)}
          >
            {t("numbering.deleteConfirm")}
          </Button>
        ) : null}
        <div className="ms-auto flex flex-wrap gap-3">
          <Button type="button" variant="secondary" onClick={onDone}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!online || save.isPending}>
            {t("numbering.save")}
          </Button>
        </div>
      </div>
      {series && confirmDelete ? (
        <p className="text-sm text-muted-foreground">{t("numbering.deleteNote")}</p>
      ) : null}
      {series?.isDefault ? (
        <p className="text-sm text-muted-foreground">{t("numbering.defaultNote")}</p>
      ) : null}
    </form>
  );
}

export function NumberingPage() {
  const { t } = useTranslation();
  const query = useQuery(numberingSeriesQuery);
  const [editing, setEditing] = useState<NumberingSeriesRecord | "new" | null>(null);
  const list = query.data?.series ?? [];
  const add = (
    <Button onClick={() => setEditing("new")}>
      <Plus aria-hidden />
      {t("numbering.add")}
    </Button>
  );

  return (
    <Page title={t("numbering.title")} backToSettings>
      <p className="max-w-2xl text-sm text-muted-foreground">{t("numbering.intro")}</p>
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
      {query.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {query.data && list.length === 0 ? (
        <EmptyState
          icon={ListOrdered}
          title={t("numbering.emptyTitle")}
          description={t("numbering.emptyBody")}
          action={add}
        />
      ) : null}
      {list.length > 0 ? (
        <>
          <div>{add}</div>
          <ul className="flex max-w-2xl flex-col divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
            {list.map((series) => (
              <li key={series.id}>
                <button
                  type="button"
                  onClick={() => setEditing(series)}
                  className="flex min-h-14 w-full flex-col items-start gap-0.5 px-4 py-3 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                >
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    {series.name}
                    {series.isDefault ? (
                      <span className="rounded-control bg-muted px-2 py-0.5 text-xs font-medium">
                        {t("numbering.defaultBadge")}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {t("numbering.example", { example: formatInvoiceNumber(series, 1) })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <Sheet
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        side="right"
        title={t(
          editing === "new" || editing === null ? "numbering.newTitle" : "numbering.editTitle",
        )}
      >
        {editing !== null ? (
          <SeriesForm
            key={editing === "new" ? "new" : editing.id}
            series={editing === "new" ? undefined : editing}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Sheet>
    </Page>
  );
}
