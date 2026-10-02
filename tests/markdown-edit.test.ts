import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { continueMarkdownList, deleteOrderedItem, indentMarkdown, MARKDOWN_INDENT_SIZE, wrapMarkdown } from "../src/ui/markdown-edit.ts";

describe("Markdown source commands", () => {
  for (const [key, marker] of [["b", "**"], ["i", "*"], ["`", "`"]]) {
    it(`toggles ${key} for inner and whole selections`, () => {
      const source = marker! + "text" + marker!;
      for (const [start, end] of [[marker!.length, marker!.length + 4], [0, source.length]]) {
        assert.deepEqual(wrapMarkdown(source, start!, end!, key!), { start: 0, end: source.length, text: "text", selectionStart: 0, selectionEnd: 4 });
      }
    });
  }
  it("does not remove ambiguous runs, compound selections or nested markers", () => {
    for (const [source, key, start, end] of [["***text***", "b", 3, 7], ["**text**", "i", 2, 6], ["``text``", "`", 2, 6], ["**a** **b**", "b", 0, 11]] as const) {
      const edit = wrapMarkdown(source, start, end, key)!;
      assert.equal(edit.start, start); assert.equal(edit.end, end);
      assert.ok(edit.text.includes(source.slice(start, end)));
    }
    assert.equal(wrapMarkdown("[text](url)", 1, 5, "k")!.text, "[text](url)");
    assert.equal(wrapMarkdown("**a *b* c**", 0, 11, "b")!.text, "a *b* c");
    assert.equal(wrapMarkdown("\\**text**", 3, 7, "b")!.start, 3);
    assert.equal(wrapMarkdown("* text *", 0, 8, "i")!.text, "** text **");
  });
  const apply = (value: string, caret: number): string => {
    const edit = continueMarkdownList(value, caret, caret)!;
    assert.ok(edit);
    return value.slice(0, edit.start) + edit.text + value.slice(edit.end);
  };
  for (const marker of [".", ")"]) {
    it(`renumbers later ${marker} siblings after middle insertion`, () => {
      const source = `1${marker} First\n2${marker} Second\n3${marker} Third\n4${marker} Fourth`;
      const caret = source.indexOf("\n3");
      assert.equal(apply(source, caret), `1${marker} First\n2${marker} Second\n3${marker} \n4${marker} Third\n5${marker} Fourth`);
    });
  }
  it("renumbers indented two-digit items while preserving nested numbering", () => {
    const source = "  9. first\n    1. nested\n    2. nested\n  10. next\n  11. last";
    assert.equal(apply(source, 10), "  9. first\n  10. \n    1. nested\n    2. nested\n  11. next\n  12. last");
  });
  for (const boundary of ["\n", "ordinary text\n", "```\n3. code\n```\n", "3) other type\n", "- other block\n"]) {
    it(`stops renumbering at ${JSON.stringify(boundary)}`, () => {
      const source = "1. first\n2. second\n" + boundary + "1. independent\n2. list";
      const result = apply(source, 8);
      assert.equal(result, "1. first\n2. \n3. second\n" + boundary + "1. independent\n2. list");
    });
  }
  for (const [key, text, offset] of [["b", "**word**", 2], ["i", "*word*", 1], ["k", "[word](url)", 1], ["`", "`word`", 1]] as const) {
    it(`wraps selection with ${key} and preserves inner selection`, () => {
      assert.deepEqual(wrapMarkdown("a word z", 2, 6, key), { start: 2, end: 6, text,
        selectionStart: 2 + offset, selectionEnd: 6 + offset });
    });
    it(`inserts ${key} at the caret`, () => {
      const edit = wrapMarkdown("", 0, 0, key)!;
      assert.equal(edit.text, text.replace("word", ""));
      assert.equal(edit.selectionStart, offset);
      assert.equal(edit.selectionEnd, offset);
    });
  }
  for (const [source, next] of [
    ["- first", "\n- "], ["+ first", "\n+ "], ["* first", "\n* "],
    ["  - first", "\n  - "], ["\t- first", "\n\t- "],
    ["1. first", "\n2. "], ["  19. first", "\n  20. "], ["9) first", "\n10) "],
    ["- [ ] first", "\n- [ ] "], ["  - [x] done", "\n  - [ ] "],
  ]) {
    it(`continues ${JSON.stringify(source)}`, () => {
      const edit = continueMarkdownList(source!, source!.length, source!.length)!;
      assert.equal(edit.text, next);
      assert.equal(edit.selectionStart, source!.length + next!.length);
      assert.equal(edit.selectionEnd, edit.selectionStart);
    });
  }
  for (const source of ["- ", "2. ", "- [ ] ", "- [x] ", "  - "]) {
    it(`exits empty item ${JSON.stringify(source)}`, () => {
      const edit = continueMarkdownList(source, source.length, source.length)!;
      assert.equal(edit.start, 0);
      assert.equal(edit.end, source.length);
      assert.equal(edit.text, source.startsWith("  ") ? "  " : "");
      assert.equal(edit.selectionStart, edit.text.length);
    });
  }
  it("leaves normal Enter, selected text, marker positions and fenced code native", () => {
    for (const source of ["normal", "```md\n- code", "~~~\n1. code"]) {
      assert.equal(continueMarkdownList(source, source.length, source.length), null);
    }
    assert.equal(continueMarkdownList("- first", 0, 0), null);
    assert.equal(continueMarkdownList("- first", 2, 5), null);
  });
  it("splits an item at the caret without losing the remainder or surrounding lines", () => {
    const source = "heading\n- first second\ntail";
    const edit = continueMarkdownList(source, 15, 15)!;
    assert.equal(source.slice(0, edit.start) + edit.text + source.slice(edit.end), "heading\n- first\n-  second\ntail");
  });
});

describe("Markdown Tab indentation", () => {
  const apply = (value: string, start: number, end = start, outdent = false) => {
    const edit = indentMarkdown(value, start, end, outdent)!; assert.ok(edit);
    return { value: value.slice(0, edit.start) + edit.text + value.slice(edit.end), start: edit.selectionStart, end: edit.selectionEnd };
  };
  it("inserts exactly four spaces at a plain caret, including fenced list-looking text", () => {
    assert.equal(MARKDOWN_INDENT_SIZE, 4);
    assert.deepEqual(apply("sometext", 4), { value: "some    text", start: 8, end: 8 });
    const source = "```md\n- code\n```";
    assert.deepEqual(apply(source, 12), { value: "```md\n- code    \n```", start: 16, end: 16 });
    assert.deepEqual(apply("", 0), { value: "    ", start: 4, end: 4 });
  });
  for (const item of ["- Child", "+ Child", "* Child", "2. Child", "2) Child", "- [ ] Child", "- [x] Child"]) {
    it(`indents/outdents the entire ${item} line and preserves its caret`, () => {
      const source = "Parent\n" + item;
      const result = apply(source, source.length);
      assert.deepEqual(result, { value: "Parent\n    " + item, start: source.length + 4, end: source.length + 4 });
      assert.deepEqual(apply(result.value, result.start, result.end, true), { value: source, start: source.length, end: source.length });
    });
  }
  it("recalculates destination and source ordered levels and supports nested continuation", () => {
    const source = "1. Parent\n2. Child\n3. Next";
    const result = apply(source, source.indexOf("\n3"));
    assert.equal(result.value, "1. Parent\n    1. Child\n2. Next");
    const continuation = continueMarkdownList(result.value, result.start, result.end)!;
    assert.equal(result.value.slice(0, continuation.start) + continuation.text + result.value.slice(continuation.end), "1. Parent\n    1. Child\n    2. \n2. Next");
  });
  it("outdents at most four spaces, clamps caret in removed indentation, leaves zero-indent native content", () => {
    assert.deepEqual(apply("        text", 10, 10, true), { value: "    text", start: 6, end: 6 });
    assert.deepEqual(apply("  text", 1, 1, true), { value: "text", start: 0, end: 0 });
    assert.deepEqual(apply("\ttext", 5, 5, true), { value: "text", start: 4, end: 4 });
    assert.equal(indentMarkdown("text", 2, 2, true), null);
  });
  it("indents multiline selection including empty lines and preserves logical text boundaries", () => {
    const source = "one\n\ntwo\nthree";
    const result = apply(source, 1, 7);
    assert.deepEqual(result, { value: "    one\n    \n    two\nthree", start: 5, end: 19 });
    assert.deepEqual(apply(result.value, result.start, result.end, true), { value: source, start: 1, end: 7 });
  });
  it("excludes the next line when selection ends exactly at its start", () => {
    assert.deepEqual(apply("one\ntwo\nthree", 0, 8), { value: "    one\n    two\nthree", start: 4, end: 16 });
    assert.deepEqual(apply("one\ntwo", 0, 4), { value: "    one\ntwo", start: 4, end: 8 });
  });
  it("outdents each mixed-indent/empty line independently", () => {
    const source = "    - one\n        - two\n  text\nplain\n  \n";
    const result = apply(source, 0, source.length, true);
    assert.equal(result.value, "- one\n    - two\ntext\nplain\n\n");
    assert.equal(result.start, 0); assert.equal(result.end, result.value.length);
  });
  it("supports repeated Tab and Shift+Tab without losing selected characters", () => {
    const source = "- one\n- two\n- three";
    let state = { value: source, start: 0, end: source.length };
    for (let step = 0; step < 3; step++) state = apply(state.value, state.start, state.end);
    assert.equal(state.value, source.split("\n").map((line) => " ".repeat(12) + line).join("\n"));
    for (let step = 0; step < 3; step++) state = apply(state.value, state.start, state.end, true);
    assert.deepEqual(state, { value: source, start: 0, end: source.length });
    assert.equal(indentMarkdown(state.value, state.start, state.end, true), null);
  });
  it("retains a single-line text selection instead of deleting its content", () => {
    assert.deepEqual(apply("some text", 5, 9), { value: "    some text", start: 9, end: 13 });
  });
  it("handles a leading newline, selected trailing newline and collapsed empty final line", () => {
    assert.deepEqual(apply("\ntext", 0, 1), { value: "    \ntext", start: 4, end: 5 });
    assert.deepEqual(apply("one\n", 0, 4), { value: "    one\n", start: 4, end: 8 });
    assert.deepEqual(apply("one\n", 4), { value: "one\n    ", start: 8, end: 8 });
  });
});

describe("conservative ordered item deletion", () => {
  const deleted = (source: string, start: number, end: number, key = "Delete") => {
    const edit = deleteOrderedItem(source, start, end, key)!;
    assert.ok(edit); assert.equal(edit.selectionStart, edit.start); assert.equal(edit.selectionEnd, edit.start);
    return source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  };
  for (const marker of [".", ")"]) {
    for (const includeLF of [false, true]) {
      it(`removes a complete ${marker} item, LF selected=${includeLF}`, () => {
        const source = `1${marker} One\n2${marker} Two\n3${marker} Temporary\n4${marker} Three\n5${marker} Four`;
        const start = source.indexOf("3"), end = source.indexOf("\n4") + Number(includeLF);
        assert.equal(deleted(source, start, end), `1${marker} One\n2${marker} Two\n3${marker} Three\n4${marker} Four`);
      });
    }
  }
  it("removes multiple complete items and preserves indented/nested siblings", () => {
    const source = "  9. One\n  10. Temporary\n  11. Temporary\n  12. Three\n    1. nested\n    2. nested\n  13. Four";
    assert.equal(deleted(source, source.indexOf("  10"), source.indexOf("  12")), "  9. One\n  10. Three\n    1. nested\n    2. nested\n  11. Four");
  });
  it("removes the first item of an unambiguously new sequential block", () => {
    const source = "1. One\n2. Two\n3. Three";
    assert.equal(deleted(source, 0, 7), "1. Two\n2. Three");
    assert.equal(deleted("heading\n\n" + source, 9, 16), "heading\n\n1. Two\n2. Three");
  });
  for (const boundary of ["\n", "ordinary\n", "```\n4. code\n```\n", "4) other\n", "- bullet\n"]) {
    it(`stops at ${JSON.stringify(boundary)}`, () => {
      const source = "1. One\n2. Temporary\n3. Three\n" + boundary + "1. independent\n2. list";
      assert.equal(deleted(source, 7, 20), "1. One\n2. Three\n" + boundary + "1. independent\n2. list");
    });
  }
  for (const [key, position] of [["Backspace", 7], ["Backspace", 10], ["Delete", 6]] as const) {
    it(`${key} at ${position} merges adjacent sequential siblings in one edit`, () => {
      const source = "1. One\n2. Two\n3. Three\n4. Four";
      assert.equal(deleted(source, position, position, key), "1. OneTwo\n2. Three\n3. Four");
    });
  }
  it("retains native editing for partial, arbitrary, nested-subtree and fenced deletions", () => {
    for (const [source, start, end, key] of [
      ["1. One\n2. Two\n3. Three", 11, 11, "Backspace"],
      ["1. One\n2. Two\n3. Three", 10, 12, "Delete"],
      ["1. One\n8. Two\n9. Three", 7, 14, "Delete"],
      ["01. One\n02. Two\n03. Three", 8, 16, "Delete"],
      ["1. One\n2. Two\n  1. child\n3. Three", 7, 14, "Delete"],
      ["1. One\n2. Two\n  1. child\n3. Three", 7, 7, "Backspace"],
      ["```\n1. One\n2. Two\n3. Three\n```", 11, 18, "Delete"],
      ["1. One\n\n2. Two\n3. Three", 8, 15, "Delete"],
    ] as const) assert.equal(deleteOrderedItem(source, start, end, key), null, source);
    const source = "1. One\n2. Temporary\n20. Intentional\n21. Numbering";
    assert.equal(deleted(source, 7, 20), "1. One\n20. Intentional\n21. Numbering");
  });
  it("does not normalize ordinary nonstructural input or unrelated keys", () => {
    assert.equal(deleteOrderedItem("1. One\n7. Two", 5, 5, "Backspace"), null);
    assert.equal(deleteOrderedItem("1. One\n2. Two", 7, 13, "Enter"), null);
  });
});
