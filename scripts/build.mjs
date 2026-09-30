/**
 * Builds the ThunderNotes extension into `dist/`.
 *
 * Bundles the two entry points (background service worker + space page) and
 * copies every static asset. All third-party code (currently only `marked`) is
 * bundled in — the finished extension performs no network requests at all.
 *
 * Usage:
 *   node scripts/build.mjs           # build dist/
 *   node scripts/build.mjs --xpi     # build dist/ and package the XPI
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { generateFallbackModule } from "./generate-locales.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const distDir = join(projectRoot, "dist");
const artifactsDir = join(projectRoot, "artifacts");

const watch = process.argv.includes("--watch");
const wantXpi = process.argv.includes("--xpi");

/** Static files/directories copied verbatim into `dist/`. */
const STATIC_ENTRIES = [
  ["manifest.json", "manifest.json"],
  ["_locales", "_locales"],
  ["assets", "assets"],
  ["src/ui/notes.html", "notes.html"],
  ["src/ui/notes.css", "ui/notes.css"],
];

function copyStatic() {
  for (const [from, to] of STATIC_ENTRIES) {
    const source = join(projectRoot, from);
    const target = join(distDir, to);
    if (!existsSync(source)) {
      throw new Error(`missing static entry: ${from}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    const stats = statSync(source);
    if (stats.isDirectory()) {
      cpSync(source, target, { recursive: true });
    } else {
      cpSync(source, target);
    }
  }
}

/** Read and sanity-check the manifest before shipping it. */
function validateManifest() {
  const manifestPath = join(distDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const problems = [];
  if (manifest.manifest_version !== 3) problems.push("manifest_version must be 3");
  if (!manifest.default_locale) problems.push("default_locale is required for __MSG_*__ placeholders");
  if (!manifest.browser_specific_settings?.gecko?.id) problems.push("browser_specific_settings.gecko.id is required");
  if (manifest.background?.type !== "module") problems.push('background.type should be "module"');
  if (manifest.spacesToolbar) problems.push("spacesToolbar is deprecated; use the spaces API instead");

  // `__MSG_key__` placeholders must exist in the default locale catalogue.
  const english = JSON.parse(readFileSync(join(distDir, "_locales", "en", "messages.json"), "utf8"));
  const scan = (value) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) {
        if (!(match[1] in english)) problems.push(`manifest references unknown message key "${match[1]}"`);
      }
    } else if (Array.isArray(value)) {
      value.forEach(scan);
    } else if (value !== null && typeof value === "object") {
      Object.values(value).forEach(scan);
    }
  };
  scan(manifest);

  // Every file the manifest points at must exist in dist/.
  const checkFile = (path) => {
    if (typeof path !== "string" || path.length === 0) return;
    if (/^[a-z]+:/i.test(path)) return;
    const resolved = join(distDir, path.replace(/^\//, ""));
    if (!existsSync(resolved)) problems.push(`manifest references missing file "${path}"`);
  };
  for (const icon of Object.values(manifest.icons ?? {})) checkFile(icon);
  for (const script of manifest.background?.scripts ?? []) checkFile(script);
  if (manifest.background?.service_worker) checkFile(manifest.background.service_worker);

  if (problems.length > 0) {
    throw new Error(`manifest validation failed:\n  - ${problems.join("\n  - ")}`);
  }

  return { manifest, warnings: [] };
}

/** Deterministic, zip-format XPI written to `artifacts/`. */
async function writeXpi(version, warnings) {
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });
  const xpiPath = join(artifactsDir, `thundernotes-${version}.xpi`);

  const entries = listFiles(distDir);
  const zip = createZip(entries);
  writeFileSync(xpiPath, zip);

  const size = statSync(xpiPath).size;
  console.log(`  XPI    ${relative(projectRoot, xpiPath)} (${formatBytes(size)}, ${entries.length} files)`);
  for (const warning of warnings) console.warn(`  !      ${warning}`);
  return xpiPath;
}

function listFiles(root, base = root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full, base));
    else files.push({ path: relative(base, full).split("\\").join("/"), full });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ------------------------------------------------------------------- zip (store)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
  const day = (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

/**
 * Build an XPI (a ZIP archive). Stored uncompressed: extension payloads are small
 * and this avoids a compression dependency. Entries are written in a stable
 * order, and `mimetype`-style ordering does not apply to XPI, so alphabetical is
 * fine.
 */
function createZip(entries) {
  const { time, day } = dosDateTime(new Date(2026, 0, 1, 0, 0, 0));
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.path, "utf8");
    const data = readFileSync(entry.full);
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 names
    localHeader.writeUInt16LE(0, 8); // stored
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(day, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(day, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // disk
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + data.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

// ---------------------------------------------------------------------- main

async function main() {
  const locales = generateFallbackModule(projectRoot);
  console.log(`locales: ${locales.locales.join(", ")} (${locales.keyCount} keys)`);
  for (const problem of locales.problems) console.warn(`  ! ${problem}`);

  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  const common = {
    bundle: true,
    format: "esm",
    target: ["firefox128"],
    platform: "browser",
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
    minify: !watch,
    define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  };

  const context = await build({
    ...common,
    entryPoints: {
      "background": join(projectRoot, "src/background/index.ts"),
      "ui/notes": join(projectRoot, "src/ui/notes.ts"),
    },
    outdir: distDir,
    metafile: true,
  });

  copyStatic();

  const { manifest, warnings } = validateManifest();

  let totalBytes = 0;
  for (const [file, output] of Object.entries(context.metafile.outputs)) {
    totalBytes += output.bytes;
    console.log(`  bundle ${relative(projectRoot, file)} (${formatBytes(output.bytes)})`);
  }

  console.log(
    `built ${manifest.name} v${manifest.version} -> ${relative(projectRoot, distDir)} (js ${formatBytes(totalBytes)})`
  );

  if (wantXpi) {
    await writeXpi(manifest.version, warnings);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});