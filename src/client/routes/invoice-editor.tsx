import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  CircleCheck,
  CircleX,
  Copy,
  Download,
  Ellipsis,
  Eye,
  FileMinus,
  Mail,
  Pencil,
  Send,
  Trash2,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
  safeTotals,
  transmissionTermWarning,
} from "../../shared/invoice";
import {
  formatInvoiceNumber,
  formatNumberWithYear,
  matchSeries,
  type NumberingSeriesRecord,
  progressiveIn,
} from "../../shared/numbering";
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
import { CourtesyEmail, canSendCourtesyEmail } from "../components/courtesy-email";
import { InvoiceDetail } from "../components/invoice-detail";
import { InvoiceLines } from "../components/invoice-lines";
import { InvoiceTotals } from "../components/invoice-totals";
import { Page } from "../components/page";
import { PaymentDialog } from "../components/payment-action";
import { PaymentTermsFields } from "../components/payment-terms-fields";
import { type Preflight, SendSheet } from "../components/send-sheet";
import { StoredInvoiceView } from "../components/stored-invoice-view";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { DatePicker } from "../components/ui/date-picker";
import { Disclosure } from "../components/ui/disclosure";
import { Field } from "../components/ui/field";
import { GroupBox } from "../components/ui/group-box";
import { Input } from "../components/ui/input";
import { MenuButton, type MenuItem } from "../components/ui/menu-button";
import { Select } from "../components/ui/select";
import { Sheet, SheetFooter } from "../components/ui/sheet";
import { ImportedBadge, StatusBadge } from "../components/ui/status-badge";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toast";
import { UnsavedChangesGuard } from "../components/unsaved-changes-guard";
import type { SeedSource } from "../import/imported-seed";
import { INVOICE_LIST_BACK } from "../lib/back-links";
import { clientsQuery } from "../lib/clients-api";
import { type FinalizeProblem, finalizeProblems, focusField } from "../lib/finalize-checks";
import { downloadBytes, downloadUrl } from "../lib/invoice-download";
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
  importedBody,
  type LineForm,
  naturaTextsFor,
  typedNumber,
  validateForm,
  withAccount,
} from "../lib/invoice-form";
import { buildInvoiceView } from "../lib/invoice-view";
import {
  createCreditNote,
  createInvoice,
  deleteInvoice,
  duplicateInvoice,
  invoiceQuery,
  invoicesQuery,
  nextNumberQuery,
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
import { renderPreviewPdf } from "../pdf/generate";

/** Select value for payment details that match no current account. */
const SNAPSHOT = "__snapshot__";
/** Invoices just duplicated: they open straight in edit mode, once (read when the page mounts). */
const OPEN_IN_EDIT = new Set<string>();

/**
 * What an imported invoice that was never edited starts from: the form built in the browser from
 * its original (see `seedImportedForm`). `onLeave` puts the page back on the file view (Cancel).
 */
export interface EditorSeed {
  form: InvoiceForm;
  source: SeedSource;
  onLeave?: (() => void) | undefined;
}

export function InvoiceEditorPage({ seed }: { seed?: EditorSeed | undefined } = {}) {
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
        seed={seed}
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
  seed: EditorSeed | undefined;
}

function EditorForm({ record, clients, accounts, series, tax, send, seed }: EditorFormProps) {
  const { t, i18n } = useTranslation();
  const locale: UiLocale = i18n.language.startsWith("it") ? "it" : "en";
  const online = useOnline();
  const routerNavigate = useNavigate();
  // Every navigation the editor starts itself is allowed past the unsaved-changes guard.
  const navigate = ((options: Parameters<typeof routerNavigate>[0]) => {
    leaving.current = true;
    return routerNavigate(options);
  }) as typeof routerNavigate;
  const queryClient = useQueryClient();
  const today = romeDateTime(new Date()).date;

  const [initialForm] = useState<InvoiceForm>(() =>
    seed
      ? seed.form
      : record
        ? fromRecord(record, clients)
        : withAccount(
            applyDefaults({ ...emptyForm(), invoiceDate: today }, null, tax),
            accounts.find((account) => account.isDefault) ?? null,
          ),
  );
  const [form, setForm] = useState<InvoiceForm>(initialForm);
  // What is stored: Cancel puts it back. Save is enabled once the form differs from it.
  const [stored, setStored] = useState<InvoiceForm>(initialForm);
  const { dirty, markSaved } = useDirty(initialForm, form);
  // View mode shows the invoice read-only; a new or just duplicated invoice opens in edit mode.
  const [editing, setEditing] = useState(
    () => !record || OPEN_IN_EDIT.has(record.id) || seed !== undefined,
  );
  // Unsaved edits block leaving the page, except the editor's own navigations (after a save,
  // a confirmed discard, a delete...), which set this flag first.
  const leaving = useRef(false);
  const blockState = useRef(false);
  blockState.current = editing && dirty;
  const shouldBlock = () => {
    if (leaving.current) {
      leaving.current = false;
      return false;
    }
    return blockState.current;
  };
  useEffect(() => {
    if (record) OPEN_IN_EDIT.delete(record.id);
  }, [record]);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // The "⋯" actions menu (where Edit lives) gets the focus back after Save or Cancel.
  const editButton = useRef<HTMLButtonElement>(null);
  const focusEditButton = useRef(false);
  useEffect(() => {
    if (!editing && focusEditButton.current) {
      focusEditButton.current = false;
      editButton.current?.focus();
    }
  }, [editing]);
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [clientSheet, setClientSheet] = useState<"new" | "edit" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);

  const editability = record ? invoiceEditability(record.state) : "full";
  // An imported invoice counts as sent for good, yet everything in it can be edited: no number to
  // reserve, nothing to finalise or send, no delete.
  const imported = record?.source === "imported";
  const locked = editability === "locked" && !imported;
  // Fields are read-only in view mode and once the invoice is finalised.
  const readOnly = locked || !editing;
  // Not finalised yet: no number, freely editable and deletable.
  const unsent = record?.state === "draft" || record?.state === "planned";
  // A rejected invoice (also once its term expired) was never issued, so there is nothing to pay; credit notes neither.
  const payable =
    record !== null &&
    record !== undefined &&
    !unsent &&
    record.state !== "rejected" &&
    record.state !== "rejected_expired" &&
    record.documentType !== "TD04";
  const client = clients.find((c) => c.id === form.clientId) ?? null;

  // The number is chosen here until it is reserved; from then on it is shown read-only.
  const numberEditable = editability === "full" && !record?.number;
  // The day the invoice will be issued with, and so its numbering year: its own date when that is
  // not in the future (an invoice dated 31/12 and sent in January is still of the old year), else
  // today. The Worker decides the same way when it reserves the number.
  const issueDateNow = form.invoiceDate && form.invoiceDate <= today ? form.invoiceDate : today;
  const year = Number(issueDateNow.slice(0, 4));
  // The invoice's series; a series that no longer exists falls back to the default one.
  const defaultSeries = series.find((s) => s.isDefault) ?? series[0] ?? null;
  const activeSeries = series.find((s) => s.id === form.seriesId) ?? defaultSeries;
  // An imported invoice whose stored number is prefix + digits + suffix of its series is edited as
  // a plain number: the series adds the prefix and suffix (1 + "/CH" prints "1/CH"). Decided from the
  // stored invoice, so typing never switches mode; any other (free text) number is edited as text.
  const storedSeries = record ? series.find((s) => s.id === record.seriesId) : undefined;
  const importedPlainNumber =
    imported &&
    storedSeries !== undefined &&
    progressiveIn(record?.number ?? "", storedSeries) !== null;
  const importedProgressive =
    importedPlainNumber && activeSeries ? progressiveIn(form.requestedNumber, activeSeries) : null;
  const nextNumber = useQuery({
    ...nextNumberQuery(year, activeSeries?.id ?? null),
    enabled: numberEditable,
  });
  const proposal = nextNumber.data?.next ?? null;
  // A new number may not be dated before the last one issued in its series (same year).
  const lastIssued = numberEditable ? (nextNumber.data?.lastIssueDate ?? null) : null;
  const dateBeforeLast =
    lastIssued && lastIssued.slice(0, 4) === issueDateNow.slice(0, 4) && issueDateNow < lastIssued
      ? formatDate(lastIssued, locale)
      : null;
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
    setConfirmCancel(false);
    setForm((current) => ({ ...current, ...changes }));
  };
  const text = (key: keyof InvoiceForm) => (event: { target: { value: string } }) =>
    patch({ [key]: event.target.value } as Partial<InvoiceForm>);

  // The checks show only after a Finalize attempt (`submitted`): opening or editing an invoice
  // shows none, they stay while editing after that attempt, and Save or Cancel clears them.
  // A refusal from the server (`serverErrors`) always shows.
  const err = (path: string): string | undefined => {
    const server = serverErrors[path];
    const code = server ?? (submitted ? issuing.errors[path] : undefined);
    if (!code) return undefined;
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
      if (!chosen && record) return next;
      // Choosing a client applies everything the invoice inherits from it (currency, language,
      // series, cassa and ritenuta, terms and so the due date), on new and saved invoices alike;
      // all of it stays editable. A number already reserved (a rejected invoice) keeps its series.
      const applied = applyDefaults(next, chosen, tax);
      if (record?.number) return { ...applied, seriesId: current.seriesId };
      return applied.seriesId === current.seriesId ? applied : { ...applied, requestedNumber: "" };
    });
    // A new series proposes its own number, as when the series select changes.
    if (chosen && !record?.number && (chosen.defaults?.seriesId ?? "") !== form.seriesId) {
      setNumberTouched(false);
      setNumberTaken(false);
    }
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
  const computedDueDate = effectiveDueDate(form, today);
  const changeTerms = (changes: { termsKind?: string; termsDays?: string }) =>
    patch(changes as Partial<InvoiceForm>);

  function setLines(lines: LineForm[]) {
    patch({ lines, naturaTexts: naturaTextsFor(lines, form.naturaTexts) });
  }

  const refresh = async (id: string) => {
    await queryClient.invalidateQueries({ queryKey: ["next-number"] });
    await queryClient.invalidateQueries({ queryKey: ["invoices"] });
    await queryClient.invalidateQueries({ queryKey: ["invoice", id] });
  };

  const save = useMutation({
    mutationFn: ({ body }: { body: unknown; form: InvoiceForm; quiet?: boolean }) =>
      record ? updateInvoice(record.id, body) : createInvoice(body),
    onSuccess: async ({ invoice }, { quiet, form: saved }) => {
      markSaved(saved);
      setStored(saved);
      await refresh(invoice.id);
      if (quiet) return;
      setSubmitted(false);
      setServerErrors({});
      if (record) {
        toast.success(t("invoice.saved"));
        focusEditButton.current = true;
        setEditing(false);
      } else {
        // The first save of a new invoice moves to its own page, which opens in view mode.
        void navigate({ to: "/invoices/$invoiceId", params: { invoiceId: invoice.id } });
      }
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "bad_request") {
        setServerErrors(fieldErrorsFromDetail(error.problem.detail));
      } else if (error instanceof ApiError && error.code === "number_unavailable" && imported) {
        setNumberTaken(true);
        toast.error(t("invoice.imported.numberTaken"));
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
      OPEN_IN_EDIT.add(invoice.id);
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
      dateBeforeLast,
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
    // A problem is fixed in edit mode. The dialog closes first (it restores the focus), then the
    // field takes it.
    setEditing(true);
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

  function startEdit() {
    setEditing(true);
    // The first field takes the focus once it is editable.
    window.setTimeout(() => focusField(document, "clientId"), 0);
  }
  function cancelEdit() {
    if (dirty && !confirmCancel) {
      setConfirmCancel(true);
      return;
    }
    setConfirmCancel(false);
    if (!record) {
      void navigate({ to: "/invoices" });
      return;
    }
    if (seed?.onLeave) {
      // Never edited: back to the view of the original file.
      leaving.current = true;
      seed.onLeave();
      return;
    }
    // Back to the stored values, as if nothing had been typed.
    setForm(stored);
    markSaved(stored);
    setServerErrors({});
    setSubmitted(false);
    setNumberTouched(false);
    setNumberTaken(false);
    setExtrasChoice(null);
    focusEditButton.current = true;
    setEditing(false);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (readOnly) return;
    // Saving never validates: whatever is typed is stored, and Finalize runs every check.
    save.mutate({
      body: imported ? importedBody(form, today) : draftBody(form, proposal, today),
      form,
    });
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
  if (imported) {
    numberError = numberTaken ? t("invoice.imported.numberTaken") : err("number");
  } else if (numberTaken) {
    numberError = t("invoice.document.numberUnavailable", { next: proposal ?? "" });
  } else if (submitted && issuing.errors.requestedNumber === "number_too_low") {
    numberError = t("invoice.document.numberTooLow", { next: proposal ?? "" });
  } else {
    numberError = err("requestedNumber");
  }
  // View mode: the compact read-only document of the stored invoice (no fields).
  const storedView = useMemo(
    () =>
      buildInvoiceView(form, {
        client,
        seriesName: series.length > 1 ? (activeSeries?.name ?? null) : null,
        linkedNumber: record?.linked?.number ?? null,
        today,
      }),
    [form, client, series, activeSeries, record?.linked?.number, today],
  );
  const clientProblems = Object.keys(issuing.errors).filter((path) => path.startsWith("client."));
  const credit = form.documentType === "TD04";

  // The number as it will be printed: the assigned one, else the proposal or the typed number.
  let printedNumber: string | null = null;
  if (record?.number) {
    printedNumber = t("invoice.numberYear", {
      number: formatNumberWithYear(record.number, record.year),
    });
  } else if (numberEditable && typed !== null && !Number.isNaN(typed)) {
    printedNumber = t("invoice.numberYear", {
      number: formatNumberWithYear(
        activeSeries ? formatInvoiceNumber(activeSeries, typed) : String(typed),
        year,
      ),
    });
  }

  // "Preview" renders the unsent invoice as saved, with the current profile, client and layout, and
  // the number and date it would get now. Marked as a preview in the browser, never stored.
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewReady =
    record !== null &&
    record !== undefined &&
    typed !== null &&
    !Number.isNaN(typed) &&
    clients.some((c) => c.id === record.clientId) &&
    safeTotals(record) !== null;
  const showPreview = (id: string) => {
    if (typed === null) return;
    setPreviewBusy(true);
    renderPreviewPdf(id, {
      number: formatNumberWithYear(
        activeSeries ? formatInvoiceNumber(activeSeries, typed) : String(typed),
        year,
      ),
      issueDate: issueDateNow,
    })
      .then(({ bytes, fileName }) => downloadBytes(bytes, fileName))
      .catch(() => toast.error(t("invoice.errors.previewFailed")))
      .finally(() => setPreviewBusy(false));
  };
  // An unsent invoice has one action, Finalize; once finalised the stored files are offered.
  const downloadItems = (["pdf", "xml"] as const).map((kind) => ({
    key: kind,
    label: kind.toUpperCase(),
    disabled: !online,
    reason: online ? undefined : t("offline.reason"),
    onSelect: () => record && downloadUrl(`/api/invoices/${record.id}/${kind}`),
  }));
  const finalizable = !locked && !imported;
  const issuedCreditable =
    !imported &&
    record?.documentType === "TD01" &&
    (record.state === "delivered" || record.state === "not_delivered");
  // View mode of an unsent (or rejected) invoice: Duplicate, Delete, Edit, Finalize. Edit mode has
  // no title actions: Cancel and Save are under the form.
  // View mode: Finalize stays a button (the main step for an unsent invoice); every other action
  // is in the "⋯" menu. Edit mode has no title actions: Cancel and Save are under the form.
  const menuItems: MenuItem[] = [];
  if (finalizable || imported) {
    menuItems.push({
      key: "edit",
      label: t("invoice.actions.edit"),
      icon: <Pencil aria-hidden />,
      onSelect: startEdit,
    });
  }
  if (record && unsent) {
    const blocked = !online || !previewReady;
    menuItems.push({
      key: "preview",
      label: t(previewBusy ? "invoice.actions.previewRendering" : "invoice.actions.preview"),
      icon: <Eye aria-hidden />,
      disabled: blocked || previewBusy,
      reason: !online
        ? t("offline.reason")
        : previewReady
          ? undefined
          : t("invoice.actions.previewUnavailable"),
      onSelect: () => showPreview(record.id),
    });
  }
  if (record && !imported) {
    menuItems.push({
      key: "duplicate",
      label: t("invoice.actions.duplicate"),
      icon: <Copy aria-hidden />,
      disabled: !online || duplicate.isPending,
      reason: online ? undefined : t("offline.reason"),
      onSelect: () => duplicate.mutate(record.id),
    });
  }
  if (record && issuedCreditable) {
    menuItems.push({
      key: "credit-note",
      label: t("invoice.actions.creditNote"),
      icon: <FileMinus aria-hidden />,
      disabled: !online || creditNote.isPending,
      reason: online ? undefined : t("offline.reason"),
      onSelect: () => creditNote.mutate(record.id),
    });
  }
  if (record && payable) {
    const paid = record.paymentFlag === "paid";
    menuItems.push({
      key: "payment",
      label: t(paid ? "invoice.paid.undo" : "invoice.paid.record"),
      icon: paid ? <CircleX aria-hidden /> : <CircleCheck aria-hidden />,
      disabled: !online,
      reason: online ? undefined : t("offline.reason"),
      onSelect: () => setPaymentOpen(true),
    });
  }
  if (record && canSendCourtesyEmail(record)) {
    menuItems.push({
      key: "send-email",
      label: t("invoice.actions.sendEmail"),
      icon: <Mail aria-hidden />,
      disabled: !online,
      reason: online ? undefined : t("offline.reason"),
      onSelect: () => setEmailOpen(true),
    });
  }
  if (record && imported && record.hasOriginal) {
    menuItems.push({
      key: "download-original",
      label: t("received.download"),
      icon: <Download aria-hidden />,
      separated: true,
      disabled: !online,
      reason: online ? undefined : t("offline.reason"),
      onSelect: () => downloadUrl(`/api/invoices/${record.id}/original`),
    });
  } else if (record && !unsent && !imported) {
    downloadItems.forEach((item, index) => {
      menuItems.push({
        ...item,
        label: t("invoice.actions.downloadAs", { format: item.label }),
        icon: <Download aria-hidden />,
        separated: index === 0,
      });
    });
  }
  if (record && unsent) {
    menuItems.push({
      key: "delete",
      label: <span className="text-danger">{t("invoice.actions.delete")}</span>,
      icon: <Trash2 aria-hidden className="text-danger" />,
      separated: true,
      onSelect: () => setConfirmDelete(true),
    });
  }
  const titleActionsAside =
    editing || !finalizable ? undefined : (
      <Button
        type="button"
        disabled={!online || save.isPending}
        title={online ? undefined : t("offline.reason")}
        onClick={() => setFinalizeOpen(true)}
      >
        <Send aria-hidden />
        {t(record?.state === "rejected" ? "invoice.actions.fixResend" : "invoice.actions.finalize")}
      </Button>
    );
  const titleActionsMenu =
    editing || menuItems.length === 0 ? undefined : (
      <MenuButton
        label={t("invoice.actions.more")}
        icon={<Ellipsis aria-hidden />}
        items={menuItems}
        iconOnly
        triggerRef={editButton}
      />
    );

  // A saved invoice is titled with its client, then number and date, then its state chips.
  const headerName = record ? (client?.name ?? record.clientName ?? "") : "";
  const headerDateValue = record ? (record.issueDate ?? (form.invoiceDate || null)) : null;
  const headerDate = headerDateValue ? formatDate(headerDateValue, locale) : null;
  const headerSubtitle = [printedNumber, headerDate].filter(Boolean).join(" · ");
  const headerChips = record ? (
    <>
      {imported ? <ImportedBadge /> : <StatusBadge status={record.state} />}
      {payable ? (
        <StatusBadge
          status={record.paymentFlag}
          detail={
            record.paymentFlag === "paid" && record.paidDate
              ? t("invoice.paid.paidOn", { date: formatDate(record.paidDate, locale) })
              : undefined
          }
        />
      ) : null}
    </>
  ) : undefined;

  return (
    <Page
      title={headerName || t(record ? "invoice.editTitle" : "invoice.newTitle")}
      subtitle={headerSubtitle || null}
      chips={headerChips}
      aside={titleActionsAside}
      actions={titleActionsMenu}
      back={INVOICE_LIST_BACK}
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
        {record?.number && !imported && record.state !== "draft" && record.state !== "planned" ? (
          <InvoiceDetail
            record={record}
            clientName={client?.name ?? record.clientName ?? ""}
            totalLabel={formatMoney(record.totalCents ?? 0, locale, record.currency)}
          />
        ) : null}

        {record && canSendCourtesyEmail(record) ? (
          <CourtesyEmail record={record} open={emailOpen} onOpenChange={setEmailOpen} />
        ) : null}

        {!online ? <Banner tone="warning">{t("offline.reason")}</Banner> : null}
        {imported ? (
          <Banner tone="info">
            <p>
              {t(
                record?.hasOriginal
                  ? "invoice.imported.noteFile"
                  : "invoice.imported.noteNoOriginal",
              )}
            </p>
            {seed ? <p>{t(`invoice.imported.seed.${seed.source}`)}</p> : null}
            {editing && record?.editorForm === null ? (
              <p>{t("invoice.imported.totalsHint")}</p>
            ) : null}
          </Banner>
        ) : null}
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
        {editing && numberEditable && numberGap ? (
          <Banner tone="warning">
            {t(
              numberGap.from === numberGap.to
                ? "invoice.document.numberGapOne"
                : "invoice.document.numberGap",
              { ...numberGap, year },
            )}
          </Banner>
        ) : null}
        {editing && suggestBollo ? (
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

        {editing || !record ? (
          <div className="flex min-w-0 flex-col gap-6">
            <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-6">
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
                  {readOnly ? null : (
                    <Button variant="secondary" onClick={() => setClientSheet("new")}>
                      {t("invoice.client.new")}
                    </Button>
                  )}
                  {client && !readOnly ? (
                    <Button variant="ghost" onClick={() => setClientSheet("edit")}>
                      <Pencil aria-hidden />
                      {t("invoice.client.edit")}
                    </Button>
                  ) : null}
                </div>
                <SdiNotes record={record} field="client" />
                {submitted && client && clientProblems.length > 0 ? (
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
                        disabled={readOnly || editability === "rejected"}
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
                  <Field
                    label={t("invoice.document.invoiceDate")}
                    error={
                      // Like the other checks of Finalize, shown once a Finalize was attempted.
                      submitted && dateBeforeLast
                        ? t("invoice.document.dateBeforeLast", { date: dateBeforeLast })
                        : err("invoiceDate")
                    }
                    name="invoiceDate"
                  >
                    {(c) => (
                      <DatePicker
                        {...c}
                        value={form.invoiceDate}
                        disabled={readOnly || editability === "rejected"}
                        onChange={text("invoiceDate")}
                      />
                    )}
                  </Field>
                  {series.length > 0 ? (
                    <Field label={t("invoice.document.series")}>
                      {(c) => (
                        <Select
                          {...c}
                          value={activeSeries?.id ?? ""}
                          disabled={imported ? !editing : !numberEditable || !editing}
                          onChange={(event) => {
                            setNumberTouched(false);
                            setNumberTaken(false);
                            const picked = series.find((s) => s.id === event.target.value);
                            patch(
                              imported
                                ? {
                                    seriesId: event.target.value,
                                    // The number stays, printed with the new series' prefix and suffix.
                                    ...(importedPlainNumber &&
                                    picked &&
                                    importedProgressive !== null
                                      ? {
                                          requestedNumber: formatInvoiceNumber(
                                            picked,
                                            importedProgressive,
                                          ),
                                        }
                                      : {}),
                                  }
                                : { seriesId: event.target.value, requestedNumber: "" },
                            );
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
                      importedPlainNumber && form.requestedNumber
                        ? t("invoice.imported.numberPrinted", { number: form.requestedNumber })
                        : undefined
                    }
                    error={numberEditable || imported ? numberError : undefined}
                    name={imported ? "number" : "requestedNumber"}
                  >
                    {(c) => (
                      <Input
                        {...c}
                        inputMode={imported && !importedPlainNumber ? "text" : "numeric"}
                        maxLength={imported && !importedPlainNumber ? 20 : undefined}
                        value={
                          imported
                            ? importedPlainNumber
                              ? importedProgressive === null
                                ? ""
                                : String(importedProgressive)
                              : form.requestedNumber
                            : numberEditable
                              ? numberText
                              : (record?.number ?? "")
                        }
                        disabled={imported ? !editing : !numberEditable || !editing}
                        onChange={(event) => {
                          setNumberTouched(true);
                          setNumberTaken(false);
                          const typedText = event.target.value;
                          if (imported && importedPlainNumber) {
                            // Digits only; the chosen series prints its prefix and suffix around them.
                            const digits = typedText.replace(/\D/g, "").slice(0, 9);
                            patch({
                              requestedNumber:
                                digits === "" || !activeSeries
                                  ? ""
                                  : formatInvoiceNumber(activeSeries, Number(digits)),
                            });
                          } else if (imported) {
                            // Free text: the number decides the series, as on import.
                            const match = matchSeries(typedText.trim(), series);
                            patch({
                              requestedNumber: typedText,
                              ...(match.seriesId && match.progressive !== null
                                ? { seriesId: match.seriesId }
                                : {}),
                            });
                          } else {
                            patch({ requestedNumber: typedText });
                          }
                        }}
                      />
                    )}
                  </Field>
                  <Field label={t("invoice.document.language")} name="language">
                    {(c) => (
                      <Select
                        {...c}
                        value={form.language}
                        onChange={(e) => patch({ language: e.target.value as "it" | "en" })}
                      >
                        <option value="it">{t("invoice.document.languageIt")}</option>
                        <option value="en">{t("invoice.document.languageEn")}</option>
                      </Select>
                    )}
                  </Field>
                  <Field
                    label={t("invoice.document.currency")}
                    error={err("currency")}
                    name="currency"
                  >
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
                    <Field
                      label={t("invoice.document.linked")}
                      error={err("linkedInvoiceId")}
                      name="linkedInvoiceId"
                    >
                      {(c) => (
                        <Select
                          {...c}
                          value={form.linkedInvoiceId}
                          onChange={text("linkedInvoiceId")}
                        >
                          <option value="">{t("invoice.document.noLinked")}</option>
                          {record?.linkedInvoiceId &&
                          !linkable.some((i) => i.id === record.linkedInvoiceId) ? (
                            <option value={record.linkedInvoiceId}>
                              {record.linked?.number ?? record.linkedInvoiceId}
                            </option>
                          ) : null}
                          {linkable.map((invoice) => (
                            <option key={invoice.id} value={invoice.id}>
                              {invoice.number
                                ? formatNumberWithYear(invoice.number, invoice.year)
                                : ""}{" "}
                              · {invoice.clientName ?? ""}
                              {invoice.issueDate
                                ? ` · ${formatDate(invoice.issueDate, locale)}`
                                : ""}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  ) : null}
                </div>
              </section>
            </fieldset>

            <Disclosure
              id="inv-extras"
              title={t("invoice.extras.title")}
              summary={extrasSummaryText}
              open={extrasOpen}
              onToggle={() => setExtrasChoice(!extrasOpen)}
            >
              <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-4">
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
                        <option value="rivalsa_inps">
                          {cassaTypeLabel("rivalsa_inps", locale)}
                        </option>
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
                              disabled={readOnly}
                              onChange={text("cassaRate")}
                            />
                          )}
                        </Field>
                        <Field label={t("clients.form.cassaMode")}>
                          {(c) => (
                            <Select
                              {...c}
                              value={form.cassaMode}
                              disabled={readOnly}
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
                            disabled={readOnly}
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
                            disabled={readOnly}
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
                            disabled={readOnly}
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
                {form.bollo ? (
                  <fieldset className="flex flex-col gap-1">
                    <legend className="text-sm font-medium">
                      {t("invoice.extras.bolloCharge")}
                    </legend>
                    {(["client", "issuer"] as const).map((option) => (
                      <label key={option} className="flex min-h-11 items-center gap-3 text-sm">
                        <input
                          type="radio"
                          name="bollo-charge"
                          className="size-5"
                          value={option}
                          // A stored issued invoice (legacy) has the stamp in its total, as charged.
                          checked={(form.bolloCharge === "issuer") === (option === "issuer")}
                          onChange={() => patch({ bolloCharge: option })}
                        />
                        {t(
                          option === "client"
                            ? "invoice.extras.bolloClient"
                            : "invoice.extras.bolloIssuer",
                        )}
                      </label>
                    ))}
                  </fieldset>
                ) : null}
              </fieldset>
            </Disclosure>

            <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-6">
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
                  disabled={readOnly}
                />
                {totals?.stampLine ? (
                  <div
                    data-testid="stamp-line"
                    className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-border bg-muted px-4 py-3 text-sm"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium">{t("invoice.lines.stampLine")}</span>
                      <span className="block text-muted-foreground">
                        {t("invoice.lines.stampLineHint")} · {totals.stampLine.natura}
                      </span>
                    </span>
                    <span className="font-medium tabular-nums">
                      {formatMoney(
                        totals.stampLine.totals.amountCents,
                        locale,
                        form.currency.toUpperCase(),
                      )}
                    </span>
                  </div>
                ) : null}
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
                              patch({
                                naturaTexts: { ...form.naturaTexts, [code]: e.target.value },
                              })
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
                      disabled={readOnly}
                      onChange={text("invoiceNote")}
                    />
                  )}
                </Field>
              </section>

              <section className="flex flex-col gap-4" aria-labelledby="inv-payment">
                <h2 id="inv-payment" className="text-base font-medium">
                  {t("invoice.payment.title")}
                </h2>
                <div className="grid items-end gap-4 sm:grid-cols-4">
                  <PaymentTermsFields
                    compact
                    kind={form.termsKind}
                    days={form.termsDays}
                    onChange={changeTerms}
                    kindError={err("data.payment.terms.kind")}
                    daysError={err("data.payment.terms.days")}
                  />
                  {terms ? (
                    <Field label={t("invoice.document.dueDate")}>
                      {(c) => <DatePicker {...c} value={computedDueDate} readOnly />}
                    </Field>
                  ) : null}
                </div>
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
              </section>
            </fieldset>
          </div>
        ) : record ? (
          <StoredInvoiceView
            view={storedView}
            locale={locale}
            cassa={form.cassaType}
            customerNotes={<SdiNotes record={record} field="client" />}
            lineNotes={<SdiNotes record={record} field="lines" />}
          />
        ) : null}

        {!locked && !imported && !send.ready ? (
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

        {readOnly ? null : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant={confirmCancel ? "destructive" : "secondary"}
              onClick={cancelEdit}
            >
              {t(confirmCancel ? "invoice.actions.discardConfirm" : "common.cancel")}
            </Button>
            <Button type="submit" disabled={!online || !dirty || save.isPending}>
              {t("invoice.actions.save")}
            </Button>
          </div>
        )}

        {editing ? <InvoiceTotals totals={totals} form={form} locale={locale} /> : null}

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
              // The message sits next to the Number field, which only edit mode has.
              setEditing(true);
              void queryClient.invalidateQueries({ queryKey: ["next-number"] });
            }
          }}
          summary={{
            client: client?.name ?? "",
            number: record?.number ? formatNumberWithYear(record.number, record.year) : "",
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

        <UnsavedChangesGuard shouldBlock={shouldBlock} />
        {record && payable ? (
          <PaymentDialog
            key={record.paymentFlag}
            record={record}
            today={today}
            open={paymentOpen}
            onOpenChange={setPaymentOpen}
          />
        ) : null}
        {record && unsent ? (
          <Sheet
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            side="responsive"
            title={t("invoice.actions.deleteTitle")}
            description={t("invoice.actions.deleteBody")}
          >
            <SheetFooter>
              <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={!online || remove.isPending}
                onClick={() => remove.mutate(record.id)}
              >
                {t("invoice.actions.deleteConfirm")}
              </Button>
            </SheetFooter>
          </Sheet>
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
    </Page>
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
