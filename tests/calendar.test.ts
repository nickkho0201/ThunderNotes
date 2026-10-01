import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { bindCreatedDateFilter, calendarDays } from "../src/ui/date-filter.ts";
import { NoteStore } from "../src/ui/store.ts";
import { MemoryNotesRepository } from "../src/storage/memory.ts";
import { note } from "./helpers.ts";
import { t } from "../src/i18n/index.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
async function calendar(locale = "en-US") {
  const { document, window } = parseHTML(readFileSync("src/ui/notes.html", "utf8"));
  const doc = document as unknown as Document;
  const prototype = window.HTMLElement.prototype;
  const original = prototype.focus;
  Object.defineProperty(doc, "activeElement", { configurable: true, writable: true, value: null });
  prototype.focus = function () { Object.defineProperty(doc, "activeElement", { configurable: true, writable: true, value: this }); };
  const store = new NoteStore(new MemoryNotesRepository()); await store.init();
  const root = doc.getElementById("tn-date-filter")!;
  const trigger = doc.getElementById("tn-date-trigger") as HTMLButtonElement;
  const popover = doc.getElementById("tn-date-popover")!;
  bindCreatedDateFilter({ root, trigger, popover, store, locale, now: () => new Date(2026, 8, 30) });
  cleanup.push(() => { store.dispose(); prototype.focus = original; });
  const button = (id: string) => doc.getElementById(id) as HTMLButtonElement;
  const day = (date: string) => root.querySelector<HTMLButtonElement>(`[data-date="${date}"]`)!;
  const key = (target: HTMLElement, name: string) => {
    const event = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.assign(event, { key: name }); target.dispatchEvent(event); return event;
  };
  return { doc, root, trigger, popover, store, button, day, key, window };
}

describe("single calendar range picker", () => {
  it("shows the filter label before selection and after reset, with RU/EN catalogues", async () => {
    const c = await calendar(); assert.equal(c.trigger.textContent, t("createdDateLabel"));
    for (const [locale, label] of [["en", "Date filter"], ["ru", "Фильтр по дате"]]) {
      assert.equal(JSON.parse(readFileSync(`_locales/${locale}/messages.json`, "utf8")).createdDateLabel.message, label);
    }
    c.store.setCreatedDateRange("2026-09-01", "2026-09-03");
    assert.notEqual(c.trigger.textContent, t("createdDateLabel"));
    c.trigger.click(); c.button("tn-date-reset").click(); assert.equal(c.trigger.textContent, t("createdDateLabel"));
  });
  it("jumps directly to a distant year and month without applying or losing the draft", async () => {
    const c = await calendar(); c.trigger.click(); c.day("2026-09-30").click();
    c.button("tn-date-month").click();
    const chooser = c.doc.getElementById("tn-date-month-year")!;
    const year = c.doc.getElementById("tn-date-year") as HTMLInputElement;
    assert.equal(chooser.hidden, false); assert.equal(c.doc.getElementById("tn-date-days")!.hidden, true);
    assert.equal(c.doc.activeElement, year); assert.equal(year.value, "2026");
    year.value = "2023"; year.dispatchEvent(new c.window.Event("change"));
    c.root.querySelector<HTMLButtonElement>('[data-month="2"]')!.click();
    assert.equal(chooser.hidden, true); assert.equal((c.doc.activeElement as HTMLElement).dataset.date, "2023-03-01");
    assert.equal(c.store.getFilter().createdFrom, "");
    c.day("2023-03-15").click();
    assert.equal(c.store.getFilter().createdFrom, "2023-03-15");
    assert.equal(c.store.getFilter().createdTo, "2026-09-30");
  });
  it("keeps applied dates through selector navigation, back and two-step Escape", async () => {
    const c = await calendar(); c.store.setCreatedDateRange("2026-09-01", "2026-09-03"); c.trigger.click();
    c.button("tn-date-month").click(); c.button("tn-date-year-prev").click();
    assert.equal((c.doc.getElementById("tn-date-year") as HTMLInputElement).value, "2025");
    c.button("tn-date-year-next").click();
    c.button("tn-date-back").click(); assert.equal(c.doc.activeElement, c.button("tn-date-month"));
    c.button("tn-date-month").click(); c.key(c.doc.getElementById("tn-date-year")!, "Escape");
    assert.equal(c.popover.hidden, false); assert.equal(c.doc.activeElement, c.button("tn-date-month"));
    assert.equal(c.store.getFilter().createdFrom, "2026-09-01"); assert.equal(c.store.getFilter().createdTo, "2026-09-03");
    c.key(c.button("tn-date-month"), "Escape"); assert.equal(c.popover.hidden, true); assert.equal(c.doc.activeElement, c.trigger);
  });
  it("supports keyboard month grid navigation, localizes months and validates year", async () => {
    const c = await calendar("ru-RU"); c.trigger.click(); c.button("tn-date-month").click();
    const first = c.root.querySelector<HTMLButtonElement>('[data-month="0"]')!;
    assert.match(first.textContent!, /янв/);
    c.key(first, "ArrowDown"); assert.equal((c.doc.activeElement as HTMLElement).dataset.month, "3");
    c.key(c.doc.activeElement as HTMLElement, "End"); assert.equal((c.doc.activeElement as HTMLElement).dataset.month, "11");
    c.key(c.doc.activeElement as HTMLElement, "Home"); assert.equal((c.doc.activeElement as HTMLElement).dataset.month, "0");
    const year = c.doc.getElementById("tn-date-year") as HTMLInputElement;
    year.value = "10000"; year.dispatchEvent(new c.window.Event("change")); first.click();
    assert.equal(year.getAttribute("aria-invalid"), "true"); assert.equal(c.doc.getElementById("tn-date-month-year")!.hidden, false);
    year.value = "23"; year.dispatchEvent(new c.window.Event("change"));
    assert.equal(c.root.querySelector('[data-month="0"]'), first, "blur must not destroy the pending click target");
    c.key(year, "Enter"); assert.equal((c.doc.activeElement as HTMLElement).dataset.month, "8");
    c.root.querySelector<HTMLButtonElement>('[data-month="0"]')!.click();
    assert.equal((c.doc.activeElement as HTMLElement).dataset.date, "0023-01-01");
    assert.match(readFileSync("src/ui/notes.css", "utf8"), /\.tn-date-months \.is-active.*var\(--tn-selected\)/);
  });
  it("retains draft across month chooser and a month boundary", async () => {
    const c = await calendar(); c.trigger.click(); c.day("2026-09-30").click(); c.button("tn-date-month").click();
    c.root.querySelector<HTMLButtonElement>('[data-month="9"]')!.click();
    c.day("2026-10-02").click(); assert.equal(c.store.getFilter().createdFrom, "2026-09-30");
    assert.equal(c.store.getFilter().createdTo, "2026-10-02");
  });
  it("opens with focus and closes by Escape with focus restored", async () => {
    const c = await calendar();
    assert.equal(c.popover.hidden, true);
    c.trigger.click(); assert.equal(c.trigger.getAttribute("aria-expanded"), "true");
    assert.equal(c.doc.activeElement, c.day("2026-09-30"));
    assert.equal(c.key(c.day("2026-09-30"), "Escape").defaultPrevented, true);
    assert.equal(c.popover.hidden, true); assert.equal(c.doc.activeElement, c.trigger);
  });
  it("applies only the second click, marks endpoints, interior and today", async () => {
    const c = await calendar(); c.trigger.click();
    c.day("2026-09-10").click();
    assert.equal(c.store.getFilter().createdFrom, "");
    assert.equal(c.day("2026-09-10").classList.contains("is-start"), true);
    c.day("2026-09-20").click();
    assert.equal(c.store.getFilter().createdFrom, "2026-09-10");
    assert.equal(c.store.getFilter().createdTo, "2026-09-20");
    c.trigger.click();
    assert.equal(c.day("2026-09-10").classList.contains("is-start"), true);
    assert.equal(c.day("2026-09-20").classList.contains("is-end"), true);
    assert.equal(c.day("2026-09-15").classList.contains("is-between"), true);
    assert.equal(c.day("2026-09-30").getAttribute("aria-current"), "date");
  });
  it("normalizes reverse selection across months and navigates both directions", async () => {
    const c = await calendar(); c.trigger.click();
    c.button("tn-date-next").click(); c.day("2026-10-15").click();
    c.button("tn-date-prev").click(); c.day("2026-09-30").click();
    assert.equal(c.store.getFilter().createdFrom, "2026-09-30");
    assert.equal(c.store.getFilter().createdTo, "2026-10-15");
    assert.match(c.trigger.textContent!, /2026/);
  });
  it("starts a new range without reset and cancels drafts without changing applied dates", async () => {
    const c = await calendar(); c.store.setCreatedDateRange("2026-09-01", "2026-09-03"); c.trigger.click();
    c.day("2026-09-10").click();
    assert.equal(c.store.getFilter().createdFrom, "2026-09-01");
    c.button("tn-date-close").click();
    assert.equal(c.store.getFilter().createdTo, "2026-09-03");
    c.trigger.click(); c.day("2026-09-10").click(); c.day("2026-09-12").click();
    assert.equal(c.store.getFilter().createdTo, "2026-09-12");
  });
  it("resets selection without clearing other filters and clears it on fast capture", async () => {
    const c = await calendar();
    c.store.setSearch("word"); c.store.setColorFilter("blue"); c.store.setFormatFilter("markdown");
    c.store.setCreatedDateRange("2026-09-01", "2026-09-03");
    c.trigger.click(); c.day("2026-09-10").click(); c.button("tn-date-reset").click();
    assert.equal(c.store.getFilter().createdFrom, ""); assert.equal(c.store.getFilter().search, "word");
    assert.equal(c.store.getFilter().color, "blue"); assert.equal(c.store.getFilter().format, "markdown");
    c.trigger.click(); assert.equal(c.root.querySelectorAll(".is-start,.is-end,.is-between").length, 0);
    c.store.setCreatedDateRange("2000-01-01", "2000-01-01");
    const created = await c.store.createNote();
    assert.equal(c.store.getFilter().createdFrom, "");
    assert.ok(c.store.getVisible().some(({ note }) => note.id === created.id));
  });
  it("same-day range is inclusive and ANDs with search/color/format", async () => {
    const c = await calendar();
    await c.store.createNote(note({ id: "match", content: "word", color: "blue", format: "markdown", createdAt: new Date(2026, 8, 30, 23, 59, 59).getTime() }));
    await c.store.createNote(note({ id: "after", content: "word", color: "blue", format: "markdown", createdAt: new Date(2026, 9, 1).getTime() }));
    c.store.setSearch("word"); c.store.setColorFilter("blue"); c.store.setFormatFilter("markdown");
    c.trigger.click(); c.day("2026-09-30").click(); c.day("2026-09-30").click();
    assert.deepEqual(c.store.getVisible().map(({ note }) => note.id), ["match"]);
  });
  it("supports arrow/Page keyboard navigation, leaves external keys untouched", async () => {
    const c = await calendar(); c.trigger.click();
    c.key(c.day("2026-09-30"), "ArrowRight");
    assert.equal((c.doc.activeElement as HTMLElement).dataset.date, "2026-10-01");
    c.key(c.day("2026-10-01"), "PageUp");
    assert.equal((c.doc.activeElement as HTMLElement).dataset.date, "2026-09-01");
    assert.equal(c.key(c.doc.getElementById("tn-textarea")!, "ArrowRight").defaultPrevented, false);
    assert.equal(c.key(c.day("2026-09-01"), "b").defaultPrevented, false);
  });
  it("closes on outside pointer and focus leaving without stealing new focus", async () => {
    const c = await calendar(); c.trigger.click();
    const outside = c.doc.getElementById("tn-search")!; outside.focus();
    outside.dispatchEvent(new c.window.Event("pointerdown", { bubbles: true }));
    assert.equal(c.popover.hidden, true); assert.equal(c.doc.activeElement, outside);
    c.trigger.click();
    const event = new c.window.Event("focusout", { bubbles: true }); Object.assign(event, { relatedTarget: outside });
    c.day("2026-09-30").dispatchEvent(event); assert.equal(c.popover.hidden, true);
  });
  it("localizes RU/EN month/day labels and defines theme-aware selected/focus states", async () => {
    const en = await calendar("en-US"); en.trigger.click();
    assert.match(en.doc.getElementById("tn-date-month")!.textContent!, /September/);
    const ru = await calendar("ru-RU"); ru.trigger.click();
    assert.match(ru.doc.getElementById("tn-date-month")!.textContent!, /сентябрь/);
    assert.match(ru.day("2026-09-30").getAttribute("aria-label")!, /среда/);
    const css = readFileSync("src/ui/notes.css", "utf8");
    assert.match(css, /\.tn-date-day\.is-start,[\s\S]*?var\(--button-primary-fg\)/);
    assert.match(css, /\.tn-date-day\.is-between[\s\S]*?var\(--tn-selected-text\)/);
    assert.match(css, /\.tn-date-day:focus-visible/);
    assert.equal(calendarDays(new Date(2026, 8, 1), 1)[0]!.getDay(), 1);
  });
});
