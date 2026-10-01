import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FILTER, createdDateRange, localDateStart, selectNotesFromNotes } from "../src/notes/query.ts";
import { NoteStore } from "../src/ui/store.ts";
import { MemoryNotesRepository } from "../src/storage/memory.ts";
import { ids, note } from "./helpers.ts";

describe("created date range", () => {
  const start = new Date(2026, 8, 1).getTime(), end = new Date(2026, 9, 1).getTime();
  const notes = [note({ id: "before", createdAt: start - 1 }), note({ id: "first", createdAt: start }),
    note({ id: "last", createdAt: end - 1, content: "target", color: "blue", format: "markdown" }),
    note({ id: "after", createdAt: end })];
  it("supports from only", () => assert.deepEqual(ids(selectNotesFromNotes(notes, { ...DEFAULT_FILTER, sort: "created-asc", createdFrom: "2026-09-01" })), ["first", "last", "after"]));
  it("supports to only, including the entire last day", () => assert.deepEqual(ids(selectNotesFromNotes(notes, { ...DEFAULT_FILTER, sort: "created-asc", createdTo: "2026-09-30" })), ["before", "first", "last"]));
  it("supports both and exact inclusive boundaries", () => assert.deepEqual(ids(selectNotesFromNotes(notes, { ...DEFAULT_FILTER, sort: "created-asc", createdFrom: "2026-09-01", createdTo: "2026-09-30" })), ["first", "last"]));
  it("ANDs date with search/color/format and keeps createdAt independent of sorting", () => {
    assert.deepEqual(ids(selectNotesFromNotes(notes, { ...DEFAULT_FILTER, createdFrom: "2026-09-01", createdTo: "2026-09-30", search: "TARGET", color: "blue", format: "markdown", sort: "updated-asc" })), ["last"]);
  });
  it("ignores invalid ranges while keeping other filters", () => {
    assert.equal(createdDateRange("2026-10-01", "2026-09-01").valid, false);
    assert.equal(localDateStart("2026-02-30"), null);
    assert.equal(localDateStart("garbage"), null);
    assert.deepEqual(ids(selectNotesFromNotes(notes, { ...DEFAULT_FILTER, createdFrom: "2026-10-01", createdTo: "2026-09-01", search: "target" })), ["last"]);
  });
  it("uses local midnight and calendar next-day across DST", () => {
    const original = process.env.TZ;
    try {
      for (const zone of ["Europe/Moscow", "America/New_York", "UTC"]) {
        process.env.TZ = zone;
        const range = createdDateRange("2026-03-08", "2026-03-08");
        assert.equal(range.start, new Date(2026, 2, 8).getTime());
        assert.equal(range.end, new Date(2026, 2, 9).getTime());
        if (zone === "America/New_York") assert.equal(range.end - range.start, 23 * 3600000);
      }
    } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
  });
  it("resets and starts a new store/session without date filtering", async () => {
    const repository = new MemoryNotesRepository();
    await repository.putMany(notes);
    const store = new NoteStore(repository);
    await store.init();
    store.setCreatedDateRange("2026-09-01", "2026-09-30");
    assert.equal(store.getVisible().length, 2);
    store.setCreatedDateRange("", "");
    assert.equal(store.getVisible().length, 4);
    assert.equal(store.isFiltering(), false);
    store.setCreatedDateRange("2026-09-01", "2026-09-30");
    const next = new NoteStore(repository);
    await next.init();
    assert.equal(next.getVisible().length, 4);
    assert.equal(next.getFilter().createdFrom, "");
    store.dispose(); next.dispose();
  });
  it("widens an active date filter for fast capture", async () => {
    const store = new NoteStore(new MemoryNotesRepository());
    await store.init();
    store.setCreatedDateRange("2000-01-01", "2000-01-01");
    const created = await store.createNote();
    assert.equal(created.format, "plain");
    assert.equal(store.getVisible()[0]?.note.id, created.id);
    assert.equal(store.getFilter().createdFrom, "");
    store.dispose();
  });
});
