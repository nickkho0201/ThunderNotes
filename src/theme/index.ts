/**
 * Light/dark theme handling for the space page.
 *
 * The detection rules themselves live in `./detect.ts`. This module is the
 * page-side wrapper: it applies the result to the document and notifies listeners
 * when the mode changes, including the DOM-only media-query fallback that the
 * background service worker cannot evaluate.
 *
 * Changes arrive from three independent sources: `theme.onUpdated`, the
 * `prefers-color-scheme` media query (covers "System theme — auto" following the
 * OS), and page visibility (cheap re-check when the user returns).
 */

import { getBrowser } from "../api/browser";
import { detectThemeMode } from "./detect";
import type { ThemeMode, ThemeSource, ThemeState } from "./detect";

export type { ThemeMode, ThemeSource, ThemeState };
export {
  detectTheme,
  detectThemeMode,
  modeFromColorScheme,
  modeFromColors,
  parseColor,
  relativeLuminance,
} from "./detect";

const THEME_ATTRIBUTE = "data-tn-theme";

export interface ThemeOptions {
  /** Element that receives `data-tn-theme`. Defaults to `<html>`. */
  target?: HTMLElement;
  /** Media query used as the last fallback. Injectable for tests. */
  mediaQuery?: MediaQueryList | null;
  /** Called after every mode change. */
  onChange?: (state: ThemeState) => void;
}

export interface ThemeController {
  /** Current state, valid after `start()` resolves. */
  readonly state: ThemeState;
  /** Re-run detection (e.g. after returning to the page). */
  refresh(): Promise<ThemeState>;
  /**
   * Register a listener fired whenever the resolved mode changes.
   *
   * Used by the space page to keep the Space icon in step with the theme. Must be
   * registered after `startTheme()` resolves.
   */
  onModeChange(listener: (state: ThemeState) => void): () => void;
  /** Detach every listener. */
  dispose(): void;
}

function resolveTarget(options: ThemeOptions): HTMLElement | null {
  if (options.target) return options.target;
  if (typeof document === "undefined") return null;
  return document.documentElement;
}

/**
 * Start theme tracking. Safe to call in Node: it no-ops when there is no DOM.
 */
export async function startTheme(options: ThemeOptions = {}): Promise<ThemeController> {
  const target = resolveTarget(options);
  const media =
    options.mediaQuery !== undefined
      ? options.mediaQuery
      : typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;

  let state: ThemeState = { mode: "light", source: "default" };
  let disposed = false;
  const modeListeners = new Set<(state: ThemeState) => void>();

  const apply = (next: ThemeState): void => {
    // Only a *mode* change is meaningful to consumers; the source can flip
    // between tiers without the effective theme changing.
    const modeChanged = next.mode !== state.mode;
    state = next;
    if (target) {
      target.setAttribute(THEME_ATTRIBUTE, next.mode);
      // Keep native widgets (scrollbars, form controls) in the same scheme.
      target.style.colorScheme = next.mode;
    }
    if (modeChanged) {
      options.onChange?.(next);
      for (const listener of modeListeners) {
        try {
          listener(next);
        } catch (error) {
          console.error("[ThunderNotes] theme listener failed", error);
        }
      }
    }
  };

  const refresh = async (): Promise<ThemeState> => {
    if (disposed) return state;
    const next = await detectThemeMode({ mediaQuery: media });
    apply(next);
    return next;
  };

  const onThemeUpdated = (): void => {
    void refresh();
  };
  const onMediaChange = (): void => {
    void refresh();
  };
  const onVisibility = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      void refresh();
    }
  };

  const themeApi = getBrowser()?.theme;
  themeApi?.onUpdated.addListener(onThemeUpdated);
  media?.addEventListener("change", onMediaChange);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }

  await refresh();

  return {
    get state() {
      return state;
    },
    refresh,
    onModeChange(listener) {
      if (disposed) return () => {};
      modeListeners.add(listener);
      return () => modeListeners.delete(listener);
    },
    dispose() {
      disposed = true;
      modeListeners.clear();
      themeApi?.onUpdated.removeListener(onThemeUpdated);
      media?.removeEventListener("change", onMediaChange);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    },
  };
}
