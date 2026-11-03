import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type ClientDefaults,
  type ClientKind,
  type ClientRecord,
  clientInputSchema,
  clientKind,
  deriveClientType,
  isItalianClientType,
  newClientDefaults,
} from "../../shared/client";
import { ApiError } from "../../shared/errors";
import { createClient, deleteClient, updateClient } from "../lib/clients-api";
import { countryOptions } from "../lib/countries";
import { formTerms, type InvoiceForm, termsToForm } from "../lib/invoice-form";
import { useOnline } from "../lib/online";
import {
  fieldErrors,
  fieldErrorsFromDetail,
  numberingSeriesQuery,
  taxQuery,
} from "../lib/settings-api";
import { PaymentTermsFields } from "./payment-terms-fields";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { Sheet } from "./ui/sheet";
import { toast } from "./ui/toast";

const KINDS: ClientKind[] = ["company", "private"];

interface FormState {
  kind: ClientKind;
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
  applyCassa: boolean;
  applyRitenuta: boolean;
  termsKind: string;
  termsDays: string;
  /** Numbering series a new invoice starts in; `""` = the default series. */
  seriesId: string;
}

const EMPTY: FormState = {
  kind: "company",
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
  ...flagsOf(newClientDefaults("it_company")),
  termsKind: "",
  termsDays: "",
  seriesId: "",
};

/** The two apply flags of a defaults object, as form state. */
function flagsOf(d: ClientDefaults) {
  return { applyCassa: d.applyCassa, applyRitenuta: d.applyRitenuta };
}

function fromRecord(c: ClientRecord): FormState {
  const d = c.defaults;
  return {
    kind: clientKind(c.type),
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
    applyCassa: d.applyCassa,
    applyRitenuta: d.applyRitenuta,
    ...termsToForm(d.terms),
    seriesId: d.seriesId ?? "",
  };
}

function toDefaults(f: FormState): ClientDefaults {
  return {
    applyCassa: f.applyCassa,
    applyRitenuta: f.applyRitenuta,
    terms: formTerms({
      termsKind: f.termsKind as InvoiceForm["termsKind"],
      termsDays: f.termsDays,
    }),
    seriesId: f.seriesId || null,
  };
}

function toBody(f: FormState) {
  return {
    type: deriveClientType(f.kind, f.countryCode),
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

/**
 * A checkbox for "apply the owner's cassa / ritenuta"; until the owner has configured it in Tax
 * details there is nothing to apply, so a hint with a link takes its place.
 */
function TaxFlag({
  checked,
  configured,
  label,
  onChange,
}: {
  checked: boolean;
  configured: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  if (!configured) {
    return (
      <p className="text-sm text-muted-foreground">
        {label}: {t("clients.form.taxNotSet")}{" "}
        <Link to="/settings/tax" className="underline underline-offset-4">
          {t("clients.form.taxOpen")}
        </Link>
      </p>
    );
  }
  return (
    <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
      <input
        type="checkbox"
        className="size-5"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

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
  const online = useOnline();
  const queryClient = useQueryClient();
  const taxSettings = useQuery(taxQuery);
  const numbering = useQuery(numberingSeriesQuery);
  const allSeries = numbering.data?.series ?? [];
  const tax = taxSettings.data?.tax;
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

  const type = deriveClientType(form.kind, form.countryCode);
  const italian = isItalianClientType(type);
  const foreign = !italian;
  const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));
  const set = (key: keyof FormState) => (event: { target: { value: string } }) =>
    update({ [key]: event.target.value } as Partial<FormState>);
  const err = (field: string) => {
    const code = errors[field];
    return code ? t(`validation.${code}`, { defaultValue: t("validation.invalid") }) : undefined;
  };

  const [separateTaxCode, setSeparateTaxCode] = useState(
    () => (client?.taxCode ?? "") !== "" && client?.type === "it_company",
  );

  function showErrors(next: Record<string, string>) {
    setErrors(next);
  }

  /** Changes the kind and/or the country; everything else follows from the derived type. */
  function onKindOrCountryChange(kind: ClientKind, countryCode: string) {
    const next = deriveClientType(kind, countryCode);
    const toItalian = isItalianClientType(next);
    update({
      kind,
      countryCode,
      // The PDF language follows Italy vs abroad only when that changes.
      ...(toItalian !== italian ? { pdfLanguage: toItalian ? "it" : "en" } : {}),
      recipientCode: next === "it_company" ? form.recipientCode : "",
      pec: next === "it_company" ? form.pec : "",
      province: toItalian ? form.province : "",
      // A tax code only fits the Italian type it was typed for; the foreign tax ID only foreign ones.
      taxCode: next === type ? form.taxCode : "",
      foreignTaxId: toItalian ? "" : form.foreignTaxId,
      // A new client starts from its type's defaults; an existing one keeps its choices.
      ...(client ? {} : { applyRitenuta: newClientDefaults(next).applyRitenuta }),
    });
    if (next !== "it_company") setSeparateTaxCode(false);
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
  const countries = countryOptions(i18n.language, form.countryCode);

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      {!online ? <Banner tone="warning">{t("offline.reason")}</Banner> : null}
      {inUse ? <Banner tone="warning">{t("clients.inUse")}</Banner> : null}

      <fieldset className="flex flex-col gap-4">
        <legend className={legend}>{t("clients.form.identity")}</legend>
        <div
          role="radiogroup"
          aria-label={t("clients.form.kind")}
          className="grid grid-cols-2 gap-2"
        >
          {KINDS.map((option) => (
            <label
              key={option}
              className="flex min-h-11 cursor-pointer items-center justify-center rounded-control border border-border bg-surface px-3 py-2 text-center text-sm font-medium has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary"
            >
              <input
                type="radio"
                name="client-kind"
                value={option}
                checked={form.kind === option}
                onChange={() => onKindOrCountryChange(option, form.countryCode)}
                className="sr-only"
              />
              {t(`clients.form.kindLabels.${option}`)}
            </label>
          ))}
        </div>
        <Field label={t("clients.form.country")} error={err("countryCode")}>
          {(c) => (
            <Select
              {...c}
              value={form.countryCode}
              onChange={(event) => onKindOrCountryChange(form.kind, event.target.value)}
            >
              {countries.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label={t(form.kind === "private" ? "clients.form.fullName" : "clients.form.companyName")}
          error={err("name")}
        >
          {(c) => <Input {...c} value={form.name} onChange={set("name")} autoComplete="off" />}
        </Field>
        {type === "it_company" ? (
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
        {type === "it_private" ? (
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
          <Field
            label={t("clients.form.foreignTaxId")}
            hint={t(
              type === "eu_company"
                ? "clients.form.foreignTaxIdEu"
                : "clients.form.foreignTaxIdOptional",
            )}
            error={err("foreignTaxId")}
          >
            {(c) => <Input {...c} value={form.foreignTaxId} onChange={set("foreignTaxId")} />}
          </Field>
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
          ) : null}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className={legend}>{t("clients.form.deliveryTitle")}</legend>
        {type === "it_company" ? (
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
              type === "it_private"
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

      <fieldset className="flex flex-col gap-4">
        <legend className={legend}>{t("clients.form.defaultsTitle")}</legend>
        <p className="text-sm text-muted-foreground">{t("clients.form.defaultsIntro")}</p>
        <TaxFlag
          checked={form.applyCassa}
          configured={tax?.cassa != null}
          label={t("clients.form.applyCassa")}
          onChange={(applyCassa) => update({ applyCassa })}
        />
        <TaxFlag
          checked={form.applyRitenuta}
          configured={tax?.ritenuta != null}
          label={t("clients.form.applyRitenuta")}
          onChange={(applyRitenuta) => update({ applyRitenuta })}
        />
        <div className={grid}>
          <PaymentTermsFields
            kind={form.termsKind}
            days={form.termsDays}
            onChange={update}
            kindError={err("defaults.terms.kind")}
            daysError={err("defaults.terms.days")}
          />
        </div>
        {allSeries.length > 1 ? (
          <div className={grid}>
            <Field label={t("clients.form.series")} error={err("defaults.seriesId")}>
              {(c) => (
                <Select {...c} value={form.seriesId} onChange={set("seriesId")}>
                  <option value="">{t("clients.form.seriesDefault")}</option>
                  {allSeries.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        ) : null}
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
      </fieldset>

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
