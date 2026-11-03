import { Plus, Trash2 } from "lucide-react";
import { type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import { formatMoney, type UiLocale } from "../../shared/format";
import { NATURA_CODES, naturaLabel, type Totals, vatRateLabel } from "../../shared/totals";
import { emptyLine, type InvoiceForm, type LineForm, VAT_RATES } from "../lib/invoice-form";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { MoneyInput } from "./ui/money-input";
import { Select } from "./ui/select";

interface CellProps {
  label: string;
  error?: string | undefined;
  className?: string;
  children: (control: {
    id: string;
    "aria-invalid": true | undefined;
    "aria-describedby": string | undefined;
  }) => ReactNode;
}

/** Label above the control on a phone (stacked card); visually hidden in the desktop table. */
function Cell({ label, error, className, children }: CellProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium md:sr-only">
        {label}
      </label>
      {children({
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": error ? errorId : undefined,
      })}
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const COLUMNS =
  "md:grid md:grid-cols-[minmax(0,3fr)_5rem_4.5rem_9rem_10rem_7rem_2.75rem] md:items-start md:gap-2";

export interface InvoiceLinesProps {
  form: InvoiceForm;
  totals: Totals | null;
  locale: UiLocale;
  /** Translated message for a field path, or undefined. */
  error: (path: string) => string | undefined;
  onChange: (lines: LineForm[]) => void;
  disabled: boolean;
}

/** Lines as stacked cards on a phone and as a table on wider screens. */
export function InvoiceLines({
  form,
  totals,
  locale,
  error,
  onChange,
  disabled,
}: InvoiceLinesProps) {
  const { t } = useTranslation();
  const currency = form.currency.toUpperCase();

  const update = (key: string, patch: Partial<LineForm>) =>
    onChange(form.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  return (
    <div className="flex flex-col gap-3">
      <div
        aria-hidden
        className={`hidden border-b border-border pb-2 text-sm font-medium text-muted-foreground ${COLUMNS}`}
      >
        <span>{t("invoice.lines.description")}</span>
        <span>{t("invoice.lines.quantity")}</span>
        <span>{t("invoice.lines.unit")}</span>
        <span>{t("invoice.lines.price")}</span>
        <span>{t("invoice.lines.vat")}</span>
        <span className="text-right">{t("invoice.lines.amount")}</span>
        <span />
      </div>
      {error("lines") ? (
        <p role="alert" className="text-sm text-danger">
          {error("lines")}
        </p>
      ) : null}
      <ul className="flex flex-col gap-3 md:gap-0">
        {form.lines.map((line, index) => {
          const path = (field: string) => `lines.${index}.${field}`;
          const amount = totals?.lines[index]?.amountCents;
          return (
            <li
              key={line.key}
              data-testid="invoice-line"
              className={`flex flex-col gap-3 rounded-card border border-border p-3 md:rounded-none md:border-0 md:border-b md:px-0 md:py-2 ${COLUMNS}`}
            >
              <Cell label={t("invoice.lines.description")} error={error(path("description"))}>
                {(c) => (
                  <Input
                    {...c}
                    value={line.description}
                    disabled={disabled}
                    onChange={(e) => update(line.key, { description: e.target.value })}
                  />
                )}
              </Cell>
              <div className="grid grid-cols-2 gap-3 md:contents">
                <Cell label={t("invoice.lines.quantity")} error={error(path("quantityMilli"))}>
                  {(c) => (
                    <Input
                      {...c}
                      value={line.quantity}
                      inputMode="decimal"
                      disabled={disabled}
                      onChange={(e) => update(line.key, { quantity: e.target.value })}
                    />
                  )}
                </Cell>
                <Cell label={t("invoice.lines.unit")} error={error(path("unit"))}>
                  {(c) => (
                    <Input
                      {...c}
                      value={line.unit}
                      maxLength={10}
                      disabled={disabled}
                      onChange={(e) => update(line.key, { unit: e.target.value })}
                    />
                  )}
                </Cell>
              </div>
              <Cell label={t("invoice.lines.price")} error={error(path("unitPriceCents"))}>
                {(c) => (
                  <MoneyInput
                    {...c}
                    value={line.price}
                    currency={currency}
                    disabled={disabled}
                    onValueChange={(price) => update(line.key, { price })}
                  />
                )}
              </Cell>
              <Cell
                label={t("invoice.lines.vat")}
                error={error(path("vat")) ?? error(path("natura"))}
              >
                {(c) => (
                  <Select
                    {...c}
                    value={line.vat}
                    disabled={disabled}
                    onChange={(e) => update(line.key, { vat: e.target.value })}
                  >
                    {line.vat === "" ? (
                      <option value="">{t("invoice.lines.chooseVat")}</option>
                    ) : null}
                    {line.vat.startsWith("rate:") &&
                    !(VAT_RATES as readonly number[]).includes(Number(line.vat.slice(5))) ? (
                      <option value={line.vat}>
                        {vatRateLabel(Number(line.vat.slice(5)), locale)}
                      </option>
                    ) : null}
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
              </Cell>
              <div className="flex items-center justify-between gap-3 md:contents">
                <p className="text-sm md:pt-2.5 md:text-right">
                  <span className="text-muted-foreground md:sr-only">
                    {t("invoice.lines.amount")}{" "}
                  </span>
                  <span className="font-medium tabular-nums">
                    {amount === undefined ? "–" : formatMoney(amount, locale, currency)}
                  </span>
                </p>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={disabled || form.lines.length === 1}
                  aria-label={t("invoice.lines.remove", { n: index + 1 })}
                  onClick={() => onChange(form.lines.filter((l) => l.key !== line.key))}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <Button
        variant="secondary"
        className="w-fit"
        disabled={disabled}
        onClick={() => onChange([...form.lines, emptyLine()])}
      >
        <Plus aria-hidden />
        {t("invoice.lines.add")}
      </Button>
    </div>
  );
}
