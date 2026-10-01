/**
 * Pure search / filter / sort pipeline.
 *
 * Everything here is synchronous and side-effect free so it can be unit-tested
 * without Thunderbird, and so the UI can recompute the visible list cheaply.
 *
 * Performance notes for the 1k–10k note target:
 *  - a single O(n) pass over the notes list applies search + colour + format;
 *  - the exact (case-insensitive) substring test runs only after the cheap
 *    colour/format checks have already rejected a record;
 *  - callers keep the derived `searchText` cached (see `indexedNotes`) so the
 *    lowercase copy of each note is not recomputed on every keystroke.
 */

import type { Note, NoteColor, NoteFormat } from "./model";

export type ColorFilter = NoteColor | "all" | "none";

export type SortField = "createdAt" | "updatedAt";
export type SortDirection = "asc" | "desc";

export type SortKey =
  | "created-desc"
  | "created-asc"
  | "updated-desc"
  | "updated-asc";

export interface SortSpec {
  field: SortField;
  direction: SortDirection;
}

/** The four sort orders the MVP exposes. */
export const SORT_KEYS: readonly SortKey[] = [
  "created-desc",
  "created-asc",
  "updated-desc",
  "updated-asc",
] as const;

export const DEFAULT_SORT_KEY: SortKey = "created-desc";

const SORT_BY_KEY: Record<SortKey, SortSpec> = {
  "created-desc": { field: "createdAt", direction: "desc" },
  "created-asc": { field: "createdAt", direction: "asc" },
  "updated-desc": { field: "updatedAt", direction: "desc" },
  "updated-asc": { field: "updatedAt", direction: "asc" },
};

export function sortSpecFor(key: SortKey): SortSpec {
  return SORT_BY_KEY[key];
}

export function isSortKey(value: unknown): value is SortKey {
  return typeof value === "string" && (SORT_KEYS as readonly string[]).includes(value);
}

export function isColorFilter(value: unknown): value is ColorFilter {
  return (
    value === "all" ||
    value === "none" ||
    (typeof value === "string" &&
      ["red", "orange", "yellow", "green", "blue", "purple"].includes(value))
  );
}

export interface NotesFilter {
  /** Raw user input. Matching is case-insensitive substring on the whole content. */
  search: string;
  color: ColorFilter;
  format: NoteFormat | "all";
  sort: SortKey;
  createdFrom?: string;
  createdTo?: string;
}

export const DEFAULT_FILTER: NotesFilter = {
  search: "",
  color: "all",
  format: "all",
  sort: DEFAULT_SORT_KEY,
  createdFrom: "",
  createdTo: "",
};

/** Parse calendar input at local midnight, without UTC parsing or 24h arithmetic. */
export function localDateStart(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (year < 1 || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function createdDateRange(from = "", to = ""): { valid: boolean; start: number; end: number } {
  const first = from ? localDateStart(from) : null;
  const last = to ? localDateStart(to) : null;
  if ((from && !first) || (to && !last) || (first && last && first > last)) {
    return { valid: false, start: -Infinity, end: Infinity };
  }
  if (last) last.setDate(last.getDate() + 1);
  return { valid: true, start: first?.getTime() ?? -Infinity, end: last?.getTime() ?? Infinity };
}

/**
 * A note plus its precomputed lowercase content, so repeated filtering during
 * typing does not re-lowercase every note.
 */
export interface IndexedNote {
  note: Note;
  /** `note.content.toLowerCase()`, computed once per content change. */
  searchText: string;
}

export function indexedNotes(notes: readonly Note[]): IndexedNote[] {
  return notes.map((note) => ({ note, searchText: note.content.toLowerCase() }));
}

export function indexNote(note: Note): IndexedNote {
  return { note, searchText: note.content.toLowerCase() };
}

function matchesColor(note: Note, filter: ColorFilter): boolean {
  if (filter === "all") return true;
  if (filter === "none") return note.color === null;
  return note.color === filter;
}

/** Case-insensitive substring match against the whole note content. */
export function matchesSearch(searchText: string, query: string): boolean {
  if (query.length === 0) return true;
  return searchText.includes(query);
}

/**
 * Filter a pre-indexed list. `search` is normalised (trimmed + lowercased) here,
 * so callers pass raw input.
 */
export function filterNotes(
  notes: readonly IndexedNote[],
  filter: Pick<NotesFilter, "search" | "color" | "format" | "createdFrom" | "createdTo">
): IndexedNote[] {
  const query = filter.search.trim().toLowerCase();
  const hasQuery = query.length > 0;
  const colorFilter = filter.color;
  const formatFilter = filter.format;
  const filterByFormat = formatFilter !== "all";
  const filterByColor = colorFilter !== "all";
  const range = createdDateRange(filter.createdFrom, filter.createdTo);
  const filterByDate = range.valid && (Number.isFinite(range.start) || Number.isFinite(range.end));

  if (!hasQuery && !filterByColor && !filterByFormat && !filterByDate) return [...notes];

  const result: IndexedNote[] = [];
  for (const entry of notes) {
    if (filterByDate && (entry.note.createdAt < range.start || entry.note.createdAt >= range.end)) continue;
    if (filterByColor && !matchesColor(entry.note, colorFilter)) continue;
    if (filterByFormat && entry.note.format !== formatFilter) continue;
    if (hasQuery && !matchesSearch(entry.searchText, query)) continue;
    result.push(entry);
  }
  return result;
}

/**
 * Sort a pre-indexed list. Newest-first is the default.
 *
 * Ties are broken by `id` so the order is deterministic and stable across
 * renders (important: without it, equal timestamps make the list jump around).
 */
export function sortNotes(notes: readonly IndexedNote[], sort: SortKey): IndexedNote[] {
  const { field, direction } = sortSpecFor(sort);
  const factor = direction === "asc" ? 1 : -1;

  return [...notes].sort((a, b) => {
    const left = a.note[field];
    const right = b.note[field];
    if (left !== right) return (left - right) * factor;
    // Deterministic tie-break.
    if (a.note.id === b.note.id) return 0;
    return a.note.id < b.note.id ? -1 : 1;
  });
}

/** Filter + sort in one call. */
export function selectNotes(notes: readonly IndexedNote[], filter: NotesFilter): IndexedNote[] {
  return sortNotes(filterNotes(notes, filter), filter.sort);
}

/** Convenience for tests and simple callers. */
export function selectNotesFromNotes(notes: readonly Note[], filter: NotesFilter): Note[] {
  return selectNotes(indexedNotes(notes), filter).map((entry) => entry.note);
}
