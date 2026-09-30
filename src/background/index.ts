/**
 * ThunderNotes background service worker.
 *
 * Its only job in the MVP is to keep the Spaces-toolbar button registered, and to
 * keep its icon matched to Thunderbird's current Light/Dark theme. Notes
 * themselves live in the extension page's own IndexedDB, so the worker does not
 * touch user data and can be killed at any time.
 */

import { getBrowser } from "../api/browser";
import { applySpaceButton, ensureSpaceRegistered } from "./space";

const api = getBrowser();

function boot(): void {
  // `registerSpace()` resolves the effective theme itself before creating or
  // updating the space, so the first registration already carries the right icon.
  void ensureSpaceRegistered();
}

if (api) {
  // Fired when Thunderbird starts, i.e. exactly when the parent-process space
  // tracker has been reset and the button needs re-creating.
  api.runtime.onStartup.addListener(boot);

  // Fired on install and on extension update. `spaces.create` is idempotent here,
  // so the same handler is correct for both.
  api.runtime.onInstalled.addListener(boot);

  // Live Light <-> Dark switching. `theme.onUpdated` fires when a theme is
  // applied, and `applySpaceButton()` re-reads the effective mode and hands
  // Thunderbird the matching `defaultIcons`.
  api.theme?.onUpdated.addListener(() => {
    void applySpaceButton();
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
 *  - `thundernotes:theme-changed` — the page resolved a different theme mode, so
 *    the button is re-applied. This is belt-and-braces alongside the worker's own
 *    `theme.onUpdated` listener: the page evaluates `prefers-color-scheme` too,
 *    which covers a "System theme — auto" switch that fires no theme event.
 */
api?.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message === null || typeof message !== "object") return false;
  const type = (message as { type?: unknown }).type;

  if (type === "thundernotes:space-info") {
    void ensureSpaceRegistered().then((result) => {
      sendResponse({
        ok: result.ok,
        created: result.created,
        spaceId: result.space?.id ?? null,
        error: result.error ?? null,
      });
    });
    return true; // async response
  }

  if (type === "thundernotes:theme-changed") {
    // Fire-and-forget: the page does not need to wait, and a failure here must
    // not disturb the UI.
    void applySpaceButton();
    return false;
  }

  return false;
});
