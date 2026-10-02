import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { indentMarkdown, continueMarkdownList, deleteOrderedItem } from "../src/ui/markdown-edit.ts";
import { listOutline } from "../src/ui/ordered-levels.ts";

function apply(value: string, edit: ReturnType<typeof indentMarkdown>) {
  assert.ok(edit); return { value: value.slice(0, edit.start) + edit.text + value.slice(edit.end), caret: edit.selectionStart };
}
const tab = (value: string, line: string, reverse = false) => {
  const caret = value.indexOf(line) + line.length;
  return apply(value, indentMarkdown(value, caret, caret, reverse));
};
describe("ordered-list levels", () => {
  for (const marker of [".", ")"]) {
    it(`Tab creates a child starting at 1; Shift+Tab restores outer ${marker} positions`, () => {
      const source = `1${marker} A\n2${marker} B\n3${marker} C`;
      const nested = tab(source, `2${marker} B`);
      assert.equal(nested.value, `1${marker} A\n    1${marker} B\n2${marker} C`);
      assert.equal(tab(nested.value, `    1${marker} B`, true).value, source);
    });
  }
  it("appends after destination siblings, shifting only the source level", () => {
    const source = "1. A\n    1. child\n    2. child\n2. B\n3. C";
    assert.equal(tab(source, "2. B").value, "1. A\n    1. child\n    2. child\n    3. B\n2. C");
  });
  it("outdents a child into its outer position and shifts following outer siblings", () => {
    const source = "1. A\n2. B\n    1. nested\n    2. sibling\n3. C";
    assert.equal(tab(source, "    1. nested", true).value, "1. A\n2. B\n3. nested\n    1. sibling\n4. C");
  });
  it("moves a subtree together through three levels", () => {
    const source = "1. A\n2. B\n    1. child\n        1. grandchild\n3. C";
    const moved = tab(source, "2. B");
    assert.equal(moved.value, "1. A\n    1. B\n        1. child\n            1. grandchild\n2. C");
    assert.equal(tab(moved.value, "    1. B", true).value, source);
  });
  it("continues and inserts inside a nested group without parent-number leakage", () => {
    const source = "3. Parent\n    1. first\n    2. second\n4. Outer";
    const caret = source.indexOf("\n    2");
    assert.equal(apply(source, continueMarkdownList(source, caret, caret)).value, "3. Parent\n    1. first\n    2. \n    3. second\n4. Outer");
  });
  it("deletes the first nested item and collapses only its sibling sequence", () => {
    const source = "1. Parent\n    1. first\n    2. second\n2. Outer";
    assert.equal(apply(source, deleteOrderedItem(source, source.indexOf("    1"), source.indexOf("    2"), "Delete")).value, "1. Parent\n    1. second\n2. Outer");
  });
  it("removes a fully selected parent subtree while preserving the next subtree", () => {
    const source = "1. A\n2. B\n    1. child\n        1. grandchild\n3. C\n    1. childC";
    assert.equal(apply(source, deleteOrderedItem(source, source.indexOf("2. B"), source.indexOf("3. C"), "Delete")).value, "1. A\n2. C\n    1. childC");
  });
  for (const boundary of ["\n", "ordinary text\n", "```\n1. code\n```\n"]) {
    it(`keeps an independent block beyond ${JSON.stringify(boundary)}`, () => {
      const source = "1. A\n2. B\n3. C\n" + boundary + "1. independent\n2. independent";
      const result = tab(source, "2. B");
      assert.equal(result.value, "1. A\n    1. B\n2. C\n" + boundary + "1. independent\n2. independent");
    });
  }
  it("supports ordered children of bullet parents; does not renumber bullets/tasks", () => {
    const source = "- Parent\n1. A\n2. B\n- [ ] task";
    assert.equal(tab(source, "1. A").value, "- Parent\n    1. A\n1. B\n- [ ] task");
    const mixed = "1. Parent\n    - bullet\n    1. ordered\n        1. third\n2. Outer";
    assert.deepEqual(listOutline(mixed).filter((node) => node.number !== null).map((node) => node.depth), [0, 4, 8, 0]);
  });
  it("keeps fenced code and arbitrary numbering conservative", () => {
    const source = "```\n1. A\n2. B\n```";
    assert.equal(tab(source, "2. B").value, "```\n1. A\n2. B    \n```");
    assert.equal(tab("1. A\n8. B\n9. C", "8. B").value, "1. A\n    8. B\n9. C");
  });
  it("does not autocomplete ordered-looking text in nested fenced code", () => {
    const source = "1. Parent\n    ```\n    1. code\n    ```\n2. Outer";
    const caret = source.indexOf("\n    ```", source.indexOf("1. code"));
    assert.equal(continueMarkdownList(source, caret, caret), null);
    assert.equal(tab(source, "    1. code").value, source.replace("1. code", "1. code    "));
  });
  it("inserts a parent without changing its children's own sequences", () => {
    const source = "1. A\n    1. childA\n2. B\n    1. childB\n    2. childB\n3. C";
    const caret = source.indexOf("\n    1");
    assert.equal(apply(source, continueMarkdownList(source, caret, caret)).value,
      "1. A\n2. \n    1. childA\n3. B\n    1. childB\n    2. childB\n4. C");
  });
});
