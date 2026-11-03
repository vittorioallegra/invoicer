import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../../i18n";
import { resetPointer, setPointer } from "../../lib/pointer-test-support";
import { DatePicker } from "./date-picker";
import { Field } from "./field";

afterEach(() => {
  cleanup();
  resetPointer();
});

async function mount(value: string, props: { readOnly?: boolean; lng?: "it" | "en" } = {}) {
  const onChange = vi.fn((event: { target: { value: string } }) => event.target.value);
  render(
    <I18nextProvider i18n={await createI18n(props.lng ?? "it")}>
      <Field label="Date">
        {(c) => (
          <DatePicker {...c} value={value} onChange={onChange} readOnly={props.readOnly ?? false} />
        )}
      </Field>
    </I18nextProvider>,
  );
  return onChange;
}

describe("DatePicker on touch devices", () => {
  it("renders the native date input", async () => {
    setPointer(true);
    const onChange = await mount("2026-03-05");
    const input = screen.getByLabelText("Date") as HTMLInputElement;
    expect(input.type).toBe("date");
    expect(input.value).toBe("2026-03-05");
    fireEvent.change(input, { target: { value: "2026-04-01" } });
    expect(onChange).toHaveReturnedWith("2026-04-01");
  });
});

describe("DatePicker with a fine pointer", () => {
  it("shows the formatted date on a labelled button", async () => {
    setPointer(false);
    await mount("2026-03-05");
    const button = screen.getByRole("button", { name: "Date" });
    expect(button.textContent).toContain("5 mar 2026");
  });

  it("picks a day from the calendar (Monday first) and returns YYYY-MM-DD", async () => {
    setPointer(false);
    const onChange = await mount("2026-03-05");
    fireEvent.click(screen.getByRole("button", { name: "Date" }));
    const grid = await screen.findByRole("grid");
    expect(grid.querySelector("th")?.textContent?.toLowerCase()).toMatch(/^lun/);
    fireEvent.click(screen.getByRole("button", { name: /12 marzo 2026/ }));
    expect(onChange).toHaveReturnedWith("2026-03-12");
    expect(screen.queryByRole("grid")).toBeNull();
  });

  it("clears and sets today", async () => {
    setPointer(false);
    const onChange = await mount("2026-03-05");
    fireEvent.click(screen.getByRole("button", { name: "Date" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancella" }));
    expect(onChange).toHaveReturnedWith("");
    fireEvent.click(screen.getByRole("button", { name: "Date" }));
    fireEvent.click(await screen.findByRole("button", { name: "Oggi" }));
    expect(onChange.mock.calls[1]?.[0].target.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("does not open when read only, and injects no style element", async () => {
    setPointer(false);
    await mount("2026-03-05", { readOnly: true });
    fireEvent.click(screen.getByRole("button", { name: "Date" }));
    expect(screen.queryByRole("grid")).toBeNull();
    cleanup();
    resetPointer();
    setPointer(false);
    await mount("2026-03-05");
    fireEvent.click(screen.getByRole("button", { name: "Date" }));
    await screen.findByRole("grid");
    expect(document.querySelectorAll("style").length).toBe(0);
  });
});
