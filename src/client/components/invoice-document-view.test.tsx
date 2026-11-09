import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "../i18n";
import { parseInvoiceFile } from "../import/read";
import { InvoiceDocumentView } from "./invoice-document-view";

afterEach(cleanup);

const invoice = parseInvoiceFile(
  "IT01234567890_FPR01.xml.p7m",
  new Uint8Array(
    readFileSync(resolve(process.cwd(), "src/client/import/fixtures/IT01234567890_FPR01.xml.p7m")),
  ),
);

async function show(counterparty: "supplier" | "customer", documents = invoice.documents) {
  render(
    <I18nextProvider i18n={await createI18n("en")}>
      <InvoiceDocumentView invoice={{ ...invoice, documents }} counterparty={counterparty} />
    </I18nextProvider>,
  );
}

describe("InvoiceDocumentView", () => {
  it("shows only the chosen party, without its name, and no header for a single document", async () => {
    await show("supplier");
    expect(screen.getByText("Supplier")).toBeTruthy();
    expect(screen.queryByText("Customer")).toBeNull();
    expect(screen.queryByText(invoice.supplier.name)).toBeNull();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(screen.queryByText(/^Dated /)).toBeNull();
  });

  it("shows the customer of an issued invoice and never the owner's own block", async () => {
    await show("customer");
    expect(screen.getByText("Customer")).toBeTruthy();
    expect(screen.queryByText("Supplier")).toBeNull();
  });

  it("keeps the header of every document of a file with several", async () => {
    const first = invoice.documents[0];
    if (!first) throw new Error("fixture has no document");
    await show("supplier", [first, { ...first, number: "999" }]);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
    expect(screen.getAllByText(/^Dated /)).toHaveLength(2);
    expect(screen.getByText(/No\. 999/)).toBeTruthy();
  });
});
