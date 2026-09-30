import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";

import { decodePortableText, encodePortableData } from "../src/portable/codec.ts";
import { DataDialog } from "../src/ui/data-dialog.ts";
import { MemoryNotesRepository } from "../src/storage/memory.ts";
import { NoteStore } from "../src/ui/store.ts";
import { note } from "./helpers.ts";

interface DialogHarness {
  document: Document;
  store: NoteStore;
  repository: MemoryNotesRepository;
  downloads: Array<{ text: string; filename: string }>;
  messages: string[];
}

const stores: NoteStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

function pageBody(): string {
  const raw = readFileSync(join(process.cwd(), "src", "ui", "notes.html"), "utf8");
  return /<body[^>]*>([\s\S]*)<\/body>/i.exec(raw)?.[1] ?? raw;
}

async function harness(seed = [note({ id: "local", content: "local" })]): Promise<DialogHarness> {
  const { document } = parseHTML(`<!doctype html><html><body>${pageBody()}</body></html>`);
  const repository = new MemoryNotesRepository();
  await repository.putMany(seed);
  const store = new NoteStore(repository, { autosaveDelayMs: 60_000 });
  stores.push(store);
  await store.init();
  const downloads: Array<{ text: string; filename: string }> = [];
  const messages: string[] = [];
  new DataDialog({
    root: document.getElementById("tn-data-dialog") as unknown as HTMLDialogElement,
    store,
    appVersion: "0.1.5",
    onMessage: (message) => messages.push(message),
    confirm: () => true,
    download: (text, filename) => downloads.push({ text, filename }),
  });
  return { document: document as unknown as Document, store, repository, downloads, messages };
}

function setSelectedFile(document: Document, text: string, name = "thundernotes-backup.json"): void {
  const bytes = new TextEncoder().encode(text);
  const file = {
    name,
    size: bytes.byteLength,
    async arrayBuffer(): Promise<ArrayBuffer> {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
  };
  const input = document.getElementById("tn-data-file") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  const EventConstructor = (document.defaultView as unknown as { Event: typeof Event }).Event;
  input.dispatchEvent(new EventConstructor("change"));
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("portable data dialog", () => {
  it("exports the current in-memory edit without waiting for autosave", async () => {
    const state = await harness();
    state.store.updateNote("local", { content: "unsaved rescue edit" });
    (state.document.getElementById("tn-data-export") as HTMLButtonElement).click();
    assert.equal(state.downloads.length, 1);
    assert.match(state.downloads[0]!.filename, /^thundernotes-backup-.*Z\.json$/);
    assert.equal(decodePortableText(state.downloads[0]!.text).notes[0]?.content, "unsaved rescue edit");
    assert.match(state.document.getElementById("tn-data-export-status")?.textContent ?? "", /download started/);
  });

  it("validates a selected file and presents metadata without note content", async () => {
    const state = await harness();
    const secret = "private imported content";
    setSelectedFile(
      state.document,
      encodePortableData([note({ id: "new", content: secret })], "0.1.5", new Date("2026-01-02T03:04:05Z")),
    );
    await settle();
    const summary = state.document.getElementById("tn-data-summary") as HTMLElement;
    assert.equal(summary.hidden, false);
    assert.equal(state.document.getElementById("tn-data-new-count")?.textContent, "1");
    assert.equal(summary.textContent?.includes(secret), false);
    assert.equal((state.document.getElementById("tn-data-import") as HTMLButtonElement).disabled, false);
  });

  it("shows a strict validation error and leaves the database unchanged", async () => {
    const state = await harness();
    setSelectedFile(state.document, "{broken");
    await settle();
    assert.match(state.document.getElementById("tn-data-import-status")?.textContent ?? "", /cannot be read/i);
    assert.deepEqual((await state.repository.getAll()).map((entry) => entry.id), ["local"]);
  });

  it("shows a localized domain error instead of the codec's technical message", async () => {
    const state = await harness();
    const newer = JSON.parse(encodePortableData([note({ id: "new" })], "0.1.5")) as {
      formatVersion: number;
    };
    newer.formatVersion = 999;
    setSelectedFile(state.document, JSON.stringify(newer));
    await settle();
    const status = state.document.getElementById("tn-data-import-status")?.textContent ?? "";
    assert.match(status, /backup format version 999 is newer than supported version 1/i);
    assert.equal(status.includes("Portable Data version 999"), false);
  });

  it("explains and enforces every Restore safety step", async () => {
    const state = await harness();
    const safety = state.document.getElementById("tn-data-safety-export") as HTMLButtonElement;
    const acknowledge = state.document.getElementById("tn-data-safety-ack") as HTMLInputElement;
    const restore = state.document.getElementById("tn-data-restore") as HTMLButtonElement;
    const sourceStep = state.document.getElementById("tn-data-restore-source-step") as HTMLElement;
    const source = state.document.getElementById("tn-data-restore-source") as HTMLElement;

    assert.equal(state.document.getElementById("tn-data-restore-source")?.closest("section")?.hidden, false);
    assert.match(sourceStep.textContent ?? "", /choose a backup/i);
    assert.match(source.textContent ?? "", /first choose a file.*above/i);
    assert.equal(safety.disabled, true);
    assert.equal(acknowledge.disabled, true);
    assert.equal(restore.disabled, true);

    setSelectedFile(
      state.document,
      encodePortableData([note({ id: "restored" })], "0.1.5"),
      "restore-source.json",
    );
    await settle();
    assert.match(sourceStep.textContent ?? "", /backup selected/i);
    assert.match(source.textContent ?? "", /restore-source\.json.*notes in backup: 1/i);
    assert.equal(safety.disabled, false);
    assert.equal(acknowledge.disabled, true);
    assert.equal(restore.disabled, true);
    safety.click();
    assert.equal(state.downloads.length, 1);
    assert.match(state.document.getElementById("tn-data-safety-status")?.textContent ?? "", /download started/i);
    assert.equal(acknowledge.disabled, false);
    assert.match(state.document.getElementById("tn-data-restore-summary")?.textContent ?? "", /current 1 notes.*1 notes/i);
    acknowledge.checked = true;
    const EventConstructor = (state.document.defaultView as unknown as { Event: typeof Event }).Event;
    acknowledge.dispatchEvent(new EventConstructor("change"));
    assert.equal(restore.disabled, false);
  });

  it("invalidates safety acknowledgement when the restore source changes", async () => {
    const state = await harness();
    const safety = state.document.getElementById("tn-data-safety-export") as HTMLButtonElement;
    const acknowledge = state.document.getElementById("tn-data-safety-ack") as HTMLInputElement;
    const restore = state.document.getElementById("tn-data-restore") as HTMLButtonElement;
    const source = state.document.getElementById("tn-data-restore-source") as HTMLElement;
    const EventConstructor = (state.document.defaultView as unknown as { Event: typeof Event }).Event;

    setSelectedFile(state.document, encodePortableData([note({ id: "first" })], "0.1.5"), "first.json");
    await settle();
    safety.click();
    acknowledge.checked = true;
    acknowledge.dispatchEvent(new EventConstructor("change"));
    assert.equal(restore.disabled, false);

    setSelectedFile(
      state.document,
      encodePortableData([note({ id: "second" }), note({ id: "third" })], "0.1.5"),
      "second.json",
    );
    await settle();
    assert.match(source.textContent ?? "", /second\.json.*notes in backup: 2/i);
    assert.equal(safety.disabled, false);
    assert.equal(acknowledge.checked, false);
    assert.equal(acknowledge.disabled, true);
    assert.equal(restore.disabled, true);
    assert.match(state.document.getElementById("tn-data-safety-status")?.textContent ?? "", /safety backup/i);
  });

  it("refreshes a stale merge preview and requires another click", async () => {
    const state = await harness([note({ id: "x", content: "local one" })]);
    setSelectedFile(
      state.document,
      encodePortableData([note({ id: "x", content: "imported" })], "0.1.5"),
    );
    await settle();
    state.store.updateNote("x", { content: "local two" });
    const importButton = state.document.getElementById("tn-data-import") as HTMLButtonElement;
    importButton.click();
    await settle();
    assert.match(state.document.getElementById("tn-data-import-status")?.textContent ?? "", /changed since this preview/);
    assert.equal((await state.repository.getAll()).length, 1);
    importButton.click();
    await settle();
    assert.equal((await state.repository.getAll()).length, 2);
  });

  it("invalidates a stale Restore safety backup and succeeds only after a new one", async () => {
    const state = await harness([note({ id: "local", content: "before" })]);
    setSelectedFile(
      state.document,
      encodePortableData([note({ id: "restored", content: "from backup" })], "0.1.5"),
    );
    await settle();
    const safety = state.document.getElementById("tn-data-safety-export") as HTMLButtonElement;
    const acknowledge = state.document.getElementById("tn-data-safety-ack") as HTMLInputElement;
    const restore = state.document.getElementById("tn-data-restore") as HTMLButtonElement;
    const EventConstructor = (state.document.defaultView as unknown as { Event: typeof Event }).Event;

    safety.click();
    acknowledge.checked = true;
    acknowledge.dispatchEvent(new EventConstructor("change"));
    state.store.updateNote("local", { content: "changed after safety backup" });
    restore.click();
    await settle();
    assert.equal(acknowledge.checked, false);
    assert.equal(acknowledge.disabled, true);
    assert.equal(restore.disabled, true);
    assert.match(state.document.getElementById("tn-data-import-status")?.textContent ?? "", /Download a new safety backup/);
    assert.match(state.document.getElementById("tn-data-safety-status")?.textContent ?? "", /safety backup/i);
    assert.deepEqual((await state.repository.getAll()).map((entry) => entry.id), ["local"]);

    safety.click();
    acknowledge.checked = true;
    acknowledge.dispatchEvent(new EventConstructor("change"));
    restore.click();
    await settle();
    assert.deepEqual((await state.repository.getAll()).map((entry) => entry.id), ["restored"]);
  });
});
