import type { ReactNode } from "react";

/**
 * A titled group of related fields: the title above, the fields in a bordered box below it. The
 * border sits on an inner box, not on the fieldset, because a legend always cuts a fieldset's own
 * border; the borderless fieldset keeps the legend as the group's accessible name.
 */
export function GroupBox({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-sm font-semibold">{title}</legend>
      <div className="flex flex-col gap-3 rounded-card border border-border p-4">{children}</div>
    </fieldset>
  );
}
