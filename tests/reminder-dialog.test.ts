import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { createNote, type Note } from "../src/notes/model.ts";
import {
  ReminderDialogController, reminderSetSuccessNotification, renderReminderTrigger, type ReminderDialogElements,
} from "../src/ui/reminder-dialog.ts";

const NOW = new Date(2030, 0, 2, 10, 0).getTime();
const FIRST_AT = new Date(2030, 0, 3, 12, 30).getTime();

function tick(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)); }

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(options: {
  permission?: boolean | Promise<boolean>;
  preflight?: boolean | Promise<boolean>;
  requestThrows?: unknown;
  saveRejects?: unknown;
  now?: number;
} = {}) {
  const { document, window } = parseHTML(`<!doctype html><button id="trigger"></button><dialog id="dialog"><form id="form">
    <input id="date" type="date"><input id="time" type="time"><button id="set"></button>
    <button id="remove"></button><button id="today"></button><button id="tomorrow"></button><p id="status"></p>
  </form></dialog>`);
  const dialog = document.getElementById("dialog") as unknown as HTMLDialogElement;
  let open = 0, closed = 0, requests = 0, saves = 0;
  Object.assign(dialog, { showModal: () => { open += 1; }, close: () => { closed += 1; } });
  const elements: ReminderDialogElements = {
    dialog,
    form: document.getElementById("form") as unknown as HTMLFormElement,
    trigger: document.getElementById("trigger") as unknown as HTMLButtonElement,
    date: document.getElementById("date") as unknown as HTMLInputElement,
    time: document.getElementById("time") as unknown as HTMLInputElement,
    set: document.getElementById("set") as unknown as HTMLButtonElement,
    remove: document.getElementById("remove") as unknown as HTMLButtonElement,
    today: document.getElementById("today") as unknown as HTMLButtonElement,
    tomorrow: document.getElementById("tomorrow") as unknown as HTMLButtonElement,
    status: document.getElementById("status") as unknown as HTMLElement,
  };
  let current: Note = createNote({ id: "note", createdAt: 1, updatedAt: 1 });
  const errors: unknown[] = [];
  const successes: number[] = [];
  new ReminderDialogController({
    elements, now: () => options.now ?? NOW, getNote: () => current,
    hasPermission: async () => await (options.preflight ?? false),
    requestPermission: () => {
      requests += 1;
      if (options.requestThrows !== undefined) throw options.requestThrows;
      return Promise.resolve(options.permission ?? true);
    },
    saveReminder: async (_id, at) => {
      saves += 1;
      if (options.saveRejects !== undefined) throw options.saveRejects;
      current = { ...current, reminder: { at } };
    },
    removeReminder: () => { current = { ...current, reminder: null }; },
    onSaved: (at) => { successes.push(at); renderReminderTrigger(elements.trigger, current); },
    logError: (_message, error) => errors.push(error),
  });
  const click = (element: Element) => element.dispatchEvent(new window.Event("click", { bubbles: true }));
  const keydown = (element: Element, key: string) => {
    const event = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.assign(event, { key, isComposing: false, repeat: false });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const openDialog = () => click(elements.trigger);
  const enter = (at = FIRST_AT) => {
    const date = new Date(at);
    const pad = (value: number) => String(value).padStart(2, "0");
    elements.date.value = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    elements.time.value = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  return { elements, click, keydown, openDialog, enter, current: () => current, errors, successes,
    counts: () => ({ open, closed, requests, saves }) };
}

describe("reminder dialog permission and Set flow", () => {
  it("initiates permissions.request synchronously from Set when not granted", () => {
    const permission = deferred<boolean>();
    const h = harness({ permission: permission.promise });
    h.openDialog(); h.enter(); h.click(h.elements.set);
    assert.equal(h.counts().requests, 1, "request must occur before the click handler returns");
    assert.equal(h.elements.set.disabled, true);
    permission.resolve(false);
  });

  it("saves, closes, and displays the active reminder after permission is granted", async () => {
    const h = harness({ permission: true });
    h.openDialog(); h.enter(); h.click(h.elements.set); await tick();
    assert.equal(h.current().reminder?.at, FIRST_AT);
    assert.deepEqual(h.counts(), { open: 1, closed: 1, requests: 1, saves: 1 });
    assert.match(h.elements.trigger.textContent ?? "", /Reminder ·/);
    assert.deepEqual(h.successes, [FIRST_AT]);
    const notification = reminderSetSuccessNotification(h.successes[0]!);
    assert.equal(notification.title, "Reminder set");
    assert.ok(notification.message.length > 0);
    assert.equal(h.elements.set.disabled, false);
  });

  it("keeps the dialog open and does not save after Deny", async () => {
    const h = harness({ permission: false });
    h.openDialog(); h.enter(); h.click(h.elements.set); await tick();
    assert.equal(h.current().reminder, null);
    assert.equal(h.counts().closed, 0);
    assert.equal(h.counts().saves, 0);
    assert.match(h.elements.status.textContent ?? "", /permission/i);
    assert.equal(h.elements.set.disabled, false);
  });

  it("shows and logs a permission request exception without closing", async () => {
    const error = new Error("request failed");
    const h = harness({ requestThrows: error });
    h.openDialog(); h.enter(); h.click(h.elements.set); await tick();
    assert.equal(h.counts().closed, 0);
    assert.equal(h.counts().saves, 0);
    assert.deepEqual(h.errors, [error]);
    assert.match(h.elements.status.textContent ?? "", /request failed/);
    assert.equal(h.elements.set.disabled, false);
  });

  it("reopens with the saved value and supports rescheduling", async () => {
    const h = harness({ permission: true, preflight: true });
    h.openDialog(); h.enter(); h.click(h.elements.set); await tick();
    h.openDialog();
    assert.equal(h.elements.date.value, "2030-01-03");
    assert.equal(h.elements.time.value, "12:30");
    const second = new Date(2030, 0, 4, 15, 45).getTime();
    h.enter(second); h.click(h.elements.set); await tick();
    assert.equal(h.current().reminder?.at, second);
    assert.equal(h.counts().saves, 2);
  });

  it("prevents duplicate submission while permission or save is pending", async () => {
    const permission = deferred<boolean>();
    const h = harness({ permission: permission.promise });
    h.openDialog(); h.enter();
    h.click(h.elements.set); h.click(h.elements.set);
    assert.equal(h.counts().requests, 1);
    permission.resolve(true); await tick();
    assert.equal(h.counts().saves, 1);
    assert.equal(h.counts().closed, 1);
  });

  it("does not request again when the open-dialog preflight already found permission", async () => {
    const h = harness({ preflight: true });
    h.openDialog(); await tick(); h.enter(); h.click(h.elements.set); await tick();
    assert.equal(h.counts().requests, 0);
    assert.equal(h.counts().saves, 1);
  });

  it("treats Enter in the date/time fields as Set", async () => {
    const h = harness({ permission: true });
    h.openDialog(); h.enter();
    assert.equal(h.keydown(h.elements.time, "Enter"), true);
    assert.equal(h.counts().requests, 1, "permission request remains in the keyboard user gesture");
    await tick();
    assert.equal(h.current().reminder?.at, FIRST_AT);
    assert.equal(h.counts().closed, 1);
  });

  it("keeps the dialog open for invalid keyboard submission", () => {
    const h = harness();
    h.openDialog();
    h.elements.date.value = ""; h.elements.time.value = "";
    assert.equal(h.keydown(h.elements.date, "Enter"), true);
    assert.equal(h.counts().requests, 0);
    assert.equal(h.counts().closed, 0);
    assert.match(h.elements.status.textContent ?? "", /future/i);
  });

  it("applies duplicate-submit protection to Enter", async () => {
    const permission = deferred<boolean>();
    const h = harness({ permission: permission.promise });
    h.openDialog(); h.enter();
    h.keydown(h.elements.time, "Enter"); h.keydown(h.elements.time, "Enter");
    assert.equal(h.counts().requests, 1);
    permission.resolve(true); await tick();
    assert.equal(h.counts().saves, 1);
    assert.equal(h.counts().closed, 1);
  });

  it("does not remap Enter on Remove and leaves Escape to the native dialog", async () => {
    const h = harness({ permission: true });
    h.openDialog(); h.enter(); h.click(h.elements.set); await tick();
    h.openDialog();
    assert.equal(h.keydown(h.elements.remove, "Enter"), false);
    assert.equal(h.counts().saves, 1);
    h.click(h.elements.remove);
    assert.equal(h.current().reminder, null);
    assert.equal(h.keydown(h.elements.date, "Escape"), false);
  });

  it("rounds Today strictly up to the next five minutes", () => {
    const cases = [
      { now: new Date(2030, 0, 2, 8, 4).getTime(), expected: "08:05" },
      { now: new Date(2030, 0, 2, 8, 7).getTime(), expected: "08:10" },
      { now: new Date(2030, 0, 2, 8, 10).getTime(), expected: "08:15" },
      { now: new Date(2030, 0, 2, 10, 58).getTime(), expected: "11:00" },
    ];
    for (const example of cases) {
      const h = harness({ now: example.now });
      h.click(h.elements.today);
      assert.equal(h.elements.date.value, "2030-01-02");
      assert.equal(h.elements.time.value, example.expected);
    }
  });

  it("carries Today across midnight and keeps Tomorrow on the next local date", () => {
    const now = new Date(2030, 11, 31, 23, 58).getTime();
    const today = harness({ now });
    today.click(today.elements.today);
    assert.equal(today.elements.date.value, "2031-01-01");
    assert.equal(today.elements.time.value, "00:00");

    const tomorrow = harness({ now });
    tomorrow.click(tomorrow.elements.tomorrow);
    assert.equal(tomorrow.elements.date.value, "2031-01-01");
    assert.equal(tomorrow.elements.time.value, "00:00");
  });

  it("uses tomorrow's date with the same next-five-minute local clock time", () => {
    const h = harness({ now: new Date(2030, 0, 2, 8, 7).getTime() });
    h.click(h.elements.tomorrow);
    assert.equal(h.elements.date.value, "2030-01-03");
    assert.equal(h.elements.time.value, "08:10");
  });
});
