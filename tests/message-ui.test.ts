import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { mailToken, bindMailCommand } from "../src/ui/mail-command.ts";
import { bindMarkdownEditing } from "../src/ui/markdown-edit.ts";
import { MessagePicker } from "../src/ui/message-picker.ts";
import { bindMessageNotes } from "../src/ui/message-notes.ts";
import { startMessageActions } from "../src/background/messages.ts";
import { MessageNavigation } from "../src/messages/navigation.ts";
import { NoteStore } from "../src/ui/store.ts";
import { MemoryNotesRepository } from "../src/storage/memory.ts";
import { createNote } from "../src/notes/model.ts";
import { PRIMARY_MESSAGE_KEY, primaryMessage, encodeMessageLocator } from "../src/messages/locator.ts";
import { parseMarkdown } from "../src/markdown/markdown.ts";
import type { EditorView } from "../src/ui/editor-view.ts";
import type { ThunderbirdBrowser, MessageHeader, MessageTab, MessageList } from "../src/api/browser.ts";

const reference = { locator: { version: 1 as const, headerMessageId: "one@test" }, subject: "Request" };
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function dom() {
  const { document, window } = parseHTML('<html lang="en"><body><div id="tn-md-mode"></div><textarea></textarea><div id="preview"></div></body></html>');
  const previous = { document: globalThis.document, Event: globalThis.Event, browser: globalThis.browser };
  globalThis.document = document; globalThis.Event = window.Event;
  let active: Element | null = null;
  Object.defineProperty(document, "activeElement", { get: () => active, configurable: true });
  Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
  window.HTMLElement.prototype.focus = function() { active = this; };
  window.HTMLElement.prototype.scrollIntoView = function() {};
  const textarea = document.querySelector("textarea")!;
  textarea.setSelectionRange = function(start, end, direction) { this.selectionStart = start ?? 0; this.selectionEnd = end ?? 0; this.selectionDirection = direction ?? "none"; };
  textarea.setRangeText = function(this: HTMLTextAreaElement, text: string, start: number = this.selectionStart, end: number = this.selectionEnd) { this.value = this.value.slice(0, start) + text + this.value.slice(end); };
  textarea.value = ""; textarea.hidden = false; textarea.setSelectionRange(0, 0); textarea.focus();
  Object.assign(window.HTMLElement.prototype, {
    showModal(this: HTMLDialogElement) { this.open = true; }, close(this: HTMLDialogElement) { this.open = false; },
  });
  const key = (target: HTMLElement, value: string, overrides = {}) => {
    const event = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.assign(event, { key: value, ...overrides }); target.dispatchEvent(event); return event;
  };
  cleanups.push(() => {
    window.dispatchEvent(new window.Event("pagehide"));
    globalThis.document = previous.document; globalThis.Event = previous.Event; globalThis.browser = previous.browser;
  });
  return { document, window, textarea, key };
}
function api() {
  const listeners: Array<Parameters<ThunderbirdBrowser["runtime"]["onMessage"]["addListener"]>[0]> = [];
  const opens: unknown[] = [];
  const headers: MessageHeader[] = [{ id: 11, headerMessageId: "one@test", subject: "Request", author: "Author", date: new Date() }];
  const browser = {
    i18n: { getMessage: () => "", getUILanguage: () => "en" },
    runtime: { getURL: (path: string) => `moz-extension://test/${path}`, getManifest: () => ({ version: "0.2.2" }),
      onMessage: { addListener: (listener: typeof listeners[number]) => listeners.push(listener) },
      sendMessage: async () => undefined,
    },
    messages: { async query() { return { messages: headers }; }, async continueList() { return { messages: [] }; }, async abortList() {} },
    messageDisplay: { async open(value: unknown) { opens.push(value); }, async getDisplayedMessages() { return { messages: headers }; }, onMessagesDisplayed: { addListener() {} } },
  } as unknown as ThunderbirdBrowser;
  globalThis.browser = browser;
  return { browser, listeners, opens, headers };
}

describe("Markdown slash tokens", () => {
  for (const source of ["/", "/m", "text /ma", "text\n/mail", "\t/m"]) {
    it(`accepts ${JSON.stringify(source)} without automatic execution`, () => {
      const token = mailToken(source, source.length, source.length); assert.ok(token?.matches); assert.equal(source.slice(token.start), source.trim().split(/\s/).at(-1));
    });
  }
  for (const source of ["https://example.com", "a/b", "word/mail", "/mail more", "/mail/path"]) {
    it(`does not trigger in ${source}`, () => assert.equal(mailToken(source, source.length, source.length), null));
  }
  it("no-match and text selection remain normal input", () => {
    assert.equal(mailToken("/other", 6, 6)?.matches, false); assert.equal(mailToken("/mail", 0, 5), null);
  });
});

describe("focused command UI and undo-compatible source insertion", () => {
  function fixture(pick: () => Promise<typeof reference | null> = async () => reference) {
    const context = dom(); let enabled = true; let id = "note"; let calls = 0;
    const editing = bindMarkdownEditing(context.textarea, () => enabled);
    const command = bindMailCommand({ textarea: context.textarea, enabled: () => enabled, noteId: () => id,
      pick: () => { calls++; return pick(); }, mutate: edit => editing.apply(edit) });
    const type = (text: string) => { context.textarea.value = text; context.textarea.setSelectionRange(text.length, text.length); context.textarea.dispatchEvent(new context.window.Event("input")); };
    return { ...context, command, type, calls: () => calls, disable: () => { enabled = false; }, changeNote: () => { id = "other"; } };
  }
  it("typing /m only shows a selected command; Enter explicitly invokes picker", async () => {
    const f = fixture(); f.type("text /m"); assert.equal(f.calls(), 0); assert.equal(f.command.menu.hidden, false);
    f.key(f.textarea, "Enter"); await tick(); assert.equal(f.calls(), 1);
    assert.equal(f.textarea.value, `text [Request](${encodeMessageLocator(reference.locator)})`);
    assert.equal(f.textarea.selectionStart, f.textarea.value.length); assert.equal(f.document.activeElement, f.textarea);
  });
  it("Escape dismisses without changing token/caret and no-match Enter stays native", () => {
    const f = fixture(); f.type("/m"); assert.equal(f.key(f.textarea, "Escape").defaultPrevented, true);
    assert.equal(f.textarea.value, "/m"); assert.equal(f.textarea.selectionStart, 2);
    f.type("/other"); assert.equal(f.command.menu.hidden, true); assert.equal(f.key(f.textarea, "Enter").defaultPrevented, false);
  });
  it("picker cancel and failure retain text and caret", async () => {
    for (const pick of [async () => null, async () => { throw new Error("failure"); }]) {
      const f = fixture(pick); f.type("before /mail"); f.key(f.textarea, "Enter"); await tick();
      assert.equal(f.textarea.value, "before /mail"); assert.equal(f.textarea.selectionStart, 12);
    }
  });
  it("arrow selection is local; plain, Preview, IME and non-editor focus are unaffected", () => {
    const f = fixture(); f.type("/m"); assert.equal(f.key(f.textarea, "ArrowDown").defaultPrevented, true);
    assert.equal(f.key(f.textarea, "ArrowUp").defaultPrevented, true);
    assert.equal(f.key(f.textarea, "Enter", { isComposing: true }).defaultPrevented, false);
    f.textarea.dispatchEvent(new f.window.Event("compositionstart")); assert.equal(f.key(f.textarea, "Enter").defaultPrevented, false);
    f.textarea.dispatchEvent(new f.window.Event("compositionend"));
    f.textarea.hidden = true; assert.equal(f.key(f.textarea, "Enter").defaultPrevented, false); f.textarea.hidden = false;
    const other = f.document.createElement("button"); f.document.body.append(other); other.focus();
    assert.equal(f.key(other, "Enter").defaultPrevented, false); f.textarea.focus(); f.disable();
    assert.equal(f.key(f.textarea, "Enter").defaultPrevented, false);
  });
  it("stale picker offsets cannot mutate a different note/source", async () => {
    let choose!: (result: typeof reference | null) => void;
    const f = fixture(() => new Promise(resolve => { choose = resolve; })); f.type("/mail"); f.key(f.textarea, "Enter");
    f.changeNote(); f.type("different content"); choose(reference); await tick(); assert.equal(f.textarea.value, "different content");
  });
  it("insertion uses native editing/input/store/revision/autosave and Preview pipeline", async () => {
    const f = fixture(), repository = new MemoryNotesRepository(), store = new NoteStore(repository, { autosaveDelayMs: 0 });
    await store.init(); const note = await store.createNote({ format: "markdown", content: "/mail" });
    cleanups.push(() => store.dispose());
    let commands = 0, inputs = 0;
    f.document.execCommand = (_command, _ui, text) => { commands++; f.textarea.setRangeText(text!, f.textarea.selectionStart, f.textarea.selectionEnd); f.textarea.dispatchEvent(new f.window.Event("input")); return true; };
    f.textarea.addEventListener("input", () => { inputs++; store.updateSelected({ content: f.textarea.value }); });
    f.type("/mail"); f.key(f.textarea, "Enter"); await tick(); store.flushPending(); await store.withMutationLock(session => session.writeBarrier());
    const saved = await repository.get(note.id); assert.ok(saved); assert.ok(saved.content.includes("thundernotes-message:")); assert.equal(saved.revision, 2);
    assert.equal(commands, 1); assert.equal(inputs, 2); assert.ok(parseMarkdown(saved.content, {}, f.document).html.includes("href="));
    store.updateSelected({ format: "plain" }); assert.equal(store.getSelectedNote()?.content, saved.content);
    store.updateSelected({ format: "markdown" }); assert.equal(store.getSelectedNote()?.content, saved.content);
  });
});

describe("message picker keyboard, query and cancellation", () => {
  it("focuses search; results are selectable by keyboard and mouse", async () => {
    const f = dom(), mock = api(), picker = new MessagePicker(f.document, mock.browser.messages!);
    const chosen = picker.open(); assert.equal(f.document.activeElement, picker.search); await tick();
    assert.equal(picker.list.querySelectorAll('[role="option"]').length, 1);
    assert.equal(f.key(picker.search, "ArrowDown").defaultPrevented, true);
    f.key(picker.search, "Enter"); assert.deepEqual(await chosen, reference);
    const mouse = picker.open(); await tick(); (picker.list.firstElementChild as HTMLElement).click(); assert.deepEqual(await mouse, reference);
  });
  it("Escape cancels; empty and error results do not claim success", async () => {
    const f = dom(), mock = api(), picker = new MessagePicker(f.document, mock.browser.messages!);
    const cancelled = picker.open(); f.key(picker.search, "Escape"); assert.equal(await cancelled, null);
    mock.headers.length = 0; const empty = picker.open(); await tick();
    assert.ok(picker.dialog.textContent?.includes("No messages found")); f.key(picker.search, "Escape"); await empty;
    mock.browser.messages!.query = async () => { throw new Error("offline"); };
    const failed = picker.open(); await tick(); assert.ok(picker.dialog.textContent?.includes("Could not search")); f.key(picker.search, "Escape"); await failed;
  });
});

describe("primary note UI and internal Preview dispatch", () => {
  async function fixture(missing = false) {
    const f = dom(), mock = api(), repository = new MemoryNotesRepository(), store = new NoteStore(repository, { autosaveDelayMs: 0 });
    if (missing) mock.headers.length = 0;
    await store.init(); await store.createNote({ meta: { [PRIMARY_MESSAGE_KEY]: reference } }); cleanups.push(() => store.dispose());
    const banners: string[] = [], preview = f.document.getElementById("preview")!;
    const editor = { focus() {}, focusOpened() {}, applySourceEdit() {} } as unknown as EditorView;
    bindMessageNotes({ store, editor, textarea: f.textarea, preview, showEditor() {}, onMessage: message => banners.push(message) });
    await tick(); const snapshot = primaryMessage(store.getSelectedNote()!)!;
    assert.equal(snapshot.subject, reference.subject); assert.deepEqual(snapshot.locator, reference.locator);
    return { ...f, ...mock, repository, store, banners, preview, snapshot };
  }
  it("unlink requires confirm; cancel changes nothing; confirm preserves content", async () => {
    const f = await fixture(); const before = f.store.getSelectedNote()!;
    f.store.updateSelected({ content: "keep inline references" });
    f.window.confirm = () => false; (f.document.querySelector('.tn-primary-message__unlink') as HTMLElement).click();
    assert.deepEqual(primaryMessage(f.store.getSelectedNote()!), f.snapshot);
    f.window.confirm = () => true; (f.document.querySelector('.tn-primary-message__unlink') as HTMLElement).click();
    assert.equal(primaryMessage(f.store.getSelectedNote()!), null); assert.equal(f.store.getSelectedNote()?.content, "keep inline references");
    assert.equal(f.store.getSelectedId(), before.id);
  });
  it("missing-message UI preserves snapshot; navigation reports unavailable", async () => {
    const f = await fixture(); f.headers.length = 0;
    f.document.dispatchEvent(new f.window.Event("visibilitychange")); await tick();
    const link = f.document.querySelector('.tn-primary-message__link') as HTMLButtonElement;
    assert.ok(link.textContent?.includes("Message unavailable:")); assert.ok(link.textContent?.includes("Request")); link.click(); await tick();
    assert.ok(f.banners[0]?.includes("could not be found")); assert.deepEqual(primaryMessage(f.store.getSelectedNote()!), f.snapshot);
  });
  it("valid Preview internal click opens mail without default/external navigation", async () => {
    const f = await fixture(); const uri = encodeMessageLocator(reference.locator);
    f.preview.innerHTML = `<a href="${uri}">mail</a><a href="https://example.test/">external</a>`;
    const plainClick = new f.window.Event("click", { bubbles: true, cancelable: true });
    f.preview.firstElementChild!.dispatchEvent(plainClick); assert.equal(f.opens.length, 0);
    f.store.updateSelected({ format: "markdown" });
    const before = f.store.getSelectedNote()?.content;
    const internal = new f.window.Event("click", { bubbles: true, cancelable: true }); f.preview.firstElementChild!.dispatchEvent(internal); await tick();
    assert.equal(internal.defaultPrevented, true); assert.equal(f.opens.length, 1); assert.equal(f.store.getSelectedNote()?.content, before);
    const external = new f.window.Event("click", { bubbles: true, cancelable: true }); f.preview.lastElementChild!.dispatchEvent(external); assert.equal(external.defaultPrevented, false);
    const aux = new f.window.Event("auxclick", { bubbles: true, cancelable: true }); f.preview.firstElementChild!.dispatchEvent(aux); assert.equal(aux.defaultPrevented, true);
  });
  it("a message disappearing while the page is open becomes unavailable on click", async () => {
    const f = await fixture(); f.headers.length = 0;
    const link = f.document.querySelector('.tn-primary-message__link') as HTMLButtonElement;
    link.click(); await tick();
    assert.ok(link.textContent?.includes("Message unavailable:")); assert.ok(link.textContent?.includes("Request"));
    assert.ok(f.banners[0]?.includes("could not be found"));
    assert.deepEqual(primaryMessage(f.store.getSelectedNote()!), f.snapshot);
  });
  it("uses an accessible secondary icon and preserves full identity in title", async () => {
    const f = await fixture();
    const unlink = f.document.querySelector('.tn-primary-message__unlink') as HTMLButtonElement;
    assert.equal(unlink.getAttribute("aria-label"), "Unlink message"); assert.equal(unlink.title, "Unlink message");
    assert.equal(unlink.textContent, ""); assert.ok(unlink.querySelector('.tn-icon--close[aria-hidden="true"]'));
    unlink.focus(); assert.equal(f.document.activeElement, unlink);
    const link = f.document.querySelector('.tn-primary-message__link') as HTMLButtonElement;
    assert.ok(link.title.includes("From: Author")); assert.ok(link.title.includes("Request")); assert.ok(link.title.includes("Message type unknown"));
    assert.equal(link.getAttribute("aria-label"), link.title);
  });
  it("an unresolved old subject-only relation stays visible and is not rewritten", async () => {
    const f = await fixture(true), note = f.store.getSelectedNote()!;
    assert.deepEqual(primaryMessage(note), reference); assert.equal(note.revision, 1);
    const link = f.document.querySelector('.tn-primary-message__link') as HTMLButtonElement;
    assert.ok(link.textContent?.includes("Request")); assert.ok(link.title.includes("Message unavailable:"));
    assert.ok(f.document.querySelector('.tn-primary-message__unlink'));
  });
  it("a cold ready page acknowledges capture only after creating/selecting/focusing the note", async () => {
    const f = dom(), mock = api(), queue = new MessageNavigation(), repository = new MemoryNotesRepository(), store = new NoteStore(repository);
    await store.init(); cleanups.push(() => store.dispose());
    await queue.enqueue(reference); await queue.enqueue(reference);
    mock.browser.runtime.sendMessage = async message => {
      const raw = message as { type: string; page: string; id: string };
      if (raw.type === "thundernotes:mail-next") return { ok: true, value: await queue.next(raw.page) };
      if (raw.type === "thundernotes:mail-ack") { await queue.ack(raw.page, raw.id); return { ok: true }; }
      return undefined;
    };
    let focused = 0, opened = 0;
    bindMessageNotes({ store, textarea: f.textarea, preview: f.document.getElementById("preview")!,
      editor: { focus() { focused++; }, focusOpened() { opened++; } } as unknown as EditorView,
      showEditor() {}, onMessage() {} });
    await tick(); assert.equal(store.getNotes().length, 1); assert.equal(focused, 1); assert.equal(await queue.next("inspect"), null);
    const linkedId = store.getSelectedId(); await store.createNote({ format: "markdown" }); await queue.enqueue(reference);
    for (const listener of mock.listeners) listener({ type: "thundernotes:mail-wake" }, {}, () => {});
    await tick(); assert.equal(store.getSelectedId(), linkedId); assert.equal(store.getNotes().length, 2); assert.equal(opened, 1);
  });
  it("failed capture does not acknowledge delivery or pretend to create a saved note", async () => {
    const f = dom(), mock = api(), queue = new MessageNavigation(), repository = new MemoryNotesRepository(), store = new NoteStore(repository);
    await store.init(); cleanups.push(() => store.dispose()); await queue.enqueue(reference);
    repository.createForMessage = async () => { throw new Error("disk failed"); };
    let acknowledgements = 0;
    mock.browser.runtime.sendMessage = async message => {
      const raw = message as { type: string; page: string };
      if (raw.type === "thundernotes:mail-next") return { ok: true, value: await queue.next(raw.page) };
      if (raw.type === "thundernotes:mail-ack") acknowledgements++;
      return undefined;
    };
    const banners: string[] = [];
    bindMessageNotes({ store, textarea: f.textarea, preview: f.document.getElementById("preview")!,
      editor: {} as EditorView, showEditor() {}, onMessage: text => banners.push(text) });
    await tick(); assert.equal(acknowledgements, 0); assert.equal(store.getNotes().length, 0); assert.ok(banners[0]?.includes("Could not"));
  });
});

describe("native message action and background/page handshake", () => {
  it("sets independent tab titles and navigates repeated clicks via one intent", async () => {
    dom(); const mock = api(), titles = new Map<number, string>(), opened: unknown[] = [];
    const data: Record<string, unknown> = {};
    const area = { async get() { return structuredClone(data); }, async set(value: object) { Object.assign(data, structuredClone(value)); } } as NonNullable<ThunderbirdBrowser["storage"]>["local"];
    mock.browser.storage = { local: area };
    mock.browser.spaces = { async query() { return [{ id: 8, name: "thundernotes" }]; }, async update() {}, async open(...args: unknown[]) { opened.push(args); } } as unknown as NonNullable<ThunderbirdBrowser["spaces"]>;
    mock.browser.tabs = { async query() { return [{ id: 1 }, { id: 2 }]; }, async create() {} };
    let click!: (tab: MessageTab) => void, displayed!: (tab: MessageTab, messages: MessageList) => void;
    mock.browser.messageDisplayAction = { async setTitle(details) { titles.set(details.tabId, details.title); }, async enable() {}, async disable() {}, onClicked: { addListener: fn => { click = fn; } } };
    mock.browser.messageDisplay!.onMessagesDisplayed.addListener = fn => { displayed = fn; };
    mock.browser.messageDisplay!.getDisplayedMessages = async tabId => ({ messages: [{ ...mock.headers[0]!, headerMessageId: tabId === 1 ? "one@test" : "two@test" }] });
    const repository = new MemoryNotesRepository();
    const note = createNote({ meta: { [PRIMARY_MESSAGE_KEY]: { ...reference, locator: { version: 1, headerMessageId: "one@test" } } } });
    await repository.create(note);
    // A stale page response must not override the authoritative repository.
    mock.browser.runtime.sendMessage = async () => ({ exists: true });
    startMessageActions(mock.browser, repository); await tick();
    assert.equal(titles.get(1), "Open note"); assert.equal(titles.get(2), "New note");
    displayed({ id: 1 }, { messages: [] }); await tick(); assert.equal(titles.get(1), "Open note");
    click({ id: 2, windowId: 3 }); click({ id: 2, windowId: 3 }); await tick();
    assert.equal(opened.length, 1);
    const queue = new MessageNavigation(area); const intent = await queue.next("ready-page"); assert.equal(intent?.reference.locator.headerMessageId, "two@test");
    await queue.ack("ready-page", intent!.id); assert.equal(await queue.next("ready-page"), null);
    const handler = mock.listeners[0]!; let responded = false;
    assert.equal(handler({ type: "thundernotes:mail-next", page: "unknown" }, { url: "moz-extension://test/other.html" }, () => { responded = true; }), false);
    assert.equal(responded, false);
    await repository.delete(note.id);
    assert.equal(handler({ type: "thundernotes:mail-changed" }, { url: "moz-extension://test/notes.html" }, () => {}), true);
    await tick(); assert.equal(titles.get(1), "New note");
  });
  it("reuses the existing Space window and only delivers to that window", async () => {
    dom(); const mock = api(), opened: unknown[] = [], focused: unknown[] = [];
    mock.browser.spaces = { async query() { return [{ id: 8, name: "thundernotes" }]; }, async update() {},
      async open(...args: unknown[]) { opened.push(args); return { windowId: 7 }; } } as unknown as NonNullable<ThunderbirdBrowser["spaces"]>;
    mock.browser.tabs = { async query(query) { return query.spaceId === 8 || query.windowId === 7 ? [{ id: 10, windowId: 7 }] : []; }, async create() {} };
    mock.browser.windows = { async update(...args) { focused.push(args); } };
    let click!: (tab: MessageTab) => void;
    mock.browser.messageDisplayAction = { async setTitle() {}, async enable() {}, async disable() {}, onClicked: { addListener: fn => { click = fn; } } };
    startMessageActions(mock.browser, new MemoryNotesRepository());
    click({ id: 1, windowId: 99 }); await tick();
    assert.deepEqual(opened, [[8, 7]]); assert.deepEqual(focused, [[7, { focused: true }]]);
    const handler = mock.listeners[0]!;
    let wrong: unknown, right: unknown;
    handler({ type: "thundernotes:mail-next", page: "other", windowId: 99 }, { url: "moz-extension://test/notes.html" }, value => { wrong = value; });
    await tick(); assert.deepEqual(wrong, { ok: true, value: null });
    handler({ type: "thundernotes:mail-next", page: "target", windowId: 7 }, { url: "moz-extension://test/notes.html" }, value => { right = value; });
    await tick(); assert.ok((right as { value: unknown }).value);
  });
});
