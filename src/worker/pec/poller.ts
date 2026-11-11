import { DurableObject } from "cloudflare:workers";
import type { Channel, ChannelSendInput, ChannelSendResult } from "../../shared/channel/types";
import { ChannelError, type ChannelErrorCode } from "../../shared/channel/types";
import { type Bindings, requireSecrets } from "../env";
import type { PecServers } from "./config";
import { type PecTestOutcome, pecConnectionTest } from "./connection-test";
import { type PollOutcome, pollMailbox } from "./poll";
import { createPecChannel } from "./smtp";

/**
 * Where every connection to the PEC provider is opened (IMAP poll, connection test, SMTP send).
 * A Worker is not placed by Cloudflare for a cron handler (Smart Placement only covers `fetch`,
 * and then only by latency to a backend), so each connection would leave from a different data
 * centre and the provider flags the logins from ever-changing countries as suspicious. A
 * Durable Object stays where it was first created, so all of them leave from the same Western
 * Europe data centre. The hint is best effort and only the first creation of the object counts.
 *
 * The Worker keeps the authorization: a send is verified (passkey/TOTP, XML hash) before
 * `createPlacedChannel` is reached; the object only opens the sockets. Errors cross the RPC
 * boundary as plain results because a thrown error loses its class and fields.
 */
export const POLLER_NAME = "mailbox";
export const POLLER_LOCATION_HINT = "weur";

export type PlacedSendResult =
  | { ok: true; messageId: string }
  | { ok: false; code: ChannelErrorCode; outcome: "none" | "unknown" };

export class PecPoller extends DurableObject<Bindings> {
  poll(): Promise<PollOutcome> {
    return pollMailbox(this.env);
  }

  connectionTest(): Promise<PecTestOutcome> {
    return pecConnectionTest(this.env);
  }

  async send(servers: PecServers, input: ChannelSendInput): Promise<PlacedSendResult> {
    requireSecrets(this.env, "pec");
    const channel = createPecChannel(servers, {
      username: this.env.PEC_USERNAME as string,
      password: this.env.PEC_PASSWORD as string,
    });
    try {
      const sent = await channel.send(input);
      return { ok: true, messageId: sent.messageId };
    } catch (error) {
      if (error instanceof ChannelError) {
        return { ok: false, code: error.code, outcome: error.outcome };
      }
      throw error;
    }
  }
}

/** The object every PEC connection goes through; `null` without the binding (local dev). */
export function placedStub(env: Bindings) {
  const ns = env.PEC_POLLER;
  if (!ns) return null;
  return ns.get(ns.idFromName(POLLER_NAME), { locationHint: POLLER_LOCATION_HINT });
}

/** Test seam: tests run the work in place (no object) or swap in a fake stub. */
export const pollerDeps = { stub: placedStub };

/** Mailbox poll from the placed object. A failed call is logged and retried by the next tick. */
export async function pollMailboxPlaced(env: Bindings): Promise<PollOutcome> {
  const stub = pollerDeps.stub(env);
  if (!stub) return pollMailbox(env);
  try {
    return await stub.poll();
  } catch (error) {
    console.error("poller_unavailable", error instanceof Error ? error.name : "error");
    return null;
  }
}

/** Connection test from the placed object; if the call itself fails the test reports it. */
export async function pecConnectionTestPlaced(env: Bindings): Promise<PecTestOutcome> {
  requireSecrets(env, "pec");
  const stub = pollerDeps.stub(env);
  if (!stub) return pecConnectionTest(env);
  try {
    return await stub.connectionTest();
  } catch (error) {
    console.error("poller_unavailable", error instanceof Error ? error.name : "error");
    return {
      ok: false,
      error: "connection_failed",
      stages: { imapLogin: "failed", mailbox: "skipped", quota: "skipped", smtpLogin: "skipped" },
      quota: null,
    };
  }
}

/**
 * PEC channel whose SMTP session is opened by the placed object. If the call fails the message
 * may or may not have been handed over, so the outcome is `unknown` (polling resolves it).
 */
export function createPlacedChannel(env: Bindings, servers: PecServers): Channel | null {
  const stub = pollerDeps.stub(env);
  if (!stub) return null;
  return {
    id: "pec",
    async send(input: ChannelSendInput): Promise<ChannelSendResult> {
      let result: PlacedSendResult;
      try {
        result = await stub.send(servers, input);
      } catch (error) {
        console.error("poller_unavailable", error instanceof Error ? error.name : "error");
        throw new ChannelError("unknown_outcome", "unknown");
      }
      if (!result.ok) throw new ChannelError(result.code, result.outcome);
      return { messageId: result.messageId };
    },
  };
}
