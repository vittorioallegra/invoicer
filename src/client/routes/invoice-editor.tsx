import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Copy, FileMinus, Pencil, Send, Trash2 } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type ClientRecord, RITENUTA_TYPES } from "../../shared/client";
import { romeDateTime } from "../../shared/cron";
import { ApiError } from "../../shared/errors";
import { formatDate, type UiLocale } from "../../shared/format";
import {
  bolloSuggestion,
  EMPTY_INVOICE_DATA,
  type InvoiceRecord,
  invoiceEditability,
  issuanceTermWarning,
  PAYMENT_METHODS,
  SDI_ERROR_FIELDS,
} from "../../shared/invoice";
import type { SendReadiness } from "../../shared/onboarding";
import {
  CASSA_TYPE_CODES,
  type CassaType,
  defaultCassaSubjectToRitenuta,
} from "../../shared/totals";
import { ClientSheet } from "../components/client-form";
import { InvoiceLines } from "../components/invoice-lines";
import { InvoiceTotals } from "../components/invoice-totals";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { StatusBadge } from "../components/ui/status-badge";
import { Textarea } from "../components/ui/textarea";
import { clientsQuery } from "../lib/clients-api";
import {
  applyDefaults,
  emptyForm,
  formTotals,
  fromRecord,
  type InvoiceForm,
  type LineForm,
  naturaTextsFor,
  validateForm,
} from "../lib/invoice-form";
import {
  createCreditNote,
  createInvoice,
  deleteInvoice,
  duplicateInvoice,
  invoiceQuery,
  invoicesQuery,
  patchInvoice,
  reissueInvoice,
  releaseNumber,
  updateInvoice,
} from "../lib/invoices-api";
import { useOnline } from "../lib/online";
import {
  fieldErrorsFromDetail,
  onboardingQuery,
  type ProfileResponse,
  profileQuery,
} from "../lib/settings-api";
import { renderInvoicePdfFor } from "../pdf/generate";

const REQUIRED_LIKE = new Set(["required", "natura_text_required"]);

export function InvoiceEditorPage() {
  const { t } = useTranslation();
  const { invoiceId } = useParams({ strict: false }) as { invoiceId?: string };
  const clients = useQuery(clientsQuery);
  const profile = useQuery(profileQuery);
  const onboarding = useQuery(onboardingQuery);
  const record = useQuery({
    ...invoiceQuery(invoiceId ?? ""),
    enabled: invoiceId !== undefined,
  });

  const failed = clients.isError || profile.isError || (invoiceId !== undefined && record.isError);
  const ready =
    clients.data && profile.data && (invoiceId === undefined || record.data) && onboarding.data;

  return (
    <Page title={t(invoiceId ? "invoice.editTitle" : "invoice.newTitle")}>
      {failed ? (
        <Banner
          tone="danger"
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void clients.refetch();
                void profile.refetch();
                void record.refetch();
              }}
            >
              {t("common.retry")}
            </Button>
          }
        >
          {invoiceId !== undefined &&
          record.error instanceof ApiError &&
          record.error.status === 404
            ? t("invoice.notFound")
            : t("common.error")}
        </Banner>
      ) : null}
      {!failed && !ready ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
      {ready && clients.data && profile.data && onboarding.data ? (
        <EditorForm
          key={record.data?.invoice.id ?? "new"}
          record={record.data?.invoice ?? null}
          clients={clients.data.clients}
          profile={profile.data.profile}
          send={onboarding.data.send}
        />
      ) : null}
    </Page>
  );
}

interface EditorFormProps {
  record: InvoiceRecord | null;
  clients: ClientRecord[];
  profile: ProfileResponse | null;
  send: SendReadiness;
}

function EditorForm({ record, clients, profile, send }: EditorFormProps) {
  const { t, i18n } = useTranslation();
  const locale: UiLocale = i18n.language.startsWith("it") ? "it" : "en";
  const online = useOnline();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const today = romeDateTime(new Date()).date;

  const [form, setForm] = useState<InvoiceForm>(() =>
    record ? fromRecord(record) : applyDefaults(emptyForm(), null, profile, today),
  );
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [clientSheet, setClientSheet] = useState<"new" | "edit" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saved, setSaved] = useState(false);

  const editability = record ? invoiceEditability(record.state) : "full";
  const locked = editability === "locked";
  const client = clients.find((c) => c.id === form.clientId) ?? null;
  const totals = useMemo(() => formTotals(form), [form]);
  const issuing = useMemo(() => validateForm(form, client, true), [form, client]);
  const structural = useMemo(() => validateForm(form, client, false), [form, client]);

  const issued = useQuery({ ...invoicesQuery("issued"), enabled: form.documentType === "TD04" });
  const linkable = (issued.data?.invoices ?? []).filter(
    (invoice) => invoice.documentType === "TD01" && invoice.number !== null,
  );

  const patch = (changes: Partial<InvoiceForm>) => {
    setSaved(false);
    setServerErrors({});
    setForm((current) => ({ ...current, ...changes }));
  };
  const text = (key: keyof InvoiceForm) => (event: { target: { value: string } }) =>
    patch({ [key]: event.target.value } as Partial<InvoiceForm>);

  const err = (path: string): string | undefined => {
    const server = serverErrors[path];
    const code = server ?? issuing.errors[path];
    if (!code || (!server && REQUIRED_LIKE.has(code) && !submitted)) return undefined;
    return t(`validation.${code}`, { defaultValue: t("validation.invalid") });
  };

  function selectClient(chosen: ClientRecord | null) {
    setSaved(false);
    setForm((current) => {
      const next = { ...current, clientId: chosen?.id ?? "" };
      // Defaults prefill a new invoice only; an existing one keeps what it has.
      return record ? next : applyDefaults(next, chosen, profile, today);
    });
  }

  function setLines(lines: LineForm[]) {
    patch({ lines, naturaTexts: naturaTextsFor(lines, form.naturaTexts) });
  }

  const refresh = async (id: string) => {
    await queryClient.invalidateQueries({ queryKey: ["invoices"] });
    await queryClient.invalidateQueries({ queryKey: ["invoice", id] });
  };

  const save = useMutation({
    mutationFn: (body: unknown) => (record ? updateInvoice(record.id, body) : createInvoice(body)),
    onSuccess: async ({ invoice }) => {
      await refresh(invoice.id);
      if (record) setSaved(true);
      else void navigate({ to: "/invoices/$invoiceId", params: { invoiceId: invoice.id } });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "bad_request") {
        setServerErrors(fieldErrorsFromDetail(error.problem.detail));
      }
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteInvoice(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      void navigate({ to: "/" });
    },
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => duplicateInvoice(id),
    onSuccess: async ({ invoice }) => {
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      void navigate({ to: "/invoices/$invoiceId", params: { invoiceId: invoice.id } });
    },
  });

  const release = useMutation({
    mutationFn: (id: string) => releaseNumber(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      await queryClient.invalidateQueries({ queryKey: ["invoice"] });
      void navigate({ to: "/" });
    },
  });

  // The PDF is rendered in the browser and shown in a tab opened right away (popup blockers
  // only allow a window opened by the click itself).
  const preview = useMutation({
    mutationFn: async (id: string) => {
      const tab = window.open("", "_blank");
      try {
        const bytes = await renderInvoicePdfFor(id);
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
        if (tab) tab.location.href = url;
        else window.location.assign(url);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch (error) {
        tab?.close();
        throw error;
      }
    },
  });

  const reissue = useMutation({
    mutationFn: (id: string) => reissueInvoice(id),
    onSuccess: async ({ invoice }) => {
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      void navigate({ to: "/invoices/$invoiceId", params: { invoiceId: invoice.id } });
    },
  });

  const creditNote = useMutation({
    mutationFn: (id: string) => createCreditNote(id),
    onSuccess: async ({ invoice }) => {
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      void navigate({ to: "/invoices/$invoiceId", params: { invoiceId: invoice.id } });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (locked) return;
    setSubmitted(true);
    setSaved(false);
    if (!structural.ok) return;
    save.mutate(structural.body);
  }

  const bolloData = {
    ...EMPTY_INVOICE_DATA,
    bollo: form.bollo,
    bolloSuggestionDismissed: form.bolloDismissed,
  };
  const suggestBollo = bolloSuggestion(totals, {
    currency: form.currency.toUpperCase(),
    data: bolloData,
  });
  const warning = issuanceTermWarning({
    operationDate: form.operationDate || null,
    issueDate: record?.issueDate ?? (form.plannedDate || today),
    deferred: form.deferred,
  });
  const clientProblems = Object.keys(issuing.errors).filter((path) => path.startsWith("client."));
  const credit = form.documentType === "TD04";
  const serverFailure = save.isError && Object.keys(serverErrors).length === 0;
  const lockedReason = serverFailure && save.error instanceof ApiError && save.error.status === 409;

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      {record ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <StatusBadge status={record.state} />
          {record.number ? (
            <span className="font-medium">
              {t("invoice.numberYear", { number: record.number, year: record.year })}
            </span>
          ) : null}
          {record.issueDate ? (
            <span className="text-muted-foreground">
              {t("invoice.issuedOn", { date: formatDate(record.issueDate, locale) })}
            </span>
          ) : null}
          {record.number ? (
            <Button
              size="sm"
              variant="secondary"
              type="button"
              disabled={!online || preview.isPending}
              onClick={() => preview.mutate(record.id)}
            >
              {t("invoice.pdf.preview")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {preview.isError ? <Banner tone="danger">{t("invoice.pdf.failed")}</Banner> : null}
      {!online ? <Banner tone="warning">{t("offline.reason")}</Banner> : null}
      {serverFailure ? (
        <Banner tone="danger">
          {lockedReason ? t("invoice.errors.locked") : t("common.error")}
        </Banner>
      ) : null}
      {saved ? <Banner tone="success">{t("invoice.saved")}</Banner> : null}
      {locked ? <Banner tone="info">{t("invoice.readOnly")}</Banner> : null}
      {record?.numberReserved ? (
        <Banner
          tone="warning"
          action={
            record.releasable ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={!online || release.isPending}
                onClick={() => release.mutate(record.id)}
              >
                {t("invoice.reserved.release")}
              </Button>
            ) : null
          }
        >
          <p>{t("invoice.reserved.info")}</p>
          {record.releasable ? null : <p>{t("invoice.reserved.mustSend")}</p>}
        </Banner>
      ) : null}
      {record?.state === "rejected" && record.rejection ? (
        <Banner tone="danger">
          <p className="font-medium">
            {t("invoice.rejected.deadline", {
              date: new Intl.DateTimeFormat(i18n.language, {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(record.rejection.deadline)),
            })}
          </p>
          <p>{t("invoice.rejected.locked")}</p>
          <ul className="mt-1 list-disc pl-5">
            {record.rejection.errors.map((error) => (
              <li key={`${error.code}-${error.description}`}>
                {t("invoice.rejected.error", { code: error.code, text: error.description })}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {record?.state === "rejected" && !record.rejection ? (
        <Banner tone="danger">{t("invoice.rejected.noDetails")}</Banner>
      ) : null}
      {record?.state === "rejected_expired" ? (
        <Banner
          tone="danger"
          action={
            record.reissuedById ? (
              <Link
                to="/invoices/$invoiceId"
                params={{ invoiceId: record.reissuedById }}
                className="text-sm font-medium underline"
              >
                {t("invoice.rejected.openReissue")}
              </Link>
            ) : (
              <Button
                size="sm"
                disabled={!online || reissue.isPending}
                onClick={() => reissue.mutate(record.id)}
              >
                {t("invoice.rejected.reissue")}
              </Button>
            )
          }
        >
          <p className="font-medium">{t("invoice.rejected.expired")}</p>
          <p>{t("invoice.rejected.expiredBody")}</p>
          {record.rejection?.errors.map((error) => (
            <p key={`${error.code}-${error.description}`}>
              {t("invoice.rejected.error", { code: error.code, text: error.description })}
            </p>
          ))}
        </Banner>
      ) : null}
      {record?.reissuesInvoiceId ? (
        <Banner tone="info">
          {t("invoice.rejected.reissues")}{" "}
          <Link
            to="/invoices/$invoiceId"
            params={{ invoiceId: record.reissuesInvoiceId }}
            className="font-medium underline"
          >
            {t("invoice.rejected.openOriginal")}
          </Link>
        </Banner>
      ) : null}
      {release.isError ? (
        <Banner tone="danger">{t("invoice.reserved.releaseFailed")}</Banner>
      ) : null}
      {submitted && !structural.ok ? <Banner tone="danger">{t("invoice.fixErrors")}</Banner> : null}
      {warning ? <Banner tone="warning">{t(`invoice.warnings.${warning}`)}</Banner> : null}
      {suggestBollo ? (
        <Banner
          tone="info"
          action={
            <div className="flex gap-2">
              <Button size="sm" onClick={() => patch({ bollo: true })}>
                {t("invoice.bollo.add")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => patch({ bolloDismissed: true })}>
                {t("invoice.bollo.dismiss")}
              </Button>
            </div>
          }
        >
          {t("invoice.bollo.suggestion")}
        </Banner>
      ) : null}

      <fieldset disabled={locked} className="flex min-w-0 flex-col gap-6">
        <section className="flex flex-col gap-4" aria-labelledby="inv-client">
          <h2 id="inv-client" className="text-base font-medium">
            {t("invoice.client.title")}
          </h2>
          <div className="flex flex-wrap items-end gap-3">
            <Field
              label={t("invoice.client.label")}
              error={err("clientId")}
              className="min-w-56 flex-1"
            >
              {(c) => (
                <Select
                  {...c}
                  value={form.clientId}
                  onChange={(e) =>
                    selectClient(clients.find((x) => x.id === e.target.value) ?? null)
                  }
                >
                  <option value="">{t("invoice.client.choose")}</option>
                  {clients.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button variant="secondary" onClick={() => setClientSheet("new")}>
              {t("invoice.client.new")}
            </Button>
            {client ? (
              <Button variant="ghost" onClick={() => setClientSheet("edit")}>
                <Pencil aria-hidden />
                {t("invoice.client.edit")}
              </Button>
            ) : null}
          </div>
          <SdiNotes record={record} field="client" />
          {client && clientProblems.length > 0 ? (
            <Banner tone="warning">
              <p className="font-medium">{t("invoice.client.incomplete")}</p>
              <ul className="list-disc pl-5">
                {clientProblems.map((path) => (
                  <li key={path}>
                    {t(`clients.form.${path.slice("client.".length).split(".")[0]}`, {
                      defaultValue: path,
                    })}
                    :{" "}
                    {t(`validation.${issuing.errors[path]}`, {
                      defaultValue: t("validation.invalid"),
                    })}
                  </li>
                ))}
              </ul>
            </Banner>
          ) : null}
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="inv-document">
          <h2 id="inv-document" className="text-base font-medium">
            {t("invoice.document.title")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("invoice.document.type")}>
              {(c) => (
                <Select
                  {...c}
                  value={form.documentType}
                  disabled={locked || record !== null}
                  onChange={(e) =>
                    patch({
                      documentType: e.target.value as "TD01" | "TD04",
                      linkedInvoiceId: "",
                    })
                  }
                >
                  <option value="TD01">{t("invoice.document.td01")}</option>
                  <option value="TD04">{t("invoice.document.td04")}</option>
                </Select>
              )}
            </Field>
            <Field label={t("invoice.document.currency")} error={err("currency")}>
              {(c) => (
                <Input
                  {...c}
                  value={form.currency}
                  maxLength={3}
                  autoCapitalize="characters"
                  onChange={text("currency")}
                />
              )}
            </Field>
            {credit ? (
              <Field label={t("invoice.document.linked")} error={err("linkedInvoiceId")}>
                {(c) => (
                  <Select {...c} value={form.linkedInvoiceId} onChange={text("linkedInvoiceId")}>
                    <option value="">{t("invoice.document.noLinked")}</option>
                    {record?.linkedInvoiceId &&
                    !linkable.some((i) => i.id === record.linkedInvoiceId) ? (
                      <option value={record.linkedInvoiceId}>
                        {record.linked?.number ?? record.linkedInvoiceId}
                      </option>
                    ) : null}
                    {linkable.map((invoice) => (
                      <option key={invoice.id} value={invoice.id}>
                        {invoice.number} · {invoice.clientName ?? ""}
                        {invoice.issueDate ? ` · ${formatDate(invoice.issueDate, locale)}` : ""}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label={t("invoice.document.operationDate")}
              hint={t("invoice.document.operationHint")}
              error={err("operationDate")}
            >
              {(c) => (
                <Input
                  {...c}
                  type="date"
                  value={form.operationDate}
                  onChange={text("operationDate")}
                />
              )}
            </Field>
            <Field
              label={t("invoice.document.plannedDate")}
              hint={t("invoice.document.plannedHint")}
              error={err("plannedDate")}
            >
              {(c) => (
                <Input
                  {...c}
                  type="date"
                  value={form.plannedDate}
                  disabled={locked || editability === "rejected"}
                  onChange={text("plannedDate")}
                />
              )}
            </Field>
            <Field label={t("invoice.document.dueDate")} error={err("dueDate")}>
              {(c) => <Input {...c} type="date" value={form.dueDate} onChange={text("dueDate")} />}
            </Field>
          </div>
          <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
            <input
              type="checkbox"
              className="size-5"
              checked={form.deferred}
              onChange={(e) => patch({ deferred: e.target.checked })}
            />
            {t("invoice.document.deferred")}
          </label>
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="inv-lines">
          <h2 id="inv-lines" className="text-base font-medium">
            {t("invoice.lines.title")}
          </h2>
          <SdiNotes record={record} field="lines" />
          <InvoiceLines
            form={form}
            totals={totals}
            locale={locale}
            error={err}
            onChange={setLines}
            disabled={locked}
          />
          {Object.keys(form.naturaTexts).length > 0 ? (
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">{t("invoice.natura.title")}</h3>
              <p className="text-sm text-muted-foreground">{t("invoice.natura.intro")}</p>
              {Object.entries(form.naturaTexts).map(([code, value]) => (
                <Field
                  key={code}
                  label={t("invoice.natura.label", { code })}
                  error={err(`data.naturaTexts.${code}`)}
                >
                  {(c) => (
                    <Textarea
                      {...c}
                      rows={2}
                      value={value}
                      onChange={(e) =>
                        patch({ naturaTexts: { ...form.naturaTexts, [code]: e.target.value } })
                      }
                    />
                  )}
                </Field>
              ))}
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="inv-extras">
          <h2 id="inv-extras" className="text-base font-medium">
            {t("invoice.extras.title")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("clients.form.cassa")} error={err("data.cassa.type")}>
              {(c) => (
                <Select
                  {...c}
                  value={form.cassaType}
                  onChange={(e) =>
                    patch({
                      cassaType: e.target.value,
                      cassaSubjectToRitenuta: e.target.value
                        ? defaultCassaSubjectToRitenuta(e.target.value as CassaType)
                        : false,
                    })
                  }
                >
                  <option value="">{t("clients.form.none")}</option>
                  <option value="rivalsa_inps">{t("clients.form.rivalsaInps")}</option>
                  {CASSA_TYPE_CODES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t("clients.form.cassaRate")} error={err("data.cassa.rateBp")}>
              {(c) => (
                <Input
                  {...c}
                  value={form.cassaRate}
                  inputMode="decimal"
                  disabled={locked || !form.cassaType}
                  onChange={text("cassaRate")}
                />
              )}
            </Field>
            <Field label={t("clients.form.cassaMode")}>
              {(c) => (
                <Select
                  {...c}
                  value={form.cassaMode}
                  disabled={locked || !form.cassaType}
                  onChange={text("cassaMode")}
                >
                  <option value="excluded">{t("clients.form.modeExcluded")}</option>
                  <option value="included">{t("clients.form.modeIncluded")}</option>
                </Select>
              )}
            </Field>
          </div>
          {form.cassaType && form.ritenutaType ? (
            <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
              <input
                type="checkbox"
                className="size-5"
                checked={form.cassaSubjectToRitenuta}
                onChange={(e) => patch({ cassaSubjectToRitenuta: e.target.checked })}
              />
              {t("invoice.extras.cassaSubject")}
            </label>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("clients.form.ritenuta")} error={err("data.ritenuta.type")}>
              {(c) => (
                <Select {...c} value={form.ritenutaType} onChange={text("ritenutaType")}>
                  <option value="">{t("clients.form.none")}</option>
                  {RITENUTA_TYPES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t("clients.form.ritenutaRate")} error={err("data.ritenuta.rateBp")}>
              {(c) => (
                <Input
                  {...c}
                  value={form.ritenutaRate}
                  inputMode="decimal"
                  disabled={locked || !form.ritenutaType}
                  onChange={text("ritenutaRate")}
                />
              )}
            </Field>
            <Field label={t("clients.form.ritenutaCausale")} error={err("data.ritenuta.causale")}>
              {(c) => (
                <Input
                  {...c}
                  value={form.ritenutaCausale}
                  maxLength={2}
                  autoCapitalize="characters"
                  disabled={locked || !form.ritenutaType}
                  onChange={text("ritenutaCausale")}
                />
              )}
            </Field>
          </div>
          <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
            <input
              type="checkbox"
              className="size-5"
              checked={form.bollo}
              onChange={(e) => patch({ bollo: e.target.checked })}
            />
            {t("clients.form.bollo")}
          </label>
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="inv-payment">
          <h2 id="inv-payment" className="text-base font-medium">
            {t("invoice.payment.title")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("invoice.payment.method")} error={err("data.payment.method")}>
              {(c) => (
                <Select {...c} value={form.paymentMethod} onChange={text("paymentMethod")}>
                  <option value="">{t("clients.form.none")}</option>
                  {PAYMENT_METHODS.map((code) => (
                    <option key={code} value={code}>
                      {t(`invoice.paymentMethods.${code}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t("profile.iban")} error={err("data.payment.iban")}>
              {(c) => <Input {...c} value={form.iban} onChange={text("iban")} />}
            </Field>
            <Field label={t("profile.bic")} error={err("data.payment.bic")}>
              {(c) => <Input {...c} value={form.bic} onChange={text("bic")} />}
            </Field>
            <Field label={t("profile.accountHolder")} error={err("data.payment.accountHolder")}>
              {(c) => <Input {...c} value={form.accountHolder} onChange={text("accountHolder")} />}
            </Field>
            <Field label={t("profile.bankName")} error={err("data.payment.bankName")}>
              {(c) => <Input {...c} value={form.bankName} onChange={text("bankName")} />}
            </Field>
          </div>
        </section>

        {editability !== "locked" ? (
          <Field label={t("invoice.notes")} error={err("notes")}>
            {(c) => <Textarea {...c} value={form.notes} onChange={text("notes")} />}
          </Field>
        ) : null}
      </fieldset>

      {record && (locked || record.state === "rejected") ? (
        <PaymentSection
          key={record.paymentFlag + record.paidDate}
          record={record}
          showNotes={locked}
        />
      ) : null}

      {!locked && !send.ready ? (
        <Banner tone="warning">
          <p className="font-medium">{t("onboarding.sendBlocked")}</p>
          <ul className="list-disc pl-5">
            {send.reasons.map((reason) => (
              <li key={reason}>{t(`onboarding.reasons.${reason}`)}</li>
            ))}
          </ul>
        </Banner>
      ) : null}

      <div className="flex flex-wrap gap-3">
        {record ? (
          <Button
            variant="secondary"
            disabled={!online || duplicate.isPending}
            onClick={() => duplicate.mutate(record.id)}
          >
            <Copy aria-hidden />
            {t("invoice.actions.duplicate")}
          </Button>
        ) : null}
        {record &&
        record.documentType === "TD01" &&
        (record.state === "delivered" || record.state === "not_delivered") ? (
          <Button
            variant="secondary"
            disabled={!online || creditNote.isPending}
            onClick={() => creditNote.mutate(record.id)}
          >
            <FileMinus aria-hidden />
            {t("invoice.actions.creditNote")}
          </Button>
        ) : null}
        {record && (record.state === "draft" || record.state === "planned") && !confirmDelete ? (
          <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
            <Trash2 aria-hidden />
            {t("invoice.actions.delete")}
          </Button>
        ) : null}
        {record && confirmDelete ? (
          <Button
            variant="destructive"
            disabled={!online || remove.isPending}
            onClick={() => remove.mutate(record.id)}
          >
            {t("invoice.actions.deleteConfirm")}
          </Button>
        ) : null}
      </div>

      <InvoiceTotals
        totals={totals}
        form={form}
        locale={locale}
        actions={
          locked ? null : (
            <>
              <Button type="submit" disabled={!online || save.isPending}>
                {t(record ? "invoice.actions.save" : "invoice.actions.saveDraft")}
              </Button>
              {/* The send flow (step 12) wires this up; until then it only explains why. */}
              <Button type="button" variant="secondary" disabled title={t("invoice.send.pending")}>
                <Send aria-hidden />
                {t("invoice.actions.send")}
              </Button>
            </>
          )
        }
      />

      <ClientSheet
        open={clientSheet !== null}
        onOpenChange={(open) => setClientSheet(open ? (clientSheet ?? "new") : null)}
        client={clientSheet === "edit" ? (client ?? undefined) : undefined}
        onSaved={(saved) => {
          setClientSheet(null);
          // Select a client created inline; an edited one stays selected.
          if (saved.id !== form.clientId) selectClient(saved);
        }}
        onDeleted={() => {
          setClientSheet(null);
          selectClient(null);
        }}
      />
    </form>
  );
}

/** Payment flag and notes: what still changes once an invoice is out. */
function PaymentSection({ record, showNotes }: { record: InvoiceRecord; showNotes: boolean }) {
  const { t } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const [paid, setPaid] = useState(record.paymentFlag === "paid");
  const [paidDate, setPaidDate] = useState(record.paidDate ?? "");
  const [notes, setNotes] = useState(record.notes ?? "");

  const save = useMutation({
    mutationFn: () =>
      patchInvoice(record.id, {
        paymentFlag: paid ? "paid" : "unpaid",
        paidDate: paid && paidDate ? paidDate : null,
        ...(showNotes ? { notes } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      await queryClient.invalidateQueries({ queryKey: ["invoice", record.id] });
    },
  });

  return (
    <section className="flex flex-col gap-4" aria-labelledby="inv-paid">
      <h2 id="inv-paid" className="text-base font-medium">
        {t("invoice.paid.title")}
      </h2>
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={record.paymentFlag} />
        <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
          <input
            type="checkbox"
            className="size-5"
            checked={paid}
            onChange={(e) => setPaid(e.target.checked)}
          />
          {t("invoice.paid.markPaid")}
        </label>
      </div>
      {paid ? (
        <Field label={t("invoice.paid.date")} className="max-w-xs">
          {(c) => (
            <Input
              {...c}
              type="date"
              value={paidDate}
              onChange={(e) => setPaidDate(e.target.value)}
            />
          )}
        </Field>
      ) : null}
      {showNotes ? (
        <Field label={t("invoice.notes")}>
          {(c) => <Textarea {...c} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      ) : null}
      {save.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {save.isSuccess ? <Banner tone="success">{t("invoice.saved")}</Banner> : null}
      <Button
        className="w-fit"
        variant="secondary"
        disabled={!online || save.isPending}
        onClick={() => save.mutate()}
      >
        {t("invoice.paid.save")}
      </Button>
    </section>
  );
}

/** SdI error texts next to the field they concern (plain text, never markup). */
function SdiNotes({ record, field }: { record: InvoiceRecord | null; field: "client" | "lines" }) {
  const { t } = useTranslation();
  const errors = (record?.state === "rejected" ? (record.rejection?.errors ?? []) : []).filter(
    (error) => SDI_ERROR_FIELDS[error.code] === field,
  );
  if (errors.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {errors.map((error) => (
        <p key={error.code} role="alert" className="text-sm text-danger">
          {t("invoice.rejected.error", { code: error.code, text: error.description })}
        </p>
      ))}
    </div>
  );
}
