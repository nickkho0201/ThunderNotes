/**
 * Bundles `scripts/verify-dist.mjs` into `build/verify-dist.mjs`.
 *
 * The verifier imports the shared TypeScript icon rules, so it cannot be run
 * directly by Node. Bundling keeps a single implementation of those rules for
 * both the verifier and the unit tests.
 */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const outfile = join(projectRoot, "build", "verify-dist.mjs");

mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [join(projectRoot, "scripts", "verify-dist.mjs")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node22"],
  packages: "external",
  logLevel: "warning",
  legalComments: "none",
});

console.log(`  bundled ${outfile.replace(`${projectRoot}\\`, "").replace(`${projectRoot}/`, "")}`);
