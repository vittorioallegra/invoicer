import { notificationPath } from "../../shared/notifications";
import { type Bindings, featureStatus } from "../env";
import { type PushPayload, type PushTarget, sendPush } from "./send";
import { loadPushPreferences } from "./settings";
import { type PushLanguage, pushText } from "./text";

/** Notifications pushed per run: each push is an ECDH + AES-GCM + ECDSA round (10 ms CPU budget). */
export const PUSH_BATCH_SIZE = 3;
/** Devices that get a push (the subscribe route keeps at most this many). */
export const MAX_DEVICES = 5;
/** A notification older than this is no longer pushed: a late alert is noise, not news. */
export const PUSH_MAX_AGE_MS = 60 * 60 * 1000;

interface Row {
  id: string;
  type: string;
  body: string | null;
  invoiceId: string | null;
}

export async function loadSubscriptions(db: D1Database): Promise<(PushTarget & { id: string })[]> {
  const { results } = await db
    .prepare(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(MAX_DEVICES)
    .all<PushTarget & { id: string }>();
  return results;
}

export function pushPayload(language: PushLanguage, row: Row): PushPayload {
  return {
    ...pushText(language, row.type, row.body),
    url: notificationPath(row.type, row.invoiceId),
    tag: row.id,
  };
}

/**
 * Derives the web pushes from the delivered `notification` rows (Open question "Step 18"): every
 * row created in the last hour whose `push_sent_at` is still empty is pushed to every subscribed
 * device, in the owner's language, unless its type is switched off. The row is settled when at
 * least one device took it, when no device is left (expired ones are deleted on 404/410), or
 * when its type is off; if every push service was unreachable it stays open and the next tick
 * retries (at-least-once: the tag makes a device replace a repeated notification, not stack it).
 * Does nothing while the VAPID keys are not configured. Returns how many rows were settled.
 */
export async function processPushNotifications(env: Bindings, now = Date.now()): Promise<number> {
  if (!featureStatus(env).push) return 0;
  const { results } = await env.DB.prepare(
    `SELECT id, type, body, invoice_id AS invoiceId FROM notifications
     WHERE push_sent_at IS NULL AND created_at >= ?1 ORDER BY created_at LIMIT ?2`,
  )
    .bind(now - PUSH_MAX_AGE_MS, PUSH_BATCH_SIZE)
    .all<Row>();
  if (results.length === 0) return 0;
  const { language, disabledTypes } = await loadPushPreferences(env.DB);
  let devices = await loadSubscriptions(env.DB);
  let settled = 0;
  for (const row of results) {
    let done = disabledTypes.has(row.type) || devices.length === 0;
    if (!done) {
      const payload = pushPayload(language, row);
      const expired: string[] = [];
      let sentToOne = false;
      let failed = 0;
      for (const device of devices) {
        try {
          const outcome = await sendPush(env, device, payload);
          if (outcome === "sent") sentToOne = true;
          else if (outcome === "expired") expired.push(device.id);
          else failed += 1;
        } catch {
          failed += 1;
        }
      }
      if (expired.length > 0) {
        await env.DB.batch(
          expired.map((id) =>
            env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(id),
          ),
        );
        devices = devices.filter((device) => !expired.includes(device.id));
      }
      done = sentToOne || failed === 0;
    }
    if (done) {
      await env.DB.prepare(
        "UPDATE notifications SET push_sent_at = ?2 WHERE id = ?1 AND push_sent_at IS NULL",
      )
        .bind(row.id, now)
        .run();
      settled += 1;
    }
  }
  return settled;
}
