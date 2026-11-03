import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { formatMoney, type UiLocale } from "../../shared/format";
import { NATURA_CODES, naturaLabel, vatRateLabel } from "../../shared/totals";
import { emptyLine, type InvoiceForm, type LineForm, VAT_RATES } from "../lib/invoice-form";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { MoneyInput } from "./ui/money-input";
import { Select } from "./ui/select";
import { Textarea } from "./ui/textarea";

interface CellProps {
  label: string;
  error?: string | undefined;
  className?: string;
  /** Data path of the field (see `Field`). */
  name?: string;
  children: (control: {
    id: string;
    "aria-invalid": true | undefined;
    "aria-describedby": string | undefined;
  }) => ReactNode;
}

/** A labelled control with its error under it. */
function Cell({ label, error, className, name, children }: CellProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className={className} data-field={name}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
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

export interface InvoiceLinesProps {
  form: InvoiceForm;
  /** Amount of each line in cents, by position (see `formLineAmounts`). */
  amounts: readonly number[];
  locale: UiLocale;
  /** Translated message for a field path, or undefined. */
  error: (path: string) => string | undefined;
  onChange: (lines: LineForm[]) => void;
  disabled: boolean;
}

/** Lines as bordered cards: description, a grid of the other fields, then the note. */
export function InvoiceLines({
  form,
  amounts,
  locale,
  error,
  onChange,
  disabled,
}: InvoiceLinesProps) {
  const { t } = useTranslation();
  const currency = form.currency.toUpperCase();
  // Move and remove only make sense while editable and with something to reorder or drop.
  const controls = !disabled && form.lines.length >= 2;
  const listId = useId();
  // After a move the keyed card is re-inserted, which drops focus: put it back on the same
  // control (or its sibling when that one is now disabled at the end of the list).
  const refocus = useRef<{ key: string; direction: "up" | "down" } | null>(null);
  useEffect(() => {
    const target = refocus.current;
    if (!target) return;
    refocus.current = null;
    const own = document.getElementById(`${listId}-${target.key}-${target.direction}`);
    const other = document.getElementById(
      `${listId}-${target.key}-${target.direction === "up" ? "down" : "up"}`,
    );
    const next = own && !(own as HTMLButtonElement).disabled ? own : other;
    next?.focus();
  });

  const update = (key: string, patch: Partial<LineForm>) =>
    onChange(form.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  function move(index: number, direction: "up" | "down") {
    const target = direction === "up" ? index - 1 : index + 1;
    const lines = [...form.lines];
    const [line] = lines.splice(index, 1);
    if (!line) return;
    lines.splice(target, 0, line);
    refocus.current = { key: line.key, direction };
    onChange(lines);
  }

  return (
    <div className="flex flex-col gap-3">
      {error("lines") ? (
        <p role="alert" className="text-sm text-danger">
          {error("lines")}
        </p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {form.lines.map((line, index) => {
          const path = (field: string) => `lines.${index}.${field}`;
          const amount = amounts[index];
          const last = index === form.lines.length - 1;
          return (
            <li
              key={line.key}
              data-testid="invoice-line"
              className="flex flex-col gap-3 rounded-card border border-border p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-muted-foreground">
                  {t("invoice.lines.lineNumber", { n: index + 1 })}
                </span>
                {controls ? (
                  <div className="flex items-center">
                    <Button
                      id={`${listId}-${line.key}-up`}
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={index === 0}
                      aria-label={t("invoice.lines.moveUp", { n: index + 1 })}
                      onClick={() => move(index, "up")}
                    >
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button
                      id={`${listId}-${line.key}-down`}
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={last}
                      aria-label={t("invoice.lines.moveDown", { n: index + 1 })}
                      onClick={() => move(index, "down")}
                    >
                      <ArrowDown aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("invoice.lines.remove", { n: index + 1 })}
                      onClick={() => onChange(form.lines.filter((l) => l.key !== line.key))}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                ) : null}
              </div>
              <Cell
                label={t("invoice.lines.description")}
                error={error(path("description"))}
                name={path("description")}
              >
                {(c) => (
                  <Input
                    {...c}
                    value={line.description}
                    disabled={disabled}
                    onChange={(e) => update(line.key, { description: e.target.value })}
                  />
                )}
              </Cell>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-12">
                <Cell
                  label={t("invoice.lines.quantity")}
                  error={error(path("quantityMilli"))}
                  name={path("quantityMilli")}
                  className="md:col-span-2"
                >
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
                <Cell
                  label={t("invoice.lines.unit")}
                  error={error(path("unit"))}
                  name={path("unit")}
                  className="md:col-span-2"
                >
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
                <Cell
                  label={t("invoice.lines.price")}
                  error={error(path("unitPriceCents"))}
                  name={path("unitPriceCents")}
                  className="col-span-2 md:col-span-3"
                >
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
                  name={path("vat")}
                  className="col-span-2 md:col-span-3"
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
                <div className="col-span-2 text-right md:col-span-2">
                  <span className="mb-1 block text-sm font-medium">
                    {t("invoice.lines.amount")}
                  </span>
                  <p className="flex min-h-11 items-center font-medium tabular-nums justify-end">
                    {amount === undefined ? "–" : formatMoney(amount, locale, currency)}
                  </p>
                </div>
              </div>
              <Cell
                label={t("invoice.lines.noteOptional")}
                error={error(path("note"))}
                name={path("note")}
              >
                {(c) => (
                  <Textarea
                    {...c}
                    rows={2}
                    value={line.note}
                    disabled={disabled}
                    className="min-h-16"
                    onChange={(e) => update(line.key, { note: e.target.value })}
                  />
                )}
              </Cell>
            </li>
          );
        })}
      </ul>
      {disabled ? null : (
        <div data-field="lines" className="w-fit">
          <Button variant="secondary" onClick={() => onChange([...form.lines, emptyLine()])}>
            <Plus aria-hidden />
            {t("invoice.lines.add")}
          </Button>
        </div>
      )}
    </div>
  );
}
