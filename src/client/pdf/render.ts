import { buildInvoicePdfModel, type InvoicePdfInput } from "./invoice-model";

/**
 * Renders the invoice PDF in the requested language. `@react-pdf/renderer` is loaded on demand
 * so it stays out of the main bundle (and, being client-only, out of the Worker bundle).
 */
export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Uint8Array> {
  const [{ pdf }, { InvoiceDocument }, { createI18n }] = await Promise.all([
    import("@react-pdf/renderer"),
    import("./invoice-document"),
    import("../i18n"),
  ]);
  const i18n = await createI18n(input.language);
  const t = i18n.getFixedT(input.language);
  const model = buildInvoicePdfModel(input, t);
  const blob = await pdf(InvoiceDocument({ model, t })).toBlob();
  return new Uint8Array(await blob.arrayBuffer());
}
