import { Hono } from "hono";
import { z } from "zod";
import { MAX_QUOTA_THRESHOLD_MB } from "../../shared/mailbox-quota";
import type { SessionVariables } from "../auth/session";
import { type Bindings, requireSecrets } from "../env";
import { checkMailboxQuota, loadMailboxStatus } from "../pec/quota";
import { makeError } from "../problem";
import { validationDetail } from "../validation";

export const mailbox = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

/**
 * SdI messages no transmission claims (an unknown file name, a message from before the app):
 * stored whole, never dropped, listed here so the owner can look at them.
 */
mailbox.get("/unmatched", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, sdi_message_type AS type, original_file_name AS fileName,
            COALESCE(received_at, created_at) AS receivedAt
     FROM pec_messages WHERE kind = 'sdi_message' AND processed_at IS NULL
     ORDER BY COALESCE(received_at, created_at) DESC LIMIT 100`,
  ).all<{ id: string; type: string | null; fileName: string | null; receivedAt: number }>();
  return c.json({ messages: results });
});

/** The mailbox warnings: a refused login (polling and sending stopped) and the last quota. */
mailbox.get("/status", async (c) => c.json(await loadMailboxStatus(c.env.DB)));

/** Checks the quota now (the owner's "Check now"); no notification, the answer is the page. */
mailbox.post("/quota", async (c) => {
  requireSecrets(c.env, "pec");
  const result = await checkMailboxQuota(c.env);
  if (!result?.ok) {
    throw makeError(result?.errorCode === "login_failed" ? "pec_auth_failed" : "pec_unavailable");
  }
  return c.json(await loadMailboxStatus(c.env.DB));
});

/** Sets the free-space threshold below which the warning shows (whole megabytes). */
mailbox.put("/quota-threshold", async (c) => {
  const parsed = z
    .object({ thresholdMb: z.number().int().min(1).max(MAX_QUOTA_THRESHOLD_MB) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  await c.env.DB.prepare(
    `INSERT INTO settings (id, mail_quota_threshold_kb, updated_at) VALUES (1, ?1, ?2)
     ON CONFLICT(id) DO UPDATE SET mail_quota_threshold_kb = ?1, updated_at = ?2`,
  )
    .bind(parsed.data.thresholdMb * 1024, Date.now())
    .run();
  return c.json(await loadMailboxStatus(c.env.DB));
});
