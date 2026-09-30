import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MemoryNotesRepository } from "../src/storage/memory.ts";
import type { NotesRepository } from "../src/storage/repository.ts";
import { NoteStore, createDebounced } from "../src/ui/store.ts";
import type { NoteStoreOptions } from "../src/ui/store.ts";
import { note } from "./helpers.ts";
import type { Note } from "../src/notes/model.ts";

/** Repository that records calls, to assert on persistence behaviour. */
class SpyRepository implements NotesRepository {
  readonly info = { kind: "memory", schemaVersion: 1 } as const;
  readonly created: Note[] = [];
  readonly updated: Note[] = [];
  readonly deleted: string[] = [];
  failOnWrite = false;
  private readonly notes: Note[];

  /** Notes are copied on the way in and out, like a real persistent backend. */
  constructor(seed: Note[] = []) {
    this.notes = seed.map((item) => ({ ...item }));
  }

  async getAll(): Promise<Note[]> {
    return this.notes.map((item) => ({ ...item }));
  }
  async get(id: string): Promise<Note | null> {
    const found = this.notes.find((item) => item.id === id);
    return found ? { ...found } : null;
  }
  async create(value: Note): Promise<void> {
    if (this.failOnWrite) throw new Error("write failed");
    this.created.push({ ...value });
    this.notes.push({ ...value });
  }
  async update(value: Note): Promise<void> {
    if (this.failOnWrite) throw new Error("write failed");
    this.updated.push({ ...value });
    const index = this.notes.findIndex((item) => item.id === value.id);
    if (index === -1) this.notes.push({ ...value });
    else this.notes[index] = { ...value };
  }
  async delete(id: string): Promise<void> {
    this.deleted.push(id);
    const index = this.notes.findIndex((item) => item.id === id);
    if (index !== -1) this.notes.splice(index, 1);
  }
  async putMany(values: Note[]): Promise<void> {
    for (const value of values) {
      const index = this.notes.findIndex((item) => item.id === value.id);
      if (index === -1) this.notes.push({ ...value });
      else this.notes[index] = { ...value };
    }
  }
  async clear(): Promise<void> {
    this.notes.length = 0;
  }
}

/** Let queued microtasks and the debounce timer (0 ms) settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

function makeStore(seed: Note[] = [], options: NoteStoreOptions = {}) {
  const repository = new SpyRepository(seed);
  const store = new NoteStore(repository, { autosaveDelayMs: 0, ...options });
  return { repository, store };
}

describe("store: initialisation", () => {
  it("loads existing notes and defaults to the newest-first order", async () => {
    const { store } = makeStore([
      note({ id: "old", createdAt: 1, updatedAt: 1 }),
      note({ id: "new", createdAt: 9, updatedAt: 9 }),
    ]);
    await store.init();
    assert.deepEqual(store.getVisible().map((entry) => entry.note.id), ["new", "old"]);
    assert.equal(store.getSelectedId(), null, "no note is selected until the UI asks");
    assert.equal(store.getState().loading, false);
  });

  it("survives a repository failure and reports it as a load error", async () => {
    const errors: string[] = [];
    const repository = new SpyRepository();
    repository.getAll = async () => {
      throw new Error("boom");
    };
    const store = new NoteStore(repository, {
      autosaveDelayMs: 0,
      onError: (_error, context) => errors.push(context),
    });
    await store.init();
    assert.deepEqual(errors, ["load"]);
    assert.equal(store.getNotes().length, 0);
  });
});

describe("store: create", () => {
  it("creates, selects and persists an empty note", async () => {
    const { store, repository } = makeStore();
    await store.init();
    const created = await store.createNote();

    assert.equal(store.getSelectedId(), created.id);
    assert.equal(repository.created.length, 1);
    assert.equal(repository.created[0]?.id, created.id);
    assert.equal(created.content, "");
    assert.equal(created.revision, 1);
    assert.deepEqual(store.getVisible().map((entry) => entry.note.id), [created.id]);
  });

  it("clears active filters so a brand-new note is visible", async () => {
    const { store } = makeStore([note({ id: "a", content: "alpha", color: "red", createdAt: 1 })]);
    await store.init();
    store.setSearch("nomatch");
    store.setColorFilter("blue");
    assert.equal(store.getVisible().length, 0);

    const created = await store.createNote();
    assert.equal(store.getFilter().search, "");
    assert.equal(store.getFilter().color, "all");
    assert.equal(store.isFiltering(), false);
    // The new note is first (default sort is created-desc) and the previously
    // hidden note is reachable again.
    assert.deepEqual(store.getVisible().map((entry) => entry.note.id), [created.id, "a"]);
    assert.equal(store.getSelectedId(), created.id);
  });
});

describe("store: update and autosave", () => {
  it("bumps revision and updatedAt on every real content change", async () => {
    const clock = { value: 1_000 };
    const { store, repository } = makeStore([], { now: () => clock.value });
    await store.init();
    const created = await store.createNote();

    clock.value = 2_000;
    store.updateNote(created.id, { content: "one" });
    clock.value = 3_000;
    store.updateNote(created.id, { content: "one two" });

    const current = store.getSelectedNote();
    assert.equal(current?.content, "one two");
    assert.equal(current?.revision, 3, "created at 1, then two content changes");
    assert.equal(current?.updatedAt, 3_000);

    store.flushPending();
    await settle();
    assert.equal(repository.updated.length, 1, "the debounced write is coalesced");
    assert.equal(repository.updated[0]?.content, "one two");
  });

  it("does not persist a no-op change", async () => {
    const { store, repository } = makeStore([note({ id: "a", content: "same" })]);
    await store.init();
    store.select("a");
    store.updateNote("a", { content: "same" });
    store.flushPending();
    await settle();
    assert.equal(repository.updated.length, 0);
    assert.equal(store.getSelectedNote()?.revision, 1);
  });

  it("coalesces a burst of keystrokes into a single write", async () => {
    const { store, repository } = makeStore([note({ id: "a" })], { autosaveDelayMs: 30 });
    await store.init();
    for (const text of ["h", "he", "hel", "hell", "hello"]) {
      store.updateNote("a", { content: text });
    }
    assert.equal(repository.updated.length, 0, "nothing is written before the debounce elapses");
    assert.equal(store.getSaveStatus(), "saving");

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(repository.updated.length, 1);
    assert.equal(repository.updated[0]?.content, "hello");
    assert.equal(store.getSaveStatus(), "saved");
  });

  it("coalesces a burst in the same tick even at delay 0", async () => {
    const { store, repository } = makeStore([note({ id: "a" })]);
    await store.init();
    store.select("a");
    store.updateNote("a", { content: "one" });
    store.updateNote("a", { content: "two" });
    store.updateNote("a", { content: "three" });
    // Deferred, so nothing is written yet — and therefore nothing is written twice.
    assert.equal(repository.updated.length, 0);
    assert.equal(store.getSaveStatus(), "saving");

    await settle();
    assert.equal(repository.updated.length, 1);
    assert.equal(repository.updated[0]?.content, "three");
    assert.equal(store.getSaveStatus(), "saved");
  });

  it("reports a write failure and keeps the note dirty for a retry", async () => {
    const contexts: string[] = [];
    const { store, repository } = makeStore([note({ id: "a" })], {
      onError: (_error, context) => contexts.push(context),
    });
    await store.init();
    repository.failOnWrite = true;

    store.updateNote("a", { content: "will fail" });
    await settle();
    assert.deepEqual(contexts, ["save"]);
    assert.equal(store.getSaveStatus(), "error");

    repository.failOnWrite = false;
    store.updateNote("a", { content: "will fail again" });
    await settle();
    assert.equal(repository.updated.at(-1)?.content, "will fail again");
    assert.equal(store.getSaveStatus(), "saved");
  });

  it("changes format without altering the stored content or the list order", async () => {
    const markdown = "# heading\n\n**bold**";
    const { store, repository } = makeStore([note({ id: "a", content: markdown })]);
    await store.init();
    store.select("a");
    store.updateNote("a", { format: "markdown" });
    await settle();
    assert.equal(store.getSelectedNote()?.format, "markdown");
    assert.equal(store.getSelectedNote()?.content, markdown);
    assert.equal(repository.updated[0]?.content, markdown);
  });
});

describe("store: flush on switch", () => {
  it("writes pending changes when the selection moves", async () => {
    const { store, repository } = makeStore([note({ id: "a" }), note({ id: "b", createdAt: 5 })], {
      autosaveDelayMs: 1_000,
    });
    await store.init();
    store.select("a");
    store.updateNote("a", { content: "typed then switched" });
    store.select("b");
    await settle();

    assert.equal(repository.updated.length, 1);
    assert.equal(repository.updated[0]?.id, "a");
    assert.equal(repository.updated[0]?.content, "typed then switched");
  });

  it("flushPending writes without waiting for the timer", async () => {
    const { store, repository } = makeStore([note({ id: "a" })], { autosaveDelayMs: 10_000 });
    await store.init();
    store.updateNote("a", { content: "urgent" });
    store.flushPending();
    await settle();
    assert.equal(repository.updated.length, 1);
  });
});

describe("store: selection", () => {
  it("ignores a selection for an unknown id", async () => {
    const { store } = makeStore([note({ id: "a" })]);
    await store.init();
    store.select("does-not-exist");
    assert.equal(store.getSelectedId(), null);
  });

  it("selects a neighbour after deleting the selected note", async () => {
    const { store, repository } = makeStore([
      note({ id: "a", createdAt: 1 }),
      note({ id: "b", createdAt: 2 }),
      note({ id: "c", createdAt: 3 }),
    ]);
    await store.init();
    // Default order is newest first: c, b, a.
    store.select("b");
    await store.deleteNote("b");

    assert.equal(repository.deleted[0], "b");
    assert.equal(store.getSelectedId(), "a", "falls back to the following row");
    assert.deepEqual(store.getVisible().map((entry) => entry.note.id), ["c", "a"]);
  });

  it("clears the selection when the last note is deleted", async () => {
    const { store } = makeStore([note({ id: "only" })]);
    await store.init();
    store.select("only");
    await store.deleteNote("only");
    assert.equal(store.getSelectedId(), null);
    assert.equal(store.getSelectedNote(), null);
    assert.equal(store.getVisible().length, 0);
  });

  it("does not resurrect a deleted note through a pending autosave", async () => {
    const { store, repository } = makeStore([note({ id: "a" })], { autosaveDelayMs: 30 });
    await store.init();
    store.updateNote("a", { content: "dirty" });
    await store.deleteNote("a");
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.deepEqual(repository.updated, [], "the queued write must be cancelled");
    assert.deepEqual(repository.deleted, ["a"]);
  });
});

describe("store: filtering", () => {
  /** Fresh fixture per test: notes are mutable domain objects. */
  const seed = (): Note[] => [
    note({ id: "a", content: "alpha contract", color: "blue", createdAt: 1 }),
    note({ id: "b", content: "beta invoice", color: "red", createdAt: 2 }),
    note({ id: "c", content: "gamma contract", color: null, createdAt: 3 }),
  ];

  it("applies search, colour and sort together", async () => {
    const { store } = makeStore(seed());
    await store.init();
    store.setSearch("contract");
    store.setColorFilter("blue");
    store.setSort("created-asc");
    assert.deepEqual(store.getVisible().map((entry) => entry.note.id), ["a"]);
    assert.equal(store.isFiltering(), true);
  });

  it("notifies subscribers on filter and visible changes", async () => {
    const { store } = makeStore(seed());
    await store.init();
    const events: string[] = [];
    store.subscribe((event) => events.push(event.type));
    store.setSearch("beta");
    assert.deepEqual(events, ["filter", "visible"]);
  });

  it("keeps a valid selection when filters hide it", async () => {
    const { store } = makeStore(seed());
    await store.init();
    store.select("a");
    store.setSearch("gamma");
    assert.equal(store.getSelectedId(), "a", "selection is independent of the visible list");
  });

  it("recomputes the visible list when a note's colour changes", async () => {
    const { store } = makeStore(seed());
    await store.init();
    store.setColorFilter("green");
    assert.equal(store.getVisible().length, 0);
    store.updateNote("b", { color: "green" });
    assert.deepEqual(store.getVisible().map((entry) => entry.note.id), ["b"]);
  });

  it("resorts when the update timestamp changes while sorted by update date", async () => {
    const clock = { value: 100 };
    const { store } = makeStore(seed(), { now: () => clock.value });
    await store.init();
    store.setSort("updated-desc");
    // Creation order was 1, 2, 3, so newest-first is c, b, a.
    assert.deepEqual(store.getVisible().map((entry) => entry.note.id), ["c", "b", "a"]);

    clock.value = 500;
    store.updateNote("a", { content: "alpha contract edited" });
    assert.deepEqual(store.getVisible().map((entry) => entry.note.id), ["a", "c", "b"]);
  });
});

describe("store: initial selection restore", () => {
  const seed = (): Note[] => [
    note({ id: "a", content: "alpha", color: "blue", createdAt: 1 }),
    note({ id: "b", content: "beta", color: "red", createdAt: 2 }),
    note({ id: "c", content: "gamma", color: null, createdAt: 3 }),
  ];

  it("restores a preferred id that still exists and is visible", async () => {
    const { store } = makeStore(seed());
    await store.init();
    assert.equal(store.selectInitial("b"), "b");
    assert.equal(store.getSelectedId(), "b");
  });

  it("falls back to the first visible note when the preferred id is gone", async () => {
    // The note was deleted between sessions.
    const { store } = makeStore(seed());
    await store.init();
    assert.equal(store.selectInitial("deleted-long-ago"), "c", "default order is created-newest-first");
  });

  it("falls back to the first visible note when the preferred id is nonsense", async () => {
    const { store } = makeStore(seed());
    await store.init();
    for (const value of ["", "   ", "not-a-uuid", "../etc/passwd"]) {
      store.select(null);
      assert.equal(store.selectInitial(value), "c", `input: ${JSON.stringify(value)}`);
    }
  });

  it("does not select a note that the restored filter hides", async () => {
    // `b` exists but is red; with a blue filter it is not in the list, so
    // selecting it would look like nothing is selected.
    const { store } = makeStore(seed(), { initialFilter: { color: "blue" } });
    await store.init();
    assert.deepEqual(store.getVisible().map((entry) => entry.note.id), ["a"]);
    assert.equal(store.selectInitial("b"), "a");
    assert.equal(store.getSelectedNote()?.id, "a");
  });

  it("leaves nothing selected when the restored filter matches no notes", async () => {
    const { store } = makeStore(seed(), { initialFilter: { color: "green" } });
    await store.init();
    assert.equal(store.getVisible().length, 0);
    assert.equal(store.selectInitial("a"), null);
    assert.equal(store.getSelectedNote(), null);
  });

  it("leaves nothing selected when there are no notes at all", async () => {
    const { store } = makeStore([]);
    await store.init();
    assert.equal(store.selectInitial("anything"), null);
    assert.equal(store.getSelectedId(), null);
  });

  it("honours a restored sort when falling back", async () => {
    const { store } = makeStore(seed(), { initialFilter: { sort: "created-asc" } });
    await store.init();
    assert.equal(store.selectInitial(null), "a", "oldest first means `a` is the first row");
  });

  it("honours a restored colour filter when falling back", async () => {
    const { store } = makeStore(seed(), { initialFilter: { color: "red" } });
    await store.init();
    assert.equal(store.selectInitial(null), "b");
  });

  it("is idempotent and does not emit needless selection churn", async () => {
    const { store } = makeStore(seed());
    await store.init();
    const events: string[] = [];
    store.subscribe((event) => events.push(event.type));
    assert.equal(store.selectInitial("a"), "a");
    const afterFirst = events.length;
    assert.equal(store.selectInitial("a"), "a");
    assert.equal(events.length, afterFirst, "re-selecting the same note must not re-notify");
  });
});

describe("store: subscribe", () => {
  it("isolates a throwing subscriber", async () => {
    const { store } = makeStore([note({ id: "a" })]);
    await store.init();
    let reached = false;
    store.subscribe(() => {
      throw new Error("subscriber blew up");
    });
    store.subscribe(() => {
      reached = true;
    });
    store.setSearch("x");
    assert.equal(reached, true);
  });

  it("stops notifying after unsubscribe", async () => {
    const { store } = makeStore([note({ id: "a" })]);
    await store.init();
    let count = 0;
    const unsubscribe = store.subscribe(() => {
      count += 1;
    });
    store.setSearch("x");
    const afterFirst = count;
    unsubscribe();
    store.setSearch("y");
    assert.equal(count, afterFirst);
  });
});

describe("store: createDebounced", () => {
  it("runs once with the last arguments", async () => {
    const seen: string[] = [];
    const debounced = createDebounced<[string]>((value) => seen.push(value), 10);
    debounced.schedule("a");
    debounced.schedule("b");
    assert.equal(debounced.pending, true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(seen, ["b"]);
    assert.equal(debounced.pending, false);
  });

  it("defers even at delay 0, so a following flush does not double-write", () => {
    const seen: string[] = [];
    const debounced = createDebounced<[string]>((value) => seen.push(value), 0);
    debounced.schedule("first");
    assert.deepEqual(seen, [], "the call must not run inline");
    assert.equal(debounced.pending, true);
    debounced.flush();
    assert.deepEqual(seen, ["first"]);
    assert.equal(debounced.pending, false);
  });

  it("coalesces several zero-delay schedules into one call", async () => {
    const seen: string[] = [];
    const debounced = createDebounced<[string]>((value) => seen.push(value), 0);
    debounced.schedule("a");
    debounced.schedule("b");
    debounced.schedule("c");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(seen, ["c"]);
  });

  it("cancel drops the pending call", async () => {
    const seen: string[] = [];
    const debounced = createDebounced<[string]>((value) => seen.push(value), 10);
    debounced.schedule("dropped");
    debounced.cancel();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(seen, []);
  });

  it("flush runs the pending call immediately", () => {
    const seen: string[] = [];
    const debounced = createDebounced<[string]>((value) => seen.push(value), 10_000);
    debounced.schedule("flushed");
    debounced.flush();
    assert.deepEqual(seen, ["flushed"]);
  });
});

describe("store: memory repository round-trip", () => {
  it("persists, reloads and deletes through the repository contract", async () => {
    const repository = new MemoryNotesRepository();
    const store = new NoteStore(repository, { autosaveDelayMs: 0 });
    await store.init();

    const created = await store.createNote();
    store.updateNote(created.id, { content: "persisted text", color: "purple" });
    store.flushPending();
    await settle();
    store.dispose();

    // A second store over the same repository must see the saved note.
    const reopened = new NoteStore(repository, { autosaveDelayMs: 0 });
    await reopened.init();
    const loaded = reopened.getNotes()[0]?.note;
    assert.equal(loaded?.id, created.id);
    assert.equal(loaded?.content, "persisted text");
    assert.equal(loaded?.color, "purple");

    await reopened.deleteNote(created.id);
    assert.deepEqual(await repository.getAll(), []);
    reopened.dispose();
  });
});
