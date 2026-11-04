DROP TABLE `recurring_occurrences`;--> statement-breakpoint
DROP TABLE `recurring_templates`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`document_type` text DEFAULT 'TD01' NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`state_rank` integer DEFAULT 0 NOT NULL,
	`payment_flag` text DEFAULT 'unpaid' NOT NULL,
	`paid_date` text,
	`source` text DEFAULT 'app' NOT NULL,
	`client_id` text,
	`number_raw` text,
	`number_int` integer,
	`requested_number_int` integer,
	`series_id` text DEFAULT 'default' NOT NULL,
	`year` integer,
	`issue_date` text,
	`planned_date` text,
	`operation_date` text,
	`due_date` text,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`data` text,
	`total_cents` integer,
	`editor_form` text,
	`linked_invoice_id` text,
	`reissues_invoice_id` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoices_state_valid" CHECK(state IN ('draft', 'planned', 'sending', 'sent', 'delivered', 'not_delivered', 'rejected', 'rejected_expired')),
	CONSTRAINT "invoices_type_valid" CHECK(document_type IN ('TD01', 'TD04')),
	CONSTRAINT "invoices_payment_valid" CHECK(payment_flag IN ('unpaid', 'paid', 'overdue')),
	CONSTRAINT "invoices_source_valid" CHECK(source IN ('app', 'imported'))
);
--> statement-breakpoint
INSERT INTO `__new_invoices`("id", "document_type", "state", "state_rank", "payment_flag", "paid_date", "source", "client_id", "number_raw", "number_int", "requested_number_int", "series_id", "year", "issue_date", "planned_date", "operation_date", "due_date", "currency", "data", "total_cents", "editor_form", "linked_invoice_id", "reissues_invoice_id", "notes", "created_at", "updated_at") SELECT "id", "document_type", "state", "state_rank", "payment_flag", "paid_date", "source", "client_id", "number_raw", "number_int", "requested_number_int", "series_id", "year", "issue_date", "planned_date", "operation_date", "due_date", "currency", "data", "total_cents", "editor_form", "linked_invoice_id", "reissues_invoice_id", "notes", "created_at", "updated_at" FROM `invoices`;--> statement-breakpoint
DROP TABLE `invoices`;--> statement-breakpoint
ALTER TABLE `__new_invoices` RENAME TO `invoices`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_series_year_number_unique` ON `invoices` (`series_id`,`year`,`number_int`) WHERE "invoices"."number_int" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `invoices_state_idx` ON `invoices` (`state`);--> statement-breakpoint
CREATE INDEX `invoices_client_idx` ON `invoices` (`client_id`);--> statement-breakpoint
ALTER TABLE `settings` DROP COLUMN `recurring_lead_days`;