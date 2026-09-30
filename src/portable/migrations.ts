import { PORTABLE_DATA_VERSION, PortableDataError } from "./types";

export interface PortableDataMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(input: unknown): unknown;
}

// Portable Data v1 is the first format, so there are no historical steps yet.
const migrations: readonly PortableDataMigration[] = [];

export function migratePortableData(input: unknown, fromVersion: number): unknown {
  if (fromVersion > PORTABLE_DATA_VERSION) {
    throw new PortableDataError(
      "unsupported-format-version",
      `Portable Data version ${fromVersion} is newer than supported version ${PORTABLE_DATA_VERSION}.`,
    );
  }

  let current = input;
  let version = fromVersion;
  while (version < PORTABLE_DATA_VERSION) {
    const migration = migrations.find((candidate) => candidate.fromVersion === version);
    if (!migration || migration.toVersion <= version) {
      throw new PortableDataError(
        "unsupported-format-version",
        `Portable Data version ${fromVersion} is not supported.`,
      );
    }
    current = migration.migrate(current);
    version = migration.toVersion;
  }
  return current;
}
