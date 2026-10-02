/**
 * Localization layer.
 *
 * UI code calls `t("key", [args])` — never `browser.i18n.getMessage` directly —
 * so the mechanism can be swapped later without touching components.
 *
 * Resolution order:
 *   1. `browser.i18n.getMessage(key, [orderedArgs])` — the native path, which owns
 *      locale resolution (against Thunderbird's **UI locale**, with
 *      `default_locale` as the platform's own fallback) and placeholder
 *      substitution. This is the only path used in a running Thunderbird.
 *   2. The bundled English catalogue (generated at build time), used only when the
 *      i18n API is missing or returns an empty string, so a key is never rendered
 *      as an empty string or as a raw technical key.
 *   3. The key itself, only as a last-resort diagnostic.
 *
 * Catalogue rules that this layer depends on (and that `scripts/generate-locales.mjs`
 * enforces):
 *   - Messages use **plain positional substitutions** (`$1`, `$2`, …) with an
 *     ordered argument array.
 *   - A message must NOT declare a named `placeholders` block whose `content` is
 *     `$1`/`$2`. Thunderbird pre-expands `$NAME$` from that block *before*
 *     substituting arguments, and an undeclared `$NAME$` is replaced with an empty
 *     string — which is how a counter ends up as "из заметок" with the numbers
 *     silently dropped.
 */

import { EN_MESSAGES } from "./fallback-messages";
import { getBrowser } from "../api/browser";

export type Substitutions = string | string[];

function toList(substitutions?: Substitutions): string[] {
  if (substitutions === undefined) return [];
  return Array.isArray(substitutions) ? substitutions : [substitutions];
}

/**
 * Expand `$1`/`$2`… positional placeholders in an English fallback template.
 *
 * This exists ONLY for the bundled English fallback used when `browser.i18n` is
 * unavailable. The normal path is Thunderbird's own `getMessage(key, [...])`,
 * which performs exactly this substitution natively.
 *
 * ThunderNotes catalogues deliberately use `$1`, `$2`, … directly. The native
 * i18n API documents ordered substitutions for those tokens, so the fallback
 * needs no named-placeholder preprocessing or platform-internal behavior.
 *
 * The single alternation (`\$(\d+)`) matters: a substituted value is inserted
 * once and never re-examined, so an argument that itself contains a
 * placeholder-looking token (an error path like `C:\dir\my$1.txt`) is safe.
 */
function expand(template: string, substitutions?: Substitutions): string {
  const list = toList(substitutions);
  if (list.length === 0) return template;

  return template.replace(/\$(\d+)/g, (match, position: string) => {
    const value = list[Number(position) - 1];
    return value === undefined ? match : value;
  });
}

/**
 * Translate a message key.
 *
 * The normal path is a single call to Thunderbird's native
 * `browser.i18n.getMessage(key, substitutions)` with an ordered array; the
 * platform owns locale resolution (including its `default_locale` fallback) and
 * placeholder substitution. The bundled English catalogue is used only when the
 * API is missing or returns an empty string, so a key is never rendered as an
 * empty string or as a raw technical key.
 *
 * Deliberately NOT done here: repairing a message that still contains an
 * unresolved placeholder. The platform is the authority on substitutions, and a
 * second guessing layer on top of it is what previously turned a working
 * message into "из заметок" with the numbers missing.
 */
export function t(key: string, substitutions?: Substitutions): string {
  const api = getBrowser()?.i18n;

  if (api && typeof api.getMessage === "function") {
    try {
      const message = api.getMessage(key, substitutions);
      if (typeof message === "string" && message.length > 0) return message;
    } catch (error) {
      console.warn(`[ThunderNotes] i18n lookup failed for "${key}"`, error);
    }
  }

  const entry = EN_MESSAGES[key];
  if (entry) return expand(entry.message, substitutions);

  console.warn(`[ThunderNotes] missing localization key: ${key}`);
  return key;
}

/** True when a translation exists in the bundled English catalogue. */
export function hasMessage(key: string): boolean {
  return key in EN_MESSAGES;
}

/**
 * The locale used for `Intl` formatting.
 *
 * Thunderbird's UI locale is the single source of truth: not the OS locale, not
 * `navigator.language`, not the language of the user's mail.
 */
export function uiLocale(): string {
  const api = getBrowser()?.i18n;
  if (api && typeof api.getUILanguage === "function") {
    try {
      const language = api.getUILanguage();
      if (typeof language === "string" && language.length > 0) return language;
    } catch {
      // fall through to the Intl default
    }
  }
  // Node (unit tests) only: there is no Thunderbird locale here.
  const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
  return resolved.length > 0 ? resolved : "en-US";
}

export type DateStyleName = "short" | "medium" | "long";

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(locale: string, style: DateStyleName): Intl.DateTimeFormat {
  const cacheKey = `${locale}|${style}`;
  const cached = dateFormatters.get(cacheKey);
  if (cached) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat(locale, { dateStyle: style, timeStyle: "short" });
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", { dateStyle: style, timeStyle: "short" });
  }
  dateFormatters.set(cacheKey, formatter);
  return formatter;
}

/**
 * Format a timestamp according to Thunderbird's UI locale and the user's own
 * regional preferences. Deliberately never hardcodes `DD.MM.YYYY` or
 * `MM/DD/YYYY`.
 */
export function formatDateTime(timestamp: number, style: DateStyleName = "short"): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return formatterFor(uiLocale(), style).format(date);
}
