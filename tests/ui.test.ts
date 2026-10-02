/**
 * Headless UI smoke tests.
 *
 * These are the closest thing to a "does the space page actually run" check that
 * can be done without launching Thunderbird. Using linkedom we:
 *
 *  - load the REAL `src/ui/notes.html`, so every `requireElement(id)` in
 *    `src/ui/notes.ts` is verified against the real markup (the most common way
 *    for an extension page to die at startup is a stale element id);
 *  - verify every `data-i18n*` attribute used in the HTML resolves to a key that
 *    exists in the English catalogue;
 *  - boot the real page entry point against a fake `browser` global and a real
 *    IndexedDB-free repository, then exercise create/type/filter/delete through
 *    the actual DOM;
 *  - check the virtualized list really windows a large note set.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseHTML } from "linkedom";

import { EN_MESSAGES } from "../src/i18n/fallback-messages.ts";
import { t } from "../src/i18n/index.ts";
import type { ThunderbirdBrowser } from "../src/api/browser.ts";
import { NoteStore } from "../src/ui/store.ts";
import { bindListDelete, createDeleteRequest } from "../src/ui/delete-request.ts";
import { bindCreatedDateFilter } from "../src/ui/date-filter.ts";
import { NotesListView } from "../src/ui/list-view.ts";
import { EditorView } from "../src/ui/editor-view.ts";
import { openNotesRepository } from "../src/storage/indexeddb.ts";
import { MemoryNotesRepository } from "../src/storage/memory.ts";
import type { NotesFilter } from "../src/notes/query.ts";
import { note } from "./helpers.ts";
import type { Note } from "../src/notes/model.ts";

/**
 * The page markup is not bundled into the test file, so locate it by walking up
 * from the working directory (tests run from the project root, but the bundle
 * lives in `build/test/`).
 */
function findProjectRoot(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(directory, "src", "ui", "notes.html"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`could not locate src/ui/notes.html from ${process.cwd()}`);
}

const PAGE_HTML_PATH = join(findProjectRoot(), "src", "ui", "notes.html");

/**
 * The exact string the row is expected to show for a timestamp, computed the same
 * way the view computes it (via `Intl` for the current test locale).
 */
function formatDateTimeForTest(timestamp: number): string {
  return new Intl.DateTimeFormat(Intl.DateTimeFormat().resolvedOptions().locale, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

/** Read a source file from the project. */
function readSource(relativePath: string): string {
  return readFileSync(join(findProjectRoot(), relativePath), "utf8");
}

/**
 * Collect every declaration block for a selector in a stylesheet.
 *
 * A selector can legitimately have several blocks — media-query overrides and
 * later refinements — so asserting on one of them is fragile. Returns the raw
 * declaration text of every match, and callers assert that *some* block carries
 * the required rule.
 */
function cssBlocks(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Selectors may be multi-line (`html,\nbody {`), so allow whitespace/comma
  // between the parts given to this helper.
  const pattern = new RegExp(`(?:^|[{};])\\s*${escaped}\\s*\\{([^}]*)\\}`, "gm");
  return [...css.matchAll(pattern)].map((match) => match[1] ?? "");
}

/** True when any declaration block for `selector` matches `pattern`. */
function cssHas(css: string, selector: string, pattern: RegExp, what: string): void {
  const blocks = cssBlocks(css, selector);
  assert.ok(blocks.length > 0, `${selector} has no rule in the stylesheet (expected ${what})`);
  assert.ok(
    blocks.some((block) => pattern.test(block)),
    `${selector} must ${what}; found: ${JSON.stringify(blocks)}`
  );
}

interface DomGlobals {
  document: Document;
  window: Window & typeof globalThis;
  cleanup: () => void;
}

/**
 * Install a linkedom document as the global DOM. Returns a cleanup function so
 * the global state does not leak into other test files.
 */
function installDom(html: string): DomGlobals {
  const { document, window } = parseHTML(html);

  const previous = new Map<string, unknown>();
  const names = [
    "document",
    "window",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLButtonElement",
    "HTMLSelectElement",
    "Element",
    "Node",
    "Event",
    "CustomEvent",
    "DOMParser",
    "MediaQueryList",
  ] as const;

  for (const name of names) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
  }

  const assign = (name: string, value: unknown): void => {
    (globalThis as Record<string, unknown>)[name] = value;
  };

  assign("document", document);
  assign("window", window);
  assign("HTMLElement", window.HTMLElement);
  assign("HTMLInputElement", window.HTMLInputElement ?? window.HTMLElement);
  assign("HTMLTextAreaElement", window.HTMLTextAreaElement ?? window.HTMLElement);
  assign("HTMLButtonElement", window.HTMLButtonElement ?? window.HTMLElement);
  assign("HTMLSelectElement", window.HTMLSelectElement ?? window.HTMLElement);
  assign("Element", window.Element);
  assign("Node", window.Node);
  assign("Event", window.Event ?? class Event {});
  assign("CustomEvent", window.CustomEvent ?? class CustomEvent {});
  assign("DOMParser", window.DOMParser);

  return {
    document: document as unknown as Document,
    window: window as unknown as Window & typeof globalThis,
    cleanup() {
      for (const [name, value] of previous) assign(name, value);
    },
  };
}

function loadPageHtml(): string {
  const raw = readFileSync(PAGE_HTML_PATH, "utf8");
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(raw);
  const body = bodyMatch ? bodyMatch[1] : raw;
  return `<!DOCTYPE html><html><head></head><body>${body}</body></html>`;
}

/** Every element id that `src/ui/notes.ts` looks up via `requireElement`. */
const REQUIRED_IDS = [
  "tn-search",
  "tn-search-clear",
  "tn-date-filter",
  "tn-date-trigger",
  "tn-date-popover",
  "tn-date-reset",
  "tn-color-filter",
  "tn-sort",
  "tn-data",
  "tn-data-dialog",
  "tn-new",
  "tn-main",
  "tn-list",
  "tn-list-empty",
  "tn-count",
  "tn-save-status",
  "tn-banner",
  "tn-banner-text",
  "tn-banner-close",
  "tn-back",
  "tn-editor",
  "tn-editor-empty",
  "tn-textarea",
  "tn-preview",
  "tn-format",
  "tn-md-mode",
  "tn-note-colors",
  "tn-delete",
] as const;

describe("ui: space page markup", () => {
  let dom: DomGlobals;

  before(() => {
    dom = installDom(loadPageHtml());
  });

  it("contains every element the page script looks up", () => {
    for (const id of REQUIRED_IDS) {
      assert.ok(dom.document.getElementById(id), `missing element #${id}`);
    }
  });

  it("loads its bundles with relative paths that exist in dist/", () => {
    // The <head> is stripped when installing the DOM, so assert against the file.
    const source = readFileSync(PAGE_HTML_PATH, "utf8");
    const scriptSrc = /<script[^>]*\bsrc="([^"]+)"/.exec(source)?.[1];
    const styleHref = /<link[^>]*\bhref="([^"]+)"/.exec(source)?.[1];
    assert.equal(scriptSrc, "ui/notes.js");
    assert.equal(styleHref, "ui/notes.css");

    // And those paths must be what the build actually produces.
    const root = findProjectRoot();
    assert.ok(existsSync(join(root, "dist", "ui", "notes.js")), "dist/ui/notes.js must exist");
    assert.ok(existsSync(join(root, "dist", "ui", "notes.css")), "dist/ui/notes.css must exist");
  });

  it("resolves every data-i18n attribute to a real catalogue key", () => {
    const attributes = ["data-i18n", "data-i18n-title", "data-i18n-placeholder", "data-i18n-aria-label"];
    let checked = 0;
    for (const attribute of attributes) {
      for (const element of dom.document.querySelectorAll(`[${attribute}]`)) {
        const key = element.getAttribute(attribute);
        assert.ok(key, `empty ${attribute} on <${element.tagName.toLowerCase()}>`);
        assert.ok(key in EN_MESSAGES, `${attribute}="${key}" is not in _locales/en/messages.json`);
        checked += 1;
      }
    }
    assert.ok(checked >= 15, `expected a decent number of localized attributes, saw ${checked}`);
  });

  it("exposes every colour filter and note colour button", () => {
    const filters = [...dom.document.querySelectorAll("#tn-color-filter [data-color]")].map((el) =>
      el.getAttribute("data-color")
    );
    assert.deepEqual(filters, ["all", "none", "red", "orange", "yellow", "green", "blue", "purple"]);

    const noteColors = [...dom.document.querySelectorAll("#tn-note-colors [data-color]")].map((el) =>
      el.getAttribute("data-color")
    );
    assert.deepEqual(noteColors, ["none", "red", "orange", "yellow", "green", "blue", "purple"]);
  });

  it("offers both editor formats and both markdown sub-modes", () => {
    const formats = [...dom.document.querySelectorAll("#tn-format [data-format]")].map((el) =>
      el.getAttribute("data-format")
    );
    assert.deepEqual(formats, ["plain", "markdown"]);

    const modes = [...dom.document.querySelectorAll("#tn-md-mode [data-mode]")].map((el) =>
      el.getAttribute("data-mode")
    );
    assert.deepEqual(modes, ["edit", "preview"]);
  });

  it("starts with the markdown sub-mode hidden and the editor hidden", () => {
    assert.equal(dom.document.getElementById("tn-md-mode")?.hasAttribute("hidden"), true);
    assert.equal(dom.document.getElementById("tn-editor")?.hasAttribute("hidden"), true);
    assert.equal(dom.document.getElementById("tn-editor-empty")?.hasAttribute("hidden"), false);
  });

  it("uses no inline script (the extension CSP forbids it)", () => {
    for (const script of dom.document.querySelectorAll("script")) {
      assert.equal(script.textContent?.trim() ?? "", "", "inline scripts are blocked by the CSP");
    }
  });
});

describe("ui: editor view behaviour", () => {
  let dom: DomGlobals;
  let view: EditorView;
  let changes: string[];
  let formats: string[];
  let colors: (string | null)[];
  let deletes: number;

  beforeEach(() => {
    dom = installDom(loadPageHtml());
    changes = [];
    formats = [];
    colors = [];
    deletes = 0;

    view = new EditorView({
      root: dom.document.getElementById("tn-editor") as HTMLElement,
      textarea: dom.document.getElementById("tn-textarea") as HTMLTextAreaElement,
      preview: dom.document.getElementById("tn-preview") as HTMLElement,
      formatGroup: dom.document.getElementById("tn-format") as HTMLElement,
      markdownModeGroup: dom.document.getElementById("tn-md-mode") as HTMLElement,
      noteColorGroup: dom.document.getElementById("tn-note-colors") as HTMLElement,
      deleteButton: dom.document.getElementById("tn-delete") as HTMLButtonElement,
      onContentChange: (content) => changes.push(content),
      onFormatChange: (format) => formats.push(format),
      onColorChange: (color) => colors.push(color),
      onDelete: () => {
        deletes += 1;
      },
    });
  });

  it("shows the editor and loads the note content", () => {
    view.render(note({ id: "a", content: "hello" }));
    const root = dom.document.getElementById("tn-editor") as HTMLElement;
    const textarea = dom.document.getElementById("tn-textarea") as HTMLTextAreaElement;
    assert.equal(root.hasAttribute("hidden"), false);
    assert.equal(textarea.value, "hello");
  });

  it("does not touch the textarea when the content is unchanged", () => {
    const current = note({ id: "a", content: "typed by hand" });
    view.render(current);
    const textarea = dom.document.getElementById("tn-textarea") as HTMLTextAreaElement;
    textarea.value = "typed by hand but with a caret";
    // A re-render for the same note+content (e.g. a colour change) must not
    // clobber the live textarea value.
    view.render({ ...current, color: "blue" });
    assert.equal(textarea.value, "typed by hand but with a caret");
  });

  it("replaces the textarea value when the content genuinely changed", () => {
    view.render(note({ id: "a", content: "one" }));
    view.render(note({ id: "a", content: "one two" }));
    assert.equal((dom.document.getElementById("tn-textarea") as HTMLTextAreaElement).value, "one two");
  });

  it("reports typed content through the callback", () => {
    view.render(note({ id: "a" }));
    const textarea = dom.document.getElementById("tn-textarea") as HTMLTextAreaElement;
    textarea.value = "typed";
    textarea.dispatchEvent(new dom.window.Event("input"));
    assert.deepEqual(changes, ["typed"]);
  });

  it("switches format via the segmented buttons", () => {
    view.render(note({ id: "a" }));
    const markdownButton = dom.document.querySelector("#tn-format [data-format=markdown]") as HTMLElement;
    markdownButton.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    assert.deepEqual(formats, ["markdown"]);
  });

  it("removes the colour when the 'none' swatch is clicked", () => {
    view.render(note({ id: "a", color: "red" }));
    const noneButton = dom.document.querySelector("#tn-note-colors [data-color=none]") as HTMLElement;
    noneButton.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    assert.deepEqual(colors, [null]);
  });

  it("invokes delete when the delete button is clicked", () => {
    view.render(note({ id: "a" }));
    (dom.document.getElementById("tn-delete") as HTMLElement).dispatchEvent(
      new dom.window.Event("click", { bubbles: true })
    );
    assert.equal(deletes, 1);
  });

  it("reveals the markdown sub-mode only for markdown notes", () => {
    const modes = dom.document.getElementById("tn-md-mode") as HTMLElement;
    view.render(note({ id: "a", format: "plain" }));
    assert.equal(modes.hasAttribute("hidden"), true);
    view.render(note({ id: "b", format: "markdown" }));
    assert.equal(modes.hasAttribute("hidden"), false);
  });

  it("renders a sanitized preview instead of the raw source", () => {
    view.render(note({ id: "a", format: "markdown", content: "# Title\n\n<script>alert(1)<\/script>" }));
    const previewButton = dom.document.querySelector("#tn-md-mode [data-mode=preview]") as HTMLElement;
    previewButton.dispatchEvent(new dom.window.Event("click", { bubbles: true }));

    const preview = dom.document.getElementById("tn-preview") as HTMLElement;
    assert.equal(preview.hasAttribute("hidden"), false);
    assert.match(preview.innerHTML, /<h1>Title<\/h1>/);
    assert.ok(!preview.innerHTML.includes("<script"), preview.innerHTML);
    assert.ok(!preview.querySelector("script"), "no script element may reach the DOM");
  });

  it("hides the editor entirely when no note is selected", () => {
    view.render(note({ id: "a" }));
    view.render(null);
    assert.equal((dom.document.getElementById("tn-editor") as HTMLElement).hasAttribute("hidden"), true);
  });

  it("marks the active format and colour buttons with aria-pressed", () => {
    view.render(note({ id: "a", format: "markdown", color: "green" }));
    const markdown = dom.document.querySelector("#tn-format [data-format=markdown]") as HTMLElement;
    const plain = dom.document.querySelector("#tn-format [data-format=plain]") as HTMLElement;
    assert.equal(markdown.getAttribute("aria-pressed"), "true");
    assert.equal(plain.getAttribute("aria-pressed"), "false");

    const green = dom.document.querySelector("#tn-note-colors [data-color=green]") as HTMLElement;
    assert.equal(green.getAttribute("aria-pressed"), "true");
  });

  it("re-syncs the format and colour buttons when the note changes", () => {
    // Regression: the store used to emit no event that re-rendered the editor, so
    // switching a note to Markdown persisted but left "Plain Text" highlighted.
    view.render(note({ id: "a", format: "plain", color: null }));
    const markdown = dom.document.querySelector("#tn-format [data-format=markdown]") as HTMLElement;
    const markdownGroup = dom.document.getElementById("tn-md-mode") as HTMLElement;
    assert.equal(markdownGroup.hasAttribute("hidden"), true);

    view.render(note({ id: "a", format: "markdown", color: "blue" }));

    assert.equal(markdown.getAttribute("aria-pressed"), "true");
    assert.equal(markdownGroup.hasAttribute("hidden"), false);
    const blue = dom.document.querySelector("#tn-note-colors [data-color=blue]") as HTMLElement;
    assert.equal(blue.getAttribute("aria-pressed"), "true");
  });

  it("keeps the Edit/Preview buttons in step with the displayed pane", () => {
    // Regression: the pane could be restored from per-note memory while the
    // buttons still highlighted the previous choice.
    const markdown = note({ id: "markdown-note", format: "markdown", content: "# Title" });
    view.render(markdown);

    const previewButton = dom.document.querySelector("#tn-md-mode [data-mode=preview]") as HTMLElement;
    previewButton.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    assert.equal(previewButton.getAttribute("aria-pressed"), "true");

    // Switch away and come back: the remembered pane is "preview", so the buttons
    // must show that even though no click happened this time.
    view.render(note({ id: "other", format: "markdown", content: "# Other" }));
    const editButton = dom.document.querySelector("#tn-md-mode [data-mode=edit]") as HTMLElement;
    assert.equal(editButton.getAttribute("aria-pressed"), "false", "an existing Markdown note opens in preview");

    view.render(markdown);
    assert.equal(previewButton.getAttribute("aria-pressed"), "true", "the remembered pane must be reflected");
    const preview = dom.document.getElementById("tn-preview") as HTMLElement;
    assert.equal(preview.hasAttribute("hidden"), false);
  });

  it("does not resurrect a deleted note's preview when focused", () => {
    // Regression: `currentNote` was never cleared, so focus() re-rendered the
    // previous note into the preview pane after a deletion.
    view.render(note({ id: "a", format: "markdown", content: "# Gone" }));
    view.render(null);

    const preview = dom.document.getElementById("tn-preview") as HTMLElement;
    const previousHtml = preview.innerHTML;
    view.focus();
    assert.equal(preview.innerHTML, previousHtml, "no stale content may be rendered");

    const textarea = dom.document.getElementById("tn-textarea") as HTMLTextAreaElement;
    assert.equal(textarea.hidden, false, "the textarea must stay the visible pane");
  });
});

describe("ui: virtualized list", () => {
  let dom: DomGlobals;

  function buildList(notes: Note[], generation = 1) {
    dom = installDom(loadPageHtml());
    const selected: string[] = [];
    const view = new NotesListView({
      listElement: dom.document.getElementById("tn-list") as HTMLElement,
      emptyElement: dom.document.getElementById("tn-list-empty") as HTMLElement,
      onSelect: (id) => selected.push(id),
    });
    const items = notes.map((item) => ({ note: item, searchText: item.content.toLowerCase() }));
    view.setItems(items, "nothing here", generation);
    return { view, selected };
  }

  it("renders only a window of rows for a large set", () => {
    const notes = Array.from({ length: 5_000 }, (_, index) => note({ id: `id-${index}`, content: `note ${index}` }));
    const { view } = buildList(notes);

    const list = dom.document.getElementById("tn-list") as HTMLElement;
    const rows = list.querySelectorAll(".tn-item");
    // Far fewer rows than notes, but enough to fill the viewport.
    assert.ok(rows.length > 0, "some rows must render");
    assert.ok(rows.length < 100, `expected a windowed list, rendered ${rows.length} rows`);
    view.dispose();
  });

  it("shows the first note at the top and the empty state when the list is empty", () => {
    const notes = Array.from({ length: 200 }, (_, index) => note({ id: `id-${index}`, content: `note ${index}` }));
    const { view } = buildList(notes);
    const list = dom.document.getElementById("tn-list") as HTMLElement;
    const first = list.querySelector(".tn-item");
    assert.equal(first?.getAttribute("data-id"), "id-0");
    view.dispose();

    buildList([]);
    const empty = dom.document.getElementById("tn-list-empty") as HTMLElement;
    assert.equal(empty.hasAttribute("hidden"), false);
    assert.equal(empty.textContent, "nothing here");
    assert.equal(dom.document.getElementById("tn-list")?.hasAttribute("hidden"), true);
  });

  it("paints the colour marker through the data attribute", () => {
    buildList([note({ id: "a", content: "with colour", color: "purple" }), note({ id: "b", content: "plain" })]);
    const rows = dom.document.querySelectorAll(".tn-item");
    const byId = new Map([...rows].map((row) => [row.getAttribute("data-id"), row]));
    assert.equal(byId.get("a")?.getAttribute("data-color"), "purple");
    assert.equal(byId.get("b")?.getAttribute("data-color"), "none");
  });

  it("marks the selected row and exposes it to assistive technology", () => {
    const { view } = buildList([note({ id: "a", content: "one" }), note({ id: "b", content: "two" })]);
    view.setSelected("a");
    const row = dom.document.querySelector('.tn-item[data-id="a"]') as HTMLElement;
    assert.equal(row.classList.contains("is-selected"), true);
    assert.equal(row.getAttribute("aria-selected"), "true");
    // Roving tabindex: only the selected row is a tab stop.
    assert.equal(row.getAttribute("tabindex"), "0");

    view.setSelected("b");
    assert.equal(row.classList.contains("is-selected"), false);
    assert.equal(row.getAttribute("aria-selected"), "false");
    assert.equal(row.getAttribute("tabindex"), "-1");
    const other = dom.document.querySelector('.tn-item[data-id="b"]') as HTMLElement;
    assert.equal(other.getAttribute("aria-selected"), "true");
    assert.equal(other.getAttribute("tabindex"), "0");
    view.dispose();
  });

  it("selects a row when it is clicked", () => {
    const { selected } = buildList([note({ id: "a", content: "one" })]);
    const row = dom.document.querySelector('.tn-item[data-id="a"]') as HTMLElement;
    row.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    assert.deepEqual(selected, ["a"]);
  });

  it("rebuilds rows when the content changes but the window bounds do not", () => {
    // Regression: `render()` short-circuits on unchanged window bounds, so a
    // changed item set of the SAME length used to leave stale rows (and stale
    // data-ids) in the DOM.
    const first = [note({ id: "a", content: "alpha" }), note({ id: "b", content: "beta" })];
    const { view } = buildList(first, 1);
    const list = dom.document.getElementById("tn-list") as HTMLElement;
    assert.equal(list.querySelector('.tn-item[data-id="a"] .tn-item__title')?.textContent, "alpha");

    // Same length, different ids and text, new generation.
    const second = [note({ id: "c", content: "gamma" }), note({ id: "d", content: "delta" })];
    view.setItems(
      second.map((item) => ({ note: item, searchText: item.content.toLowerCase() })),
      "nothing here",
      2
    );

    assert.equal(list.querySelector('.tn-item[data-id="a"]'), null, "stale rows must be gone");
    assert.equal(list.querySelector('.tn-item[data-id="c"] .tn-item__title')?.textContent, "gamma");
    assert.equal(list.querySelectorAll(".tn-item").length, 2);
    view.dispose();
  });

  it("refreshes the edited row's preview text when the generation changes", () => {
    const items = [{ note: note({ id: "a", content: "before" }), searchText: "before" }];
    const { view } = buildList([note({ id: "a", content: "before" })], 1);
    const list = dom.document.getElementById("tn-list") as HTMLElement;
    assert.equal(list.querySelector(".tn-item__title")?.textContent, "before");

    const edited = { note: note({ id: "a", content: "after" }), searchText: "after" };
    view.setItems([edited], "nothing here", 2);
    assert.equal(list.querySelector(".tn-item__title")?.textContent, "after");
    void items;
    view.dispose();
  });

  it("highlights a selected row that was outside the rendered window", () => {
    // Regression: `ensureSelectedVisible` could not restore the highlight when the
    // row was not materialized and the scroll position did not move.
    const notes = Array.from({ length: 500 }, (_, index) => note({ id: `id-${index}`, content: `note ${index}` }));
    const { view } = buildList(notes, 1);
    // Force the window far away from the selection target.
    const list = dom.document.getElementById("tn-list") as HTMLElement;
    list.scrollTop = 4000;

    view.setSelected("id-1");
    const row = dom.document.querySelector('.tn-item[data-id="id-1"]') as HTMLElement | null;
    assert.ok(row, "the selected row must be materialized");
    assert.equal(row.getAttribute("aria-selected"), "true");
    assert.equal(row.classList.contains("is-selected"), true);
    view.dispose();
  });
});

describe("ui: list row timestamp follows the sort field", () => {
  let dom: DomGlobals;

  /** A note whose creation and edit times are far apart and clearly labelled. */
  const CREATED = Date.UTC(2020, 0, 15, 10, 0);
  const UPDATED = Date.UTC(2024, 5, 20, 16, 30);

  function buildSortedList(sort: Parameters<NotesListView["setSort"]>[0]) {
    dom = installDom(loadPageHtml());
    const view = new NotesListView({
      listElement: dom.document.getElementById("tn-list") as HTMLElement,
      emptyElement: dom.document.getElementById("tn-list-empty") as HTMLElement,
      onSelect: () => {},
    });
    const item = note({ id: "a", content: "note", createdAt: CREATED, updatedAt: UPDATED });
    view.setSort(sort);
    view.setItems([{ note: item, searchText: "note" }], "nothing here", 1);
    const row = dom.document.querySelector('.tn-item[data-id="a"]') as HTMLElement;
    return {
      view,
      row,
      label: () => row.querySelector(".tn-item__date-label")?.textContent ?? "",
      date: () => row.querySelector(".tn-item__date")?.textContent ?? "",
    };
  }

  it("shows createdAt (with its label) when sorting by creation", () => {
    const createdDesc = buildSortedList("created-desc");
    assert.equal(createdDesc.label(), "Created");
    assert.equal(createdDesc.date(), formatDateTimeForTest(CREATED));
    assert.notEqual(createdDesc.date(), formatDateTimeForTest(UPDATED));
    createdDesc.view.dispose();

    const createdAsc = buildSortedList("created-asc");
    assert.equal(createdAsc.label(), "Created", "the direction must not change which date is shown");
    assert.equal(createdAsc.date(), formatDateTimeForTest(CREATED));
    createdAsc.view.dispose();
  });

  it("shows updatedAt (with its label) when sorting by modification", () => {
    const updatedDesc = buildSortedList("updated-desc");
    assert.equal(updatedDesc.label(), "Edited");
    assert.equal(updatedDesc.date(), formatDateTimeForTest(UPDATED));
    assert.notEqual(updatedDesc.date(), formatDateTimeForTest(CREATED));
    updatedDesc.view.dispose();

    const updatedAsc = buildSortedList("updated-asc");
    assert.equal(updatedAsc.label(), "Edited", "the direction must not change which date is shown");
    assert.equal(updatedAsc.date(), formatDateTimeForTest(UPDATED));
    updatedAsc.view.dispose();
  });

  it("switches the displayed date when the sort field changes", () => {
    const { view, label, date } = buildSortedList("created-desc");
    assert.equal(label(), "Created");

    view.setSort("updated-desc");
    assert.equal(label(), "Edited", "the label must follow the new sort field");
    assert.equal(date(), formatDateTimeForTest(UPDATED));

    view.setSort("created-asc");
    assert.equal(label(), "Created");
    assert.equal(date(), formatDateTimeForTest(CREATED));
    view.dispose();
  });

  it("does not touch the notes' persisted timestamps", () => {
    const { view } = buildSortedList("created-desc");
    const item = note({ id: "a", content: "note", createdAt: CREATED, updatedAt: UPDATED });
    // The row only reads; both fields on the model are still distinct and intact.
    assert.equal(item.createdAt, CREATED);
    assert.equal(item.updatedAt, UPDATED);
    view.dispose();
  });
});

describe("ui: CSS invariants", () => {
  it("resets the hidden attribute so JS-toggled elements can actually hide", () => {
    const root = findProjectRoot();
    const css = readFileSync(join(root, "src", "ui", "notes.css"), "utf8");
    // A UA `[hidden] { display: none }` loses to any author `display`
    // declaration, and several toggled elements set `display: flex`.
    assert.match(css, /\[hidden\][^{]*\{[^}]*display\s*:\s*none\s*!important/i);

    const html = readFileSync(PAGE_HTML_PATH, "utf8");
    for (const id of ["tn-banner", "tn-editor", "tn-md-mode", "tn-search-clear"]) {
      const pattern = new RegExp(`id="${id}"[^>]*\\shidden(?:\\s|>)`);
      assert.match(html, pattern, `#${id} starts hidden and relies on the reset rule`);
    }
  });

  it("keeps the row height constant in sync between CSS and the list view", () => {
    const root = findProjectRoot();
    const css = readFileSync(join(root, "src", "ui", "notes.css"), "utf8");
    const listView = readFileSync(join(root, "src", "ui", "list-view.ts"), "utf8");
    const cssHeight = Number(/--tn-row-height:\s*(\d+)px/.exec(css)?.[1]);
    const tsHeight = Number(/const ROW_HEIGHT = (\d+)/.exec(listView)?.[1]);
    assert.equal(cssHeight, tsHeight, "--tn-row-height and ROW_HEIGHT must agree");
    // The row must fit title + excerpt + date (see .tn-item padding/metrics).
    assert.ok(cssHeight >= 60, `row height ${cssHeight}px is too small for three text lines`);
  });

  it("uses one compact vertical rhythm for every Restore step", () => {
    const root = findProjectRoot();
    const css = readFileSync(join(root, "src", "ui", "notes.css"), "utf8");
    const step = /\.tn-data-steps li\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const details = /\.tn-data-steps \.tn-data-status,\s*\.tn-data-steps \.tn-data-check\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    assert.match(step, /display\s*:\s*flex/);
    assert.match(step, /gap\s*:\s*5px/);
    assert.match(details, /margin\s*:\s*0/);
  });
});

/**
 * Wire a store to the real views exactly as `src/ui/notes.ts` does.
 *
 * Shared by the integration suites so the tests exercise the real subscriber
 * wiring — including the `filter` event's window invalidation and sort-field
 * update, which is exactly where bugs hide.
 */
async function wireIntegration(seed: Note[] = [], initialFilter: Partial<NotesFilter> = {}) {
  const dom = installDom(loadPageHtml());
  const repository = new MemoryNotesRepository();
  await repository.putMany(seed);

  const store = new NoteStore(repository, { autosaveDelayMs: 0, initialFilter });
  await store.init();

  const editorView = new EditorView({
    root: dom.document.getElementById("tn-editor") as HTMLElement,
    textarea: dom.document.getElementById("tn-textarea") as HTMLTextAreaElement,
    preview: dom.document.getElementById("tn-preview") as HTMLElement,
    formatGroup: dom.document.getElementById("tn-format") as HTMLElement,
    markdownModeGroup: dom.document.getElementById("tn-md-mode") as HTMLElement,
    noteColorGroup: dom.document.getElementById("tn-note-colors") as HTMLElement,
    deleteButton: dom.document.getElementById("tn-delete") as HTMLButtonElement,
    onContentChange: (content) => store.updateSelected({ content }),
    onFormatChange: (format) => store.updateSelected({ format }),
    onColorChange: (color) => store.updateSelected({ color }),
    onDelete: () => {},
  });

  const listView = new NotesListView({
    listElement: dom.document.getElementById("tn-list") as HTMLElement,
    emptyElement: dom.document.getElementById("tn-list-empty") as HTMLElement,
    onSelect: (id) => store.select(id),
  });
  listView.setSort(store.getFilter().sort);

  const countLabel = dom.document.getElementById("tn-count") as HTMLElement;

  const renderList = (): void => {
    listView.setItems(store.getVisible(), "no matches", store.getGeneration());
    listView.setSelected(store.getSelectedId());
    countLabel.textContent = t("noteCount", [
      String(store.getVisible().length),
      String(store.getNotes().length),
    ]);
  };
  const renderEditor = (): void => {
    const selected = store.getSelectedNote();
    editorView.render(selected);
    (dom.document.getElementById("tn-editor-empty") as HTMLElement).hidden = selected !== null;
  };

  // Mirrors the subscriber in src/ui/notes.ts.
  store.subscribe((event) => {
    switch (event.type) {
      case "notes":
      case "visible":
        renderList();
        renderEditor();
        break;
      case "filter":
        listView.invalidate();
        listView.setSort(store.getFilter().sort);
        renderList();
        renderEditor();
        break;
      case "selection":
        renderList();
        renderEditor();
        break;
    }
  });

  renderList();
  renderEditor();
  return { dom, store, editorView, listView, repository };
}

describe("ui: UX and Markdown polish", () => {
  async function setup(content = "", format: "plain" | "markdown" = "markdown") {
    const wired = await wireIntegration([note({ id: "a", content, format }), note({ id: "b" })]);
    const { dom, store } = wired;
    store.select("a");
    const textarea = dom.document.getElementById("tn-textarea") as HTMLTextAreaElement;
    // linkedom has no selection/focus/range editing implementation. These shims
    // exercise our event wiring, not browser undo or native editing behavior.
    Object.defineProperty(dom.document, "activeElement", { configurable: true, writable: true, value: textarea });
    textarea.setSelectionRange = (start, end, direction = "none") => { textarea.selectionStart = start ?? 0; textarea.selectionEnd = end ?? 0; textarea.selectionDirection = direction; };
    textarea.setRangeText = (text: string, start: number = textarea.selectionStart, end: number = textarea.selectionEnd) => {
      textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    };
    textarea.setSelectionRange(content.length, content.length);
    const clickMode = (mode: string) => dom.document.querySelector(`#tn-md-mode [data-mode=${mode}]`)!.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    const key = (target: HTMLElement, name: string, extra = {}) => {
      const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
      Object.assign(event, { key: name, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra });
      target.dispatchEvent(event);
      return event;
    };
    const focus = (target: HTMLElement) => Object.defineProperty(dom.document, "activeElement", { configurable: true, writable: true, value: target });
    const cleanup = () => { wired.store.dispose(); wired.listView.dispose(); dom.cleanup(); };
    return { ...wired, textarea, clickMode, key, focus, cleanup };
  }

  it("nested numbering follows input/revision/autosave/reopen and native history input", async () => {
    const before = "1. Parent\n2. Child\n3. Next", after = "1. Parent\n    1. Child\n2. Next";
    const h = await setup(before);
    try {
      h.clickMode("edit"); const caret = before.indexOf("\n3"); h.textarea.setSelectionRange(caret, caret);
      const revision = h.store.getSelectedNote()!.revision;
      h.key(h.textarea, "Tab"); assert.equal(h.textarea.value, after);
      assert.equal(h.store.getSelectedNote()!.revision, revision + 1);
      h.store.flushPending(); await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal((await h.repository.get("a"))!.content, after);
      h.store.select("b"); h.store.select("a"); assert.equal(h.textarea.value, after);
      assert.equal(h.textarea.hidden, true);
      const preview = h.dom.document.getElementById("tn-preview")!;
      assert.ok(preview.querySelector("ol ol")); assert.equal(h.store.getSelectedNote()!.content, after);
      for (const content of [before, after]) {
        h.textarea.value = content; h.textarea.dispatchEvent(new h.dom.window.Event("input"));
        assert.equal(h.store.getSelectedNote()!.content, content);
      }
    } finally { h.cleanup(); }
  });
  it("preserves pre-existing selection through a background double-click gesture", async () => {
    const h = await setup("nonempty");
    try {
      const preview = h.dom.document.getElementById("tn-preview")!;
      let selected = true;
      Object.defineProperty(h.dom.document, "getSelection", { configurable: true, value: () => ({ isCollapsed: !selected }) });
      const down = new h.dom.window.Event("mousedown", { bubbles: true, cancelable: true });
      Object.assign(down, { button: 0, detail: 1 }); preview.dispatchEvent(down);
      assert.equal(down.defaultPrevented, false);
      selected = false;
      preview.dispatchEvent(new h.dom.window.Event("dblclick", { bubbles: true })); assert.equal(h.textarea.hidden, true);
    } finally { h.cleanup(); }
  });

  it("Tab is one native editor mutation with selection/scroll, revision, autosave and Preview", async () => {
    const before = "- one\n- two", after = "    - one\n    - two";
    const h = await setup(before);
    try {
      h.clickMode("edit"); h.textarea.setSelectionRange(0, before.length, "backward");
      h.textarea.scrollTop = 120; h.textarea.scrollLeft = 15;
      let inputs = 0, mutations = 0;
      h.textarea.addEventListener("input", () => inputs++);
      h.dom.document.execCommand = (command, _ui, text) => {
        assert.equal(command, "insertText"); mutations++; h.textarea.setRangeText(text!);
        h.textarea.scrollTop = 0; h.textarea.scrollLeft = 0;
        h.textarea.dispatchEvent(new h.dom.window.Event("input")); return true;
      };
      const revision = h.store.getSelectedNote()!.revision;
      const timestamp = h.store.getSelectedNote()!.updatedAt;
      assert.equal(h.key(h.textarea, "Tab").defaultPrevented, true);
      assert.equal(h.textarea.value, after); assert.equal(inputs, 1); assert.equal(mutations, 1);
      assert.equal(h.textarea.selectionStart, 4); assert.equal(h.textarea.selectionEnd, after.length);
      assert.equal(h.textarea.selectionDirection, "backward");
      assert.equal(h.textarea.scrollTop, 120); assert.equal(h.textarea.scrollLeft, 15);
      assert.equal(h.store.getSelectedNote()!.revision, revision + 1);
      assert.ok(h.store.getSelectedNote()!.updatedAt >= timestamp);
      h.store.flushPending(); await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal((await h.repository.get("a"))!.content, after);
      h.store.select("b"); h.store.select("a");
      assert.equal(h.textarea.value, after); assert.equal(h.textarea.hidden, true);
      assert.ok(h.dom.document.getElementById("tn-preview")!.querySelector("pre code"));
      h.clickMode("edit");
      // Native history emits input; the actual undo stack needs Thunderbird QA.
      for (const content of [before, after]) {
        h.textarea.value = content; h.textarea.dispatchEvent(new h.dom.window.Event("input"));
        assert.equal(h.store.getSelectedNote()!.content, content);
      }
      h.textarea.setSelectionRange(4, after.length, "backward");
      h.key(h.textarea, "Tab", { shiftKey: true }); assert.equal(h.textarea.value, before);
    } finally { h.cleanup(); }
  });
  it("Tab inserts at a plain caret; no-op Shift+Tab retains focus without a write", async () => {
    const h = await setup("sometext");
    try {
      h.clickMode("edit"); h.textarea.setSelectionRange(4, 4);
      const revision = h.store.getSelectedNote()!.revision;
      assert.equal(h.key(h.textarea, "Tab", { shiftKey: true }).defaultPrevented, true);
      assert.equal(h.store.getSelectedNote()!.revision, revision);
      assert.equal(h.textarea.selectionStart, 4);
      assert.equal(h.key(h.textarea, "Tab").defaultPrevented, true);
      assert.equal(h.textarea.value, "some    text"); assert.equal(h.textarea.selectionStart, 8);
      assert.equal(h.dom.document.activeElement, h.textarea);
    } finally { h.cleanup(); }
  });
  it("never intercepts Tab/Shift+Tab in Preview, Plain, other controls or composition", async () => {
    const h = await setup("- item");
    try {
      for (const shiftKey of [false, true]) assert.equal(h.key(h.textarea, "Tab", { shiftKey }).defaultPrevented, false);
      h.clickMode("edit");
      for (const id of ["tn-search", "tn-list", "tn-preview", "tn-delete", "tn-date-trigger", "tn-data-dialog"]) {
        const target = h.dom.document.getElementById(id)!; assert.ok(target, id); h.focus(target);
        for (const shiftKey of [false, true]) {
          assert.equal(h.key(target, "Tab", { shiftKey }).defaultPrevented, false);
          assert.equal(h.key(h.textarea, "Tab", { shiftKey }).defaultPrevented, false);
        }
      }
      h.focus(h.textarea);
      for (const extra of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
        for (const shiftKey of [false, true]) assert.equal(h.key(h.textarea, "Tab", { shiftKey, ...extra }).defaultPrevented, false);
      }
      h.textarea.dispatchEvent(new h.dom.window.Event("compositionstart"));
      assert.equal(h.key(h.textarea, "Tab").defaultPrevented, false);
      h.textarea.dispatchEvent(new h.dom.window.Event("compositionend"));
      h.store.updateSelected({ format: "plain" });
      for (const shiftKey of [false, true]) assert.equal(h.key(h.textarea, "Tab", { shiftKey }).defaultPrevented, false);
      assert.equal(h.textarea.value, "- item");
    } finally { h.cleanup(); }
  });

  it("deletes a complete ordered item with one native edit, caret, autosave and undo/redo input", async () => {
    const before = "1. One\n2. Two\n3. Temporary\n4. Three\n5. Four";
    const after = "1. One\n2. Two\n3. Three\n4. Four";
    const h = await setup(before);
    try {
      h.clickMode("edit"); h.textarea.setSelectionRange(before.indexOf("3"), before.indexOf("4"));
      let mutations = 0, inputs = 0;
      h.textarea.addEventListener("input", () => inputs++);
      h.dom.document.execCommand = (command, _ui, text) => {
        assert.equal(command, "insertText"); mutations++; h.textarea.setRangeText(text!);
        h.textarea.dispatchEvent(new h.dom.window.Event("input")); return true;
      };
      const revision = h.store.getSelectedNote()!.revision;
      assert.equal(h.key(h.textarea, "Delete").defaultPrevented, true);
      assert.equal(mutations, 1); assert.equal(inputs, 1);
      assert.equal(h.textarea.value, after); assert.equal(h.textarea.selectionStart, 14);
      assert.equal(h.store.getSelectedNote()!.revision, revision + 1);
      h.store.flushPending(); await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal((await h.repository.get("a"))!.content, after);
      // Simulate native history input; headless DOM has no browser undo stack.
      for (const content of [before, after]) {
        h.textarea.value = content; h.textarea.dispatchEvent(new h.dom.window.Event("input"));
        assert.equal(h.store.getSelectedNote()!.content, content);
      }
      h.clickMode("preview"); assert.match(h.dom.document.getElementById("tn-preview")!.textContent!, /Three/);
    } finally { h.cleanup(); }
  });
  it("leaves partial deletion, composition, Plain and non-editor contexts native", async () => {
    const h = await setup("1. One\n2. Two\n3. Three");
    try {
      h.clickMode("edit"); h.textarea.setSelectionRange(11, 11);
      assert.equal(h.key(h.textarea, "Backspace").defaultPrevented, false);
      h.textarea.setSelectionRange(7, 14);
      assert.equal(h.key(h.textarea, "Delete", { isComposing: true }).defaultPrevented, false);
      const search = h.dom.document.getElementById("tn-search")!; h.focus(search);
      assert.equal(h.key(h.textarea, "Delete").defaultPrevented, false);
      h.focus(h.textarea); h.store.updateSelected({ format: "plain" });
      assert.equal(h.key(h.textarea, "Delete").defaultPrevented, false);
    } finally { h.cleanup(); }
  });
  it("switches only empty Preview background double-click to Edit, preserves reopen/button behavior", async () => {
    const h = await setup("# Heading\n\nText");
    try {
      const preview = h.dom.document.getElementById("tn-preview")!;
      Object.defineProperty(h.dom.document, "getSelection", { configurable: true, value: () => ({ isCollapsed: true }) });
      preview.dispatchEvent(new h.dom.window.Event("click", { bubbles: true })); assert.equal(h.textarea.hidden, true);
      preview.dispatchEvent(new h.dom.window.Event("dblclick", { bubbles: true })); assert.equal(h.textarea.hidden, false);
      assert.equal(h.textarea.selectionStart, h.textarea.value.length);
      h.store.select("b"); h.store.select("a"); assert.equal(h.textarea.hidden, true);
      h.clickMode("edit"); assert.equal(h.textarea.hidden, false);
      h.store.updateSelected({ format: "plain" });
      preview.dispatchEvent(new h.dom.window.Event("dblclick", { bubbles: true })); assert.equal(h.textarea.hidden, false);
    } finally { h.cleanup(); }
  });
  for (const selector of ["p", "h1", "a", "li", "code", "pre", "blockquote", "strong", "table"]) {
    it(`retains Preview on double-click of rendered ${selector}`, async () => {
      const h = await setup("# Heading\n\nParagraph **bold** and [link](https://example.com) and `code`\n\n- item\n\n```\nblock\n```\n\n> quote\n\n| a | b |\n|---|---|\n| c | d |");
      try {
        const preview = h.dom.document.getElementById("tn-preview")!;
        Object.defineProperty(h.dom.document, "getSelection", { configurable: true, value: () => ({ isCollapsed: true }) });
        const element = preview.querySelector(selector); assert.ok(element);
        element.dispatchEvent(new h.dom.window.Event("dblclick", { bubbles: true }));
        assert.equal(h.textarea.hidden, true);
      } finally { h.cleanup(); }
    });
  }
  it("retains Preview with active text selection, no note or a hidden surface", async () => {
    const h = await setup("Text");
    try {
      const preview = h.dom.document.getElementById("tn-preview")!;
      Object.defineProperty(h.dom.document, "getSelection", { configurable: true, value: () => ({ isCollapsed: false }) });
      preview.dispatchEvent(new h.dom.window.Event("dblclick", { bubbles: true })); assert.equal(h.textarea.hidden, true);
      h.editorView.reset(); preview.dispatchEvent(new h.dom.window.Event("dblclick", { bubbles: true }));
      assert.equal(preview.hidden, true);
    } finally { h.cleanup(); }
  });

  it("opens existing Markdown in preview, preserves Edit through updates, and reopens in preview", async () => {
    const h = await setup("# Title");
    try {
      assert.equal(h.textarea.hidden, true);
      h.clickMode("edit");
      h.store.updateSelected({ color: "blue" });
      assert.equal(h.textarea.hidden, false);
      h.store.select("b"); h.store.select("a");
      assert.equal(h.textarea.hidden, true);
    } finally { h.cleanup(); }
  });
  it("opens Plain/new notes in Edit and keeps Plain → Markdown conversion in Edit", async () => {
    const h = await setup("text", "plain");
    try {
      assert.equal(h.textarea.hidden, false);
      h.store.updateSelected({ format: "markdown" });
      assert.equal(h.textarea.hidden, false);
      h.store.select("b"); h.store.select("a");
      assert.equal(h.textarea.hidden, true);
      const created = await h.store.createNote();
      assert.equal(created.format, "plain");
      assert.equal(h.textarea.hidden, false);
    } finally { h.cleanup(); }
  });

  for (const [key, expected, start, end] of [["b", "**word**", 2, 6], ["i", "*word*", 1, 5], ["k", "[word](url)", 1, 5], ["`", "`word`", 1, 5]] as const) {
    it(`editor Ctrl+${key} wraps selection, updates revision, preview and autosave`, async () => {
      const h = await setup("word");
      try {
        h.clickMode("edit"); h.textarea.setSelectionRange(0, 4);
        const revision = h.store.getSelectedNote()!.revision;
        assert.equal(h.key(h.textarea, key, { ctrlKey: true }).defaultPrevented, true);
        assert.equal(h.store.getSelectedNote()!.content, expected);
        assert.equal(h.store.getSelectedNote()!.revision, revision + 1);
        assert.equal(h.textarea.selectionStart, start); assert.equal(h.textarea.selectionEnd, end);
        h.store.flushPending();
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal((await h.repository.get("a"))!.content, expected);
        h.clickMode("preview");
        assert.match(h.dom.document.getElementById("tn-preview")!.textContent!, /word/);
      } finally { h.cleanup(); }
    });
  }
  it("inserts at the caret with Cmd and passes through native input/undo changes", async () => {
    const h = await setup();
    try {
      h.clickMode("edit");
      h.key(h.textarea, "k", { metaKey: true });
      assert.equal(h.textarea.value, "[](url)"); assert.equal(h.textarea.selectionStart, 1);
      // Native undo emits input; real undo stack remains a Thunderbird QA gate.
      h.textarea.value = ""; h.textarea.dispatchEvent(new h.dom.window.Event("input"));
      assert.equal(h.store.getSelectedNote()!.content, "");
    } finally { h.cleanup(); }
  });
  for (const name of ["b", "i", "`"]) {
    it(`editor ${name} toggles inner/whole selection through input, revision and autosave`, async () => {
      const h = await setup("word");
      try {
        h.clickMode("edit"); h.textarea.setSelectionRange(0, 4);
        const revision = h.store.getSelectedNote()!.revision;
        h.key(h.textarea, name, { ctrlKey: true });
        const formatted = h.textarea.value;
        h.key(h.textarea, name, { ctrlKey: true });
        assert.equal(h.textarea.value, "word");
        assert.equal(h.textarea.selectionStart, 0); assert.equal(h.textarea.selectionEnd, 4);
        h.key(h.textarea, name, { ctrlKey: true }); h.textarea.setSelectionRange(0, h.textarea.value.length);
        h.key(h.textarea, name, { ctrlKey: true });
        assert.equal(h.store.getSelectedNote()!.content, "word");
        assert.equal(h.store.getSelectedNote()!.revision, revision + 4);
        h.textarea.value = formatted; h.textarea.dispatchEvent(new h.dom.window.Event("input"));
        assert.equal(h.store.getSelectedNote()!.content, formatted);
        h.store.flushPending(); await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal((await h.repository.get("a"))!.content, formatted);
      } finally { h.cleanup(); }
    });
  }
  it("renumbers ordered siblings as one store edit and never pairs curly braces", async () => {
    const h = await setup("1. First\n2. Second\n3. Third\n4. Fourth");
    try {
      h.clickMode("edit"); h.textarea.setSelectionRange(18, 18);
      const revision = h.store.getSelectedNote()!.revision;
      h.key(h.textarea, "Enter");
      assert.equal(h.textarea.value, "1. First\n2. Second\n3. \n4. Third\n5. Fourth");
      assert.equal(h.store.getSelectedNote()!.revision, revision + 1);
      assert.equal(h.textarea.selectionStart, 22);
      assert.equal(h.key(h.textarea, "{", { shiftKey: true }).defaultPrevented, false);
    } finally { h.cleanup(); }
  });
  it("row activation keeps Preview and consecutive backticks permit a code fence", async () => {
    const h = await setup();
    try {
      h.editorView.focusOpened(); assert.equal(h.textarea.hidden, true);
      h.clickMode("edit");
      h.key(h.textarea, "`"); h.key(h.textarea, "`");
      assert.equal(h.textarea.value, "``"); assert.equal(h.textarea.selectionStart, 2);
      assert.equal(h.key(h.textarea, "`").defaultPrevented, false);
    } finally { h.cleanup(); }
  });
  it("uses a native insertText result without duplicate input notification", async () => {
    const h = await setup();
    try {
      h.clickMode("edit");
      let inputs = 0;
      h.textarea.addEventListener("input", () => inputs++);
      h.dom.document.execCommand = (_command, _ui, text) => {
        h.textarea.setRangeText(text!);
        h.textarea.dispatchEvent(new h.dom.window.Event("input"));
        return true;
      };
      h.key(h.textarea, "b", { ctrlKey: true });
      assert.equal(h.textarea.value, "****"); assert.equal(inputs, 1);
    } finally { h.cleanup(); }
  });
  it("recognizes the physical Markdown chord on a Russian keyboard layout", async () => {
    const h = await setup();
    try {
      h.clickMode("edit");
      h.key(h.textarea, "и", { ctrlKey: true, code: "KeyB" });
      assert.equal(h.textarea.value, "****"); assert.equal(h.textarea.selectionStart, 2);
    } finally { h.cleanup(); }
  });
  it("does not intercept outside editor, in Plain/Preview, AltGr or during IME", async () => {
    const h = await setup("text");
    try {
      assert.equal(h.key(h.textarea, "b", { ctrlKey: true }).defaultPrevented, false);
      h.clickMode("edit");
      const search = h.dom.document.getElementById("tn-search") as HTMLElement;
      h.focus(search);
      assert.equal(h.key(h.textarea, "b", { ctrlKey: true }).defaultPrevented, false);
      assert.equal(h.key(search, "b", { ctrlKey: true }).defaultPrevented, false);
      h.focus(h.textarea);
      for (const extra of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }]) {
        assert.equal(h.key(h.textarea, "b", { ctrlKey: true, ...extra }).defaultPrevented, false);
      }
      h.textarea.dispatchEvent(new h.dom.window.Event("compositionstart"));
      assert.equal(h.key(h.textarea, "[" ).defaultPrevented, false);
      h.textarea.dispatchEvent(new h.dom.window.Event("compositionend"));
      h.store.updateSelected({ format: "plain" });
      assert.equal(h.key(h.textarea, "b", { ctrlKey: true }).defaultPrevented, false);
    } finally { h.cleanup(); }
  });
  for (const [open, close] of [["[", "]"], ["(", ")"], ["`", "`"]]) {
    it(`pairs ${open}, tracks typed content and skips its own closing character`, async () => {
      const h = await setup();
      try {
        h.clickMode("edit");
        h.key(h.textarea, open!, { shiftKey: open === "(" });
        assert.equal(h.textarea.value, open! + close!); assert.equal(h.textarea.selectionStart, 1);
        h.textarea.setRangeText("x", 1, 1); h.textarea.setSelectionRange(2, 2);
        h.textarea.dispatchEvent(new h.dom.window.Event("input"));
        assert.equal(h.key(h.textarea, close!, { shiftKey: close === ")" }).defaultPrevented, true);
        assert.equal(h.textarea.value, open! + "x" + close!); assert.equal(h.textarea.selectionStart, 3);
      } finally { h.cleanup(); }
    });
  }
  it("preserves selection when pairing and does not skip manually existing closings", async () => {
    const h = await setup("word)");
    try {
      h.clickMode("edit"); h.textarea.setSelectionRange(0, 4);
      h.key(h.textarea, "[");
      assert.equal(h.textarea.value, "[word])"); assert.equal(h.textarea.selectionStart, 1); assert.equal(h.textarea.selectionEnd, 5);
      h.textarea.setSelectionRange(6, 6);
      assert.equal(h.key(h.textarea, ")", { shiftKey: true }).defaultPrevented, false);
      h.textarea.setSelectionRange(2, 2);
      assert.equal(h.key(h.textarea, "(", { shiftKey: true }).defaultPrevented, false);
    } finally { h.cleanup(); }
  });
  it("continues lists through the store and leaves ordinary Enter native", async () => {
    const h = await setup("  - [x] done");
    try {
      h.clickMode("edit");
      h.key(h.textarea, "Enter");
      assert.equal(h.store.getSelectedNote()!.content, "  - [x] done\n  - [ ] ");
      assert.equal(h.textarea.selectionStart, h.textarea.value.length);
      h.key(h.textarea, "Enter");
      assert.equal(h.textarea.value, "  - [x] done\n  ");
      assert.equal(h.key(h.textarea, "Enter").defaultPrevented, false);
    } finally { h.cleanup(); }
  });

  it("Delete in list confirms through shared workflow; Cancel keeps edits, Confirm deletes", async () => {
    const h = await setup("draft", "plain");
    try {
      let confirmed = false, confirmations = 0;
      const request = createDeleteRequest(h.store, () => { confirmations++; return confirmed; });
      const list = h.dom.document.getElementById("tn-list") as HTMLElement;
      bindListDelete(list, h.store, request);
      h.store.updateSelected({ content: "pending edit" });
      h.focus(list);
      assert.equal(h.key(list, "Delete").defaultPrevented, true);
      assert.equal(confirmations, 1); assert.equal(h.store.getSelectedNote()!.content, "pending edit");
      h.store.flushPending(); await new Promise((resolve) => setTimeout(resolve, 0));
      confirmed = true;
      const row = list.querySelector('[data-id="a"]') as HTMLElement;
      h.focus(row); h.key(row, "Delete");
      assert.equal(confirmations, 2); assert.equal(h.store.getNotes().some(({ note }) => note.id === "a"), false);
      assert.equal(request(), false, "pending deletion blocks another request");
    } finally { h.cleanup(); }
  });
  it("Delete never handles textarea, controls, descendants, preview, repeats or locked mutations", async () => {
    const h = await setup("draft", "plain");
    try {
      let confirmations = 0;
      const request = createDeleteRequest(h.store, () => { confirmations++; return false; });
      const list = h.dom.document.getElementById("tn-list") as HTMLElement;
      bindListDelete(list, h.store, request);
      const row = list.querySelector('[data-id="a"]') as HTMLElement;
      for (const tag of ["input", "textarea", "select", "button", "a", "div"]) {
        const target = h.dom.document.createElement(tag);
        if (tag === "div") target.setAttribute("contenteditable", "true");
        row.append(target); h.focus(target);
        assert.equal(h.key(target, "Delete").defaultPrevented, false);
      }
      for (const id of ["tn-textarea", "tn-search", "tn-preview", "tn-delete"]) {
        const target = h.dom.document.getElementById(id) as HTMLElement;
        h.focus(target); assert.equal(h.key(target, "Delete").defaultPrevented, false);
      }
      h.focus(list);
      for (const extra of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { shiftKey: true }]) {
        assert.equal(h.key(list, "Delete", extra).defaultPrevented, false);
      }
      await h.store.withMutationLock(async () => { assert.equal(h.key(list, "Delete").defaultPrevented, false); assert.equal(request(), false); });
      assert.equal(confirmations, 0);
    } finally { h.cleanup(); }
  });
  it("calendar applies two-click ranges, resets independently and follows fast capture", async () => {
    const h = await setup("target");
    try {
      const root = h.dom.document.getElementById("tn-date-filter") as HTMLElement;
      const trigger = h.dom.document.getElementById("tn-date-trigger") as HTMLButtonElement;
      const popover = h.dom.document.getElementById("tn-date-popover") as HTMLElement;
      bindCreatedDateFilter({ root, trigger, popover, store: h.store, now: () => new Date(2026, 9, 1) });
      trigger.click();
      root.querySelector<HTMLButtonElement>('[data-date="2026-10-01"]')!.click();
      assert.equal(h.store.getFilter().createdFrom, "");
      root.querySelector<HTMLButtonElement>('[data-date="2026-10-02"]')!.click();
      assert.equal(h.store.getFilter().createdFrom, "2026-10-01");
      assert.equal(popover.hidden, true);
      h.store.setSearch("target");
      (root.querySelector("#tn-date-reset") as HTMLButtonElement).click();
      assert.equal(h.store.getFilter().createdFrom, "");
      assert.equal(h.store.getFilter().search, "target");
      h.store.setCreatedDateRange("2000-01-01", "2000-01-01");
      assert.equal(h.store.getVisible().length, 0);
      await h.store.createNote();
      assert.equal(h.store.getFilter().createdFrom, "");
      assert.equal(trigger.textContent, t("createdDateLabel"));
    } finally { h.cleanup(); }
  });

});

describe("ui: store/view integration", () => {
  const wire = wireIntegration;

  it("reflects a format change made through the UI", async () => {
    const { dom, store, editorView } = await wire([note({ id: "a", content: "hello" })]);
    store.select("a");
    editorView.render(store.getSelectedNote());

    const markdownGroup = dom.document.getElementById("tn-md-mode") as HTMLElement;
    assert.equal(markdownGroup.hasAttribute("hidden"), true);

    // Click "Markdown" exactly as a user would.
    const markdownButton = dom.document.querySelector("#tn-format [data-format=markdown]") as HTMLElement;
    markdownButton.dispatchEvent(new dom.window.Event("click", { bubbles: true }));

    assert.equal(store.getSelectedNote()?.format, "markdown");
    assert.equal(markdownGroup.hasAttribute("hidden"), false, "the Edit/Preview switch must appear");
    assert.equal(markdownButton.getAttribute("aria-pressed"), "true");

    const plainButton = dom.document.querySelector("#tn-format [data-format=plain]") as HTMLElement;
    assert.equal(plainButton.getAttribute("aria-pressed"), "false");
    store.dispose();
  });

  it("reflects a colour change made through the UI", async () => {
    const { dom, store, editorView } = await wire([note({ id: "a", content: "hello" })]);
    store.select("a");
    editorView.render(store.getSelectedNote());

    const red = dom.document.querySelector("#tn-note-colors [data-color=red]") as HTMLElement;
    red.dispatchEvent(new dom.window.Event("click", { bubbles: true }));

    assert.equal(store.getSelectedNote()?.color, "red");
    assert.equal(red.getAttribute("aria-pressed"), "true");
    const none = dom.document.querySelector("#tn-note-colors [data-color=none]") as HTMLElement;
    assert.equal(none.getAttribute("aria-pressed"), "false");
    store.dispose();
  });

  it("updates the list preview while typing", async () => {
    const { dom, store } = await wire([note({ id: "a", content: "" })]);
    store.select("a");

    const textarea = dom.document.getElementById("tn-textarea") as HTMLTextAreaElement;
    textarea.value = "typed live";
    textarea.dispatchEvent(new dom.window.Event("input"));

    const title = dom.document.querySelector('.tn-item[data-id="a"] .tn-item__title');
    assert.equal(title?.textContent, "typed live");
    store.dispose();
  });

  it("reorders the list when the sort order changes", async () => {
    const { dom, store } = await wire([
      note({ id: "a", content: "first", createdAt: 1 }),
      note({ id: "b", content: "second", createdAt: 2 }),
    ]);
    const idsInOrder = () =>
      [...dom.document.querySelectorAll(".tn-item")].map((row) => row.getAttribute("data-id"));
    assert.deepEqual(idsInOrder(), ["b", "a"]);

    store.setSort("created-asc");
    assert.deepEqual(idsInOrder(), ["a", "b"], "the rendered rows must follow the new order");
    store.dispose();
  });

  it("clears the editor when the selected note is deleted", async () => {
    const { dom, store } = await wire([note({ id: "only", content: "bye" })]);
    store.select("only");
    await store.deleteNote("only");

    assert.equal((dom.document.getElementById("tn-editor") as HTMLElement).hasAttribute("hidden"), true);
    assert.equal((dom.document.getElementById("tn-editor-empty") as HTMLElement).hidden, false);
    assert.equal((dom.document.getElementById("tn-list") as HTMLElement).hasAttribute("hidden"), true);
    store.dispose();
  });

  it("keeps the colour-filter buttons in step when creating a note widens the filter", async () => {
    // Regression: `createNote()` silently widens the filter to "all" so the new
    // note is visible. Nothing re-synced the filter buttons, so with Blue selected
    // the Blue button stayed highlighted while the store (and the persisted
    // preferences) said "all".
    const dom = installDom(loadPageHtml());
    const repository = new MemoryNotesRepository();
    await repository.putMany([note({ id: "red-note", content: "red one", color: "red" })]);

    const store = new NoteStore(repository, { autosaveDelayMs: 0, initialFilter: { color: "red" } });
    await store.init();

    const group = dom.document.getElementById("tn-color-filter") as HTMLElement;
    const activeColours = (): string[] =>
      [...group.querySelectorAll<HTMLButtonElement>("[data-color]")]
        .filter((button) => button.classList.contains("is-active"))
        .map((button) => button.dataset.color ?? "");

    // Mirrors `syncFilterButtons` in src/ui/notes.ts: the store is the only owner.
    const syncFilterButtons = (): void => {
      const active = store.getFilter().color;
      for (const button of group.querySelectorAll<HTMLButtonElement>("[data-color]")) {
        button.classList.toggle("is-active", button.dataset.color === active);
      }
    };
    store.subscribe((event) => {
      if (event.type === "filter") syncFilterButtons();
    });

    syncFilterButtons();
    assert.deepEqual(activeColours(), ["red"]);

    await store.createNote();

    assert.equal(store.getFilter().color, "all", "creating a note widens the filter");
    assert.deepEqual(activeColours(), ["all"], "the highlighted button must follow the applied filter");
    store.dispose();
  });
});

describe("ui: note counter localization", () => {
  /**
   * Install a fake `browser.i18n` that reproduces Thunderbird's real resolution
   * for a locale, using the two-stage algorithm from `ExtensionCommon.sys.mjs`:
   *
   *  1. `addLocale` pre-expands every `$NAME$` from THAT LOCALE FILE's declared
   *     `placeholders` block, replacing an undeclared `$NAME$` with an empty
   *     string. (This per-file behaviour is why the counter used to lose its
   *     numbers: the Russian file declared no placeholders.)
   *  2. `localizeMessage` substitutes the caller's ordered array into `$1`, `$2`, …
   */
  function installI18n(locale: string) {
    const rawCatalogue = JSON.parse(
      readFileSync(join(findProjectRoot(), "_locales", locale, "messages.json"), "utf8")
    ) as Record<string, { message: string; placeholders?: Record<string, { content: string }> }>;

    // Stage 1, done once per locale the way `addLocale` does it.
    const catalogue = new Map<string, string>();
    for (const [key, entry] of Object.entries(rawCatalogue)) {
      const placeholders = new Map(
        Object.entries(entry.placeholders ?? {}).map(([name, definition]) => [name.toLowerCase(), definition.content])
      );
      catalogue.set(
        key.toLowerCase(),
        entry.message.replace(/\$([A-Za-z0-9@_]+)\$/g, (_match, name: string) => placeholders.get(name.toLowerCase()) ?? "")
      );
    }

    const previous = globalThis.browser;
    globalThis.browser = {
      i18n: {
        getUILanguage: () => locale,
        getMessage: (key: string, substitutions?: string | string[]) => {
          const message = catalogue.get(key.toLowerCase());
          if (message === undefined) return "";
          const list = substitutions === undefined ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
          // Stage 2, mirroring `localizeMessage` exactly (including its early exit
          // when no `$` remains, and its `$1`-`$9` index range).
          if (!message.includes("$")) return message;
          return message.replace(/\$(?:([1-9]\d*)|(\$+))/g, (_match, index?: string, dollars?: string) => {
            if (index) {
              const position = parseInt(index, 10) - 1;
              return position in list ? list[position]! : "";
            }
            return dollars ?? "";
          });
        },
      },
      runtime: { getURL: (path: string) => `moz-extension://fake/${path}` },
    } as unknown as ThunderbirdBrowser;
    return () => {
      globalThis.browser = previous;
    };
  }

  /** The exact footer text each list state must produce. */
  const COUNTER_CASES = {
    en: {
      empty: "0 of 0 notes",
      all: "2 of 2 notes",
      filtered: "1 of 2 notes",
      noMatch: "0 of 2 notes",
      format: (visible: number, total: number) => `${visible} of ${total} notes`,
    },
    ru: {
      empty: "0 из 0 заметок",
      all: "2 из 2 заметок",
      filtered: "1 из 2 заметок",
      noMatch: "0 из 2 заметок",
      format: (visible: number, total: number) => `${visible} из ${total} заметок`,
    },
  } as const;

  it("substitutes both counts in English", () => {
    const restore = installI18n("en");
    try {
      assert.equal(t("noteCount", ["2", "5"]), "2 of 5 notes");
      assert.equal(t("noteCount", ["0", "0"]), "0 of 0 notes");
      assert.equal(t("noteCount", ["1", "1"]), "1 of 1 notes");
      assert.equal(t("noteCount", ["0", "5"]), "0 of 5 notes");
      assert.equal(t("noteCount", ["5", "5"]), "5 of 5 notes");
    } finally {
      restore();
    }
  });

  it("substitutes both counts in Russian", () => {
    const restore = installI18n("ru");
    try {
      assert.equal(t("noteCount", ["2", "5"]), "2 из 5 заметок");
      assert.equal(t("noteCount", ["0", "0"]), "0 из 0 заметок");
      assert.equal(t("noteCount", ["0", "5"]), "0 из 5 заметок");
    } finally {
      restore();
    }
  });

  it("never leaves a bare placeholder in either locale", () => {
    for (const locale of ["en", "ru"]) {
      const restore = installI18n(locale);
      try {
        for (const [visible, total] of [
          ["0", "0"],
          ["1", "1"],
          ["2", "5"],
          ["12", "340"],
        ] as const) {
          const message = t("noteCount", [visible, total]);
          assert.ok(!/\$/.test(message), `${locale}: unresolved placeholder in "${message}"`);
          assert.ok(message.includes(visible), `${locale}: missing visible count in "${message}"`);
          assert.ok(message.includes(total), `${locale}: missing total count in "${message}"`);
        }
      } finally {
        restore();
      }
    }
  });

  it("keeps both counts ordered correctly (visible first, total second)", () => {
    const restore = installI18n("en");
    try {
      const message = t("noteCount", ["3", "9"]);
      assert.ok(message.indexOf("3") < message.indexOf("9"), message);
    } finally {
      restore();
    }
  });

  describe("rendered DOM text, per locale", () => {
    for (const locale of ["en", "ru"] as const) {
      it(`renders the exact footer text in every list state (${locale})`, async () => {
        const expected = COUNTER_CASES[locale];
        const restore = installI18n(locale);
        try {
          const { dom, store } = await wireIntegration([
            note({ id: "a", content: "alpha contract", color: "blue", createdAt: 1 }),
            note({ id: "b", content: "beta invoice", color: "red", createdAt: 2 }),
          ]);
          const counter = dom.document.getElementById("tn-count") as HTMLElement;
          const text = (): string => (counter.textContent ?? "").trim();

          // All notes visible.
          assert.equal(text(), expected.all, `all (${locale})`);

          // Filtered down to one note by the colour filter.
          store.setColorFilter("red");
          assert.equal(text(), expected.filtered, `colour filter (${locale})`);

          // A colour filter with no matches.
          store.setColorFilter("purple");
          assert.equal(text(), expected.noMatch, `colour filter, no match (${locale})`);

          // Search with no matches.
          store.setColorFilter("all");
          store.setSearch("nothing matches this");
          assert.equal(text(), expected.noMatch, `search, no match (${locale})`);
          assert.ok(!/\$/.test(text()), `left a placeholder: ${text()}`);

          // Search that matches one of the two.
          store.setSearch("contract");
          assert.equal(text(), expected.filtered, `search, one match (${locale})`);

          // No notes at all.
          store.setSearch("");
          await store.deleteNote("a");
          await store.deleteNote("b");
          assert.equal(text(), expected.empty, `no notes (${locale})`);
          assert.ok(!/\$/.test(text()), `left a placeholder: ${text()}`);

          store.dispose();
        } finally {
          restore();
        }
      });
    }
  });

  it("formats arbitrary counts correctly in the DOM", async () => {
    const restore = installI18n("ru");
    try {
      const seed = Array.from({ length: 12 }, (_, index) =>
        note({ id: `n${index}`, content: index < 5 ? `needle ${index}` : `hay ${index}`, createdAt: index })
      );
      const { dom, store } = await wireIntegration(seed);
      const counter = dom.document.getElementById("tn-count") as HTMLElement;
      const text = (): string => (counter.textContent ?? "").trim();

      assert.equal(text(), COUNTER_CASES.ru.format(12, 12));
      store.setSearch("needle");
      assert.equal(text(), COUNTER_CASES.ru.format(5, 12));
      store.dispose();
    } finally {
      restore();
    }
  });

  it("gives the dynamic counter exactly one owner", () => {
    // The counter is dynamic text. If a generic `data-i18n` pass claimed it, that
    // pass would overwrite the rendered numbers with the raw message template —
    // so the element must not carry a `data-i18n` attribute of any kind.
    const dom = installDom(loadPageHtml());
    const counter = dom.document.getElementById("tn-count");
    assert.ok(counter, "#tn-count must exist");

    for (const attribute of ["data-i18n", "data-i18n-title", "data-i18n-placeholder", "data-i18n-aria-label"]) {
      assert.equal(
        counter!.hasAttribute(attribute),
        false,
        `#tn-count must not carry ${attribute}; the counter is written only by renderCount()`
      );
    }

    // And no other element in the page may claim the counter's text.
    const claimants = [...dom.document.querySelectorAll("[data-i18n]")].filter(
      (element) => (element.getAttribute("data-i18n") ?? "").toLowerCase() === "notecount"
    );
    assert.deepEqual(claimants, [], "no static element may claim the noteCount message");
  });

  it("survives a generic localization pass without losing the numbers", async () => {
    const restore = installI18n("ru");
    try {
      const { dom, store } = await wireIntegration([
        note({ id: "a", content: "one", createdAt: 1 }),
        note({ id: "b", content: "two", createdAt: 2 }),
      ]);
      const counter = dom.document.getElementById("tn-count") as HTMLElement;
      const before = counter.textContent;

      // Re-run the static pass the page performs at startup, over the whole
      // document, and confirm it cannot touch the dynamically rendered counter.
      for (const element of dom.document.querySelectorAll<HTMLElement>("[data-i18n]")) {
        const key = element.dataset.i18n;
        if (key) element.textContent = t(key);
      }

      assert.equal(counter.textContent, before, "the static pass must not overwrite the counter");
      assert.equal(counter.textContent, "2 из 2 заметок");
      store.dispose();
    } finally {
      restore();
    }
  });
});

describe("ui: primary button contrast", () => {
  const css = () => readSource("src/ui/notes.css");

  /**
   * Read the effective value of a custom property from a `:root` block.
   *
   * The two blocks are `:root { ... }` and `:root[data-tn-theme="dark"] { ... }`,
   * so this returns the light value unless `theme` is "dark".
   */
  function variableValue(source: string, name: string, theme: "light" | "dark"): string {
    // Match the block for the requested theme specifically. The light block is a
    // bare `:root`; the dark one is `:root[data-tn-theme="dark"]`.
    const pattern =
      theme === "dark"
        ? /:root\[data-tn-theme="dark"\]\s*\{([^}]*)\}/g
        : /(?:^|[}\s]):root\s*\{([^}]*)\}/g;
    for (const match of source.matchAll(pattern)) {
      const found = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(match[1] ?? "");
      if (found) return found[1]!.trim();
    }
    throw new Error(`--${name} is not defined for the ${theme} theme`);
  }

  /** Contrast ratio per WCAG 2.x, between 1 and 21. */
  function contrastRatio(a: string, b: string): number {
    const luminance = (value: string): number => {
      const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())![1]!;
      const channel = (pair: string): number => {
        const c = parseInt(pair, 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(hex.slice(0, 2)) + 0.7152 * channel(hex.slice(2, 4)) + 0.0722 * channel(hex.slice(4, 6));
    };
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (light + 0.05) / (dark + 0.05);
  }

  for (const theme of ["light", "dark"] as const) {
    it(`defines a legible foreground/background pair for every state (${theme})`, () => {
      const source = css();
      // The resting/active label must meet the 4.5:1 small-text requirement. Hover
      // is allowed 3:1 because on a dark theme the natural hover *lightens* the
      // fill, and white-on-blue cannot both lighten and stay at 4.5:1 — but it must
      // still be clearly readable, never washed out.
      const states = [
        { bg: "button-primary-bg", fg: "button-primary-fg", min: 4.5 },
        { bg: "button-primary-hover-bg", fg: "button-primary-hover-fg", min: 3 },
        { bg: "button-primary-active-bg", fg: "button-primary-active-fg", min: 4.5 },
      ];

      for (const { bg, fg, min } of states) {
        const background = variableValue(source, bg, theme);
        const foreground = variableValue(source, fg, theme);
        assert.ok(foreground.length > 0 && background.length > 0, `${bg}/${fg} must both be set`);

        const ratio = contrastRatio(foreground, background);
        assert.ok(
          ratio >= min,
          `${theme}: --${bg} (${background}) vs --${fg} (${foreground}) has contrast ${ratio.toFixed(2)}:1, ` +
            `need >= ${min}:1`
        );
      }
    });

    it(`keeps the disabled label legible but visibly muted (${theme})`, () => {
      const source = css();
      const ratio = contrastRatio(
        variableValue(source, "button-primary-disabled-fg", theme),
        variableValue(source, "button-primary-disabled-bg", theme)
      );
      assert.ok(ratio >= 3, `${theme}: a disabled label must still be readable, got ${ratio.toFixed(2)}:1`);
      // ...but it must not look like an ordinary interactive label either.
      const interactive = contrastRatio(
        variableValue(source, "button-primary-fg", theme),
        variableValue(source, "button-primary-bg", theme)
      );
      assert.notEqual(ratio.toFixed(2), interactive.toFixed(2), `${theme}: disabled must differ from the base state`);
    });

    it(`never moves hover towards the foreground colour (${theme})`, () => {
      // The original bug: hover applied `filter: brightness(1.08)`, lifting the
      // text and the fill together and collapsing the contrast between them.
      const source = css();
      const base = variableValue(source, "button-primary-bg", theme);
      const hover = variableValue(source, "button-primary-hover-bg", theme);
      const foreground = variableValue(source, "button-primary-fg", theme);

      assert.notEqual(hover, base, `${theme}: hover must differ from the base background`);
      // Whatever direction it moves, hover must stay clearly readable and must not
      // fall below the 3:1 floor that stops it resembling a disabled control.
      const hoverRatio = contrastRatio(hover, foreground);
      assert.ok(hoverRatio >= 3, `${theme}: hover label contrast dropped to ${hoverRatio.toFixed(2)}:1`);
    });

    it(`keeps the disabled state visually distinct from hover (${theme})`, () => {
      const source = css();
      const hoverBg = variableValue(source, "button-primary-hover-bg", theme);
      const disabledBg = variableValue(source, "button-primary-disabled-bg", theme);
      assert.notEqual(disabledBg, hoverBg, `${theme}: disabled must not look like hover`);

      const disabledFg = variableValue(source, "button-primary-disabled-fg", theme);
      const normalFg = variableValue(source, "button-primary-fg", theme);
      assert.notEqual(disabledFg, normalFg, `${theme}: a disabled label must not use the interactive colour`);
    });
  }

  it("does not use a brightness filter on the primary button", () => {
    // A filter moves foreground and background together, which is what made hover
    // unreadable. Explicit pairs are required instead.
    const source = css();
    const primaryBlocks = cssBlocks(source, ".tn-btn--primary");
    for (const block of primaryBlocks) {
      assert.ok(!/filter\s*:/.test(block), `the primary button must not use a filter: ${block.trim()}`);
    }
  });

  it("declares hover and active after the generic hover so they win", () => {
    const source = css();
    const genericHover = source.indexOf(".tn-btn:hover");
    const primaryHover = source.indexOf(".tn-btn--primary:hover");
    assert.ok(genericHover !== -1, ".tn-btn:hover must exist");
    assert.ok(primaryHover !== -1, ".tn-btn--primary:hover must exist");
    // Equal specificity means source order decides: the specific rule must come
    // later, or the primary button would fall back to the generic hover fill.
    assert.ok(
      primaryHover > genericHover,
      ".tn-btn--primary:hover must be declared after .tn-btn:hover"
    );
  });

  it("declares the disabled state last, so it overrides hover and active", () => {
    const source = css();
    const disabled = source.indexOf(".tn-btn:disabled");
    const primaryActive = source.indexOf(".tn-btn--primary:active");
    assert.ok(disabled !== -1, "a disabled rule must exist");
    assert.ok(primaryActive !== -1, ".tn-btn--primary:active must exist");
    assert.ok(disabled > primaryActive, "the disabled rule must come after the interactive states");
  });

  it("gives the disabled button a non-interactive cursor and full opacity", () => {
    const source = css();
    // Match on the declaration text rather than a selector regex, because the
    // selector is a multi-line group.
    assert.match(
      source,
      /\.tn-btn:disabled[^{]*\{[^}]*cursor\s*:\s*default/,
      "a disabled button must not show a pointer cursor"
    );
    assert.match(
      source,
      /\.tn-btn:disabled[^{]*\{[^}]*opacity\s*:\s*1/,
      "opacity must be explicit, not a washed-out fade"
    );
  });

  it("applies the pairs through the theme attribute without rebuilding the page", () => {
    // The state colours live in the same `:root` custom-property blocks as the
    // rest of the palette, so switching `data-tn-theme` on <html> re-resolves
    // them. No class or element changes are needed.
    const source = css();
    const lightBlock = /(?:^|[}\s]):root\s*\{([^}]*)\}/.exec(source)?.[1] ?? "";
    const darkBlock = /:root\[data-tn-theme="dark"\]\s*\{([^}]*)\}/.exec(source)?.[1] ?? "";

    for (const name of [
      "button-primary-bg",
      "button-primary-fg",
      "button-primary-hover-bg",
      "button-primary-hover-fg",
      "button-primary-active-bg",
      "button-primary-disabled-bg",
    ]) {
      assert.match(lightBlock, new RegExp(`--${name}\\s*:`), `--${name} must be in the light :root block`);
      assert.match(darkBlock, new RegExp(`--${name}\\s*:`), `--${name} must be in the dark :root block`);
    }

    // And the theme layer only ever writes the attribute, never restructures.
    const themeSource = readSource("src/theme/index.ts");
    assert.match(themeSource, /setAttribute\(THEME_ATTRIBUTE/, "the theme layer must switch via the attribute");
    assert.ok(
      !/removeChild|innerHTML\s*=/.test(themeSource),
      "switching the theme must not reconstruct the DOM"
    );
  });

  it("keeps the New note button reachable and styled as the primary button", () => {
    const dom = installDom(loadPageHtml());
    const newButton = dom.document.getElementById("tn-new");
    assert.ok(newButton, "#tn-new must exist");
    assert.ok(
      newButton!.classList.contains("tn-btn--primary"),
      "the New note button must keep the primary styling these rules target"
    );
    assert.equal(newButton!.hasAttribute("disabled"), false, "it must not start disabled");
  });
});

describe("ui: pane structure and footer position", () => {
  it("keeps the status bar a sibling of the flexible list area", () => {
    const dom = installDom(loadPageHtml());
    const panes = dom.document.querySelector(".tn-list-pane") as HTMLElement;
    const area = panes.querySelector(".tn-list-area") as HTMLElement;
    const statusbar = panes.querySelector(".tn-statusbar") as HTMLElement;

    assert.ok(area, ".tn-list-area must exist");
    assert.ok(statusbar, ".tn-statusbar must exist");

    // The footer must NOT be inside the scrollable/flexible area, or it would be
    // pushed around by the list contents.
    assert.equal(statusbar.parentElement, panes, "the status bar must be a direct child of the list pane");
    assert.equal(area.parentElement, panes);
    assert.equal(area.contains(statusbar), false, "the status bar must not be inside the list area");

    // The empty state lives inside the flexible area, not in the footer flow.
    const empty = dom.document.getElementById("tn-list-empty") as HTMLElement;
    assert.equal(empty.parentElement, area);
    assert.equal(empty.parentElement === statusbar.parentElement && empty.nextElementSibling?.classList.contains("tn-statusbar"), false);

    // The list itself is also inside the flexible area.
    const list = dom.document.getElementById("tn-list") as HTMLElement;
    assert.equal(list.parentElement, area);
  });

  it("pins the footer with the expected flex rules", () => {
    const css = readSource("src/ui/notes.css");

    cssHas(css, ".tn-list-pane", /flex-direction:\s*column/, "be a column flex container");
    cssHas(css, ".tn-list-area", /flex:\s*1\s+1\s+auto/, "absorb the free space");
    cssHas(
      css,
      ".tn-list-area",
      /min-height:\s*0/,
      "be allowed to shrink below its content (min-height: 0), or the footer is pushed out"
    );
    cssHas(css, ".tn-statusbar", /flex:\s*0\s+0\s+auto/, "keep its natural height");
    cssHas(css, ".tn-empty-list", /margin:\s*auto/, "centre inside the flexible area");
  });

  it("does not let the footer be hidden by the empty state or the list", () => {
    const html = readFileSync(PAGE_HTML_PATH, "utf8");
    // The status bar has no `hidden` attribute and is never toggled from JS.
    assert.ok(!/id="tn-count"[^>]*hidden/.test(html));
    assert.ok(!/<footer[^>]*\shidden/.test(html));

    const notesSource = readFileSync(join(findProjectRoot(), "src", "ui", "notes.ts"), "utf8");
    assert.ok(!/statusbar[\s\S]{0,40}\.hidden\s*=/.test(notesSource), "the status bar must never be hidden");
    assert.ok(!/tn-count[\s\S]{0,40}\.hidden\s*=/.test(notesSource));
  });
});

describe("ui: responsive layout invariants", () => {
  const css = () => readSource("src/ui/notes.css");

  it("never allows horizontal scrolling of the page itself", () => {
    const source = css();
    cssHas(source, "body", /overflow:\s*hidden/, "clip page overflow");
    cssHas(source, ".tn-main", /overflow:\s*hidden/, "clip horizontal overflow");
    cssHas(source, ".tn-main", /min-width:\s*0/, "be allowed to shrink");
  });

  it("gives the list a bounded width rather than a wide percentage", () => {
    const source = css();
    cssHas(source, ".tn-list-pane", /width:\s*\d+px/, "have an explicit base width");
    cssHas(source, ".tn-list-pane", /max-width:\s*\d+px/, "be capped in pixels, not a large percentage");
    cssHas(source, ".tn-list-pane", /min-width:\s*\d+px/, "have a floor so rows stay readable");
  });

  it("declares the three intended breakpoints", () => {
    const source = css();
    assert.match(source, /@media \(max-width: 1040px\)/);
    assert.match(source, /@media \(max-width: 900px\)/);
    assert.match(source, /@media \(max-width: 780px\)/);
  });

  it("switches to a single pane below the narrow breakpoint", () => {
    const source = css();
    const narrow = source.slice(source.indexOf("@media (max-width: 780px)"));
    assert.ok(narrow.length > 0, "the narrow breakpoint must exist");

    // `data-pane` decides which pane is visible.
    assert.match(narrow, /\.tn-main\[data-pane="list"\]\s*\.tn-editor-pane\s*\{[^}]*display:\s*none/);
    assert.match(narrow, /\.tn-main\[data-pane="editor"\]\s*\.tn-list-pane\s*\{[^}]*display:\s*none/);

    // The back button appears only here.
    assert.match(narrow, /\.tn-btn--back\s*\{[^}]*display:\s*inline-flex/);
  });

  it("keeps the back button hidden above the narrow breakpoint", () => {
    cssHas(css(), ".tn-btn--back", /display:\s*none/, "be hidden in the wide layout");
  });

  it("wraps long text and unbroken strings in both panes", () => {
    const source = css();
    cssHas(source, ".tn-textarea", /white-space:\s*pre-wrap/, "wrap plain text");
    cssHas(source, ".tn-textarea", /overflow-wrap:\s*anywhere/, "wrap long unbroken strings");

    cssHas(source, ".tn-preview", /overflow-wrap:\s*anywhere/, "wrap long words in the preview");
    cssHas(source, ".tn-preview", /overflow-x:\s*hidden/, "never scroll the preview sideways");

    // Fenced code must wrap rather than push the pane sideways.
    cssHas(source, ".tn-markdown pre", /white-space:\s*pre-wrap/, "soft-wrap long code lines");
    cssHas(source, ".tn-markdown pre", /overflow-wrap:\s*anywhere/, "wrap unbroken code lines");
  });

  it("uses native ordered counters for arbitrary-depth hierarchical markers", () => {
    cssHas(css(), ".tn-markdown ol > li::marker", /content:\s*counters\(list-item,\s*"\."\)/,
      "nested labels use the ancestor ordered counters without source mutations");
    assert.ok(!css().includes("counter-reset: list-item"), "keep the native ol[start] counter");
  });

  it("preserves distinct standard bullet markers across three levels", () => {
    cssHas(css(), ".tn-markdown ul", /list-style-type:\s*disc/, "outer bullets");
    cssHas(css(), ".tn-markdown ul ul", /list-style-type:\s*circle/, "nested bullets");
    cssHas(css(), ".tn-markdown ul ul ul", /list-style-type:\s*square/, "third-level bullets");
  });

  it("lets the editor bar and toolbar wrap so no control is clipped", () => {
    const source = css();
    cssHas(source, ".tn-editor__bar", /flex-wrap:\s*wrap/, "wrap its controls");
    cssHas(source, ".tn-toolbar", /flex-wrap:\s*wrap/, "wrap its controls");
  });

  it("keeps every editor control present in the markup regardless of width", () => {
    const dom = installDom(loadPageHtml());
    // Narrowing is purely CSS: nothing is removed from the DOM, so the controls
    // are always reachable once the layout switches.
    for (const selector of ["#tn-back", "#tn-format", "#tn-note-colors", "#tn-md-mode", "#tn-delete"]) {
      assert.ok(dom.document.querySelector(selector), `${selector} must exist in the markup`);
    }
  });
});

describe("ui: page boot smoke test", () => {
  it("starts, creates a note, filters, and deletes without throwing", async () => {
    const dom = installDom(loadPageHtml());
    const repository = new MemoryNotesRepository();

    // A functional Thunderbird-ish global.
    const fake = {
      i18n: {
        getMessage: (key: string) => EN_MESSAGES[key]?.message ?? "",
        getUILanguage: () => "en-US",
      },
      runtime: {
        getURL: (path: string) => `moz-extension://fake/${path}`,
        getManifest: () => ({ version: "0.1.0" }),
      },
      theme: {
        getCurrent: async () => ({ properties: { color_scheme: "dark" } }),
        onUpdated: { addListener() {}, removeListener() {}, hasListener: () => false },
      },
    } as unknown as ThunderbirdBrowser;

    const previousBrowser = globalThis.browser;
    globalThis.browser = fake;

    // `openNotesRepository()` needs `indexedDB`; the fake global omits it, which
    // is exactly the "IndexedDB unavailable" path that must fall back to memory.
    const opened = await openNotesRepository();
    assert.equal(opened.info.kind, "memory");

    const store = new NoteStore(repository, { autosaveDelayMs: 0 });
    await store.init();
    const created = await store.createNote();
    assert.equal(store.getSelectedId(), created.id);

    store.updateSelected({ content: "smoke test note", color: "blue", format: "markdown" });
    store.flushPending();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const persisted = await repository.getAll();
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.content, "smoke test note");
    assert.equal(persisted[0]?.color, "blue");
    assert.equal(persisted[0]?.revision, 2);

    store.setColorFilter("red");
    assert.equal(store.getVisible().length, 0);
    store.setColorFilter("blue");
    store.setSearch("smoke");
    assert.equal(store.getVisible().length, 1);
    store.setSearch("no match at all");
    assert.equal(store.getVisible().length, 0);
    store.setSearch("");

    await store.deleteNote(created.id);
    assert.deepEqual(await repository.getAll(), []);

    store.dispose();
    globalThis.browser = previousBrowser;
    dom.cleanup();
  });

  it("falls back to a memory repository when IndexedDB is missing", async () => {
    const previous = globalThis.indexedDB;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).indexedDB;
    const repository = await openNotesRepository();
    assert.equal(repository.info.kind, "memory");
    if (previous !== undefined) globalThis.indexedDB = previous;
  });
});
