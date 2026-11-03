import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Copy, FileMinus, Pencil, Send, Trash2, Upload } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type ClientRecord, RITENUTA_TYPES } from "../../shared/client";
import { romeDateTime } from "../../shared/cron";
import { ApiError } from "../../shared/errors";
import { formatDate, formatMoney, type UiLocale } from "../../shared/format";
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
import { maskIban, type PaymentMethodRecord } from "../../shared/payment-method";
import {
  CASSA_TYPE_CODES,
  CAUSALE_PAGAMENTO_CODES,
  type CassaType,
  cassaTypeLabel,
  causalePagamentoLabel,
  defaultCassaSubjectToRitenuta,
  ritenutaTypeLabel,
} from "../../shared/totals";
import { ClientSheet } from "../components/client-form";
import { InvoiceDetail } from "../components/invoice-detail";
import { InvoiceLines } from "../components/invoice-lines";
import { InvoiceTotals } from "../components/invoice-totals";
import { Page } from "../components/page";
import { PaymentTermsFields } from "../components/payment-terms-fields";
import { SendSheet } from "../components/send-sheet";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { StatusBadge } from "../components/ui/status-badge";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toast";
import { clientsQuery } from "../lib/clients-api";
import {
  applyDefaults,
  effectiveDueDate,
  emptyForm,
  formTerms,
  formTotals,
  fromRecord,
  type InvoiceForm,
  type LineForm,
  naturaTextsFor,
  typedNumber,
  validateForm,
  withAccount,
} from "../lib/invoice-form";
import {
  createCreditNote,
  createInvoice,
  deleteInvoice,
  duplicateInvoice,
  invoiceQuery,
  invoicesQuery,
  nextNumberQuery,
  patchInvoice,
  reissueInvoice,
  releaseNumber,
  updateInvoice,
} from "../lib/invoices-api";
import { useOnline } from "../lib/online";
import { previewPdf } from "../lib/pdf-preview";
import { sdiErrorLine } from "../lib/sdi-error";
import {
  fieldErrorsFromDetail,
  onboardingQuery,
  paymentMethodsQuery,
  profileQuery,
} from "../lib/settings-api";
import { renderInvoicePdfFor } from "../pdf/generate";

/** Select value for payment details that match no current account. */
const SNAPSHOT = "__snapshot__";
const REQUIRED_LIKE = new Set(["required", "natura_text_required"]);

export function InvoiceEditorPage() {
  const { t } = useTranslation();
  const { invoiceId } = useParams({ strict: false }) as { invoiceId?: string };
  const clients = useQuery(clientsQuery);
  const profile = useQuery(profileQuery);
  const accounts = useQuery(paymentMethodsQuery);
  const onboarding = useQuery(onboardingQuery);
  const record = useQuery({
    ...invoiceQuery(invoiceId ?? ""),
    enabled: invoiceId !== undefined,
  });

  const failed =
    clients.isError ||
    profile.isError ||
    accounts.isError ||
    (invoiceId !== undefined && record.isError);
  const ready =
    clients.data &&
    profile.data &&
    accounts.data &&
    (invoiceId === undefined || record.data) &&
    onboarding.data;

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
                void accounts.refetch();
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
      {ready && clients.data && profile.data && accounts.data && onboarding.data ? (
        <EditorForm
          key={record.data?.invoice.id ?? "new"}
          record={record.data?.invoice ?? null}
          clients={clients.data.clients}
          accounts={accounts.data.paymentMethods}
          send={onboarding.data.send}
        />
      ) : null}
    </Page>
  );
}

interface EditorFormProps {
  record: InvoiceRecord | null;
  clients: ClientRecord[];
  accounts: PaymentMethodRecord[];
  send: SendReadiness;
}

function EditorForm({ record, clients, accounts, send }: EditorFormProps) {
  const { t, i18n } = useTranslation();
  const locale: UiLocale = i18n.language.startsWith("it") ? "it" : "en";
  const online = useOnline();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const today = romeDateTime(new Date()).date;

  const [form, setForm] = useState<InvoiceForm>(() =>
    record
      ? fromRecord(record)
      : withAccount(
          applyDefaults(emptyForm(), null),
          accounts.find((account) => account.isDefault) ?? null,
        ),
  );
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [clientSheet, setClientSheet] = useState<"new" | "edit" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const editability = record ? invoiceEditability(record.state) : "full";
  const locked = editability === "locked";
  const client = clients.find((c) => c.id === form.clientId) ?? null;

  // The number is chosen here until it is reserved; from then on it is shown read-only.
  const numberEditable = editability === "full" && !record?.number;
  const year = Number(today.slice(0, 4));
  const nextNumber = useQuery({ ...nextNumberQuery(year), enabled: numberEditable });
  const proposal = nextNumber.data?.next ?? null;
  const [numberTouched, setNumberTouched] = useState(false);
  const [numberTaken, setNumberTaken] = useState(false);
  const numberText = numberTouched
    ? form.requestedNumber
    : form.requestedNumber || (proposal === null ? "" : String(proposal));

  const totals = useMemo(() => formTotals(form), [form]);
  const issuing = useMemo(
    () => validateForm(form, client, true, proposal, today),
    [form, client, proposal, today],
  );
  const structural = useMemo(
    () => validateForm(form, client, false, proposal, today),
    [form, client, proposal, today],
  );

  const issued = useQuery({ ...invoicesQuery("issued"), enabled: form.documentType === "TD04" });
  const linkable = (issued.data?.invoices ?? []).filter(
    (invoice) => invoice.documentType === "TD01" && invoice.number !== null,
  );

  const patch = (changes: Partial<InvoiceForm>) => {
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
    setForm((current) => {
      const next = { ...current, clientId: chosen?.id ?? "" };
      // Defaults prefill a new invoice only; an existing one keeps what it has.
      return record ? next : applyDefaults(next, chosen);
    });
  }

  // The account select shows the account whose details the invoice carries; details that match
  // no account (edited or deleted since) stay as they are under their own entry.
  const matching = accounts.find(
    (account) =>
      account.iban === form.iban &&
      (account.bic ?? "") === form.bic &&
      (account.accountHolder ?? "") === form.accountHolder,
  );
  const accountValue = matching?.id ?? (form.iban ? SNAPSHOT : "");
  function chooseAccount(event: { target: { value: string } }) {
    const value = event.target.value;
    if (value === SNAPSHOT) return;
    setServerErrors({});
    setForm((current) =>
      withAccount(current, accounts.find((account) => account.id === value) ?? null),
    );
  }

  const terms = formTerms(form);
  const computedDueDate = effectiveDueDate({ ...form, dueDateCustom: false }, today);
  // Clearing the terms keeps the date they gave as a plain date.
  function changeTerms(changes: { termsKind?: string; termsDays?: string }) {
    const clearing = changes.termsKind === "" && terms !== null && !form.dueDateCustom;
    patch({
      ...changes,
      ...(clearing ? { dueDate: computedDueDate, dueDateCustom: false } : {}),
    } as Partial<InvoiceForm>);
  }

  function setLines(lines: LineForm[]) {
    patch({ lines, naturaTexts: naturaTextsFor(lines, form.naturaTexts) });
  }

  const refresh = async (id: string) => {
    await queryClient.invalidateQueries({ queryKey: ["next-number"] });
    await queryClient.invalidateQueries({ queryKey: ["invoices"] });
    await queryClient.invalidateQueries({ queryKey: ["invoice", id] });
  };

  const save = useMutation({
    mutationFn: (body: unknown) => (record ? updateInvoice(record.id, body) : createInvoice(body)),
    onSuccess: async ({ invoice }) => {
      await refresh(invoice.id);
      if (record) toast.success(t("invoice.saved"));
      else void navigate({ to: "/invoices/$invoiceId", params: { invoiceId: invoice.id } });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "bad_request") {
        setServerErrors(fieldErrorsFromDetail(error.problem.detail));
      } else if (error instanceof ApiError && error.status === 409) {
        toast.error(t("invoice.errors.locked"));
      } else {
        toast.error(t("common.error"));
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
    onError: () => toast.error(t("invoice.reserved.releaseFailed")),
  });

  // The PDF is rendered in the browser; the tab is opened by the click itself (see previewPdf).
  // The link below stays as a reliable way to get the file when the viewer stays blank.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const preview = useMutation({
    mutationFn: (id: string) =>
      previewPdf(() => renderInvoicePdfFor(id), `invoice-${record?.number ?? id}.pdf`),
    onSuccess: ({ url }) => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(url);
    },
    onError: () => toast.error(t("invoice.pdf.failed")),
  });

  const [sendOpen, setSendOpen] = useState(false);
  const [sendChannel, setSendChannel] = useState<"pec" | "manual">("pec");
  // Saves what is on screen first, so the number is reserved for exactly what the owner reviewed.
  async function startSend(channel: "pec" | "manual" = "pec") {
    if (!record || !structural.ok) return;
    try {
      await save.mutateAsync(structural.body);
      setSendChannel(channel);
      setSendOpen(true);
    } catch {
      // The save banner already shows why.
    }
  }

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
  const typed = typedNumber(numberText);
  const gapFrom = proposal ?? 0;
  const numberGap =
    typed !== null && proposal !== null && typed > proposal
      ? { from: gapFrom, to: typed - 1 }
      : null;
  let numberError: string | undefined;
  if (numberTaken) {
    numberError = t("invoice.document.numberUnavailable", { next: proposal ?? "" });
  } else if (issuing.errors.requestedNumber === "number_too_low") {
    numberError = t("invoice.document.numberTooLow", { next: proposal ?? "" });
  } else {
    numberError = err("requestedNumber");
  }
  const clientProblems = Object.keys(issuing.errors).filter((path) => path.startsWith("client."));
  const credit = form.documentType === "TD04";

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

      {record?.number && record.state !== "draft" && record.state !== "planned" ? (
        <InvoiceDetail
          record={record}
          clientName={client?.name ?? record.clientName ?? ""}
          totalLabel={formatMoney(record.totalCents ?? 0, locale, record.currency)}
        />
      ) : null}

      {previewUrl ? (
        <Banner tone="info">
          {t("invoice.pdf.ready")}{" "}
          <a
            className="font-medium underline"
            href={previewUrl}
            download={`invoice-${record?.number ?? "preview"}.pdf`}
          >
            {t("invoice.pdf.download")}
          </a>
        </Banner>
      ) : null}
      {!online ? <Banner tone="warning">{t("offline.reason")}</Banner> : null}
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
              <li key={`${error.code}-${error.description}`}>{sdiErrorLine(t, error)}</li>
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
            <p key={`${error.code}-${error.description}`}>{sdiErrorLine(t, error)}</p>
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
      {submitted && !structural.ok ? <Banner tone="danger">{t("invoice.fixErrors")}</Banner> : null}
      {warning ? <Banner tone="warning">{t(`invoice.warnings.${warning}`)}</Banner> : null}
      {numberEditable && numberGap ? (
        <Banner tone="warning">
          {t(
            numberGap.from === numberGap.to
              ? "invoice.document.numberGapOne"
              : "invoice.document.numberGap",
            { ...numberGap, year },
          )}
        </Banner>
      ) : null}
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
            <Field
              label={t("invoice.document.number")}
              hint={
                numberEditable
                  ? t("invoice.document.numberHint", { year })
                  : t("invoice.document.numberAssigned")
              }
              error={numberEditable ? numberError : undefined}
            >
              {(c) => (
                <Input
                  {...c}
                  inputMode="numeric"
                  value={numberEditable ? numberText : (record?.number ?? "")}
                  disabled={!numberEditable}
                  onChange={(event) => {
                    setNumberTouched(true);
                    setNumberTaken(false);
                    patch({ requestedNumber: event.target.value });
                  }}
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
                  <option value="rivalsa_inps">{cassaTypeLabel("rivalsa_inps", locale)}</option>
                  {CASSA_TYPE_CODES.map((code) => (
                    <option key={code} value={code}>
                      {cassaTypeLabel(code, locale)}
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
                      {ritenutaTypeLabel(code, locale)}
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
            <Field
              label={t("clients.form.ritenutaBase")}
              hint={t("clients.form.withholdingBaseHint")}
              error={err("data.ritenuta.baseBp")}
            >
              {(c) => (
                <Input
                  {...c}
                  value={form.ritenutaBase}
                  inputMode="decimal"
                  disabled={locked || !form.ritenutaType}
                  onChange={text("ritenutaBase")}
                />
              )}
            </Field>
            <Field label={t("clients.form.ritenutaCausale")} error={err("data.ritenuta.causale")}>
              {(c) => (
                <Select
                  {...c}
                  value={form.ritenutaCausale}
                  disabled={locked || !form.ritenutaType}
                  onChange={text("ritenutaCausale")}
                >
                  {CAUSALE_PAGAMENTO_CODES.map((code) => (
                    <option key={code} value={code}>
                      {causalePagamentoLabel(code, locale)}
                    </option>
                  ))}
                </Select>
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
            <Field
              label={t("invoice.payment.account")}
              error={err("data.payment.iban") ?? err("data.payment.bic")}
              {...(accounts.length === 0 ? { hint: t("invoice.payment.noAccounts") } : {})}
            >
              {(c) => (
                <Select {...c} value={accountValue} onChange={chooseAccount}>
                  <option value="">{t("clients.form.none")}</option>
                  {accountValue === SNAPSHOT ? (
                    <option value={SNAPSHOT}>
                      {t("invoice.payment.accountSaved")} · {maskIban(form.iban)}
                    </option>
                  ) : null}
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label} · {maskIban(account.iban)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <PaymentTermsFields
              kind={form.termsKind}
              days={form.termsDays}
              onChange={changeTerms}
              kindError={err("data.payment.terms.kind")}
              daysError={err("data.payment.terms.days")}
            />
            {terms ? (
              <Field label={t("paymentTerms.dueMode")}>
                {(c) => (
                  <Select
                    {...c}
                    value={form.dueDateCustom ? "custom" : "terms"}
                    onChange={(e) =>
                      patch(
                        e.target.value === "custom"
                          ? { dueDateCustom: true, dueDate: computedDueDate }
                          : { dueDateCustom: false },
                      )
                    }
                  >
                    <option value="terms">{t("paymentTerms.mode_terms")}</option>
                    <option value="custom">{t("paymentTerms.mode_custom")}</option>
                  </Select>
                )}
              </Field>
            ) : null}
            <Field
              label={t("invoice.document.dueDate")}
              error={err("dueDate")}
              {...(terms && !form.dueDateCustom ? { hint: t("paymentTerms.computed") } : {})}
            >
              {(c) =>
                terms && !form.dueDateCustom ? (
                  <Input {...c} type="date" value={computedDueDate} readOnly />
                ) : (
                  <Input {...c} type="date" value={form.dueDate} onChange={text("dueDate")} />
                )
              }
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
              <Button
                type="button"
                variant="secondary"
                disabled={!online || !record || !send.ready || !issuing.ok || save.isPending}
                title={record ? undefined : t("send.saveFirst")}
                onClick={() => void startSend("pec")}
              >
                <Send aria-hidden />
                {t(
                  record?.state === "rejected"
                    ? "invoice.actions.fixResend"
                    : "invoice.actions.send",
                )}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={
                  !online ||
                  !record ||
                  send.reasons.includes("profile_incomplete") ||
                  !issuing.ok ||
                  save.isPending
                }
                title={record ? undefined : t("send.saveFirst")}
                onClick={() => void startSend("manual")}
              >
                <Upload aria-hidden />
                {t("invoice.actions.prepareManual")}
              </Button>
            </>
          )
        }
      />

      {record ? (
        <SendSheet
          invoiceId={record.id}
          open={sendOpen}
          onOpenChange={setSendOpen}
          channel={sendChannel}
          onError={(error) => {
            if (error instanceof ApiError && error.code === "number_unavailable") {
              // Nothing was reserved: show it next to the Number field with the new proposal.
              setNumberTaken(true);
              setSendOpen(false);
              void queryClient.invalidateQueries({ queryKey: ["next-number"] });
            }
          }}
          summary={{
            client: client?.name ?? "",
            number: record.number ?? "",
            total: formatMoney(
              totals?.amountDueCents ?? 0,
              locale,
              form.currency.toUpperCase() || "EUR",
            ),
          }}
          onSent={() => {
            setSendOpen(false);
            void navigate({ to: "/invoices/$invoiceId", params: { invoiceId: record.id } });
          }}
        />
      ) : null}

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
      toast.success(t("invoice.saved"));
    },
    onError: () => toast.error(t("common.error")),
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
          {sdiErrorLine(t, error)}
        </p>
      ))}
    </div>
  );
}
