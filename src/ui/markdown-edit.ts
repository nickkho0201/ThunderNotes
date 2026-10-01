/** Pure source edits; no HTML, storage or global keyboard handlers. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

export const MARKDOWN_INDENT_SIZE = 4;

/** Line edits preserve selected text; a plain collapsed caret inserts spaces. */
export function indentMarkdown(value: string, start: number, end: number, outdent: boolean): TextEdit | null {
  const spaces = " ".repeat(MARKDOWN_INDENT_SIZE);
  const lineStart = start === 0 ? 0 : value.lastIndexOf("\n", start - 1) + 1;
  const multiline = value.slice(start, end).includes("\n");
  const firstEnd = value.indexOf("\n", lineStart);
  const firstLine = value.slice(lineStart, firstEnd < 0 ? value.length : firstEnd);
  const list = /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/.test(firstLine) && !insideFence(value.slice(0, lineStart));
  if (!outdent && start === end && !list) {
    return { start, end, text: spaces, selectionStart: start + spaces.length, selectionEnd: start + spaces.length };
  }
  // A selection ending exactly at the next line's start excludes that line.
  const lastPosition = multiline && value[end - 1] === "\n" ? end - 1 : end;
  const nextLF = value.indexOf("\n", lastPosition);
  const blockEnd = nextLF < 0 ? value.length : nextLF;
  const lines = value.slice(lineStart, blockEnd).split("\n");
  let offset = lineStart, delta = 0;
  let selectionStart = start, selectionEnd = end;
  const text = lines.map((line) => {
    // Legacy literal tabs may be removed one at a time, but never inserted.
    let removed = 0;
    if (outdent) {
      while (removed < MARKDOWN_INDENT_SIZE && line[removed] === " ") removed++;
      if (removed === 0 && line.startsWith("\t")) removed = 1;
    }
    const added = outdent ? 0 : spaces.length;
    const translate = (position: number): number => position < offset ? position :
      offset + delta + Math.max(0, position - offset - removed) + added;
    // Translate each original boundary only at the line containing it. An end
    // beyond this block (the excluded next line's start) receives all deltas.
    if (start >= offset && start <= offset + line.length) selectionStart = translate(start);
    if (end >= offset && end <= offset + line.length) selectionEnd = translate(end);
    delta += added - removed;
    offset += line.length + 1;
    return outdent ? line.slice(removed) : spaces + line;
  }).join("\n");
  if (end > blockEnd) selectionEnd = end + delta;
  if (delta === 0) return null;
  return { start: lineStart, end: blockEnd, text, selectionStart, selectionEnd };
}

export function wrapMarkdown(value: string, start: number, end: number, key: string): TextEdit | null {
  const syntax: Record<string, [string, string]> = { b: ["**", "**"], i: ["*", "*"], k: ["[", "](url)"], "`": ["`", "`"] };
  const pair = syntax[key];
  if (!pair) return null;
  const [open, close] = pair;
  if (key !== "k") {
    const marker = open[0]!;
    const exact = (left: number, right: number, body: string): boolean =>
      left >= 0 && right <= value.length && body.length > 0 &&
      !body.includes(open) && !body.startsWith(marker) && !body.endsWith(marker) &&
      value[left - 1] !== marker && value[right] !== marker &&
      value[left - 1] !== "\\" && !body.endsWith("\\") &&
      (key === "`" || body.trim() === body);
    const selected = value.slice(start, end);
    // Remove only an exact, isolated delimiter pair. Larger runs and compound
    // selections fall back to wrapping rather than deleting ambiguous markup.
    if (selected.startsWith(open) && selected.endsWith(close) && selected.length >= open.length + close.length) {
      const body = selected.slice(open.length, -close.length);
      if (exact(start, end, body)) return { start, end, text: body,
        selectionStart: start, selectionEnd: start + body.length };
    }
    const left = start - open.length, right = end + close.length;
    if (value.slice(left, start) === open && value.slice(end, right) === close && exact(left, right, selected)) {
      return { start: left, end: right, text: selected,
        selectionStart: left, selectionEnd: left + selected.length };
    }
  }
  return { start, end, text: open + value.slice(start, end) + close,
    selectionStart: start + open.length, selectionEnd: end + open.length };
}

function insideFence(value: string): boolean {
  let fence: { marker: string; length: number } | null = null;
  for (const line of value.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const run = match[1]!;
    if (!fence) fence = { marker: run[0]!, length: run.length };
    else if (run[0] === fence.marker && run.length >= fence.length && match[2]!.trim() === "") fence = null;
  }
  return fence !== null;
}

export function continueMarkdownList(value: string, start: number, end: number): TextEdit | null {
  if (start !== end) return null;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = value.indexOf("\n", start);
  const line = value.slice(lineStart, lineEnd === -1 ? value.length : lineEnd);
  if (insideFence(value.slice(0, lineStart))) return null;
  const match = /^(\s*)([-+*]|\d{1,9}[.)])([ \t]+)(?:\[([ xX])\]([ \t]+))?(.*)$/.exec(line);
  if (!match) return null;
  const [, indent, marker, spacing, task, taskSpace, content] = match;
  const prefixLength = line.length - content!.length;
  if (start < lineStart + prefixLength) return null;
  if (content!.trim() === "") {
    return { start: lineStart, end: lineStart + line.length, text: indent!,
      selectionStart: lineStart + indent!.length, selectionEnd: lineStart + indent!.length };
  }
  const numeric = /^(\d+)([.)])$/.exec(marker!);
  const nextMarker = numeric ? `${Number(numeric[1]) + 1}${numeric[2]}` : marker!;
  const text = `\n${indent}${nextMarker}${spacing}${task !== undefined ? `[ ]${taskSpace}` : ""}`;
  if (numeric && lineEnd !== -1) {
    // Include the suffix in one browser edit/undo transaction. Only direct
    // siblings of the same marker type are renumbered; nested list lines pass
    // through unchanged, while blank lines and unrelated blocks end the scan.
    let position = lineEnd + 1;
    let number = Number(numeric[1]) + 2;
    let suffix = value.slice(start, lineEnd) + "\n";
    let touched = false;
    while (position < value.length) {
      const nextEnd = value.indexOf("\n", position);
      const stop = nextEnd === -1 ? value.length : nextEnd;
      const nextLine = value.slice(position, stop);
      if (!nextLine.trim()) break;
      const item = /^([ \t]*)(\d{1,9})([.)])([ \t]+)(.*)$/.exec(nextLine);
      const nested = /^([ \t]+)(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(nextLine);
      if (item && item[1] === indent && item[3] === numeric[2]) {
        suffix += `${item[1]}${number++}${item[3]}${item[4]}${item[5]}`;
        touched = true;
      } else if (nested && nested[1]!.startsWith(indent!) && nested[1]!.length > indent!.length) {
        suffix += nextLine;
      } else break;
      if (nextEnd !== -1) suffix += "\n";
      position = nextEnd === -1 ? value.length : nextEnd + 1;
    }
    if (touched) return { start, end: position, text: text + suffix,
      selectionStart: start + text.length, selectionEnd: start + text.length };
  }
  return { start, end, text, selectionStart: start + text.length, selectionEnd: start + text.length };
}

/** Only explicit whole-item deletion or a sibling boundary merge is structural.
 * Require consecutive original numbers; never normalize handwritten numbering.
 */
export function deleteOrderedItem(value: string, start: number, end: number, key: string): TextEdit | null {
  if (key !== "Backspace" && key !== "Delete") return null;
  const item = (line: string) => /^([ \t]*)([1-9]\d{0,8})([.)])([ \t]+)(.*)$/.exec(line);
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  let removeStart = lineStart, removeEnd: number, replacement = "", removed = 0;
  let first = item(value.slice(lineStart, value.indexOf("\n", lineStart) < 0 ? value.length : value.indexOf("\n", lineStart)));
  if (start === end) {
    if (key === "Delete") {
      if (value[start] !== "\n") return null;
      removeStart = start + 1;
      const stop = value.indexOf("\n", removeStart);
      first = item(value.slice(removeStart, stop < 0 ? value.length : stop));
    } else if (!first || (start !== lineStart && start !== lineStart + first[0].length - first[5]!.length)) return null;
    if (!first || removeStart === 0) return null;
    // Merge the item's content into its previous sibling, removing its marker.
    removeEnd = removeStart + first[0].length - first[5]!.length;
    removeStart--;
    removed = 1;
  } else {
    if (start !== lineStart || !first) return null;
    // A selection must contain complete item lines, optionally their last LF.
    removeEnd = end;
    if (value[end - 1] !== "\n") {
      if (end !== value.length && value[end] !== "\n") return null;
      if (value[end] === "\n") removeEnd++;
    }
    const selected = value.slice(start, removeEnd).replace(/\n$/, "").split("\n");
    for (const line of selected) {
      const next = item(line);
      if (!next || next[1] !== first[1] || next[3] !== first[3] || Number(next[2]) !== Number(first[2]) + removed) return null;
      removed++;
    }
  }
  if (!first || insideFence(value.slice(0, lineStart))) return null;
  // Find the preceding direct sibling, passing nested list lines unchanged.
  const priorEnd = (start === end && key === "Delete") ? start : lineStart - 1;
  let prior = priorEnd;
  let predecessor: RegExpExecArray | null = null;
  while (prior >= 0) {
    const left = value.lastIndexOf("\n", prior - 1) + 1;
    const line = value.slice(left, prior);
    const parsed = item(line);
    if (parsed && parsed[1] === first[1] && parsed[3] === first[3]) { predecessor = parsed; break; }
    const nested = /^([ \t]+)(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(line);
    if (!nested || !nested[1]!.startsWith(first[1]!) || nested[1]!.length <= first[1]!.length || start === end) {
      if (start !== end && !line.trim()) break;
      return null;
    }
    prior = left - 1;
  }
  if (predecessor ? Number(predecessor[2]) + 1 !== Number(first[2]) : start === end || Number(first[2]) !== 1 || first[1] !== "") return null;
  const afterLineEnd = value.indexOf("\n", removeEnd);
  const after = value.slice(removeEnd, afterLineEnd < 0 ? value.length : afterLineEnd);
  // Do not delete/reparent a nested subtree owned by the removed item.
  const child = /^([ \t]+)(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(after);
  if (child && child[1]!.startsWith(first[1]!) && child[1]!.length > first[1]!.length) return null;
  let position = removeEnd, number = Number(first[2]) + removed;
  if (start === end) {
    // Keep the merged content and LF before subsequent siblings in this edit.
    const stop = value.indexOf("\n", removeEnd);
    if (stop === -1) return { start: removeStart, end: removeEnd, text: "", selectionStart: removeStart, selectionEnd: removeStart };
    replacement = value.slice(removeEnd, stop + 1);
    position = stop + 1;
    const nextEnd = value.indexOf("\n", position);
    const nested = /^([ \t]+)(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(value.slice(position, nextEnd < 0 ? value.length : nextEnd));
    if (nested && nested[1]!.startsWith(first[1]!) && nested[1]!.length > first[1]!.length) return null;
  }
  while (position < value.length) {
    const nextEnd = value.indexOf("\n", position), stop = nextEnd < 0 ? value.length : nextEnd;
    const line = value.slice(position, stop), parsed = item(line);
    const nested = /^([ \t]+)(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(line);
    if (parsed && parsed[1] === first[1] && parsed[3] === first[3] && Number(parsed[2]) === number) {
      replacement += `${parsed[1]}${number++ - removed}${parsed[3]}${parsed[4]}${parsed[5]}`;
    } else if (nested && nested[1]!.startsWith(first[1]!) && nested[1]!.length > first[1]!.length) replacement += line;
    else break;
    if (nextEnd >= 0) replacement += "\n";
    position = nextEnd < 0 ? value.length : nextEnd + 1;
  }
  return { start: removeStart, end: position, text: replacement, selectionStart: removeStart, selectionEnd: removeStart };
}

/** Bind only to the actual focused textarea. Plain text keeps native typing. */
export function bindMarkdownEditing(textarea: HTMLTextAreaElement, enabled: () => boolean): { reset(): void } {
  let composing = false;
  let previous = textarea.value;
  const closings = new Map<number, string>();
  const sync = (): void => {
    const next = textarea.value;
    let left = 0;
    while (left < previous.length && left < next.length && previous[left] === next[left]) left++;
    let oldEnd = previous.length, newEnd = next.length;
    while (oldEnd > left && newEnd > left && previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
    const pairs = [...closings];
    closings.clear();
    for (const [position, character] of pairs) {
      if (position < left) closings.set(position, character);
      else if (position >= oldEnd) closings.set(position + newEnd - oldEnd, character);
    }
    previous = next;
  };
  const apply = (edit: TextEdit): void => {
    const before = textarea.value;
    const expected = before.slice(0, edit.start) + edit.text + before.slice(edit.end);
    const scrollTop = textarea.scrollTop;
    const scrollLeft = textarea.scrollLeft;
    const direction = textarea.selectionDirection;
    let inputReceived = false;
    const receiveInput = (): void => { inputReceived = true; };
    textarea.addEventListener("input", receiveInput);
    textarea.setSelectionRange(edit.start, edit.end);
    try {
      // insertText is deprecated, but is still the browser's undo-preserving
      // textarea mutation path. Use a standard range edit when unavailable.
      textarea.ownerDocument.execCommand?.("insertText", false, edit.text);
    } catch { /* The standard fallback below works without editing commands. */ }
    textarea.removeEventListener("input", receiveInput);
    const fallback = textarea.value !== expected;
    if (fallback) textarea.setRangeText(edit.text, edit.start, edit.end, "preserve");
    sync();
    textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd, direction);
    textarea.scrollTop = scrollTop;
    textarea.scrollLeft = scrollLeft;
    // Range edits (and some editing commands) do not emit input.
    if (!inputReceived || fallback) textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };
  textarea.addEventListener("compositionstart", () => { composing = true; });
  textarea.addEventListener("compositionend", () => { composing = false; });
  textarea.addEventListener("input", sync);
  textarea.addEventListener("keydown", (event) => {
    if (textarea.ownerDocument.activeElement !== textarea || textarea.hidden || textarea.disabled || textarea.readOnly ||
        !enabled() || event.defaultPrevented || composing || event.isComposing || event.keyCode === 229 || event.altKey) return;
    sync();
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    let edit: TextEdit | null = null;
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
      edit = wrapMarkdown(textarea.value, start, end, event.key.toLowerCase());
      // The physical chord still works with Thunderbird's Russian keyboard layout.
      if (!edit) {
        const key = ({ KeyB: "b", KeyI: "i", KeyK: "k", Backquote: "`" } as Record<string, string>)[event.code];
        if (key) edit = wrapMarkdown(textarea.value, start, end, key);
      }
    } else if (!event.ctrlKey && !event.metaKey) {
      if (event.key === "Tab") {
        // Even a no-op outdent keeps focus in the Markdown editor.
        event.preventDefault();
        edit = indentMarkdown(textarea.value, start, end, event.shiftKey);
      }
      else if (event.key === "Enter" && !event.shiftKey) edit = continueMarkdownList(textarea.value, start, end);
      else if ((event.key === "Backspace" || event.key === "Delete") && !event.shiftKey) edit = deleteOrderedItem(textarea.value, start, end, event.key);
      else if (start === end && closings.get(start) === event.key && textarea.value[start] === event.key) {
        event.preventDefault();
        textarea.setSelectionRange(start + 1, start + 1);
        closings.delete(start);
        return;
      } else {
        const close = ({ "[": "]", "(": ")", "`": "`" } as Record<string, string>)[event.key];
        // Pair at a boundary; preserve ordinary punctuation in the middle of words.
        const adjacentBacktick = event.key === "`" && start === end &&
          (textarea.value[start - 1] === "`" || textarea.value[start] === "`");
        if (close && !adjacentBacktick && (start !== end || start === textarea.value.length || /[\s\])}]/.test(textarea.value[start]!))) {
          const text = event.key + textarea.value.slice(start, end) + close;
          edit = { start, end, text, selectionStart: start + 1, selectionEnd: end + 1 };
          event.preventDefault();
          apply(edit);
          closings.set(start + text.length - 1, close);
          return;
        }
      }
    }
    if (!edit) return;
    event.preventDefault();
    apply(edit);
  });
  return { reset() { closings.clear(); previous = textarea.value; composing = false; } };
}
