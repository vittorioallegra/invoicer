# Invoice numbering: series (sezionali), format and limits

Research notes behind the numbering series feature (2026-11-03). Italian law, official sources first.

## Findings

- **Legal rule.** Since 1 January 2013 art. 21, comma 2, lett. b) of DPR 633/1972 (as amended by
  art. 1, comma 325, lett. d), L. 228/2012) requires "un numero progressivo che la identifichi in
  modo univoco". The yearly restart is no longer required.
  Source: Agenzia delle Entrate, Risoluzione 1/E of 10 January 2013 (PDF:
  https://dirittobancario.it/wp-content/uploads/sites/default/files/allegati/risoluzione_agenzia_delle_entrate_10_gennaio_2013_n._1_e.pdf;
  the Agenzia press release of the same day,
  https://agenziaentrate.gov.it/portale/documents/20143/314854/CS10012013+fatturazione_004_Com+st+Numerazione+progressiva+delle+fatture+10+01+2013.pdf/95b502d9-9b81-adab-e81f-be9c0625db2b/-/cs10012013-fatturazione).
- **Any progressive scheme is fine if it identifies the invoice uniquely**, "se del caso, anche
  mediante riferimento alla data della fattura". Allowed: one continuous series for all years
  (starting from 1, or from the number after the last 2012 invoice), or the traditional restart
  every calendar year, because the invoice date (a mandatory element) makes the pair unique.
  Same source (Risoluzione 1/E/2013).
- **Several series are allowed.** The rule comes from art. 226(2) of Directive 2006/112/EC, which the
  Italian text transposes: "a sequential number, based on one or more series, which uniquely
  identifies the invoice" (https://eur-lex.europa.eu/legal-content/IT/TXT/?uri=CELEX:32006L0112,
  art. 226). The Agenzia applies the same uniqueness test to letter-marked numbers: Risposta
  n. 132 of 30 April 2019 accepts a progressive number plus identifying letters (example
  `1/DPE`); Risposta n. 505 of 29 October 2020 accepts alphanumeric numbering
  (https://www.fisco7.it/wp-content/uploads/Interpello_n._505_del_29_ottobre_2020.pdf).
  These two answers were read through secondary summaries (the PDFs have no extractable text for
  our tools); the directive wording and Risoluzione 1/E/2013 were read directly.
- **How a series is told apart.** The law fixes no format: a prefix or suffix (`CH-3`, `3/CH`)
  that makes the full string unique is enough. Each series keeps its own progressive; the full
  string (prefix + progressive + suffix) is the invoice number everywhere.
- **FatturaPA `Numero`.** In the vendored XSD (`assets/xsd/Schema_VFPR12_v1.2.3.xsd`) `Numero` is
  `String20Type`: `\p{IsBasicLatin}{1,20}`, so at most 20 basic Latin characters. The "at least one
  digit" rule is NOT in the XSD. It could not be confirmed from an official SdI control list in
  this research (the controls list was not reachable as readable text), so we treat it as a
  precaution: the progressive is always a digit sequence, so every generated number contains digits.

## Decisions for this app

- A series has a name, an optional prefix and an optional suffix limited to letters, digits,
  `-`, `/` and `.` (all basic Latin), and the full number must stay within 20 characters.
- Exactly one default series (no prefix/suffix at migration time, used by all existing invoices).
- The progressive restarts every Europe/Rome year, per series (the traditional method of the
  Risoluzione, unique together with the invoice date). The existing rules (requested number above
  the highest issued, no gaps going back, release only of the highest) apply per series and year.
- Imported invoices count for the default series, unless their printed number clearly matches
  another series' prefix and suffix around a digit run (then they count for that series).
- Changing a series' prefix/suffix only affects invoices issued afterwards; issued invoices keep
  their stored full number.
