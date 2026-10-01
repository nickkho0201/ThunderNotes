import { localDateStart } from "../notes/query";
import { t, uiLocale } from "../i18n";
import type { NoteStore } from "./store";

export function calendarDate(date: Date): string {
  return String(date.getFullYear()).padStart(4, "0") + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

export function calendarDays(month: Date, weekStart: number): Date[] {
  const first = new Date(month); first.setDate(1);
  first.setDate(1 - (first.getDay() - weekStart + 7) % 7);
  return Array.from({ length: 42 }, (_, index) => { const date = new Date(first); date.setDate(first.getDate() + index); return date; });
}

export function bindCreatedDateFilter(options: {
  root: HTMLElement; trigger: HTMLButtonElement; popover: HTMLElement;
  store: NoteStore; now?: () => Date; locale?: string;
}): void {
  const { root, trigger, popover, store } = options;
  const doc = root.ownerDocument;
  const locale = options.locale ?? uiLocale();
  const weekStart = locale.toLowerCase().startsWith("ru") ? 1 : 0;
  const now = options.now ?? (() => new Date());
  const require = <T extends HTMLElement>(id: string): T => {
    const element = root.querySelector<T>("#" + id);
    if (!element) throw new Error("Missing calendar element " + id);
    return element;
  };
  const monthLabel = require<HTMLButtonElement>("tn-date-month");
  const chooser = require<HTMLElement>("tn-date-month-year");
  const months = require<HTMLElement>("tn-date-months");
  const yearInput = require<HTMLInputElement>("tn-date-year");
  const yearPrevious = require<HTMLButtonElement>("tn-date-year-prev");
  const yearNext = require<HTMLButtonElement>("tn-date-year-next");
  const back = require<HTMLButtonElement>("tn-date-back");
  let choosingMonth = false;
  let chosenYear = now().getFullYear();
  const weekdays = require<HTMLElement>("tn-date-weekdays");
  const days = require<HTMLElement>("tn-date-days");
  const status = require<HTMLElement>("tn-date-status");
  const reset = require<HTMLButtonElement>("tn-date-reset");
  const closeButton = require<HTMLButtonElement>("tn-date-close");
  const previous = require<HTMLButtonElement>("tn-date-prev");
  const next = require<HTMLButtonElement>("tn-date-next");
  let month = new Date(now().getFullYear(), now().getMonth(), 1);
  let anchor: string | null = null;
  let focused = calendarDate(now());
  const format = new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" });
  const fullDate = new Intl.DateTimeFormat(locale, { dateStyle: "full" });
  const monthFormat = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" });
  const shortMonth = new Intl.DateTimeFormat(locale, { month: "short" });
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: "short" });
  for (let index = 0; index < 7; index++) {
    const span = doc.createElement("span");
    span.textContent = weekdayFormat.format(new Date(2026, 0, 4 + weekStart + index));
    weekdays.append(span);
  }
  const position = (): void => {
    const bounds = trigger.getBoundingClientRect?.();
    if (!bounds) return;
    const width = Math.min(288, (doc.defaultView?.innerWidth ?? 800) - 16);
    popover.style.left = Math.max(8, Math.min(bounds.left, (doc.defaultView?.innerWidth ?? 800) - width - 8)) + "px";
    popover.style.top = Math.max(8, Math.min(bounds.bottom + 6, (doc.defaultView?.innerHeight ?? 600) - (popover.offsetHeight || 360) - 8)) + "px";
  };
  const close = (restoreFocus = true): void => {
    popover.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    anchor = null;
    choosingMonth = false;
    if (restoreFocus) trigger.focus();
  };
  const focusDay = (): void => {
    days.querySelector<HTMLButtonElement>('[data-date="' + focused + '"]')?.focus();
  };
  const render = (): void => {
    const filter = store.getFilter();
    const from = anchor ?? filter.createdFrom ?? "";
    const to = anchor ?? filter.createdTo ?? "";
    trigger.textContent = filter.createdFrom && filter.createdTo
      ? format.format(localDateStart(filter.createdFrom)!) + " — " + format.format(localDateStart(filter.createdTo)!)
      : t("createdDateLabel");
    trigger.classList.toggle("is-active", Boolean(filter.createdFrom || filter.createdTo));
    trigger.setAttribute("aria-label", t("createdDateLabel") + (filter.createdFrom ? ": " + trigger.textContent : ""));
    monthLabel.textContent = monthFormat.format(month);
    monthLabel.setAttribute("aria-expanded", String(choosingMonth));
    chooser.hidden = !choosingMonth;
    weekdays.hidden = choosingMonth;
    days.hidden = choosingMonth;
    previous.disabled = choosingMonth;
    next.disabled = choosingMonth;
    status.textContent = t(anchor ? "createdDateChooseEnd" : "createdDateChooseStart");
    if (choosingMonth) status.textContent = t("createdDateChooseMonthYear");
    days.setAttribute("aria-label", status.textContent);
    reset.disabled = !anchor && !filter.createdFrom && !filter.createdTo;
    yearInput.value = String(chosenYear);
    yearInput.setAttribute("aria-invalid", "false");
    yearPrevious.disabled = chosenYear <= 1;
    yearNext.disabled = chosenYear >= 9999;
    months.replaceChildren();
    for (let index = 0; index < 12; index++) {
      const button = doc.createElement("button");
      button.type = "button"; button.className = "tn-btn"; button.dataset.month = String(index);
      button.textContent = shortMonth.format(new Date(2026, index, 1));
      button.setAttribute("aria-label", new Intl.DateTimeFormat(locale, { month: "long" }).format(new Date(2026, index, 1)));
      const selected = month.getMonth() === index && month.getFullYear() === chosenYear;
      button.classList.toggle("is-active", selected); button.setAttribute("aria-pressed", String(selected));
      button.addEventListener("click", () => {
        if (!readYear()) return;
        month = localDateStart(String(chosenYear).padStart(4, "0") + "-" + String(index + 1).padStart(2, "0") + "-01")!;
        focused = calendarDate(month); choosingMonth = false; render(); focusDay(); position();
      });
      months.append(button);
    }
    days.replaceChildren();
    for (const date of calendarDays(month, weekStart)) {
      const key = calendarDate(date);
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "tn-date-day";
      button.dataset.date = key;
      button.textContent = String(date.getDate());
      button.tabIndex = key === focused ? 0 : -1;
      button.setAttribute("aria-label", fullDate.format(date));
      button.disabled = date.getFullYear() < 1 || date.getFullYear() > 9999;
      const selected = Boolean(from && to && key >= from && key <= to);
      button.setAttribute("aria-pressed", String(selected));
      button.classList.toggle("is-start", key === from);
      button.classList.toggle("is-end", key === to);
      button.classList.toggle("is-between", selected && key !== from && key !== to);
      button.classList.toggle("is-other-month", date.getMonth() !== month.getMonth());
      if (key === calendarDate(now())) button.setAttribute("aria-current", "date");
      button.addEventListener("click", () => {
        focused = key;
        if (anchor === null) { anchor = key; render(); focusDay(); }
        else {
          const first = anchor < key ? anchor : key;
          const last = anchor < key ? key : anchor;
          anchor = null;
          store.setCreatedDateRange(first, last);
          render(); close();
        }
      });
      days.append(button);
    }
  };
  const moveMonth = (delta: number): void => {
    const candidate = new Date(month); candidate.setMonth(candidate.getMonth() + delta, 1);
    if (candidate.getFullYear() < 1 || candidate.getFullYear() > 9999) return;
    month = candidate;
    focused = calendarDate(month);
    render();
  };
  trigger.addEventListener("click", () => {
    if (!popover.hidden) { close(); return; }
    anchor = null;
    choosingMonth = false;
    focused = store.getFilter().createdFrom || calendarDate(now());
    const date = localDateStart(focused)!;
    month = new Date(date); month.setDate(1);
    popover.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    render(); position(); focusDay();
  });
  previous.addEventListener("click", () => moveMonth(-1));
  next.addEventListener("click", () => moveMonth(1));
  const readYear = (): boolean => {
    const value = Number(yearInput.value);
    const valid = /^\d{1,4}$/.test(yearInput.value) && Number.isInteger(value) && value >= 1 && value <= 9999;
    yearInput.setAttribute("aria-invalid", String(!valid));
    status.textContent = t(valid ? "createdDateChooseMonthYear" : "createdDateInvalidYear");
    if (valid) chosenYear = value;
    return valid;
  };
  const returnToDays = (): void => { choosingMonth = false; render(); monthLabel.focus(); position(); };
  const updateYearControls = (): void => {
    yearPrevious.disabled = chosenYear <= 1; yearNext.disabled = chosenYear >= 9999;
    for (const button of months.querySelectorAll<HTMLButtonElement>("[data-month]")) {
      const selected = month.getFullYear() === chosenYear && month.getMonth() === Number(button.dataset.month);
      button.classList.toggle("is-active", selected); button.setAttribute("aria-pressed", String(selected));
    }
  };
  monthLabel.addEventListener("click", () => {
    if (choosingMonth) { returnToDays(); return; }
    chosenYear = month.getFullYear(); choosingMonth = true; render(); yearInput.focus(); yearInput.select?.(); position();
  });
  // A change fires on blur before the clicked month's click. Keep its DOM node
  // intact so direct year entry followed by clicking a month works in Firefox.
  yearInput.addEventListener("change", () => { if (readYear()) updateYearControls(); });
  yearPrevious.addEventListener("click", () => { if (readYear() && chosenYear > 1) { chosenYear--; render(); (yearPrevious.disabled ? yearInput : yearPrevious).focus(); } });
  yearNext.addEventListener("click", () => { if (readYear() && chosenYear < 9999) { chosenYear++; render(); (yearNext.disabled ? yearInput : yearNext).focus(); } });
  back.addEventListener("click", returnToDays);
  closeButton.addEventListener("click", () => close());
  reset.addEventListener("click", () => {
    anchor = null;
    store.setCreatedDateRange("", "");
    render(); close();
  });
  root.addEventListener("keydown", (event) => {
    if (popover.hidden || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (choosingMonth) returnToDays(); else close(); return; }
    const target = event.target as HTMLElement;
    if (choosingMonth) {
      if (target === yearInput && event.key === "Enter") {
        event.preventDefault();
        if (readYear()) { updateYearControls(); months.querySelector<HTMLButtonElement>('[data-month="' + month.getMonth() + '"]')?.focus(); }
        return;
      }
      if (target.dataset.month === undefined) return;
      const shifts: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 };
      let index = Number(target.dataset.month);
      if (event.key in shifts) index = (index + shifts[event.key]! + 12) % 12;
      else if (event.key === "Home") index = 0;
      else if (event.key === "End") index = 11;
      else return;
      event.preventDefault(); months.querySelector<HTMLButtonElement>('[data-month="' + index + '"]')?.focus(); return;
    }
    if (!target.dataset.date) return;
    const date = localDateStart(target.dataset.date)!;
    const shifts: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in shifts) date.setDate(date.getDate() + shifts[event.key]!);
    else if (event.key === "Home") date.setDate(date.getDate() - (date.getDay() - weekStart + 7) % 7);
    else if (event.key === "End") date.setDate(date.getDate() + 6 - (date.getDay() - weekStart + 7) % 7);
    else if (event.key === "PageUp" || event.key === "PageDown") date.setMonth(date.getMonth() + (event.key === "PageUp" ? -1 : 1), 1);
    else return;
    event.preventDefault();
    focused = calendarDate(date);
    if (date.getFullYear() < 1 || date.getFullYear() > 9999) return;
    month = new Date(date); month.setDate(1);
    render(); focusDay();
  });
  doc.addEventListener("pointerdown", (event) => {
    if (!popover.hidden && !root.contains(event.target as Node)) close(false);
  });
  root.addEventListener("focusout", (event) => {
    if (event.relatedTarget && !root.contains(event.relatedTarget as Node)) close(false);
  });
  doc.defaultView?.addEventListener("resize", () => { if (!popover.hidden) position(); });
  store.subscribe((event) => {
    if (event.type === "filter") { anchor = null; render(); }
  });
  render();
}
