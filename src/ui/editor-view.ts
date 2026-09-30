/**
 * Note editor view.
 *
 * Owns the right-hand pane: format switch (Plain Text / Markdown), the Markdown
 * Edit|Preview toggle, the per-note colour picker, delete, and the text area.
 *
 * Autosave itself lives in `NoteStore`; this component only reports changes.
 * Every DOM write is guarded by a cache so re-rendering while the user types does
 * not reset the caret or the selection.
 */

import type { Note, NoteColor, NoteFormat } from "../notes/model";
import { NOTE_COLORS } from "../notes/model";
import { parseMarkdown } from "../markdown/markdown";
import { t } from "../i18n";

export type MarkdownPane = "edit" | "preview";

export interface EditorViewOptions {
  root: HTMLElement;
  textarea: HTMLTextAreaElement;
  preview: HTMLElement;
  formatGroup: HTMLElement;
  markdownModeGroup: HTMLElement;
  noteColorGroup: HTMLElement;
  deleteButton: HTMLButtonElement;
  onContentChange: (content: string) => void;
  onFormatChange: (format: NoteFormat) => void;
  onColorChange: (color: NoteColor | null) => void;
  onDelete: () => void;
}

interface RenderCache {
  id: string | null;
  content: string;
  format: NoteFormat | null;
  color: NoteColor | null;
  markdownPane: MarkdownPane;
}

export class EditorView {
  private readonly options: EditorViewOptions;
  private readonly cache: RenderCache = {
    id: null,
    content: "",
    format: null,
    color: null,
    markdownPane: "edit",
  };

  /** Kept per note, so switching back and forth preserves the chosen pane. */
  private readonly markdownPaneByNote = new Map<string, MarkdownPane>();

  constructor(options: EditorViewOptions) {
    this.options = options;

    options.textarea.addEventListener("input", () => {
      this.cache.content = options.textarea.value;
      options.onContentChange(options.textarea.value);
    });

    options.formatGroup.addEventListener("click", (event) => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-format]");
      const format = button?.dataset.format;
      if (format === "plain" || format === "markdown") options.onFormatChange(format);
    });

    options.markdownModeGroup.addEventListener("click", (event) => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-mode]");
      const mode = button?.dataset.mode;
      if (mode !== "edit" && mode !== "preview") return;
      if (this.cache.id !== null) this.markdownPaneByNote.set(this.cache.id, mode);
      this.setMarkdownPane(mode);
    });

    options.noteColorGroup.addEventListener("click", (event) => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-color]");
      const value = button?.dataset.color;
      if (value === undefined) return;
      options.onColorChange(value === "none" ? null : (value as NoteColor));
    });

    options.deleteButton.addEventListener("click", () => options.onDelete());
  }

  /** Render the given note, or clear the editor when `note` is null. */
  render(note: Note | null): void {
    const root = this.options.root;

    if (note === null) {
      root.hidden = true;
      this.cache.id = null;
      this.cache.format = null;
      this.cache.color = null;
      this.cache.content = "";
      this.currentNote = null;
      return;
    }

    root.hidden = false;

    const noteChanged = this.cache.id !== note.id;

    if (noteChanged) {
      this.cache.id = note.id;
      this.cache.content = note.content;
      this.options.textarea.value = note.content;
      this.options.preview.replaceChildren();
      this.options.textarea.scrollTop = 0;
      this.options.preview.scrollTop = 0;
      this.cache.markdownPane = this.markdownPaneByNote.get(note.id) ?? "edit";
    } else if (this.cache.content !== note.content) {
      // External change (undo, future import): only touch the DOM when the value
      // really differs, so typing never loses the caret.
      this.cache.content = note.content;
      this.options.textarea.value = note.content;
    }

    if (this.cache.format !== note.format) {
      this.cache.format = note.format;
      this.syncSegmented(this.options.formatGroup, "format", note.format);
      this.options.markdownModeGroup.hidden = note.format !== "markdown";
      // Leaving Markdown always returns the note to plain editing.
      if (note.format !== "markdown" && this.cache.markdownPane !== "edit") {
        this.cache.markdownPane = "edit";
      }
    }

    if (this.cache.color !== note.color) {
      this.cache.color = note.color;
      this.syncSegmented(this.options.noteColorGroup, "color", note.color ?? "none");
    }

    // `applyMarkdownPane` syncs the Edit/Preview buttons, so the control always
    // reflects the pane that is actually on screen — including when the pane was
    // restored from `markdownPaneByNote` for a note being opened for the first
    // time.
    this.applyMarkdownPane(note);
  }

  private syncSegmented(group: HTMLElement, attribute: string, value: string): void {
    for (const button of group.querySelectorAll<HTMLButtonElement>(`[data-${attribute}]`)) {
      const isActive = button.dataset[attribute] === value;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    }
  }

  private setMarkdownPane(pane: MarkdownPane): void {
    if (this.cache.markdownPane === pane) return;
    this.cache.markdownPane = pane;
    if (this.currentNote) this.applyMarkdownPane(this.currentNote);
    else this.syncSegmented(this.options.markdownModeGroup, "mode", pane);
  }

  /** The note currently shown, or null when the editor is empty. */
  private currentNote: Note | null = null;

  private applyMarkdownPane(note: Note): void {
    this.currentNote = note;

    const isMarkdown = note.format === "markdown";
    const showingPreview = isMarkdown && this.cache.markdownPane === "preview";

    this.options.textarea.hidden = showingPreview;
    this.options.preview.hidden = !showingPreview;
    // Keep the Edit/Preview control in step with what is actually displayed.
    this.syncSegmented(this.options.markdownModeGroup, "mode", this.cache.markdownPane);

    if (showingPreview) {
      const { html } = parseMarkdown(note.content);
      // `parseMarkdown` guarantees sanitized output (raw HTML is escaped and the
      // result passes a strict allowlist), so innerHTML is safe here.
      this.options.preview.innerHTML = html;
      for (const link of this.options.preview.querySelectorAll("a")) {
        link.setAttribute("target", "_blank");
      }
    } else if (isMarkdown) {
      this.options.preview.replaceChildren();
    }
  }

  /** Replace the editor contents without notifying the store (used on teardown). */
  reset(): void {
    this.render(null);
    this.markdownPaneByNote.clear();
  }

  focus(): void {
    const textarea = this.options.textarea;
    if (this.currentNote === null) return; // nothing is selected; focus would go nowhere
    if (textarea.hidden) {
      // Markdown preview is showing: go back to editing so the user can type.
      this.setMarkdownPane("edit");
    }
    textarea.focus();
    // Place the caret at the end, which is what "opened and started typing" means.
    const end = textarea.value.length;
    try {
      textarea.setSelectionRange(end, end);
    } catch {
      // Some input types do not support selection ranges; harmless.
    }
  }

  /** True when the editor currently holds the focused element. */
  hasFocus(): boolean {
    return document.activeElement === this.options.textarea;
  }
}

/** Colour picker values in palette order, with `null` first. */
export const COLOR_PICKER_ORDER: readonly (NoteColor | null)[] = [null, ...NOTE_COLORS];

/** Localized label for a palette value. */
export function colorLabel(color: NoteColor | null): string {
  switch (color) {
    case "red":
      return t("colorRed");
    case "orange":
      return t("colorOrange");
    case "yellow":
      return t("colorYellow");
    case "green":
      return t("colorGreen");
    case "blue":
      return t("colorBlue");
    case "purple":
      return t("colorPurple");
    default:
      return t("colorNone");
  }
}
