import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createNote } from "../src/notes/model.ts";
import { primaryMessageReference, messageKind, primaryMessage, isMessageReference, enrichMessageReference, PRIMARY_MESSAGE_KEY, type MessageReference } from "../src/messages/locator.ts";
import { formatPrimaryMessage } from "../src/messages/presentation.ts";
import { formatDateTime } from "../src/i18n/index.ts";
import { NoteStore } from "../src/ui/store.ts";
import { MemoryNotesRepository } from "../src/storage/memory.ts";
import { encodePortableData, decodePortableText, toPortableNote } from "../src/portable/codec.ts";
import { materializeImportPlan, planImport } from "../src/portable/import-plan.ts";
import type { MessageHeader, ThunderbirdBrowser } from "../src/api/browser.ts";

const old: MessageReference = { locator: { version: 1, headerMessageId: "context@test" }, subject: "Request" };
const header: MessageHeader = { id: 7, headerMessageId: "context@test", subject: "Request", author: "Alice <alice@test>", recipients: ["Bob <bob@test>"], date: new Date(1700000000000) };
function localized<T>(locale: string, run: () => T): T {
  const previous = globalThis.browser;
  const catalog = JSON.parse(readFileSync(`_locales/${locale}/messages.json`, "utf8")) as Record<string, { message: string }>;
  globalThis.browser = { i18n: { getUILanguage: () => locale, getMessage: (key: string, subs?: string | string[]) => catalog[key]?.message.replace(/\$(\d+)/g, (_, index: string) => (Array.isArray(subs) ? subs : [subs])[Number(index) - 1] ?? "") ?? "" } } as ThunderbirdBrowser;
  try { return run(); } finally { globalThis.browser = previous; }
}
describe("primary message snapshot and conservative kind", () => {
  it("accepts old and incomplete snapshots without destructive migration", () => {
    assert.equal(isMessageReference(old), true);
    assert.deepEqual(primaryMessage(createNote({ meta: { [PRIMARY_MESSAGE_KEY]: old } })), old);
    assert.equal(isMessageReference({ ...old, kind: "draft" }), true);
  });
  for (const [specialUse, kind] of [["inbox", "incoming"], ["sent", "outgoing"], ["drafts", "draft"]] as const) {
    it(`uses supplied ${specialUse} special-use evidence`, () => {
      const snapshot = primaryMessageReference({ ...header, folder: { specialUse: [specialUse] } })!;
      assert.equal(snapshot.kind, kind); assert.equal(snapshot.author, header.author);
      assert.deepEqual(snapshot.recipients, header.recipients); assert.equal(snapshot.date, header.date.getTime());
      assert.equal("folder" in snapshot, false); assert.equal("id" in snapshot, false);
    });
  }
  it("falls back for missing/custom/mixed folder evidence without address or new/read heuristics", () => {
    assert.equal(messageKind(header), "unknown");
    assert.equal(messageKind({ ...header, folder: { specialUse: ["archives"] } }), "unknown");
    assert.equal(messageKind({ ...header, folder: { specialUse: ["inbox", "sent"] } }), "unknown");
    assert.equal(messageKind({ ...header, new: true, read: false } as MessageHeader), "unknown");
  });
  it("stores machine snapshots independently of UI locale and copies recipients", () => {
    const en = localized("en", () => primaryMessageReference(header)!);
    const ru = localized("ru", () => primaryMessageReference(header)!);
    assert.deepEqual(en, ru); assert.notEqual(en.recipients, header.recipients);
    assert.deepEqual(Object.keys(en), ["locator", "subject", "kind", "author", "recipients", "date"]);
  });
  it("omits unavailable values rather than inventing them", () => {
    const snapshot = primaryMessageReference({ ...header, subject: "", author: "", recipients: [], date: new Date(NaN) })!;
    assert.equal(snapshot.subject, ""); assert.equal(snapshot.kind, "unknown");
    assert.equal("author" in snapshot, false); assert.equal("recipients" in snapshot, false); assert.equal("date" in snapshot, false);
  });
  it("never reads body or attachment data from a metadata snapshot", () => {
    const guarded = { ...header };
    for (const property of ["body", "attachments", "raw", "headers"]) {
      Object.defineProperty(guarded, property, { enumerable: true, get() { throw new Error(`Read forbidden field ${property}`); } });
    }
    assert.deepEqual(primaryMessageReference(guarded), primaryMessageReference(header));
  });
  it("preserves captured kind and identity after moving to custom folders", () => {
    const incoming = primaryMessageReference({ ...header, folder: { specialUse: ["inbox"] } })!;
    assert.equal(enrichMessageReference(incoming, primaryMessageReference(header)!), incoming);
    assert.equal(enrichMessageReference(incoming, { ...old, locator: { version: 1, headerMessageId: "other@test" }, author: "other" }), incoming);
  });
});

describe("locale-aware primary message presentation", () => {
  it("separates the primary subject from participants and date for every known kind", () => localized("en", () => {
    const incoming = formatPrimaryMessage({ ...primaryMessageReference(header)!, kind: "incoming" });
    assert.equal(incoming.subject, "Request");
    assert.equal(incoming.metadata, header.author + " → Bob <bob@test> · " + formatDateTime(header.date.getTime()));
    for (const kind of ["outgoing", "draft"] as const) {
      const display = formatPrimaryMessage({ ...primaryMessageReference(header)!, kind });
      assert.equal(display.subject, "Request");
      assert.equal(display.metadata, header.author + " → Bob <bob@test> · " + formatDateTime(header.date.getTime()));
    }
  }));
  it("unknown uses neutral author → recipients without a question or diagnostic label", () => localized("en", () => {
    const display = formatPrimaryMessage(primaryMessageReference(header)!);
    assert.equal(display.metadata, "Alice <alice@test> → Bob <bob@test> · " + formatDateTime(header.date.getTime()));
    assert.equal(display.subject, "Request");
    assert.doesNotMatch(display.title, /unknown|From:|To:|\?/i);
    assert.equal("badge" in display, false);
  }));
  for (const [author, recipients, expected] of [
    ["Alice", ["Bob", "Carol"], "Alice → Bob, Carol"],
    [undefined, ["Bob"], "Bob"],
    ["Alice", undefined, "Alice"],
    [" ", [" "], ""],
  ] as const) {
    it("omits missing participant separators: " + (expected || "no participants"), () => localized("en", () => {
      const display = formatPrimaryMessage({ ...old, kind: "unknown", author, recipients: recipients ? [...recipients] : undefined });
      assert.equal(display.metadata, expected);
      assert.equal(display.subject, "Request");
      assert.equal(display.title, "Linked message: Request" + (expected ? " · " + expected : ""));
    }));
  }
  it("date-only identity remains readable", () => localized("en", () => {
    assert.equal(formatPrimaryMessage({ ...old, date: header.date.getTime() }).metadata, formatDateTime(header.date.getTime()));
  }));
  it("missing subject/correspondent/date and old subject-only snapshots remain readable", () => localized("en", () => {
    const display = formatPrimaryMessage({ ...old, subject: "", kind: "draft", recipients: [" "] });
    assert.equal(display.subject, "(No subject)"); assert.equal(display.metadata, "");
    assert.equal(formatPrimaryMessage(old).subject, "Request");
  }));
  it("RU/EN localize empty subject, status and date without changing stored source", () => {
    const snapshot = primaryMessageReference(header)!, before = JSON.stringify(snapshot);
    for (const locale of ["en", "ru"]) localized(locale, () => {
      const display = formatPrimaryMessage({ ...snapshot, subject: "" }, true);
      assert.equal(display.subject, locale === "en" ? "(No subject)" : "(Без темы)");
      assert.ok(display.metadata.startsWith(locale === "en" ? "Message unavailable · " : "Письмо недоступно · "));
      assert.ok(display.metadata.endsWith(formatDateTime(snapshot.date!)));
      assert.doesNotMatch(display.title, /unknown|Неизвестно|\?/i);
    });
    assert.equal(JSON.stringify(snapshot), before);
  });
  it("unavailable preserves the complete saved identity and long subjects", () => localized("en", () => {
    const snapshot = { ...primaryMessageReference(header)!, subject: "Long ".repeat(100), recipients: ["Bob", "Carol"] };
    const display = formatPrimaryMessage(snapshot, true);
    assert.equal(display.subject, snapshot.subject);
    assert.ok(display.metadata.startsWith("Message unavailable · Alice"));
    assert.ok(display.title.includes(snapshot.subject));
    assert.ok(display.title.includes("Alice <alice@test> → Bob, Carol"));
    assert.ok(display.title.includes(formatDateTime(snapshot.date!)));
  }));
});

describe("primary context persistence and Portable Data v1", () => {
  it("enriches once through revision/autosave and unlink preserves unrelated meta/content", async () => {
    const repository = new MemoryNotesRepository(), store = new NoteStore(repository, { autosaveDelayMs: 0 });
    await store.init();
    const note = await store.createNote({ content: "keep [mail](thundernotes-message:v1/a)", meta: { other: { keep: true }, [PRIMARY_MESSAGE_KEY]: old } });
    const fresh = primaryMessageReference(header)!;
    store.enrichPrimarySnapshot(note.id, fresh); store.enrichPrimarySnapshot(note.id, fresh);
    assert.equal(store.getSelectedNote()!.revision, note.revision + 1);
    await store.withMutationLock(session => session.writeBarrier());
    const reloaded = new NoteStore(repository); await reloaded.init();
    assert.deepEqual(primaryMessage(reloaded.getNoteSnapshot()[0]!), { ...old, kind: "unknown", author: header.author, recipients: header.recipients, date: header.date.getTime() });
    store.unlinkPrimary(note.id); store.enrichPrimarySnapshot(note.id, fresh);
    await store.withMutationLock(session => session.writeBarrier());
    const saved = (await repository.get(note.id))!;
    assert.deepEqual(saved.meta, { other: { keep: true } }); assert.equal(saved.content, note.content);
    store.dispose(); reloaded.dispose();
  });
  it("round-trips rich and old backups through export, Merge and Restore", () => {
    for (const snapshot of [old, primaryMessageReference({ ...header, folder: { specialUse: ["drafts"] } })!]) {
      const note = createNote({ meta: { [PRIMARY_MESSAGE_KEY]: snapshot } });
      const decoded = decodePortableText(encodePortableData([note], "0.2.2")); assert.equal(decoded.formatVersion, 1);
      for (const mode of ["merge", "restore"] as const) {
        const result = materializeImportPlan(planImport([], decoded.notes, mode, "keep-current"));
        assert.deepEqual(primaryMessage(result[0]!), snapshot);
        assert.deepEqual(toPortableNote(result[0]!).meta, note.meta);
      }
    }
    assert.equal(decodePortableText(encodePortableData([createNote()], "0.2.2")).notes.length, 1);
  });
  it("UI style uses local icon, truncation and existing theme/focus states", () => {
    const css = readFileSync("src/ui/notes.css", "utf8");
    assert.match(css, /\.tn-primary-message__subject\s*\{[^}]*text-overflow:\s*ellipsis/);
    assert.match(css, /\.tn-primary-message__unlink:active\s*\{[^}]*var\(--tn-selected\)/);
    assert.match(css, /\.tn-primary-message__unlink:focus-visible/); assert.match(css, /\.tn-primary-message__unlink:hover/);
    assert.match(css, /\.tn-primary-message__subject[^}]*font-size:\s*14px[^}]*font-weight:\s*600/);
    assert.match(css, /@media[^}]*\.tn-primary-message[^}]*max-width:\s*100%/);
    assert.ok(readFileSync("assets/icons/mail.svg", "utf8").includes("<svg"));
    assert.match(css, /\.tn-icon--mail[^}]*assets\/icons\/mail\.svg/);
    assert.match(css, /\.tn-primary-message__metadata[^}]*text-overflow:\s*ellipsis/);
    assert.match(css, /grid-template-columns:\s*30px minmax\(0, 1fr\)/);
    assert.match(css, /@media[^}]*\.tn-primary-message[^}]*flex-basis:\s*100%/);
    assert.match(css, /\.tn-primary-message\s*\{[^}]*align-items:\s*center/);
    assert.match(css, /\.tn-primary-message__link\s*\{[^}]*align-items:\s*center[^}]*border:\s*1px solid var\(--tn-border\)[^}]*border-radius:\s*5px[^}]*background:\s*var\(--tn-panel-alt-bg\)/);
    assert.match(css, /\.tn-primary-message__link:hover\s*\{[^}]*background:\s*var\(--tn-hover\)[^}]*border-color:/);
    assert.match(css, /\.tn-primary-message__link:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--tn-focus\)/);
    assert.match(css, /\.tn-primary-message__icon-area\s*\{[^}]*align-items:\s*center[^}]*width:\s*30px[^}]*height:\s*30px/);
    assert.match(css, /\.tn-primary-message__icon\.tn-icon\s*\{[^}]*width:\s*18px[^}]*height:\s*18px/);
    assert.match(css, /\.tn-primary-message__unlink\s*\{[^}]*align-items:\s*center[^}]*flex:\s*0 0 30px[^}]*width:\s*30px[^}]*height:\s*30px/);
    assert.match(css, /\.tn-icon--unlink[^}]*assets\/icons\/unlink\.svg/);
    assert.ok(readFileSync("assets/icons/unlink.svg", "utf8").includes("<svg"));
    for (const locale of ["en", "ru"]) {
      const json = JSON.parse(readFileSync(`_locales/${locale}/messages.json`, "utf8"));
      assert.equal(json.messageUnlink.message, locale === "en" ? "Unlink message" : "Отвязать письмо");
      assert.equal(json.messageUnlinkShort.message, locale === "en" ? "Unlink" : "Отвязать");
    }
  });
});
