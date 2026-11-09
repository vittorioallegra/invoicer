PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_send_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`invoice_id` text,
	`xml_sha256` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_send_challenges`("id", "challenge", "invoice_id", "xml_sha256", "expires_at", "used_at", "created_at") SELECT "id", "challenge", "invoice_id", "xml_sha256", "expires_at", "used_at", "created_at" FROM `send_challenges`;--> statement-breakpoint
DROP TABLE `send_challenges`;--> statement-breakpoint
ALTER TABLE `__new_send_challenges` RENAME TO `send_challenges`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `send_challenges_challenge_unique` ON `send_challenges` (`challenge`);