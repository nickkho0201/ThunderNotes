import {
  CURRENT_SCHEMA_VERSION,
  NOTE_COLORS,
  isNoteFormat,
  type Note,
  type NoteColor,
  type NoteFormat,
} from "../notes/model";
import { migratePortableData } from "./migrations";
import {
  MAX_PORTABLE_FILE_BYTES,
  MAX_PORTABLE_JSON_DEPTH,
  MAX_PORTABLE_NOTES,
  PORTABLE_DATA_FORMAT,
  PORTABLE_DATA_VERSION,
  PortableDataError,
  type PortableDataErrorCode,
  type PortableDataErrorParameters,
  type JsonObject,
  type JsonValue,
  type PortableDataV1,
  type PortableNoteV1,
} from "./types";

const ENVELOPE_KEYS = ["format", "formatVersion", "exportedAt", "appVersion", "notes"];
const NOTE_KEYS = [
  "id",
  "content",
  "format",
  "color",
  "createdAt",
  "updatedAt",
  "revision",
  "schemaVersion",
];

function fail(
  code: PortableDataErrorCode,
  message: string,
  parameters: PortableDataErrorParameters = {},
): never {
  throw new PortableDataError(code, message, parameters);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail("invalid-shape", `${path} must be an object.`, { path });
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      const field = `${path}.${key}`;
      fail("unknown-field", `${field} is not supported.`, { field });
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      const field = `${path}.${key}`;
      fail("missing-field", `${field} is required.`, { field });
    }
  }
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid-value", `${path} must be a non-empty string.`, { field: path });
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") {
    fail("invalid-value", `${path} must be a string.`, { field: path });
  }
}

function assertSafeInteger(value: unknown, path: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail("invalid-value", `${path} must be a safe integer greater than or equal to ${minimum}.`, {
      field: path,
    });
  }
}

function assertFormat(value: unknown, path: string): asserts value is NoteFormat {
  if (!isNoteFormat(value)) {
    fail("invalid-value", `${path} is not a supported note format.`, { field: path });
  }
}

function assertColor(value: unknown, path: string): asserts value is NoteColor | null {
  if (value !== null && !NOTE_COLORS.includes(value as Exclude<NoteColor, null>)) {
    fail("invalid-value", `${path} is not a supported note color.`, { field: path });
  }
}

function defineJsonProperty(target: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function copyJsonValue(value: unknown, path: string, depth: number): JsonValue {
  if (depth > MAX_PORTABLE_JSON_DEPTH) {
    fail("max-depth", `${path} exceeds the maximum JSON nesting depth.`, {
      maximum: MAX_PORTABLE_JSON_DEPTH,
    });
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      fail("invalid-meta", `${path} contains an unsupported number.`, { path });
    }
    return value;
  }
  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some(
        (key) =>
          key !== "length" &&
          (typeof key !== "string" || !/^\d+$/.test(key) || Number(key) >= value.length),
      ) ||
      Array.from(
        { length: value.length },
        (_, index) => !Object.prototype.hasOwnProperty.call(value, index),
      ).some(Boolean)
    ) {
      fail("invalid-meta", `${path} must be a dense JSON array without extra properties.`, {
        path,
      });
    }
    return value.map((entry, index) => copyJsonValue(entry, `${path}[${index}]`, depth + 1));
  }
  if (!isRecord(value)) {
    fail("invalid-meta", `${path} must contain JSON-compatible values only.`, { path });
  }

  const result: JsonObject = {};
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    fail("invalid-meta", `${path} cannot contain symbol keys.`, { path });
  }
  for (const key of (keys as string[]).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail("invalid-meta", `${path}.${key} must be an enumerable JSON data property.`, {
        path: `${path}.${key}`,
      });
    }
    defineJsonProperty(
      result,
      key,
      copyJsonValue(descriptor.value, `${path}.${key}`, depth + 1),
    );
  }
  return result;
}

function copyMeta(value: unknown, path: string): JsonObject {
  if (!isRecord(value)) fail("invalid-meta", `${path} must be a JSON object.`, { path });
  return copyJsonValue(value, path, 1) as JsonObject;
}

function assertIsoTimestamp(value: unknown, path: string): asserts value is string {
  assertNonEmptyString(value, path);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("invalid-value", `${path} must be a canonical UTC ISO timestamp.`, { field: path });
  }
}

export function toPortableNote(note: Note): PortableNoteV1 {
  assertNonEmptyString(note.id, "note.id");
  assertString(note.content, "note.content");
  assertFormat(note.format, "note.format");
  assertColor(note.color, "note.color");
  assertSafeInteger(note.createdAt, "note.createdAt");
  assertSafeInteger(note.updatedAt, "note.updatedAt");
  assertSafeInteger(note.revision, "note.revision", 1);

  const portable: PortableNoteV1 = {
    id: note.id,
    content: note.content,
    format: note.format,
    color: note.color,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    revision: note.revision,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
  if (note.meta !== undefined) portable.meta = copyMeta(note.meta, "note.meta");
  return portable;
}

function decodePortableNote(value: unknown, index: number): PortableNoteV1 {
  const path = `portable.notes[${index}]`;
  assertRecord(value, path);
  assertExactKeys(value, NOTE_KEYS, ["meta"], path);
  assertNonEmptyString(value.id, `${path}.id`);
  assertString(value.content, `${path}.content`);
  assertFormat(value.format, `${path}.format`);
  assertColor(value.color, `${path}.color`);
  assertSafeInteger(value.createdAt, `${path}.createdAt`);
  assertSafeInteger(value.updatedAt, `${path}.updatedAt`);
  assertSafeInteger(value.revision, `${path}.revision`, 1);
  assertSafeInteger(value.schemaVersion, `${path}.schemaVersion`, 1);
  if (value.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    fail(
      "unsupported-note-schema",
      `${path}.schemaVersion ${value.schemaVersion} is not supported.`,
      { actual: value.schemaVersion, supported: CURRENT_SCHEMA_VERSION },
    );
  }

  const note: PortableNoteV1 = {
    id: value.id,
    content: value.content,
    format: value.format,
    color: value.color,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    revision: value.revision,
    schemaVersion: value.schemaVersion,
  };
  if (Object.prototype.hasOwnProperty.call(value, "meta")) {
    note.meta = copyMeta(value.meta, `${path}.meta`);
  }
  return note;
}

function readFormatVersion(value: unknown): number {
  assertRecord(value, "portable");
  if (!Object.prototype.hasOwnProperty.call(value, "formatVersion")) {
    fail("missing-field", "portable.formatVersion is required.", {
      field: "portable.formatVersion",
    });
  }
  assertSafeInteger(value.formatVersion, "portable.formatVersion", 1);
  return value.formatVersion;
}

export function decodePortableData(input: unknown): PortableDataV1 {
  const migrated = migratePortableData(input, readFormatVersion(input));
  assertRecord(migrated, "portable");
  assertExactKeys(migrated, ENVELOPE_KEYS, [], "portable");
  if (migrated.format !== PORTABLE_DATA_FORMAT) {
    fail("wrong-format", "The selected file is not ThunderNotes Portable Data.");
  }
  if (migrated.formatVersion !== PORTABLE_DATA_VERSION) {
    fail("unsupported-format-version", "The Portable Data version is not supported.", {
      actual: migrated.formatVersion as number,
      supported: PORTABLE_DATA_VERSION,
    });
  }
  assertIsoTimestamp(migrated.exportedAt, "portable.exportedAt");
  assertNonEmptyString(migrated.appVersion, "portable.appVersion");
  if (!Array.isArray(migrated.notes)) {
    fail("invalid-shape", "portable.notes must be an array.", { path: "portable.notes" });
  }
  if (migrated.notes.length > MAX_PORTABLE_NOTES) {
    fail("too-many-notes", `portable.notes cannot contain more than ${MAX_PORTABLE_NOTES} notes.`, {
      actual: migrated.notes.length,
      maximum: MAX_PORTABLE_NOTES,
    });
  }

  const ids = new Set<string>();
  const notes = migrated.notes.map((entry, index) => {
    const note = decodePortableNote(entry, index);
    if (ids.has(note.id)) fail("duplicate-note-id", `Duplicate note id: ${note.id}`);
    ids.add(note.id);
    return note;
  });
  return {
    format: PORTABLE_DATA_FORMAT,
    formatVersion: PORTABLE_DATA_VERSION,
    exportedAt: migrated.exportedAt,
    appVersion: migrated.appVersion,
    notes,
  };
}

export function decodePortableText(text: string): PortableDataV1 {
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutBom) as unknown;
  } catch (error) {
    throw new PortableDataError(
      "malformed-json",
      "The selected file is not valid JSON.",
      {},
      { cause: error },
    );
  }
  return decodePortableData(parsed);
}

export function encodePortableData(
  notes: readonly Note[],
  appVersion: string,
  exportedAt = new Date(),
): string {
  assertNonEmptyString(appVersion, "appVersion");
  if (!Number.isFinite(exportedAt.getTime())) {
    fail("invalid-value", "exportedAt is invalid.", { field: "exportedAt" });
  }
  if (notes.length > MAX_PORTABLE_NOTES) {
    fail("too-many-notes", `Cannot export more than ${MAX_PORTABLE_NOTES} notes.`, {
      actual: notes.length,
      maximum: MAX_PORTABLE_NOTES,
    });
  }
  const portableNotes = notes
    .map(toPortableNote)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const ids = new Set<string>();
  for (const note of portableNotes) {
    if (ids.has(note.id)) fail("duplicate-note-id", `Duplicate note id: ${note.id}`);
    ids.add(note.id);
  }
  const data: PortableDataV1 = {
    format: PORTABLE_DATA_FORMAT,
    formatVersion: PORTABLE_DATA_VERSION,
    exportedAt: exportedAt.toISOString(),
    appVersion,
    notes: portableNotes,
  };
  const output = `${JSON.stringify(data, null, 2)}\n`;
  const outputBytes = new TextEncoder().encode(output).byteLength;
  if (outputBytes > MAX_PORTABLE_FILE_BYTES) {
    fail("file-too-large", `The backup exceeds ${MAX_PORTABLE_FILE_BYTES} bytes.`, {
      actual: outputBytes,
      maximum: MAX_PORTABLE_FILE_BYTES,
    });
  }
  return output;
}

export function portableNoteToNote(note: PortableNoteV1): Note {
  const result: Note = {
    id: note.id,
    content: note.content,
    format: note.format,
    color: note.color,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    revision: note.revision,
    schemaVersion: note.schemaVersion,
  };
  if (note.meta !== undefined) result.meta = copyMeta(note.meta, "note.meta");
  return result;
}
