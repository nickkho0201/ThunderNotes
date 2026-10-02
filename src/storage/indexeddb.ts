/**
 * IndexedDB-backed notes repository.
 *
 * Chosen over `storage.local` because ThunderNotes targets thousands of small
 * notes and needs indexed, non-whole-file reads/writes. The API is a plain
 * `NotesRepository`, so the UI stays backend-agnostic.
 *
 * Notes are stored as individual records keyed by `id` (never as one big blob),
 * so a write touches exactly one record.
 */

import { CURRENT_SCHEMA_VERSION, normalizeNote } from "../notes/model";
import type { Note } from "../notes/model";
import type { NotesRepository, NotesRepositoryInfo } from "./repository";
import { migrationsBetween } from "./migrations";
import { MemoryNotesRepository } from "./memory";
import { primaryMessage, primaryOwner } from "../messages/locator";

export { MemoryNotesRepository };

export const DB_NAME = "thundernotes";
export const DB_VERSION = 1;

const STORE_NOTES = "notes";
const STORE_META = "meta";
const META_SCHEMA_VERSION = "schemaVersion";

interface MetaRecord {
  key: string;
  value: unknown;
}

/** Minimal IDB surface we rely on, to keep this file readable. */
type StoreName = typeof STORE_NOTES | typeof STORE_META;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/**
 * IndexedDB-backed repository.
 *
 * The in-memory fallback lives in `./memory.ts`.
 */
export class IndexedDbNotesRepository implements NotesRepository {
  readonly info: NotesRepositoryInfo = {
    kind: "indexeddb",
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };

  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly indexedDBFactory: IDBFactory | undefined = globalThis.indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (!this.indexedDBFactory) {
        reject(new Error("IndexedDB is not available in this context"));
        return;
      }

      const request = this.indexedDBFactory.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        const tx = request.transaction;
        const oldVersion = event.oldVersion;

        if (!db.objectStoreNames.contains(STORE_NOTES)) {
          const store = db.createObjectStore(STORE_NOTES, { keyPath: "id" });
          store.createIndex("byCreatedAt", "createdAt");
          store.createIndex("byUpdatedAt", "updatedAt");
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "key" });
        }

        if (!tx) return;

        // Read the version recorded by the previous build. Falls back to
        // `oldVersion`, which is what a brand-new database reports (0).
        const metaStore = tx.objectStore(STORE_META);
        const versionRequest = oldVersion === 0 ? null : metaStore.get(META_SCHEMA_VERSION);

        const runMigrations = (recordedVersion: number) => {
          if (recordedVersion >= CURRENT_SCHEMA_VERSION) return;
          const notesStore = tx.objectStore(STORE_NOTES);
          const allRequest = notesStore.getAll();
          allRequest.onsuccess = () => {
            let raw = allRequest.result as unknown[];
            for (const migration of migrationsBetween(recordedVersion, CURRENT_SCHEMA_VERSION)) {
              migration.run({
                readAll: () => raw,
                writeAll: (notes) => {
                  raw = notes;
                },
              });
              console.info(`[ThunderNotes] migration ${migration.from}->${migration.to}`);
            }
            // Rewrite normalised records (and drop the unreadable ones).
            notesStore.clear();
            for (const item of raw) {
              const note = normalizeNote(item);
              if (note) notesStore.put(note);
            }
            metaStore.put({ key: META_SCHEMA_VERSION, value: CURRENT_SCHEMA_VERSION } satisfies MetaRecord);
          };
          allRequest.onerror = () => {
            console.error("[ThunderNotes] failed to read notes during migration", allRequest.error);
            tx.abort();
          };
        };

        if (versionRequest) {
          versionRequest.onsuccess = () => {
            const record = versionRequest.result as MetaRecord | undefined;
            const recorded =
              record && typeof record.value === "number" ? record.value : (oldVersion as number);
            runMigrations(recorded);
          };
          versionRequest.onerror = () => runMigrations(oldVersion as number);
        } else {
          runMigrations(0);
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        // Another context (or a future build) wants to upgrade: step aside.
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        this.dbPromise = null;
        reject(request.error ?? new Error("Failed to open IndexedDB"));
      };
      request.onblocked = () => {
        console.warn("[ThunderNotes] IndexedDB upgrade blocked by another open connection");
      };
    });

    return this.dbPromise;
  }

  private async transaction<T>(
    storeNames: StoreName[],
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction) => Promise<T> | T
  ): Promise<T> {
    const db = await this.open();
    const tx = db.transaction(storeNames, mode);
    const done = transactionDone(tx);
    try {
      const result = await work(tx);
      await done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // The transaction may already have aborted or completed.
      }
      await done.catch(() => undefined);
      throw error;
    }
  }

  async getAll(): Promise<Note[]> {
    return this.transaction([STORE_NOTES], "readonly", async (tx) => {
      const store = tx.objectStore(STORE_NOTES);
      const rows = await requestToPromise(store.getAll() as IDBRequest<unknown[]>);
      const notes: Note[] = [];
      let skipped = 0;
      for (const row of rows) {
        const note = normalizeNote(row);
        if (note) notes.push(note);
        else skipped += 1;
      }
      if (skipped > 0) {
        console.warn(`[ThunderNotes] skipped ${skipped} unreadable note record(s)`);
      }
      return notes;
    });
  }

  async get(id: string): Promise<Note | null> {
    return this.transaction([STORE_NOTES], "readonly", async (tx) => {
      const store = tx.objectStore(STORE_NOTES);
      const row = await requestToPromise(store.get(id) as IDBRequest<unknown>);
      return normalizeNote(row);
    });
  }

  async create(note: Note): Promise<void> {
    await this.transaction([STORE_NOTES], "readwrite", (tx) => {
      tx.objectStore(STORE_NOTES).add(note);
    });
  }

  async createForMessage(note: Note): Promise<{ note: Note; created: boolean }> {
    const reference = primaryMessage(note);
    if (!reference) throw new Error("Primary message required");
    return this.transaction([STORE_NOTES], "readwrite", async tx => {
      const store = tx.objectStore(STORE_NOTES);
      const rows = await requestToPromise(store.getAll() as IDBRequest<unknown[]>);
      const notes = rows.map(normalizeNote).filter((note): note is Note => note !== null);
      const owner = primaryOwner(notes, reference.locator);
      if (owner) return { note: owner, created: false };
      await requestToPromise(store.add(note));
      return { note, created: true };
    });
  }

  async update(note: Note): Promise<void> {
    await this.transaction([STORE_NOTES], "readwrite", (tx) => {
      tx.objectStore(STORE_NOTES).put(note);
    });
  }

  async delete(id: string): Promise<void> {
    await this.transaction([STORE_NOTES], "readwrite", (tx) => {
      tx.objectStore(STORE_NOTES).delete(id);
    });
  }

  async putMany(notes: Note[]): Promise<void> {
    await this.transaction([STORE_NOTES], "readwrite", (tx) => {
      const store = tx.objectStore(STORE_NOTES);
      for (const note of notes) store.put(note);
    });
  }

  async replaceAll(notes: readonly Note[]): Promise<void> {
    await this.transaction([STORE_NOTES, STORE_META], "readwrite", (tx) => {
      const notesStore = tx.objectStore(STORE_NOTES);
      notesStore.clear();
      for (const note of notes) notesStore.put(note);
      tx.objectStore(STORE_META).put({
        key: META_SCHEMA_VERSION,
        value: CURRENT_SCHEMA_VERSION,
      } satisfies MetaRecord);
    });
  }

  async clear(): Promise<void> {
    await this.transaction([STORE_NOTES, STORE_META], "readwrite", (tx) => {
      tx.objectStore(STORE_NOTES).clear();
      tx.objectStore(STORE_META).put({
        key: META_SCHEMA_VERSION,
        value: CURRENT_SCHEMA_VERSION,
      } satisfies MetaRecord);
    });
  }
}

/**
 * Open the best available backend. Falls back to memory (never throws) so the
 * UI always has something to talk to.
 */
export async function openNotesRepository(): Promise<NotesRepository> {
  try {
    const repo = new IndexedDbNotesRepository();
    // Force the connection open now so failures surface here, not later.
    await repo.getAll();
    return repo;
  } catch (error) {
    console.error("[ThunderNotes] IndexedDB unavailable, falling back to in-memory storage", error);
    return new MemoryNotesRepository();
  }
}
