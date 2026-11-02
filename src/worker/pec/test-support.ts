import { env } from "cloudflare:test";
import type { Bindings } from "../env";
import { type FakeMailbox, type FakeMessage, fakeMailbox } from "./fake-mailbox";
import type { FakeSocket } from "./fake-socket";
import { pollDeps } from "./poll";

/** Worker bindings with PEC credentials set, for the polling tests. Test support only. */
export const PEC_USERNAME = "owner@pec.example";
export const PEC_PASSWORD = "s3cret-pw";
export const pollEnv = { ...env, PEC_USERNAME, PEC_PASSWORD } as unknown as Bindings;

export interface Server {
  mailbox: FakeMailbox;
  /** Every socket opened so far (one per poll). */
  sockets: FakeSocket[];
  add(...messages: FakeMessage[]): void;
}

/** Points the poller at a fake mailbox; returns it so a test can add mail between runs. */
export function useMailbox(messages: FakeMessage[] = [], uidValidity = 1000): Server {
  const mailbox: FakeMailbox = { uidValidity, messages: [...messages] };
  const server: Server = {
    mailbox,
    sockets: [],
    add: (...more) => void mailbox.messages.push(...more),
  };
  pollDeps.open = () => {
    const socket = fakeMailbox(mailbox);
    server.sockets.push(socket);
    return socket;
  };
  return server;
}

const TABLES = [
  "outbox",
  "notifications",
  "events",
  "received_invoices",
  "pec_messages",
  "files",
  "transmissions",
  "invoice_lines",
  "invoices",
  "job_runs",
  "settings",
] as const;

/** Empties the tables the polling touches (foreign-key order). */
export async function resetPolling(db: D1Database): Promise<void> {
  for (const table of TABLES) await db.prepare(`DELETE FROM ${table}`).run();
}

export interface SeedAttempt {
  fileName: string;
  messageId?: string;
  outcome?: "none" | "complete" | "unknown";
}

let sequence = 0;

/** An issued invoice with its transmission attempts, straight into D1 (bypasses the send flow). */
export async function seedInvoice(
  db: D1Database,
  o: { state?: string; rank?: number; attempts: SeedAttempt[] },
): Promise<{ id: string; transmissionIds: string[] }> {
  const id = crypto.randomUUID();
  const n = ++sequence;
  await db
    .prepare(
      `INSERT INTO invoices (id, document_type, state, state_rank, year, number_int, number_raw, created_at)
       VALUES (?, 'TD01', ?, ?, 2026, ?, ?, 1)`,
    )
    .bind(id, o.state ?? "sending", o.rank ?? 2, n, String(n))
    .run();
  const transmissionIds: string[] = [];
  let attempt = 0;
  for (const a of o.attempts) {
    attempt += 1;
    const tid = crypto.randomUUID();
    transmissionIds.push(tid);
    await db
      .prepare(
        `INSERT INTO transmissions (id, invoice_id, attempt, file_progressive, file_name, channel,
           send_outcome, channel_message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pec', ?, ?, 1, 1)`,
      )
      .bind(
        tid,
        id,
        attempt,
        ++sequence * 1000 + attempt,
        a.fileName,
        a.outcome ?? "complete",
        a.messageId ?? null,
      )
      .run();
  }
  return { id, transmissionIds };
}
