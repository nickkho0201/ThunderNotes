/** A conservative source outline: continuous list lines only, never code/text. */
export interface ListLine {
  index: number; start: number; end: number; depth: number; parent: number | null;
  number: number | null; marker: string; numberStart: number; group: ListLine[];
}
export const MARKDOWN_INDENT_SIZE = 4;
export function listOutline(value: string): ListLine[] {
  const result: ListLine[] = [], stack: ListLine[] = [];
  const groups = new Map<string, ListLine[]>();
  let offset = 0, segment = 0, fence: string | null = null;
  for (const [index, line] of value.split("\n").entries()) {
    const fenceMatch = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1]!;
      else if (fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length && !fenceMatch[2]!.trim()) fence = null;
      stack.length = 0; segment++;
    } else if (!fence) {
      const match = /^([ \t]*)(?:(\d{1,9})([.)])|([-+*]))([ \t]+)(.*)$/.exec(line);
      if (!match) { stack.length = 0; segment++; }
      else {
        const depth = match[1]!.replace(/\t/g, " ".repeat(MARKDOWN_INDENT_SIZE)).length;
        while (stack.length && stack[stack.length - 1]!.depth >= depth) stack.pop();
        const parent = stack[stack.length - 1]?.index ?? null;
        const key = `${segment}:${parent}:${depth}`;
        const marker = match[3] ?? match[4]!;
        let group = groups.get(key);
        if (!group || group[0]!.marker !== marker) { group = []; groups.set(key, group); }
        const node: ListLine = { index, start: offset, end: offset + line.length, depth, parent,
          number: match[2] ? Number(match[2]) : null, marker, numberStart: offset + match[1]!.length, group };
        group.push(node); result.push(node); stack.push(node);
      }
    }
    offset += line.length + 1;
  }
  return result;
}

/** Whole-line/subtree deletion, including the first child of a nested list. */
export function selectedOrderedDeletion(value: string, start: number, end: number) {
  if (start === end || (start > 0 && value[start - 1] !== "\n")) return null;
  let stop = end;
  if (value[end - 1] !== "\n") {
    if (end !== value.length && value[end] !== "\n") return null;
    if (value[end] === "\n") stop++;
  }
  const outline = listOutline(value), byIndex = new Map(outline.map((node) => [node.index, node]));
  const removed = outline.filter((node) => node.start >= start && node.start < stop);
  if (!removed.length || removed[0]!.number === null || removed[0]!.start !== start) return null;
  if (value.slice(start, stop).replace(/\n$/, "").split("\n").length !== removed.length) return null;
  const indices = new Set(removed.map((node) => node.index));
  for (const node of outline.filter((entry) => entry.start >= stop)) {
    let parent = node.parent;
    while (parent !== null) { if (indices.has(parent)) return null; parent = byIndex.get(parent)?.parent ?? null; }
  }
  const groups = new Set(removed.filter((node) => node.number !== null).map((node) => node.group));
  for (const group of groups) {
    if (indices.has(group[0]!.index) && group[0]!.number !== 1) return null;
    if (!group.every((node, index) => node.number === group[0]!.number! + index && String(node.number) === value.slice(node.numberStart, node.numberStart + String(node.number).length))) return null;
  }
  const changes = [{ start, end: stop, text: "" }];
  for (const group of groups) {
    let number = group[0]!.number!;
    for (const node of group) {
      if (indices.has(node.index)) continue;
      const text = String(number++);
      if (text !== String(node.number)) changes.push({ start: node.numberStart, end: node.numberStart + String(node.number).length, text });
    }
  }
  let text = value;
  const right = Math.max(...changes.map((change) => change.end));
  for (const change of changes.sort((a, b) => b.start - a.start)) text = text.slice(0, change.start) + change.text + text.slice(change.end);
  return { start, end: right, text: text.slice(start, text.length - (value.length - right)), selectionStart: start, selectionEnd: start };
}

/** Renumber only the source/destination groups of moved ordered items. */
export function movedOrderedNumbers(before: string, after: string): Array<{ start: number; end: number; text: string }> {
  const old = listOutline(before), next = listOutline(after);
  const oldByLine = new Map(old.map((node) => [node.index, node]));
  const moved = next.filter((node) => node.number !== null && oldByLine.get(node.index)?.depth !== node.depth);
  const affected = new Set<ListLine[]>();
  const sequential = (group: ListLine[]) => group.every((node, index) => node.number === group[0]!.number! + index);
  for (const node of moved) {
    const original = oldByLine.get(node.index)!;
    if (!sequential(original.group)) continue;
    // Destination children need a real list parent. Arbitrary code indentation
    // and standalone indented lists retain their handwritten starting number.
    if (node.parent === null && node.depth > original.depth) continue;
    affected.add(node.group);
    for (const sibling of next) {
      if (sibling.number !== null && original.group.some((entry) => entry.index === sibling.index) && sibling.depth === original.depth) affected.add(sibling.group);
    }
  }
  const changes: Array<{ start: number; end: number; text: string }> = [];
  for (const group of affected) {
    const stable = group.filter((node) => oldByLine.get(node.index)?.depth === node.depth);
    // Check original numbering independently of inserted/moved items.
    if (stable.some((node) => !sequential(oldByLine.get(node.index)!.group))) continue;
    const first = group[0]!;
    const originalFirst = oldByLine.get(first.index)!;
    const firstStable = stable[0];
    let number = firstStable ? oldByLine.get(firstStable.index)!.group[0]!.number! :
      first.parent !== null ? 1 : originalFirst.group[0]!.number!;
    for (const node of group) {
      const text = String(number++);
      if (text !== String(node.number)) changes.push({ start: node.numberStart, end: node.numberStart + String(node.number).length, text });
    }
  }
  return changes.sort((a, b) => a.start - b.start);
}
