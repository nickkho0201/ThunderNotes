/**
 * In-memory `NotesRepository`.
 *
 * Used as a fallback when IndexedDB cannot be opened, and by the unit tests so
 * the store can be exercised in Node without a DOM.
 */

import { CURRENT_SCHEMA_VERSION } from "../notes/model";
import type { Note } from "../notes/model";
import type { NotesRepository, NotesRepositoryInfo } from "./repository";

export class MemoryNotesRepository implements NotesRepository {
  readonly info: NotesRepositoryInfo = {
    kind: "memory",
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };

  private notes = new Map<string, Note>();

  async getAll(): Promise<Note[]> {
    return [...this.notes.values()].map((note) => ({ ...note }));
  }

  async get(id: string): Promise<Note | null> {
    const note = this.notes.get(id);
    return note ? { ...note } : null;
  }

  async create(note: Note): Promise<void> {
    this.notes.set(note.id, { ...note });
  }

  async update(note: Note): Promise<void> {
    this.notes.set(note.id, { ...note });
  }

  async delete(id: string): Promise<void> {
    this.notes.delete(id);
  }

  async putMany(notes: Note[]): Promise<void> {
    for (const note of notes) this.notes.set(note.id, { ...note });
  }

  async replaceAll(notes: readonly Note[]): Promise<void> {
    const replacement = new Map<string, Note>();
    for (const note of notes) replacement.set(note.id, { ...note });
    this.notes = replacement;
  }

  async clear(): Promise<void> {
    this.notes.clear();
  }
}
