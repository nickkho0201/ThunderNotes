import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

import {
  isSafeUrl,
  markdownToPlainText,
  parseMarkdown,
  sanitizeHtml,
} from "../src/markdown/markdown.ts";

const { document } = parseHTML("<!doctype html><html><body></body></html>");

function render(markdown: string, options = {}): string {
  return parseMarkdown(markdown, options, document).html;
}

describe("markdown: sanitizer", () => {
  it("drops scripts, styles and other dangerous elements", () => {
    const html = sanitizeHtml(
      '<p>ok</p><script>alert(1)</script><style>body{}</style><iframe src="https://x"></iframe>',
      document
    );
    assert.match(html, /<p>ok<\/p>/);
    assert.ok(!html.includes("<script"), html);
    assert.ok(!html.includes("<style"), html);
    assert.ok(!html.includes("<iframe"), html);
    assert.ok(!html.includes("alert(1)"), html);
  });

  it("strips event handler attributes", () => {
    const html = sanitizeHtml('<img src="a.png" onerror="alert(1)" onload="x()">', document);
    assert.ok(!html.includes("onerror"), html);
    assert.ok(!html.includes("onload"), html);
    assert.match(html, /src="a\.png"/);
  });

  it("removes javascript: and data: URLs", () => {
    const html = sanitizeHtml(
      '<a href="javascript:alert(1)">a</a><a href="data:text/html,x">b</a><img src="data:image/svg+xml,x">',
      document
    );
    assert.ok(!html.includes("javascript:"), html);
    assert.ok(!html.includes("data:"), html);
  });

  it("keeps safe URL schemes and relative references", () => {
    const html = sanitizeHtml(
      '<a href="https://example.com">a</a><a href="mailto:x@y.z">b</a><a href="./rel.html">c</a><a href="#frag">d</a>',
      document
    );
    assert.match(html, /href="https:\/\/example\.com"/);
    assert.match(html, /href="mailto:x@y\.z"/);
    assert.match(html, /href="\.\/rel\.html"/);
    assert.match(html, /href="#frag"/);
  });

  it("adds rel=noreferrer noopener to links and keeps it across passes", () => {
    const html = sanitizeHtml('<a href="https://example.com">a</a>', document);
    assert.match(html, /rel="noreferrer noopener"/);
    // Re-sanitising must not strip it (which is what a non-idempotent allowlist
    // would do) and must not duplicate it.
    const again = sanitizeHtml(html, document);
    assert.equal(again, html);
    assert.equal((again.match(/rel=/g) ?? []).length, 1);
  });

  it("drops unsafe rel values", () => {
    const html = sanitizeHtml('<a href="https://example.com" rel="opener">a</a>', document);
    assert.ok(!html.includes('"opener"'), html);
    assert.match(html, /rel="noreferrer noopener"/);
  });

  it("removes HTML comments", () => {
    const html = sanitizeHtml("<p>a</p><!--[if IE]><script>x</script><![endif]--><p>b</p>", document);
    assert.ok(!html.includes("<!--"), html);
    assert.ok(!html.includes("<![endif]"), html);
    assert.match(html, /<p>a<\/p>/);
    assert.match(html, /<p>b<\/p>/);
  });

  it("unwraps unknown tags but keeps their text", () => {
    const html = sanitizeHtml("<custom-tag>keep me</custom-tag>", document);
    assert.ok(!html.includes("custom-tag"), html);
    assert.match(html, /keep me/);
  });

  it("is idempotent (re-sanitising changes nothing)", () => {
    const once = sanitizeHtml('<p>hi <a href="https://a.b">l</a></p>', document);
    const twice = sanitizeHtml(once, document);
    assert.equal(twice, once);
  });
});

describe("markdown: isSafeUrl", () => {
  it("accepts relative and allowlisted absolute URLs", () => {
    for (const url of ["https://x.y", "http://x.y", "mailto:a@b.c", "tel:+1", "#anchor", "a/b.png", "/root.png"]) {
      assert.equal(isSafeUrl(url), true, url);
    }
  });

  it("rejects active-content schemes and blanks", () => {
    for (const url of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<b>", "blob:https://x/y", "file:///c:/x", "vbscript:x", "", "   "]) {
      assert.equal(isSafeUrl(url), false, url);
    }
  });

  it("sees through embedded control characters", () => {
    assert.equal(isSafeUrl("java\tscript:alert(1)"), false);
    assert.equal(isSafeUrl("java\nscript:alert(1)"), false);
  });
});

describe("markdown: rendering", () => {
  it("renders the core Markdown constructs", () => {
    const html = render(
      [
        "# Heading",
        "",
        "Some **bold**, *italic* and `code`.",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "2. second",
        "",
        "> quoted",
        "",
        "```js",
        "const x = 1;",
        "```",
        "",
        "[link](https://example.com)",
      ].join("\n")
    );

    assert.match(html, /<h1[^>]*>Heading<\/h1>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<em>italic<\/em>/);
    assert.match(html, /<code>code<\/code>/);
    assert.match(html, /<ul>[\s\S]*<li>one<\/li>/);
    assert.match(html, /<ol>[\s\S]*<li>first<\/li>/);
    assert.match(html, /<blockquote>/);
    assert.match(html, /<pre><code/);
    assert.match(html, /<a [^>]*href="https:\/\/example\.com"[^>]*>link<\/a>/);
  });

  it("never emits raw HTML from the note body", () => {
    const raw = '<div onclick="x">nope</div>\n\n<script>alert(1)</script>';
    const html = render(raw);
    // Everything is escaped text: a tag needs an unescaped `<`, so no element
    // (and therefore no attribute) can survive.
    assert.ok(!html.includes("<div"), html);
    assert.ok(!html.includes("<script"), html);
    assert.ok(!html.includes("<"), "the output must contain no markup at all");
    assert.match(html, /&lt;div/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;\/div&gt;/);
  });

  it("keeps the language hint on fenced code blocks", () => {
    assert.match(render("```python\nprint(1)\n```"), /class="language-python"/);
  });

  it("drops a bogus language hint class", () => {
    const html = render("```\" onload=alert(1)\nx\n```");
    assert.ok(!html.includes("onload"), html);
  });

  it("flags raw HTML in the result metadata", () => {
    assert.equal(parseMarkdown("<b>hi</b>", {}, document).hadRawHtml, true);
    assert.equal(parseMarkdown("plain text", {}, document).hadRawHtml, false);
  });

  it("renders an empty document for empty input", () => {
    assert.equal(render(""), "");
  });

  it("converts to plain text for future export features", () => {
    assert.equal(markdownToPlainText("**bold** text").trim(), "bold text");
  });
});
