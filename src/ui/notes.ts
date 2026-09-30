/**
 * ThunderNotes space page entry point.
 *
 * Wires the store (data + autosave) to the two view components (list, editor)
 * and applies localization. No framework: the page is one toolbar, one virtual
 * list and one editor, and this keeps re-render cost bounded and predictable.
 */

import { getBrowser } from "../api/browser";
import { openNotesRepository } from "../storage/indexeddb";
import { NoteStore } from "./store";
import { NotesListView } from "./list-view";
import { EditorView, colorLabel } from "./editor-view";
import { startTheme } from "../theme";
import { t } from "../i18n";
import { openUiPreferencesStore } from "../storage/ui-preferences";
import type { Note, NoteColor, NoteFormat } from "../notes/model";
import type { ColorFilter, SortKey } from "../notes/query";
import { SORT_KEYS, isSortKey } from "../notes/query";

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`[ThunderNotes] missing element #${id}`);
  return element as T;
}

// ------------------------------------------------------------------ localized

const SORT_LABEL_KEYS: Record<SortKey, string> = {
  "created-desc": "sortCreatedDesc",
  "created-asc": "sortCreatedAsc",
  "updated-desc": "sortUpdatedDesc",
  "updated-asc": "sortUpdatedAsc",
};

const COLOR_LABEL_KEYS: Record<NoteColor | "none" | "all", string> = {
  all: "colorAll",
  none: "colorNone",
  red: "colorRed",
  orange: "colorOrange",
  yellow: "colorYellow",
  green: "colorGreen",
  blue: "colorBlue",
  purple: "colorPurple",
};

/** Apply every `data-i18n*` attribute in the document. */
function localizeDocument(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset.i18n;
    if (key) element.textContent = t(key);
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    const key = element.dataset.i18nTitle;
    if (key) element.title = t(key);
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]")) {
    const key = element.dataset.i18nPlaceholder;
    if (key) element.setAttribute("placeholder", t(key));
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) {
    const key = element.dataset.i18nAriaLabel;
    if (key) element.setAttribute("aria-label", t(key));
  }
}

function localizeToolbarColors(): void {
  const filterGroup = document.getElementById("tn-color-filter");
  if (filterGroup) {
    for (const button of filterGroup.querySelectorAll<HTMLButtonElement>("[data-color]")) {
      const value = button.dataset.color as NoteColor | "none" | "all" | undefined;
      if (value === undefined) continue;
      const label = t(COLOR_LABEL_KEYS[value]);
      button.title = label;
      button.setAttribute("aria-label", label);
      // The "All" filter benefits from a visible label; the rest are dots.
      if (value === "all") {
        button.classList.add("tn-color-btn--labelled");
        if (button.textContent === null || button.textContent.length === 0) {
          const span = document.createElement("span");
          span.textContent = label;
          button.append(span);
        }
      }
    }
  }

  const noteColorGroup = document.getElementById("tn-note-colors");
  if (noteColorGroup) {
    for (const button of noteColorGroup.querySelectorAll<HTMLButtonElement>("[data-color]")) {
      const value = button.dataset.color as NoteColor | "none" | undefined;
      if (value === undefined) continue;
      const label = colorLabel(value === "none" ? null : value);
      button.title = label;
      button.setAttribute("aria-label", label);
    }
  }
}

function populateSortOptions(select: HTMLSelectElement): void {
  select.replaceChildren();
  for (const key of SORT_KEYS) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = t(SORT_LABEL_KEYS[key]);
    select.append(option);
  }
}

// ----------------------------------------------------------------------- boot

async function main(): Promise<void> {
  localizeDocument();
  localizeToolbarColors();

  document.title = t("extName");

  const searchInput = requireElement<HTMLInputElement>("tn-search");
  const searchClear = requireElement<HTMLButtonElement>("tn-search-clear");
  const colorFilterGroup = requireElement<HTMLElement>("tn-color-filter");
  const sortSelect = requireElement<HTMLSelectElement>("tn-sort");
  const newButton = requireElement<HTMLButtonElement>("tn-new");
  const listElement = requireElement<HTMLElement>("tn-list");
  const listEmpty = requireElement<HTMLElement>("tn-list-empty");
  const countLabel = requireElement<HTMLElement>("tn-count");
  const saveStatus = requireElement<HTMLElement>("tn-save-status");
  const banner = requireElement<HTMLElement>("tn-banner");
  const bannerText = requireElement<HTMLElement>("tn-banner-text");
  const bannerClose = requireElement<HTMLButtonElement>("tn-banner-close");
  const editorRoot = requireElement<HTMLElement>("tn-editor");
  const editorEmpty = requireElement<HTMLElement>("tn-editor-empty");
  const textarea = requireElement<HTMLTextAreaElement>("tn-textarea");
  const preview = requireElement<HTMLElement>("tn-preview");
  const formatGroup = requireElement<HTMLElement>("tn-format");
  const markdownModeGroup = requireElement<HTMLElement>("tn-md-mode");
  const noteColorGroup = requireElement<HTMLElement>("tn-note-colors");
  const deleteButton = requireElement<HTMLButtonElement>("tn-delete");
  const mainElement = requireElement<HTMLElement>("tn-main");
  const backButton = requireElement<HTMLButtonElement>("tn-back");

  populateSortOptions(sortSelect);

  // Theme tracking runs independently of the data layer.
  const theme = await startTheme();

  /**
   * Ask the background to re-apply the space button.
   *
   * The background resolves the effective theme and re-applies one concrete
   * `defaultIcons` glyph set while clearing `themeIcons`. This also replaces icon
   * properties an older build registered. Costs one message.
   */
  const notifyThemeToBackground = (): void => {
    void getBrowser()?.runtime.sendMessage({ type: "thundernotes:theme-changed" }).catch(() => {
      // The background may be asleep; the button keeps its current icon set,
      // which is not worth surfacing to the user.
    });
  };
  theme.onModeChange(notifyThemeToBackground);

  const repository = await openNotesRepository();

  // Restored UI preferences (sort, colour filter, last selected note). Loaded
  // before the first render so the list never visibly re-sorts on startup.
  const preferenceStore = openUiPreferencesStore();
  const preferences = await preferenceStore.load();
  sortSelect.value = preferences.sort;

  let bannerTimer: ReturnType<typeof setTimeout> | null = null;

  const showBanner = (message: string, autoHideMs = 0): void => {
    bannerText.textContent = message;
    banner.hidden = false;
    if (bannerTimer !== null) clearTimeout(bannerTimer);
    if (autoHideMs > 0) {
      bannerTimer = setTimeout(() => {
        banner.hidden = true;
        bannerTimer = null;
      }, autoHideMs);
    }
  };
  bannerClose.addEventListener("click", () => {
    banner.hidden = true;
  });

  const store = new NoteStore(repository, {
    initialFilter: {
      sort: preferences.sort,
      color: preferences.colorFilter,
      format: preferences.formatFilter,
    },
    onError: (error, context) => {
      const message = error instanceof Error ? error.message : String(error);
      const key = context === "load" ? "loadError" : context === "delete" ? "deleteError" : "saveError";
      showBanner(t(key, message));
    },
  });

  // ------------------------------------------------------------------- views

  /**
   * The narrow single-pane layout is handled by CSS; this flag only tells the
   * wiring which navigation behaviour is in effect (switching panes on selection
   * and on the back button).
   */
  const narrowQuery =
    typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 780px)") : null;
  const isNarrow = (): boolean => narrowQuery?.matches ?? false;

  const showListPane = (): void => {
    mainElement.dataset.pane = "list";
  };
  const showEditorPane = (): void => {
    mainElement.dataset.pane = "editor";
  };

  let editorView: EditorView;

  const listView = new NotesListView({
    listElement,
    emptyElement: listEmpty,
    onSelect: (id) => {
      store.select(id);
      // In the single-pane layout, choosing a note reveals the editor.
      if (isNarrow()) showEditorPane();
    },
    onActivate: () => {
      if (isNarrow()) showEditorPane();
      editorView.focus();
    },
  });

  // Row timestamps must reflect the active sort field from the very first render.
  listView.setSort(store.getFilter().sort);

  editorView = new EditorView({
    root: editorRoot,
    textarea,
    preview,
    formatGroup,
    markdownModeGroup,
    noteColorGroup,
    deleteButton,
    onContentChange: (content) => {
      store.updateSelected({ content });
    },
    onFormatChange: (format: NoteFormat) => {
      store.updateSelected({ format });
    },
    onColorChange: (color) => {
      store.updateSelected({ color });
    },
    onDelete: () => {
      const note = store.getSelectedNote();
      if (!note) return;
      const excerpt = note.content.trim().split(/\r?\n/, 1)[0]?.slice(0, 60) ?? "";
      const body = excerpt.length > 0
        ? `${t("deleteConfirmMessage")}\n\n${excerpt}`
        : t("deleteConfirmMessage");
      if (window.confirm(`${t("deleteConfirmTitle")}\n\n${body}`)) {
        void store.deleteNote(note.id);
      }
    },
  });

  // ----------------------------------------------------------------- persistence

  /**
   * The colour filter has exactly ONE owner of its button state: the store.
   *
   * `createNote()` silently widens the filter to "all" (so a brand-new note is
   * never invisible), so the buttons must be driven from the store on every
   * filter change. Setting `is-active` in the click handler as well would give
   * the same state two owners, which is how the highlighted button once drifted
   * out of step with the applied filter.
   */
  const syncFilterButtons = (): void => {
    const active = store.getFilter().color;
    for (const button of colorFilterGroup.querySelectorAll<HTMLButtonElement>("[data-color]")) {
      button.classList.toggle("is-active", button.dataset.color === active);
    }
  };

  /** Last known preference values, so a save only happens on a real change. */
  let lastSavedColorFilter = store.getFilter().color;
  let lastSavedSort = store.getFilter().sort;
  let lastSavedFormatFilter = store.getFilter().format;
  let lastSavedSelectedId = store.getSelectedId();

  const persistPreferences = (): void => {
    const filter = store.getFilter();
    const selectedId = store.getSelectedId();
    if (
      filter.color === lastSavedColorFilter &&
      filter.sort === lastSavedSort &&
      filter.format === lastSavedFormatFilter &&
      selectedId === lastSavedSelectedId
    ) {
      return;
    }
    lastSavedColorFilter = filter.color;
    lastSavedSort = filter.sort;
    lastSavedFormatFilter = filter.format;
    lastSavedSelectedId = selectedId;
    void preferenceStore.save({
      sort: filter.sort,
      colorFilter: filter.color,
      formatFilter: filter.format,
      // Persisted so the same note is reopened next time. A stale id is handled
      // by `store.selectInitial`.
      lastSelectedId: selectedId,
    });
  };

  const renderCount = (): void => {
    const visible = store.getVisible().length;
    const total = store.getNotes().length;
    countLabel.textContent = t("noteCount", [String(visible), String(total)]);
  };

  const renderSaveStatus = (): void => {
    const status = store.getSaveStatus();
    saveStatus.dataset.status = status;
    saveStatus.textContent =
      status === "saving" ? t("saving") : status === "error" ? t("saveFailed") : status === "saved" ? t("saved") : "";
  };

  const renderList = (): void => {
    const filtered = store.isFiltering();
    const emptyMessage = filtered
      ? t("emptyNoMatches")
      : `${t("emptyNoNotes")} ${t("emptyNoNotesHint")}`;
    listView.setItems(store.getVisible(), emptyMessage, store.getGeneration());
    listView.setSelected(store.getSelectedId());
    renderCount();
  };
  const renderEditor = (): void => {
    const note: Note | null = store.getSelectedNote();
    editorView.render(note);
    editorEmpty.hidden = note !== null;
    renderSaveStatus();
  };

  store.subscribe((event) => {
    switch (event.type) {
      case "notes":
      case "visible":
        renderList();
        // A note change can alter the editor state too (format, colour, or the
        // note being deleted): without this, switching a note to Markdown would
        // persist the change but leave the UI showing "Plain Text".
        renderEditor();
        break;
      case "filter":
        // Search, colour filter and sort change the projection without changing
        // the note set, so the rendered window must be rebuilt explicitly, and
        // the rows must switch to the timestamp of the new sort field.
        listView.invalidate();
        listView.setSort(store.getFilter().sort);
        // `createNote()` widens the filter to "all" behind the user's back, so the
        // buttons must be driven from the store here rather than only from the
        // click handler.
        syncFilterButtons();
        renderList();
        renderEditor();
        persistPreferences();
        break;
      case "selection":
        renderList();
        renderEditor();
        persistPreferences();
        break;
      case "save-status":
        renderSaveStatus();
        break;
      case "error":
        showBanner(event.message);
        break;
    }
  });

  // ---------------------------------------------------------------- controls

  searchInput.addEventListener("input", () => {
    store.setSearch(searchInput.value);
    searchClear.hidden = searchInput.value.length === 0;
  });

  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    searchClear.hidden = true;
    store.setSearch("");
    searchInput.focus();
  });

  colorFilterGroup.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-color]");
    const value = button?.dataset.color;
    if (value === undefined) return;
    // The store is the only owner of the button state; `syncFilterButtons` runs on
    // the resulting `filter` event, so a rejected or widened value can never leave
    // a stale highlight behind.
    store.setColorFilter(value as ColorFilter);
  });

  sortSelect.addEventListener("change", () => {
    if (isSortKey(sortSelect.value)) store.setSort(sortSelect.value);
  });

  newButton.addEventListener("click", () => {
    void store.createNote().then(() => {
      if (isNarrow()) showEditorPane();
      editorView.focus();
    });
  });

  // Narrow layout only: hand the pane back to the list. The note stays selected
  // (and any pending edit is flushed), so returning shows it highlighted again.
  backButton.addEventListener("click", () => {
    store.flushPending();
    showListPane();
    listElement.focus();
  });

  // Keyboard shortcuts, deliberately limited to combinations Thunderbird does not
  // already use for something else.
  document.addEventListener("keydown", (event) => {
    // AltGr arrives as Ctrl+Alt on many layouts, and a held key repeats; neither
    // should create a stream of notes.
    if (event.altKey || event.repeat) return;

    const modifier = event.ctrlKey || event.metaKey;
    if (!modifier) return;

    const key = event.key.toLowerCase();

    if (key === "n" && !event.shiftKey) {
      event.preventDefault();
      void store.createNote().then(() => {
        if (isNarrow()) showEditorPane();
        editorView.focus();
      });
      return;
    }
    if (key === "f") {
      event.preventDefault();
      if (isNarrow()) showListPane();
      searchInput.focus();
      searchInput.select();
    }
    // Ctrl+S is intentionally not intercepted: autosave handles persistence and
    // Thunderbird may bind it itself. A manual save would only add surprise.
  });

  // Escape returns to the list in the single-pane layout.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isNarrow()) return;
    if (mainElement.dataset.pane !== "editor") return;
    store.flushPending();
    showListPane();
    listElement.focus();
  });

  // Never lose a pending edit when the page goes away.
  window.addEventListener("pagehide", () => store.flushPending());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") store.flushPending();
  });

  // ------------------------------------------------------------------- start

  await store.init();

  if (repository.info.kind === "memory") {
    showBanner(t("storageMemoryWarning"));
  }

  // Apply the restored colour filter to its button before the first render.
  syncFilterButtons();

  renderList();
  renderEditor();

  // Restore the previous note when it still exists and is visible under the
  // restored filter; otherwise fall back to a sensible selection (or none).
  store.selectInitial(preferences.lastSelectedId);
  lastSavedSelectedId = store.getSelectedId();
  renderList();
  renderEditor();

  // In the narrow layout the space opens on the list, never on a half-visible
  // editor. In the wide layout both panes are always shown.
  showListPane();

  // Reflect the UI language on <html lang> for screen readers.
  const language = getBrowser()?.i18n?.getUILanguage();
  if (language && language.length > 0) document.documentElement.lang = language;

  // Keeps a reference so tooling can inspect state during development; it is not
  // part of the extension's public surface.
  Object.defineProperty(globalThis, "__thunderNotes", {
    value: { store, listView, editorView, theme },
    configurable: true,
  });
}

main().catch((error: unknown) => {
  console.error("[ThunderNotes] failed to start", error);
  const text = error instanceof Error ? error.message : String(error);
  const banner = document.getElementById("tn-banner");
  const bannerText = document.getElementById("tn-banner-text");
  if (banner && bannerText) {
    bannerText.textContent = t("loadError", text);
    banner.hidden = false;
  }
});
