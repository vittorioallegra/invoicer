import { notifications as enNotifications } from "../../../locales/en/common.json";
import { notifications as itNotifications } from "../../../locales/it/common.json";
import { fillTemplate } from "../../shared/notifications";

export type PushLanguage = "en" | "it";

const TEXTS: Record<PushLanguage, Record<string, { title: string; body: string }>> = {
  en: enNotifications,
  it: itNotifications,
};

export interface PushText {
  title: string;
  body: string;
}

/**
 * Title and body of a notification in `language`, from the same `notifications.<type>` keys the
 * in-app list renders (the Worker has no i18n library: `{{name}}` is filled here). `body` is the
 * JSON interpolation values stored on the notification row.
 */
export function pushText(language: PushLanguage, type: string, body: string | null): PushText {
  const entry = TEXTS[language][type] ?? TEXTS.en[type];
  let values: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(body ?? "{}");
    if (parsed && typeof parsed === "object") values = parsed as Record<string, unknown>;
  } catch {
    // Unreadable values: the placeholders are left empty.
  }
  if (!entry) return { title: "Invoicer", body: "" };
  return { title: entry.title, body: fillTemplate(entry.body, values) };
}
