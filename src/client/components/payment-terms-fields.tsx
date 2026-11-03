import { useTranslation } from "react-i18next";
import {
  PAYMENT_TERMS_BASES,
  PAYMENT_TERMS_MAX_DAYS,
  PAYMENT_TERMS_MAX_EXTRA_DAYS,
} from "../../shared/payment-terms";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

interface PaymentTermsFieldsProps {
  /** `""` = no terms, else a whole number of days. */
  days: string;
  basis: string;
  /** Days after the end of the month; shown only for the end-of-month basis. */
  extraDays: string;
  disabled?: boolean;
  onChange: (changes: { termsDays?: string; termsBasis?: string; termsExtraDays?: string }) => void;
  daysError?: string | undefined;
  basisError?: string | undefined;
  extraDaysError?: string | undefined;
}

/** The payment terms inputs (days, basis, days after the end of month), shared by the client form and the editor. */
export function PaymentTermsFields({
  days,
  basis,
  extraDays,
  disabled,
  onChange,
  daysError,
  basisError,
  extraDaysError,
}: PaymentTermsFieldsProps) {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t("paymentTerms.days")} hint={t("paymentTerms.daysHint")} error={daysError}>
        {(c) => (
          <Input
            {...c}
            type="number"
            inputMode="numeric"
            min={0}
            max={PAYMENT_TERMS_MAX_DAYS}
            step={1}
            value={days}
            disabled={disabled}
            placeholder={t("paymentTerms.none")}
            onChange={(e) => onChange({ termsDays: e.target.value })}
          />
        )}
      </Field>
      <Field label={t("paymentTerms.basis")} error={basisError}>
        {(c) => (
          <Select
            {...c}
            value={basis}
            disabled={disabled || days === ""}
            onChange={(e) => onChange({ termsBasis: e.target.value })}
          >
            {PAYMENT_TERMS_BASES.map((value) => (
              <option key={value} value={value}>
                {t(`paymentTerms.basis_${value}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {days !== "" && basis === "end_of_month" ? (
        <Field label={t("paymentTerms.extraDays")} error={extraDaysError}>
          {(c) => (
            <Input
              {...c}
              type="number"
              inputMode="numeric"
              min={0}
              max={PAYMENT_TERMS_MAX_EXTRA_DAYS}
              step={1}
              value={extraDays}
              disabled={disabled}
              onChange={(e) => onChange({ termsExtraDays: e.target.value })}
            />
          )}
        </Field>
      ) : null}
    </>
  );
}
