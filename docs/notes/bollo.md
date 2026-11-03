# Bollo on e-invoices

Rules the app follows and the sources behind them. Written 2026-11-03.

## How it is expressed

- The stamp duty (2.00 EUR, DPR 642/1972 tariff art. 13) is due on invoices whose amounts not
  subject to VAT exceed 77.47 EUR. The issuer must declare it: `DatiBollo` with `BolloVirtuale`
  = `SI`. `ImportoBollo` is optional in the FatturaPA schema; the AdE ignores its content and
  computes 2 EUR for every invoice marked `SI`. The app writes `ImportoBollo` 2.00 anyway.
- The obligation is the issuer's (AdE answer 67/E of 2020; joint liability of the client under
  art. 22 DPR 642/1972). The issuer may rebill it to the client.

## Rebilling to the client

- AdE Circolare 5/E of 14 May 2021, par. 3.3, and Interpello 428 of 12 Aug 2022: the 2.00 EUR
  charged to the client "non può essere indicato in fattura quale importo escluso in base
  all'art. 15 DPR n. 633/72" (it is not an advance made in the client's name and on its
  behalf); it follows the treatment of the main service and is part of the compenso (for a
  forfettario it counts towards the flat-rate income).
- So the app does not write an N1 line. It writes an ordinary line "Imposta di bollo", 1 x 2.00,
  with the natura of the invoice's no-VAT lines (the one with the largest total, the first on a
  tie). It is part of the taxable base like any line, so it enters the total, the amount due and
  the cassa and ritenuta bases.
- Borne by the issuer: no line, totals unchanged, `DatiBollo` only.

## Sources and how they were read

- AdE guide "L'imposta di bollo sulle fatture elettroniche" (June 2026 edition, 2024 and 2021
  before it), agenziaentrate.gov.it: read directly (PDF text extracted). Covers `BolloVirtuale`,
  the irrelevance of `ImportoBollo` and the lists A and B.
- FatturaPA technical specifications v1.2.x (`assets/xsd/` holds the schema; `ImportoBollo`
  optional): checked in the vendored XSD and the specification text.
- Circ. 5/E 2021 par. 3.3 and Interpello 428/2022: read only second-hand, through a circular of
  the Regione Emilia-Romagna (prot. 0785168 of 30 Aug 2022) that quotes them. Not checked against
  the AdE originals.
- Answer 67/E of 2020 and art. 22 DPR 642/1972: second-hand, same circular.
- Practitioner pages (for example Fiscozen) were used only to see common practice (a separate
  "rimborso" line); they are not authoritative.

## Stored invoices

Invoices saved before the choice existed read as `legacy`: 2.00 EUR added to the document total
and amount due without a line, as they were calculated. The editor never offers it; an unsent
invoice opens with "Addebitato al cliente", and a duplicate, credit note or reissue starts with
the current rule.
