import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  migrateNotes,
  migrationsBetween,
} from "../src/storage/migrations.ts";

describe("migrations: registry", () => {
  it("starts at schema version 1", () => {
    assert.equal(CURRENT_SCHEMA_VERSION, 1);
  });

  it("has a contiguous, gap-free chain starting at 0", () => {
    const ordered = [...MIGRATIONS].sort((a, b) => a.from - b.from);
    assert.equal(ordered[0]?.from, 0);
    for (let index = 0; index < ordered.length; index += 1) {
      const migration = ordered[index]!;
      assert.equal(migration.to, migration.from + 1, "each migration must advance exactly one version");
      if (index > 0) {
        assert.equal(migration.from, ordered[index - 1]!.to, "migrations must not leave gaps");
      }
    }
    assert.equal(ordered.at(-1)?.to, CURRENT_SCHEMA_VERSION);
  });

  it("selects the migrations needed to reach the target version", () => {
    assert.equal(migrationsBetween(0).length, 1);
    assert.equal(migrationsBetween(1).length, 0);
    assert.equal(migrationsBetween(CURRENT_SCHEMA_VERSION).length, 0);
  });
});

describe("migrations: migrateNotes", () => {
  it("normalises records when upgrading from a fresh database", () => {
    const result = migrateNotes(
      [
        { id: "a", content: "hello", format: "markdown", color: "blue", createdAt: 1, updatedAt: 2, revision: 4 },
      ],
      0
    );
    assert.equal(result.version, CURRENT_SCHEMA_VERSION);
    assert.equal(result.notes.length, 1);
    assert.equal(result.applied.length, 1);
    assert.deepEqual(
      { id: result.notes[0]!.id, format: result.notes[0]!.format, color: result.notes[0]!.color, revision: result.notes[0]!.revision },
      { id: "a", format: "markdown", color: "blue", revision: 4 }
    );
  });

  it("drops unreadable records instead of failing the whole upgrade", () => {
    const result = migrateNotes([{ id: "ok" }, { noId: true }, null, 42, "nope"], 0);
    assert.deepEqual(result.notes.map((note) => note.id), ["ok"]);
  });

  it("repairs invalid enum values during migration", () => {
    const result = migrateNotes([{ id: "a", format: "wysiwyg", color: "#ff0000" }], 0);
    assert.equal(result.notes[0]?.format, "plain");
    assert.equal(result.notes[0]?.color, null);
  });

  it("is a no-op for an already-current database apart from validation", () => {
    const result = migrateNotes([{ id: "a", content: "x", format: "plain", color: null, createdAt: 1, updatedAt: 1, revision: 1 }], CURRENT_SCHEMA_VERSION);
    assert.deepEqual(result.applied, []);
    assert.equal(result.version, CURRENT_SCHEMA_VERSION);
    assert.equal(result.notes.length, 1);
  });

  it("tolerates a database from a newer build", () => {
    const result = migrateNotes([{ id: "a", content: "x" }], CURRENT_SCHEMA_VERSION + 5);
    assert.deepEqual(result.applied, []);
    assert.equal(result.notes.length, 1);
    assert.equal(result.version, CURRENT_SCHEMA_VERSION + 5);
  });

  it("records what it applied, for logging", () => {
    const result = migrateNotes([], 0);
    assert.equal(result.applied.length, 1);
    assert.match(result.applied[0]!, /^0->1: /);
  });
});
