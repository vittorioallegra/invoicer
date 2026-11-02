import type { TFunction } from "i18next";

/** Maps a Better Auth client error to a translated, non-leaky message. */
export function authErrorMessage(
  error: { status?: number; message?: string } | null | undefined,
  t: TFunction,
  fallbackKey: string,
): string {
  if (error?.status === 429) return t("auth.rateLimited");
  if (error?.status === 0 || error === undefined) return t("auth.networkError");
  return t(fallbackKey);
}
