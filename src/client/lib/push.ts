/** Browser side of Web Push: permission, subscription and the service worker registration. */

export type PushSupport = "supported" | "unsupported";

export function pushSupport(): PushSupport {
  return typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
    ? "supported"
    : "unsupported";
}

/** The VAPID public key is base64url; `applicationServerKey` wants the raw bytes. */
export function urlBase64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The registration of the app's service worker; none in `pnpm dev` (production builds only). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() === "unsupported") return null;
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export type SubscribeResult =
  | { ok: true; subscription: PushSubscriptionJSON }
  | { ok: false; reason: "denied" | "no_service_worker" };

/** Asks for permission (from a click) and subscribes this device. */
export async function subscribeThisDevice(publicKey: string): Promise<SubscribeResult> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: "denied" };
  const reg = await registration();
  if (!reg) return { ok: false, reason: "no_service_worker" };
  const subscription =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(publicKey),
    }));
  return { ok: true, subscription: subscription.toJSON() };
}

/** Unsubscribes this device and returns the endpoint to remove on the server, if there was one. */
export async function unsubscribeThisDevice(): Promise<string | null> {
  const subscription = await currentPushSubscription();
  if (!subscription) return null;
  const { endpoint } = subscription;
  await subscription.unsubscribe();
  return endpoint;
}
