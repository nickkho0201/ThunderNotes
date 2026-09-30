/**
 * ThunderNotes application store.
 *
 * Framework-free, deliberately: the MVP UI is a small keyed list plus a text
 * editor, so a hand-written store keeps the bundle tiny and avoids React's
 * whole-tree re-render cost at the 1k–10k note target.
 *
 * Responsibilities:
 *  - keeps the canonical `Note[]` and a derived, indexed view for filtering;
 *  - owns the filter/search/sort state;
 *  - owns selection and autosave;
 *  - emits typed change events so the view layer can update surgically.
 *
 * It knows nothing about IndexedDB (only `NotesRepository`) and nothing about
 * DOM, so it is unit-testable in Node.
 */

import type { Note, NoteFormat } from "../notes/model";
import { applyNoteChange, createNote } from "../notes/model";
import type { NotesRepository } from "../storage/repository";
import type { ColorFilter, IndexedNote, NotesFilter, SortKey } from "../notes/query";
import { DEFAULT_FILTER, indexNote, indexedNotes, isSortKey, selectNotes } from "../notes/query";
/** Autosave debounce, within the requested 300–500 ms window. */
export const AUTOSAVE_DELAY_MS = 400;

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface StoreState {
  notes: IndexedNote[];
  visible: IndexedNote[];
  selectedId: string | null;
  filter: NotesFilter;
  saveStatus: SaveStatus;
  /** True while the initial load has not finished. */
  loading: boolean;
  /** Non-null when persistent storage is unavailable. */
  storageKind: string;
}

export type StoreEvent =
  | { type: "notes" }
  | { type: "visible" }
  | { type: "selection" }
  | { type: "filter" }
  | { type: "save-status" }
  | { type: "error"; message: string };

export type StoreListener = (event: StoreEvent) => void;

export interface NoteStoreOptions {
  /**
   * Autosave debounce in ms. `0` means "no deliberate delay" — the write is still
   * deferred to a microtask so a burst of changes in one tick coalesces.
   */
  autosaveDelayMs?: number;
  /** Called when a write fails. */
  onError?: (error: unknown, context: "load" | "save" | "delete") => void;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
  /**
   * Filter/sort to start from. Used to apply restored UI preferences. The search
   * query is deliberately not part of persisted state, but it is accepted here so
   * tests and future callers can seed it.
   */
  initialFilter?: Partial<NotesFilter>;
}

/** Immutable array replace (`Array.prototype.with` is avoided for compatibility). */
function replaceAt<T>(list: readonly T[], index: number, value: T): T[] {
  const copy = [...list];
  copy[index] = value;
  return copy;
}

/**
 * Minimal debounce helper producing a `flush()`-able handle.
 *
 * `delayMs <= 0` still defers (to a microtask) rather than running inline. That
 * matters: without it, a burst of changes in the same tick — or an `update()`
 * immediately followed by `flushPending()` — would produce several writes for the
 * same record instead of one.
 */
export function createDebounced<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: number
): { schedule(...args: A): void; flush(): void; cancel(): void; readonly pending: boolean } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deferred = false;
  let lastArgs: A | null = null;

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    deferred = false;
  };

  const run = (): void => {
    const args = lastArgs;
    lastArgs = null;
    if (args) fn(...args);
  };

  return {
    schedule(...args: A) {
      lastArgs = args;
      if (timer !== null || deferred) return; // already queued; the args are updated
      if (delayMs <= 0) {
        deferred = true;
        queueMicrotask(() => {
          if (!deferred) return;
          deferred = false;
          run();
        });
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delayMs);
    },
    flush() {
      clear();
      run();
    },
    cancel() {
      clear();
      lastArgs = null;
    },
    get pending() {
      return timer !== null || deferred;
    },
  };
}

export class NoteStore {
  private notes: Note[] = [];
  private indexed: IndexedNote[] = [];
  private visible: IndexedNote[] = [];
  private filter: NotesFilter = { ...DEFAULT_FILTER };
  private selectedId: string | null = null;
  private saveStatus: SaveStatus = "idle";
  private loading = true;
  private storageKind: string;
  /**
   * Incremented whenever the note set (or any note's fields) changes.
   *
   * The list view uses this to decide whether its rendered window is still
   * valid: without it, it would either rebuild the window on every keystroke or
   * skip a genuine change that happens to leave the window bounds identical.
   */
  private generation = 0;

  /** O(1) note lookup, rebuilt only when the note set changes. */
  private noteIndex = new Map<string, Note>();

  private readonly listeners = new Set<StoreListener>();
  private readonly autosave: ReturnType<typeof createDebounced<[Note]>>;
  /** Notes with unwritten changes, keyed by id. */
  private readonly dirty = new Map<string, Note>();
  private readonly now: () => number;

  constructor(
    private readonly repository: NotesRepository,
    private readonly options: NoteStoreOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.storageKind = repository.info.kind;
    if (options.initialFilter) this.filter = { ...this.filter, ...options.initialFilter };
    this.autosave = createDebounced<[Note]>(
      (note) => {
        void this.persist(note);
      },
      options.autosaveDelayMs ?? AUTOSAVE_DELAY_MS
    );
  }

  // ---------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    try {
      this.notes = await this.repository.getAll();
      this.storageKind = this.repository.info.kind;
    } catch (error) {
      this.notes = [];
      this.reportError(error, "load");
    }
    this.reindex();
    this.generation += 1;
    this.loading = false;
    this.emit({ type: "notes" });
    this.emit({ type: "visible" });
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: StoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[ThunderNotes] store listener failed", error);
      }
    }
  }

  private reportError(error: unknown, context: "load" | "save" | "delete"): void {
    console.error(`[ThunderNotes] ${context} failed`, error);
    if (this.options.onError) this.options.onError(error, context);
    else this.emit({ type: "error", message: String(error) });
  }

  // ------------------------------------------------------------------- getters

  getState(): StoreState {
    return {
      notes: this.indexed,
      visible: this.visible,
      selectedId: this.selectedId,
      filter: this.filter,
      saveStatus: this.saveStatus,
      loading: this.loading,
      storageKind: this.storageKind,
    };
  }

  getNotes(): readonly IndexedNote[] {
    return this.indexed;
  }

  getVisible(): readonly IndexedNote[] {
    return this.visible;
  }

  getFilter(): NotesFilter {
    return this.filter;
  }

  getSelectedId(): string | null {
    return this.selectedId;
  }

  getSelectedNote(): Note | null {
    return this.findNote(this.selectedId);
  }

  getSaveStatus(): SaveStatus {
    return this.saveStatus;
  }

  /** Monotonic counter bumped on every change to the note set. */
  getGeneration(): number {
    return this.generation;
  }

  isFiltering(): boolean {
    return this.filter.search.trim().length > 0 || this.filter.color !== "all" || this.filter.format !== "all";
  }

  /** O(1) note lookup via a map rebuilt only when the note set changes. */
  private findNote(id: string | null): Note | null {
    if (id === null) return null;
    return this.noteIndex.get(id) ?? null;
  }

  // ------------------------------------------------------------------- filters

  setSearch(search: string): void {
    if (this.filter.search === search) return;
    this.filter = { ...this.filter, search };
    this.recomputeVisible();
    this.emit({ type: "filter" });
    this.emit({ type: "visible" });
  }

  setColorFilter(color: ColorFilter): void {
    if (this.filter.color === color) return;
    this.filter = { ...this.filter, color };
    this.recomputeVisible();
    this.emit({ type: "filter" });
    this.emit({ type: "visible" });
  }

  setFormatFilter(format: NoteFormat | "all"): void {
    if (this.filter.format === format) return;
    this.filter = { ...this.filter, format };
    this.recomputeVisible();
    this.emit({ type: "filter" });
    this.emit({ type: "visible" });
  }

  setSort(sort: SortKey): void {
    if (!isSortKey(sort) || this.filter.sort === sort) return;
    this.filter = { ...this.filter, sort };
    this.recomputeVisible();
    this.emit({ type: "filter" });
    this.emit({ type: "visible" });
  }

  // ----------------------------------------------------------------- selection

  select(id: string | null): void {
    if (this.selectedId === id) return;
    // Switching notes is an autosave trigger: never lose the pending edit.
    this.flushPending();
    this.selectedId = id !== null && this.noteIndex.has(id) ? id : null;
    this.emit({ type: "selection" });
  }

  /** Select a sensible neighbour after a removal. */
  private selectNeighbourOf(id: string): void {
    const list = this.visible.length > 0 ? this.visible : this.indexed;
    const index = list.findIndex((entry) => entry.note.id === id);
    if (index === -1) {
      this.selectedId = list[0]?.note.id ?? null;
      return;
    }
    const next = list[index + 1] ?? list[index - 1] ?? null;
    this.selectedId = next?.note.id ?? null;
  }

  /**
   * Choose the initial selection on startup without ever leaving the UI broken.
   *
   * Rules, in order:
   *  1. a preferred (restored) id is used only when the note still exists AND is
   *     visible under the current filter — selecting a hidden note would look
   *     like nothing is selected;
   *  2. otherwise the first note in the current view is selected;
   *  3. with no visible notes, nothing is selected.
   *
   * Returns the id that ended up selected, or null.
   */
  selectInitial(preferredId: string | null = null): string | null {
    const isVisible = (id: string): boolean => this.visible.some((entry) => entry.note.id === id);

    if (preferredId !== null && this.noteIndex.has(preferredId) && isVisible(preferredId)) {
      this.select(preferredId);
      return this.selectedId;
    }

    const first = this.visible[0]?.note.id ?? null;
    this.select(first);
    return this.selectedId;
  }

  // ------------------------------------------------------------------ mutation

  /**
   * Create an empty note, insert it, select it and return it. The caller is
   * expected to focus the editor immediately.
   */
  async createNote(partial: Partial<Note> = {}): Promise<Note> {
    const note = createNote({ format: "plain", ...partial });
    this.notes = [note, ...this.notes];
    this.noteIndex.set(note.id, note);
    this.indexed = [indexNote(note), ...this.indexed];
    this.recomputeVisible();

    // A brand new note must be visible even if a filter is active; otherwise the
    // user would type into an invisible note.
    if (!this.visible.some((entry) => entry.note.id === note.id)) {
      if (this.filter.search.trim().length > 0) this.filter = { ...this.filter, search: "" };
      if (this.filter.color !== "all") this.filter = { ...this.filter, color: "all" };
      if (this.filter.format !== "all") this.filter = { ...this.filter, format: "all" };
      this.recomputeVisible();
      this.emit({ type: "filter" });
    }

    this.selectedId = note.id;
    this.generation += 1;
    this.emit({ type: "notes" });
    this.emit({ type: "visible" });
    this.emit({ type: "selection" });

    try {
      await this.repository.create(note);
    } catch (error) {
      this.reportError(error, "save");
    }
    return note;
  }

  /**
   * Apply a change to a note, updating the list immediately and persisting after
   * the debounce. Bumps `updatedAt`/`revision` exactly once per real change.
   */
  updateNote(
    id: string,
    change: Partial<Pick<Note, "content" | "format" | "color">>
  ): Note | null {
    const current = this.noteIndex.get(id);
    if (!current) return null;

    const next = applyNoteChange(current, change, this.now());
    if (next === current) return current; // no-op

    this.replaceNote(next);
    this.dirty.set(next.id, next);
    this.setSaveStatus("saving");
    this.autosave.schedule(next);
    return next;
  }

  /** Update the content of the currently selected note. */
  updateSelected(change: Partial<Pick<Note, "content" | "format" | "color">>): Note | null {
    if (this.selectedId === null) return null;
    return this.updateNote(this.selectedId, change);
  }

  /** Replace a note in all derived structures, keeping sort/filter consistent. */
  private replaceNote(note: Note): void {
    this.noteIndex.set(note.id, note);

    const noteIndex = this.notes.findIndex((item) => item.id === note.id);
    if (noteIndex === -1) this.notes = [note, ...this.notes];
    else this.notes = replaceAt(this.notes, noteIndex, note);

    const indexedIndex = this.indexed.findIndex((entry) => entry.note.id === note.id);
    const entry = indexNote(note);
    if (indexedIndex === -1) this.indexed = [entry, ...this.indexed];
    else this.indexed = replaceAt(this.indexed, indexedIndex, entry);

    this.recomputeVisible();
    this.generation += 1;
    this.emit({ type: "notes" });
    this.emit({ type: "visible" });
  }

  async deleteNote(id: string): Promise<void> {
    const existed = this.noteIndex.has(id);
    if (!existed) return;

    // Drop any pending write: the record is about to disappear.
    this.dirty.delete(id);
    this.autosave.cancel();

    this.notes = this.notes.filter((note) => note.id !== id);
    this.indexed = this.indexed.filter((entry) => entry.note.id !== id);
    this.noteIndex.delete(id);
    const wasSelected = this.selectedId === id;
    if (wasSelected) this.selectNeighbourOf(id);
    this.recomputeVisible();
    this.generation += 1;
    this.emit({ type: "notes" });
    this.emit({ type: "visible" });
    if (wasSelected) this.emit({ type: "selection" });

    try {
      await this.repository.delete(id);
      this.setSaveStatus("saved");
    } catch (error) {
      this.reportError(error, "delete");
    }
  }

  // ----------------------------------------------------------------- autosave

  private setSaveStatus(status: SaveStatus): void {
    if (this.saveStatus === status) return;
    this.saveStatus = status;
    this.emit({ type: "save-status" });
  }

  private async persist(note: Note): Promise<void> {
    const pending = this.dirty.get(note.id);
    if (!pending) return; // already written, or the note was deleted
    this.dirty.delete(note.id);
    this.setSaveStatus("saving");
    try {
      await this.repository.update(pending);
      // Only report "saved" when nothing newer is queued.
      if (this.dirty.size === 0) this.setSaveStatus("saved");
    } catch (error) {
      this.dirty.set(pending.id, pending);
      this.setSaveStatus("error");
      this.reportError(error, "save");
    }
  }

  /** Write every pending change immediately (note switch, unload, hide). */
  flushPending(): void {
    if (this.dirty.size === 0) return;
    if (this.autosave.pending) {
      // Let the debounced write run now, with its already-captured note. Starting
      // a second write for the same note here would double-write the record.
      this.autosave.flush();
      return;
    }
    const pending = [...this.dirty.values()];
    this.dirty.clear();
    for (const note of pending) {
      void this.repository
        .update(note)
        .then(() => {
          if (this.dirty.size === 0) this.setSaveStatus("saved");
        })
        .catch((error) => {
          this.dirty.set(note.id, note);
          this.setSaveStatus("error");
          this.reportError(error, "save");
        });
    }
  }

  /** Stop timers; used when the page is torn down (tests especially). */
  dispose(): void {
    this.autosave.cancel();
    this.listeners.clear();
  }

  private reindex(): void {
    this.indexed = indexedNotes(this.notes);
    this.noteIndex = new Map(this.notes.map((note) => [note.id, note]));
    this.recomputeVisible();
    // Keep the selection valid.
    if (this.selectedId !== null && !this.noteIndex.has(this.selectedId)) {
      this.selectedId = null;
    }
  }

  private recomputeVisible(): void {
    // `selectNotes` sorts a copy, so the visible order always reflects the notes'
    // current timestamps — an edit that changes `updatedAt` reorders the list.
    this.visible = selectNotes(this.indexed, this.filter);
    if (this.selectedId !== null && !this.noteIndex.has(this.selectedId)) {
      this.selectedId = null;
    }
  }
}
