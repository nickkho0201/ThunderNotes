import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Alarm, ThunderbirdBrowser } from "../src/api/browser.ts";
import { DEFAULT_FILTER, selectNotesFromNotes } from "../src/notes/query.ts";
import { normalizeNote } from "../src/notes/model.ts";
import { MemoryNotesRepository } from "../src/storage/memory.ts";
import { NoteStore } from "../src/ui/store.ts";
import { ReminderService } from "../src/reminders/service.ts";
import { reminderAlarmId } from "../src/reminders/protocol.ts";
import { decodePortableText, encodePortableData, portableNoteToNote } from "../src/portable/codec.ts";
import { ids, note } from "./helpers.ts";

describe("favorites and pinned notes", () => {
  const notes = [
    note({ id: "red-fav", content: "invoice", color: "red", favorite: true, createdAt: 100 }),
    note({ id: "blue-fav", content: "other", color: "blue", favorite: true, createdAt: 200 }),
    note({ id: "red", content: "invoice", color: "red", createdAt: 300 }),
  ];

  it("defaults missing historical fields safely", () => {
    const normalized = normalizeNote({ id: "old", content: "", createdAt: 1, updatedAt: 1, revision: 1 });
    assert.equal(normalized?.favorite, false);
    assert.equal(normalized?.pinned, false);
    assert.equal(normalized?.reminder, null);
    assert.equal(normalizeNote({
      id: "completed", content: "", createdAt: 1, updatedAt: 1, revision: 1,
      reminder: { at: 2_000, firedAt: 2_100 },
    })?.reminder, null);
  });

  it("ANDs favorites with search/date and the OR color group", () => {
    const selected = selectNotesFromNotes(notes, {
      ...DEFAULT_FILTER, search: "invoice", favoriteOnly: true, colors: ["red", "blue"],
      createdFrom: "1970-01-01", createdTo: "1970-01-01",
    });
    assert.deepEqual(ids(selected), ["red-fav"]);
  });

  it("keeps pinned first and preserves the selected sort inside both groups", () => {
    const selected = selectNotesFromNotes([
      note({ id: "regular-new", createdAt: 400 }), note({ id: "pinned-old", createdAt: 100, pinned: true }),
      note({ id: "pinned-new", createdAt: 300, pinned: true }), note({ id: "regular-old", createdAt: 200 }),
    ], { ...DEFAULT_FILTER, sort: "created-desc" });
    assert.deepEqual(ids(selected), ["pinned-new", "pinned-old", "regular-new", "regular-old"]);
  });

  it("does not let pin bypass favorite/color filters", () => {
    const selected = selectNotesFromNotes([
      note({ id: "hidden-pin", pinned: true, favorite: false, color: "blue" }),
      note({ id: "shown", favorite: true, color: "red" }),
    ], { ...DEFAULT_FILTER, favoriteOnly: true, colors: ["red"] });
    assert.deepEqual(ids(selected), ["shown"]);
  });

  it("toggles and immediately persists independent favorite and pin state", async () => {
    const repository = new MemoryNotesRepository();
    await repository.create(note({ id: "a" }));
    const store = new NoteStore(repository, { autosaveDelayMs: 0 });
    await store.init();
    store.toggleFavorite("a"); store.togglePinned("a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((await repository.get("a"))?.favorite, true);
    assert.equal((await repository.get("a"))?.pinned, true);
  });

  it("round-trips favorite, pin, reminder and accepts old exports without them", () => {
    const original = note({ id: "portable", favorite: true, pinned: true, reminder: { at: 2_000 } });
    const decoded = decodePortableText(encodePortableData([original], "test")).notes[0]!;
    assert.deepEqual(portableNoteToNote(decoded), original);
    const legacy = { ...decoded } as Record<string, unknown>;
    delete legacy.favorite; delete legacy.pinned; delete legacy.reminder;
    assert.deepEqual(portableNoteToNote(legacy as unknown as typeof decoded), { ...original, favorite: false, pinned: false, reminder: null });
  });

  it("imports a legacy completed reminder as inactive", () => {
    const original = note({ id: "completed", reminder: { at: 2_000 } });
    const decoded = decodePortableText(encodePortableData([original], "test")).notes[0]!;
    decoded.reminder = { at: 2_000, firedAt: 2_100 };
    assert.equal(portableNoteToNote(decoded).reminder, null);
  });

  it("creates, reschedules and cancels reminder state with firedAt reset", async () => {
    const repository = new MemoryNotesRepository();
    await repository.create(note({ id: "a", reminder: { at: 500, firedAt: 600 } }));
    const store = new NoteStore(repository, { autosaveDelayMs: 0 });
    await store.init();
    store.setReminder("a", 2_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual((await repository.get("a"))?.reminder, { at: 2_000 });
    store.removeReminder("a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((await repository.get("a"))?.reminder, null);
  });
});

function reminderApi() {
  const alarms = new Map<string, Alarm>();
  const notifications: string[] = [];
  const messages: unknown[] = [];
  const api = {
    alarms: {
      create(name: string, info: { when: number }) { alarms.set(name, { name, scheduledTime: info.when }); },
      async clear(name: string) { return alarms.delete(name); },
      async get(name: string) { return alarms.get(name); },
      async getAll() { return [...alarms.values()]; },
      onAlarm: { addListener() {} },
    },
    notifications: { async create(id: string) { notifications.push(id); return id; }, onClicked: { addListener() {} } },
    permissions: { async contains() { return true; }, async request() { return true; } },
    runtime: {
      getURL: (path: string) => path, getManifest: () => ({ version: "test" }),
      async sendMessage(message: unknown) { messages.push(message); },
    },
  } as unknown as ThunderbirdBrowser;
  return { api, alarms, notifications, messages };
}

describe("reminder runtime reconciliation", () => {
  it("restores missing alarms, replaces stale times and clears orphan alarms", async () => {
    const repository = new MemoryNotesRepository();
    await repository.putMany([note({ id: "a", reminder: { at: 2_000 } }), note({ id: "b", reminder: { at: 3_000 } })]);
    const fake = reminderApi();
    fake.alarms.set(reminderAlarmId("a"), { name: reminderAlarmId("a"), scheduledTime: 1_500 });
    fake.alarms.set(reminderAlarmId("gone"), { name: reminderAlarmId("gone"), scheduledTime: 4_000 });
    await new ReminderService(fake.api, repository, () => 1_000).reconcile();
    assert.equal(fake.alarms.get(reminderAlarmId("a"))?.scheduledTime, 2_000);
    assert.equal(fake.alarms.get(reminderAlarmId("b"))?.scheduledTime, 3_000);
    assert.equal(fake.alarms.has(reminderAlarmId("gone")), false);
  });

  it("delivers an overdue reminder once on startup, clears it, and does not repeat", async () => {
    const repository = new MemoryNotesRepository();
    await repository.create(note({ id: "due", content: "Pay invoice", reminder: { at: 900 } }));
    const fake = reminderApi();
    fake.alarms.set(reminderAlarmId("due"), { name: reminderAlarmId("due"), scheduledTime: 900 });
    const service = new ReminderService(fake.api, repository, () => 1_000);
    await service.reconcile();
    assert.equal((await repository.get("due"))?.reminder, null);
    assert.equal(fake.alarms.has(reminderAlarmId("due")), false);
    assert.equal(fake.notifications.length, 1);
    assert.deepEqual(fake.messages, [{ type: "thundernotes:reminder-fired", noteId: "due", at: 900, firedAt: 1_000 }]);
    await new ReminderService(fake.api, repository, () => 2_000).reconcile();
    assert.equal(fake.notifications.length, 1);
  });

  it("ignores a stale alarm after rescheduling and fires the current alarm", async () => {
    const repository = new MemoryNotesRepository();
    await repository.create(note({ id: "a", reminder: { at: 2_000 } }));
    const fake = reminderApi();
    const service = new ReminderService(fake.api, repository, () => 3_000);
    await service.handleAlarm({ name: reminderAlarmId("a"), scheduledTime: 1_500 });
    assert.deepEqual((await repository.get("a"))?.reminder, { at: 2_000 });
    await service.handleAlarm({ name: reminderAlarmId("a"), scheduledTime: 2_000 });
    assert.equal((await repository.get("a"))?.reminder, null);
  });

  it("updates an open UI store from active to completed without retaining history as a schedule", async () => {
    const repository = new MemoryNotesRepository();
    await repository.create(note({ id: "open", reminder: { at: 2_000 } }));
    const store = new NoteStore(repository, { autosaveDelayMs: 0 });
    await store.init();
    store.applyReminderCompleted("open", 2_000, 3_000);
    assert.equal(store.getNotes()[0]?.note.reminder, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((await repository.get("open"))?.reminder, null);
  });

  it("coalesces concurrent alarm delivery for the same note", async () => {
    const repository = new MemoryNotesRepository();
    await repository.create(note({ id: "race", reminder: { at: 2_000 } }));
    const fake = reminderApi();
    const service = new ReminderService(fake.api, repository, () => 3_000);
    const alarm = { name: reminderAlarmId("race"), scheduledTime: 2_000 };
    await Promise.all([service.handleAlarm(alarm), service.handleAlarm(alarm)]);
    assert.equal(fake.notifications.length, 1);
    assert.equal((await repository.get("race"))?.reminder, null);
  });

  it("cleans the runtime alarm after note deletion", async () => {
    const repository = new MemoryNotesRepository();
    await repository.create(note({ id: "deleted", reminder: { at: 2_000 } }));
    const fake = reminderApi();
    fake.alarms.set(reminderAlarmId("deleted"), { name: reminderAlarmId("deleted"), scheduledTime: 2_000 });
    await repository.delete("deleted");
    await new ReminderService(fake.api, repository, () => 1_000).reconcile();
    assert.equal(fake.alarms.has(reminderAlarmId("deleted")), false);
  });
});
