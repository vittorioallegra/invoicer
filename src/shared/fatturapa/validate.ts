/**
 * XSD validation of a FatturaPA with `xmllint-wasm` (libxml2 compiled to WebAssembly).
 *
 * Heavy work: it runs in the browser (before a send) and in tests, never in the Worker (10 ms CPU
 * limit, and the library is on the bundle check's client-only list). This module is therefore not
 * re-exported by `index.ts`; import it only from client code and tests. The schema texts are
 * passed in by the caller (the client loads them with Vite `?raw`, tests read `assets/xsd/`), so
 * the module itself stays free of bundler specifics.
 */

export interface XsdAssets {
  /** `Schema_VFPR12_v1.2.3.xsd` (the same schema file covers FPR12 and FPA12). */
  schema: string;
  /** `xmldsig-core-schema.xsd`, imported by the FatturaPA schema. */
  xmldsig: string;
}

export interface XsdError {
  /** Message without file name and line, as libxml2 words it. */
  message: string;
  /** 1-based line of the offending element in the validated XML, or null. */
  line: number | null;
}

export interface XsdResult {
  valid: boolean;
  errors: XsdError[];
}

const XMLDSIG_FILE = "xmldsig-core-schema.xsd";
const SCHEMA_FILE = "fatturapa.xsd";
const XML_FILE = "invoice.xml";

/**
 * Validates `xml` against the official schema. The vendored schema points at the W3C URL for the
 * xmldsig import; xmllint-wasm never touches the network, so the location is rewritten in memory
 * to the preloaded copy (the vendored bytes stay untouched).
 */
export async function validateFatturaXml(xml: string, assets: XsdAssets): Promise<XsdResult> {
  const { validateXML } = await import("xmllint-wasm");
  const schema = assets.schema.replace(
    /(<xs:import\b[^>]*schemaLocation=")[^"]*(")/,
    `$1${XMLDSIG_FILE}$2`,
  );
  const result = await validateXML({
    xml: [{ fileName: XML_FILE, contents: xml }],
    schema: [{ fileName: SCHEMA_FILE, contents: schema }],
    preload: [{ fileName: XMLDSIG_FILE, contents: assets.xmldsig }],
  });
  return {
    valid: result.valid,
    errors: result.errors.map((error) => ({
      message: error.message,
      line: error.loc?.lineNumber ?? null,
    })),
  };
}
