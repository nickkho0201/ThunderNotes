/**
 * Database schema versioning and migrations.
 *
 * Only version 1 exists today, but the mechanism is real: `IndexedDbNotesRepository`
 * runs every migration whose `to` is greater than the version found on disk and
 * then writes the new version. Adding a future field means appending one entry
 * here plus a `Note` field — no rewrite of the storage layer.
 */

import { CURRENT_SCHEMA_VERSION, normalizeNote } from "../notes/model";
import type { Note } from "../notes/model";

export { CURRENT_SCHEMA_VERSION };

export interface MigrationContext {
  /** Read every stored record as raw, unvalidated data. */
  readAll(): unknown[];
  /** Overwrite every record. */
  writeAll(notes: Note[]): void;
}

export interface Migration {
  /** Version this migration upgrades FROM. */
  from: number;
  /** Version this migration produces (`from + 1`). */
  to: number;
  /** Human-readable one-liner, logged during upgrade. */
  description: string;
  run(context: MigrationContext): void;
}

/**
 * Ordered list of migrations. v0 -> v1 is the initial creation: it only has to
 * normalise anything that was already on disk (there is nothing yet).
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    from: 0,
    to: 1,
    description: "Initial schema: notes with content/format/color/timestamps/revision.",
    run({ readAll, writeAll }) {
      const notes: Note[] = [];
      for (const raw of readAll()) {
        const note = normalizeNote(raw);
        if (note) notes.push(note);
      }
      writeAll(notes);
    },
  },
];

/** Migrations that must run to get from `fromVersion` to `targetVersion`. */
export function migrationsBetween(
  fromVersion: number,
  targetVersion: number = CURRENT_SCHEMA_VERSION
): Migration[] {
  return MIGRATIONS.filter((m) => m.from >= fromVersion && m.to <= targetVersion).sort(
    (a, b) => a.from - b.from
  );
}

/**
 * Apply migrations in order against an in-memory snapshot.
 *
 * Kept pure (no database handles) so it is unit-testable in Node.
 */
export function migrateNotes(
  rawNotes: unknown[],
  fromVersion: number,
  targetVersion: number = CURRENT_SCHEMA_VERSION
): { notes: Note[]; version: number; applied: string[] } {
  const applied: string[] = [];
  const context: MigrationContext = {
    readAll: () => rawNotes,
    writeAll: (notes) => {
      rawNotes = notes;
    },
  };

  let version = fromVersion;
  for (const migration of migrationsBetween(fromVersion, targetVersion)) {
    migration.run(context);
    applied.push(`${migration.from}->${migration.to}: ${migration.description}`);
    version = migration.to;
  }

  // Always finish with validation, even when there was no migration to run
  // (e.g. data written by a newer build with unknown fields).
  const notes: Note[] = [];
  for (const raw of rawNotes) {
    const note = normalizeNote(raw);
    if (note) notes.push(note);
  }

  return { notes, version: Math.max(version, fromVersion), applied };
}
