import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { permissionFailures } from "../scripts/permission-rules.ts";

describe("approved permission surface", () => {
  it("accepts exactly downloads and messagesRead in source and built manifests", () => {
    for (const path of ["manifest.json", "dist/manifest.json"]) {
      assert.deepEqual(permissionFailures(JSON.parse(readFileSync(path, "utf8"))), []);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).permissions, ["downloads", "messagesRead"]);
    }
  });
  it("rejects missing, extra, duplicate and malformed permissions", () => {
    for (const permissions of [undefined, [], ["downloads"], ["downloads", "tabs"], ["downloads", "downloads"], ["downloads", "messagesRead", "accountsRead"], ["<all_urls>"], "downloads"]) {
      assert.ok(permissionFailures({ permissions }).length > 0);
    }
  });
  it("rejects host, optional and experiment permission expansion", () => {
    for (const key of ["host_permissions", "optional_host_permissions", "optional_permissions", "experiment_apis"]) {
      assert.ok(permissionFailures({ permissions: ["downloads", "messagesRead"], [key]: ["extra"] }).length > 0);
    }
  });
});
