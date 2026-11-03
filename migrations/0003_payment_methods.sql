CREATE TABLE `payment_methods` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`iban` text NOT NULL,
	`bic` text,
	`bank_name` text,
	`account_holder` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_methods_single_default` ON `payment_methods` (`is_default`) WHERE `is_default` = 1;--> statement-breakpoint
-- Keep the owner's existing default payment data as the first (default) account.
INSERT INTO `payment_methods` (`id`, `label`, `iban`, `bic`, `bank_name`, `account_holder`, `is_default`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))),
  COALESCE(NULLIF(trim(json_extract(`payment_defaults`, '$.bankName')), ''), 'Bank account'),
  json_extract(`payment_defaults`, '$.iban'),
  NULLIF(json_extract(`payment_defaults`, '$.bic'), ''),
  NULLIF(json_extract(`payment_defaults`, '$.bankName'), ''),
  NULLIF(json_extract(`payment_defaults`, '$.accountHolder'), ''),
  1, CAST(strftime('%s', 'now') AS integer) * 1000, NULL
FROM `profile`
WHERE json_valid(`payment_defaults`) AND COALESCE(json_extract(`payment_defaults`, '$.iban'), '') <> '';--> statement-breakpoint
ALTER TABLE `profile` DROP COLUMN `payment_defaults`;