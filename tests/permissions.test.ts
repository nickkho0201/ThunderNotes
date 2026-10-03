import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { permissionFailures } from "../scripts/permission-rules.ts";

describe("approved permission surface", () => {
  it("accepts required alarms/data permissions and optional notifications", () => {
    for (const path of ["manifest.json", "dist/manifest.json"]) {
      assert.deepEqual(permissionFailures(JSON.parse(readFileSync(path, "utf8"))), []);
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      assert.deepEqual(manifest.permissions, ["alarms", "downloads", "messagesRead"]);
      assert.deepEqual(manifest.optional_permissions, ["notifications"]);
    }
  });
  it("rejects missing, extra, duplicate and malformed permissions", () => {
    for (const permissions of [undefined, [], ["downloads"], ["alarms", "downloads", "tabs"], ["alarms", "downloads", "downloads"], ["alarms", "downloads", "messagesRead", "accountsRead"], ["<all_urls>"], "downloads"]) {
      assert.ok(permissionFailures({ permissions, optional_permissions: ["notifications"] }).length > 0);
    }
  });
  it("rejects host, optional and experiment permission expansion", () => {
    for (const key of ["host_permissions", "optional_host_permissions", "experiment_apis"]) {
      assert.ok(permissionFailures({ permissions: ["alarms", "downloads", "messagesRead"], optional_permissions: ["notifications"], [key]: ["extra"] }).length > 0);
    }
    assert.ok(permissionFailures({ permissions: ["alarms", "downloads", "messagesRead"], optional_permissions: ["tabs"] }).length > 0);
  });
});
