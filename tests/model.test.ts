import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CURRENT_SCHEMA_VERSION,
  applyNoteChange,
  createNote,
  isNoteColor,
  isNoteFormat,
  normalizeColor,
  normalizeFormat,
  normalizeNote,
} from "../src/notes/model.ts";
import { note } from "./helpers.ts";

describe("model: normalizeNote", () => {
  it("accepts a well-formed note", () => {
    const input = {
      id: "a",
      content: "hello",
      format: "markdown",
      color: "blue",
      createdAt: 5,
      updatedAt: 9,
      revision: 3,
    };
    const result = normalizeNote(input);
    assert.ok(result);
    assert.equal(result.id, "a");
    assert.equal(result.content, "hello");
    assert.equal(result.format, "markdown");
    assert.equal(result.color, "blue");
    assert.equal(result.createdAt, 5);
    assert.equal(result.updatedAt, 9);
    assert.equal(result.revision, 3);
    assert.equal(result.schemaVersion, CURRENT_SCHEMA_VERSION);
  });

  it("rejects records without a usable id", () => {
    assert.equal(normalizeNote(null), null);
    assert.equal(normalizeNote("string"), null);
    assert.equal(normalizeNote({ content: "no id" }), null);
    assert.equal(normalizeNote({ id: "" }), null);
    assert.equal(normalizeNote({ id: 42 }), null);
  });

  it("repairs unknown enum values instead of throwing", () => {
    const result = normalizeNote({ id: "x", format: "rich", color: "chartreuse" });
    assert.ok(result);
    assert.equal(result.format, "plain");
    assert.equal(result.color, null);
  });

  it("falls back to sane timestamps and revision", () => {
    const result = normalizeNote({ id: "x", createdAt: "nope", updatedAt: Number.NaN, revision: -5 });
    assert.ok(result);
    assert.equal(typeof result.createdAt, "number");
    assert.ok(Number.isFinite(result.createdAt));
    assert.equal(result.updatedAt, result.createdAt);
    assert.equal(result.revision, 1);
  });

  it("preserves an explicit revision and schemaVersion", () => {
    const result = normalizeNote({ id: "x", revision: 12, schemaVersion: 1 });
    assert.ok(result);
    assert.equal(result.revision, 12);
    assert.equal(result.schemaVersion, 1);
  });

  it("keeps a plain meta bag but drops non-objects", () => {
    assert.deepEqual(normalizeNote({ id: "x", meta: { mailId: "1" } })?.meta, { mailId: "1" });
    assert.equal(normalizeNote({ id: "x", meta: [1, 2] })?.meta, undefined);
    assert.equal(normalizeNote({ id: "x", meta: "nope" })?.meta, undefined);
  });
});

describe("model: helpers", () => {
  it("validates colours and formats", () => {
    assert.ok(isNoteColor("red"));
    assert.ok(!isNoteColor("crimson"));
    assert.ok(!isNoteColor(null));
    assert.ok(isNoteFormat("plain"));
    assert.ok(isNoteFormat("markdown"));
    assert.ok(!isNoteFormat("Markdown"));
  });

  it("normalizes to fallbacks", () => {
    assert.equal(normalizeColor("purple"), "purple");
    assert.equal(normalizeColor(undefined), null);
    assert.equal(normalizeFormat(undefined), "plain");
    assert.equal(normalizeFormat("markdown"), "markdown");
  });

  it("creates notes with a stable unique id and revision 1", () => {
    const first = createNote();
    const second = createNote();
    assert.notEqual(first.id, second.id);
    assert.equal(first.revision, 1);
    assert.equal(first.color, null);
    assert.equal(first.format, "plain");
    assert.equal(first.content, "");
    assert.ok(first.createdAt > 0);
  });
});

describe("model: applyNoteChange", () => {
  const base = note({ id: "a", content: "one", createdAt: 100, updatedAt: 100, revision: 1 });

  it("bumps revision and updatedAt on a real change", () => {
    const next = applyNoteChange(base, { content: "two" }, 500);
    assert.equal(next.content, "two");
    assert.equal(next.updatedAt, 500);
    assert.equal(next.revision, 2);
    assert.notEqual(next, base);
  });

  it("returns the same object when nothing changed", () => {
    assert.equal(applyNoteChange(base, { content: "one" }, 500), base);
    assert.equal(applyNoteChange(base, {}), base);
    assert.equal(applyNoteChange(base, { color: null }), base);
  });

  it("treats a colour change as a change", () => {
    const next = applyNoteChange(base, { color: "green" }, 700);
    assert.equal(next.color, "green");
    assert.equal(next.revision, 2);
    assert.equal(next.updatedAt, 700);
    // Content is untouched.
    assert.equal(next.content, "one");
  });

  it("changes format without converting the stored content", () => {
    const markdown = "## heading\n\n**bold** and `code`";
    const source = note({ id: "b", content: markdown });
    const next = applyNoteChange(source, { format: "markdown" }, 900);
    assert.equal(next.format, "markdown");
    assert.equal(next.content, markdown, "content must be stored verbatim");
    assert.equal(applyNoteChange(next, { format: "plain" }, 1000).content, markdown);
  });

  it("increments revision by exactly one per call", () => {
    let current = base;
    for (let index = 0; index < 5; index += 1) {
      current = applyNoteChange(current, { content: `v${index}` }, 1000 + index);
    }
    assert.equal(current.revision, 6);
    assert.equal(current.updatedAt, 1004);
  });
});
