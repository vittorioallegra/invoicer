import type { PecTestResult, PecTestStages, StageResult } from "../../shared/onboarding";
import type { Bindings } from "../env";
import { requireSecrets } from "../env";
import { loadPecServers } from "./config";
import { ImapError, type ImapSocket, openMailbox } from "./imap";
import { smtpLogin } from "./smtp";
import { connectImap } from "./socket";

export type OpenSocket = (host: string, port: number) => ImapSocket;

export type PecTestOutcome = Omit<PecTestResult, "at">;

/**
 * PEC connection test: IMAP connect + LOGIN, EXAMINE INBOX, quota (GETQUOTAROOT, optional), then
 * SMTP connect + AUTH without sending anything. Read-only on the mailbox; no message is fetched.
 * Each stage has its own result so the screen says exactly what failed; the first blocking
 * failure becomes the stable error code. Nothing from the servers or the credentials is kept.
 * Throws `missing_secret` when the PEC variables are not set (nothing to test).
 */
export async function pecConnectionTest(
  env: Bindings,
  open: OpenSocket = connectImap,
): Promise<PecTestOutcome> {
  requireSecrets(env, "pec");
  const servers = await loadPecServers(env);
  const credentials = {
    username: env.PEC_USERNAME as string,
    password: env.PEC_PASSWORD as string,
  };
  const stages: PecTestStages = {
    imapLogin: "skipped",
    mailbox: "skipped",
    quota: "skipped",
    smtpLogin: "skipped",
  };
  let error: string | null = null;
  let quota: PecTestOutcome["quota"] = null;

  try {
    const client = await openMailbox(open(servers.imapHost, servers.imapPort), credentials);
    stages.imapLogin = "ok";
    try {
      await client.select("INBOX");
      stages.mailbox = "ok";
      try {
        const found = await client.getQuota();
        quota = found;
        stages.quota = found ? "ok" : "unsupported";
      } catch {
        stages.quota = "unsupported";
      }
      await client.logout();
    } catch {
      stages.mailbox = stages.mailbox === "ok" ? "ok" : "failed";
      error = stages.mailbox === "failed" ? "mailbox_failed" : error;
      await client.close();
    }
  } catch (caught) {
    if (caught instanceof ImapError && caught.code === "login_failed") {
      stages.imapLogin = "failed";
      error = "login_failed";
    } else {
      stages.imapLogin = "failed";
      error = "connection_failed";
    }
  }

  try {
    await smtpLogin(servers, credentials);
    stages.smtpLogin = "ok";
  } catch (caught) {
    stages.smtpLogin = "failed";
    const code = caught instanceof Error && "code" in caught ? (caught.code as string) : "";
    error ??= code === "auth_failed" ? "smtp_login_failed" : "smtp_connection_failed";
  }

  return { ok: error === null, error, stages, quota };
}

export type { StageResult };
