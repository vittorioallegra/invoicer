-- Local demo data for `pnpm dev` (run `pnpm db:seed`; safe to run again). Four issued invoices of
-- 2026 for one client: 22% VAT with a 4% rivalsa, 22% VAT paid, VAT-exempt, and a credit note.
-- Totals are stored as the editor would: taxable + VAT (the stamp and ritenuta are not used).
INSERT OR IGNORE INTO clients (id, type, name, country_code, created_at)
VALUES ('demo-client', 'it_company', 'Acme S.r.l.', 'IT', CAST(strftime('%s', 'now') AS integer) * 1000);

INSERT OR IGNORE INTO invoices
  (id, document_type, state, state_rank, payment_flag, paid_date, source, client_id, number_raw,
   number_int, series_id, year, issue_date, planned_date, due_date, currency, data, total_cents,
   created_at)
VALUES
  ('demo-1', 'TD01', 'delivered', 4, 'unpaid', NULL, 'app', 'demo-client', '1', 1, 'default', 2026,
   '2026-09-15', '2026-09-15', '2026-10-15', 'EUR',
   '{"cassa":{"type":"rivalsa_inps","rateBp":400,"mode":"excluded","subjectToRitenuta":false},"ritenuta":null,"bollo":false,"bolloCharge":"client","bolloSuggestionDismissed":false,"note":"","naturaTexts":{},"language":null,"payment":{"method":null,"iban":null,"bic":null,"accountHolder":null,"bankName":null,"terms":null}}',
   126880, CAST(strftime('%s', 'now') AS integer) * 1000),
  ('demo-2', 'TD01', 'delivered', 4, 'paid', '2026-10-20', 'app', 'demo-client', '2', 2, 'default', 2026,
   '2026-10-01', '2026-10-01', '2026-10-31', 'EUR',
   '{"cassa":null,"ritenuta":null,"bollo":false,"bolloCharge":"client","bolloSuggestionDismissed":false,"note":"","naturaTexts":{},"language":null,"payment":{"method":null,"iban":null,"bic":null,"accountHolder":null,"bankName":null,"terms":null}}',
   61000, CAST(strftime('%s', 'now') AS integer) * 1000),
  ('demo-3', 'TD01', 'delivered', 4, 'unpaid', NULL, 'app', 'demo-client', '3', 3, 'default', 2026,
   '2026-10-10', '2026-10-10', '2026-11-30', 'EUR',
   '{"cassa":null,"ritenuta":null,"bollo":false,"bolloCharge":"client","bolloSuggestionDismissed":false,"note":"","naturaTexts":{},"language":null,"payment":{"method":null,"iban":null,"bic":null,"accountHolder":null,"bankName":null,"terms":null}}',
   50000, CAST(strftime('%s', 'now') AS integer) * 1000),
  ('demo-4', 'TD04', 'delivered', 4, 'unpaid', NULL, 'app', 'demo-client', '4', 4, 'default', 2026,
   '2026-10-25', '2026-10-25', NULL, 'EUR',
   '{"cassa":null,"ritenuta":null,"bollo":false,"bolloCharge":"client","bolloSuggestionDismissed":false,"note":"","naturaTexts":{},"language":null,"payment":{"method":null,"iban":null,"bic":null,"accountHolder":null,"bankName":null,"terms":null}}',
   24400, CAST(strftime('%s', 'now') AS integer) * 1000);

INSERT OR IGNORE INTO invoice_lines
  (id, invoice_id, position, description, quantity_milli, unit_price_cents, vat_rate_bp, natura)
VALUES
  ('demo-1-l1', 'demo-1', 0, 'Consulting', 1000, 100000, 2200, NULL),
  ('demo-2-l1', 'demo-2', 0, 'Design work', 1000, 50000, 2200, NULL),
  ('demo-3-l1', 'demo-3', 0, 'Training (exempt)', 1000, 50000, NULL, 'N2.2'),
  ('demo-4-l1', 'demo-4', 0, 'Refund of design work', 1000, 20000, 2200, NULL);
