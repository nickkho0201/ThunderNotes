import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodePortableData } from "../src/portable/codec.ts";
import { createBackupFilename, decodePortableFile, downloadPortableData } from "../src/portable/file.ts";
import type { DownloadDelta, DownloadItem, DownloadsApi } from "../src/api/browser.ts";
import { MAX_PORTABLE_FILE_BYTES } from "../src/portable/types.ts";
import { note } from "./helpers.ts";

function fileFrom(bytes: Uint8Array, declaredSize = bytes.byteLength) {
  return {
    size: declaredSize,
    async arrayBuffer(): Promise<ArrayBuffer> {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
  };
}

describe("portable file transport", () => {
  it("decodes strict UTF-8 and an optional BOM", async () => {
    const text = encodePortableData([note({ id: "x" })], "0.1.5");
    const bytes = new TextEncoder().encode(`\uFEFF${text}`);
    assert.equal((await decodePortableFile(fileFrom(bytes))).notes[0]?.id, "x");
  });

  it("rejects empty and oversized files before reading", async () => {
    let reads = 0;
    const input = {
      size: 0,
      async arrayBuffer(): Promise<ArrayBuffer> {
        reads += 1;
        return new ArrayBuffer(0);
      },
    };
    await assert.rejects(() => decodePortableFile(input), /empty/);
    input.size = MAX_PORTABLE_FILE_BYTES + 1;
    await assert.rejects(() => decodePortableFile(input), /exceeds/);
    assert.equal(reads, 0);
  });

  it("rejects invalid UTF-8", async () => {
    await assert.rejects(() => decodePortableFile(fileFrom(new Uint8Array([0xc3, 0x28]))), /UTF-8/);
  });

  it("distinguishes a file read failure from invalid UTF-8", async () => {
    const cause = new Error("reader failed");
    await assert.rejects(
      () =>
        decodePortableFile({
          size: 1,
          async arrayBuffer(): Promise<ArrayBuffer> {
            throw cause;
          },
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "file-read-failed" &&
        error.cause === cause,
    );
  });

  it("creates a data-free, filesystem-safe UTC filename", () => {
    assert.equal(
      createBackupFilename(new Date("2026-01-02T03:04:05.678Z")),
      "thundernotes-backup-2026-01-02T03-04-05Z.json",
    );
  });
});

describe("backup Downloads Save As", () => {
  function api() {
    const listeners = new Set<(delta: DownloadDelta) => void>();
    const calls: Array<{ url: string; filename: string; saveAs: true }> = [];
    const revoked: string[] = [];
    let blob: Blob;
    let state: DownloadItem = { id: 7, state: "in_progress" };
    const downloads: DownloadsApi = {
      async download(options) { calls.push(options); return 7; },
      async search() { return [state]; },
      onChanged: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
    };
    const urls = { createObjectURL(value: Blob) { blob = value; return "blob:local-backup"; }, revokeObjectURL(url: string) { revoked.push(url); } };
    return { downloads, urls, calls, revoked, listeners, payload: () => blob.text(),
      setState: (item: DownloadItem) => { state = item; },
      emit: (delta: DownloadDelta) => { for (const fn of listeners) fn(delta); } };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  it("uses saveAs, the suggested filename and exact Portable Data payload; waits for completion", async () => {
    const mock = api();
    const payload = encodePortableData([note({ id: "current", content: "latest" })], "0.2.0");
    const name = createBackupFilename(new Date("2026-10-01T10:20:30Z"));
    let settled = false;
    const result = downloadPortableData(payload, name, mock.downloads, mock.urls).then((value) => { settled = true; return value; });
    await tick();
    assert.deepEqual(mock.calls, [{ url: "blob:local-backup", filename: name, saveAs: true }]);
    assert.equal(await mock.payload(), payload);
    assert.equal(settled, false); assert.deepEqual(mock.revoked, []);
    mock.emit({ id: 999, state: { current: "complete" } }); await tick(); assert.equal(settled, false);
    mock.emit({ id: 7, state: { current: "complete" } });
    assert.equal(await result, "complete");
    assert.deepEqual(mock.revoked, ["blob:local-backup"]); assert.equal(mock.listeners.size, 0);
  });
  it("handles completion before download() returns the ID", async () => {
    const mock = api();
    mock.downloads.download = async () => { mock.emit({ id: 7, state: { current: "complete" } }); return 7; };
    assert.equal(await downloadPortableData("{}", "backup.json", mock.downloads, mock.urls), "complete");
    assert.equal(mock.revoked.length, 1);
  });
  it("handles an already complete search result without missing the terminal state", async () => {
    const mock = api(); mock.setState({ id: 7, state: "complete" });
    assert.equal(await downloadPortableData("{}", "backup.json", mock.downloads, mock.urls), "complete");
  });
  for (const reason of ["USER_CANCELED", "Download canceled by the user"]) {
    it(`treats Save As rejection ${reason} as cancellation and cleans up`, async () => {
      const mock = api(); mock.downloads.download = async () => { throw new Error(reason); };
      assert.equal(await downloadPortableData("{}", "backup.json", mock.downloads, mock.urls), "cancelled");
      assert.equal(mock.revoked.length, 1); assert.equal(mock.listeners.size, 0);
    });
  }
  it("recognizes Gecko's structured cancellation rejection", async () => {
    const mock = api(); mock.downloads.download = async () => { throw { message: "Download canceled by the user" }; };
    assert.equal(await downloadPortableData("{}", "backup.json", mock.downloads, mock.urls), "cancelled");
    assert.equal(mock.revoked.length, 1);
  });
  it("distinguishes interrupted cancellation from a file failure", async () => {
    for (const reason of ["USER_CANCELED", "FILE_NO_SPACE"]) {
      const mock = api(); mock.setState({ id: 7, state: "interrupted", error: reason });
      if (reason === "USER_CANCELED") assert.equal(await downloadPortableData("{}", "backup.json", mock.downloads, mock.urls), "cancelled");
      else await assert.rejects(downloadPortableData("{}", "backup.json", mock.downloads, mock.urls), /FILE_NO_SPACE/);
      assert.equal(mock.revoked.length, 1); assert.equal(mock.listeners.size, 0);
    }
  });
  it("queries an interruption reason omitted from the event", async () => {
    const mock = api(); const pending = downloadPortableData("{}", "backup.json", mock.downloads, mock.urls);
    await tick(); mock.setState({ id: 7, state: "interrupted", error: "USER_CANCELED" });
    mock.emit({ id: 7, state: { current: "interrupted" } });
    assert.equal(await pending, "cancelled");
  });
  it("survives failed status search while listening for the terminal event", async () => {
    const mock = api(); mock.downloads.search = async () => { throw new Error("search failed"); };
    const pending = downloadPortableData("{}", "backup.json", mock.downloads, mock.urls);
    await tick(); assert.equal(mock.revoked.length, 0);
    mock.emit({ id: 7, state: { current: "complete" } }); assert.equal(await pending, "complete");
  });
  it("reports startup failure or missing API without false success", async () => {
    const mock = api(); mock.downloads.download = async () => { throw new Error("FILE_FAILED"); };
    await assert.rejects(downloadPortableData("{}", "backup.json", mock.downloads, mock.urls), /FILE_FAILED/);
    assert.equal(mock.revoked.length, 1);
    await assert.rejects(downloadPortableData("{}", "backup.json", undefined, mock.urls), /unavailable/);
  });
});
