import { Hono } from "hono";
import type { SessionVariables } from "../auth/session";
import type { Bindings } from "../env";
import { loadMailboxStatus } from "../pec/status";

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

/** The mailbox warnings: a refused login (polling and sending stopped). */
mailbox.get("/status", async (c) => c.json(await loadMailboxStatus(c.env.DB)));
