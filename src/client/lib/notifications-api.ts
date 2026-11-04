import type { NotificationType } from "../../shared/notifications";
import { api } from "./api";
import { putJson } from "./settings-api";

export interface NotificationItem {
  id: string;
  type: string;
  /** The `{{values}}` of `notifications.<type>.body`. */
  params: Record<string, string | number>;
  invoiceId: string | null;
  readAt: number | null;
  createdAt: number;
}

export interface NotificationsResponse {
  unread: number;
  notifications: NotificationItem[];
}

export interface PushState {
  configured: boolean;
  publicKey: string | null;
  disabledTypes: NotificationType[];
  devices: number;
}

export const notificationsQuery = {
  queryKey: ["notifications"],
  queryFn: () => api<NotificationsResponse>("/api/notifications"),
  // The bell shows the unread count while the app is open.
  refetchInterval: 60_000,
};

export const pushStateQuery = {
  queryKey: ["push"],
  queryFn: () => api<PushState>("/api/push"),
};

const post = (path: string, method: string, body: unknown) =>
  api<unknown>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Marks the given notifications read, or every unread one when `ids` is left out. */
export const markNotificationsRead = (ids?: string[]) =>
  post("/api/notifications/read", "POST", ids ? { ids } : {});

export const savePushTypes = (disabled: string[]) =>
  putJson<{ disabledTypes: string[] }>("/api/push/types", { disabled });

export const registerPushDevice = (subscription: PushSubscriptionJSON) =>
  post("/api/push/subscriptions", "POST", subscription);

export const removePushDevice = (endpoint: string) =>
  post("/api/push/subscriptions", "DELETE", { endpoint });

/** Tells the Worker the UI language, so push text is written in it. */
export const saveLanguage = (language: "en" | "it") =>
  putJson("/api/settings/language", { language }).catch(() => undefined);
