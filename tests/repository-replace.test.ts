import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Note } from "../src/notes/model.ts";
import { MemoryNotesRepository } from "../src/storage/memory.ts";
import { note } from "./helpers.ts";

describe("repository atomic dataset replacement", () => {
  it("replaces Memory repository contents exactly", async () => {
    const repository = new MemoryNotesRepository();
    await repository.putMany([note({ id: "old-a" }), note({ id: "old-b" })]);
    await repository.replaceAll([note({ id: "new" })]);
    assert.deepEqual((await repository.getAll()).map((entry) => entry.id), ["new"]);
  });

  it("stages Memory replacement before swapping existing state", async () => {
    const repository = new MemoryNotesRepository();
    await repository.putMany([note({ id: "old" })]);
    const explosive = new Proxy(note({ id: "bad" }), {
      ownKeys(): ArrayLike<string | symbol> {
        throw new Error("copy failed");
      },
    });
    await assert.rejects(() => repository.replaceAll([explosive as Note]), /copy failed/);
    assert.deepEqual((await repository.getAll()).map((entry) => entry.id), ["old"]);
  });
});
