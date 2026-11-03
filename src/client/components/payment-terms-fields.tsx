import { useTranslation } from "react-i18next";
import { PAYMENT_TERMS_KINDS, PAYMENT_TERMS_MAX_DAYS } from "../../shared/payment-terms";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

interface PaymentTermsFieldsProps {
  /** `""` = no terms, else one of `PAYMENT_TERMS_KINDS`. */
  kind: string;
  /** Days from the invoice date, as typed; shown only for the custom kind. */
  days: string;
  disabled?: boolean;
  /** Fit in a one-line row: the days field is narrow and has no hint. */
  compact?: boolean;
  onChange: (changes: { termsKind?: string; termsDays?: string }) => void;
  kindError?: string | undefined;
  daysError?: string | undefined;
}

/** The payment terms inputs (a choice, plus the days for a custom one), shared by the client form and the editor. */
export function PaymentTermsFields({
  kind,
  days,
  disabled,
  compact,
  onChange,
  kindError,
  daysError,
}: PaymentTermsFieldsProps) {
  const { t } = useTranslation();
  return (
    <>
      <Field
        label={t("paymentTerms.label")}
        error={kindError}
        {...(compact ? { className: "min-w-48 flex-1" } : {})}
      >
        {(c) => (
          <Select
            {...c}
            value={kind}
            disabled={disabled}
            onChange={(e) => onChange({ termsKind: e.target.value })}
          >
            <option value="">{t("paymentTerms.none")}</option>
            {PAYMENT_TERMS_KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`paymentTerms.kind_${value}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {kind === "custom" ? (
        <Field
          label={t("paymentTerms.days")}
          error={daysError}
          {...(compact ? { className: "w-36" } : { hint: t("paymentTerms.daysHint") })}
        >
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
              onChange={(e) => onChange({ termsDays: e.target.value })}
            />
          )}
        </Field>
      ) : null}
    </>
  );
}
