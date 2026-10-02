import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { createNote } from "../src/notes/model.ts";
import { NoteStore } from "../src/ui/store.ts";
import { MemoryNotesRepository } from "../src/storage/memory.ts";
import { IndexedDbNotesRepository } from "../src/storage/indexeddb.ts";
import { PRIMARY_MESSAGE_KEY, primaryMessage, primaryOwner, isMessageLocator, messageReference, encodeMessageLocator,
  decodeMessageLocator, inlineMessageLink, MessageRelationConflictError } from "../src/messages/locator.ts";
import { resolveMessage, openMessage, searchMessages } from "../src/messages/platform.ts";
import { MessageNavigation } from "../src/messages/navigation.ts";
import { parseMarkdown, sanitizeHtml, isSafeUrl } from "../src/markdown/markdown.ts";
import { encodePortableData, decodePortableText, toPortableNote } from "../src/portable/codec.ts";
import { planImport, materializeImportPlan, portableNotesEqual } from "../src/portable/import-plan.ts";
import { commitConfirmedImport } from "../src/portable/import-controller.ts";
import { localizePortableError } from "../src/ui/portable-errors.ts";
import type { MessageHeader, MessagesApi, MessageQuery, MessageDisplayApi, StorageArea } from "../src/api/browser.ts";

const reference = { locator: { version: 1 as const, headerMessageId: "test+id@example.test" }, subject: "Re: Request" };
function header(id = 1, overrides: Partial<MessageHeader> = {}): MessageHeader {
  return { id, headerMessageId: reference.locator.headerMessageId, subject: "Re: Request", author: "Sender <sender@example.test>", date: new Date(1700000000000), ...overrides };
}
function metadataApi(all: MessageHeader[], pageSize = 100): MessagesApi & { calls: MessageQuery[]; aborted: string[] } {
  const lists = new Map<string, MessageHeader[]>(), calls: MessageQuery[] = [], aborted: string[] = [];
  const page = (messages: MessageHeader[], id: string) => {
    const chunk = messages.slice(0, pageSize); const rest = messages.slice(pageSize);
    if (rest.length) lists.set(id, rest); else lists.delete(id);
    return { messages: chunk, id: rest.length ? id : null };
  };
  return { calls, aborted,
    async query(query) {
      calls.push(query);
      const matches = all.filter(message => (!query.headerMessageId || message.headerMessageId === query.headerMessageId) &&
        (!query.fromDate || message.date >= query.fromDate) && (!query.toDate || message.date <= query.toDate) &&
        (!query.subject || message.subject.toLowerCase().includes(query.subject.toLowerCase())) &&
        (!query.author || message.author.toLowerCase().includes(query.author.toLowerCase())));
      return page(matches, `list-${calls.length}`);
    },
    async continueList(id) { return page(lists.get(id) ?? [], id); },
    async abortList(id) { aborted.push(id); lists.delete(id); },
  };
}

describe("durable message locators and strict internal links", () => {
  it("round-trips deterministically without a session ID", () => {
    const uri = encodeMessageLocator(reference.locator);
    assert.equal(uri, "thundernotes-message:v1/test%2Bid%40example.test");
    assert.deepEqual(decodeMessageLocator(uri), reference.locator);
    assert.equal("id" in reference.locator, false);
  });
  for (const value of [null, {}, { version: 2, headerMessageId: "a@b" }, { version: 1, headerMessageId: "" },
    { version: 1, headerMessageId: "<a@b>" }, { version: 1, headerMessageId: "a\nb" }, { version: 1, headerMessageId: "a@b", id: 12 }]) {
    it(`rejects malformed locator ${JSON.stringify(value)}`, () => assert.equal(isMessageLocator(value), false));
  }
  for (const uri of ["thundernotes-message:12", "thundernotes-message:v2/a", "thundernotes-message:v1/%ZZ", "thundernotes-message:v1/%0A", "thundernotes-message:v1/a@b", "THUNDERNOTES-MESSAGE:v1/a", " thundernotes-message:v1/a"]) {
    it(`blocks malformed internal destination ${uri}`, () => { assert.equal(decodeMessageLocator(uri), null); assert.equal(isSafeUrl(uri), false); });
  }
  it("rejects external messages and messages without durable identity", () => {
    assert.equal(messageReference(header(4, { external: true })), null);
    assert.equal(messageReference(header(4, { headerMessageId: "" })), null);
  });
  it("stores only subject and locator from a saved message, including drafts", () => {
    assert.deepEqual(messageReference(header(900)), reference);
    assert.deepEqual(Object.keys(messageReference(header())!), ["locator", "subject"]);
  });
  it("renders safely escaped Markdown labels and preserves ordinary links", () => {
    const { document } = parseHTML("<html></html>");
    const subject = "[x](javascript:alert(1)) <b> `test` \\ text";
    const source = inlineMessageLink({ ...reference, subject });
    const html = parseMarkdown(source, {}, document).html;
    const wrapper = document.createElement("div"); wrapper.innerHTML = html;
    assert.equal(wrapper.querySelectorAll("a").length, 1);
    assert.equal(wrapper.querySelector("a")?.getAttribute("href"), encodeMessageLocator(reference.locator));
    assert.equal(wrapper.querySelector("a")?.textContent, subject);
    assert.equal(isSafeUrl("javascript:alert(1)"), false);
    assert.equal(isSafeUrl("https://example.test/"), true);
  });
  it("internal destinations are allowed on links only, not image sources", () => {
    const { document } = parseHTML("<html></html>");
    const uri = encodeMessageLocator(reference.locator);
    const html = sanitizeHtml(`<a href="${uri}" onclick="evil()">message</a><img src="${uri}">`, document);
    assert.ok(html.includes(`href="${uri}"`)); assert.ok(!html.includes("onclick")); assert.ok(!html.includes("src="));
    assert.equal(sanitizeHtml(html, document), html);
  });
  it("encodes URI punctuation and neutralizes label entities/autolinks", () => {
    const locator = { version: 1 as const, headerMessageId: "id('x')!@host" };
    const uri = encodeMessageLocator(locator); assert.ok(!/[()!']/.test(uri)); assert.deepEqual(decodeMessageLocator(uri), locator);
    const { document } = parseHTML("<html></html>"), wrapper = document.createElement("div");
    const subject = "&amp; https://example.test/ me@example.test **hi**";
    wrapper.innerHTML = parseMarkdown(inlineMessageLink({ locator, subject }), {}, document).html;
    assert.equal(wrapper.querySelectorAll("a").length, 1); assert.equal(wrapper.querySelector("a")?.textContent, subject);
  });
});

describe("metadata resolution and bounded unified picker queries", () => {
  it("resolves through headerMessageId across changed runtime IDs", async () => {
    const api = metadataApi([header(1000)]);
    assert.equal((await resolveMessage(api, reference.locator))?.id, 1000);
    assert.deepEqual(api.calls[0], { headerMessageId: reference.locator.headerMessageId, messagesPerPage: 2 });
  });
  it("fails closed for missing or duplicated RFC identities", async () => {
    assert.equal(await resolveMessage(metadataApi([]), reference.locator), null);
    const api = metadataApi([header(1), header(2)], 1);
    assert.equal(await resolveMessage(api, reference.locator), null);
  });
  it("opens only the currently resolved numeric ID, not an external URL", async () => {
    const opens: unknown[] = [];
    const display = { async open(value: unknown) { opens.push(value); } } as MessageDisplayApi;
    assert.equal(await openMessage(metadataApi([header(42)]), display, reference.locator), true);
    assert.deepEqual(opens, [{ messageId: 42, location: "tab", active: true }]);
    assert.equal(await openMessage(metadataApi([]), display, reference.locator), false);
    assert.equal(opens.length, 1);
  });
  it("saved draft ID changes fail safely instead of following another draft", async () => {
    assert.equal(await resolveMessage(metadataApi([header(2, { headerMessageId: "new-draft@host" })]), reference.locator), null);
  });
  it("sorts recent messages across arbitrary traversal order and date sources", async () => {
    const now = 1700000000000;
    const all = [header(1, { date: new Date(now - 60000) }), header(3, { date: new Date(now), subject: "Saved draft" }), header(2, { date: new Date(now - 1000), subject: "Sent message" })];
    const api = metadataApi(all);
    assert.deepEqual((await searchMessages(api, "", undefined, now)).messages.map(x => x.id), [3, 2, 1]);
    assert.ok(api.calls.every(call => !('fullText' in call) && !('body' in call) && !('online' in call)));
  });
  it("OR searches subject and author and deduplicates both query streams", async () => {
    const all = [header(1, { subject: "alpha" }), header(2, { author: "alpha" }), header(3, { subject: "alpha", author: "alpha" })];
    const api = metadataApi(all);
    assert.deepEqual((await searchMessages(api, "alpha", undefined, 1700000000000)).messages.map(x => x.id), [1, 2, 3]);
    assert.ok(api.calls.some(call => call.subject === "alpha")); assert.ok(api.calls.some(call => call.author === "alpha"));
  });
  it("bisects full windows rather than accepting mailbox-first pagination", async () => {
    const now = 1700000000000;
    const all = Array.from({ length: 250 }, (_, index) => header(index, { date: new Date(now - (250 - index) * 3600000) }));
    const api = metadataApi(all);
    const result = await searchMessages(api, "", undefined, now);
    assert.equal(result.messages.length, 50); assert.equal(result.messages[0]?.id, 249); assert.equal(result.messages[49]?.id, 200);
    assert.ok(api.aborted.length > 0); assert.ok(api.calls.length <= 64);
  });
  it("reports pathological identical-date overflow and honours cancellation", async () => {
    const api = metadataApi(Array.from({ length: 250 }, (_, index) => header(index)));
    assert.equal((await searchMessages(api, "", undefined, 1700000000000)).limited, true);
    assert.ok(api.calls.length <= 64);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(searchMessages(api, "", cancelled.signal), { name: "AbortError" });
  });
});

describe("one primary owner, persistence and Portable Data v1", () => {
  async function setup() { const repository = new MemoryNotesRepository(); const store = new NoteStore(repository, { autosaveDelayMs: 0 }); await store.init(); return { repository, store }; }
  it("creates a Plain/Edit-ready linked note then opens exactly that owner", async () => {
    const { repository, store } = await setup();
    const first = await store.openPrimaryNote(reference), second = await store.openPrimaryNote(reference);
    assert.equal(first.created, true); assert.equal(second.created, false); assert.equal(second.note.id, first.note.id);
    assert.equal(first.note.format, "plain"); assert.equal(first.note.content, "");
    assert.equal(store.getSelectedId(), first.note.id); assert.equal((await repository.getAll()).length, 1);
    store.dispose();
  });
  it("two stores racing share one atomically created owner", async () => {
    const { repository, store } = await setup(); const other = new NoteStore(repository); await other.init();
    const [a, b] = await Promise.all([store.openPrimaryNote(reference), other.openPrimaryNote(reference)]);
    assert.equal(a.note.id, b.note.id); assert.equal(Number(a.created) + Number(b.created), 1);
    assert.equal((await repository.getAll()).length, 1); store.dispose(); other.dispose();
  });
  it("new links remain visible under excluding filters", async () => {
    const { store } = await setup(); store.setSearch("unmatched"); store.setCreatedDateRange("2000-01-01", "2000-01-02");
    const result = await store.openPrimaryNote(reference); assert.equal(store.getVisible()[0]?.note.id, result.note.id); store.dispose();
  });
  it("does not resurrect an owner deleted between atomic capture and refresh", async () => {
    const { repository, store } = await setup();
    const capture = repository.createForMessage.bind(repository);
    repository.createForMessage = async note => {
      const result = await capture(note); await repository.delete(result.note.id); return result;
    };
    await assert.rejects(store.openPrimaryNote(reference), /owner changed/);
    assert.equal(store.getNotes().length, 0); assert.equal(store.getSelectedId(), null);
    assert.equal((await repository.getAll()).length, 0); store.dispose();
  });
  it("rechecks stale cached owners after another page unlinks or deletes them", async () => {
    const { repository, store } = await setup();
    const first = await store.openPrimaryNote(reference);
    const other = new NoteStore(repository); await other.init();
    other.unlinkPrimary(first.note.id); other.flushPending();
    await other.withMutationLock(session => session.writeBarrier());
    const second = await store.openPrimaryNote(reference);
    assert.equal(second.created, true); assert.notEqual(second.note.id, first.note.id);
    assert.equal(primaryMessage(store.getNoteSnapshot().find(note => note.id === first.note.id)!), null);
    await repository.delete(second.note.id);
    const third = await store.openPrimaryNote(reference);
    assert.equal(third.created, true); assert.notEqual(third.note.id, second.note.id);
    assert.equal(store.getNoteSnapshot().some(note => note.id === second.note.id), false);
    store.dispose(); other.dispose();
  });
  it("unlink changes metadata/revision only, autosaves, and permits a new owner", async () => {
    const { repository, store } = await setup(); const { note } = await store.openPrimaryNote(reference);
    store.updateNote(note.id, { content: "literal /mail and [reference](thundernotes-message:v1/a)" }); store.flushPending();
    const before = store.getNoteSnapshot()[0]!;
    store.unlinkPrimary(note.id); store.flushPending();
    await store.withMutationLock(session => session.writeBarrier());
    const after = (await repository.get(note.id))!;
    assert.equal(after.content, before.content); assert.equal(after.revision, before.revision + 1); assert.equal(primaryMessage(after), null);
    assert.equal((await store.openPrimaryNote(reference)).created, true); assert.equal(store.getNotes().length, 2); store.dispose();
  });
  it("confirmed normal deletion removes the owning relationship", async () => {
    const { repository, store } = await setup(); const result = await store.openPrimaryNote(reference);
    await store.deleteNote(result.note.id); assert.equal(primaryOwner(await repository.getAll(), reference.locator), null);
    assert.equal((await store.openPrimaryNote(reference)).created, true); store.dispose();
  });
  it("reload and old/new Portable Data backups preserve metadata and raw content", async () => {
    const { repository, store } = await setup(); const result = await store.openPrimaryNote(reference);
    const reloaded = new NoteStore(repository); await reloaded.init(); assert.deepEqual(primaryMessage(reloaded.getNoteSnapshot()[0]!), reference);
    const json = encodePortableData(store.getNoteSnapshot(), "0.2.2");
    const decoded = decodePortableText(json); assert.equal(decoded.formatVersion, 1);
    const restored = materializeImportPlan(planImport([], decoded.notes, "restore", "keep-current"));
    assert.deepEqual(primaryMessage(restored[0]!), reference);
    assert.equal(portableNotesEqual(toPortableNote(result.note), decoded.notes[0]!), true);
    assert.equal(decodePortableText(encodePortableData([createNote()], "0.2.2")).notes.length, 1);
    store.dispose(); reloaded.dispose();
  });
  it("Merge and Restore preserve valid relations; conflicting keep-both never replaces data", async () => {
    const { repository, store } = await setup(); const { note } = await store.openPrimaryNote(reference);
    const incoming = toPortableNote({ ...note, content: "changed", revision: note.revision + 1 });
    const keepBoth = planImport(store.getNoteSnapshot(), [incoming], "merge", "keep-both");
    await assert.rejects(commitConfirmedImport(store, keepBoth), MessageRelationConflictError);
    assert.equal((await repository.get(note.id))?.content, "");
    assert.ok(localizePortableError(new MessageRelationConflictError()).includes("primary"));
    assert.equal((await commitConfirmedImport(store, planImport(store.getNoteSnapshot(), [incoming], "merge", "use-imported"))).status, "committed");
    assert.deepEqual(primaryMessage(store.getNoteSnapshot()[0]!), reference);
    store.unlinkPrimary(note.id); store.flushPending();
    const restore = planImport(store.getNoteSnapshot(), [incoming], "restore", "keep-current");
    assert.equal((await commitConfirmedImport(store, restore)).status, "committed");
    assert.deepEqual(primaryMessage(store.getNoteSnapshot()[0]!), reference); store.dispose();
  });
  it("a second note cannot be assigned an already owned primary via metadata mutation", async () => {
    const { store } = await setup(); await store.openPrimaryNote(reference); const other = await store.createNote();
    assert.throws(() => store.updateNote(other.id, { meta: { [PRIMARY_MESSAGE_KEY]: reference } }), MessageRelationConflictError); store.dispose();
  });
  it("atomic IndexedDB creation checks ownership and adds in one readwrite transaction", async () => {
    const notes = new Map<string, ReturnType<typeof createNote>>(); let transactions = 0;
    const db = { transaction(names: string[], mode: string) {
      assert.deepEqual(names, ["notes"]); assert.equal(mode, "readwrite"); transactions++;
      const tx = { oncomplete: null as (() => void) | null, onerror: null, onabort: null, abort() {},
        objectStore() {
          const request = (result: unknown) => {
            const req = { result, onsuccess: null as (() => void) | null }; queueMicrotask(() => req.onsuccess?.()); return req;
          };
          return { getAll: () => request([...notes.values()]), add(note: ReturnType<typeof createNote>) { notes.set(note.id, note); return request(note.id); } };
        } };
      setTimeout(() => tx.oncomplete?.(), 0); return tx;
    } } as unknown as IDBDatabase;
    const repository = new IndexedDbNotesRepository();
    (repository as unknown as { dbPromise: Promise<IDBDatabase> }).dbPromise = Promise.resolve(db);
    const first = await repository.createForMessage(createNote({ meta: { [PRIMARY_MESSAGE_KEY]: reference } }));
    const again = await repository.createForMessage(createNote({ meta: { [PRIMARY_MESSAGE_KEY]: reference } }));
    assert.equal(first.created, true); assert.equal(again.created, false); assert.equal(notes.size, 1); assert.equal(transactions, 2);
  });
});

describe("Space navigation intent handshake", () => {
  function storage(): StorageArea {
    const data: Record<string, unknown> = {};
    return { async get() { return structuredClone(data); }, async set(value) { Object.assign(data, structuredClone(value)); }, async remove(key) { for (const name of Array.isArray(key) ? key : [key]) delete data[name]; }, async clear() { for (const key of Object.keys(data)) delete data[key]; } };
  }
  it("deduplicates repeated clicks before a page is ready", async () => {
    const queue = new MessageNavigation(storage()); await Promise.all([queue.enqueue(reference), queue.enqueue(reference)]);
    const intent = await queue.next("page"); assert.ok(intent); await queue.ack("page", intent.id); assert.equal(await queue.next("page"), null);
  });
  it("a second page cannot claim/ack another page's active lease", async () => {
    const queue = new MessageNavigation(storage()); await queue.enqueue(reference); const intent = await queue.next("first");
    assert.equal(await queue.next("second"), null); await queue.ack("second", intent!.id); assert.equal((await queue.next("first"))?.id, intent!.id);
  });
  it("background restart preserves unacked delivery and has no authoritative backlink database", async () => {
    const area = storage(), first = new MessageNavigation(area); await first.enqueue(reference); const intent = await first.next("old");
    const restarted = new MessageNavigation(area); assert.equal((await restarted.next("new"))?.id, intent!.id);
    await restarted.ack("new", intent!.id); assert.equal(await restarted.next("new"), null);
    const values = Object.values(await area.get()); assert.ok(values.every(value => Array.isArray(value) && value.length === 0));
  });
  it("expired page leases recover while stale navigation expires", async () => {
    let now = 100000000; const queue = new MessageNavigation(storage(), () => now);
    await queue.enqueue(reference); await queue.next("lost"); now += 30001; assert.ok(await queue.next("replacement"));
    now += 86400001; assert.equal(await queue.next("later"), null);
  });
});
