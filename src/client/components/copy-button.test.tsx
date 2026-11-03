import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../i18n";
import { CopyButton } from "./copy-button";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function show(writeText: (text: string) => Promise<void>) {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  render(
    <I18nextProvider i18n={await createI18n("en")}>
      <CopyButton text={"aaa\nbbb"} label="Copy recovery codes" />
    </I18nextProvider>,
  );
}

describe("CopyButton", () => {
  it("copies the text and shows the copied state", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    await show(writeText);
    fireEvent.click(screen.getByRole("button", { name: "Copy recovery codes" }));
    expect(writeText).toHaveBeenCalledWith("aaa\nbbb");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Copied");
  });

  it("explains how to copy by hand when the clipboard refuses", async () => {
    await show(vi.fn().mockRejectedValue(new Error("denied")));
    fireEvent.click(screen.getByRole("button", { name: "Copy recovery codes" }));
    expect((await screen.findByRole("status")).textContent).toContain("copy it by hand");
    expect(screen.getByRole("button", { name: "Copy recovery codes" })).toBeTruthy();
  });
});
