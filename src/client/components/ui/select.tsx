import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import {
  type ChangeEvent,
  Children,
  type FocusEventHandler,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
} from "react";
import { useNativeControls } from "../../lib/use-native-controls";
import { cn } from "../../lib/utils";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  ref?: Ref<HTMLSelectElement>;
}

/** Radix Select forbids `value=""` on an item; the empty option travels as this sentinel. */
const EMPTY = "__empty__";

interface Option {
  value: string;
  label: ReactNode;
  disabled: boolean;
}

/** Reads `<option>` children (also inside fragments and arrays) into a flat list. */
function readOptions(children: ReactNode): Option[] {
  const out: Option[] = [];
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue;
    const el = child as ReactElement<{
      value?: string | number;
      disabled?: boolean;
      children?: ReactNode;
    }>;
    if (el.type === "option") {
      const value = el.props.value ?? "";
      out.push({
        value: String(value),
        label: el.props.children,
        disabled: Boolean(el.props.disabled),
      });
    } else if (el.props.children !== undefined) {
      out.push(...readOptions(el.props.children));
    }
  }
  return out;
}

const box =
  "min-h-11 w-full min-w-0 rounded-control border border-border bg-surface py-2 pr-9 pl-3 text-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger";

/**
 * Select with the same box as `Input`. Touch-first devices (phones) get the native select, which
 * is best there: `appearance-none` drops the platform chrome and a chevron replaces it. Pointer
 * devices get a Radix Select with a styled list. Both take `<option>` children and call
 * `onChange` with an event whose `target.value` is the chosen value.
 */
export function Select(props: SelectProps) {
  const native = useNativeControls();
  return native ? <NativeSelect {...props} /> : <RichSelect {...props} />;
}

function NativeSelect({ className, ref, ...props }: SelectProps) {
  return (
    <div className="relative w-full min-w-0">
      <select
        ref={ref}
        className={cn("block appearance-none text-ellipsis", box, className)}
        {...props}
      />
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

function RichSelect({
  className,
  ref: _ref,
  children,
  value,
  defaultValue,
  onChange,
  disabled,
  id,
  name,
  required,
  onBlur,
  ...aria
}: SelectProps) {
  const options = readOptions(children);
  const encode = (v: string) => (v === "" ? EMPTY : v);
  const decode = (v: string) => (v === EMPTY ? "" : v);
  const current = value === undefined ? undefined : encode(String(value));
  const selected = options.find((o) => encode(o.value) === current);
  return (
    <RadixSelect.Root
      {...(current !== undefined ? { value: current } : {})}
      {...(defaultValue !== undefined ? { defaultValue: encode(String(defaultValue)) } : {})}
      {...(name !== undefined ? { name } : {})}
      {...(required !== undefined ? { required } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
      onValueChange={(next) => {
        const target = { value: decode(next), name: name ?? "" };
        onChange?.({ target, currentTarget: target } as unknown as ChangeEvent<HTMLSelectElement>);
      }}
    >
      <RadixSelect.Trigger
        id={id}
        onBlur={onBlur as unknown as FocusEventHandler<HTMLButtonElement>}
        aria-label={aria["aria-label"]}
        aria-labelledby={aria["aria-labelledby"]}
        aria-describedby={aria["aria-describedby"]}
        aria-invalid={aria["aria-invalid"]}
        className={cn(
          "relative flex items-center text-left data-[placeholder]:text-muted-foreground",
          box,
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label}</span>
        <RadixSelect.Icon asChild>
          <ChevronDown
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        {/* No Radix Viewport: it injects an inline <style> that our CSP blocks; Content scrolls itself. */}
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className="z-[60] max-h-[min(20rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] max-w-[min(32rem,calc(100vw-1rem))] overflow-y-auto rounded-control border border-border bg-surface p-1 text-foreground shadow-lg"
        >
          {options.map((option) => (
            <RadixSelect.Item
              key={option.value}
              value={encode(option.value)}
              disabled={option.disabled}
              className="relative flex min-h-9 cursor-default select-none items-center rounded-sm py-1.5 pr-8 pl-2 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted"
            >
              <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
              <RadixSelect.ItemIndicator className="absolute right-2 flex items-center">
                <Check aria-hidden className="size-4" />
              </RadixSelect.ItemIndicator>
            </RadixSelect.Item>
          ))}
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
