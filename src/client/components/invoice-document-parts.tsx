import type { ReactNode } from "react";
import { GroupBox } from "./ui/group-box";

/** A label and its value on one line; both wrap, the value is aligned to the end. */
export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-x-4 text-sm">
      <dt className="min-w-0 flex-1 text-muted-foreground">{label}</dt>
      <dd className="max-w-[60%] shrink-0 break-words text-right tabular-nums">{children}</dd>
    </div>
  );
}

/** A counterparty block: rows (tax ids...), then an address line and a contacts line. */
export function PartyBox({
  title,
  rows,
  address,
  contacts,
}: {
  title: string;
  rows: readonly { label: string; value: string }[];
  address: string;
  contacts: string;
}) {
  return (
    <GroupBox title={title}>
      {rows.length > 0 ? (
        <dl className="flex flex-col gap-1">
          {rows.map((row) => (
            <Row key={row.label} label={row.label}>
              {row.value}
            </Row>
          ))}
        </dl>
      ) : null}
      {address ? <p className="text-sm text-muted-foreground">{address}</p> : null}
      {contacts ? <p className="text-sm text-muted-foreground">{contacts}</p> : null}
    </GroupBox>
  );
}

export interface LineItem {
  key: string;
  description: string;
  /** Optional note under the description. */
  note?: string;
  /** Quantity, unit price and VAT, already formatted. */
  detail: string;
  /** The line total, already formatted. */
  total: string;
}

/** The lines of a document: description, a detail line, and the total at the end. */
export function LineList({ lines }: { lines: readonly LineItem[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border">
      {lines.map((line) => (
        <li
          key={line.key}
          className="flex items-start justify-between gap-4 py-2 first:pt-0 last:pb-0"
        >
          <div className="min-w-0">
            <p className="whitespace-pre-wrap break-words font-medium">{line.description}</p>
            {line.note ? (
              <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                {line.note}
              </p>
            ) : null}
            {line.detail ? <p className="text-sm text-muted-foreground">{line.detail}</p> : null}
          </div>
          <p className="shrink-0 font-medium tabular-nums">{line.total}</p>
        </li>
      ))}
    </ul>
  );
}
