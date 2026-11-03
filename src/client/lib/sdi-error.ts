import type { TFunction } from "i18next";

/** One SdI error as a line; an error without a code (manual channel) has no code slot. */
export function sdiErrorLine(t: TFunction, error: { code: string; description: string }): string {
  const code = error.code.trim();
  return code
    ? t("invoice.rejected.error", { code, text: error.description })
    : t("invoice.rejected.errorNoCode", { text: error.description });
}
