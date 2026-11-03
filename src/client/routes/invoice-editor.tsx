import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Copy, Download, FileMinus, Pencil, Send, Trash2 } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClientRecord } from "../../shared/client";
import { romeDateTime } from "../../shared/cron";
import { ApiError } from "../../shared/errors";
import { formatDate, formatMoney, type UiLocale } from "../../shared/format";
import {
  bolloSuggestion,
  EMPTY_INVOICE_DATA,
  type InvoiceRecord,
  invoiceEditability,
  PAYMENT_METHODS,
  SDI_ERROR_FIELDS,
  transmissionTermWarning,
} from "../../shared/invoice";
import { formatInvoiceNumber, type NumberingSeriesRecord } from "../../shared/numbering";
import type { SendReadiness } from "../../shared/onboarding";
import { maskIban, type PaymentMethodRecord } from "../../shared/payment-method";
import { RITENUTA_TYPES, type TaxOptions } from "../../shared/tax";
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
import { type Preflight, SendSheet } from "../components/send-sheet";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { Disclosure } from "../components/ui/disclosure";
import { Field } from "../components/ui/field";
import { GroupBox } from "../components/ui/group-box";
import { Input } from "../components/ui/input";
import { MenuButton } from "../components/ui/menu-button";
import { Select } from "../components/ui/select";
import { StatusBadge } from "../components/ui/status-badge";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toast";
import { INVOICE_LIST_BACK } from "../lib/back-links";
import { clientsQuery } from "../lib/clients-api";
import { type FinalizeProblem, finalizeProblems, focusField } from "../lib/finalize-checks";
import { downloadUrl } from "../lib/invoice-download";
import {
  applyDefaults,
  draftBody,
  effectiveDueDate,
  emptyForm,
  formLineAmounts,
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
import { sdiErrorLine } from "../lib/sdi-error";
import {
  fieldErrorsFromDetail,
  numberingSeriesQuery,
  onboardingQuery,
  paymentMethodsQuery,
  profileQuery,
  taxQuery,
} from "../lib/settings-api";
import { useDirty } from "../lib/use-dirty";

/** Select value for payment details that match no current account. */
const SNAPSHOT = "__snapshot__";
const REQUIRED_LIKE = new Set(["required", "natura_text_required"]);

export function InvoiceEditorPage() {
  const { t } = useTranslation();
  const { invoiceId } = useParams({ strict: false }) as { invoiceId?: string };
  const clients = useQuery(clientsQuery);
  const profile = useQuery(profileQuery);
  const accounts = useQuery(paymentMethodsQuery);
  const numbering = useQuery(numberingSeriesQuery);
  const onboarding = useQuery(onboardingQuery);
  const tax = useQuery(taxQuery);
  const record = useQuery({
    ...invoiceQuery(invoiceId ?? ""),
    enabled: invoiceId !== undefined,
  });

  const failed =
    clients.isError ||
    profile.isError ||
    accounts.isError ||
    numbering.isError ||
    tax.isError ||
    (invoiceId !== undefined && record.isError);
  const ready =
    clients.data &&
    profile.data &&
    accounts.data &&
    numbering.data &&
    tax.data &&
    (invoiceId === undefined || record.data) &&
    onboarding.data;

  if (
    ready &&
    clients.data &&
    profile.data &&
    accounts.data &&
    numbering.data &&
    tax.data &&
    onboarding.data
  ) {
    return (
      <EditorForm
        key={record.data?.invoice.id ?? "new"}
        record={record.data?.invoice ?? null}
        clients={clients.data.clients}
        accounts={accounts.data.paymentMethods}
        series={numbering.data.series}
        tax={tax.data.tax}
        send={onboarding.data.send}
      />
    );
  }

  return (
    <Page title={t(invoiceId ? "invoice.editTitle" : "invoice.newTitle")} back={INVOICE_LIST_BACK}>
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
                void numbering.refetch();
                void tax.refetch();
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
      {!failed ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
    </Page>
  );
}

interface EditorFormProps {
  record: InvoiceRecord | null;
  clients: ClientRecord[];
  accounts: PaymentMethodRecord[];
  series: NumberingSeriesRecord[];
  tax: TaxOptions;
  send: SendReadiness;
}

function EditorForm({ record, clients, accounts, series, tax, send }: EditorFormProps) {
  const { t, i18n } = useTranslation();
  const locale: UiLocale = i18n.language.startsWith("it") ? "it" : "en";
  const online = useOnline();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const today = romeDateTime(new Date()).date;

  const [initialForm] = useState<InvoiceForm>(() =>
    record
      ? fromRecord(record)
      : withAccount(
          applyDefaults({ ...emptyForm(), invoiceDate: today }, null, tax),
          accounts.find((account) => account.isDefault) ?? null,
        ),
  );
  const [form, setForm] = useState<InvoiceForm>(initialForm);
  // Save is enabled once the form differs from what was loaded or last saved.
  const { dirty, markSaved } = useDirty(initialForm, form);
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [clientSheet, setClientSheet] = useState<"new" | "edit" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const editability = record ? invoiceEditability(record.state) : "full";
  const locked = editability === "locked";
  // Not finalised yet: no number, freely editable and deletable.
  const unsent = record?.state === "draft" || record?.state === "planned";
  const client = clients.find((c) => c.id === form.clientId) ?? null;

  // The number is chosen here until it is reserved; from then on it is shown read-only.
  const numberEditable = editability === "full" && !record?.number;
  const year = Number(today.slice(0, 4));
  // The invoice's series; a series that no longer exists falls back to the default one.
  const defaultSeries = series.find((s) => s.isDefault) ?? series[0] ?? null;
  const activeSeries = series.find((s) => s.id === form.seriesId) ?? defaultSeries;
  const nextNumber = useQuery({
    ...nextNumberQuery(year, activeSeries?.id ?? null),
    enabled: numberEditable,
  });
  const proposal = nextNumber.data?.next ?? null;
  const [extrasChoice, setExtrasChoice] = useState<boolean | null>(null);
  const [numberTouched, setNumberTouched] = useState(false);
  const [numberTaken, setNumberTaken] = useState(false);
  const numberText = numberTouched
    ? form.requestedNumber
    : form.requestedNumber || (proposal === null ? "" : String(proposal));

  const totals = useMemo(() => formTotals(form), [form]);
  const lineAmounts = useMemo(() => formLineAmounts(form), [form]);
  const issuing = useMemo(
    () => validateForm(form, client, true, proposal, today),
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
    // A missing VAT shows as soon as the line has content, not on an untouched new line.
    if (code === "vat_required" && !server && !submitted) {
      const line = form.lines[Number(path.split(".")[1])];
      if (!line || (line.description.trim() === "" && line.price.trim() === "")) return undefined;
    }
    return t(`validation.${code}`, { defaultValue: t("validation.invalid") });
  };

  // Contribution, withholding and stamp duty sit in a disclosure that starts closed unless one of
  // them is on or has an error; a click of the owner then decides.
  const extrasActive = form.cassaType !== "" || form.ritenutaType !== "" || form.bollo;
  const extrasError = [...Object.keys(serverErrors), ...Object.keys(issuing.errors)].some(
    (path) => (path.startsWith("data.cassa") || path.startsWith("data.ritenuta")) && err(path),
  );
  const extrasOpen = extrasError || (extrasChoice ?? extrasActive);
  const extrasParts: string[] = [];
  if (form.cassaType) {
    const code =
      form.cassaType === "rivalsa_inps" ? t("invoice.extras.summaryRivalsa") : form.cassaType;
    extrasParts.push(form.cassaRate ? `${code} ${form.cassaRate}%` : code);
  }
  if (form.ritenutaType) {
    const rate = form.ritenutaRate || "?";
    extrasParts.push(
      form.ritenutaBase && form.ritenutaBase !== "100"
        ? t("invoice.extras.summaryBase", {
            type: form.ritenutaType,
            rate,
            base: form.ritenutaBase,
          })
        : `${form.ritenutaType} ${rate}%`,
    );
  }
  if (form.bollo) extrasParts.push(t("invoice.extras.summaryBollo"));
  const extrasSummaryText =
    extrasParts.length > 0 ? extrasParts.join(" · ") : t("invoice.extras.none");

  function selectClient(chosen: ClientRecord | null) {
    setForm((current) => {
      const next = { ...current, clientId: chosen?.id ?? "" };
      // Defaults prefill a new invoice only; an existing one keeps what it has.
      return record ? next : applyDefaults(next, chosen, tax);
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

  // A new invoice created by Finalize stays on this page until the flow ends; later saves update it.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const savedId = record?.id ?? createdId;
  const save = useMutation({
    mutationFn: ({ body }: { body: unknown; form: InvoiceForm; quiet?: boolean }) =>
      savedId ? updateInvoice(savedId, body) : createInvoice(body),
    onSuccess: async ({ invoice }, { quiet, form: submitted }) => {
      markSaved(submitted);
      await refresh(invoice.id);
      if (quiet) setCreatedId(invoice.id);
      else if (record) toast.success(t("invoice.saved"));
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

  // Finalize: the checks run first (nothing is saved, numbered or sent when one fails), then what
  // is on screen is saved and the send flow goes on. Without a ready PEC the invoice is finalised
  // for the manual AdE channel (the XML is stored for the portal) instead of being sent.
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const channel = send.ready ? "pec" : "manual";
  async function preflight(): Promise<Preflight> {
    setSubmitted(true);
    const problems = finalizeProblems(t, {
      errors: issuing.errors,
      nextNumber: proposal,
      online,
      profileIncomplete: send.reasons.includes("profile_incomplete"),
    });
    if (problems.length > 0) return { ok: false, problems };
    const { invoice } = await save.mutateAsync({
      body: draftBody(form, proposal, today),
      form,
      quiet: true,
    });
    return { ok: true, invoiceId: invoice.id };
  }
  function showProblem(problem: FinalizeProblem) {
    setFinalizeOpen(false);
    // The dialog closes first (it restores the focus), then the field takes it.
    window.setTimeout(() => focusField(document, problem.field ?? ""), 0);
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
    // Saving never validates: whatever is typed is stored, and Finalize runs every check.
    setSubmitted(true);
    save.mutate({ body: draftBody(form, proposal, today), form });
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
  const lateTransmission = transmissionTermWarning({
    invoiceDate: record?.issueDate ? null : form.invoiceDate || null,
    sendDate: today,
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

  // The number as it will be printed: the assigned one, else the proposal or the typed number.
  let printedNumber: string | null = null;
  if (record?.number) {
    printedNumber = t("invoice.numberYear", { number: record.number, year: record.year });
  } else if (numberEditable && typed !== null && !Number.isNaN(typed)) {
    printedNumber = t("invoice.numberYear", {
      number: activeSeries ? formatInvoiceNumber(activeSeries, typed) : typed,
      year,
    });
  }

  // An unsent invoice has one action, Finalize; once finalised the stored files are offered.
  const downloadItems = (["pdf", "xml"] as const).map((kind) => ({
    key: kind,
    label: kind.toUpperCase(),
    disabled: !online,
    reason: online ? undefined : t("offline.reason"),
    onSelect: () => record && downloadUrl(`/api/invoices/${record.id}/${kind}`),
  }));
  const finalizable = !locked;
  const titleActions = (
    <>
      {record && !unsent ? (
        <MenuButton
          label={t("invoice.actions.download")}
          icon={<Download aria-hidden />}
          items={downloadItems}
        />
      ) : null}
      {finalizable ? (
        <Button
          type="button"
          disabled={!online || save.isPending}
          title={online ? undefined : t("offline.reason")}
          onClick={() => setFinalizeOpen(true)}
        >
          <Send aria-hidden />
          {t(
            record?.state === "rejected" ? "invoice.actions.fixResend" : "invoice.actions.finalize",
          )}
        </Button>
      ) : null}
    </>
  );

  return (
    <Page
      title={t(record ? "invoice.editTitle" : "invoice.newTitle")}
      subtitle={printedNumber}
      aside={titleActions}
      back={INVOICE_LIST_BACK}
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
        {record ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <StatusBadge status={record.state} />
            {record.issueDate ? (
              <span className="text-muted-foreground">
                {t("invoice.issuedOn", { date: formatDate(record.issueDate, locale) })}
              </span>
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
        {lateTransmission ? <Banner tone="warning">{t("invoice.warnings.late")}</Banner> : null}
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
          <section className="flex flex-col gap-4" aria-label={t("invoice.client.label")}>
            <div className="flex flex-wrap items-end gap-3">
              <Field
                label={t("invoice.client.label")}
                error={err("clientId")}
                name="clientId"
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
            <div className="grid gap-4 sm:grid-cols-2">
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
              <Field label={t("invoice.document.currency")} error={err("currency")} name="currency">
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
              {series.length > 0 ? (
                <Field label={t("invoice.document.series")}>
                  {(c) => (
                    <Select
                      {...c}
                      value={activeSeries?.id ?? ""}
                      disabled={!numberEditable}
                      onChange={(event) => {
                        setNumberTouched(false);
                        setNumberTaken(false);
                        patch({ seriesId: event.target.value, requestedNumber: "" });
                      }}
                    >
                      {series.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : null}
              <Field
                label={t("invoice.document.number")}
                hint={
                  numberEditable
                    ? activeSeries &&
                      (activeSeries.prefix || activeSeries.suffix) &&
                      typed !== null &&
                      !Number.isNaN(typed)
                      ? formatInvoiceNumber(activeSeries, typed)
                      : undefined
                    : t("invoice.document.numberAssigned")
                }
                error={numberEditable ? numberError : undefined}
                name="requestedNumber"
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
              <Field
                label={t("invoice.document.invoiceDate")}
                hint={t("invoice.document.invoiceDateHint")}
                error={err("invoiceDate")}
                name="invoiceDate"
              >
                {(c) => (
                  <Input
                    {...c}
                    type="date"
                    value={form.invoiceDate}
                    disabled={locked || editability === "rejected"}
                    onChange={text("invoiceDate")}
                  />
                )}
              </Field>
              {credit ? (
                <Field
                  label={t("invoice.document.linked")}
                  error={err("linkedInvoiceId")}
                  name="linkedInvoiceId"
                >
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
          </section>

          <Disclosure
            id="inv-extras"
            title={t("invoice.extras.title")}
            summary={extrasSummaryText}
            open={extrasOpen}
            onToggle={() => setExtrasChoice(!extrasOpen)}
          >
            <GroupBox title={t("clients.form.pensionFund")}>
              <Field
                label={t("clients.form.cassa")}
                error={err("data.cassa.type")}
                name="data.cassa.type"
              >
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
              {form.cassaType ? (
                <div className="flex flex-col gap-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label={t("clients.form.cassaRate")}
                      error={err("data.cassa.rateBp")}
                      name="data.cassa.rateBp"
                    >
                      {(c) => (
                        <Input
                          {...c}
                          value={form.cassaRate}
                          suffix="%"
                          inputMode="decimal"
                          disabled={locked}
                          onChange={text("cassaRate")}
                        />
                      )}
                    </Field>
                    <Field label={t("clients.form.cassaMode")}>
                      {(c) => (
                        <Select
                          {...c}
                          value={form.cassaMode}
                          disabled={locked}
                          onChange={text("cassaMode")}
                        >
                          <option value="excluded">{t("clients.form.modeExcluded")}</option>
                          <option value="included">{t("clients.form.modeIncluded")}</option>
                        </Select>
                      )}
                    </Field>
                  </div>
                  {form.ritenutaType ? (
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
                </div>
              ) : null}
            </GroupBox>
            <GroupBox title={t("clients.form.withholding")}>
              <Field
                label={t("clients.form.ritenuta")}
                error={err("data.ritenuta.type")}
                name="data.ritenuta.type"
              >
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
              {form.ritenutaType ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label={t("clients.form.ritenutaRate")}
                    error={err("data.ritenuta.rateBp")}
                    name="data.ritenuta.rateBp"
                  >
                    {(c) => (
                      <Input
                        {...c}
                        value={form.ritenutaRate}
                        suffix="%"
                        inputMode="decimal"
                        disabled={locked}
                        onChange={text("ritenutaRate")}
                      />
                    )}
                  </Field>
                  <Field
                    label={t("clients.form.ritenutaBase")}
                    error={err("data.ritenuta.baseBp")}
                    name="data.ritenuta.baseBp"
                  >
                    {(c) => (
                      <Input
                        {...c}
                        value={form.ritenutaBase}
                        suffix="%"
                        inputMode="decimal"
                        disabled={locked}
                        onChange={text("ritenutaBase")}
                      />
                    )}
                  </Field>
                  <Field
                    label={t("clients.form.ritenutaCausale")}
                    error={err("data.ritenuta.causale")}
                    name="data.ritenuta.causale"
                    className="sm:col-span-2"
                  >
                    {(c) => (
                      <Select
                        {...c}
                        value={form.ritenutaCausale}
                        disabled={locked}
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
              ) : null}
            </GroupBox>
            <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
              <input
                type="checkbox"
                className="size-5"
                checked={form.bollo}
                onChange={(e) => patch({ bollo: e.target.checked })}
              />
              {t("invoice.extras.bollo")}
            </label>
          </Disclosure>

          <section className="flex flex-col gap-4" aria-labelledby="inv-lines">
            <h2 id="inv-lines" className="text-base font-medium">
              {t("invoice.lines.title")}
            </h2>
            <SdiNotes record={record} field="lines" />
            <InvoiceLines
              form={form}
              amounts={lineAmounts}
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
                    name={`data.naturaTexts.${code}`}
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
            <Field
              label={t("invoice.document.note")}
              hint={t("invoice.document.noteHint")}
              error={err("data.note")}
              name="data.note"
            >
              {(c) => (
                <Textarea
                  {...c}
                  value={form.invoiceNote}
                  disabled={locked}
                  onChange={text("invoiceNote")}
                />
              )}
            </Field>
          </section>

          <section className="flex flex-col gap-4" aria-labelledby="inv-payment">
            <h2 id="inv-payment" className="text-base font-medium">
              {t("invoice.payment.title")}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t("invoice.payment.method")}
                error={err("data.payment.method")}
                name="data.payment.method"
              >
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
                name="data.payment.iban"
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
                name="dueDate"
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
        </fieldset>

        {record && (locked || record.state === "rejected") ? (
          <PaymentSection key={record.paymentFlag + record.paidDate} record={record} />
        ) : null}

        {!locked && !send.ready ? (
          <Banner tone="warning">
            <p className="font-medium">{t("onboarding.sendBlocked")}</p>
            <ul className="list-disc pl-5">
              {send.reasons.map((reason) => (
                <li key={reason}>{t(`onboarding.reasons.${reason}`)}</li>
              ))}
            </ul>
            {send.reasons.includes("profile_incomplete") ? null : (
              <p>{t("finalize.manualInstead")}</p>
            )}
          </Banner>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {record && unsent && !confirmDelete ? (
            <Button
              variant="ghost"
              className="mr-auto text-danger"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 aria-hidden />
              {t("invoice.actions.delete")}
            </Button>
          ) : null}
          {record && unsent && confirmDelete ? (
            <Button
              variant="destructive"
              className="mr-auto"
              disabled={!online || remove.isPending}
              onClick={() => remove.mutate(record.id)}
            >
              {t("invoice.actions.deleteConfirm")}
            </Button>
          ) : null}
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
          {locked ? null : (
            <Button type="submit" disabled={!online || !dirty || save.isPending}>
              {t("invoice.actions.save")}
            </Button>
          )}
        </div>

        <InvoiceTotals totals={totals} form={form} locale={locale} />

        <SendSheet
          invoiceId={record?.id ?? null}
          open={finalizeOpen}
          onOpenChange={setFinalizeOpen}
          channel={channel}
          preflight={preflight}
          onProblem={showProblem}
          onError={(error) => {
            if (error instanceof ApiError && error.code === "number_unavailable") {
              // Nothing was reserved: show it next to the Number field with the new proposal.
              setNumberTaken(true);
              setFinalizeOpen(false);
              void queryClient.invalidateQueries({ queryKey: ["next-number"] });
            }
          }}
          summary={{
            client: client?.name ?? "",
            number: record?.number ?? "",
            total: formatMoney(
              totals?.amountDueCents ?? 0,
              locale,
              form.currency.toUpperCase() || "EUR",
            ),
          }}
          onSent={(id) => {
            setFinalizeOpen(false);
            void navigate({ to: "/invoices/$invoiceId", params: { invoiceId: id } });
          }}
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
    </Page>
  );
}

/** Payment flag: what still changes once an invoice is out. */
function PaymentSection({ record }: { record: InvoiceRecord }) {
  const { t } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const [paid, setPaid] = useState(record.paymentFlag === "paid");
  const [paidDate, setPaidDate] = useState(record.paidDate ?? "");
  const { dirty, markSaved } = useDirty(
    { paid: record.paymentFlag === "paid", paidDate: record.paidDate ?? "" },
    { paid, paidDate: paid ? paidDate : "" },
  );

  const save = useMutation({
    mutationFn: () =>
      patchInvoice(record.id, {
        paymentFlag: paid ? "paid" : "unpaid",
        paidDate: paid && paidDate ? paidDate : null,
      }),
    onSuccess: async () => {
      markSaved({ paid, paidDate: paid ? paidDate : "" });
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
      <Button
        className="w-fit"
        variant="secondary"
        disabled={!online || !dirty || save.isPending}
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
