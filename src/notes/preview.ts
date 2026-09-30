/**
 * Note preview generation.
 *
 * A note has no `title` field: the list derives its label from `content`.
 * Markdown syntax is stripped only for display purposes — the stored content is
 * never modified.
 */

import type { Note } from "./model";

const WHITESPACE = /\s/;

/** Fenced code fences: ``` or ~~~. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** ATX heading prefix: "# ", "## ", ... */
const ATX_HEADING = /^\s{0,3}#{1,6}\s+/;
/** Blockquote prefix: "> ". */
const BLOCK_QUOTE = /^\s{0,3}>\s?/;
/** Unordered/ordered list marker. */
const LIST_MARKER = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/;
/** Horizontal rule (a whole line of - * or _). */
const THEMATIC_BREAK = /^\s{0,3}(?:[-*_]\s*){3,}$/;
/** Markdown link / image: keep the label, drop the target. */
const LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
/** Reference-style link: [label][ref] */
const REFERENCE_LINK = /!?\[([^\]]*)\]\[[^\]]*\]/g;
/** Inline emphasis and code markers. */
const INLINE_MARKERS = /(\*\*|__|\*|_|`{1,3}|~~)/g;
/** Table alignment row: |---|:--:| */
const TABLE_DELIMITER = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;
/** HTML-ish tag, stripped from previews. */
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;

/**
 * Turn one line of raw note content into readable plain text.
 * `stripMarkdown` only removes the *obvious* structural syntax; this stays
 * deliberately simple (no parser) so previews are cheap for thousands of notes.
 */
export function lineToPlainText(line: string, stripMarkdown: boolean): string {
  let text = line;

  if (!stripMarkdown) {
    return text.trim();
  }

  // Fenced code block delimiter lines carry no information for a preview.
  if (FENCE.test(text)) return "";
  if (THEMATIC_BREAK.test(text)) return "";

  text = text.replace(ATX_HEADING, "");
  text = text.replace(BLOCK_QUOTE, "");
  text = text.replace(LIST_MARKER, "");
  if (TABLE_DELIMITER.test(text)) return "";

  text = text.replace(LINK, "$1");
  text = text.replace(REFERENCE_LINK, "$1");
  text = text.replace(HTML_TAG, "");
  text = text.replace(INLINE_MARKERS, "");

  return text.trim();
}

export interface NotePreview {
  /** First non-empty line, markdown-stripped. `""` when the note has no text. */
  title: string;
  /** Short following fragment, `""` when there is nothing else to show. */
  excerpt: string;
}

export interface PreviewOptions {
  /** Max characters of `title`. Default 120. */
  maxTitleLength?: number;
  /** Max characters of `excerpt`. Default 160. */
  maxExcerptLength?: number;
}

function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}\u2026`;
}

function splitLines(content: string): string[] {
  return content.split(/\r\n|\r|\n/);
}

/**
 * Derive `{ title, excerpt }` for a note.
 *
 * - first non-empty line becomes the title;
 * - remaining lines are concatenated into a shortened excerpt;
 * - an all-whitespace note yields empty strings (the UI substitutes its own
 *   localised "New note" placeholder).
 */
export function buildNotePreview(note: Note, options: PreviewOptions = {}): NotePreview {
  const maxTitleLength = options.maxTitleLength ?? 120;
  const maxExcerptLength = options.maxExcerptLength ?? 160;
  const stripMarkdown = note.format === "markdown";

  const lines = splitLines(note.content);
  let title = "";
  let excerpt = "";

  for (const line of lines) {
    const plain = lineToPlainText(line, stripMarkdown);
    if (plain.length === 0) continue;
    title = plain;
    break;
  }

  if (title.length > 0 && maxExcerptLength > 0) {
    const parts: string[] = [];
    let seenTitle = false;
    for (const line of lines) {
      const plain = lineToPlainText(line, stripMarkdown);
      if (plain.length === 0) continue;
      if (!seenTitle) {
        seenTitle = true;
        continue;
      }
      parts.push(plain);
      if (parts.join(" ").length >= maxExcerptLength) break;
    }
    const joined = parts.join(" ").replace(/\s+/g, " ").trim();
    excerpt = truncate(joined, maxExcerptLength);
  }

  return {
    title: truncate(title, maxTitleLength),
    excerpt,
  };
}

/** Convenience used by the UI: raw first-line access without markdown stripping. */
export function firstNonEmptyLine(content: string): string {
  for (const line of splitLines(content)) {
    if (line.trim().length > 0) return line.trim();
  }
  return "";
}

/** True when the content is only whitespace. */
export function isBlank(content: string): boolean {
  for (const char of content) {
    if (!WHITESPACE.test(char)) return false;
  }
  return true;
}
