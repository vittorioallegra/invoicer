import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPointer, setPointer } from "../../lib/pointer-test-support";
import { Field } from "./field";
import { Select } from "./select";

afterEach(() => {
  cleanup();
  resetPointer();
});

function mount(onChange = vi.fn(), extra: { disabled?: boolean; error?: string } = {}) {
  render(
    <Field label="Country" error={extra.error}>
      {(c) => (
        <Select {...c} value="" disabled={extra.disabled ?? false} onChange={onChange}>
          <option value="">None</option>
          <option value="it">Italy</option>
          <option value="fr">France</option>
        </Select>
      )}
    </Field>,
  );
  return onChange;
}

describe("Select on touch devices (and without matchMedia)", () => {
  it("renders the native select", () => {
    setPointer(true);
    const onChange = mount();
    const select = screen.getByLabelText("Country") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    fireEvent.change(select, { target: { value: "fr" } });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("defaults to native when matchMedia is missing", () => {
    mount();
    expect(screen.getByLabelText("Country").tagName).toBe("SELECT");
  });
});

describe("Select with a fine pointer", () => {
  it("renders a labelled combobox showing the empty option", () => {
    setPointer(false);
    mount();
    const trigger = screen.getByRole("combobox", { name: "Country" });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.textContent).toContain("None");
  });

  it("does not open inside a disabled fieldset (a read-only form)", () => {
    setPointer(false);
    render(
      <fieldset disabled>
        <Select aria-label="Country" value="it" onChange={vi.fn()}>
          <option value="it">Italy</option>
          <option value="fr">France</option>
        </Select>
      </fieldset>,
    );
    const trigger = screen.getByRole("combobox", { name: "Country" });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.queryByRole("option", { name: "France" })).toBeNull();
  });

  it("opens by keyboard and reports the chosen value like a change event", async () => {
    setPointer(false);
    const onChange = mount();
    const trigger = screen.getByRole("combobox", { name: "Country" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "France" }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0].target.value).toBe("fr");
  });

  it("maps the empty option to an empty value", async () => {
    setPointer(false);
    const onChange = vi.fn();
    render(
      <Select aria-label="Country" value="it" onChange={onChange}>
        <option value="">None</option>
        <option value="it">Italy</option>
      </Select>,
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "None" }));
    expect(onChange.mock.calls[0]?.[0].target.value).toBe("");
  });

  it("keeps the invalid state, the hint wiring and disabled", () => {
    setPointer(false);
    mount(vi.fn(), { disabled: true, error: "Required" });
    const trigger = screen.getByRole("combobox", { name: "Country" });
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    expect(trigger.getAttribute("aria-describedby")).toBeTruthy();
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not inject the Radix viewport style element (blocked by the CSP)", async () => {
    setPointer(false);
    mount();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await screen.findByRole("option", { name: "Italy" });
    const css = [...document.querySelectorAll("style")].map((el) => el.textContent).join("");
    expect(css).not.toContain("radix-select-viewport");
  });
});
