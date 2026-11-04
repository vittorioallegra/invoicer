ALTER TABLE `received_invoices` ADD `supplier_vat` text;--> statement-breakpoint
ALTER TABLE `received_invoices` ADD `document_type` text;--> statement-breakpoint
ALTER TABLE `received_invoices` ADD `currency` text DEFAULT 'EUR' NOT NULL;