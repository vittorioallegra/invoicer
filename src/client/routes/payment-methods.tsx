import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Landmark, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../shared/errors";
import {
  maskIban,
  type PaymentMethodRecord,
  paymentMethodInputSchema,
} from "../../shared/payment-method";
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
  createPaymentMethod,
  deletePaymentMethod,
  fieldErrors,
  fieldErrorsFromDetail,
  paymentMethodsQuery,
  setDefaultPaymentMethod,
  updatePaymentMethod,
} from "../lib/settings-api";

interface FormState {
  label: string;
  iban: string;
  bic: string;
  accountHolder: string;
}

const EMPTY: FormState = { label: "", iban: "", bic: "", accountHolder: "" };

const fromRecord = (m: PaymentMethodRecord): FormState => ({
  label: m.label,
  iban: m.iban,
  bic: m.bic ?? "",
  accountHolder: m.accountHolder ?? "",
});

function AccountForm({
  method,
  onDone,
}: {
  method: PaymentMethodRecord | undefined;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(method ? fromRecord(method) : EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [makeDefault, setMakeDefault] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["payment-methods"] });
  const save = useMutation({
    mutationFn: async (body: unknown) => {
      const { paymentMethod } = method
        ? await updatePaymentMethod(method.id, body)
        : await createPaymentMethod(body);
      if (makeDefault) await setDefaultPaymentMethod(paymentMethod.id);
    },
    onSuccess: async () => {
      await refresh();
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "bad_request") {
        setErrors(fieldErrorsFromDetail(error.problem.detail));
      } else {
        toast.error(t("common.error"));
      }
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deletePaymentMethod(id),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });

  const err = (field: string) => {
    const code = errors[field];
    return code ? t(`validation.${code}`, { defaultValue: t("validation.invalid") }) : undefined;
  };
  const set = (key: keyof FormState) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = paymentMethodInputSchema.safeParse(form);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    save.mutate(form);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <Field
        label={t("paymentMethods.label")}
        hint={t("paymentMethods.labelHint")}
        error={err("label")}
      >
        {(c) => <Input {...c} value={form.label} onChange={set("label")} maxLength={40} />}
      </Field>
      <Field label={t("paymentMethods.iban")} error={err("iban")}>
        {(c) => (
          <Input {...c} value={form.iban} onChange={set("iban")} autoCapitalize="characters" />
        )}
      </Field>
      <Field label={t("paymentMethods.bic")} error={err("bic")}>
        {(c) => <Input {...c} value={form.bic} onChange={set("bic")} autoCapitalize="characters" />}
      </Field>
      <Field label={t("paymentMethods.accountHolder")} error={err("accountHolder")}>
        {(c) => <Input {...c} value={form.accountHolder} onChange={set("accountHolder")} />}
      </Field>
      {method?.isDefault ? null : (
        <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
          <input
            type="checkbox"
            className="size-5"
            checked={makeDefault}
            onChange={(e) => setMakeDefault(e.target.checked)}
          />
          {t("paymentMethods.makeDefault")}
        </label>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {method && !confirmDelete ? (
          <Button
            type="button"
            variant="ghost"
            className="text-danger hover:text-danger"
            onClick={() => setConfirmDelete(true)}
          >
            {t("paymentMethods.delete")}
          </Button>
        ) : null}
        {method && confirmDelete ? (
          <Button
            type="button"
            variant="destructive"
            disabled={!online || remove.isPending}
            onClick={() => remove.mutate(method.id)}
          >
            {t("paymentMethods.deleteConfirm")}
          </Button>
        ) : null}
        <div className="ms-auto flex flex-wrap gap-3">
          <Button type="button" variant="secondary" onClick={onDone}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!online || save.isPending}>
            {t("paymentMethods.save")}
          </Button>
        </div>
      </div>
      {method && confirmDelete ? (
        <p className="text-sm text-muted-foreground">{t("paymentMethods.deleteNote")}</p>
      ) : null}
    </form>
  );
}

export function PaymentMethodsPage() {
  const { t } = useTranslation();
  const query = useQuery(paymentMethodsQuery);
  const [editing, setEditing] = useState<PaymentMethodRecord | "new" | null>(null);
  const methods = query.data?.paymentMethods ?? [];
  const add = (
    <Button onClick={() => setEditing("new")}>
      <Plus aria-hidden />
      {t("paymentMethods.add")}
    </Button>
  );

  return (
    <Page title={t("paymentMethods.title")} backToSettings>
      <p className="max-w-2xl text-sm text-muted-foreground">{t("paymentMethods.intro")}</p>
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
      {query.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {query.data && methods.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title={t("paymentMethods.emptyTitle")}
          description={t("paymentMethods.emptyBody")}
          action={add}
        />
      ) : null}
      {methods.length > 0 ? (
        <>
          <div>{add}</div>
          <ul className="flex max-w-2xl flex-col divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
            {methods.map((method) => (
              <li key={method.id}>
                <button
                  type="button"
                  onClick={() => setEditing(method)}
                  className="flex min-h-14 w-full flex-col items-start gap-0.5 px-4 py-3 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                >
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    {method.label}
                    {method.isDefault ? (
                      <span className="rounded-control bg-muted px-2 py-0.5 text-xs font-medium">
                        {t("paymentMethods.defaultBadge")}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-sm text-muted-foreground">{maskIban(method.iban)}</span>
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
          editing === "new" || editing === null
            ? "paymentMethods.newTitle"
            : "paymentMethods.editTitle",
        )}
      >
        {editing !== null ? (
          <AccountForm
            key={editing === "new" ? "new" : editing.id}
            method={editing === "new" ? undefined : editing}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Sheet>
    </Page>
  );
}
