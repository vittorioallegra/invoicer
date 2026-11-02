import i18next, { type i18n } from "i18next";
import { initReactI18next } from "react-i18next";
import enCommon from "../../../locales/en/common.json";
import itCommon from "../../../locales/it/common.json";
import { resolveLocale, type UiLocale } from "../../shared/format";

export const resources = {
  en: { common: enCommon },
  it: { common: itCommon },
} as const;

const STORAGE_KEY = "invoicer.lng";

/** Creates an isolated i18next instance (English is the base and fallback language). */
export async function createI18n(lng: UiLocale = "en"): Promise<i18n> {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    resources,
    lng,
    fallbackLng: "en",
    defaultNS: "common",
    ns: ["common"],
    interpolation: { escapeValue: false },
  });
  return instance;
}

export function detectLocale(): UiLocale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "it") return stored;
  } catch {
    // Storage can be unavailable (private mode); fall through to the browser language.
  }
  return resolveLocale(navigator.languages ?? [navigator.language]);
}

export function persistLocale(lng: UiLocale): void {
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    // Ignore: the choice just won't persist.
  }
}
