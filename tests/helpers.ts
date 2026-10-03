/**
 * Shared test helpers.
 *
 * Deliberately tiny: it builds notes with deterministic ids/timestamps so
 * sorting and filtering assertions are exact and reproducible.
 */

import { createNote } from "../src/notes/model.ts";
import type { Note, NoteColor, NoteFormat, NoteReminder } from "../src/notes/model.ts";

export interface NoteOverrides {
  id: string;
  content?: string;
  color?: NoteColor | null;
  format?: NoteFormat;
  createdAt?: number;
  updatedAt?: number;
  revision?: number;
  favorite?: boolean;
  pinned?: boolean;
  reminder?: NoteReminder | null;
}

/** Build a deterministic note. */
export function note(overrides: NoteOverrides): Note {
  const createdAt = overrides.createdAt ?? 1_000;
  const updatedAt = overrides.updatedAt ?? createdAt;
  return {
    ...createNote(),
    id: overrides.id,
    content: overrides.content ?? "",
    color: overrides.color ?? null,
    format: overrides.format ?? "plain",
    createdAt,
    updatedAt,
    revision: overrides.revision ?? 1,
    favorite: overrides.favorite ?? false,
    pinned: overrides.pinned ?? false,
    reminder: overrides.reminder ?? null,
  };
}

/** Shorthand for asserting an ordered list of ids. */
export function ids(notes: readonly Note[]): string[] {
  return notes.map((item) => item.id);
}
