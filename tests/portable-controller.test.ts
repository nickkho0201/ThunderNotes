import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Note } from "../src/notes/model.ts";
import { toPortableNote } from "../src/portable/codec.ts";
import {
  commitConfirmedImport,
  createImportPreview,
} from "../src/portable/import-controller.ts";
import { PORTABLE_DATA_FORMAT, PORTABLE_DATA_VERSION, type PortableDataV1 } from "../src/portable/types.ts";
import { MemoryNotesRepository } from "../src/storage/memory.ts";
import { NoteStore, StoreMutationLockedError } from "../src/ui/store.ts";
import { note } from "./helpers.ts";

class TrackingRepository extends MemoryNotesRepository {
  replaceCalls = 0;
  updateFailure: Error | null = null;
  replaceFailure: Error | null = null;
  updateGate: Promise<void> | null = null;

  override async update(value: Note): Promise<void> {
    if (this.updateGate) await this.updateGate;
    if (this.updateFailure) throw this.updateFailure;
    await super.update(value);
  }

  override async replaceAll(values: readonly Note[]): Promise<void> {
    this.replaceCalls += 1;
    if (this.replaceFailure) throw this.replaceFailure;
    await super.replaceAll(values);
  }
}

function backup(notes: Note[]): PortableDataV1 {
  return {
    format: PORTABLE_DATA_FORMAT,
    formatVersion: PORTABLE_DATA_VERSION,
    exportedAt: "2026-01-02T03:04:05.000Z",
    appVersion: "0.1.5",
    notes: notes.map(toPortableNote),
  };
}

async function setup(seed: Note[]) {
  const repository = new TrackingRepository();
  await repository.putMany(seed);
  const store = new NoteStore(repository, { autosaveDelayMs: 60_000 });
  await store.init();
  return { repository, store };
}

describe("portable import controller: authoritative confirmation", () => {
  it("commits once when the authoritative plan is unchanged", async () => {
    const { repository, store } = await setup([note({ id: "local" })]);
    const preview = createImportPreview(store, backup([note({ id: "new" })]), "merge", "keep-both");
    const result = await commitConfirmedImport(store, preview);
    assert.equal(result.status, "committed");
    assert.equal(repository.replaceCalls, 1);
    assert.deepEqual((await repository.getAll()).map((entry) => entry.id).sort(), ["local", "new"]);
  });

  it("preserves filters and a still-visible selection across replacement", async () => {
    const { store } = await setup([
      note({ id: "selected", content: "match", color: "blue" }),
      note({ id: "other", content: "match", color: "blue" }),
    ]);
    store.setSearch("match");
    store.setColorFilter("blue");
    store.setSort("updated-asc");
    store.select("selected");
    const data = backup([
      note({ id: "selected", content: "match", color: "blue" }),
      note({ id: "replacement", content: "match", color: "blue" }),
    ]);
    const result = await commitConfirmedImport(
      store,
      createImportPreview(store, data, "restore", "keep-both"),
    );
    assert.equal(result.status, "committed");
    assert.equal(store.getSelectedId(), "selected");
    assert.deepEqual(store.getFilter(), {
      search: "match",
      createdFrom: "",
      createdTo: "",
      color: "blue",
      colors: ["blue"],
      favoriteOnly: false,
      format: "all",
      sort: "updated-asc",
    });
  });

  it("selects the first visible note, or null, when the old selection disappears", async () => {
    const visible = await setup([note({ id: "old" })]);
    visible.store.select("old");
    const visibleData = backup([note({ id: "new", content: "visible" })]);
    await commitConfirmedImport(
      visible.store,
      createImportPreview(visible.store, visibleData, "restore", "keep-both"),
    );
    assert.equal(visible.store.getSelectedId(), "new");

    const hidden = await setup([note({ id: "old" })]);
    hidden.store.select("old");
    hidden.store.setSearch("does not match");
    const hiddenData = backup([note({ id: "new", content: "hidden" })]);
    await commitConfirmedImport(
      hidden.store,
      createImportPreview(hidden.store, hiddenData, "restore", "keep-both"),
    );
    assert.equal(hidden.store.getSelectedId(), null);
  });

  it("does not commit a stale preview after local create, update or delete", async () => {
    for (const mutation of ["create", "update", "delete"] as const) {
      const { repository, store } = await setup([
        note({ id: "local", content: "before" }),
        note({ id: "delete-me" }),
      ]);
      const data = backup([note({ id: "imported" })]);
      const preview = createImportPreview(store, data, "merge", "keep-both");
      if (mutation === "create") await store.createNote({ id: "created" });
      if (mutation === "update") store.updateNote("local", { content: "after" });
      if (mutation === "delete") await store.deleteNote("delete-me");
      const result = await commitConfirmedImport(store, preview);
      assert.equal(result.status, "changed", mutation);
      assert.equal(repository.replaceCalls, 0, mutation);
      assert.equal(store.isMutationLocked(), false, mutation);
    }
  });

  it("requires refreshed confirmation even when counts stay the same, then succeeds", async () => {
    const { repository, store } = await setup([note({ id: "x", content: "local 1" })]);
    const data = backup([note({ id: "x", content: "imported" })]);
    const preview = createImportPreview(store, data, "merge", "keep-both");
    store.updateNote("x", { content: "local 2" });
    const stale = await commitConfirmedImport(store, preview, () => "clone");
    assert.equal(stale.status, "changed");
    assert.equal(repository.replaceCalls, 0);
    if (stale.status !== "changed") return;
    assert.deepEqual(
      [stale.plan.newCount, stale.plan.conflictCount],
      [preview.newCount, preview.conflictCount],
    );
    const committed = await commitConfirmedImport(store, stale.plan, () => "clone");
    assert.equal(committed.status, "committed");
    assert.equal(repository.replaceCalls, 1);
  });

  it("handles repeated races without mutation", async () => {
    const { repository, store } = await setup([note({ id: "x", content: "0" })]);
    let preview = createImportPreview(store, backup([note({ id: "new" })]), "merge", "keep-both");
    for (let index = 1; index <= 2; index += 1) {
      store.updateNote("x", { content: String(index) });
      const result = await commitConfirmedImport(store, preview);
      assert.equal(result.status, "changed");
      if (result.status === "changed") preview = result.plan;
    }
    assert.equal(repository.replaceCalls, 0);
  });

  it("marks restore safety acknowledgement stale when the plan changes", async () => {
    const { store } = await setup([note({ id: "x", content: "before" })]);
    const preview = createImportPreview(store, backup([note({ id: "restored" })]), "restore", "keep-both");
    store.updateNote("x", { content: "after" });
    const result = await commitConfirmedImport(store, preview);
    assert.equal(result.status, "changed");
    if (result.status === "changed") assert.equal(result.safetyBackupInvalidated, true);
  });

  it("blocks import when the write barrier fails and preserves rescue-export state", async () => {
    const { repository, store } = await setup([note({ id: "x", content: "before" })]);
    const preview = createImportPreview(store, backup([note({ id: "new" })]), "merge", "keep-both");
    store.updateNote("x", { content: "unsaved rescue" });
    repository.updateFailure = new Error("storage unavailable");
    await assert.rejects(() => commitConfirmedImport(store, preview), /storage unavailable/);
    assert.equal(repository.replaceCalls, 0);
    assert.equal(store.getNoteSnapshot().find((entry) => entry.id === "x")?.content, "unsaved rescue");
    assert.equal(store.isMutationLocked(), false);
  });

  it("keeps Store state unchanged when atomic replacement fails", async () => {
    const { repository, store } = await setup([note({ id: "old" })]);
    const preview = createImportPreview(store, backup([note({ id: "new" })]), "restore", "keep-both");
    repository.replaceFailure = new Error("replace failed");
    await assert.rejects(() => commitConfirmedImport(store, preview), /replace failed/);
    assert.deepEqual(store.getNoteSnapshot().map((entry) => entry.id), ["old"]);
    assert.deepEqual((await repository.getAll()).map((entry) => entry.id), ["old"]);
  });

  it("blocks ordinary mutations during the commit window and releases the lock", async () => {
    const { repository, store } = await setup([note({ id: "old" })]);
    let releaseUpdate!: () => void;
    repository.updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    store.updateNote("old", { content: "dirty" });
    const preview = createImportPreview(store, backup([note({ id: "new" })]), "merge", "keep-both");
    const committing = commitConfirmedImport(store, preview);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await assert.rejects(() => store.createNote(), StoreMutationLockedError);
    assert.throws(() => store.updateNote("old", { content: "blocked" }), StoreMutationLockedError);
    releaseUpdate();
    const result = await committing;
    assert.equal(result.status, "committed");
    assert.equal(store.isMutationLocked(), false);
  });
});
