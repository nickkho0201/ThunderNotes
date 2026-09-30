/**
 * ThunderNotes space registration.
 *
 * Thunderbird does NOT persist extension-created spaces: `SpaceTracker` keeps
 * them in an in-memory `Map` in the parent process, and `spaces.create()` throws
 * `"Failed to create space with name <n>: Space already exists for this
 * extension."` when a space with that name is already registered.
 *
 * That gives us two hard requirements:
 *
 *  1. The space must be re-created on every Thunderbird start.
 *  2. Creation must be idempotent, because an MV3 service worker restart happens
 *     while the parent-process tracker (and therefore the space) survives. A
 *     naive `create()` on every worker wake-up would reject loudly.
 *
 * Strategy: always `spaces.query({ isSelfOwned: true })` first and adopt an
 * existing space, then fall back to `create()`, tolerating the "already exists"
 * race as a success. `spaces.update()` is used to repair the button (title,
 * icons, URL), which also makes a future icon/URL change take effect without
 * removing and recreating the space.
 *
 * The space id is deliberately NEVER persisted: ids are assigned from a runtime
 * counter (built-ins consume 1–6) and are not stable across restarts.
 */

import { getBrowser } from "../api/browser";
import type { Space, SpaceButtonProperties } from "../api/browser";
import { t } from "../i18n";
import { detectTheme } from "../theme/detect";
import type { ThemeMode } from "../theme/detect";

/**
 * Space name. Thunderbird requires `^[a-zA-Z0-9_]+$` and uniqueness per
 * extension, so this is a stable technical identifier — not a UI string, and
 * therefore not localized.
 */
export const SPACE_NAME = "thundernotes";

/** Extension page opened by the space. Relative to the manifest root. */
export const SPACE_PAGE = "notes.html";

/**
 * Space toolbar icons, by glyph colour.
 *
 * Self-contained SVGs with literal colours. A manual test in Thunderbird 156
 * showed the context paint mechanism (`-moz-context-properties` +
 * `context-stroke`, which Thunderbird's own built-in space icons rely on) does
 * NOT reach a custom space button: the glyph rendered completely invisible.
 *
 * Paths are relative to the extension root, as `IconPath` requires.
 */
export const SPACE_ICONS = {
  dark16: "assets/icons/notes-glyph-dark-16.svg",
  light16: "assets/icons/notes-glyph-light-16.svg",
  dark32: "assets/icons/notes-glyph-dark-32.svg",
  light32: "assets/icons/notes-glyph-light-32.svg",
} as const;

/**
 * The icon set to use for a given effective theme mode.
 *
 * The acceptance criterion, stated plainly:
 *   light theme -> the DARK glyph
 *   dark theme  -> the LIGHT glyph
 */
export function iconsForMode(mode: ThemeMode): Record<string, string> {
  return mode === "dark"
    ? { 16: SPACE_ICONS.light16, 32: SPACE_ICONS.light32 }
    : { 16: SPACE_ICONS.dark16, 32: SPACE_ICONS.dark32 };
}

/**
 * Button properties for the space toolbar entry.
 *
 * ## Why the icon is chosen explicitly instead of via `themeIcons`
 *
 * `themeIcons` asks Thunderbird to pick between a `dark` and a `light` glyph
 * itself. Three rounds of manually testing the Space button in Thunderbird 156
 * produced contradictory results from that automatic selection:
 *
 *   - documenting the fields as the artwork colour (and mapping them that way)
 *     rendered the wrong glyph;
 *   - mapping them the other way round also rendered the wrong glyph;
 *   - `defaultIcons` + context paint rendered no glyph at all.
 *
 * So the automatic mechanism is not used at all. This function reads the
 * effective theme from the shared detection layer — the *same* decision the
 * space page uses for its own Light/Dark styling — and hands Thunderbird one
 * concrete set of icons through `defaultIcons`. The extension decides; there is
 * nothing left for Thunderbird to interpret.
 *
 * `themeIcons` is explicitly set to `null` (`spaces.update()` merges properties,
 * so this is what clears the sets registered by 0.1.2/0.1.3).
 */
export async function buildButtonProperties(): Promise<SpaceButtonProperties> {
  const mode = await detectTheme();
  return {
    title: t("spaceTitle"),
    defaultIcons: iconsForMode(mode),
    // Explicitly cleared: see above. `null` is the documented reset value.
    themeIcons: null,
  };
}

/**
 * Registration result.
 */
export interface SpaceRegistration {
  ok: boolean;
  space?: Space;
  created: boolean;
  error?: string;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return t("unknownError");
}

/** True when a rejected `create()` merely means the space already exists. */
function isAlreadyExists(error: unknown): boolean {
  const message = describeError(error);
  return /already exists/i.test(message);
}

/**
 * Register (or adopt) the ThunderNotes space. Idempotent and safe to await
 * concurrently from `onStartup`, `onInstalled` and worker wake-up.
 */
export async function registerSpace(): Promise<SpaceRegistration> {
  const spaces = getBrowser()?.spaces;
  if (!spaces) {
    return { ok: false, created: false, error: "spaces API unavailable" };
  }

  const url = getBrowser()!.runtime.getURL(SPACE_PAGE);
  // Resolved before the space is touched, so the very first registration already
  // carries the icon for the current theme.
  const button = await buildButtonProperties();

  let existing: Space | undefined;
  try {
    const owned = await spaces.query({ isSelfOwned: true });
    existing = owned.find((space) => space.name === SPACE_NAME) ?? owned[0];
  } catch (error) {
    console.warn("[ThunderNotes] spaces.query() failed", error);
  }

  if (existing) {
    try {
      // Repair the tab URL and button in case the page path or icons changed.
      await spaces.update(existing.id, url, button);
    } catch (error) {
      console.warn("[ThunderNotes] spaces.update() failed", error);
    }
    return { ok: true, space: existing, created: false };
  }

  try {
    const space = await spaces.create(SPACE_NAME, url, button);
    return { ok: true, space, created: true };
  } catch (error) {
    if (isAlreadyExists(error)) {
      // Lost a race with another context: adopt whatever is registered.
      try {
        const owned = await spaces.query({ isSelfOwned: true });
        const adopted = owned.find((space) => space.name === SPACE_NAME) ?? owned[0];
        if (adopted) return { ok: true, space: adopted, created: false };
      } catch {
        // fall through to the error result
      }
    }
    const message = describeError(error);
    console.error(`[ThunderNotes] ${t("spaceRegisterError", message)}`);
    return { ok: false, created: false, error: message };
  }
}

/**
 * Re-apply the space button with the icon for the current theme.
 *
 * Called when Thunderbird's theme changes and once when the space is opened. It
 * re-reads the effective theme, so this is also what makes a live Light <-> Dark
 * switch change the toolbar glyph. Upgrading from an older build is handled by the
 * same call, because `buildButtonProperties()` always clears `themeIcons`.
 */
export async function applySpaceButton(): Promise<boolean> {
  const spaces = getBrowser()?.spaces;
  if (!spaces) return false;

  try {
    const owned = await spaces.query({ isSelfOwned: true });
    const space = owned.find((candidate) => candidate.name === SPACE_NAME) ?? owned[0];
    if (!space) return false;

    const url = getBrowser()!.runtime.getURL(SPACE_PAGE);
    // The URL is passed as a plain string rather than a `SpaceTabProperties`
    // object: the object form only arrived in Thunderbird 135, while the string
    // form works in every version that has the spaces API at all. Keeping the
    // declared `strict_min_version` at 128 therefore stays honest.
    const button = await buildButtonProperties();
    await spaces.update(space.id, url, button);
    return true;
  } catch (error) {
    console.warn("[ThunderNotes] could not re-apply the space button", error);
    return false;
  }
}

/**
 * Guards against a burst of concurrent registrations (worker wake-up racing
 * `onStartup`). The promise is cleared once settled so a later wake-up re-checks
 * Thunderbird's live state instead of trusting a stale result.
 */
let inFlight: Promise<SpaceRegistration> | null = null;

export function ensureSpaceRegistered(): Promise<SpaceRegistration> {
  if (!inFlight) {
    inFlight = registerSpace().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
