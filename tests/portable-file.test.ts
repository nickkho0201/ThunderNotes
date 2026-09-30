import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodePortableData } from "../src/portable/codec.ts";
import { createBackupFilename, decodePortableFile } from "../src/portable/file.ts";
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

  it("creates a data-free, filesystem-safe UTC filename", () => {
    assert.equal(
      createBackupFilename(new Date("2026-01-02T03:04:05.678Z")),
      "thundernotes-backup-2026-01-02T03-04-05Z.json",
    );
  });
});
