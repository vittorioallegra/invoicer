import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../shared/errors";
import type { UiLocale } from "../../shared/format";
import { REGIME_FISCALE_CODES } from "../../shared/profile";
import { RITENUTA_TYPES, taxInputSchema } from "../../shared/tax";
import {
  CASSA_TYPE_CODES,
  CAUSALE_PAGAMENTO_CODES,
  type CassaType,
  type CausalePagamento,
  cassaTypeLabel,
  causalePagamentoLabel,
  defaultCassaSubjectToRitenuta,
  ritenutaTypeLabel,
} from "../../shared/totals";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { GroupBox } from "../components/ui/group-box";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { toast } from "../components/ui/toast";
import { bpToText, percentToBp } from "../lib/invoice-form";
import { useOnline } from "../lib/online";
import {
  fieldErrors,
  fieldErrorsFromDetail,
  putJson,
  type TaxResponse,
  taxQuery,
} from "../lib/settings-api";

interface FormState {
  regimeFiscale: string;
  cassaType: string;
  cassaRate: string;
  cassaMode: "excluded" | "included";
  ritenutaType: string;
  ritenutaRate: string;
  ritenutaBase: string;
  ritenutaCausale: string;
}

const EMPTY: FormState = {
  regimeFiscale: "RF01",
  cassaType: "",
  cassaRate: "",
  cassaMode: "excluded",
  ritenutaType: "",
  ritenutaRate: "",
  ritenutaBase: "100",
  ritenutaCausale: "A",
};

function fromTax(tax: TaxResponse): FormState {
  return {
    regimeFiscale: tax.regimeFiscale ?? EMPTY.regimeFiscale,
    cassaType: tax.cassa?.type ?? "",
    cassaRate: tax.cassa ? bpToText(tax.cassa.rateBp) : "",
    cassaMode: tax.cassa?.mode ?? "excluded",
    ritenutaType: tax.ritenuta?.type ?? "",
    ritenutaRate: tax.ritenuta ? bpToText(tax.ritenuta.rateBp) : "",
    ritenutaBase: tax.ritenuta ? bpToText(tax.ritenuta.baseBp) : "100",
    ritenutaCausale: tax.ritenuta?.causale ?? "A",
  };
}

function toBody(f: FormState) {
  return {
    regimeFiscale: f.regimeFiscale,
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
  };
}

/** Settings > Tax details: regime fiscale, cassa previdenziale and ritenuta d'acconto of the owner. */
export function TaxPage() {
  const { t, i18n } = useTranslation();
  const locale: UiLocale = i18n.language.startsWith("it") ? "it" : "en";
  const online = useOnline();
  const queryClient = useQueryClient();
  const query = useQuery(taxQuery);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (query.data && !loaded) {
      setForm(fromTax(query.data.tax));
      setLoaded(true);
    }
  }, [query.data, loaded]);

  const save = useMutation({
    mutationFn: (body: unknown) => putJson("/api/tax", body),
    onSuccess: async () => {
      toast.success(t("tax.saved"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tax"] }),
        queryClient.invalidateQueries({ queryKey: ["profile"] }),
      ]);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "bad_request") {
        setErrors(fieldErrorsFromDetail(error.problem.detail));
      } else {
        toast.error(t("common.error"));
      }
    },
  });

  const set = (key: keyof FormState) => (event: { target: { value: string } }) => {
    setForm((current) => ({ ...current, [key]: event.target.value }));
  };
  const err = (field: string) => {
    const code = errors[field];
    return code ? t(`validation.${code}`, { defaultValue: t("validation.invalid") }) : undefined;
  };

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body = toBody(form);
    const parsed = taxInputSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    save.mutate(body);
  }

  const grid = "grid grid-cols-1 items-start gap-4 sm:grid-cols-2";
  const noProfile = query.data !== undefined && query.data.tax.regimeFiscale === null;

  return (
    <Page title={t("tax.title")} backToSettings>
      <p className="text-sm text-muted-foreground">{t("tax.intro")}</p>
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
      {query.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {!online ? <Banner tone="warning">{t("offline.reason")}</Banner> : null}
      {query.data ? (
        <form onSubmit={onSubmit} noValidate className="flex max-w-2xl flex-col gap-6">
          <Field label={t("tax.regime")} error={err("regimeFiscale")}>
            {(c) => (
              <Select
                {...c}
                value={form.regimeFiscale}
                onChange={set("regimeFiscale")}
                disabled={noProfile}
              >
                {REGIME_FISCALE_CODES.map((code) => (
                  <option key={code} value={code}>
                    {code} - {t(`tax.regimes.${code}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {noProfile ? (
            <p className="-mt-3 text-sm text-muted-foreground">
              {t("tax.regimeNeedsCompany")}{" "}
              <Link to="/settings/company" className="underline underline-offset-4">
                {t("tax.regimeCompanyLink")}
              </Link>
            </p>
          ) : null}

          <GroupBox title={t("tax.pensionFund")}>
            <Field label={t("tax.cassa")} error={err("cassa.type")}>
              {(c) => (
                <Select {...c} value={form.cassaType} onChange={set("cassaType")}>
                  <option value="">{t("tax.none")}</option>
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
              <div className={grid}>
                <Field label={t("tax.rate")} error={err("cassa.rateBp")}>
                  {(c) => (
                    <Input
                      {...c}
                      value={form.cassaRate}
                      suffix="%"
                      onChange={set("cassaRate")}
                      inputMode="decimal"
                    />
                  )}
                </Field>
                <Field label={t("tax.mode")} error={err("cassa.mode")}>
                  {(c) => (
                    <Select {...c} value={form.cassaMode} onChange={set("cassaMode")}>
                      <option value="excluded">{t("tax.modeAdded")}</option>
                      <option value="included">{t("tax.modeIncluded")}</option>
                    </Select>
                  )}
                </Field>
              </div>
            ) : null}
          </GroupBox>

          <GroupBox title={t("tax.withholding")}>
            <Field label={t("tax.ritenuta")} error={err("ritenuta.type")}>
              {(c) => (
                <Select {...c} value={form.ritenutaType} onChange={set("ritenutaType")}>
                  <option value="">{t("tax.none")}</option>
                  {RITENUTA_TYPES.map((code) => (
                    <option key={code} value={code}>
                      {ritenutaTypeLabel(code, locale)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {form.ritenutaType ? (
              <div className={grid}>
                <Field label={t("tax.rate")} error={err("ritenuta.rateBp")}>
                  {(c) => (
                    <Input
                      {...c}
                      value={form.ritenutaRate}
                      suffix="%"
                      onChange={set("ritenutaRate")}
                      inputMode="decimal"
                    />
                  )}
                </Field>
                <Field label={t("tax.base")} error={err("ritenuta.baseBp")}>
                  {(c) => (
                    <Input
                      {...c}
                      value={form.ritenutaBase}
                      suffix="%"
                      onChange={set("ritenutaBase")}
                      inputMode="decimal"
                    />
                  )}
                </Field>
                <Field
                  label={t("tax.reason")}
                  error={err("ritenuta.causale")}
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
          </GroupBox>

          <div className="flex justify-end">
            <Button type="submit" disabled={!online || save.isPending}>
              {t("tax.save")}
            </Button>
          </div>
        </form>
      ) : null}
    </Page>
  );
}
