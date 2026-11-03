import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CLIENT_TYPES,
  type ClientDefaults,
  type ClientRecord,
  type ClientType,
  clientInputSchema,
  RITENUTA_TYPES,
} from "../../shared/client";
import { ApiError } from "../../shared/errors";
import {
  CASSA_TYPE_CODES,
  type CassaType,
  defaultCassaSubjectToRitenuta,
  NATURA_CODES,
} from "../../shared/totals";
import { createClient, deleteClient, updateClient } from "../lib/clients-api";
import { useOnline } from "../lib/online";
import { fieldErrors, fieldErrorsFromDetail } from "../lib/settings-api";
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
  ritenutaCausale: string;
  bollo: boolean;
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
  ritenutaCausale: "A",
  bollo: false,
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
    ritenutaCausale: d.ritenuta?.causale ?? "A",
    bollo: d.bollo,
    termsDays: d.paymentTermsDays === null ? "" : String(d.paymentTermsDays),
  };
}

function toDefaults(f: FormState): ClientDefaults {
  const days = f.termsDays.trim();
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
          causale: f.ritenutaCausale,
        }
      : null,
    bollo: f.bollo,
    paymentTermsDays: days === "" ? null : Number(days),
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
  const { t } = useTranslation();
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
        setErrors(fieldErrorsFromDetail(error.problem.detail));
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
  const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));
  const set = (key: keyof FormState) => (event: { target: { value: string } }) =>
    update({ [key]: event.target.value } as Partial<FormState>);
  const err = (field: string) => {
    const code = errors[field];
    return code ? t(`validation.${code}`, { defaultValue: t("validation.invalid") }) : undefined;
  };

  function onTypeChange(type: ClientType) {
    const toItalian = type === "it_company" || type === "it_private";
    update({
      type,
      countryCode: toItalian ? "IT" : italian ? "" : form.countryCode,
      pdfLanguage: toItalian ? form.pdfLanguage : "en",
    });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body = toBody(form);
    const parsed = clientInputSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    save.mutate(body);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      {!online ? <Banner tone="warning">{t("offline.reason")}</Banner> : null}
      {inUse ? <Banner tone="warning">{t("clients.inUse")}</Banner> : null}

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-base font-medium">{t("clients.form.identity")}</legend>
        <Field label={t("clients.form.type")} error={err("type")}>
          {(c) => (
            <Select
              {...c}
              value={form.type}
              onChange={(e) => onTypeChange(e.target.value as ClientType)}
            >
              {CLIENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`clients.types.${type}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("clients.form.name")} error={err("name")}>
          {(c) => <Input {...c} value={form.name} onChange={set("name")} />}
        </Field>
        {italian ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t("clients.form.vatNumber")}
              hint={form.type === "it_private" ? t("clients.form.vatOptional") : undefined}
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
            <Field
              label={t("clients.form.taxCode")}
              hint={form.type === "it_company" ? t("clients.form.taxCodeOptional") : undefined}
              error={err("taxCode")}
            >
              {(c) => (
                <Input
                  {...c}
                  value={form.taxCode}
                  onChange={set("taxCode")}
                  autoCapitalize="characters"
                />
              )}
            </Field>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("clients.form.countryCode")} error={err("countryCode")}>
              {(c) => (
                <Input
                  {...c}
                  value={form.countryCode}
                  onChange={set("countryCode")}
                  maxLength={2}
                  autoCapitalize="characters"
                />
              )}
            </Field>
            <Field
              label={t("clients.form.foreignTaxId")}
              hint={
                form.type === "non_eu_company" ? t("clients.form.foreignTaxIdOptional") : undefined
              }
              error={err("foreignTaxId")}
            >
              {(c) => <Input {...c} value={form.foreignTaxId} onChange={set("foreignTaxId")} />}
            </Field>
          </div>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-base font-medium">{t("clients.form.addressTitle")}</legend>
        <Field label={t("clients.form.address")} error={err("address")}>
          {(c) => <Input {...c} value={form.address} onChange={set("address")} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t("clients.form.postalCode")} error={err("postalCode")}>
            {(c) => <Input {...c} value={form.postalCode} onChange={set("postalCode")} />}
          </Field>
          <Field label={t("clients.form.city")} error={err("city")} className="sm:col-span-2">
            {(c) => <Input {...c} value={form.city} onChange={set("city")} />}
          </Field>
        </div>
        {italian ? (
          <Field label={t("clients.form.province")} error={err("province")}>
            {(c) => (
              <Input
                {...c}
                value={form.province}
                onChange={set("province")}
                maxLength={2}
                autoCapitalize="characters"
              />
            )}
          </Field>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-base font-medium">{t("clients.form.deliveryTitle")}</legend>
        {form.type === "it_company" ? (
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
        ) : (
          <p className="text-sm text-muted-foreground">
            {t(
              form.type === "it_private"
                ? "clients.form.recipientFixedIt"
                : "clients.form.recipientFixedForeign",
            )}
          </p>
        )}
        {italian ? (
          <Field label={t("clients.form.pec")} error={err("pec")}>
            {(c) => <Input {...c} value={form.pec} onChange={set("pec")} type="email" />}
          </Field>
        ) : null}
        <Field
          label={t("clients.form.email")}
          hint={t("clients.form.emailHint")}
          error={err("email")}
        >
          {(c) => <Input {...c} value={form.email} onChange={set("email")} type="email" />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("clients.form.pdfLanguage")} error={err("pdfLanguage")}>
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

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-base font-medium">{t("clients.form.defaultsTitle")}</legend>
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
                  {t("clients.form.vatRate", { rate: bpToText(bp) })}
                </option>
              ))}
              {NATURA_CODES.map((code) => (
                <option key={code} value={`natura:${code}`}>
                  {t("clients.form.exempt", { code })}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t("clients.form.cassa")} error={err("defaults.cassa.type")}>
            {(c) => (
              <Select {...c} value={form.cassaType} onChange={set("cassaType")}>
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
          <Field label={t("clients.form.cassaRate")} error={err("defaults.cassa.rateBp")}>
            {(c) => (
              <Input
                {...c}
                value={form.cassaRate}
                onChange={set("cassaRate")}
                inputMode="decimal"
                disabled={!form.cassaType}
              />
            )}
          </Field>
          <Field label={t("clients.form.cassaMode")} error={err("defaults.cassa.mode")}>
            {(c) => (
              <Select
                {...c}
                value={form.cassaMode}
                onChange={set("cassaMode")}
                disabled={!form.cassaType}
              >
                <option value="excluded">{t("clients.form.modeExcluded")}</option>
                <option value="included">{t("clients.form.modeIncluded")}</option>
              </Select>
            )}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t("clients.form.ritenuta")} error={err("defaults.ritenuta.type")}>
            {(c) => (
              <Select {...c} value={form.ritenutaType} onChange={set("ritenutaType")}>
                <option value="">{t("clients.form.none")}</option>
                {RITENUTA_TYPES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("clients.form.ritenutaRate")} error={err("defaults.ritenuta.rateBp")}>
            {(c) => (
              <Input
                {...c}
                value={form.ritenutaRate}
                onChange={set("ritenutaRate")}
                inputMode="decimal"
                disabled={!form.ritenutaType}
              />
            )}
          </Field>
          <Field label={t("clients.form.ritenutaCausale")} error={err("defaults.ritenuta.causale")}>
            {(c) => (
              <Input
                {...c}
                value={form.ritenutaCausale}
                onChange={set("ritenutaCausale")}
                maxLength={2}
                autoCapitalize="characters"
                disabled={!form.ritenutaType}
              />
            )}
          </Field>
        </div>
        <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
          <input
            type="checkbox"
            className="size-5"
            checked={form.bollo}
            onChange={(e) => update({ bollo: e.target.checked })}
          />
          {t("clients.form.bollo")}
        </label>
        <Field label={t("clients.form.termsDays")} error={err("defaults.paymentTermsDays")}>
          {(c) => (
            <Input {...c} value={form.termsDays} onChange={set("termsDays")} inputMode="numeric" />
          )}
        </Field>
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
