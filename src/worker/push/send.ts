import { buildPushHTTPRequest } from "@pushforge/builder";
import { type Bindings, requireSecrets } from "../env";

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** What the service worker receives (`public/push-sw.js`). */
export type PushPayload = {
  title: string;
  body: string;
  /** Page the click opens. */
  url: string;
  /** Same tag replaces the notification instead of stacking a second one. */
  tag: string;
};

/** Test seam: the HTTP call to the push service (no automated test talks to a real one). */
export const pushDeps = {
  fetch: (url: string, init: RequestInit): Promise<Response> => fetch(url, init),
};

export type PushOutcome = "sent" | "expired" | "failed";

/**
 * Encrypts the payload (RFC 8291) and signs it with the VAPID key (WebCrypto), then posts it to
 * the device's push service. 404/410 means the subscription is gone (`expired`); any other
 * refusal or an unreachable service is `failed` and worth a retry. A missing VAPID secret
 * throws the `missing_secret` ApiError naming it.
 */
export async function sendPush(
  env: Bindings,
  target: PushTarget,
  payload: PushPayload,
): Promise<PushOutcome> {
  requireSecrets(env, "push");
  const { endpoint, headers, body } = await buildPushHTTPRequest({
    privateJWK: env.VAPID_PRIVATE_KEY as string,
    subscription: { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
    message: {
      payload,
      adminContact: env.VAPID_SUBJECT as string,
      options: { ttl: 3600, urgency: "high" },
    },
  });
  let response: Response;
  try {
    response = await pushDeps.fetch(endpoint, { method: "POST", headers, body });
  } catch {
    return "failed";
  }
  if (response.ok) return "sent";
  return response.status === 404 || response.status === 410 ? "expired" : "failed";
}
