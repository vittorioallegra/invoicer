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
	`recipient` text NOT NULL,
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
	`year` integer,
	`issue_date` text,
	`planned_date` text,
	`operation_date` text,
	`due_date` text,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`data` text,
	`total_cents` integer,
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
CREATE UNIQUE INDEX `invoices_year_number_unique` ON `invoices` (`year`,`number_int`) WHERE "invoices"."number_int" IS NOT NULL;--> statement-breakpoint
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
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `number_sequences` (
	`year` integer PRIMARY KEY NOT NULL,
	`last_number` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
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
	CONSTRAINT "outbox_status_valid" CHECK(status IN ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_invoice_attempt_kind_unique` ON `outbox` (`invoice_id`,`attempt`,`kind`);--> statement-breakpoint
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
	`payment_defaults` text,
	`default_payment_terms_days` integer,
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
CREATE TABLE `received_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`pec_message_id` text,
	`parse_status` text DEFAULT 'pending' NOT NULL,
	`file_id` text,
	`supplier_name` text,
	`number` text,
	`issue_date` text,
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
	`recurring_lead_days` integer DEFAULT 3 NOT NULL,
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
CREATE UNIQUE INDEX `transmissions_invoice_attempt_unique` ON `transmissions` (`invoice_id`,`attempt`);