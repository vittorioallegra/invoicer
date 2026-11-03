import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CLIENT_TYPES,
  type ClientDefaults,
  type ClientRecord,
  type ClientType,
  clientInputSchema,
  EMPTY_CLIENT_DEFAULTS,
  RITENUTA_TYPES,
} from "../../shared/client";
import { ApiError } from "../../shared/errors";
import type { UiLocale } from "../../shared/format";
import {
  CASSA_TYPE_CODES,
  CAUSALE_PAGAMENTO_CODES,
  type CassaType,
  type CausalePagamento,
  cassaTypeLabel,
  causalePagamentoLabel,
  defaultCassaSubjectToRitenuta,
  NATURA_CODES,
  naturaLabel,
  ritenutaTypeLabel,
  vatRateLabel,
} from "../../shared/totals";
import { createClient, deleteClient, updateClient } from "../lib/clients-api";
import { countryName, countryOptions } from "../lib/countries";
import { formTerms, type InvoiceForm, termsToForm } from "../lib/invoice-form";
import { useOnline } from "../lib/online";
import { fieldErrors, fieldErrorsFromDetail } from "../lib/settings-api";
import { cn } from "../lib/utils";
import { PaymentTermsFields } from "./payment-terms-fields";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { Sheet } from "./ui/sheet";
import { toast } from "./ui/toast";

interface FormState {
  type: ClientType;
  name: string;
  vatNumber: string;
  taxCode: string;
  foreignTaxId: string;
  countryCode: string;
  address: string;
  postalCode: string;
  city: string;
  province: string;
  recipientCode: string;
  pec: string;
  email: string;
  pdfLanguage: "it" | "en";
  currency: string;
  /** `""` none, `rate:<bp>` or `natura:<code>`. */
  vat: string;
  cassaType: string;
  cassaRate: string;
  cassaMode: "excluded" | "included";
  ritenutaType: string;
  ritenutaRate: string;
  ritenutaBase: string;
  ritenutaCausale: string;
  bollo: boolean;
  termsKind: string;
  termsDays: string;
}

const VAT_RATES = [2200, 1000, 500, 400];

const EMPTY: FormState = {
  type: "it_company",
  name: "",
  vatNumber: "",
  taxCode: "",
  foreignTaxId: "",
  countryCode: "IT",
  address: "",
  postalCode: "",
  city: "",
  province: "",
  recipientCode: "",
  pec: "",
  email: "",
  pdfLanguage: "it",
  currency: "EUR",
  vat: "",
  cassaType: "",
  cassaRate: "",
  cassaMode: "excluded",
  ritenutaType: "",
  ritenutaRate: "",
  ritenutaBase: "100",
  ritenutaCausale: "A",
  bollo: false,
  termsKind: "",
  termsDays: "",
};

const bpToText = (bp: number) => String(bp / 100).replace(".", ",");

/** "22" or "22,5" to basis points; NaN when it is not a number. */
function percentToBp(text: string): number {
  const value = Number(text.trim().replace(",", "."));
  return text.trim() === "" || Number.isNaN(value) ? Number.NaN : Math.round(value * 100);
}

function fromRecord(c: ClientRecord): FormState {
  const d = c.defaults;
  return {
    type: c.type,
    name: c.name,
    vatNumber: c.vatNumber ?? "",
    taxCode: c.taxCode ?? "",
    foreignTaxId: c.foreignTaxId ?? "",
    countryCode: c.countryCode,
    address: c.address,
    postalCode: c.postalCode,
    city: c.city,
    province: c.province ?? "",
    recipientCode:
      c.recipientCode === "0000000" || c.recipientCode === "XXXXXXX" ? "" : c.recipientCode,
    pec: c.pec ?? "",
    email: c.email ?? "",
    pdfLanguage: c.pdfLanguage,
    currency: c.currency,
    vat: d.natura ? `natura:${d.natura}` : d.vatRateBp !== null ? `rate:${d.vatRateBp}` : "",
    cassaType: d.cassa?.type ?? "",
    cassaRate: d.cassa ? bpToText(d.cassa.rateBp) : "",
    cassaMode: d.cassa?.mode ?? "excluded",
    ritenutaType: d.ritenuta?.type ?? "",
    ritenutaRate: d.ritenuta ? bpToText(d.ritenuta.rateBp) : "",
    ritenutaBase: d.ritenuta ? bpToText(d.ritenuta.baseBp) : "100",
    ritenutaCausale: d.ritenuta?.causale ?? "A",
    bollo: d.bollo,
    ...termsToForm(d.terms),
  };
}

function toDefaults(f: FormState): ClientDefaults {
  return {
    vatRateBp: f.vat.startsWith("rate:") ? Number(f.vat.slice(5)) : null,
    natura: f.vat.startsWith("natura:") ? (f.vat.slice(7) as ClientDefaults["natura"]) : null,
    cassa: f.cassaType
      ? {
          type: f.cassaType as CassaType,
          rateBp: percentToBp(f.cassaRate),
          mode: f.cassaMode,
          subjectToRitenuta: defaultCassaSubjectToRitenuta(f.cassaType as CassaType),
        }
      : null,
    ritenuta: f.ritenutaType
      ? {
          type: f.ritenutaType as (typeof RITENUTA_TYPES)[number],
          rateBp: percentToBp(f.ritenutaRate),
          baseBp: percentToBp(f.ritenutaBase),
          causale: f.ritenutaCausale as CausalePagamento,
        }
      : null,
    bollo: f.bollo,
    terms: formTerms({
      termsKind: f.termsKind as InvoiceForm["termsKind"],
      termsDays: f.termsDays,
    }),
  };
}

function toBody(f: FormState) {
  return {
    type: f.type,
    name: f.name,
    vatNumber: f.vatNumber,
    taxCode: f.taxCode,
    foreignTaxId: f.foreignTaxId,
    countryCode: f.countryCode,
    address: f.address,
    postalCode: f.postalCode,
    city: f.city,
    province: f.province,
    recipientCode: f.recipientCode,
    pec: f.pec,
    email: f.email,
    pdfLanguage: f.pdfLanguage,
    currency: f.currency,
    defaults: toDefaults(f),
  };
}

/** True when the form holds invoice defaults, or a PDF language or currency other than the type's. */
function defaultsDiffer(f: FormState): boolean {
  const italian = f.type === "it_company" || f.type === "it_private";
  return (
    JSON.stringify(toDefaults(f)) !== JSON.stringify(EMPTY_CLIENT_DEFAULTS) ||
    f.pdfLanguage !== (italian ? "it" : "en") ||
    f.currency !== "EUR"
  );
}

/** Field errors that live in the collapsed "Invoice defaults" section. */
const inDefaultsSection = (field: string) =>
  field.startsWith("defaults.") || field === "pdfLanguage" || field === "currency";

export interface ClientFormProps {
  /** Client to edit; omit to create one. */
  client?: ClientRecord | undefined;
  /** Called with the saved client (the invoice editor uses it to select the new client). */
  onSaved: (client: ClientRecord) => void;
  onCancel: () => void;
  /** Called after the client is deleted (edit mode only). */
  onDeleted?: () => void;
}

/** Create / edit form for a client; reusable inside a sheet (Clients screen, invoice editor). */
export function ClientForm({ client, onSaved, onCancel, onDeleted }: ClientFormProps) {
  const { t, i18n } = useTranslation();
  const locale: UiLocale = i18n.language.startsWith("it") ? "it" : "en";
  const online = useOnline();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(client ? fromRecord(client) : EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: (body: unknown) => (client ? updateClient(client.id, body) : createClient(body)),
    onSuccess: async ({ client: saved }) => {
      await queryClient.invalidateQueries({ queryKey: ["clients"] });
      onSaved(saved);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "bad_request") {
        showErrors(fieldErrorsFromDetail(error.problem.detail));
      } else {
        toast.error(t("common.error"));
      }
    },
  });

  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = useMutation({
    mutationFn: (id: string) => deleteClient(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["clients"] });
      onDeleted?.();
    },
    onError: (error) => {
      if (!(error instanceof ApiError && error.code === "conflict")) {
        toast.error(t("common.error"));
      }
    },
  });
  const inUse = remove.error instanceof ApiError && remove.error.code === "conflict";

  const italian = form.type === "it_company" || form.type === "it_private";
  const foreign = !italian;
  const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));
  const set = (key: keyof FormState) => (event: { target: { value: string } }) =>
    update({ [key]: event.target.value } as Partial<FormState>);
  const err = (field: string) => {
    const code = errors[field];
    return code ? t(`validation.${code}`, { defaultValue: t("validation.invalid") }) : undefined;
  };

  const [defaultsOpen, setDefaultsOpen] = useState(() =>
    client ? defaultsDiffer(fromRecord(client)) : false,
  );
  const [separateTaxCode, setSeparateTaxCode] = useState(
    () => (client?.taxCode ?? "") !== "" && client?.type === "it_company",
  );

  function showErrors(next: Record<string, string>) {
    setErrors(next);
    if (Object.keys(next).some(inDefaultsSection)) setDefaultsOpen(true);
  }

  function onTypeChange(type: ClientType) {
    const toItalian = type === "it_company" || type === "it_private";
    update({
      type,
      countryCode: toItalian ? "IT" : italian ? "" : form.countryCode,
      pdfLanguage: toItalian ? "it" : "en",
      recipientCode: type === "it_company" ? form.recipientCode : "",
      pec: type === "it_company" ? form.pec : "",
    });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body = toBody(form);
    const parsed = clientInputSchema.safeParse(body);
    if (!parsed.success) {
      showErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    save.mutate(body);
  }

  const grid = "grid grid-cols-1 items-start gap-4 sm:grid-cols-2";
  const legend = "mb-2 text-base font-medium";
  // A select with the fields that belong to it: a bordered group, dependents indented.
  const group = "flex flex-col gap-3 rounded-card border border-border p-4";
  const groupLegend = "px-1 text-sm font-semibold";
  const nested = "border-s-2 border-border ps-4";
  const countries =
    form.type === "eu_company" || form.type === "non_eu_company"
      ? countryOptions(
          form.type === "eu_company" ? "eu" : "non_eu",
          i18n.language,
          form.countryCode,
        )
      : [];

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      {!online ? <Banner tone="warning">{t("offline.reason")}</Banner> : null}
      {inUse ? <Banner tone="warning">{t("clients.inUse")}</Banner> : null}

      <fieldset className="flex flex-col gap-4">
        <legend className={legend}>{t("clients.form.identity")}</legend>
        <div
          role="radiogroup"
          aria-label={t("clients.form.type")}
          className="grid grid-cols-2 gap-2"
        >
          {CLIENT_TYPES.map((option) => (
            <label
              key={option}
              className="flex min-h-11 cursor-pointer items-center justify-center rounded-control border border-border bg-surface px-3 py-2 text-center text-sm font-medium has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary"
            >
              <input
                type="radio"
                name="client-type"
                value={option}
                checked={form.type === option}
                onChange={() => onTypeChange(option)}
                className="sr-only"
              />
              {t(`clients.form.typeLabels.${option}`)}
            </label>
          ))}
        </div>
        <p className="-mt-2 text-sm text-muted-foreground">
          {t(`clients.form.typeHints.${form.type}`)}
        </p>
        <Field
          label={t(
            form.type === "it_private" ? "clients.form.fullName" : "clients.form.companyName",
          )}
          error={err("name")}
        >
          {(c) => <Input {...c} value={form.name} onChange={set("name")} autoComplete="off" />}
        </Field>
        {form.type === "it_company" ? (
          <>
            <Field
              label={t("clients.form.vatNumber")}
              hint={t("clients.form.vatNumberHint")}
              error={err("vatNumber")}
            >
              {(c) => (
                <Input
                  {...c}
                  value={form.vatNumber}
                  onChange={set("vatNumber")}
                  inputMode="numeric"
                />
              )}
            </Field>
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="size-5"
                checked={separateTaxCode}
                onChange={(e) => {
                  setSeparateTaxCode(e.target.checked);
                  if (!e.target.checked) update({ taxCode: "" });
                }}
              />
              {t("clients.form.separateTaxCode")}
            </label>
            {separateTaxCode ? (
              <Field label={t("clients.form.taxCode")} error={err("taxCode")}>
                {(c) => (
                  <Input
                    {...c}
                    value={form.taxCode}
                    onChange={set("taxCode")}
                    autoCapitalize="characters"
                  />
                )}
              </Field>
            ) : null}
          </>
        ) : null}
        {form.type === "it_private" ? (
          <Field
            label={t("clients.form.taxCode")}
            hint={t("clients.form.taxCodeHint")}
            error={err("taxCode")}
          >
            {(c) => (
              <Input
                {...c}
                value={form.taxCode}
                onChange={set("taxCode")}
                maxLength={16}
                autoCapitalize="characters"
              />
            )}
          </Field>
        ) : null}
        {foreign ? (
          <div className="flex flex-col gap-4">
            <Field label={t("clients.form.country")} error={err("countryCode")}>
              {(c) => (
                <Select {...c} value={form.countryCode} onChange={set("countryCode")}>
                  <option value="">{t("clients.form.countryPlaceholder")}</option>
                  {countries.map((country) => (
                    <option key={country.code} value={country.code}>
                      {country.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label={t("clients.form.foreignTaxId")}
              hint={t(
                form.type === "eu_company"
                  ? "clients.form.foreignTaxIdEu"
                  : "clients.form.foreignTaxIdNonEu",
              )}
              error={err("foreignTaxId")}
            >
              {(c) => <Input {...c} value={form.foreignTaxId} onChange={set("foreignTaxId")} />}
            </Field>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className={legend}>{t("clients.form.addressTitle")}</legend>
        <Field label={t("clients.form.address")} error={err("address")}>
          {(c) => <Input {...c} value={form.address} onChange={set("address")} />}
        </Field>
        <div className={grid}>
          <Field label={t("clients.form.postalCode")} error={err("postalCode")}>
            {(c) => <Input {...c} value={form.postalCode} onChange={set("postalCode")} />}
          </Field>
          <Field label={t("clients.form.city")} error={err("city")}>
            {(c) => <Input {...c} value={form.city} onChange={set("city")} />}
          </Field>
          {italian ? (
            <>
              <Field label={t("clients.form.province")} error={err("province")}>
                {(c) => (
                  <Input
                    {...c}
                    value={form.province}
                    onChange={set("province")}
                    maxLength={2}
                    placeholder="RM"
                    autoCapitalize="characters"
                  />
                )}
              </Field>
              <Field label={t("clients.form.country")}>
                {(c) => <Input {...c} value={countryName("IT", i18n.language)} readOnly />}
              </Field>
            </>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className={legend}>{t("clients.form.deliveryTitle")}</legend>
        {form.type === "it_company" ? (
          <>
            <p className="text-sm text-muted-foreground">{t("clients.form.deliveryIntro")}</p>
            <div className={grid}>
              <Field
                label={t("clients.form.recipientCode")}
                hint={t("clients.form.recipientCodeHint")}
                error={err("recipientCode")}
              >
                {(c) => (
                  <Input
                    {...c}
                    value={form.recipientCode}
                    onChange={set("recipientCode")}
                    maxLength={7}
                    placeholder="0000000"
                    autoCapitalize="characters"
                  />
                )}
              </Field>
              <Field
                label={t("clients.form.pec")}
                hint={t("clients.form.pecHint")}
                error={err("pec")}
              >
                {(c) => <Input {...c} value={form.pec} onChange={set("pec")} type="email" />}
              </Field>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t(
              form.type === "it_private"
                ? "clients.form.recipientFixedIt"
                : "clients.form.recipientFixedForeign",
            )}
          </p>
        )}
        <Field
          label={t("clients.form.email")}
          hint={t("clients.form.emailHint")}
          error={err("email")}
        >
          {(c) => <Input {...c} value={form.email} onChange={set("email")} type="email" />}
        </Field>
      </fieldset>

      <section className="flex flex-col gap-4">
        <button
          type="button"
          aria-expanded={defaultsOpen}
          aria-controls="client-defaults"
          onClick={() => setDefaultsOpen((open) => !open)}
          className="flex min-h-11 w-full items-center justify-between gap-3 rounded-control border border-border px-3 text-start text-base font-medium"
        >
          {t("clients.form.defaultsTitle")}
          <ChevronDown
            aria-hidden
            className={cn("size-4 shrink-0 transition-transform", defaultsOpen && "rotate-180")}
          />
        </button>
        {defaultsOpen ? (
          <div id="client-defaults" className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{t("clients.form.defaultsIntro")}</p>
            <Field
              label={t("clients.form.vat")}
              error={err("defaults.vatRateBp") ?? err("defaults.natura")}
            >
              {(c) => (
                <Select {...c} value={form.vat} onChange={set("vat")}>
                  <option value="">{t("clients.form.none")}</option>
                  {VAT_RATES.map((bp) => (
                    <option key={bp} value={`rate:${bp}`}>
                      {vatRateLabel(bp, locale)}
                    </option>
                  ))}
                  {NATURA_CODES.map((code) => (
                    <option key={code} value={`natura:${code}`}>
                      {naturaLabel(code, locale)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <fieldset className={group}>
              <legend className={groupLegend}>{t("clients.form.pensionFund")}</legend>
              <Field label={t("clients.form.cassa")} error={err("defaults.cassa.type")}>
                {(c) => (
                  <Select {...c} value={form.cassaType} onChange={set("cassaType")}>
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
                <div className={`${grid} ${nested}`}>
                  <Field
                    label={t("clients.form.pensionRate")}
                    hint={t("clients.form.rateHint")}
                    error={err("defaults.cassa.rateBp")}
                  >
                    {(c) => (
                      <Input
                        {...c}
                        value={form.cassaRate}
                        onChange={set("cassaRate")}
                        inputMode="decimal"
                      />
                    )}
                  </Field>
                  <Field label={t("clients.form.pensionMode")} error={err("defaults.cassa.mode")}>
                    {(c) => (
                      <Select {...c} value={form.cassaMode} onChange={set("cassaMode")}>
                        <option value="excluded">{t("clients.form.pensionAdded")}</option>
                        <option value="included">{t("clients.form.pensionIncluded")}</option>
                      </Select>
                    )}
                  </Field>
                </div>
              ) : null}
            </fieldset>

            <fieldset className={group}>
              <legend className={groupLegend}>{t("clients.form.withholding")}</legend>
              <Field label={t("clients.form.ritenuta")} error={err("defaults.ritenuta.type")}>
                {(c) => (
                  <Select {...c} value={form.ritenutaType} onChange={set("ritenutaType")}>
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
                <div className={`${grid} ${nested}`}>
                  <Field
                    label={t("clients.form.withholdingRate")}
                    hint={t("clients.form.rateHint")}
                    error={err("defaults.ritenuta.rateBp")}
                  >
                    {(c) => (
                      <Input
                        {...c}
                        value={form.ritenutaRate}
                        onChange={set("ritenutaRate")}
                        inputMode="decimal"
                      />
                    )}
                  </Field>
                  <Field
                    label={t("clients.form.withholdingBase")}
                    hint={t("clients.form.withholdingBaseHint")}
                    error={err("defaults.ritenuta.baseBp")}
                  >
                    {(c) => (
                      <Input
                        {...c}
                        value={form.ritenutaBase}
                        onChange={set("ritenutaBase")}
                        inputMode="decimal"
                      />
                    )}
                  </Field>
                  <Field
                    label={t("clients.form.withholdingReason")}
                    error={err("defaults.ritenuta.causale")}
                    className="sm:col-span-2"
                  >
                    {(c) => (
                      <Select {...c} value={form.ritenutaCausale} onChange={set("ritenutaCausale")}>
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
            </fieldset>

            <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
              <input
                type="checkbox"
                className="size-5"
                checked={form.bollo}
                onChange={(e) => update({ bollo: e.target.checked })}
              />
              {t("clients.form.stampDuty")}
            </label>
            <div className={grid}>
              <PaymentTermsFields
                kind={form.termsKind}
                days={form.termsDays}
                onChange={update}
                kindError={err("defaults.terms.kind")}
                daysError={err("defaults.terms.days")}
              />
            </div>
            <div className={grid}>
              <Field
                label={t("clients.form.pdfLanguage")}
                hint={t("clients.form.pdfLanguageHint")}
                error={err("pdfLanguage")}
              >
                {(c) => (
                  <Select {...c} value={form.pdfLanguage} onChange={set("pdfLanguage")}>
                    <option value="it">{t("clients.languages.it")}</option>
                    <option value="en">{t("clients.languages.en")}</option>
                  </Select>
                )}
              </Field>
              <Field label={t("clients.form.currency")} error={err("currency")}>
                {(c) => (
                  <Input
                    {...c}
                    value={form.currency}
                    onChange={set("currency")}
                    maxLength={3}
                    autoCapitalize="characters"
                  />
                )}
              </Field>
            </div>
          </div>
        ) : null}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        {client && !confirmDelete ? (
          <Button
            type="button"
            variant="ghost"
            className="text-danger hover:text-danger"
            onClick={() => setConfirmDelete(true)}
          >
            {t("clients.delete")}
          </Button>
        ) : null}
        {client && confirmDelete ? (
          <Button
            type="button"
            variant="destructive"
            disabled={!online || remove.isPending}
            onClick={() => remove.mutate(client.id)}
          >
            {t("clients.deleteConfirm")}
          </Button>
        ) : null}
        <div className="ms-auto flex flex-wrap gap-3">
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!online || save.isPending}>
            {t("clients.form.save")}
          </Button>
        </div>
      </div>
    </form>
  );
}

export interface ClientSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client?: ClientRecord | undefined;
  onSaved: (client: ClientRecord) => void;
  onDeleted?: () => void;
}

/** The client form in a side sheet: the Clients screen uses it, and so will the invoice editor. */
export function ClientSheet({ open, onOpenChange, client, onSaved, onDeleted }: ClientSheetProps) {
  const { t } = useTranslation();
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      title={t(client ? "clients.editTitle" : "clients.newTitle")}
    >
      {/* Remount per client so the form state starts from the right record. */}
      <ClientForm
        key={client?.id ?? "new"}
        client={client}
        onSaved={onSaved}
        {...(onDeleted ? { onDeleted } : {})}
        onCancel={() => onOpenChange(false)}
      />
    </Sheet>
  );
}
