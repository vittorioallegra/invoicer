import type { PushSubscription } from "@pushforge/builder";
import { buildPushHTTPRequest } from "@pushforge/builder";
import { Hono } from "hono";
import { type Bindings, featureStatus } from "../env";
import { makeError } from "../problem";
import { readJson, writeJson } from "./util";

export interface StoredSubscription extends PushSubscription {
  label: string;
  addedAt: string;
}

const KEY = "push-subscriptions";
const LAST_KEY = "push-last";

export type PushPayload = {
  title: string;
  body: string;
  url: string;
  tag?: string;
};

/** Builds the encrypted Web Push request (RFC 8291 + VAPID); does not send it. */
export async function buildSpikePush(
  env: Pick<Bindings, "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT">,
  subscription: PushSubscription,
  payload: PushPayload,
) {
  if (!env.VAPID_PRIVATE_KEY) throw makeError("missing_secret", "VAPID_PRIVATE_KEY is not set.");
  return buildPushHTTPRequest({
    privateJWK: env.VAPID_PRIVATE_KEY,
    subscription,
    message: {
      payload,
      adminContact: env.VAPID_SUBJECT || "mailto:spike@example.invalid",
      options: { ttl: 3600, urgency: "high" },
    },
  });
}

export async function sendSpikePush(
  env: Bindings,
  subscription: PushSubscription,
  payload: PushPayload,
  doFetch: typeof fetch = fetch,
): Promise<number> {
  const { endpoint, headers, body } = await buildSpikePush(env, subscription, payload);
  const response = await doFetch(endpoint, { method: "POST", headers, body });
  return response.status;
}

interface SendResult {
  label: string;
  host: string;
  status: number | string;
}

async function sendToAll(env: Bindings, payload: PushPayload): Promise<SendResult[]> {
  const subs = await readJson<StoredSubscription[]>(env, KEY, []);
  const results: SendResult[] = [];
  const alive: StoredSubscription[] = [];
  for (const sub of subs) {
    let status: number | string;
    try {
      status = await sendSpikePush(env, sub, payload);
    } catch (error) {
      status = error instanceof Error ? error.message : "error";
    }
    // 404/410: the push service dropped the subscription.
    if (status !== 404 && status !== 410) alive.push(sub);
    results.push({ label: sub.label, host: new URL(sub.endpoint).host, status });
  }
  if (alive.length !== subs.length) await writeJson(env, KEY, alive);
  await writeJson(env, LAST_KEY, { at: new Date().toISOString(), results });
  return results;
}

export const push = new Hono<{ Bindings: Bindings }>();

push.get("/config", (c) =>
  c.json({
    configured: featureStatus(c.env).push,
    publicKey: c.env.VAPID_PUBLIC_KEY ?? null,
  }),
);

push.get("/subscriptions", async (c) => {
  const subs = await readJson<StoredSubscription[]>(c.env, KEY, []);
  const last = await readJson<unknown>(c.env, LAST_KEY, null);
  return c.json({
    subscriptions: subs.map((s) => ({
      label: s.label,
      host: new URL(s.endpoint).host,
      addedAt: s.addedAt,
    })),
    last,
  });
});

push.delete("/subscriptions", async (c) => {
  await writeJson(c.env, KEY, []);
  return c.json({ ok: true });
});

push.post("/subscribe", async (c) => {
  const body = (await c.req.json()) as { subscription?: PushSubscription; label?: string };
  const sub = body.subscription;
  if (!sub?.endpoint?.startsWith("https://") || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw makeError("bad_request", "A PushSubscription JSON is required.");
  }
  const subs = await readJson<StoredSubscription[]>(c.env, KEY, []);
  const entry: StoredSubscription = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    label: (body.label ?? "device").slice(0, 40),
    addedAt: new Date().toISOString(),
  };
  await writeJson(
    c.env,
    KEY,
    [...subs.filter((s) => s.endpoint !== entry.endpoint), entry].slice(-10),
  );
  return c.json({ ok: true });
});

/** Sends now, or after `delaySeconds` (max 25, kept alive with waitUntil) so the app can be closed. */
push.post("/send", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { delaySeconds?: number };
  const delay = Math.min(Math.max(Number(body.delaySeconds) || 0, 0), 25);
  const payload: PushPayload = {
    title: "Invoicer spike",
    body: `Test push sent ${new Date().toISOString().slice(11, 19)} UTC`,
    url: "/spike",
    tag: "spike",
  };
  if (!c.env.VAPID_PRIVATE_KEY) throw makeError("missing_secret", "VAPID_PRIVATE_KEY is not set.");
  if (delay === 0) return c.json({ sent: true, results: await sendToAll(c.env, payload) });
  c.executionCtx.waitUntil(
    new Promise<void>((resolve) => setTimeout(resolve, delay * 1000)).then(() =>
      sendToAll(c.env, payload).then(() => undefined),
    ),
  );
  return c.json({
    sent: false,
    scheduledInSeconds: delay,
    note: "Close the app now; read the result later.",
  });
});
