import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "../env";
import { type PollOutcome, pollMailbox } from "./poll";

/**
 * Where the mailbox poll runs. A cron handler is not placed by Cloudflare (Smart Placement only
 * covers `fetch`), so every tick would open the IMAP connection from a different data centre and
 * the provider flags the logins from ever-changing countries as suspicious. A Durable Object
 * stays where it was first created, so the poll always leaves from the same Western Europe
 * data centre. The hint is best effort and only the first creation of the object respects it.
 */
export const POLLER_NAME = "mailbox";
export const POLLER_LOCATION_HINT = "weur";

export class PecPoller extends DurableObject<Bindings> {
  poll(): Promise<PollOutcome> {
    return pollMailbox(this.env);
  }
}

/** Test seam: replaced to observe or fail the Durable Object call. */
export const pollerDeps = {
  stub(env: Bindings) {
    const ns = env.PEC_POLLER;
    if (!ns) return null;
    return ns.get(ns.idFromName(POLLER_NAME), { locationHint: POLLER_LOCATION_HINT });
  },
};

/**
 * Polls the mailbox from the Durable Object. Without the binding (local dev) or when the call
 * itself fails (not a poll failure: those come back as a result), it polls in place, so the
 * mailbox never goes unpolled because of this indirection.
 */
export async function pollMailboxPlaced(env: Bindings): Promise<PollOutcome> {
  const stub = pollerDeps.stub(env);
  if (!stub) return pollMailbox(env);
  try {
    return await stub.poll();
  } catch (error) {
    console.error("poller_unavailable", error instanceof Error ? error.name : "error");
    return pollMailbox(env);
  }
}
