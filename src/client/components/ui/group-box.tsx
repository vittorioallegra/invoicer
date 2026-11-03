import type { ReactNode } from "react";

/**
 * A bordered group of related fields with its title inside the box. The border sits on a wrapper,
 * not on the fieldset: a legend always cuts a fieldset's own border (Safari ignores the float
 * workaround), while a borderless fieldset keeps the legend as the group's accessible name.
 */
export function GroupBox({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-card border border-border p-4">
      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-3 text-sm font-semibold">{title}</legend>
        {children}
      </fieldset>
    </div>
  );
}
