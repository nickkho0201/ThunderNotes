import { decodePortableText } from "./codec";
import { getBrowser, type DownloadsApi, type DownloadDelta } from "../api/browser";
import {
  MAX_PORTABLE_FILE_BYTES,
  PortableDataError,
  type PortableDataV1,
} from "./types";

export interface PortableFileInput {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export async function decodePortableFile(file: PortableFileInput): Promise<PortableDataV1> {
  if (file.size <= 0) {
    throw new PortableDataError("empty-file", "The selected file is empty.");
  }
  if (file.size > MAX_PORTABLE_FILE_BYTES) {
    throw new PortableDataError(
      "file-too-large",
      `The selected file exceeds ${MAX_PORTABLE_FILE_BYTES} bytes.`,
      { actual: file.size, maximum: MAX_PORTABLE_FILE_BYTES },
    );
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (error) {
    throw new PortableDataError(
      "file-read-failed",
      "The selected file could not be read.",
      {},
      { cause: error },
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PortableDataError(
      "invalid-utf8",
      "The selected file is not valid UTF-8.",
      {},
      { cause: error },
    );
  }
  return decodePortableText(text);
}

export function createBackupFilename(exportedAt: Date): string {
  const timestamp = exportedAt.toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
  return `thundernotes-backup-${timestamp}.json`;
}

export type DownloadResult = "complete" | "cancelled";

export class BackupSaveError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "BackupSaveError";
  }
}

function isDownloadCancelled(error: unknown): boolean {
  const message = error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message : String(error);
  return /^(USER_CANCELED|Download cancel(?:ed|led) by the user\.?)$/i.test(message);
}

export async function downloadPortableData(
  text: string,
  filename: string,
  downloads: DownloadsApi | undefined = getBrowser()?.downloads,
  urlObject: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL,
): Promise<DownloadResult> {
  if (!downloads) throw new BackupSaveError(new Error("Downloads API is unavailable."));
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = urlObject.createObjectURL(blob);
  let id: number | null = null;
  const early = new Map<number, DownloadDelta>();
  let finish!: (delta: DownloadDelta) => void;
  const completed = new Promise<DownloadDelta>((resolve) => { finish = resolve; });
  const listener = (delta: DownloadDelta): void => {
    if (delta.state?.current !== "complete" && delta.state?.current !== "interrupted") return;
    if (id === null) early.set(delta.id, delta);
    else if (delta.id === id) finish(delta);
  };
  try {
    downloads.onChanged.addListener(listener);
    id = await downloads.download({ url, filename, saveAs: true });
    if (!Number.isInteger(id) || id < 0) throw new Error("Downloads API returned an invalid download ID.");
    const observed = early.get(id);
    if (observed) finish(observed);
    // Handles tiny local downloads that finish before download() resolves.
    // onChanged remains active if search fails or still reports in_progress.
    try {
      const item = (await downloads.search({ id })).find((entry) => entry.id === id);
      if (item?.state === "complete" || item?.state === "interrupted") {
        finish({ id, state: { current: item.state }, error: { current: item.error } });
      }
    } catch { /* The terminal event remains authoritative. */ }
    const terminal = await completed;
    if (terminal.state?.current === "complete") return "complete";
    let reason = terminal.error?.current;
    if (!reason) {
      try { reason = (await downloads.search({ id })).find((item) => item.id === id)?.error; }
      catch { /* Report interruption if its reason cannot be queried. */ }
    }
    if (reason === "USER_CANCELED") return "cancelled";
    throw new Error(reason ?? "The backup download was interrupted.");
  } catch (error) {
    if (isDownloadCancelled(error)) return "cancelled";
    throw new BackupSaveError(error);
  } finally {
    // Keep the URL alive through Save As and actual completion/interruption,
    // not merely until the API accepts the request.
    try { downloads.onChanged.removeListener(listener); }
    finally { urlObject.revokeObjectURL(url); }
  }
}
