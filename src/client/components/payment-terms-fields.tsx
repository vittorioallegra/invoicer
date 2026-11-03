import { useTranslation } from "react-i18next";
import { PAYMENT_TERMS_BASES, PAYMENT_TERMS_DAYS } from "../../shared/payment-terms";
import { Field } from "./ui/field";
import { Select } from "./ui/select";

interface PaymentTermsFieldsProps {
  /** `""` = no terms, else one of the allowed numbers of days. */
  days: string;
  basis: string;
  disabled?: boolean;
  onChange: (changes: { termsDays?: string; termsBasis?: string }) => void;
  daysError?: string | undefined;
  basisError?: string | undefined;
}

/** The two selects of the payment terms (days and basis), shared by the client form and the editor. */
export function PaymentTermsFields({
  days,
  basis,
  disabled,
  onChange,
  daysError,
  basisError,
}: PaymentTermsFieldsProps) {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t("paymentTerms.days")} error={daysError}>
        {(c) => (
          <Select
            {...c}
            value={days}
            disabled={disabled}
            onChange={(e) => onChange({ termsDays: e.target.value })}
          >
            <option value="">{t("paymentTerms.none")}</option>
            {PAYMENT_TERMS_DAYS.map((value) => (
              <option key={value} value={String(value)}>
                {value === 0 ? t("paymentTerms.day0") : t("paymentTerms.dayN", { days: value })}
              </option>
            ))}
          </Select>
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
    </>
  );
}
