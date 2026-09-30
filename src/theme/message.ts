import type { ThemeMode, ThemeState } from "./detect";

export const THEME_CHANGED_MESSAGE = "thundernotes:theme-changed";

export interface ThemeChangedMessage {
  type: typeof THEME_CHANGED_MESSAGE;
  mode: ThemeMode;
}

/** Build the page-to-background message without discarding the resolved mode. */
export function createThemeChangedMessage(mode: ThemeMode): ThemeChangedMessage {
  return { type: THEME_CHANGED_MESSAGE, mode };
}

/** Read a validated resolved mode from an untrusted runtime message. */
export function themeModeFromMessage(message: unknown): ThemeMode | null {
  if (message === null || typeof message !== "object") return null;
  const candidate = message as { type?: unknown; mode?: unknown };
  if (candidate.type !== THEME_CHANGED_MESSAGE) return null;
  return candidate.mode === "light" || candidate.mode === "dark" ? candidate.mode : null;
}

export interface ResolvedThemeSource {
  readonly state: ThemeState;
  onModeChange(listener: (state: ThemeState) => void): () => void;
}

/** Send the current mode immediately, then every later resolved mode change. */
export function synchronizeResolvedTheme(
  source: ResolvedThemeSource,
  send: (message: ThemeChangedMessage) => void
): () => void {
  const notify = (state: ThemeState): void => send(createThemeChangedMessage(state.mode));
  const unsubscribe = source.onModeChange(notify);
  notify(source.state);
  return unsubscribe;
}
