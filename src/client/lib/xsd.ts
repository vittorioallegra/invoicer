import { type MappedXsdErrors, mapXsdErrors } from "../../shared/fatturapa";

export interface XsdCheck {
  valid: boolean;
  mapped: MappedXsdErrors;
}

/**
 * Validates a FatturaPA against the vendored official XSD (assets/xsd, v1.2.3) with xmllint-wasm,
 * in the browser. Everything is imported lazily: the schema texts (Vite `?raw`) and the WASM
 * validator are only fetched when the owner sends, and none of it is in the Worker bundle.
 */
export async function checkFatturaXml(xml: string): Promise<XsdCheck> {
  const [{ validateFatturaXml }, schema, xmldsig] = await Promise.all([
    import("../../shared/fatturapa/validate"),
    import("../../../assets/xsd/Schema_VFPR12_v1.2.3.xsd?raw"),
    import("../../../assets/xsd/xmldsig-core-schema.xsd?raw"),
  ]);
  const result = await validateFatturaXml(xml, {
    schema: schema.default,
    xmldsig: xmldsig.default,
  });
  return { valid: result.valid, mapped: mapXsdErrors(xml, result.errors) };
}
