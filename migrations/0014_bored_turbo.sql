PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`kind` text NOT NULL,
	`payload` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outbox_kind_valid" CHECK(kind IN ('email', 'push', 'notification')),
	CONSTRAINT "outbox_status_valid" CHECK(status IN ('pending', 'sent', 'failed', 'asked', 'skipped'))
);
--> statement-breakpoint
INSERT INTO `__new_outbox`("id", "invoice_id", "attempt", "kind", "payload", "status", "error", "created_at", "sent_at") SELECT "id", "invoice_id", "attempt", "kind", "payload", "status", "error", "created_at", "sent_at" FROM `outbox`;--> statement-breakpoint
DROP TABLE `outbox`;--> statement-breakpoint
ALTER TABLE `__new_outbox` RENAME TO `outbox`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_invoice_attempt_kind_unique` ON `outbox` (`invoice_id`,`attempt`,`kind`);--> statement-breakpoint
ALTER TABLE `email_log` ADD `attempt` integer;--> statement-breakpoint
ALTER TABLE `email_log` ADD `trigger` text;--> statement-breakpoint
ALTER TABLE `email_log` ADD `subject` text;