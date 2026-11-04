# Vendored FatturaPA schemas

Official files, vendored byte for byte (never edited). XSD validation runs in the browser and in
tests with `xmllint-wasm` (`src/shared/fatturapa/validate.ts`), never in the Worker.

| File | Version | Source | SHA-256 |
|------|---------|--------|---------|
| `Schema_VFPR12_v1.2.3.xsd` | FatturaPA 1.2.3 (FPR12; the file is identical to the FPA12 one, both formats are allowed by `FormatoTrasmissioneType`) | https://www.fatturapa.gov.it/export/documenti/fatturapa/v1.4/Schema_VFPR12_v1.2.3.xsd (page: https://www.fatturapa.gov.it/it/norme-e-regole/documentazione-fattura-elettronica/formato-fatturapa/) | `152944f6eef9f5d69ef6e955ee173b32142b00a8c1c5222fc97dfab5910e8a8c` |
| `xmldsig-core-schema.xsd` | W3C XML Signature 1.0 (2002-02-12), imported by the FatturaPA schema | http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd | `35cf8197da812c85e40d57891b35c94187569ed474a2dac813ce5090dafcd35c` |

Downloaded on 2026-11-02. The FatturaPA schema imports the xmldsig schema from the W3C URL;
`xmllint-wasm` does no network access, so `validateFatturaXml` rewrites that `schemaLocation` in
memory to the preloaded local copy.

Last checked against the AdE site on 2026-11-04: the formato page still lists FatturaPA schema 1.2.3 (valid from 2025-04-01, technical specifications 1.4) as the current one, and the file downloaded from the source URL above has the SHA-256 in the table (68,619 bytes). No newer version exists; nothing to upgrade. Repeat this check before each year-end and when the AdE announces a schema change.

To update: download the new files from the official page above, replace them, update this table,
the version in `CLAUDE.md` and the file names used in `tests/fatturapa*.test.ts` and in the client
loader, then run `pnpm vitest run tests/fatturapa.test.ts --reporter=dot`.
