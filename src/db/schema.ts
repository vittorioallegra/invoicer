import { sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { INVOICE_STATES, PAYMENT_STATES } from "../shared/invoice-state";
import { MAX_FILE_BYTES } from "../shared/limits";

export { MAX_FILE_BYTES };

export const DOCUMENT_TYPES = ["TD01", "TD04"] as const;
export const INVOICE_SOURCES = ["app", "imported"] as const;
export const CHANNELS = ["pec", "manual"] as const;
export const SEND_OUTCOMES = ["none", "complete", "unknown"] as const;
export const FILE_KINDS = ["xml", "pdf", "received", "import", "pec_raw"] as const;
export const PEC_MESSAGE_KINDS = [
  "pec_receipt",
  "sdi_message",
  "received_invoice",
  "ignored",
] as const;
export const PARSE_STATUSES = ["pending", "parsed", "failed"] as const;
export const OUTBOX_KINDS = ["email", "push", "notification"] as const;
/**
 * `asked`: a courtesy email waiting for the owner's Send / Skip (mode ask); `skipped`: not sent
 * on purpose (off, not configured, no recipient, or the owner skipped it).
 */
export const OUTBOX_STATUSES = ["pending", "sent", "failed", "asked", "skipped"] as const;
export const EMAIL_TRIGGERS = ["automatic", "ask", "manual"] as const;
export const JOB_STATUSES = ["running", "success", "failed"] as const;

const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(", ")})`);

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());

/** Issuer profile: a single row (`id = 1`). */
export const profile = sqliteTable(
  "profile",
  {
    id: integer("id").primaryKey().default(1),
    name: text("name").notNull(),
    vatNumber: text("vat_number").notNull(),
    taxCode: text("tax_code"),
    address: text("address"),
    postalCode: text("postal_code"),
    city: text("city"),
    province: text("province"),
    country: text("country").notNull().default("IT"),
    regimeFiscale: text("regime_fiscale").notNull().default("RF01"),
    email: text("email"),
    phone: text("phone"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (t) => [check("profile_single_row", sql`${t.id} = 1`)],
);

/**
 * Bank accounts the owner can print on invoices (payment method MP05). Exactly one is the
 * default while any exist (partial unique index; the Worker keeps it so). Invoices copy the
 * chosen account into their own data, so editing or deleting an account never changes one.
 */
export const paymentMethods = sqliteTable(
  "payment_methods",
  {
    id: id(),
    label: text("label").notNull(),
    iban: text("iban").notNull(),
    bic: text("bic"),
    accountHolder: text("account_holder"),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("payment_methods_single_default").on(t.isDefault).where(sql`${t.isDefault} = 1`),
  ],
);

/**
 * Numbering series (sezionali). Each series has its own yearly progressive; the printed number is
 * prefix + progressive + suffix. Exactly one series is the default (partial unique index; the
 * Worker keeps it so). Migration 0001 creates the default series (`id = 'default'`) in every
 * new database.
 */
export const numberingSeries = sqliteTable(
  "numbering_series",
  {
    id: id(),
    name: text("name").notNull(),
    prefix: text("prefix"),
    suffix: text("suffix"),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("numbering_series_single_default").on(t.isDefault).where(sql`${t.isDefault} = 1`),
  ],
);

/** Application settings: a single row (`id = 1`), including the PEC mailbox cursor. */
export const settings = sqliteTable(
  "settings",
  {
    id: integer("id").primaryKey().default(1),
    pecImapHost: text("pec_imap_host"),
    pecImapPort: integer("pec_imap_port"),
    pecSmtpHost: text("pec_smtp_host"),
    pecSmtpPort: integer("pec_smtp_port"),
    /** SdI PEC address assigned by the SdI in its first reply; null until known. */
    sdiPecAddress: text("sdi_pec_address"),
    /** Mailbox cursor: UIDVALIDITY of the INBOX and the last UID processed under it. */
    mailboxUidValidity: integer("mailbox_uid_validity"),
    mailboxLastUid: integer("mailbox_last_uid"),
    emailSenderName: text("email_sender_name"),
    emailSenderAddress: text("email_sender_address"),
    emailReplyTo: text("email_reply_to"),
    emailBcc: text("email_bcc"),
    courtesyEmailMode: text("courtesy_email_mode").notNull().default("ask"),
    /** The owner's UI language, kept here so the Worker can write push text in it. */
    uiLanguage: text("ui_language", { enum: ["it", "en"] }),
    /** Notification types the owner turned push off for (JSON array of type names). */
    pushDisabledTypes: text("push_disabled_types", { mode: "json" }),
    /** Last PEC connection test (IMAP login + mailbox open): when, whether it passed, why not. */
    pecTestAt: integer("pec_test_at", { mode: "timestamp_ms" }),
    pecTestOk: integer("pec_test_ok", { mode: "boolean" }),
    pecTestError: text("pec_test_error"),
    /** Mailbox space in KiB the last test read from the server (null: not reported). */
    pecTestQuotaUsedKb: integer("pec_test_quota_used_kb"),
    pecTestQuotaLimitKb: integer("pec_test_quota_limit_kb"),
    /** Setup checklist items the owner confirms by hand (set when done, null when pending). */
    adeGuideDoneAt: integer("ade_guide_done_at", { mode: "timestamp_ms" }),
    emailConfiguredAt: integer("email_configured_at", { mode: "timestamp_ms" }),
    /** The owner's cassa previdenziale and ritenuta d'acconto (Tax details), JSON; null = none. */
    taxCassa: text("tax_cassa", { mode: "json" }),
    taxRitenuta: text("tax_ritenuta", { mode: "json" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    check("settings_single_row", sql`${t.id} = 1`),
    check("settings_courtesy_mode", inList("courtesy_email_mode", ["automatic", "ask", "off"])),
  ],
);

export const clients = sqliteTable("clients", {
  id: id(),
  type: text("type", {
    enum: ["it_company", "it_private", "eu_company", "non_eu_company", "foreign_private"],
  }).notNull(),
  name: text("name").notNull(),
  vatNumber: text("vat_number"),
  taxCode: text("tax_code"),
  foreignTaxId: text("foreign_tax_id"),
  countryCode: text("country_code").notNull().default("IT"),
  address: text("address"),
  postalCode: text("postal_code"),
  city: text("city"),
  province: text("province"),
  recipientCode: text("recipient_code"),
  pec: text("pec"),
  email: text("email"),
  pdfLanguage: text("pdf_language", { enum: ["it", "en"] })
    .notNull()
    .default("it"),
  currency: text("currency").notNull().default("EUR"),
  /** Default VAT/exemption, rivalsa/cassa/ritenuta/bollo and payment terms (JSON). */
  defaults: text("defaults", { mode: "json" }),
  createdAt: createdAt(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

export const invoices = sqliteTable(
  "invoices",
  {
    id: id(),
    documentType: text("document_type", { enum: DOCUMENT_TYPES }).notNull().default("TD01"),
    state: text("state", { enum: INVOICE_STATES }).notNull().default("draft"),
    /** Position of `state` in INVOICE_STATES; guarded updates never lower it by accident. */
    stateRank: integer("state_rank").notNull().default(0),
    paymentFlag: text("payment_flag", { enum: PAYMENT_STATES }).notNull().default("unpaid"),
    paidDate: text("paid_date"),
    source: text("source", { enum: INVOICE_SOURCES }).notNull().default("app"),
    clientId: text("client_id").references(() => clients.id),
    /** Customer name as written in a summary import (no client record behind it); null otherwise. */
    counterpartyName: text("counterparty_name"),
    /** Number as printed (imported invoices may carry any string); null while draft. */
    numberRaw: text("number_raw"),
    /** Parsed integer part of the number, used for uniqueness within the series and year. */
    numberInt: integer("number_int"),
    /** Number the owner asked for on a draft (null = automatic); cleared once a number is reserved. */
    requestedNumberInt: integer("requested_number_int"),
    /** Numbering series (plain reference to `numbering_series`, no foreign key: see the delete guard). */
    seriesId: text("series_id").notNull().default("default"),
    year: integer("year"),
    /** Calendar dates as `YYYY-MM-DD`. */
    issueDate: text("issue_date"),
    /** The invoice date set by the owner on an unnumbered invoice (column kept from "planned date"). */
    invoiceDate: text("planned_date"),
    /** Unused since the editor has a single invoice date; the column is kept to avoid a data loss. */
    operationDate: text("operation_date"),
    dueDate: text("due_date"),
    currency: text("currency").notNull().default("EUR"),
    /** Invoice settings (cassa, ritenuta, bollo, payment data, note) as JSON. */
    data: text("data", { mode: "json" }),
    totalCents: integer("total_cents"),
    /** The editor form as typed at the last save (raw text, JSON), so an unsent invoice reopens exactly as left. */
    editorForm: text("editor_form"),
    linkedInvoiceId: text("linked_invoice_id"),
    /** Rejected invoice this one reissues after `rejected_expired`. */
    reissuesInvoiceId: text("reissues_invoice_id"),
    /** Unused since the internal invoice notes were removed; the column is kept to avoid a data loss. */
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("invoices_series_year_number_unique")
      .on(t.seriesId, t.year, t.numberInt)
      .where(sql`${t.numberInt} IS NOT NULL`),
    index("invoices_state_idx").on(t.state),
    index("invoices_client_idx").on(t.clientId),
    check("invoices_state_valid", inList("state", INVOICE_STATES)),
    check("invoices_type_valid", inList("document_type", DOCUMENT_TYPES)),
    check("invoices_payment_valid", inList("payment_flag", PAYMENT_STATES)),
    check("invoices_source_valid", inList("source", INVOICE_SOURCES)),
  ],
);

export const invoiceLines = sqliteTable(
  "invoice_lines",
  {
    id: id(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    description: text("description").notNull(),
    /** Optional note appended to the description in the XML and printed under it on the PDF. */
    note: text("note"),
    /** Quantity in thousandths and prices in cents as integers. */
    quantityMilli: integer("quantity_milli").notNull().default(1000),
    unit: text("unit"),
    unitPriceCents: integer("unit_price_cents").notNull(),
    vatRateBp: integer("vat_rate_bp"),
    natura: text("natura"),
  },
  (t) => [uniqueIndex("invoice_lines_position_unique").on(t.invoiceId, t.position)],
);

/** Global file progressive counter: a single row (`id = 1`). */
export const fileSequence = sqliteTable(
  "file_sequence",
  {
    id: integer("id").primaryKey().default(1),
    lastValue: integer("last_value").notNull().default(0),
  },
  (t) => [check("file_sequence_single_row", sql`${t.id} = 1`)],
);

/**
 * One scratch row per series and calendar year used by the numbering batch (guard and last
 * allocated number). It is not a setting: the next number always comes from the invoices themselves.
 */
export const numberSequences = sqliteTable(
  "number_sequences",
  {
    seriesId: text("series_id").notNull(),
    year: integer("year").notNull(),
    lastNumber: integer("last_number").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.seriesId, t.year] })],
);

/**
 * Stored files. Owner columns are plain references (no foreign keys) so that rows can point at
 * files and files at rows without cycles; the storage interface keeps them consistent.
 */
export const files = sqliteTable(
  "files",
  {
    id: id(),
    kind: text("kind", { enum: FILE_KINDS }).notNull(),
    invoiceId: text("invoice_id"),
    transmissionId: text("transmission_id"),
    receivedInvoiceId: text("received_invoice_id"),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    content: blob("content", { mode: "buffer" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("files_size_cap", sql.raw(`size <= ${MAX_FILE_BYTES}`)),
    check("files_kind_valid", inList("kind", FILE_KINDS)),
    index("files_invoice_idx").on(t.invoiceId),
  ],
);

export const transmissions = sqliteTable(
  "transmissions",
  {
    id: id(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id),
    /** Attempt counter per invoice, starting at 1. */
    attempt: integer("attempt").notNull(),
    fileProgressive: integer("file_progressive").notNull(),
    fileName: text("file_name").notNull(),
    channel: text("channel", { enum: CHANNELS }).notNull(),
    sendOutcome: text("send_outcome", { enum: SEND_OUTCOMES }).notNull().default("none"),
    /** PEC Message-ID of the sent message. */
    channelMessageId: text("channel_message_id"),
    sdiPecAddress: text("sdi_pec_address"),
    xmlFileId: text("xml_file_id").references(() => files.id),
    pdfFileId: text("pdf_file_id").references(() => files.id),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("transmissions_file_name_unique").on(t.fileName),
    uniqueIndex("transmissions_progressive_unique").on(t.fileProgressive),
    uniqueIndex("transmissions_invoice_attempt_unique").on(t.invoiceId, t.attempt),
    check("transmissions_channel_valid", inList("channel", CHANNELS)),
    check("transmissions_outcome_valid", inList("send_outcome", SEND_OUTCOMES)),
  ],
);

export const pecMessages = sqliteTable(
  "pec_messages",
  {
    id: id(),
    messageId: text("message_id").notNull(),
    uidValidity: integer("uid_validity").notNull(),
    uid: integer("uid").notNull(),
    kind: text("kind", { enum: PEC_MESSAGE_KINDS }).notNull(),
    /** SdI message type (RC, MC, NS, ...) or null when not an SdI message. */
    sdiMessageType: text("sdi_message_type"),
    originalFileName: text("original_file_name"),
    size: integer("size").notNull(),
    rawFileId: text("raw_file_id").references(() => files.id),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("pec_messages_message_id_unique").on(t.messageId),
    uniqueIndex("pec_messages_uid_unique").on(t.uidValidity, t.uid),
    check("pec_messages_kind_valid", inList("kind", PEC_MESSAGE_KINDS)),
  ],
);

export const receivedInvoices = sqliteTable(
  "received_invoices",
  {
    id: id(),
    pecMessageId: text("pec_message_id").references(() => pecMessages.id),
    parseStatus: text("parse_status", { enum: PARSE_STATUSES }).notNull().default("pending"),
    fileId: text("file_id").references(() => files.id),
    supplierName: text("supplier_name"),
    /** Supplier tax identifier (VAT id with country, else codice fiscale) as read from the file. */
    supplierVat: text("supplier_vat"),
    number: text("number"),
    issueDate: text("issue_date"),
    /** SdI document type of the first document (TD01, TD04, ...); null until the file is read. */
    documentType: text("document_type"),
    currency: text("currency").notNull().default("EUR"),
    totalCents: integer("total_cents"),
    paymentFlag: text("payment_flag", { enum: PAYMENT_STATES }).notNull().default("unpaid"),
    paidDate: text("paid_date"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("received_invoices_pec_message_unique").on(t.pecMessageId),
    check("received_invoices_parse_valid", inList("parse_status", PARSE_STATUSES)),
  ],
);

/** SdI receipts and error events, deduplicated on their source id. */
export const events = sqliteTable(
  "events",
  {
    id: id(),
    /** Stable id of the source (the PEC message id of the receipt, or a synthetic key). */
    sourceId: text("source_id").notNull(),
    type: text("type").notNull(),
    invoiceId: text("invoice_id").references(() => invoices.id),
    transmissionId: text("transmission_id").references(() => transmissions.id),
    payload: text("payload", { mode: "json" }),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("events_source_unique").on(t.sourceId)],
);

/** Side effects (courtesy email, push, in-app notification) enqueued with the state change. */
export const outbox = sqliteTable(
  "outbox",
  {
    id: id(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id),
    attempt: integer("attempt").notNull().default(1),
    kind: text("kind", { enum: OUTBOX_KINDS }).notNull(),
    payload: text("payload", { mode: "json" }),
    status: text("status", { enum: OUTBOX_STATUSES }).notNull().default("pending"),
    error: text("error"),
    createdAt: createdAt(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("outbox_invoice_attempt_kind_unique").on(t.invoiceId, t.attempt, t.kind),
    check("outbox_kind_valid", inList("kind", OUTBOX_KINDS)),
    check("outbox_status_valid", inList("status", OUTBOX_STATUSES)),
  ],
);

export const notifications = sqliteTable("notifications", {
  id: id(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  invoiceId: text("invoice_id").references(() => invoices.id),
  readAt: integer("read_at", { mode: "timestamp_ms" }),
  /** When the push for this row was settled (sent, or skipped: type off, no device); null = open. */
  pushSentAt: integer("push_sent_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
});

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: id(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint_unique").on(t.endpoint)],
);

export const emailLog = sqliteTable("email_log", {
  id: id(),
  invoiceId: text("invoice_id").references(() => invoices.id),
  /** Transmission attempt the email belongs to (the latest one for a manual send). */
  attempt: integer("attempt"),
  trigger: text("trigger", { enum: EMAIL_TRIGGERS }),
  recipient: text("recipient").notNull(),
  subject: text("subject"),
  providerMessageId: text("provider_message_id"),
  status: text("status", { enum: ["sent", "failed"] }).notNull(),
  error: text("error"),
  createdAt: createdAt(),
});

export const jobRuns = sqliteTable(
  "job_runs",
  {
    id: id(),
    job: text("job").notNull(),
    /** Europe/Rome date (`YYYY-MM-DD`) the run belongs to; used by the daily-job gate. */
    runDate: text("run_date"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("running"),
    /** Processed/created/failed counts as JSON. */
    counts: text("counts", { mode: "json" }),
    errorCode: text("error_code"),
  },
  (t) => [
    index("job_runs_job_date_idx").on(t.job, t.runDate),
    check("job_runs_status_valid", inList("status", JOB_STATUSES)),
  ],
);

/** Single-use WebAuthn challenges for send authorization, bound to an invoice and its XML hash. */
export const sendChallenges = sqliteTable("send_challenges", {
  id: id(),
  challenge: text("challenge").notNull().unique(),
  invoiceId: text("invoice_id")
    .notNull()
    .references(() => invoices.id),
  xmlSha256: text("xml_sha256").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
});

// --- Authentication (Better Auth) ------------------------------------------------------------
// Table and field names follow Better Auth's model names (camelCase keys, snake_case columns).
// A single owner account exists; sign-up is closed once it does (src/worker/auth/setup.ts).

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).default(false),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    /** PBKDF2 hash string (`src/worker/auth/password.ts`), never the password. */
    password: text("password"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const twoFactor = sqliteTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: integer("verified", { mode: "boolean" }).default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: timestamp("locked_until"),
  },
  (t) => [index("two_factor_user_idx").on(t.userId), index("two_factor_secret_idx").on(t.secret)],
);

export const passkey = sqliteTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
    transports: text("transports"),
    createdAt: timestamp("created_at"),
    aaguid: text("aaguid"),
  },
  (t) => [
    index("passkey_user_idx").on(t.userId),
    index("passkey_credential_idx").on(t.credentialID),
  ],
);

/** Login rate-limit counters (Better Auth `storage: "database"`; Worker isolates share no memory). */
export const rateLimit = sqliteTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
});
