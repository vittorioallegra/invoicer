import type { PecTestResult } from "../../shared/onboarding";
import type { Bindings } from "../env";
import { requireSecrets } from "../env";
import { pecServers } from "./config";
import { ImapError, type ImapSocket, openMailbox } from "./imap";
import { connectImap } from "./socket";

export type OpenSocket = (host: string, port: number) => ImapSocket;

/**
 * PEC connection test (setup checklist): connect, LOGIN, EXAMINE INBOX, LOGOUT. Read-only, no
 * message is fetched and no SMTP connection is opened (the SMTP side is tested with the send
 * flow in step 12). Failures become a stable code; nothing from the server or the credentials is
 * kept. Throws `missing_secret` when the PEC variables are not set (nothing to test).
 */
export async function pecConnectionTest(
  env: Bindings,
  open: OpenSocket = connectImap,
): Promise<Omit<PecTestResult, "at">> {
  requireSecrets(env, "pec");
  const { imapHost, imapPort } = pecServers(env);
  let stage: "connect" | "mailbox" = "connect";
  try {
    const client = await openMailbox(open(imapHost, imapPort), {
      username: env.PEC_USERNAME as string,
      password: env.PEC_PASSWORD as string,
    });
    stage = "mailbox";
    try {
      await client.select("INBOX");
    } catch (error) {
      await client.close();
      throw error;
    }
    await client.logout();
    return { ok: true, error: null };
  } catch (error) {
    if (error instanceof ImapError && error.code === "login_failed") {
      return { ok: false, error: "login_failed" };
    }
    return { ok: false, error: stage === "mailbox" ? "mailbox_failed" : "connection_failed" };
  }
}
