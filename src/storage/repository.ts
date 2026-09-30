/**
 * Storage abstraction. The UI depends ONLY on this interface, never on
 * IndexedDB, so the physical backend can be swapped (in-memory for tests,
 * OPFS/SQLite later, a synced replica in the future) without touching UI code.
 */

import type { Note, NoteColor, NoteFormat } from "../notes/model";

export interface NotesRepository {
  /** Descriptive metadata, used by the UI to warn about a non-persistent backend. */
  readonly info: NotesRepositoryInfo;

  /** Load every note. Callers filter/sort/search in memory. */
  getAll(): Promise<Note[]>;

  get(id: string): Promise<Note | null>;

  create(note: Note): Promise<void>;

  update(note: Note): Promise<void>;

  delete(id: string): Promise<void>;

  /** Bulk insert/overwrite, used by tests and data migrations. */
  putMany(notes: Note[]): Promise<void>;

  /** Atomically replace the complete note dataset. */
  replaceAll(notes: readonly Note[]): Promise<void>;

  /** Remove everything. Used by tests; reserved for a future "reset" action. */
  clear(): Promise<void>;
}

/** Fields a caller may filter on. Kept separate from `Note` on purpose. */
export interface NoteQuery {
  search?: string;
  color?: NoteColor | "all" | "none";
  format?: NoteFormat | "all";
}

export interface NotesRepositoryInfo {
  /** e.g. "indexeddb" | "memory" */
  readonly kind: string;
  /** Persisted schema version currently in use. */
  readonly schemaVersion: number;
}
