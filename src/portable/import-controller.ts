import type { NoteStore } from "../ui/store";
import { importPlansEqual, materializeImportPlan, planImport } from "./import-plan";
import type {
  ConflictPolicy,
  ImportCommitResult,
  ImportMode,
  ImportPlan,
  PortableDataV1,
} from "./types";

export function createImportPreview(
  store: NoteStore,
  data: PortableDataV1,
  mode: ImportMode,
  conflictPolicy: ConflictPolicy,
): ImportPlan {
  return planImport(store.getNoteSnapshot(), data.notes, mode, conflictPolicy);
}

export async function commitConfirmedImport(
  store: NoteStore,
  confirmedPlan: ImportPlan,
  generateId?: () => string,
): Promise<ImportCommitResult> {
  return store.withMutationLock(async (session) => {
    await session.writeBarrier();
    const authoritativePlan = planImport(
      session.getNoteSnapshot(),
      confirmedPlan.importedNotes,
      confirmedPlan.mode,
      confirmedPlan.conflictPolicy,
    );
    if (!importPlansEqual(confirmedPlan, authoritativePlan)) {
      return {
        status: "changed",
        plan: authoritativePlan,
        safetyBackupInvalidated: confirmedPlan.mode === "restore",
      };
    }

    const notes = materializeImportPlan(authoritativePlan, generateId);
    await session.replaceAll(notes);
    return { status: "committed", notes, plan: authoritativePlan };
  });
}
