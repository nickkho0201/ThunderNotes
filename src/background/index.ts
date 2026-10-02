/**
 * ThunderNotes MV3 background module.
 *
 * Registers the Space, synchronizes its icon and handles native message actions.
 * Note mutations belong to the page/store. Action labels can read note metadata
 * through the repository; a live page supplies the memory-fallback state.
 */

import { getBrowser } from "../api/browser";
import { startMessageActions } from "./messages";
import { detectThemeMode } from "../theme/detect";
import { themeModeFromMessage } from "../theme/message";
import { applySpaceButton, ensureSpaceRegistered } from "./space";
import type { SpaceRegistration } from "./space";
import { loadStoredThemeMode, SpaceThemeSync, storeResolvedThemeMode } from "./theme-sync";

const api = getBrowser();
if (api) startMessageActions(api);
const themeSync = api
  ? new SpaceThemeSync<SpaceRegistration>({
      detect: () => detectThemeMode({ mediaQuery: null }),
      load: () => loadStoredThemeMode(api.storage?.local),
      save: (mode) => storeResolvedThemeMode(api.storage?.local, mode),
      register: (mode) => ensureSpaceRegistered(mode),
      apply: (mode) => applySpaceButton(mode),
    })
  : null;

function boot(): void {
  void themeSync?.boot();
}

if (api) {
  // Fired when Thunderbird starts, i.e. exactly when the parent-process space
  // tracker has been reset and the button needs re-creating.
  api.runtime.onStartup.addListener(boot);

  // Fired on install and on extension update. `spaces.create` is idempotent here,
  // so the same handler is correct for both.
  api.runtime.onInstalled.addListener(boot);

  // Live Light <-> Dark switching. The event carries the new theme; the
  // coordinator combines it with the page/stored fallback and hands Thunderbird
  // the matching `defaultIcons` without racing another update.
  api.theme?.onUpdated.addListener((updateInfo) => {
    void themeSync?.themeUpdated(updateInfo.theme);
  });
}

// Also run on every worker wake-up (MV3 service workers are terminated when
// idle). `ensureSpaceRegistered()` queries first, so this is a cheap no-op when
// the space is already registered.
boot();

/**
 * Small channel used by the space page.
 *
 *  - `thundernotes:space-info` — diagnostics (the page's own space id).
 *  - `thundernotes:theme-changed` — the page sends its resolved mode, including
 *    the DOM-only `prefers-color-scheme` fallback unavailable to this worker.
 */
api?.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message === null || typeof message !== "object") return false;
  const type = (message as { type?: unknown }).type;

  if (type === "thundernotes:space-info") {
    void themeSync?.boot().then((result) => {
      sendResponse({
        ok: result.ok,
        created: result.created,
        spaceId: result.space?.id ?? null,
        error: result.error ?? null,
      });
    });
    return true; // async response
  }

  const resolvedMode = themeModeFromMessage(message);
  if (resolvedMode) {
    void themeSync?.pageResolved(resolvedMode).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false })
    );
    return true;
  }

  return false;
});
