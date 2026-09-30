import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toPortableNote } from "../src/portable/codec.ts";
import {
  importPlansEqual,
  materializeImportPlan,
  planImport,
  portableNotesEqual,
} from "../src/portable/import-plan.ts";
import { note } from "./helpers.ts";

describe("portable import planner", () => {
  it("classifies all-new, all-identical and mixed datasets", () => {
    const local = [note({ id: "same", content: "same" }), note({ id: "conflict", content: "local" })];
    const imported = [
      toPortableNote(local[0]!),
      toPortableNote(note({ id: "new", content: "new" })),
      toPortableNote(note({ id: "conflict", content: "remote" })),
    ];
    const plan = planImport(local, imported, "merge", "keep-both");
    assert.deepEqual(
      [plan.newCount, plan.identicalCount, plan.conflictCount, plan.resultingTotal],
      [1, 1, 1, 4],
    );
    assert.deepEqual(plan.conflictIds, ["conflict"]);
  });

  it("implements every conflict policy without using timestamps or revision as a winner", () => {
    const local = [note({ id: "x", content: "local", updatedAt: 999, revision: 99 })];
    const imported = [toPortableNote(note({ id: "x", content: "imported", updatedAt: 1, revision: 1 }))];
    const keepCurrent = materializeImportPlan(planImport(local, imported, "merge", "keep-current"));
    assert.equal(keepCurrent[0]?.content, "local");
    const useImported = materializeImportPlan(planImport(local, imported, "merge", "use-imported"));
    assert.equal(useImported[0]?.content, "imported");
    const keepBoth = materializeImportPlan(
      planImport(local, imported, "merge", "keep-both"),
      () => "clone-id",
    );
    assert.deepEqual(keepBoth.map((entry) => [entry.id, entry.content]), [
      ["x", "local"],
      ["clone-id", "imported"],
    ]);
    assert.equal(keepBoth[1]?.updatedAt, 1);
    assert.equal(keepBoth[1]?.revision, 1);
  });

  it("generates keep-both UUIDs only during materialization and avoids collisions", () => {
    const local = [note({ id: "x", content: "local" }), note({ id: "collision" })];
    const imported = [toPortableNote(note({ id: "x", content: "imported" }))];
    let calls = 0;
    const plan = planImport(local, imported, "merge", "keep-both");
    assert.equal(calls, 0);
    const result = materializeImportPlan(plan, () => (++calls === 1 ? "collision" : "unique"));
    assert.equal(calls, 2);
    assert.ok(result.some((entry) => entry.id === "unique" && entry.content === "imported"));
  });

  it("compares meta semantically without depending on key order", () => {
    const left = toPortableNote({ ...note({ id: "x" }), meta: { a: 1, nested: { b: 2, c: 3 } } });
    const right = toPortableNote({ ...note({ id: "x" }), meta: { nested: { c: 3, b: 2 }, a: 1 } });
    assert.equal(portableNotesEqual(left, right), true);
  });

  it("detects same-count plan changes through exact snapshots", () => {
    const imported = [toPortableNote(note({ id: "x", content: "imported" }))];
    const first = planImport([note({ id: "x", content: "local 1" })], imported, "merge", "keep-both");
    const second = planImport([note({ id: "x", content: "local 2" })], imported, "merge", "keep-both");
    assert.deepEqual([first.newCount, first.conflictCount], [second.newCount, second.conflictCount]);
    assert.equal(importPlansEqual(first, second), false);
  });

  it("plans 10,000 notes with one indexed pass", () => {
    const local = Array.from({ length: 10_000 }, (_, index) => note({ id: `id-${index}` }));
    const imported = local.map(toPortableNote);
    const plan = planImport(local, imported, "merge", "keep-both");
    assert.equal(plan.identicalCount, 10_000);
    assert.equal(plan.actions.length, 10_000);
  });
});
