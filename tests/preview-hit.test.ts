import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { emptyPreviewHit } from "../src/ui/preview-hit.ts";

function fixture(html: string) {
  const { document } = parseHTML(`<div id="surface">${html}</div>`);
  const doc = document as unknown as Document;
  const surface = doc.getElementById("surface")!;
  const rect = { left: 10, right: 100, top: 10, bottom: 30, width: 90, height: 20 } as DOMRect;
  doc.createRange = (() => ({ selectNodeContents() {}, getClientRects: () => [rect] })) as unknown as typeof doc.createRange;
  for (const element of surface.querySelectorAll<HTMLElement>("*")) element.getClientRects = () => [rect] as unknown as DOMRectList;
  const hit = (target: HTMLElement, x: number, y: number) => emptyPreviewHit(surface, { target, clientX: x, clientY: y } as unknown as MouseEvent);
  return { surface, hit };
}
describe("Preview content geometry", () => {
  it("allows an empty note background", () => {
    const { surface, hit } = fixture(""); assert.equal(hit(surface, 200, 200), true);
  });
  it("allows below-text and paragraph-side empty space in a nonempty note", () => {
    const { surface, hit } = fixture("<p>text</p>");
    assert.equal(hit(surface, 50, 200), true);
    assert.equal(hit(surface.firstElementChild as HTMLElement, 200, 20), true);
    assert.equal(hit(surface.firstElementChild as HTMLElement, 50, 20), false);
  });
  for (const html of ["<h2>heading</h2>", "<p><strong>bold</strong></p>", "<ul><li>item</li></ul>", "<blockquote>quote</blockquote>", "<section><span>unknown structural content</span></section>"]) {
    it(`protects rendered text without a tag allowlist: ${html}`, () => {
      const { surface, hit } = fixture(html); assert.equal(hit(surface.firstElementChild as HTMLElement, 50, 20), false);
    });
  }
  for (const html of ["<a href='#'>link</a>", "<pre><code>code</code></pre>", "<table><tr><td>table</td></tr></table>"]) {
    it(`protects interactive/painted block surfaces: ${html}`, () => {
      const { surface, hit } = fixture(html); assert.equal(hit(surface.firstElementChild as HTMLElement, 200, 20), false);
    });
  }
  it("protects non-text leaves such as rules and images", () => {
    const { surface, hit } = fixture("<hr><img>"); assert.equal(hit(surface, 50, 20), false);
  });
});
