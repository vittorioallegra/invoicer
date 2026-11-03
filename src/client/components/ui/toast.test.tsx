import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "../../i18n";
import { dismissToast, Toaster, toast } from "./toast";

afterEach(() => {
  cleanup();
});

async function mount() {
  render(
    <I18nextProvider i18n={await createI18n("en")}>
      <Toaster />
    </I18nextProvider>,
  );
}

describe("toast", () => {
  it("shows the message and dismisses it with the close button", async () => {
    await mount();
    act(() => {
      toast.success("Saved");
    });
    expect(await screen.findByText("Saved")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await act(async () => {});
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("can be dismissed programmatically and supports the error variant", async () => {
    await mount();
    let id = 0;
    act(() => {
      id = toast.error("Something failed");
    });
    expect(await screen.findByText("Something failed")).toBeTruthy();
    act(() => dismissToast(id));
    expect(screen.queryByText("Something failed")).toBeNull();
  });
});
