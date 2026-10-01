import { encodePortableData } from "../portable/codec";
import {
  commitConfirmedImport,
  createImportPreview,
} from "../portable/import-controller";
import { decodePortableFile, createBackupFilename, downloadPortableData, BackupSaveError } from "../portable/file";
import type { DownloadResult } from "../portable/file";
import { planImport } from "../portable/import-plan";
import type { ConflictPolicy, ImportPlan, PortableDataV1 } from "../portable/types";
import type { Note } from "../notes/model";
import type { NoteStore } from "./store";
import { formatDateTime, t } from "../i18n";
import { localizePortableError } from "./portable-errors";

export interface DataDialogOptions {
  root: HTMLDialogElement;
  store: NoteStore;
  appVersion: string;
  onMessage(message: string): void;
  confirm?: (message: string) => boolean;
  download?: (text: string, filename: string) => Promise<DownloadResult>;
}

function requireInside<T extends HTMLElement>(root: ParentNode, id: string): T {
  const element = root.querySelector(`#${id}`);
  if (!element) throw new Error(`[ThunderNotes] missing data dialog element #${id}`);
  return element as T;
}

export class DataDialog {
  private readonly closeButtons: NodeListOf<HTMLButtonElement>;
  private readonly exportButton: HTMLButtonElement;
  private readonly exportStatus: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private readonly importStatus: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly exportedAt: HTMLElement;
  private readonly appVersion: HTMLElement;
  private readonly fileCount: HTMLElement;
  private readonly newCount: HTMLElement;
  private readonly identicalCount: HTMLElement;
  private readonly conflictCount: HTMLElement;
  private readonly resultingTotal: HTMLElement;
  private readonly conflictPolicy: HTMLSelectElement;
  private readonly importButton: HTMLButtonElement;
  private readonly restoreSourceStep: HTMLElement;
  private readonly restoreSource: HTMLElement;
  private readonly safetyButton: HTMLButtonElement;
  private readonly safetyStatus: HTMLElement;
  private readonly safetyAcknowledge: HTMLInputElement;
  private readonly restoreSummary: HTMLElement;
  private readonly restoreButton: HTMLButtonElement;
  private data: PortableDataV1 | null = null;
  private sourceFilename: string | null = null;
  private mergePlan: ImportPlan | null = null;
  private safetyPlan: ImportPlan | null = null;
  private busy = false;

  constructor(private readonly options: DataDialogOptions) {
    const root = options.root;
    this.closeButtons = root.querySelectorAll<HTMLButtonElement>("[data-data-close]");
    this.exportButton = requireInside(root, "tn-data-export");
    this.exportStatus = requireInside(root, "tn-data-export-status");
    this.fileInput = requireInside(root, "tn-data-file");
    this.importStatus = requireInside(root, "tn-data-import-status");
    this.summary = requireInside(root, "tn-data-summary");
    this.exportedAt = requireInside(root, "tn-data-exported-at");
    this.appVersion = requireInside(root, "tn-data-app-version");
    this.fileCount = requireInside(root, "tn-data-file-count");
    this.newCount = requireInside(root, "tn-data-new-count");
    this.identicalCount = requireInside(root, "tn-data-identical-count");
    this.conflictCount = requireInside(root, "tn-data-conflict-count");
    this.resultingTotal = requireInside(root, "tn-data-resulting-total");
    this.conflictPolicy = requireInside(root, "tn-data-conflict-policy");
    this.importButton = requireInside(root, "tn-data-import");
    this.restoreSourceStep = requireInside(root, "tn-data-restore-source-step");
    this.restoreSource = requireInside(root, "tn-data-restore-source");
    this.safetyButton = requireInside(root, "tn-data-safety-export");
    this.safetyStatus = requireInside(root, "tn-data-safety-status");
    this.safetyAcknowledge = requireInside(root, "tn-data-safety-ack");
    this.restoreSummary = requireInside(root, "tn-data-restore-summary");
    this.restoreButton = requireInside(root, "tn-data-restore");
    this.bind();
    this.resetImport();
  }

  open(): void {
    if (typeof this.options.root.showModal === "function") this.options.root.showModal();
    else this.options.root.setAttribute("open", "");
  }

  close(): void {
    if (typeof this.options.root.close === "function") this.options.root.close();
    else this.options.root.removeAttribute("open");
  }

  private bind(): void {
    for (const button of this.closeButtons) button.addEventListener("click", () => this.close());
    this.exportButton.addEventListener("click", () => void this.exportBackup(false));
    this.fileInput.addEventListener("change", () => void this.readSelectedFile());
    this.conflictPolicy.addEventListener("change", () => this.refreshMergePreview());
    this.importButton.addEventListener("click", () => void this.commitMerge());
    this.safetyButton.addEventListener("click", () => void this.exportBackup(true));
    this.safetyAcknowledge.addEventListener("change", () => this.syncRestoreButton());
    this.restoreButton.addEventListener("click", () => void this.commitRestore());
  }

  private selectedPolicy(): ConflictPolicy {
    const value = this.conflictPolicy.value;
    if (value === "keep-current" || value === "use-imported") return value;
    return "keep-both";
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.exportButton.disabled = busy;
    this.fileInput.disabled = busy;
    this.conflictPolicy.disabled = busy || this.data === null;
    this.importButton.disabled = busy || this.mergePlan === null;
    this.safetyButton.disabled = busy || this.data === null;
    this.safetyAcknowledge.disabled = busy || this.safetyPlan === null;
    this.syncRestoreButton();
  }

  private resetImport(): void {
    this.data = null;
    this.sourceFilename = null;
    this.mergePlan = null;
    this.safetyPlan = null;
    this.summary.hidden = true;
    this.fileInput.value = "";
    this.importStatus.textContent = "";
    this.importButton.disabled = true;
    this.conflictPolicy.disabled = true;
    this.safetyButton.disabled = true;
    this.safetyStatus.textContent = "";
    this.safetyAcknowledge.checked = false;
    this.safetyAcknowledge.disabled = true;
    this.restoreSummary.textContent = "";
    this.restoreButton.disabled = true;
    this.renderRestoreSource();
  }

  private async createDownload(): Promise<{ filename: string; noteCount: number; planSnapshot: readonly Note[]; outcome: DownloadResult }> {
    const exportedAt = new Date();
    const snapshot = this.options.store.getNoteSnapshot();
    const text = encodePortableData(snapshot, this.options.appVersion, exportedAt);
    const filename = createBackupFilename(exportedAt);
    const outcome = await (this.options.download ?? downloadPortableData)(text, filename);
    return { filename, noteCount: snapshot.length, planSnapshot: snapshot, outcome };
  }

  private async exportBackup(forRestore: boolean): Promise<void> {
    if (this.busy) return;
    const target = forRestore ? this.safetyStatus : this.exportStatus;
    if (forRestore) this.invalidateSafetyBackup();
    this.setBusy(true);
    target.textContent = t("dataExportSaving");
    try {
      const result = await this.createDownload();
      if (result.outcome === "cancelled") {
        target.textContent = t("dataExportCancelled");
        return;
      }
      // Save As may rename the file; do not report the suggested name as actual.
      const status = t("dataExportComplete", String(result.noteCount));
      if (!forRestore) {
        this.exportStatus.textContent = status;
        return;
      }
      if (!this.data) return;
      this.safetyPlan = planImport(
        result.planSnapshot,
        this.data.notes,
        "restore",
        this.selectedPolicy(),
      );
      this.safetyStatus.textContent = status;
      this.safetyAcknowledge.checked = false;
      this.safetyAcknowledge.disabled = false;
      this.renderRestoreSummary();
      this.syncRestoreButton();
    } catch (error) {
      target.textContent = error instanceof BackupSaveError
        ? t("dataExportSaveError") : t("dataExportError", localizePortableError(error));
    } finally {
      this.setBusy(false);
    }
  }

  private async readSelectedFile(): Promise<void> {
    const files = this.fileInput.files;
    if (!files || files.length !== 1 || !files[0]) {
      this.resetImport();
      return;
    }
    this.setBusy(true);
    try {
      const selectedFile = files[0];
      this.data = await decodePortableFile(selectedFile);
      this.sourceFilename = selectedFile.name;
      this.importStatus.textContent = "";
      this.renderRestoreSource();
      this.invalidateSafetyBackup();
      this.refreshMergePreview();
    } catch (error) {
      this.resetImport();
      this.importStatus.textContent = t("dataInvalidFile", localizePortableError(error));
    } finally {
      this.setBusy(false);
    }
  }

  private refreshMergePreview(): void {
    if (!this.data) return;
    this.mergePlan = createImportPreview(
      this.options.store,
      this.data,
      "merge",
      this.selectedPolicy(),
    );
    this.renderSummary();
    this.importButton.disabled = this.busy;
    this.safetyButton.disabled = this.busy;
    this.invalidateSafetyBackup();
  }

  private renderSummary(): void {
    if (!this.data || !this.mergePlan) return;
    this.summary.hidden = false;
    this.exportedAt.textContent = formatDateTime(new Date(this.data.exportedAt).getTime(), "medium");
    this.appVersion.textContent = this.data.appVersion;
    this.fileCount.textContent = String(this.data.notes.length);
    this.newCount.textContent = String(this.mergePlan.newCount);
    this.identicalCount.textContent = String(this.mergePlan.identicalCount);
    this.conflictCount.textContent = String(this.mergePlan.conflictCount);
    this.resultingTotal.textContent = String(this.mergePlan.resultingTotal);
  }

  private renderRestoreSummary(): void {
    if (!this.data || !this.safetyPlan) {
      this.restoreSummary.textContent = "";
      return;
    }
    this.restoreSummary.textContent = t("dataRestoreSummary", [
      String(this.safetyPlan.localSnapshot.length),
      String(this.data.notes.length),
    ]);
  }

  private renderRestoreSource(): void {
    if (!this.data || this.sourceFilename === null) {
      this.restoreSourceStep.textContent = t("dataRestoreSourceStep");
      this.restoreSource.textContent = t("dataRestoreSourceRequired");
      return;
    }
    this.restoreSourceStep.textContent = t("dataRestoreSourceReady");
    this.restoreSource.textContent = t("dataRestoreSourceSelected", [
      this.sourceFilename,
      String(this.data.notes.length),
    ]);
  }

  private invalidateSafetyBackup(): void {
    this.safetyPlan = null;
    this.safetyStatus.textContent = this.data ? t("dataSafetyRequired") : "";
    this.safetyAcknowledge.checked = false;
    this.safetyAcknowledge.disabled = true;
    this.restoreSummary.textContent = "";
    this.restoreButton.disabled = true;
  }

  private syncRestoreButton(): void {
    this.restoreButton.disabled =
      this.busy || this.safetyPlan === null || !this.safetyAcknowledge.checked;
  }

  private async commitMerge(): Promise<void> {
    if (!this.mergePlan || this.busy) return;
    this.setBusy(true);
    try {
      const result = await commitConfirmedImport(this.options.store, this.mergePlan);
      if (result.status === "changed") {
        this.mergePlan = result.plan;
        this.renderSummary();
        this.importStatus.textContent = t("dataLocalChanged");
        return;
      }
      this.resetImport();
      this.close();
      this.options.onMessage(t("dataImportComplete", String(result.notes.length)));
    } catch (error) {
      this.importStatus.textContent = t("dataImportError", localizePortableError(error));
    } finally {
      this.setBusy(false);
    }
  }

  private async commitRestore(): Promise<void> {
    if (!this.safetyPlan || !this.safetyAcknowledge.checked || this.busy) return;
    const confirm = this.options.confirm ?? ((message: string) => window.confirm(message));
    if (!confirm(t("dataRestoreConfirm"))) return;
    this.setBusy(true);
    try {
      const result = await commitConfirmedImport(this.options.store, this.safetyPlan);
      if (result.status === "changed") {
        this.mergePlan = this.data
          ? createImportPreview(this.options.store, this.data, "merge", this.selectedPolicy())
          : null;
        if (this.mergePlan) this.renderSummary();
        this.invalidateSafetyBackup();
        this.importStatus.textContent = t("dataRestoreChanged");
        return;
      }
      this.resetImport();
      this.close();
      this.options.onMessage(t("dataRestoreComplete", String(result.notes.length)));
    } catch (error) {
      this.importStatus.textContent = t("dataImportError", localizePortableError(error));
    } finally {
      this.setBusy(false);
    }
  }
}
