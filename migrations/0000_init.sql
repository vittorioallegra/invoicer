CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`vat_number` text,
	`tax_code` text,
	`foreign_tax_id` text,
	`country_code` text DEFAULT 'IT' NOT NULL,
	`address` text,
	`postal_code` text,
	`city` text,
	`province` text,
	`recipient_code` text,
	`pec` text,
	`email` text,
	`pdf_language` text DEFAULT 'it' NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`defaults` text,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `email_log` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text,
	`attempt` integer,
	`trigger` text,
	`recipient` text NOT NULL,
	`subject` text,
	`provider_message_id` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`type` text NOT NULL,
	`invoice_id` text,
	`transmission_id` text,
	`payload` text,
	`occurred_at` integer,
	`processed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transmission_id`) REFERENCES `transmissions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_source_unique` ON `events` (`source_id`);--> statement-breakpoint
CREATE TABLE `file_sequence` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`last_value` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "file_sequence_single_row" CHECK("file_sequence"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`invoice_id` text,
	`transmission_id` text,
	`received_invoice_id` text,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`content` blob NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "files_size_cap" CHECK(size <= 2097152),
	CONSTRAINT "files_kind_valid" CHECK(kind IN ('xml', 'pdf', 'received', 'import', 'pec_raw'))
);
--> statement-breakpoint
CREATE INDEX `files_invoice_idx` ON `files` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`position` integer NOT NULL,
	`description` text NOT NULL,
	`note` text,
	`quantity_milli` integer DEFAULT 1000 NOT NULL,
	`unit` text,
	`unit_price_cents` integer NOT NULL,
	`vat_rate_bp` integer,
	`natura` text,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_lines_position_unique` ON `invoice_lines` (`invoice_id`,`position`);--> statement-breakpoint
CREATE TABLE `invoices` (
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
	`recurring_template_id` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recurring_template_id`) REFERENCES `recurring_templates`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoices_state_valid" CHECK(state IN ('draft', 'planned', 'sending', 'sent', 'delivered', 'not_delivered', 'rejected', 'rejected_expired')),
	CONSTRAINT "invoices_type_valid" CHECK(document_type IN ('TD01', 'TD04')),
	CONSTRAINT "invoices_payment_valid" CHECK(payment_flag IN ('unpaid', 'paid', 'overdue')),
	CONSTRAINT "invoices_source_valid" CHECK(source IN ('app', 'imported'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_series_year_number_unique` ON `invoices` (`series_id`,`year`,`number_int`) WHERE "invoices"."number_int" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `invoices_state_idx` ON `invoices` (`state`);--> statement-breakpoint
CREATE INDEX `invoices_client_idx` ON `invoices` (`client_id`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job` text NOT NULL,
	`run_date` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`counts` text,
	`error_code` text,
	CONSTRAINT "job_runs_status_valid" CHECK(status IN ('running', 'success', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `job_runs_job_date_idx` ON `job_runs` (`job`,`run_date`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`invoice_id` text,
	`read_at` integer,
	`push_sent_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `number_sequences` (
	`series_id` text NOT NULL,
	`year` integer NOT NULL,
	`last_number` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`series_id`, `year`)
);
--> statement-breakpoint
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
CREATE TABLE `outbox` (
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
CREATE UNIQUE INDEX `outbox_invoice_attempt_kind_unique` ON `outbox` (`invoice_id`,`attempt`,`kind`);--> statement-breakpoint
CREATE TABLE `passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`transports` text,
	`created_at` integer,
	`aaguid` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passkey_user_idx` ON `passkey` (`user_id`);--> statement-breakpoint
CREATE INDEX `passkey_credential_idx` ON `passkey` (`credential_id`);--> statement-breakpoint
CREATE TABLE `payment_methods` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`iban` text NOT NULL,
	`bic` text,
	`account_holder` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_methods_single_default` ON `payment_methods` (`is_default`) WHERE "payment_methods"."is_default" = 1;--> statement-breakpoint
CREATE TABLE `pec_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`uid_validity` integer NOT NULL,
	`uid` integer NOT NULL,
	`kind` text NOT NULL,
	`sdi_message_type` text,
	`original_file_name` text,
	`size` integer NOT NULL,
	`raw_file_id` text,
	`received_at` integer,
	`processed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`raw_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pec_messages_kind_valid" CHECK(kind IN ('pec_receipt', 'sdi_message', 'received_invoice', 'ignored'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pec_messages_message_id_unique` ON `pec_messages` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pec_messages_uid_unique` ON `pec_messages` (`uid_validity`,`uid`);--> statement-breakpoint
CREATE TABLE `profile` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`vat_number` text NOT NULL,
	`tax_code` text,
	`address` text,
	`postal_code` text,
	`city` text,
	`province` text,
	`country` text DEFAULT 'IT' NOT NULL,
	`regime_fiscale` text DEFAULT 'RF01' NOT NULL,
	`email` text,
	`phone` text,
	`updated_at` integer,
	CONSTRAINT "profile_single_row" CHECK("profile"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE TABLE `rate_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`);--> statement-breakpoint
CREATE TABLE `received_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`pec_message_id` text,
	`parse_status` text DEFAULT 'pending' NOT NULL,
	`file_id` text,
	`supplier_name` text,
	`supplier_vat` text,
	`number` text,
	`issue_date` text,
	`document_type` text,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`total_cents` integer,
	`payment_flag` text DEFAULT 'unpaid' NOT NULL,
	`paid_date` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`pec_message_id`) REFERENCES `pec_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "received_invoices_parse_valid" CHECK(parse_status IN ('pending', 'parsed', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `received_invoices_pec_message_unique` ON `received_invoices` (`pec_message_id`);--> statement-breakpoint
CREATE TABLE `recurring_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`occurrence_date` text NOT NULL,
	`invoice_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `recurring_templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_occurrences_unique` ON `recurring_occurrences` (`template_id`,`occurrence_date`);--> statement-breakpoint
CREATE TABLE `recurring_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`body` text NOT NULL,
	`interval_months` integer NOT NULL,
	`day_of_month` integer NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`max_count` integer,
	`paused` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `send_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`invoice_id` text NOT NULL,
	`xml_sha256` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `send_challenges_challenge_unique` ON `send_challenges` (`challenge`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`pec_imap_host` text,
	`pec_imap_port` integer,
	`pec_smtp_host` text,
	`pec_smtp_port` integer,
	`sdi_pec_address` text,
	`mailbox_uid_validity` integer,
	`mailbox_last_uid` integer,
	`mail_quota_threshold_kb` integer,
	`email_sender_name` text,
	`email_sender_address` text,
	`email_reply_to` text,
	`email_bcc` text,
	`courtesy_email_mode` text DEFAULT 'ask' NOT NULL,
	`ui_language` text,
	`push_disabled_types` text,
	`recurring_lead_days` integer DEFAULT 3 NOT NULL,
	`pec_test_at` integer,
	`pec_test_ok` integer,
	`pec_test_error` text,
	`ade_guide_done_at` integer,
	`email_configured_at` integer,
	`tax_cassa` text,
	`tax_ritenuta` text,
	`updated_at` integer,
	CONSTRAINT "settings_single_row" CHECK("settings"."id" = 1),
	CONSTRAINT "settings_courtesy_mode" CHECK(courtesy_email_mode IN ('automatic', 'ask', 'off'))
);
--> statement-breakpoint
CREATE TABLE `transmissions` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`file_progressive` integer NOT NULL,
	`file_name` text NOT NULL,
	`channel` text NOT NULL,
	`send_outcome` text DEFAULT 'none' NOT NULL,
	`channel_message_id` text,
	`sdi_pec_address` text,
	`xml_file_id` text,
	`pdf_file_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`xml_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pdf_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transmissions_channel_valid" CHECK(channel IN ('pec', 'manual')),
	CONSTRAINT "transmissions_outcome_valid" CHECK(send_outcome IN ('none', 'complete', 'unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transmissions_file_name_unique` ON `transmissions` (`file_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `transmissions_progressive_unique` ON `transmissions` (`file_progressive`);--> statement-breakpoint
CREATE UNIQUE INDEX `transmissions_invoice_attempt_unique` ON `transmissions` (`invoice_id`,`attempt`);--> statement-breakpoint
CREATE TABLE `two_factor` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`backup_codes` text NOT NULL,
	`user_id` text NOT NULL,
	`verified` integer DEFAULT true,
	`failed_verification_count` integer DEFAULT 0,
	`locked_until` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `two_factor_user_idx` ON `two_factor` (`user_id`);--> statement-breakpoint
CREATE INDEX `two_factor_secret_idx` ON `two_factor` (`secret`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`two_factor_enabled` integer DEFAULT false,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);