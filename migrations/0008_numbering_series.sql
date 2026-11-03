CREATE TABLE `numbering_series` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prefix` text,
	`suffix` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `numbering_series_single_default` ON `numbering_series` (`is_default`) WHERE "numbering_series"."is_default" = 1;--> statement-breakpoint
DROP INDEX `invoices_year_number_unique`;--> statement-breakpoint
ALTER TABLE `invoices` ADD `series_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_series_year_number_unique` ON `invoices` (`series_id`,`year`,`number_int`) WHERE "invoices"."number_int" IS NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_number_sequences` (
	`series_id` text NOT NULL,
	`year` integer NOT NULL,
	`last_number` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`series_id`, `year`)
);
--> statement-breakpoint
INSERT INTO `__new_number_sequences`("series_id", "year", "last_number") SELECT 'default', "year", "last_number" FROM `number_sequences`;--> statement-breakpoint
DROP TABLE `number_sequences`;--> statement-breakpoint
ALTER TABLE `__new_number_sequences` RENAME TO `number_sequences`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
-- The default series (no prefix or suffix) numbers all the invoices that exist before series.
INSERT INTO `numbering_series` (`id`, `name`, `prefix`, `suffix`, `is_default`, `created_at`, `updated_at`)
VALUES ('default', 'Default', NULL, NULL, 1, CAST(strftime('%s', 'now') AS integer) * 1000, NULL);
