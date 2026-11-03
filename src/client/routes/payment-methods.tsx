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

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["payment-methods"] });
  const save = useMutation({
    mutationFn: (body: unknown) =>
      method ? updatePaymentMethod(method.id, body) : createPaymentMethod(body),
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
  const online = useOnline();
  const queryClient = useQueryClient();
  const query = useQuery(paymentMethodsQuery);
  const [editing, setEditing] = useState<PaymentMethodRecord | "new" | null>(null);
  const makeDefault = useMutation({
    mutationFn: (id: string) => setDefaultPaymentMethod(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["payment-methods"] }),
    onError: () => toast.error(t("common.error")),
  });
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
          <ul className="max-w-2xl divide-y divide-border rounded-card border border-border bg-surface">
            {methods.map((method) => (
              <li key={method.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {method.label}
                    {method.isDefault ? (
                      <span className="rounded-control bg-muted px-2 py-0.5 text-xs font-medium">
                        {t("paymentMethods.defaultBadge")}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-sm text-muted-foreground">{maskIban(method.iban)}</p>
                </div>
                {!method.isDefault ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!online || makeDefault.isPending}
                    onClick={() => makeDefault.mutate(method.id)}
                    aria-label={t("paymentMethods.setDefaultFor", { label: method.label })}
                  >
                    {t("paymentMethods.setDefault")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setEditing(method)}
                  aria-label={t("paymentMethods.editFor", { label: method.label })}
                >
                  {t("paymentMethods.edit")}
                </Button>
              </li>
            ))}
          </ul>
          <div>{add}</div>
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
