import { createNoteId, type Note } from "../notes/model";
import { portableNoteToNote, toPortableNote } from "./codec";
import type {
  ConflictPolicy,
  ImportMode,
  ImportPlan,
  JsonValue,
  PortableNoteV1,
} from "./types";

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => jsonEqual(entry, right[index]!));
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key, index) => key === rightKeys[index] && jsonEqual(left[key]!, right[key]!),
    );
  }
  return false;
}

export function portableNotesEqual(left: PortableNoteV1, right: PortableNoteV1): boolean {
  return (
    left.id === right.id &&
    left.content === right.content &&
    left.format === right.format &&
    left.color === right.color &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.revision === right.revision &&
    left.schemaVersion === right.schemaVersion &&
    (left.meta === undefined
      ? right.meta === undefined
      : right.meta !== undefined && jsonEqual(left.meta, right.meta))
  );
}

function sortNotes(notes: readonly PortableNoteV1[]): PortableNoteV1[] {
  return [...notes].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export function planImport(
  localNotes: readonly Note[],
  importedNotes: readonly PortableNoteV1[],
  mode: ImportMode,
  conflictPolicy: ConflictPolicy,
): ImportPlan {
  const localSnapshot = sortNotes(localNotes.map(toPortableNote));
  const importedSnapshot = sortNotes(
    importedNotes.map((note) => toPortableNote(portableNoteToNote(note))),
  );
  const localById = new Map(localSnapshot.map((note) => [note.id, note]));
  let newCount = 0;
  let identicalCount = 0;
  let conflictCount = 0;
  const conflictIds: string[] = [];
  const actions = importedSnapshot.map((imported) => {
    const local = localById.get(imported.id);
    if (!local) {
      newCount += 1;
      return { kind: "add" as const, imported };
    }
    if (portableNotesEqual(local, imported)) {
      identicalCount += 1;
      return { kind: "identical" as const, local, imported };
    }
    conflictCount += 1;
    conflictIds.push(imported.id);
    return { kind: "conflict" as const, local, imported, policy: conflictPolicy };
  });

  let resultingTotal = importedSnapshot.length;
  if (mode === "merge") {
    const conflictDelta = conflictPolicy === "keep-both" ? conflictCount : 0;
    resultingTotal = localSnapshot.length + newCount + conflictDelta;
  }
  return {
    mode,
    conflictPolicy,
    localSnapshot,
    importedNotes: importedSnapshot,
    actions,
    newCount,
    identicalCount,
    conflictCount,
    resultingTotal,
    conflictIds,
  };
}

function noteArraysEqual(left: readonly PortableNoteV1[], right: readonly PortableNoteV1[]): boolean {
  return (
    left.length === right.length &&
    left.every((note, index) => portableNotesEqual(note, right[index]!))
  );
}

export function importPlansEqual(left: ImportPlan, right: ImportPlan): boolean {
  return (
    left.mode === right.mode &&
    left.conflictPolicy === right.conflictPolicy &&
    left.newCount === right.newCount &&
    left.identicalCount === right.identicalCount &&
    left.conflictCount === right.conflictCount &&
    left.resultingTotal === right.resultingTotal &&
    left.conflictIds.length === right.conflictIds.length &&
    left.conflictIds.every((id, index) => id === right.conflictIds[index]) &&
    noteArraysEqual(left.localSnapshot, right.localSnapshot) &&
    noteArraysEqual(left.importedNotes, right.importedNotes)
  );
}

export function materializeImportPlan(
  plan: ImportPlan,
  generateId: () => string = createNoteId,
): Note[] {
  if (plan.mode === "restore") return plan.importedNotes.map(portableNoteToNote);

  const result = new Map(plan.localSnapshot.map((note) => [note.id, portableNoteToNote(note)]));
  const usedIds = new Set([
    ...plan.localSnapshot.map((note) => note.id),
    ...plan.importedNotes.map((note) => note.id),
  ]);
  for (const action of plan.actions) {
    if (action.kind === "add") {
      result.set(action.imported.id, portableNoteToNote(action.imported));
      continue;
    }
    if (action.kind !== "conflict" || action.policy === "keep-current") continue;
    if (action.policy === "use-imported") {
      result.set(action.imported.id, portableNoteToNote(action.imported));
      continue;
    }

    let id = generateId();
    while (usedIds.has(id)) id = generateId();
    usedIds.add(id);
    result.set(id, portableNoteToNote({ ...action.imported, id }));
  }
  return [...result.values()];
}
