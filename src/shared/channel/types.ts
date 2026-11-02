/**
 * Channel interface (plan step 12): how a final FatturaPA XML reaches the SdI. Implementations:
 * PEC over SMTP (Worker), manual AdE portal upload (owner does it by hand) and a mock for `dev`.
 */

export type ChannelId = "pec" | "manual" | "mock";

export interface ChannelSendInput {
  /** `IT<idCodice>_<progressive>.xml`, the name the SdI echoes in its receipts. */
  fileName: string;
  xml: Uint8Array;
  /** SdI PEC address to send to (see `sdiAddressFor`). */
  to: string;
  /** Message-ID chosen by the caller so it can be stored before the SMTP send. */
  messageId: string;
  invoiceNumber: string;
}

export interface ChannelSendResult {
  /** The PEC Message-ID of the message handed to the server. */
  messageId: string;
}

/** Stable codes for a failed send; the UI words them in plain language with a fix. */
export const CHANNEL_ERROR_CODES = [
  "auth_failed",
  "mailbox_full",
  "sdi_address_missing",
  "unavailable",
  "rejected",
  "unknown_outcome",
] as const;
export type ChannelErrorCode = (typeof CHANNEL_ERROR_CODES)[number];

/**
 * A send that did not complete. `outcome` says whether the message may have reached the server:
 * `none` = the server definitely did not take it (safe to retry as is); `unknown` = the
 * connection broke around DATA, so only the mailbox can tell (polling resolves it).
 */
export class ChannelError extends Error {
  constructor(
    readonly code: ChannelErrorCode,
    readonly outcome: "none" | "unknown",
  ) {
    super(code);
    this.name = "ChannelError";
  }
}

export interface Channel {
  readonly id: ChannelId;
  send(input: ChannelSendInput): Promise<ChannelSendResult>;
}
