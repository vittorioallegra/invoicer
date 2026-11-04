import { NOTIFICATION_TYPES } from "../../shared/notifications";
import type { PushLanguage } from "./text";

export interface PushPreferences {
  language: PushLanguage;
  disabledTypes: Set<string>;
}

/** The owner's language (default English, the base language) and the types push is off for. */
export async function loadPushPreferences(db: D1Database): Promise<PushPreferences> {
  const row = await db
    .prepare(
      "SELECT ui_language AS language, push_disabled_types AS disabled FROM settings WHERE id = 1",
    )
    .first<{ language: string | null; disabled: string | null }>();
  let disabled: unknown = [];
  try {
    disabled = JSON.parse(row?.disabled ?? "[]");
  } catch {
    // Unreadable value: nothing is switched off.
  }
  const known: readonly string[] = NOTIFICATION_TYPES;
  return {
    language: row?.language === "it" ? "it" : "en",
    disabledTypes: new Set(
      Array.isArray(disabled)
        ? disabled.filter((t): t is string => typeof t === "string" && known.includes(t))
        : [],
    ),
  };
}
