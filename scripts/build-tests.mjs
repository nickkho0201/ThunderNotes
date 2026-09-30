/**
 * Builds the test bundles.
 *
 * Tests import the TypeScript sources directly (`.ts` specifiers); esbuild bundles
 * each test file, together with everything it pulls in, into `build/test/` as
 * plain ESM that Node can run. Nothing here needs Thunderbird or a browser.
 *
 * `linkedom` stays external so its CommonJS internals resolve normally at runtime.
 */

import { mkdirSync, rmSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { generateFallbackModule } from "./generate-locales.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const testsDir = join(projectRoot, "tests");
const outDir = join(projectRoot, "build", "test");

generateFallbackModule(projectRoot);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const entryPoints = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => join(testsDir, name));

if (entryPoints.length === 0) throw new Error("no tests/*.test.ts files found");

const result = await build({
  entryPoints,
  outdir: outDir,
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node22"],
  packages: "external",
  sourcemap: "inline",
  logLevel: "warning",
  legalComments: "none",
  metafile: true,
});

let total = 0;
for (const [file, output] of Object.entries(result.metafile.outputs)) {
  total += output.bytes;
  console.log(`  test bundle ${file.replace(`${projectRoot}\\`, "")} (${output.bytes} B)`);
}
console.log(`  ${entryPoints.length} test file(s), ${total} B total`);
