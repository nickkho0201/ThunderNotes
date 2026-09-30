/**
 * The single source of truth for "is Thunderbird currently light or dark?".
 *
 * Both consumers must agree, and they must agree *by construction* rather than by
 * keeping two copies of the rules in step:
 *
 *  - the space page, which styles its own Light/Dark UI;
 *  - the background service worker, which picks the Space toolbar icon.
 *
 * Detection is a three-tier fallback, applied at load and on every change:
 *
 *  1. `theme.getCurrent().properties.color_scheme` — the authoritative signal.
 *     Thunderbird's own built-in Light and Dark themes are nothing more than
 *     `{"theme": {"properties": {"color_scheme": "light"|"dark"}}}`.
 *     Read-only access needs no permission; `theme` is only required for
 *     `theme.update()`/`theme.reset()`, which ThunderNotes never calls.
 *  2. Luminance of the theme's actual background colours, for third-party themes
 *     that set colours without declaring a colour scheme.
 *  3. `prefers-color-scheme`, which in a Thunderbird document is derived from the
 *     embedding chrome window.
 *
 * There is no documented API that returns "is Thunderbird dark" unconditionally,
 * which is why this fallback chain exists.
 */

import { getBrowser } from "../api/browser";
import type { ColorArray, ThemeType } from "../api/browser";

export type ThemeMode = "light" | "dark";
export type ThemeSource = "color_scheme" | "luminance" | "media" | "default";

export interface ThemeState {
  mode: ThemeMode;
  source: ThemeSource;
}

/** Background colour keys, most authoritative first. */
const BACKGROUND_KEYS = [
  "toolbar",
  "popup",
  "frame",
  "sidebar",
  "ntp_background",
  "toolbar_field",
  "tab_selected",
] as const;

/**
 * Parse a CSS colour (`#rgb`, `#rrggbb`, `rgb()`, `rgba()`) or an RGBA array
 * into `[r, g, b, a]`, or `null` when unsupported.
 */
export function parseColor(value: unknown): [number, number, number, number] | null {
  if (Array.isArray(value)) {
    if (value.length < 3) return null;
    const [r, g, b, a] = value as ColorArray;
    if ([r, g, b].some((channel) => typeof channel !== "number")) return null;
    return [r, g, b, typeof a === "number" ? a : 1];
  }

  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (text.length === 0) return null;

  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const digits = hex[1]!;
    if (digits.length === 3 || digits.length === 4) {
      const r = parseInt(digits[0]! + digits[0]!, 16);
      const g = parseInt(digits[1]! + digits[1]!, 16);
      const b = parseInt(digits[2]! + digits[2]!, 16);
      const a = digits.length === 4 ? parseInt(digits[3]! + digits[3]!, 16) / 255 : 1;
      return [r, g, b, a];
    }
    if (digits.length === 6 || digits.length === 8) {
      const r = parseInt(digits.slice(0, 2), 16);
      const g = parseInt(digits.slice(2, 4), 16);
      const b = parseInt(digits.slice(4, 6), 16);
      const a = digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1;
      return [r, g, b, a];
    }
    return null;
  }

  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgb) {
    const parts = rgb[1]!.split(/[\s,/]+/).filter((part) => part.length > 0);
    if (parts.length < 3) return null;
    const channels = parts.slice(0, 3).map((part) => {
      if (part.endsWith("%")) return Math.round((parseFloat(part) / 100) * 255);
      return Math.round(parseFloat(part));
    });
    if (channels.some((channel) => !Number.isFinite(channel))) return null;
    const alpha = parts[3] === undefined ? 1 : parseFloat(parts[3]);
    return [channels[0]!, channels[1]!, channels[2]!, Number.isFinite(alpha) ? alpha : 1];
  }

  // Named colours: only the handful a theme might plausibly use.
  const named: Record<string, string> = {
    white: "#ffffff",
    black: "#000000",
    transparent: "#00000000",
  };
  if (text in named) return parseColor(named[text]!);

  return null;
}

/**
 * Perceived brightness (HSP, http://alienryderflex.com/hsp.html) normalised to
 * 0..1. Used instead of a naive RGB average because it weights green, to which
 * the eye is most sensitive.
 */
export function relativeLuminance(rgb: [number, number, number, number]): number {
  const [r, g, b] = rgb;
  return Math.sqrt(0.299 * (r * r) + 0.587 * (g * g) + 0.114 * (b * b)) / 255;
}

/** Derive a mode from a theme's declared colour scheme, or null when undecided. */
export function modeFromColorScheme(theme: ThemeType | null | undefined): ThemeMode | null {
  const scheme = theme?.properties?.color_scheme;
  if (scheme === "dark") return "dark";
  if (scheme === "light") return "light";
  // "auto" / "system" / undefined: not decisive, fall through to the next tier.
  return null;
}

/** Derive a mode from the theme's background colours, or null when undecided. */
export function modeFromColors(theme: ThemeType | null | undefined): ThemeMode | null {
  const colors = theme?.colors;
  if (!colors) return null;

  for (const key of BACKGROUND_KEYS) {
    const parsed = parseColor(colors[key]);
    if (!parsed) continue;
    // Ignore fully transparent backgrounds: they tell us nothing.
    if (parsed[3] === 0) continue;
    return relativeLuminance(parsed) < 0.5 ? "dark" : "light";
  }
  return null;
}

export interface DetectionOptions {
  /**
   * Media query used as the last fallback. Pass `null` to skip this tier (the
   * background service worker has no window, so it cannot evaluate one).
   */
  mediaQuery?: MediaQueryList | null;
}

/**
 * Resolve the effective theme mode.
 *
 * Returns the mode together with the tier that decided it, which makes the
 * outcome diagnosable from a log line.
 */
export async function detectThemeMode(options: DetectionOptions = {}): Promise<ThemeState> {
  const themeApi = getBrowser()?.theme;
  if (themeApi && typeof themeApi.getCurrent === "function") {
    try {
      const theme = await themeApi.getCurrent();
      const fromScheme = modeFromColorScheme(theme);
      if (fromScheme) return { mode: fromScheme, source: "color_scheme" };
      const fromColors = modeFromColors(theme);
      if (fromColors) return { mode: fromColors, source: "luminance" };
    } catch (error) {
      console.warn("[ThunderNotes] theme.getCurrent() failed", error);
    }
  }

  const media = options.mediaQuery;
  if (media) return { mode: media.matches ? "dark" : "light", source: "media" };
  return { mode: "light", source: "default" };
}

/** Convenience: just the mode. */
export async function detectTheme(options: DetectionOptions = {}): Promise<ThemeMode> {
  return (await detectThemeMode(options)).mode;
}
