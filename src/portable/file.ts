import { decodePortableText } from "./codec";
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

export function downloadPortableData(
  text: string,
  filename: string,
  documentObject: Document = document,
  urlObject: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL,
): void {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = urlObject.createObjectURL(blob);
  const anchor = documentObject.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  documentObject.body.append(anchor);
  anchor.click();
  anchor.remove();
  queueMicrotask(() => urlObject.revokeObjectURL(url));
}
