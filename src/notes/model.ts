/**
 * ThunderNotes domain model.
 *
 * Deliberately small and *extensible*: nothing here references mail, calendar or
 * sync, but every future addition (mail links, calendar links, device sync) can
 * be expressed as new optional fields on `Note` plus a schema migration — see
 * `src/storage/migrations.ts`.
 *
 * Invariants:
 *  - `id` is stable for the whole life of the note (UUID v4).
 *  - `revision` starts at 1 and is bumped on every persisted content change.
 *  - `content` is the single source of truth; `format` only describes how it is
 *    edited/rendered and is NEVER used to convert the stored text.
 */

/** Fixed colour palette. `null` means "no colour" (adapts to the TB theme). */
export const NOTE_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] as const;

export type NoteColor = (typeof NOTE_COLORS)[number];

/** How the note body is edited and rendered. Stored verbatim. */
export type NoteFormat = "plain" | "markdown";

export interface Note {
  id: string;

  content: string;
  format: NoteFormat;

  color: NoteColor | null;

  createdAt: number;
  updatedAt: number;

  /**
   * Monotonic counter, incremented on every change that is written to storage.
   * Unused for conflict resolution today; it exists so that a future sync layer
   * can do last-writer-wins / three-way merges without a schema change.
   */
  revision: number;

  /**
   * Reserved for persistent schema migrations. Message relations use the v1 meta
   * extension bag. Readers tolerate absence in data written by older builds.
   */
  schemaVersion?: number;

  /**
   * Optional extension bag. Typed message helpers own the primary-relation key;
   * unrelated entries are preserved. Portable Data requires JSON-compatible data.
   */
  meta?: Record<string, unknown>;
}

/** Current persisted schema version. Bump when `Note` changes shape. */
export const CURRENT_SCHEMA_VERSION = 1;

export function isNoteColor(value: unknown): value is NoteColor {
  return typeof value === "string" && (NOTE_COLORS as readonly string[]).includes(value);
}

export function isNoteFormat(value: unknown): value is NoteFormat {
  return value === "plain" || value === "markdown";
}

/** Coerce arbitrary storage content into a valid palette value. */
export function normalizeColor(value: unknown): NoteColor | null {
  return isNoteColor(value) ? value : null;
}

export function normalizeFormat(value: unknown): NoteFormat {
  return isNoteFormat(value) ? value : "plain";
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Validate/repair a historical or partially corrupt local storage record.
 * Never throws: unreadable input yields `null` so callers can skip the record
 * instead of losing the whole database. External Portable Data imports use a
 * separate strict decoder and never call this permissive normalizer.
 */
export function normalizeNote(input: unknown): Note | null {
  if (input === null || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;

  const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : null;
  if (id === null) return null;

  const content = typeof raw.content === "string" ? raw.content : "";

  const now = Date.now();
  const createdAt = toFiniteNumber(raw.createdAt, now);
  const updatedAt = toFiniteNumber(raw.updatedAt, createdAt);

  const revisionValue = toFiniteNumber(raw.revision, 0);
  const revision = Number.isInteger(revisionValue) && revisionValue >= 1 ? revisionValue : 1;

  const note: Note = {
    id,
    content,
    format: normalizeFormat(raw.format),
    color: normalizeColor(raw.color),
    createdAt,
    updatedAt,
    revision,
  };

  const schemaVersion = toFiniteNumber(raw.schemaVersion, CURRENT_SCHEMA_VERSION);
  if (Number.isInteger(schemaVersion)) note.schemaVersion = schemaVersion;

  if (raw.meta !== null && typeof raw.meta === "object" && !Array.isArray(raw.meta)) {
    note.meta = raw.meta as Record<string, unknown>;
  }

  return note;
}

/** Generate a stable unique id. `crypto.randomUUID` is available in TB 128+. */
export function createNoteId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  // Defensive fallback; should not be reachable inside Thunderbird.
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Build a brand new, empty, uncategorised note. */
export function createNote(overrides: Partial<Note> = {}): Note {
  const now = Date.now();
  return {
    id: createNoteId(),
    content: "",
    format: "plain",
    color: null,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ...overrides,
  };
}

/**
 * Apply a content/format/colour change and return a NEW note object with a
 * bumped `revision` and refreshed `updatedAt`.
 *
 * Returns the original reference when nothing actually changed, so callers can
 * cheaply skip a write.
 */
export function applyNoteChange(
  note: Note,
  change: Partial<Pick<Note, "content" | "format" | "color" | "meta">>,
  now: number = Date.now()
): Note {
  const content = change.content ?? note.content;
  const format = change.format ?? note.format;
  const color = change.color === undefined ? note.color : change.color;
  const meta = change.meta === undefined ? note.meta : change.meta;

  if (content === note.content && format === note.format && color === note.color && meta === note.meta) {
    return note;
  }

  return {
    ...note,
    content,
    format,
    color,
    ...(meta === undefined ? {} : { meta }),
    updatedAt: now,
    revision: note.revision + 1,
  };
}
