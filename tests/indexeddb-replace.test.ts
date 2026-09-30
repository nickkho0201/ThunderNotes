import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Note } from "../src/notes/model.ts";
import { IndexedDbNotesRepository } from "../src/storage/indexeddb.ts";
import { note } from "./helpers.ts";

interface FakeDatabaseState {
  notes: Map<string, Note>;
  meta: Map<string, unknown>;
  transactions: number;
}

function fakeDatabase(state: FakeDatabaseState, failId: string | null): IDBDatabase {
  return {
    transaction(storeNames: string | string[], mode: IDBTransactionMode): IDBTransaction {
      assert.equal(mode, "readwrite");
      assert.deepEqual(storeNames, ["notes", "meta"]);
      state.transactions += 1;
      const stagedNotes = new Map(state.notes);
      const stagedMeta = new Map(state.meta);
      let failed = false;
      let aborted = false;
      const tx = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore(name: string) {
          if (name === "notes") {
            return {
              clear() {
                stagedNotes.clear();
                return {};
              },
              put(value: Note) {
                if (value.id === failId) failed = true;
                else stagedNotes.set(value.id, { ...value });
                return {};
              },
            };
          }
          return {
            put(value: { key: string; value: unknown }) {
              stagedMeta.set(value.key, value.value);
              return {};
            },
          };
        },
        abort() {
          aborted = true;
        },
      } as unknown as IDBTransaction;
      setTimeout(() => {
        if (failed || aborted) {
          tx.onabort?.(new Event("abort"));
          return;
        }
        state.notes = stagedNotes;
        state.meta = stagedMeta;
        tx.oncomplete?.(new Event("complete"));
      }, 0);
      return tx;
    },
  } as unknown as IDBDatabase;
}

function repositoryWithDatabase(db: IDBDatabase): IndexedDbNotesRepository {
  const repository = new IndexedDbNotesRepository(undefined);
  (repository as unknown as { dbPromise: Promise<IDBDatabase> }).dbPromise = Promise.resolve(db);
  return repository;
}

describe("IndexedDB atomic dataset replacement", () => {
  it("uses one transaction for clear, all puts and schema metadata", async () => {
    const state: FakeDatabaseState = {
      notes: new Map([["old", note({ id: "old" })]]),
      meta: new Map(),
      transactions: 0,
    };
    const repository = repositoryWithDatabase(fakeDatabase(state, null));
    await repository.replaceAll([note({ id: "a" }), note({ id: "b" })]);
    assert.equal(state.transactions, 1);
    assert.deepEqual([...state.notes.keys()], ["a", "b"]);
    assert.equal(state.meta.get("schemaVersion"), 1);
  });

  it("rolls back the whole transaction when an intermediate put fails", async () => {
    const state: FakeDatabaseState = {
      notes: new Map([["old", note({ id: "old" })]]),
      meta: new Map([["schemaVersion", 1]]),
      transactions: 0,
    };
    const repository = repositoryWithDatabase(fakeDatabase(state, "bad"));
    await assert.rejects(() =>
      repository.replaceAll([
        note({ id: "first" }),
        note({ id: "bad" }),
        note({ id: "after-bad" }),
      ]),
    );
    assert.equal(state.transactions, 1);
    assert.deepEqual([...state.notes.keys()], ["old"]);
  });
});
