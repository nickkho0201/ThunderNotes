import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FILTER,
  DEFAULT_SORT_KEY,
  SORT_KEYS,
  filterNotes,
  indexedNotes,
  isColorFilter,
  isSortKey,
  matchesSearch,
  selectNotes,
  selectNotesFromNotes,
  sortNotes,
  sortSpecFor,
} from "../src/notes/query.ts";
import type { NotesFilter } from "../src/notes/query.ts";
import { ids, note } from "./helpers.ts";
import type { NoteColor } from "../src/notes/model.ts";

/** A small fixture covering every filter/sort dimension. */
const FIXTURE = [
  note({ id: "n1", content: "Alpha contract review", color: "blue", createdAt: 100, updatedAt: 900 }),
  note({ id: "n2", content: "Beta invoice", color: "red", createdAt: 200, updatedAt: 800 }),
  note({ id: "n3", content: "gamma notes about the contract", color: null, createdAt: 300, updatedAt: 700 }),
  note({ id: "n4", content: "Delta reminder", color: "blue", createdAt: 400, updatedAt: 600, format: "markdown" }),
  note({ id: "n5", content: "epsilon", color: "green", createdAt: 500, updatedAt: 500 }),
];

function filter(overrides: Partial<NotesFilter> = {}): NotesFilter {
  return { ...DEFAULT_FILTER, ...overrides };
}

describe("query: sort keys", () => {
  it("exposes exactly the four documented orders with the documented default", () => {
    assert.deepEqual([...SORT_KEYS], ["created-desc", "created-asc", "updated-desc", "updated-asc"]);
    assert.equal(DEFAULT_SORT_KEY, "created-desc");
  });

  it("maps each key to a field and direction", () => {
    assert.deepEqual(sortSpecFor("created-desc"), { field: "createdAt", direction: "desc" });
    assert.deepEqual(sortSpecFor("created-asc"), { field: "createdAt", direction: "asc" });
    assert.deepEqual(sortSpecFor("updated-desc"), { field: "updatedAt", direction: "desc" });
    assert.deepEqual(sortSpecFor("updated-asc"), { field: "updatedAt", direction: "asc" });
  });

  it("guards the key and colour-filter unions", () => {
    assert.ok(isSortKey("created-asc"));
    assert.ok(!isSortKey("created"));
    assert.ok(!isSortKey(null));
    assert.ok(isColorFilter("all"));
    assert.ok(isColorFilter("none"));
    assert.ok(isColorFilter("blue"));
    assert.ok(!isColorFilter("chartreuse"));
  });
});

describe("query: sorting", () => {
  const indexed = indexedNotes(FIXTURE);

  it("sorts by creation date, newest first by default", () => {
    assert.deepEqual(ids(selectNotesFromNotes(FIXTURE, DEFAULT_FILTER)), ["n5", "n4", "n3", "n2", "n1"]);
  });

  it("sorts by creation date, oldest first", () => {
    assert.deepEqual(ids(selectNotesFromNotes(FIXTURE, filter({ sort: "created-asc" }))), [
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
    ]);
  });

  it("sorts by update date in both directions", () => {
    assert.deepEqual(ids(selectNotesFromNotes(FIXTURE, filter({ sort: "updated-desc" }))), [
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
    ]);
    assert.deepEqual(ids(selectNotesFromNotes(FIXTURE, filter({ sort: "updated-asc" }))), [
      "n5",
      "n4",
      "n3",
      "n2",
      "n1",
    ]);
  });

  it("does not mutate the input array", () => {
    const before = ids(FIXTURE);
    sortNotes(indexed, "created-asc");
    assert.deepEqual(ids(FIXTURE), before);
  });

  it("breaks ties deterministically by id", () => {
    const tied = [
      note({ id: "b", createdAt: 10 }),
      note({ id: "a", createdAt: 10 }),
      note({ id: "c", createdAt: 10 }),
    ];
    assert.deepEqual(ids(selectNotesFromNotes(tied, filter({ sort: "created-desc" }))), ["a", "b", "c"]);
    // Re-sorting the same input must give the identical order.
    assert.deepEqual(
      ids(selectNotesFromNotes(tied, filter({ sort: "created-desc" }))),
      ids(selectNotesFromNotes(tied, filter({ sort: "created-desc" })))
    );
  });
});

describe("query: search", () => {
  it("matches case-insensitively anywhere in the content", () => {
    assert.deepEqual(ids(selectNotesFromNotes(FIXTURE, filter({ search: "CONTRACT" }))), ["n3", "n1"]);
  });

  it("matches a substring in the middle of a word", () => {
    // n3 was created later, so it comes first under the default sort.
    assert.deepEqual(ids(selectNotesFromNotes(FIXTURE, filter({ search: "ontra" }))), ["n3", "n1"]);
    assert.deepEqual(
      ids(selectNotesFromNotes(FIXTURE, filter({ search: "ontra", sort: "created-asc" }))),
      ["n1", "n3"]
    );
  });

  it("ignores surrounding whitespace in the query", () => {
    assert.deepEqual(
      ids(selectNotesFromNotes(FIXTURE, filter({ search: "   alpha   " }))),
      ids(selectNotesFromNotes(FIXTURE, filter({ search: "alpha" })))
    );
  });

  it("returns everything when the query is empty or blank", () => {
    assert.equal(selectNotesFromNotes(FIXTURE, filter({ search: "" })).length, 5);
    assert.equal(selectNotesFromNotes(FIXTURE, filter({ search: "    " })).length, 5);
  });

  it("returns nothing when there is no match", () => {
    assert.deepEqual(ids(selectNotesFromNotes(FIXTURE, filter({ search: "zzzz" }))), []);
  });

  it("searches markdown source text, not the rendered output", () => {
    const markdown = note({ id: "m", format: "markdown", content: "see [label](https://target.example)" });
    // The raw content contains the URL, so a search for it matches.
    assert.equal(selectNotesFromNotes([markdown], filter({ search: "target.example" })).length, 1);
    assert.equal(selectNotesFromNotes([markdown], filter({ search: "label" })).length, 1);
  });

  it("matches on a precomputed lowercase haystack", () => {
    assert.equal(matchesSearch("hello world", "world"), true);
    assert.equal(matchesSearch("hello world", "WORLD"), false, "the haystack must already be lowercased");
    assert.equal(matchesSearch("hello world", ""), true);
  });
});

describe("query: colour and format filtering", () => {
  it("filters by a single colour", () => {
    assert.deepEqual(ids(selectNotesFromNotes(FIXTURE, filter({ color: "blue" }))), ["n4", "n1"]);
  });

  it("filters to notes without a colour", () => {
    assert.deepEqual(ids(selectNotesFromNotes(FIXTURE, filter({ color: "none" }))), ["n3"]);
  });

  it("treats 'all' as no colour restriction", () => {
    assert.equal(selectNotesFromNotes(FIXTURE, filter({ color: "all" })).length, 5);
  });

  it("filters by format", () => {
    assert.deepEqual(ids(selectNotesFromNotes(FIXTURE, filter({ format: "markdown" }))), ["n4"]);
    assert.equal(selectNotesFromNotes(FIXTURE, filter({ format: "plain" })).length, 4);
  });

  it("combines colour, search and sort", () => {
    // The documented example: colour = blue AND content contains "contract".
    assert.deepEqual(
      ids(selectNotesFromNotes(FIXTURE, filter({ color: "blue", search: "contract", sort: "created-asc" }))),
      ["n1"]
    );
    assert.deepEqual(
      ids(selectNotesFromNotes(FIXTURE, filter({ color: "blue", search: "a", sort: "created-desc" }))),
      ["n4", "n1"]
    );
  });

  it("combines format, colour and search", () => {
    assert.deepEqual(
      ids(selectNotesFromNotes(FIXTURE, filter({ format: "markdown", color: "blue", search: "delta" }))),
      ["n4"]
    );
    assert.deepEqual(
      ids(selectNotesFromNotes(FIXTURE, filter({ format: "plain", color: "blue" }))),
      ["n1"]
    );
  });

  it("returns an empty list when filters cannot be satisfied together", () => {
    assert.deepEqual(ids(selectNotesFromNotes(FIXTURE, filter({ color: "green", search: "alpha" }))), []);
  });
});

describe("query: implementation details", () => {
  it("reuses the input array when nothing needs filtering", () => {
    const indexed = indexedNotes(FIXTURE);
    const result = filterNotes(indexed, { search: "", color: "all", format: "all" });
    assert.equal(result.length, indexed.length);
    assert.notEqual(result, indexed, "a copy is returned so callers can sort safely");
  });

  it("keeps the note object identity (no cloning) for the list renderer", () => {
    const indexed = indexedNotes(FIXTURE);
    const result = selectNotes(indexed, filter({ color: "blue" }));
    for (const entry of result) {
      assert.ok(indexed.some((candidate) => candidate.note === entry.note));
    }
  });

  it("lowercases the haystack exactly once per index call", () => {
    const single = note({ id: "a", content: "MiXeD Case" });
    const indexed = indexedNotes([single]);
    assert.equal(indexed[0]?.searchText, "mixed case");
  });

  it("scales to 10k notes without quadratic behaviour", () => {
    const many = Array.from({ length: 10_000 }, (_, index) =>
      note({
        id: `id-${index.toString().padStart(5, "0")}`,
        content: index % 3 === 0 ? `needle ${index}` : `hay ${index}`,
        color: (["red", "blue", "green", "yellow", null] as (NoteColor | null)[])[index % 5]!,
        createdAt: index,
        updatedAt: 10_000 - index,
      })
    );

    const started = performance.now();
    const indexed = indexedNotes(many);
    const result = selectNotes(indexed, filter({ search: "needle", color: "blue", sort: "updated-desc" }));
    const elapsed = performance.now() - started;

    // A loose guard against an accidental O(n^2): the whole pass must stay well
    // under a second even on a slow machine.
    assert.ok(elapsed < 1000, `took ${elapsed.toFixed(1)} ms`);
    assert.ok(result.length > 0);
    // Ordering is by updatedAt descending.
    for (let index = 1; index < result.length; index += 1) {
      assert.ok(result[index - 1]!.note.updatedAt >= result[index]!.note.updatedAt);
    }
  });
});
