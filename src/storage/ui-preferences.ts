/**
 * UI preferences — a small, *separate* persistence surface from the notes.
 *
 * These are view settings, not domain data, so they deliberately do not live on
 * `Note` records and do not share the IndexedDB schema. They are stored in
 * `browser.storage.local`, which:
 *   - keeps them out of the notes database entirely (no migration needed, and no
 *     chance of a schema change losing them);
 *   - is the documented, stable place for small extension settings;
 *   - survives restarts and is cleared with the extension's other data on
 *     uninstall.
 *
 * What is intentionally NOT persisted: the search query. It stays part of the
 * in-memory session state, so it survives while the space tab is open and resets
 * when the tab is closed.
 */

import { getBrowser } from "../api/browser";
import type { NoteFormat } from "../notes/model";
import { isNoteFormat } from "../notes/model";
import type { ColorFilter, ColorFilterValue, SortKey } from "../notes/query";
import { DEFAULT_SORT_KEY, isColorFilter, isColorFilterValue, isColorFilters, isSortKey } from "../notes/query";

/** Storage key, namespaced so it cannot collide with anything else. */
export const UI_PREFERENCES_KEY = "thundernotes.ui.v1";

export interface UiPreferences {
  sort: SortKey;
  colorFilter: ColorFilter;
  colorFilters?: readonly ColorFilterValue[];
  favoriteOnly?: boolean;
  /** The note that was selected when the user last left the space. */
  lastSelectedId: string | null;
  /** Optional format filter; `all` unless a future UI exposes it. */
  formatFilter: NoteFormat | "all";
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  sort: DEFAULT_SORT_KEY,
  colorFilter: "all",
  colorFilters: [],
  favoriteOnly: false,
  lastSelectedId: null,
  formatFilter: "all",
};

export interface UiPreferencesStore {
  load(): Promise<UiPreferences>;
  save(preferences: UiPreferences): Promise<void>;
}

/**
 * Coerce anything found on disk into valid preferences.
 *
 * Never throws and never returns a partially-invalid object: an unrecognised
 * sort, colour or format falls back to its default. This is what stops a stale
 * or hand-edited value from making the UI appear broken on startup.
 */
export function normalizeUiPreferences(input: unknown): UiPreferences {
  if (input === null || typeof input !== "object") return { ...DEFAULT_UI_PREFERENCES };
  const raw = input as Record<string, unknown>;

  const lastSelectedId =
    typeof raw.lastSelectedId === "string" && raw.lastSelectedId.length > 0 ? raw.lastSelectedId : null;

  return {
    sort: isSortKey(raw.sort) ? raw.sort : DEFAULT_UI_PREFERENCES.sort,
    // Accept the historical single-value preference and migrate it in memory.
    colorFilter: isColorFilter(raw.colorFilter) ? raw.colorFilter : "all",
    colorFilters: isColorFilters(raw.colorFilters)
      ? [...raw.colorFilters]
      : isColorFilterValue(raw.colorFilter) ? [raw.colorFilter] : [],
    favoriteOnly: raw.favoriteOnly === true,
    lastSelectedId,
    formatFilter:
      raw.formatFilter === "all" || isNoteFormat(raw.formatFilter)
        ? raw.formatFilter
        : DEFAULT_UI_PREFERENCES.formatFilter,
  };
}

/**
 * In-memory fallback used when `storage.local` is unavailable.
 *
 * Preferences degrade to "defaults every launch" — the notes themselves are
 * unaffected, which is the important part.
 */
export class MemoryUiPreferencesStore implements UiPreferencesStore {
  private preferences: UiPreferences = { ...DEFAULT_UI_PREFERENCES };

  async load(): Promise<UiPreferences> {
    return { ...this.preferences };
  }

  async save(preferences: UiPreferences): Promise<void> {
    this.preferences = normalizeUiPreferences(preferences);
  }
}

export class StorageUiPreferencesStore implements UiPreferencesStore {
  async load(): Promise<UiPreferences> {
    const storage = getBrowser()?.storage?.local;
    if (!storage) return { ...DEFAULT_UI_PREFERENCES };
    try {
      const result = await storage.get(UI_PREFERENCES_KEY);
      return normalizeUiPreferences(result?.[UI_PREFERENCES_KEY]);
    } catch (error) {
      console.warn("[ThunderNotes] could not read UI preferences", error);
      return { ...DEFAULT_UI_PREFERENCES };
    }
  }

  async save(preferences: UiPreferences): Promise<void> {
    const storage = getBrowser()?.storage?.local;
    if (!storage) return;
    try {
      await storage.set({ [UI_PREFERENCES_KEY]: normalizeUiPreferences(preferences) });
    } catch (error) {
      // Preferences are a convenience: failing to save them must never surface as
      // an error banner or interrupt editing.
      console.warn("[ThunderNotes] could not save UI preferences", error);
    }
  }
}

/** Pick the best available preferences backend. */
export function openUiPreferencesStore(): UiPreferencesStore {
  return getBrowser()?.storage?.local ? new StorageUiPreferencesStore() : new MemoryUiPreferencesStore();
}
