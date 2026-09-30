import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildNotePreview, firstNonEmptyLine, isBlank, lineToPlainText } from "../src/notes/preview.ts";
import { note } from "./helpers.ts";

describe("preview: plain text notes", () => {
  it("uses the first non-empty line as the title", () => {
    const preview = buildNotePreview(note({ id: "a", content: "\n\n  Shopping list  \n\nbuy milk\neggs" }));
    assert.equal(preview.title, "Shopping list");
    assert.equal(preview.excerpt, "buy milk eggs");
  });

  it("ignores leading whitespace-only lines", () => {
    assert.equal(buildNotePreview(note({ id: "a", content: "   \n\t\nReal line" })).title, "Real line");
  });

  it("never strips markdown syntax from a plain-text note", () => {
    const preview = buildNotePreview(note({ id: "a", content: "# not a heading" }));
    assert.equal(preview.title, "# not a heading");
  });

  it("produces empty strings for a blank note", () => {
    const preview = buildNotePreview(note({ id: "a", content: "   \n\t\n  " }));
    assert.equal(preview.title, "");
    assert.equal(preview.excerpt, "");
  });

  it("handles CRLF and CR line endings", () => {
    assert.equal(buildNotePreview(note({ id: "a", content: "one\r\ntwo\r\nthree" })).excerpt, "two three");
    assert.equal(buildNotePreview(note({ id: "b", content: "one\rtwo" })).excerpt, "two");
  });

  it("truncates a very long title with an ellipsis", () => {
    const preview = buildNotePreview(note({ id: "a", content: "x".repeat(500) }), { maxTitleLength: 20 });
    assert.equal(preview.title.length, 20);
    assert.ok(preview.title.endsWith("\u2026"));
  });

  it("truncates the excerpt", () => {
    const content = `title\n${"word ".repeat(200)}`;
    const preview = buildNotePreview(note({ id: "a", content }), { maxExcerptLength: 40 });
    assert.ok(preview.excerpt.length <= 40, String(preview.excerpt.length));
    assert.ok(preview.excerpt.endsWith("\u2026"));
  });

  it("has no excerpt when the note is a single line", () => {
    assert.equal(buildNotePreview(note({ id: "a", content: "just one line" })).excerpt, "");
  });

  it("collapses runs of whitespace in the excerpt", () => {
    const preview = buildNotePreview(note({ id: "a", content: "t\n   many     spaces   here" }));
    assert.equal(preview.excerpt, "many spaces here");
  });
});

describe("preview: markdown notes", () => {
  it("turns an ATX heading into a readable title", () => {
    assert.equal(
      buildNotePreview(note({ id: "a", content: "## Project plan\n\nstep one", format: "markdown" })).title,
      "Project plan"
    );
  });

  it("removes emphasis, code markers and strikethrough", () => {
    assert.equal(
      lineToPlainText("**bold** and *italic* and `code` and ~~gone~~", true),
      "bold and italic and code and gone"
    );
  });

  it("keeps link labels and drops targets", () => {
    assert.equal(lineToPlainText("see [the docs](https://example.com/a_b) now", true), "see the docs now");
    assert.equal(lineToPlainText("![alt text](img.png)", true), "alt text");
  });

  it("removes list markers and quotes", () => {
    assert.equal(lineToPlainText("- item", true), "item");
    assert.equal(lineToPlainText("* item", true), "item");
    assert.equal(lineToPlainText("+ item", true), "item");
    assert.equal(lineToPlainText("1. item", true), "item");
    assert.equal(lineToPlainText("12) item", true), "item");
    assert.equal(lineToPlainText("> quoted", true), "quoted");
    assert.equal(lineToPlainText(">> nested", true), "> nested");
  });

  it("drops fence lines, rules and table separator rows entirely", () => {
    assert.equal(lineToPlainText("```js", true), "");
    assert.equal(lineToPlainText("~~~", true), "");
    assert.equal(lineToPlainText("---", true), "");
    assert.equal(lineToPlainText("| --- | :--: |", true), "");
  });

  it("strips raw HTML tags from the preview", () => {
    assert.equal(lineToPlainText("<b>bold</b>", true), "bold");
  });

  it("skips a fenced block's opening line when choosing the title", () => {
    const preview = buildNotePreview(
      note({ id: "a", content: "```\nconst x = 1;\n```\n\nreal text", format: "markdown" })
    );
    assert.equal(preview.title, "const x = 1;");
  });

  it("does not leak markdown punctuation for a typical note", () => {
    const preview = buildNotePreview(
      note({
        id: "a",
        format: "markdown",
        content: "# Sprint notes\n\n- **Done**: shipped [release](https://x.y/1)\n- *Next*: review",
      })
    );
    assert.equal(preview.title, "Sprint notes");
    assert.ok(!preview.excerpt.includes("#"), preview.excerpt);
    assert.ok(!preview.excerpt.includes("*"), preview.excerpt);
    assert.ok(!preview.excerpt.includes("]("), preview.excerpt);
    assert.ok(preview.excerpt.includes("shipped release"), preview.excerpt);
  });
});

describe("preview: small helpers", () => {
  it("firstNonEmptyLine keeps the raw line", () => {
    assert.equal(firstNonEmptyLine("\n  **x**  \n"), "**x**");
    assert.equal(firstNonEmptyLine("   "), "");
  });

  it("isBlank detects whitespace-only content", () => {
    assert.equal(isBlank(""), true);
    assert.equal(isBlank("  \n\t "), true);
    assert.equal(isBlank(" a "), false);
  });
});

describe("preview: hostile input is not interpreted", () => {
  it("does not emit script markup through the preview path", () => {
    const preview = buildNotePreview(
      note({ id: "a", format: "markdown", content: "<script>alert(1)</script>\n\nsafe" })
    );
    assert.ok(!preview.title.includes("<script"), preview.title);
    assert.equal(preview.title, "alert(1)");
  });
});
