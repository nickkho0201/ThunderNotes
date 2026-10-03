import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CURRENT_SCHEMA_VERSION, type Note } from "../src/notes/model.ts";
import {
  decodePortableData,
  decodePortableText,
  encodePortableData,
  toPortableNote,
} from "../src/portable/codec.ts";
import {
  MAX_PORTABLE_NOTES,
  PORTABLE_DATA_FORMAT,
  PORTABLE_DATA_VERSION,
  PortableDataError,
  type PortableDataV1,
} from "../src/portable/types.ts";
import { note } from "./helpers.ts";

function document(overrides: Partial<PortableDataV1> = {}): PortableDataV1 {
  return {
    format: PORTABLE_DATA_FORMAT,
    formatVersion: PORTABLE_DATA_VERSION,
    exportedAt: "2026-01-02T03:04:05.000Z",
    appVersion: "0.1.5",
    notes: [toPortableNote(note({ id: "a", content: "hello" }))],
    ...overrides,
  };
}

describe("portable codec: trusted canonical export", () => {
  it("maps every field explicitly and canonicalizes a missing local schemaVersion", () => {
    const local: Note = {
      ...note({
        id: "legacy",
        content: "line 1\nline 2 😀 https://example.test `code`",
        format: "markdown",
        color: "purple",
        createdAt: 10,
        updatedAt: 20,
        revision: 7,
      }),
      schemaVersion: undefined,
      meta: { nested: { enabled: true, list: [1, null, "x"] } },
    };
    const portable = toPortableNote(local);
    assert.deepEqual(portable, {
      id: "legacy",
      content: local.content,
      format: "markdown",
      color: "purple",
      createdAt: 10,
      updatedAt: 20,
      revision: 7,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      favorite: false,
      pinned: false,
      reminder: null,
      meta: { nested: { enabled: true, list: [1, null, "x"] } },
    });
    assert.notEqual(portable.meta, local.meta);
  });

  it("round-trips plain, Markdown, empty, Unicode, URLs, code and large opaque content", () => {
    const contents = [
      "",
      "plain\nmultiline",
      "# Markdown\n\n**bold**",
      "Привет 👋",
      "https://example.test/path?q=1",
      "const answer = 42;",
      "x".repeat(200_000),
    ];
    const notes = contents.map((content, index) =>
      note({ id: `note-${index}`, content, format: index === 2 ? "markdown" : "plain" }),
    );
    const encoded = encodePortableData(notes, "0.1.5", new Date("2026-01-02T03:04:05Z"));
    assert.ok(encoded.endsWith("\n"));
    assert.deepEqual(
      decodePortableText(encoded).notes.map((entry) => entry.content),
      contents,
    );
  });

  it("sorts notes by id and emits deterministic property order", () => {
    const encoded = encodePortableData(
      [note({ id: "z" }), note({ id: "a" })],
      "0.1.5",
      new Date("2026-01-02T03:04:05Z"),
    );
    const parsed = JSON.parse(encoded) as PortableDataV1;
    assert.deepEqual(parsed.notes.map((entry) => entry.id), ["a", "z"]);
    assert.deepEqual(Object.keys(parsed), ["format", "formatVersion", "exportedAt", "appVersion", "notes"]);
  });

  it("omits absent meta and fails loudly for invalid runtime meta", () => {
    assert.equal("meta" in toPortableNote(note({ id: "a" })), false);
    assert.throws(
      () => toPortableNote({ ...note({ id: "bad" }), meta: { callback: () => undefined } }),
      /JSON-compatible/,
    );
  });
});

describe("portable codec: strict external import", () => {
  it("strictly imports its own canonical backup", () => {
    const encoded = encodePortableData([note({ id: "a", content: "ok" })], "0.1.5");
    assert.equal(decodePortableText(encoded).notes[0]?.schemaVersion, CURRENT_SCHEMA_VERSION);
  });

  it("accepts one leading BOM", () => {
    assert.equal(decodePortableText(`\uFEFF${JSON.stringify(document())}`).notes.length, 1);
  });

  it("rejects malformed JSON", () => {
    assert.throws(() => decodePortableText("{"), /not valid JSON/);
  });

  it("rejects a missing schemaVersion even though local normalization tolerates it", () => {
    const raw = document() as unknown as { notes: Array<Record<string, unknown>> };
    delete raw.notes[0]!.schemaVersion;
    assert.throws(() => decodePortableData(raw), /schemaVersion is required/);
  });

  it("rejects unknown envelope and note fields", () => {
    assert.throws(() => decodePortableData({ ...document(), extra: true }), /extra is not supported/);
    const raw = structuredClone(document()) as unknown as { notes: Array<Record<string, unknown>> };
    raw.notes[0]!.extra = true;
    assert.throws(() => decodePortableData(raw), /extra is not supported/);
  });

  it("rejects a different portable format identifier", () => {
    assert.throws(
      () => decodePortableData({ ...document(), format: "some-other-format" }),
      /not ThunderNotes Portable Data/,
    );
  });

  it("rejects malformed fields, enums and unsafe numbers", () => {
    const cases: unknown[] = [
      { ...document(), exportedAt: "yesterday" },
      { ...document(), appVersion: "" },
      { ...document(), notes: [{ ...document().notes[0], format: "html" }] },
      { ...document(), notes: [{ ...document().notes[0], color: "pink" }] },
      { ...document(), notes: [{ ...document().notes[0], revision: 0 }] },
      { ...document(), notes: [{ ...document().notes[0], createdAt: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...document(), notes: [{ ...document().notes[0], content: 42 }] },
    ];
    for (const candidate of cases) assert.throws(() => decodePortableData(candidate));
  });

  it("rejects unsupported portable and note schema versions", () => {
    assert.throws(
      () => decodePortableData({ ...document(), formatVersion: 999 }),
      (error: unknown) =>
        error instanceof PortableDataError &&
        error.code === "unsupported-format-version" &&
        error.parameters.actual === 999 &&
        error.parameters.supported === 1,
    );
    assert.throws(
      () =>
        decodePortableData({
          ...document(),
          notes: [{ ...document().notes[0]!, schemaVersion: CURRENT_SCHEMA_VERSION + 1 }],
        }),
      (error: unknown) =>
        error instanceof PortableDataError &&
        error.code === "unsupported-note-schema" &&
        error.parameters.actual === CURRENT_SCHEMA_VERSION + 1 &&
        error.parameters.supported === CURRENT_SCHEMA_VERSION,
    );
  });

  it("rejects duplicate note ids and more than the note limit", () => {
    const duplicate = document().notes[0]!;
    assert.throws(
      () => decodePortableData(document({ notes: [duplicate, { ...duplicate }] })),
      /Duplicate note id/,
    );
    assert.throws(
      () => decodePortableData(document({ notes: new Array(MAX_PORTABLE_NOTES + 1).fill(duplicate) })),
      /cannot contain more/,
    );
  });

  it("rejects JSON meta deeper than 32 levels after parsing", () => {
    let nested: unknown = "bottom";
    for (let index = 0; index < 33; index += 1) nested = [nested];
    assert.throws(
      () =>
        decodePortableData(
          document({ notes: [{ ...document().notes[0]!, meta: { nested: nested as never } }] }),
        ),
      /maximum JSON nesting depth/,
    );
  });

  it("treats prototype-looking meta keys as plain data", () => {
    const raw = JSON.parse(JSON.stringify(document()).replace('"content":"hello"', '"content":"hello","meta":{"__proto__":{"polluted":true}}')) as unknown;
    const decoded = decodePortableData(raw);
    assert.equal(Object.prototype.hasOwnProperty.call(decoded.notes[0]!.meta, "__proto__"), true);
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  });
});
