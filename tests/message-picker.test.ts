import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { MessagePicker } from "../src/ui/message-picker.ts";
import { readMessageExcerpt, normalizeExcerpt, htmlExcerptText } from "../src/messages/excerpt.ts";
import type { MessagesApi, MessageHeader, ThunderbirdBrowser } from "../src/api/browser.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(locale = "en", count = 2) {
  const { document, window } = parseHTML('<html><body><textarea></textarea></body></html>');
  const prior = { browser: globalThis.browser, document: globalThis.document, Event: globalThis.Event };
  const localeData = JSON.parse(readFileSync(`_locales/${locale}/messages.json`, "utf8"));
  globalThis.browser = { i18n: { getUILanguage: () => locale, getMessage: (key: string, args?: string | string[]) => {
    const values = typeof args === "string" ? [args] : args ?? [];
    return (localeData[key]?.message ?? "").replace(/\$(\d+)/g, (match: string, index: string) => values[Number(index) - 1] ?? match);
  } } } as unknown as ThunderbirdBrowser;
  globalThis.document = document; globalThis.Event = window.Event;
  let active: HTMLElement | null = document.querySelector("textarea");
  Object.defineProperty(document, "activeElement", { get: () => active });
  window.HTMLElement.prototype.focus = function() { active = this; };
  window.HTMLElement.prototype.scrollIntoView = function() {};
  Object.assign(window.HTMLElement.prototype, { showModal(this: HTMLDialogElement) { this.open = true; }, close(this: HTMLDialogElement) { this.open = false; } });
  Object.defineProperty(window, "innerWidth", { value: 1600, writable: true, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 900, writable: true, configurable: true });
  const headers: MessageHeader[] = Array.from({ length: count }, (_, i) => ({ id: i + 1, headerMessageId: `${i + 1}@test`, subject: `Subject ${i + 1}`,
    author: "Author <author@test>", recipients: ["Recipient <recipient@test>"], date: new Date(Date.now() - i * 1000) }));
  const reads: number[] = []; let queries = 0;
  const api: MessagesApi = { async query(q) { queries++; return { messages: headers.filter(m => (!q.fromDate || m.date >= q.fromDate) && (!q.toDate || m.date <= q.toDate)) }; },
    async continueList() { throw new Error("Unexpected pagination"); }, async abortList() {},
    async listInlineTextParts(id) { reads.push(id); return [{ contentType: "text/plain", content: `Body ${id}` }]; } };
  const picker = new MessagePicker(document, api);
  picker.dialog.getBoundingClientRect = () => ({ left: 400, right: 960, top: 100, bottom: 600, width: 560, height: 500, x: 400, y: 100, toJSON() {} });
  const event = (target: HTMLElement, type: string) => target.dispatchEvent(new window.Event(type, { bubbles: false }));
  const key = (value: string) => { const e = new window.Event("keydown", { bubbles: true, cancelable: true }); Object.assign(e, { key: value }); picker.search.dispatchEvent(e); };
  const row = (index = 0) => picker.list.children[index] as HTMLElement;
  cleanup.push(() => { key("Escape"); globalThis.browser = prior.browser; globalThis.document = prior.document; globalThis.Event = prior.Event; });
  return { document, window, picker, api, headers, reads, event, key, row, queries: () => queries };
}

describe("hover-only ephemeral message picker preview", () => {
  it("releases hidden rows and identity on close and ignores an outstanding excerpt", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture();
    let complete!: (parts: { contentType: string; content: string }[]) => void;
    f.api.listInlineTextParts = () => new Promise(resolve => { complete = resolve; });
    const result = f.picker.open(); await settle();
    f.event(f.row(), "mouseenter"); t.mock.timers.tick(350); await settle();
    assert.ok(f.picker.preview.textContent?.includes("Subject 1"));
    f.key("Escape"); assert.equal(await result, null);
    assert.equal(f.picker.list.children.length, 0); assert.equal(f.picker.preview.textContent, "");
    assert.equal(f.picker.search.getAttribute("aria-activedescendant"), null);
    assert.equal(f.picker.list.getAttribute("aria-busy"), "false");
    complete([{ contentType: "text/plain", content: "Late body" }]); await settle();
    assert.equal(f.picker.preview.textContent, ""); assert.equal(f.picker.preview.hidden, true);
  });
  it("does not read bodies on opening, keyboard selection or a short hover", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(); const result = f.picker.open(); await settle();
    f.key("ArrowDown"); assert.equal(f.reads.length, 0);
    f.event(f.row(), "mouseenter"); t.mock.timers.tick(349); await settle(); assert.equal(f.reads.length, 0);
    f.event(f.row(), "mouseleave"); t.mock.timers.tick(1000); await settle(); assert.equal(f.reads.length, 0);
    assert.equal(f.picker.preview.hidden, true); f.key("Escape"); assert.equal(await result, null);
  });
  it("loads exactly once after stable hover and reuses only the current dialog cache", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(); let result = f.picker.open(); await settle();
    f.event(f.row(), "mouseenter"); t.mock.timers.tick(350); await settle();
    assert.deepEqual(f.reads, [1]); assert.ok(f.picker.preview.textContent?.includes("Body 1"));
    assert.equal(f.document.activeElement, f.picker.search); assert.equal(f.picker.preview.classList.contains("is-side"), true);
    f.event(f.row(), "mouseleave"); f.event(f.row(), "mouseenter"); t.mock.timers.tick(350); await settle(); assert.deepEqual(f.reads, [1]);
    f.key("Escape"); await result; result = f.picker.open(); await settle();
    f.event(f.row(), "mouseenter"); t.mock.timers.tick(350); await settle(); assert.deepEqual(f.reads, [1, 1]); f.key("Escape"); await result;
  });
  it("quick movement loads only the final row; stale async results cannot replace it", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(); const pending = new Map<number, (parts: {contentType: string; content: string}[]) => void>();
    f.api.listInlineTextParts = id => { f.reads.push(id); return new Promise(resolve => pending.set(id, resolve)); };
    const result = f.picker.open(); await settle();
    f.event(f.row(), "mouseenter"); t.mock.timers.tick(200); f.event(f.row(), "mouseleave"); f.event(f.row(1), "mouseenter"); t.mock.timers.tick(350); await settle();
    assert.deepEqual(f.reads, [2]); assert.ok(f.picker.preview.textContent?.includes("Loading preview"));
    f.event(f.row(1), "mouseleave"); f.event(f.row(), "mouseenter"); t.mock.timers.tick(350); await settle();
    pending.get(2)!([{ contentType: "text/plain", content: "STALE" }]); await settle(); assert.ok(!f.picker.preview.textContent?.includes("STALE"));
    pending.get(1)!([{ contentType: "text/plain", content: "CURRENT" }]); await settle(); assert.ok(f.picker.preview.textContent?.includes("CURRENT"));
    f.key("Escape"); await result;
  });
  it("preview failure is neutral and never blocks selecting a metadata-only reference", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(); f.api.listInlineTextParts = async () => { throw new Error("Unavailable"); };
    const result = f.picker.open(); await settle(); f.event(f.row(), "mouseenter"); t.mock.timers.tick(350); await settle();
    assert.ok(f.picker.preview.textContent?.includes("Preview unavailable")); f.row().click();
    assert.deepEqual(await result, { locator: { version: 1, headerMessageId: "1@test" }, subject: "Subject 1" });
    assert.equal(f.picker.preview.hidden, true);
  });
  it("renders malicious HTML as text only, without resource or attachment API calls", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture();
    Object.assign(f.api, { getRaw() { throw new Error("Raw forbidden"); }, getFull() { throw new Error("Full forbidden"); }, listAttachments() { throw new Error("Attachments forbidden"); } });
    f.api.listInlineTextParts = async () => [{ contentType: "text/html", content: '<script>evil()</script><style>bad</style><img src="https://remote.test/x"><p>Hello &lt;img&gt;</p><p>World</p>' }];
    const result = f.picker.open(); await settle(); f.event(f.row(), "mouseenter"); t.mock.timers.tick(350); await settle();
    assert.ok(f.picker.preview.textContent?.includes("Hello <img>")); assert.equal(f.picker.preview.querySelectorAll("img,script,style,iframe").length, 0);
    assert.ok(!f.picker.preview.textContent?.includes("evil")); f.key("Escape"); await result;
  });
  it("suppresses reads at narrow widths and uses an overlay at medium widths", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(); const result = f.picker.open(); await settle();
    f.window.innerWidth = 600; f.event(f.row(), "mouseenter"); t.mock.timers.tick(350); await settle(); assert.equal(f.reads.length, 0);
    f.window.innerWidth = 1000; f.event(f.row(), "mouseenter"); t.mock.timers.tick(350); await settle(); assert.equal(f.picker.preview.classList.contains("is-side"), false);
    f.event(f.picker.list, "scroll"); assert.equal(f.picker.preview.hidden, true); f.key("Escape"); await result;
  });
  it("bounds the hover cache to twenty excerpts", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture("en", 21); const result = f.picker.open(); await settle();
    for (let i = 0; i < 21; i++) { f.event(f.row(i), "mouseenter"); t.mock.timers.tick(350); await settle(); }
    f.event(f.row(), "mouseenter"); t.mock.timers.tick(350); await settle(); assert.equal(f.reads.length, 22); f.key("Escape"); await result;
  });
});

describe("picker search and visual interaction contracts", () => {
  it("shows cached matches before debounce/deep completion and merges older matches", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture("en", 50); f.headers[0]!.subject = "Target";
    const oldHeader = { ...f.headers[0]!, id: 99, headerMessageId: "old@test", date: new Date("2001-01-01") };
    const normal = f.api.query; let release!: () => void;
    f.api.query = async q => {
      if (q.fromDate && q.toDate && oldHeader.date >= q.fromDate && oldHeader.date <= q.toDate) {
        await new Promise<void>(resolve => { release = resolve; }); return { messages: [oldHeader] };
      }
      return normal(q);
    };
    const result = f.picker.open(); await settle(); const baseline = f.queries();
    f.picker.search.value = "Target"; f.event(f.picker.search, "input");
    assert.equal(f.picker.list.children.length, 1); assert.ok(f.row().textContent?.includes("Target")); assert.equal(f.queries(), baseline);
    t.mock.timers.tick(200); await settle(); assert.ok(release); assert.equal(f.picker.list.children.length, 1);
    release(); await settle(); assert.equal(f.picker.list.children.length, 2); assert.equal(f.picker.list.getAttribute("aria-busy"), "false");
    f.key("Escape"); await result;
  });
  it("cached results never let an obsolete deep query overwrite a new one", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture("en", 50); const normal = f.api.query;
    const oldHeader = { ...f.headers[0]!, id: 99, headerMessageId: "old@test", subject: "Old target", date: new Date("2001-01-01") };
    let release!: () => void;
    f.api.query = async q => {
      if (q.fromDate && q.toDate && oldHeader.date >= q.fromDate && oldHeader.date <= q.toDate) {
        await new Promise<void>(resolve => { release = resolve; }); return { messages: [oldHeader] };
      }
      return normal(q);
    };
    const result = f.picker.open(); await settle(); f.picker.search.value = "Old target"; f.event(f.picker.search, "input");
    t.mock.timers.tick(200); await settle(); assert.ok(release);
    f.picker.search.value = "Subject 2"; f.event(f.picker.search, "input"); assert.ok(f.row().textContent?.includes("Subject 2"));
    t.mock.timers.tick(200); await settle(); release(); await settle();
    assert.ok([...f.picker.list.children].every(row => row.textContent?.includes("Subject 2"))); f.key("Escape"); await result;
  });
  it("retains unchanged rows while searching and observes fresh metadata on reopening", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(); let result = f.picker.open(); await settle();
    const row = f.row(); const baseline = f.queries(); f.picker.search.value = "Author"; f.event(f.picker.search, "input");
    assert.equal(f.row(), row); t.mock.timers.tick(200); await settle(); assert.equal(f.row(), row); assert.equal(f.queries(), baseline);
    f.key("Escape"); await result; f.headers[0]!.subject = "Fresh mailbox";
    result = f.picker.open(); await settle(); assert.ok(f.row().textContent?.includes("Fresh mailbox")); assert.ok(f.queries() > baseline);
    f.key("Escape"); await result;
  });
  it("ignores stale search results after rapid query changes", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(); const normal = f.api.query;
    let finishOld!: (value: { messages: MessageHeader[]; id: string }) => void; let first = true; let starts = 0; const aborted: string[] = [];
    f.api.query = q => { starts++; if (first) { first = false; return new Promise(resolve => { finishOld = resolve; }); } return normal(q); };
    f.api.abortList = async id => { aborted.push(id); };
    const result = f.picker.open(); f.picker.search.value = "Subject 2"; f.event(f.picker.search, "input");
    t.mock.timers.tick(200); await settle(); assert.equal(starts, 1); // Shared metadata request, not a duplicate search.
    finishOld({ id: "old-list", messages: f.headers }); await settle();
    assert.equal(f.picker.list.children.length, 1);
    assert.ok(f.row().textContent?.includes("Subject 2")); assert.deepEqual(aborted, ["old-list"]); f.key("Escape"); await result;
  });
  it("shows localized empty/error states while retaining Cancel", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(); let result = f.picker.open(); await settle();
    f.picker.search.value = "no match"; f.event(f.picker.search, "input"); t.mock.timers.tick(200); await settle();
    assert.equal(f.picker.list.children.length, 0); assert.ok(f.picker.dialog.textContent?.includes("No messages found")); f.key("Escape"); await result;
    f.api.query = async () => { throw new Error("Query failed"); }; result = f.picker.open(); await settle();
    assert.equal(f.picker.list.getAttribute("aria-busy"), "false"); assert.ok(f.picker.dialog.textContent?.includes("Could not search")); f.key("Escape"); await result;
  });
  it("debounces live typing for 200ms and retains keyboard choice", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(); const result = f.picker.open(); await settle(); const baseline = f.queries();
    f.picker.search.value = "Subject 2"; f.event(f.picker.search, "input"); t.mock.timers.tick(199); await settle(); assert.equal(f.queries(), baseline);
    t.mock.timers.tick(1); await settle(); assert.equal(f.picker.list.children.length, 1); assert.ok(f.row().textContent?.includes("Subject 2"));
    f.key("Enter"); assert.equal((await result)?.locator.headerMessageId, "2@test"); assert.equal(f.reads.length, 0);
  });
  for (const locale of ["en", "ru"]) it(`localizes search and preserves full row identity in ${locale}`, async () => {
    const f = fixture(locale); f.headers[0]!.subject = ""; const result = f.picker.open(); await settle();
    assert.equal(f.picker.search.placeholder, locale === "en" ? "Search by subject, name or email" : "Поиск по теме, имени или адресу");
    assert.ok(f.row().textContent?.includes(locale === "en" ? "(No subject)" : "(Без темы)"));
    assert.ok(f.row().title.includes("author@test")); assert.ok(f.row().getAttribute("aria-label")?.includes("recipient@test"));
    assert.equal(f.picker.search.getAttribute("aria-activedescendant"), f.row().id); f.key("Escape"); await result;
  });
  it("close and Cancel retain editor text and restore focus", async () => {
    const f = fixture(); const editor = f.document.querySelector("textarea")!; editor.value = "text /mail";
    for (const selector of [".tn-dialog__close", ".tn-dialog__footer button"]) {
      const result = f.picker.open(); await settle(); (f.picker.dialog.querySelector(selector) as HTMLElement).click();
      assert.equal(await result, null); assert.equal(editor.value, "text /mail"); assert.equal(f.document.activeElement, editor);
    }
  });
  it("styles fixed results, focus, hover and non-interactive responsive preview", () => {
    const css = readFileSync("src/ui/notes.css", "utf8");
    for (const contract of [".tn-message-picker__body", ".tn-message-picker__search", ".tn-message-result:hover", '.tn-message-result[aria-selected="true"]',
      ".tn-message-result:focus-visible", "pointer-events: none", "max-width: 679px", "max-height: 429px"]) assert.ok(css.includes(contract), contract);
    assert.match(css, /#tn-message-results\s*\{[^}]*height:\s*clamp/s);
  });
});

describe("bounded plain-text inline excerpts", () => {
  it("prefers plain text and preserves basic paragraphs while collapsing excess whitespace", async () => {
    const api = { async listInlineTextParts() { return [{ contentType: "text/html", content: "wrong" }, { contentType: "text/plain", content: "  Hello\t  world\r\n\r\n\r\n  Next  " }]; } } as unknown as MessagesApi;
    assert.equal(await readMessageExcerpt(api, 1), "Hello world\n\nNext");
  });
  it("caps excerpts at 450 Unicode code points without splitting surrogate pairs", () => {
    const text = normalizeExcerpt("😀".repeat(600)); assert.equal(Array.from(text).length, 450); assert.ok(text.endsWith("…")); assert.ok(!text.includes("\ufffd"));
  });
  it("converts HTML safely without active content and decodes common/numeric entities", () => {
    assert.equal(normalizeExcerpt(htmlExcerptText('<head>secret</head><p>A &amp; B &#x1f600;</p><br><div>C</div>')), "A & B 😀\n\nC");
  });
  it("reports missing API or unreadable parts without falling back to raw MIME", async () => {
    await assert.rejects(readMessageExcerpt({} as MessagesApi, 1));
    await assert.rejects(readMessageExcerpt({ async listInlineTextParts() { return [{ contentType: "text/calendar", content: "not body" }]; } } as unknown as MessagesApi, 1));
  });
});
