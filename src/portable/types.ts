import type { Note, NoteColor, NoteFormat } from "../notes/model";

export const PORTABLE_DATA_FORMAT = "thundernotes-portable-data" as const;
export const PORTABLE_DATA_VERSION = 1 as const;
export const MAX_PORTABLE_FILE_BYTES = 268_435_456;
export const MAX_PORTABLE_NOTES = 100_000;
export const MAX_PORTABLE_JSON_DEPTH = 32;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface PortableNoteV1 {
  id: string;
  content: string;
  format: NoteFormat;
  color: NoteColor | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
  schemaVersion: number;
  meta?: JsonObject;
}

export interface PortableDataV1 {
  format: typeof PORTABLE_DATA_FORMAT;
  formatVersion: typeof PORTABLE_DATA_VERSION;
  exportedAt: string;
  appVersion: string;
  notes: PortableNoteV1[];
}

export type ConflictPolicy = "keep-both" | "keep-current" | "use-imported";
export type ImportMode = "merge" | "restore";

export type ImportPlanAction =
  | { kind: "add"; imported: PortableNoteV1 }
  | { kind: "identical"; local: PortableNoteV1; imported: PortableNoteV1 }
  | {
      kind: "conflict";
      local: PortableNoteV1;
      imported: PortableNoteV1;
      policy: ConflictPolicy;
    };

export interface ImportPlan {
  mode: ImportMode;
  conflictPolicy: ConflictPolicy;
  localSnapshot: PortableNoteV1[];
  importedNotes: PortableNoteV1[];
  actions: ImportPlanAction[];
  newCount: number;
  identicalCount: number;
  conflictCount: number;
  resultingTotal: number;
  conflictIds: string[];
}

export interface ImportCommitSuccess {
  status: "committed";
  notes: readonly Note[];
  plan: ImportPlan;
}

export interface ImportCommitChanged {
  status: "changed";
  plan: ImportPlan;
  safetyBackupInvalidated: boolean;
}

export type ImportCommitResult = ImportCommitSuccess | ImportCommitChanged;

export class PortableDataError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PortableDataError";
  }
}
