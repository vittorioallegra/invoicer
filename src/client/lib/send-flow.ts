import { startAuthentication } from "@simplewebauthn/browser";
import type { ClientRecord } from "../../shared/client";
import { romeDateTime } from "../../shared/cron";
import {
  buildFatturaXml,
  decodeFileProgressive,
  type FatturaInput,
  type FatturaIssuer,
  type MappedXsdErrors,
} from "../../shared/fatturapa";
import type { InvoiceRecord } from "../../shared/invoice";
import { formatInvoiceNumber } from "../../shared/numbering";
import { generateAndStoreInvoicePdf } from "../pdf/generate";
import { api } from "./api";
import {
  newAttempt,
  nextNumberQuery,
  releaseNumber,
  requestSendChallenge,
  reserveNumber,
  sendInvoice,
  uploadXml,
} from "./invoices-api";
import { numberingSeriesQuery, type ProfileResponse } from "./settings-api";
import { checkFatturaXml } from "./xsd";

/** The ordered steps of a send, in the order the review sheet shows them. */
export const SEND_STEPS = ["validate", "reserve", "build", "upload", "authorize", "send"] as const;
export type SendStep = (typeof SEND_STEPS)[number];

/**
 * The manual AdE channel stops after the files are stored: nothing is transmitted by the app, so
 * there is no send authorization; the owner downloads the files, uploads them on the portal and
 * confirms the hand-over on the invoice page.
 */
export const MANUAL_STEPS: readonly SendStep[] = ["validate", "reserve", "build", "upload"];
export type SendChannel = "pec" | "manual";

export type SendFlowErrorCode =
  /** The XML fails the XSD (provisional or final): a definite refusal, nothing was sent. */
  | "invalid_xml"
  /** The owner dismissed the passkey prompt: the invoice stays unsent. */
  | "cancelled"
  | "build_failed"
  | "missing_data";

export class SendFlowError extends Error {
  constructor(
    readonly code: SendFlowErrorCode,
    readonly detail: {
      step?: SendStep;
      mapped?: MappedXsdErrors;
      /** The reserved number was given back (or kept because it could not be released). */
      released?: boolean;
      numberKept?: boolean;
    } = {},
  ) {
    super(code);
    this.name = "SendFlowError";
  }
}

/** How the owner proves presence for this send: a passkey assertion or a fresh TOTP code. */
export type AuthorizeChoice = { kind: "passkey" } | { kind: "totp"; code: string };

export interface SendFlowHooks {
  onStep?: (step: SendStep) => void;
  /** Asked once the final XML is stored; resolves to how to answer the challenge. */
  chooseAuthorization?: (available: {
    passkey: boolean;
    totp: boolean;
  }) => Promise<AuthorizeChoice>;
}

const toIssuer = (profile: ProfileResponse): FatturaIssuer => ({
  name: profile.name,
  vatNumber: profile.vatNumber,
  taxCode: profile.taxCode,
  address: profile.address ?? "",
  postalCode: profile.postalCode ?? "",
  city: profile.city ?? "",
  province: profile.province,
  country: profile.country,
  email: profile.email,
  phone: profile.phone,
  regimeFiscale: profile.regimeFiscale as FatturaIssuer["regimeFiscale"],
});

export function fatturaInput(
  invoice: InvoiceRecord,
  client: ClientRecord,
  profile: ProfileResponse,
  number: string,
  issueDate: string,
  fileProgressive: number,
): FatturaInput {
  return {
    issuer: toIssuer(profile),
    client,
    invoice,
    number,
    issueDate,
    fileProgressive,
    linked:
      invoice.linked?.number && invoice.linked.issueDate
        ? { number: invoice.linked.number, issueDate: invoice.linked.issueDate }
        : null,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function progressiveOf(fileName: string): number {
  const match = /_([A-Za-z0-9]+)\.xml$/i.exec(fileName)?.[1];
  const value = match ? decodeFileProgressive(match) : null;
  if (value === null) throw new SendFlowError("build_failed");
  return value;
}

async function validateOrThrow(xml: string, step: SendStep) {
  const check = await checkFatturaXml(xml);
  if (!check.valid) throw new SendFlowError("invalid_xml", { step, mapped: check.mapped });
}

/** Gives a just-reserved number back after a definite refusal; keeps it when it cannot be. */
async function releaseAfterFailure(invoiceId: string): Promise<boolean> {
  try {
    await releaseNumber(invoiceId);
    return true;
  } catch {
    return false;
  }
}

/**
 * The number an unnumbered invoice would get now: the one the owner asked for, else the next free
 * one of its series, formatted with the series prefix and suffix.
 */
export async function provisionalNumberFor(
  invoice: InvoiceRecord,
  today = romeDateTime(new Date()).date,
): Promise<string> {
  const [next, { series }] = await Promise.all([
    invoice.requestedNumber
      ? Promise.resolve(invoice.requestedNumber)
      : nextNumberQuery(Number(today.slice(0, 4)), invoice.seriesId)
          .queryFn()
          .then((proposal) => proposal.next),
    numberingSeriesQuery.queryFn(),
  ]);
  return formatInvoiceNumber(
    series.find((s) => s.id === invoice.seriesId) ?? { prefix: null, suffix: null },
    next,
  );
}

/**
 * The browser side of a send (plan step 12), in order: review data -> XSD validation with the
 * provisional next number -> the Worker reserves the number and sets `sending` -> the final XML
 * and the PDF are built and stored -> the final XML is validated again (a failure releases the
 * number when the release rule allows, and is a definite refusal) -> send challenge bound to the
 * hash of the final XML -> passkey (or TOTP) -> the Worker verifies and sends.
 * Cancelling the passkey prompt throws `cancelled` and leaves the invoice unsent.
 */
export async function runSendFlow(
  invoiceId: string,
  hooks: SendFlowHooks,
  channel: SendChannel = "pec",
): Promise<{ messageId: string | null; fileName: string }> {
  const step = (s: SendStep) => hooks.onStep?.(s);

  step("validate");
  const [{ invoice }, { clients }, { profile }] = await Promise.all([
    api<{ invoice: InvoiceRecord }>(`/api/invoices/${invoiceId}`),
    api<{ clients: ClientRecord[] }>("/api/clients"),
    api<{ profile: ProfileResponse | null }>("/api/profile"),
  ]);
  const client = clients.find((c) => c.id === invoice.clientId);
  if (!client || !profile) throw new SendFlowError("missing_data");

  const fresh = invoice.state === "draft" || invoice.state === "planned";
  if (fresh) {
    // Provisional number (the one the owner asked for, else the next free one) and today's date:
    // catches what the XSD would refuse before a number is used.
    const today = romeDateTime(new Date()).date;
    const provisionalNumber = await provisionalNumberFor(invoice, today);
    const provisional = buildFatturaXml(
      fatturaInput(invoice, client, profile, provisionalNumber, today, 0),
    );
    await validateOrThrow(provisional.xml, "validate");
  }

  step("reserve");
  let number = invoice.number;
  let issueDate = invoice.issueDate;
  // The invoice as stored once the number is reserved: its due date is recomputed from the
  // payment terms and the final issue date, so the XML and PDF must use this copy.
  let issued = invoice;
  let fileName: string;
  if (fresh) {
    const { reservation, invoice: reserved } = await reserveNumber(invoiceId);
    issued = reserved;
    number = reservation.numberText;
    issueDate = reservation.issueDate;
    fileName = reservation.transmission.fileName;
  } else {
    // Already numbered: resend after a refusal, an unknown outcome or an SdI rejection.
    const attempt = await newAttempt(invoiceId);
    fileName = attempt.transmission.fileName;
  }
  if (!number || !issueDate) throw new SendFlowError("missing_data");

  step("build");
  const finalXml = buildFatturaXml(
    fatturaInput(issued, client, profile, number, issueDate, progressiveOf(fileName)),
  ).xml;
  try {
    await validateOrThrow(finalXml, "build");
  } catch (error) {
    if (error instanceof SendFlowError && fresh) {
      const released = await releaseAfterFailure(invoiceId);
      throw new SendFlowError(error.code, { ...error.detail, released, numberKept: !released });
    }
    throw error;
  }

  step("upload");
  const bytes = new TextEncoder().encode(finalXml);
  const localHash = await sha256Hex(bytes);
  await generateAndStoreInvoicePdf(invoiceId);
  const { file } = await uploadXml(invoiceId, bytes);
  if (file.sha256 !== localHash) throw new SendFlowError("build_failed", { step: "upload" });

  if (channel === "manual") return { messageId: null, fileName };

  step("authorize");
  if (!hooks.chooseAuthorization) throw new SendFlowError("build_failed", { step: "authorize" });
  const challenge = await requestSendChallenge(invoiceId, localHash);
  const choice = await hooks.chooseAuthorization({
    passkey: challenge.passkeyAvailable,
    totp: challenge.totpAvailable,
  });
  let answer: Record<string, unknown>;
  if (choice.kind === "totp") {
    answer = { challengeId: challenge.challengeId, totp: choice.code };
  } else {
    try {
      const passkey = await startAuthentication({
        optionsJSON: challenge.options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
      });
      answer = { challengeId: challenge.challengeId, passkey };
    } catch {
      throw new SendFlowError("cancelled", { step: "authorize" });
    }
  }

  step("send");
  const result = await sendInvoice(invoiceId, answer);
  return { messageId: result.messageId, fileName: result.fileName };
}
