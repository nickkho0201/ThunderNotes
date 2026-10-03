/**
 * UI preference persistence.
 *
 * Preferences are view state (sort, colour filter, last selected note) and are
 * stored separately from the note domain data. These tests cover the validation
 * rules that keep a stale or hand-edited value from making the UI look broken on
 * startup.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_UI_PREFERENCES,
  MemoryUiPreferencesStore,
  StorageUiPreferencesStore,
  UI_PREFERENCES_KEY,
  normalizeUiPreferences,
  openUiPreferencesStore,
} from "../src/storage/ui-preferences.ts";
import type { UiPreferences } from "../src/storage/ui-preferences.ts";
import type { StorageArea, ThunderbirdBrowser } from "../src/api/browser.ts";

describe("ui preferences: defaults", () => {
  it("defaults to created-newest-first with no filter and no selection", () => {
    assert.deepEqual(DEFAULT_UI_PREFERENCES, {
      sort: "created-desc",
      colorFilter: "all",
      colorFilters: [],
      favoriteOnly: false,
      lastSelectedId: null,
      formatFilter: "all",
    });
  });

  it("does not persist the search query", () => {
    // The stored shape has no search field at all: search lives only in the
    // session, exactly as required.
    assert.ok(!("search" in DEFAULT_UI_PREFERENCES));
  });
  it("does not restore created-date query fields from persisted preferences", () => {
    const normalized = normalizeUiPreferences({ ...DEFAULT_UI_PREFERENCES, createdFrom: "2026-09-01", createdTo: "2026-09-30" });
    assert.ok(!("createdFrom" in normalized));
    assert.ok(!("createdTo" in normalized));
  });
});

describe("ui preferences: normalizeUiPreferences", () => {
  it("accepts a well-formed record", () => {
    const input: UiPreferences = {
      sort: "updated-asc",
      colorFilter: "blue",
      colorFilters: ["blue"],
      favoriteOnly: true,
      lastSelectedId: "note-1",
      formatFilter: "markdown",
    };
    assert.deepEqual(normalizeUiPreferences(input), input);
  });

  it("returns defaults for anything that is not an object", () => {
    for (const value of [null, undefined, 42, "nope", true, []]) {
      const result = normalizeUiPreferences(value);
      assert.equal(result.sort, DEFAULT_UI_PREFERENCES.sort, JSON.stringify(value));
      assert.equal(result.colorFilter, "all");
      assert.equal(result.lastSelectedId, null);
    }
  });

  it("drops an unrecognised sort instead of trusting it", () => {
    assert.equal(normalizeUiPreferences({ sort: "size-desc" }).sort, DEFAULT_UI_PREFERENCES.sort);
    assert.equal(normalizeUiPreferences({ sort: 5 }).sort, DEFAULT_UI_PREFERENCES.sort);
    assert.equal(normalizeUiPreferences({ sort: "updated-desc" }).sort, "updated-desc");
  });

  it("drops an unrecognised colour filter", () => {
    assert.equal(normalizeUiPreferences({ colorFilter: "chartreuse" }).colorFilter, "all");
    assert.equal(normalizeUiPreferences({ colorFilter: "none" }).colorFilter, "none");
    assert.equal(normalizeUiPreferences({ colorFilter: "purple" }).colorFilter, "purple");
  });

  it("drops an empty or non-string last selected id", () => {
    assert.equal(normalizeUiPreferences({ lastSelectedId: "" }).lastSelectedId, null);
    assert.equal(normalizeUiPreferences({ lastSelectedId: 7 }).lastSelectedId, null);
    assert.equal(normalizeUiPreferences({ lastSelectedId: "x" }).lastSelectedId, "x");
  });

  it("drops an unrecognised format filter", () => {
    assert.equal(normalizeUiPreferences({ formatFilter: "wysiwyg" }).formatFilter, "all");
    assert.equal(normalizeUiPreferences({ formatFilter: "plain" }).formatFilter, "plain");
  });

  it("always returns a complete object, never a partial one", () => {
    const result = normalizeUiPreferences({ sort: "updated-desc" });
    assert.deepEqual(Object.keys(result).sort(), ["colorFilter", "colorFilters", "favoriteOnly", "formatFilter", "lastSelectedId", "sort"]);
  });
});

describe("ui preferences: in-memory store", () => {
  it("round-trips preferences", async () => {
    const store = new MemoryUiPreferencesStore();
    await store.save({
      sort: "created-asc",
      colorFilter: "green",
      colorFilters: ["green", "blue"],
      favoriteOnly: true,
      lastSelectedId: "abc",
      formatFilter: "all",
    });
    assert.deepEqual(await store.load(), {
      sort: "created-asc",
      colorFilter: "green",
      colorFilters: ["green", "blue"],
      favoriteOnly: true,
      lastSelectedId: "abc",
      formatFilter: "all",
    });
  });

  it("normalizes on the way in", async () => {
    const store = new MemoryUiPreferencesStore();
    await store.save({
      sort: "bogus" as never,
      colorFilter: "nope" as never,
      lastSelectedId: "" as never,
      formatFilter: "all",
    });
    const loaded = await store.load();
    assert.equal(loaded.sort, DEFAULT_UI_PREFERENCES.sort);
    assert.equal(loaded.colorFilter, "all");
    assert.equal(loaded.lastSelectedId, null);
  });

  it("hands out copies, so a caller cannot mutate internal state", async () => {
    const store = new MemoryUiPreferencesStore();
    const first = await store.load();
    first.sort = "updated-asc";
    assert.equal((await store.load()).sort, DEFAULT_UI_PREFERENCES.sort);
  });
});

/** A `storage.local` stand-in, so the real store path can be exercised. */
function fakeStorageArea(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  const calls: string[] = [];
  const area: StorageArea = {
    async get(keys) {
      calls.push("get");
      if (keys === undefined || keys === null) return Object.fromEntries(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of list) if (data.has(key)) result[key] = data.get(key);
      return result;
    },
    async set(items) {
      calls.push("set");
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
    },
    async clear() {
      data.clear();
    },
  };
  return { area, data, calls };
}

function withFakeStorage(area: StorageArea | null, run: () => Promise<void>): Promise<void> {
  const previous = globalThis.browser;
  globalThis.browser = {
    i18n: { getMessage: () => "", getUILanguage: () => "en-US" },
    runtime: { getURL: (path: string) => `moz-extension://fake/${path}` },
    ...(area ? { storage: { local: area } } : {}),
  } as unknown as ThunderbirdBrowser;
  return run().finally(() => {
    globalThis.browser = previous;
  });
}

describe("ui preferences: browser.storage.local store", () => {
  let harness: ReturnType<typeof fakeStorageArea>;

  beforeEach(() => {
    harness = fakeStorageArea();
  });

  it("writes under a namespaced key, separate from note data", async () => {
    await withFakeStorage(harness.area, async () => {
      const store = new StorageUiPreferencesStore();
      await store.save({
        sort: "updated-desc",
        colorFilter: "red",
        lastSelectedId: "n1",
        formatFilter: "all",
      });
    });

    assert.deepEqual([...harness.data.keys()], [UI_PREFERENCES_KEY]);
    assert.equal(UI_PREFERENCES_KEY, "thundernotes.ui.v1");
    // The payload is preferences only — it must never contain notes.
    const stored = harness.data.get(UI_PREFERENCES_KEY) as Record<string, unknown>;
    assert.deepEqual(Object.keys(stored).sort(), ["colorFilter", "colorFilters", "favoriteOnly", "formatFilter", "lastSelectedId", "sort"]);
  });

  it("reads back what it wrote", async () => {
    await withFakeStorage(harness.area, async () => {
      const store = new StorageUiPreferencesStore();
      await store.save({
        sort: "created-asc",
        colorFilter: "orange",
        lastSelectedId: "n9",
        formatFilter: "all",
      });
      assert.deepEqual(await store.load(), {
        sort: "created-asc",
        colorFilter: "orange",
        colorFilters: ["orange"],
        favoriteOnly: false,
        lastSelectedId: "n9",
        formatFilter: "all",
      });
    });
  });

  it("returns defaults when nothing has been stored yet", async () => {
    await withFakeStorage(harness.area, async () => {
      assert.deepEqual(await new StorageUiPreferencesStore().load(), DEFAULT_UI_PREFERENCES);
    });
  });

  it("repairs a corrupt stored record instead of failing", async () => {
    harness = fakeStorageArea({ [UI_PREFERENCES_KEY]: { sort: 12, colorFilter: null, lastSelectedId: {} } });
    await withFakeStorage(harness.area, async () => {
      const loaded = await new StorageUiPreferencesStore().load();
      assert.equal(loaded.sort, DEFAULT_UI_PREFERENCES.sort);
      assert.equal(loaded.colorFilter, "all");
      assert.equal(loaded.lastSelectedId, null);
    });
  });

  it("repairs a stored value of the wrong type entirely", async () => {
    harness = fakeStorageArea({ [UI_PREFERENCES_KEY]: "garbage" });
    await withFakeStorage(harness.area, async () => {
      assert.deepEqual(await new StorageUiPreferencesStore().load(), DEFAULT_UI_PREFERENCES);
    });
  });

  it("never throws when the storage area itself fails", async () => {
    const failing: StorageArea = {
      async get() {
        throw new Error("storage disabled");
      },
      async set() {
        throw new Error("storage disabled");
      },
      async remove() {},
      async clear() {},
    };
    await withFakeStorage(failing, async () => {
      const store = new StorageUiPreferencesStore();
      assert.deepEqual(await store.load(), DEFAULT_UI_PREFERENCES);
      // A failed save must resolve, not reject: preferences are a convenience.
      await store.save({ sort: "updated-asc", colorFilter: "all", lastSelectedId: null, formatFilter: "all" });
    });
  });

  it("falls back to memory when storage.local is unavailable", async () => {
    await withFakeStorage(null, async () => {
      const store = openUiPreferencesStore();
      assert.ok(store instanceof MemoryUiPreferencesStore);
      await store.save({ sort: "updated-asc", colorFilter: "all", lastSelectedId: null, formatFilter: "all" });
      assert.equal((await store.load()).sort, "updated-asc");
    });
  });

  it("selects the storage-backed store when storage.local exists", async () => {
    await withFakeStorage(harness.area, async () => {
      assert.ok(openUiPreferencesStore() instanceof StorageUiPreferencesStore);
    });
  });
});
