import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "../i18n";
import { DataExport } from "./data-export";

afterEach(cleanup);

async function show(online: boolean, lng: "en" | "it" = "en") {
  render(
    <I18nextProvider i18n={await createI18n(lng)}>
      <DataExport online={online} />
    </I18nextProvider>,
  );
}

describe("Download all data", () => {
  it("links to the export as a download", async () => {
    await show(true);
    const link = screen.getByRole("link", { name: "Download all data" });
    expect(link.getAttribute("href")).toBe("/api/export");
    expect(link.hasAttribute("download")).toBe(true);
    expect(link.getAttribute("aria-disabled")).toBe("false");
  });

  it("is disabled offline and translated", async () => {
    await show(false, "it");
    const link = screen.getByRole("link", { name: "Scarica tutti i dati" });
    expect(link.getAttribute("aria-disabled")).toBe("true");
    expect(link.getAttribute("tabindex")).toBe("-1");
  });
});
