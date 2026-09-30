/**
 * Removes build output and the generated locale module.
 *
 * After a clean, `npm run typecheck` and `npm test` regenerate whatever they
 * need (see package.json), so a clean tree is always a working tree.
 */

import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");

const targets = ["dist", "build", "artifacts", join("src", "i18n", "fallback-messages.ts")];

for (const target of targets) {
  rmSync(join(projectRoot, target), { recursive: true, force: true });
}
console.log(`cleaned: ${targets.join(", ")}`);
