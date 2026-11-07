import { Hono } from "hono";
import { z } from "zod";
import { notificationPath } from "../../shared/notifications";
import type { SessionVariables } from "../auth/session";
import type { Bindings } from "../env";
import { makeError } from "../problem";
import { validationDetail } from "../validation";

export const notifications = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

const LIST_LIMIT = 100;

interface Row {
  id: string;
  type: string;
  body: string | null;
  invoiceId: string | null;
  readAt: number | null;
  createdAt: number;
}

function params(body: string | null): Record<string, string | number> {
  try {
    const parsed: unknown = JSON.parse(body ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string | number>) : {};
  } catch {
    return {};
  }
}

/** The latest notifications (newest first) with the interpolation values the client renders. */
notifications.get("/", async (c) => {
  const [{ results }, unread] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, type, body, invoice_id AS invoiceId, read_at AS readAt, created_at AS createdAt
       FROM notifications WHERE dismissed_at IS NULL ORDER BY created_at DESC, id LIMIT ?`,
    )
      .bind(LIST_LIMIT)
      .all<Row>(),
    c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL AND dismissed_at IS NULL",
    ).first<{
      n: number;
    }>(),
  ]);
  return c.json({
    unread: unread?.n ?? 0,
    notifications: results.map((row) => ({
      id: row.id,
      type: row.type,
      params: params(row.body),
      invoiceId: row.invoiceId,
      path: notificationPath(row.type, row.invoiceId),
      readAt: row.readAt,
      createdAt: row.createdAt,
    })),
  });
});

/** Marks the given notifications read, or every unread one when `ids` is left out. */
notifications.post("/read", async (c) => {
  const parsed = z
    .object({ ids: z.array(z.string().min(1)).max(LIST_LIMIT).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  const now = Date.now();
  const { ids } = parsed.data;
  if (ids === undefined) {
    await c.env.DB.prepare("UPDATE notifications SET read_at = ? WHERE read_at IS NULL")
      .bind(now)
      .run();
  } else if (ids.length > 0) {
    await c.env.DB.batch(
      ids.map((id) =>
        c.env.DB.prepare(
          "UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL",
        ).bind(now, id),
      ),
    );
  }
  return c.json({ ok: true });
});

/**
 * Deletes one notification from the list. It is hidden, not removed (see `dismissedAt`), and counts
 * as read so a repeated mailbox problem raises a new notification.
 */
notifications.delete("/:id", async (c) => {
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE notifications SET dismissed_at = ?1, read_at = COALESCE(read_at, ?1)
     WHERE id = ?2 AND dismissed_at IS NULL`,
  )
    .bind(now, c.req.param("id"))
    .run();
  return c.json({ ok: true });
});

/** Deletes every notification from the list. */
notifications.delete("/", async (c) => {
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE notifications SET dismissed_at = ?1, read_at = COALESCE(read_at, ?1)
     WHERE dismissed_at IS NULL`,
  )
    .bind(now)
    .run();
  return c.json({ ok: true });
});
