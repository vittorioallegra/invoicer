import type { ZodError } from "zod";
import type { OnboardingStatus, PecTestResult } from "../../shared/onboarding";
import type { PaymentMethodRecord } from "../../shared/payment-method";
import type { CourtesyEmailMode } from "../../shared/profile";
import { api } from "./api";

export interface ProfileResponse {
  name: string;
  vatNumber: string;
  taxCode: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  province: string | null;
  country: string;
  regimeFiscale: string;
}

export interface SettingsResponse {
  email: {
    senderName: string | null;
    senderAddress: string | null;
    replyTo: string | null;
    bcc: string | null;
    mode: CourtesyEmailMode;
    defaultSenderName: string | null;
    configured: boolean;
  };
  pec: {
    servers: { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number };
    preset: { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number };
    test: PecTestResult | null;
  };
  adeGuideDone: boolean;
}

export const onboardingQuery = {
  queryKey: ["onboarding"],
  queryFn: () => api<OnboardingStatus>("/api/onboarding"),
};
export const profileQuery = {
  queryKey: ["profile"],
  queryFn: () => api<{ profile: ProfileResponse | null }>("/api/profile"),
};
export const paymentMethodsQuery = {
  queryKey: ["payment-methods"],
  queryFn: () => api<{ paymentMethods: PaymentMethodRecord[] }>("/api/payment-methods"),
};
export const settingsQuery = {
  queryKey: ["settings"],
  queryFn: () => api<SettingsResponse>("/api/settings"),
};

export const putJson = <T>(path: string, body: unknown) =>
  api<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Field error codes (`invalid_iban`, ...) by dotted field path, from a failed zod parse. */
export function fieldErrors(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (!(key in out)) out[key] = fieldCode(issue);
  }
  return out;
}

function fieldCode(issue: ZodError["issues"][number]): string {
  // Our own refinements carry a stable code as the message; built-in checks do not.
  if (/^[a-z_]+$/.test(issue.message)) return issue.message;
  return issue.code === "too_small" ? "required" : "invalid";
}

/** Same shape from the server's `detail` (`field: code; field: code`). */
export function fieldErrorsFromDetail(detail: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (detail ?? "").split("; ")) {
    const [field, code] = part.split(": ");
    if (field && code) out[field] = code.split(" ")[0] ?? code;
  }
  return out;
}

const sendJson = <T>(method: string, path: string, body?: unknown) =>
  api<T>(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });

export const createPaymentMethod = (body: unknown) =>
  sendJson<{ paymentMethod: PaymentMethodRecord }>("POST", "/api/payment-methods", body);
export const updatePaymentMethod = (id: string, body: unknown) =>
  sendJson<{ paymentMethod: PaymentMethodRecord }>("PUT", `/api/payment-methods/${id}`, body);
export const deletePaymentMethod = (id: string) =>
  sendJson<null>("DELETE", `/api/payment-methods/${id}`);
export const setDefaultPaymentMethod = (id: string) =>
  sendJson<{ paymentMethods: PaymentMethodRecord[] }>(
    "POST",
    `/api/payment-methods/${id}/default`,
    {},
  );
