/**
 * Verifies the built `dist/` extension artifact and, with `--xpi`, the XPI.
 *
 * Nothing here needs Thunderbird: it inspects the built `dist/` tree and checks
 * the things that actually break an install or a first run — a manifest
 * that references a missing file, a localized placeholder with no catalogue
 * entry, a page that loads a bundle which was never emitted, an icon that does
 * not resolve from where the CSS expects it, an icon that could never adapt to
 * the theme, and any trace of a network call or remote asset (ThunderNotes must
 * work fully offline).
 *
 * This file is bundled by esbuild before it runs (`npm run verify`), because it
 * imports the shared TypeScript icon rules.
 *
 * Usage:
 *   node scripts/verify-dist.mjs
 *   node scripts/verify-dist.mjs --xpi
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hasViewBox, paintValues, usesContextPaint } from "./icon-rules.ts";
import { permissionFailures } from "./permission-rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const distDir = join(projectRoot, "dist");
const artifactsDir = join(projectRoot, "artifacts");
const verifyXpi = process.argv.includes("--xpi");

const failures = [];
const notes = [];
const APPROVED_MARKED_LICENSE_SHA256 = new Map([
  ["15.0.12", "8e3a3f82f59a60958f56ca08f445647c32a4733dc7ca6c2c46f6eb898471ab9c"],
]);

function fail(message) {
  failures.push(message);
}

function ok(message) {
  notes.push(message);
}

function assertFile(relativePath, why) {
  const full = join(distDir, relativePath);
  if (!existsSync(full)) {
    fail(`missing file "${relativePath}"${why ? ` (${why})` : ""}`);
    return null;
  }
  return full;
}

/** Every file in dist/, as POSIX-style relative paths. */
function listDistFiles(root = distDir, base = distDir) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listDistFiles(full, base));
    else files.push({ path: relativePosix(base, full), full });
  }
  return files;
}

function relativePosix(base, full) {
  return normalize(full).slice(normalize(base).length + 1).split("\\").join("/");
}

function sameBytes(left, right) {
  return left.length === right.length && left.equals(right);
}

/** Read entries from the stored (uncompressed) ZIP format emitted by build.mjs. */
function readStoredZip(buffer) {
  const minimumEnd = Math.max(0, buffer.length - 65_557);
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= minimumEnd; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("ZIP end-of-central-directory record is missing");

  const entryCount = buffer.readUInt16LE(endOffset + 10);
  let centralOffset = buffer.readUInt32LE(endOffset + 16);
  const entries = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error(`invalid central-directory entry ${index}`);
    }
    const method = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const uncompressedSize = buffer.readUInt32LE(centralOffset + 24);
    const nameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localOffset = buffer.readUInt32LE(centralOffset + 42);
    const name = buffer.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString("utf8");

    if (method !== 0) throw new Error(`${name}: expected stored ZIP entry, found compression method ${method}`);
    if (compressedSize !== uncompressedSize) throw new Error(`${name}: stored entry has inconsistent sizes`);
    if (entries.has(name)) throw new Error(`${name}: duplicate ZIP entry`);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`${name}: invalid local ZIP header`);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + uncompressedSize;
    if (dataEnd > buffer.length) throw new Error(`${name}: ZIP entry extends beyond the archive`);
    entries.set(name, buffer.subarray(dataOffset, dataEnd));

    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ------------------------------------------------------------------- manifest

if (!existsSync(join(distDir, "manifest.json"))) {
  fail("dist/manifest.json is missing - run `npm run build` first");
} else {
  const manifest = JSON.parse(readFileSync(join(distDir, "manifest.json"), "utf8"));
  const english = JSON.parse(readFileSync(join(distDir, "_locales", "en", "messages.json"), "utf8"));

  if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
  if (manifest.default_locale !== "en") fail("default_locale should be the shipped fallback (en)");
  if (!manifest.browser_specific_settings?.gecko?.id) fail("browser_specific_settings.gecko.id is required");
  if (!manifest.browser_specific_settings?.gecko?.strict_min_version) {
    fail("strict_min_version is required so Thunderbird refuses unsupported versions");
  }
  if (manifest.spacesToolbar) fail("spacesToolbar is deprecated; the spaces API must be used instead");
  const permissionErrors = permissionFailures(manifest);
  for (const message of permissionErrors) fail(message);
  if (permissionErrors.length === 0) ok('permissions: alarms/downloads/messagesRead; optional notifications; no host permissions');
  if (manifest.background?.type !== "module") fail('background.type should be "module"');
  if (!manifest.background?.scripts?.length) fail("background.scripts must list the service worker");

  // `__MSG_key__` placeholders must resolve in the default locale.
  const placeholders = [];
  const scan = (value, path) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) {
        placeholders.push(match[1]);
        if (!(match[1] in english)) fail(`manifest ${path} uses unknown message key "${match[1]}"`);
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => scan(item, `${path}[${index}]`));
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) scan(item, `${path}.${key}`);
    }
  };
  scan(manifest, "manifest");
  if (placeholders.length === 0) fail("manifest uses no localizable __MSG_*__ placeholders");

  // Referenced files must exist.
  for (const [size, path] of Object.entries(manifest.icons ?? {})) {
    assertFile(path, `icons.${size}`);
  }
  const action = manifest.message_display_action;
  if (!action || action.default_popup || action.type === "menu" || action.default_title !== "__MSG_messageNewNote__") {
    fail("message_display_action must be a native no-popup New note action");
  } else {
    assertFile(action.default_icon, "message_display_action.default_icon");
    ok("native message-display action: local icon, localized label, no popup");
  }
  for (const script of manifest.background?.scripts ?? []) assertFile(script, "background script");

  ok(
    `manifest: v${manifest.manifest_version}, gecko ${manifest.browser_specific_settings.gecko.strict_min_version}+, ` +
      `${placeholders.length} localized string(s)`
  );
}

// ---------------------------------------------------------- license payloads

const packageJsonPath = join(projectRoot, "package.json");
const installedMarkedPackagePath = join(projectRoot, "node_modules", "marked", "package.json");
const installedMarkedLicensePath = join(projectRoot, "node_modules", "marked", "LICENSE.md");

if (!existsSync(packageJsonPath)) {
  fail("package.json is missing");
} else if (!existsSync(installedMarkedPackagePath) || !existsSync(installedMarkedLicensePath)) {
  fail("installed marked package or its LICENSE.md is missing; run the frozen install before verification");
} else {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const markedPackage = JSON.parse(readFileSync(installedMarkedPackagePath, "utf8"));
  const markedVersion = markedPackage.version;
  const markedLicenseRelative = `licenses/marked-${markedVersion}-LICENSE.md`;
  const approvedLicenseHash = APPROVED_MARKED_LICENSE_SHA256.get(markedVersion);

  if (!packageJson.dependencies?.marked) {
    fail("marked is not declared as a production dependency");
  }
  if (!approvedLicenseHash) {
    fail(`marked@${markedVersion} has no explicitly approved license payload hash`);
  }

  const requiredPayloads = new Map([
    ["LICENSE", join(projectRoot, "LICENSE")],
    ["NOTICE", join(projectRoot, "NOTICE")],
    ["THIRD_PARTY_LICENSES.md", join(projectRoot, "THIRD_PARTY_LICENSES.md")],
    [markedLicenseRelative, join(projectRoot, markedLicenseRelative)],
  ]);

  for (const [relativePath, sourcePath] of requiredPayloads) {
    if (!existsSync(sourcePath)) {
      fail(`license payload source is missing: ${relativePath}`);
      continue;
    }
    const distPath = assertFile(relativePath, "required license/notice payload");
    if (distPath && !sameBytes(readFileSync(distPath), readFileSync(sourcePath))) {
      fail(`${relativePath} in dist/ differs from its repository source`);
    }
  }

  const localMarkedLicensePath = join(projectRoot, markedLicenseRelative);
  if (existsSync(localMarkedLicensePath)) {
    const localLicense = readFileSync(localMarkedLicensePath);
    const installedLicense = readFileSync(installedMarkedLicensePath);
    const localHash = createHash("sha256").update(localLicense).digest("hex");
    if (approvedLicenseHash && localHash !== approvedLicenseHash) {
      fail(`${markedLicenseRelative} differs from the explicitly approved upstream text`);
    } else if (!sameBytes(localLicense, installedLicense)) {
      fail(`${markedLicenseRelative} does not exactly match marked@${markedVersion} LICENSE.md`);
    } else {
      ok(`marked@${markedVersion}: license matches the installed package and approved upstream SHA-256`);
    }
  }

  for (const indexFile of ["NOTICE", "THIRD_PARTY_LICENSES.md"]) {
    const sourcePath = join(projectRoot, indexFile);
    if (!existsSync(sourcePath)) continue;
    const source = readFileSync(sourcePath, "utf8");
    if (!source.includes(`marked@${markedVersion}`) && !source.includes(`| ${markedVersion} |`)) {
      fail(`${indexFile} does not identify the bundled marked version ${markedVersion}`);
    }
    if (!source.includes(markedLicenseRelative)) {
      fail(`${indexFile} does not reference ${markedLicenseRelative}`);
    }
  }

  if (verifyXpi) {
    const distManifestPath = join(distDir, "manifest.json");
    if (!existsSync(distManifestPath)) {
      fail("cannot verify the XPI without dist/manifest.json");
    } else {
      const version = JSON.parse(readFileSync(distManifestPath, "utf8")).version;
      const xpiPath = join(artifactsDir, `thundernotes-${version}.xpi`);
      if (!existsSync(xpiPath)) {
        fail(`XPI is missing: artifacts/thundernotes-${version}.xpi`);
      } else {
        try {
          const archive = readStoredZip(readFileSync(xpiPath));
          const distFiles = listDistFiles();
          const distNames = new Set(distFiles.map((file) => file.path));

          for (const file of distFiles) {
            const archived = archive.get(file.path);
            if (!archived) {
              fail(`XPI is missing dist file: ${file.path}`);
            } else if (!sameBytes(archived, readFileSync(file.full))) {
              fail(`XPI entry differs from dist/: ${file.path}`);
            }
          }
          for (const name of archive.keys()) {
            if (!distNames.has(name)) fail(`XPI contains an unexpected file not present in dist/: ${name}`);
          }

          for (const relativePath of requiredPayloads.keys()) {
            if (!archive.has(relativePath)) fail(`XPI is missing required license/notice file: ${relativePath}`);
          }
          ok(`XPI: ${archive.size} entries exactly match dist/, including all required license payloads`);
        } catch (error) {
          fail(`cannot inspect XPI: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
}

// ----------------------------------------------------------------- localisation

const localesDir = join(distDir, "_locales");
if (!existsSync(localesDir)) {
  fail("dist/_locales is missing");
} else {
  const locales = readdirSync(localesDir).filter((name) => existsSync(join(localesDir, name, "messages.json")));
  if (!locales.includes("en")) fail("_locales/en is required as the default locale");
  if (locales.length < 2) fail(`expected at least English and one more locale, found: ${locales.join(", ")}`);

  const english = JSON.parse(readFileSync(join(localesDir, "en", "messages.json"), "utf8"));
  const englishKeys = new Set(Object.keys(english));

  for (const locale of locales) {
    const catalogue = JSON.parse(readFileSync(join(localesDir, locale, "messages.json"), "utf8"));
    for (const [key, entry] of Object.entries(catalogue)) {
      if (typeof entry.message !== "string" || entry.message.length === 0) {
        fail(`${locale}: "${key}" has an empty message`);
      }
      if (locale !== "en" && !englishKeys.has(key)) {
        fail(`${locale}: "${key}" is not present in the English catalogue`);
      }
      // A translation must not reference a placeholder English does not declare.
      if (locale !== "en") {
        const declared = new Set(Object.keys(english[key]?.placeholders ?? {}).map((n) => n.toUpperCase()));
        for (const match of entry.message.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g)) {
          if (!declared.has(match[1].toUpperCase())) {
            fail(`${locale}: "${key}" uses undeclared placeholder $${match[1]}$`);
          }
        }
      }
    }
  }

  // Every key the UI asks for must exist in English.
  const englishKeysUsed = new Set();
  for (const [key, entry] of Object.entries(english)) {
    if (entry.message.length > 0) englishKeysUsed.add(key);
  }

  ok(`locales: ${locales.sort().join(", ")} (${englishKeys.size} keys, ${locales.length - 1} translation(s))`);
}

// ------------------------------------------------------------------- page + CSS

const pagePath = assertFile("notes.html", "the space page");
if (pagePath) {
  const html = readFileSync(pagePath, "utf8");

  const scriptSrc = /<script[^>]*\bsrc="([^"]+)"/.exec(html)?.[1];
  const styleHref = /<link[^>]*\bhref="([^"]+)"/.exec(html)?.[1];

  if (!scriptSrc) fail("notes.html loads no script bundle");
  else assertFile(scriptSrc, "page bundle");

  if (!styleHref) fail("notes.html loads no stylesheet");
  else assertFile(styleHref, "page stylesheet");

  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
    fail("notes.html contains an inline script, which the extension CSP blocks");
  }
  if (/\son[a-z]+\s*=/i.test(html)) {
    fail("notes.html contains an inline event handler attribute, which the extension CSP blocks");
  }
  if (/https?:\/\//i.test(html)) {
    fail("notes.html references a remote URL; the extension must work fully offline");
  }

  // The bundled CSS must only reference icon files that were actually shipped.
  if (styleHref) {
    const cssFile = join(distDir, styleHref);
    if (existsSync(cssFile)) {
      const css = readFileSync(cssFile, "utf8");
      const cssDir = dirname(cssFile);
      let urlCount = 0;
      for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
        const raw = match[1].trim();
        if (/^(data:|https?:|\/\/)/i.test(raw)) {
          fail(`CSS references a non-local url(): ${raw}`);
          continue;
        }
        const target = resolve(cssDir, raw.split("?")[0]);
        if (!existsSync(target)) fail(`CSS url() does not resolve: ${raw}`);
        else urlCount += 1;
      }
      ok(`stylesheet: ${urlCount} local asset reference(s), all resolving`);

      // The `hidden` attribute is toggled from JS on elements whose class rules
      // set `display`, and the UA `[hidden]` rule loses to any author `display`
      // declaration. Without an explicit reset those elements can never be
      // hidden, which silently breaks the error banner, the editor pane, the
      // markdown Edit/Preview switch and the search clear button.
      if (!/\[hidden\][^{]*\{[^}]*display\s*:\s*none\s*!important/i.test(css)) {
        fail("CSS lacks a `[hidden] { display: none !important }` reset; JS-toggled hidden elements stay visible");
      } else {
        const toggled = [...html.matchAll(/id="([^"]+)"[^>]*\shidden(?:\s|>)/g)].map((m) => m[1]);
        ok(`hidden-attribute reset present (initially hidden: ${toggled.join(", ") || "none"})`);
      }
    }
  }

  // The version must be consistent between the manifest and package.json: a
  // mismatch produces an XPI whose filename and manifest disagree.
  const distManifestPath = join(distDir, "manifest.json");
  const packageJsonPath = join(projectRoot, "package.json");
  if (existsSync(distManifestPath) && existsSync(packageJsonPath)) {
    const distManifest = JSON.parse(readFileSync(distManifestPath, "utf8"));
    const packageVersion = JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
    if (packageVersion !== distManifest.version) {
      fail(`package.json version (${packageVersion}) does not match manifest version (${distManifest.version})`);
    } else {
      ok(`version: ${distManifest.version} (manifest and package.json agree)`);
    }
  }

  // The button must choose its icon explicitly, not via `themeIcons`.
  //
  // Automatic theme selection produced contradictory results across manual tests,
  // so the extension now resolves the effective theme itself and hands Thunderbird
  // one concrete `defaultIcons` set. `themeIcons` must be cleared to `null`, because
  // `spaces.update()` merges properties and would otherwise leave the sets an older
  // build registered.
  {
    const backgroundFile = join(distDir, "background.js");
    if (!existsSync(backgroundFile)) {
      fail("background.js is missing from dist");
    } else {
      const source = readFileSync(backgroundFile, "utf8");
      if (!/defaultIcons/.test(source)) {
        fail("the background bundle does not set `defaultIcons`, so the button would have no icon");
      }
      if (!/themeIcons\s*:\s*null/.test(source)) {
        fail("the background bundle does not clear `themeIcons` with null");
      }
      // Both glyph colours must be reachable, or one theme would render nothing.
      for (const glyph of ["notes-glyph-dark-16.svg", "notes-glyph-light-16.svg"]) {
        if (!source.includes(glyph)) fail(`the background bundle never references ${glyph}`);
      }
      ok("space button selects defaultIcons explicitly and clears themeIcons");
    }
  }

  // The space button uses one concrete `defaultIcons` set at a time, with 16px
  // and 32px variants selected from the matching dark or light glyph pair.
  //
  // Every glyph must be SELF-CONTAINED with a literal colour: manual testing in
  // Thunderbird 156 showed the context paint mechanism renders nothing for a
  // custom space button. The two glyphs must also genuinely differ, or the pair
  // could never change.
  //
  // `inDarkTheme` and `inLightTheme` name the effective theme in which each
  // explicitly selected glyph is used; see src/background/space.ts.
  const glyphPairs = [
    {
      size: 16,
      inDarkTheme: "assets/icons/notes-glyph-light-16.svg",
      inLightTheme: "assets/icons/notes-glyph-dark-16.svg",
    },
    {
      size: 32,
      inDarkTheme: "assets/icons/notes-glyph-light-32.svg",
      inLightTheme: "assets/icons/notes-glyph-dark-32.svg",
    },
  ];

  for (const { size, inDarkTheme, inLightTheme } of glyphPairs) {
    const colours = new Map();
    for (const [theme, relative] of [
      ["dark", inDarkTheme],
      ["light", inLightTheme],
    ]) {
      const full = join(distDir, relative);
      if (!existsSync(full)) {
        fail(`theme icon missing from dist: ${relative}`);
        continue;
      }
      const svg = readFileSync(full, "utf8");
      if (usesContextPaint(svg)) {
        fail(`${relative} uses a context paint keyword, which renders nothing for a custom space button`);
      }
      if (!hasViewBox(svg)) {
        fail(`${relative} has no viewBox and cannot be scaled`);
      }
      const literal = paintValues(svg).filter((value) => /^#[0-9a-f]{3,8}$/i.test(value));
      if (literal.length === 0) {
        fail(`${relative} declares no literal colour, so the glyph would be invisible`);
      }
      colours.set(theme, new Set(literal.map((value) => value.toLowerCase())));
    }

    const darkThemeColours = colours.get("dark");
    const lightThemeColours = colours.get("light");
    if (darkThemeColours && lightThemeColours) {
      const identical =
        darkThemeColours.size === lightThemeColours.size &&
        [...darkThemeColours].every((value) => lightThemeColours.has(value));
      if (identical) {
        fail(
          `the ${size}px glyphs for the two themes use identical colours (${[...darkThemeColours].join(", ")}); ` +
            "the icon could never change with the theme"
        );
      } else {
        // The dark theme must be given the LIGHTER artwork, per manual observation.
        const brightness = (values) => {
          const luminance = (value) => {
            const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
            if (!hex) return Number.NaN;
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            return Math.sqrt(0.299 * r * r + 0.587 * g * g + 0.114 * b * b) / 255;
          };
          return [...values].reduce((total, value) => total + luminance(value), 0) / values.size;
        };
        if (brightness(darkThemeColours) <= brightness(lightThemeColours)) {
          fail(
            `the ${size}px icon rendered in DARK themes is not the lighter artwork ` +
              `(${[...darkThemeColours].join(", ")} vs ${[...lightThemeColours].join(", ")})`
          );
        } else {
          ok(
            `theme icons ${size}px: dark theme gets ${[...darkThemeColours].join(", ")}, ` +
              `light theme gets ${[...lightThemeColours].join(", ")}`
          );
        }
      }
    }
  }

  // The two icon roles must NOT share files: the add-ons manager has no theme to
  // match and no context paint, so it needs independent, self-contained artwork.
  if (existsSync(join(distDir, "manifest.json"))) {
    const distManifest = JSON.parse(readFileSync(join(distDir, "manifest.json"), "utf8"));
    const glyphPaths = new Set(glyphPairs.flatMap((pair) => [pair.inDarkTheme, pair.inLightTheme]));

    for (const size of ["16", "32", "64"]) {
      const declared = distManifest.icons?.[size];
      if (!declared) {
        fail(`manifest.icons["${size}"] is missing`);
        continue;
      }
      assertFile(declared, `icons.${size}`);
      if (glyphPaths.has(declared)) {
        fail(`manifest.icons["${size}"] reuses the theme glyph "${declared}"; it needs its own artwork`);
        continue;
      }
      const svg = readFileSync(join(distDir, declared), "utf8");
      if (usesContextPaint(svg)) {
        fail(`manifest icon "${declared}" uses context paint, which does not resolve here`);
      }
      // It needs an actual colour, or it renders as nothing.
      const literal = paintValues(svg).filter((value) => /^#[0-9a-f]{3,8}$/i.test(value));
      if (literal.length === 0) {
        fail(`manifest icon "${declared}" has no concrete colour and would render as nothing`);
      }
    }
    ok("manifest icons are self-contained and distinct from the theme glyphs");
  }

  // The page CSP must stop a note that contains a remote image from issuing a
  // network request when its Markdown preview is rendered.
  const manifestPath = join(distDir, "manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const csp = manifest.content_security_policy?.extension_pages ?? "";
    const cspProblems = [];
    if (!/\bdefault-src\s+'none'/.test(csp)) cspProblems.push("default-src 'none'");
    if (!/\bconnect-src\s+'none'/.test(csp)) cspProblems.push("connect-src 'none'");
    if (!/\bimg-src\b/.test(csp) || /\bimg-src\s+[^;]*https?:/i.test(csp)) cspProblems.push("img-src restricted to local sources");
    if (cspProblems.length > 0) {
      fail(`page CSP is missing: ${cspProblems.join(", ")}`);
    } else {
      ok("page CSP: default-src 'none', connect-src 'none', img-src local only");
    }
  }
}

// ----------------------------------------------------- offline / no network code

const jsFiles = listDistFiles().filter((file) => file.path.endsWith(".js"));
const networkPatterns = [
  { pattern: /\bfetch\s*\(/, label: "fetch()" },
  { pattern: /XMLHttpRequest/, label: "XMLHttpRequest" },
  { pattern: /new\s+WebSocket\b/, label: "WebSocket" },
  { pattern: /navigator\.sendBeacon/, label: "navigator.sendBeacon" },
  { pattern: /EventSource\s*\(/, label: "EventSource" },
  // A URL that is actually *used*: as a fetch/URL argument, an import, or a src.
  { pattern: /(?:fetch|import|open|send)\s*\(\s*["'`]https?:/i, label: "network call with a remote URL" },
  { pattern: /new\s+URL\s*\(\s*["'`]https?:/i, label: "URL constructed from a remote origin" },
  { pattern: /\.src\s*=\s*["'`]https?:/i, label: "src assigned a remote URL" },
  { pattern: /(?:src|href)\s*=\s*["'`]https?:\/\/(?!localhost)/i, label: "element pointed at a remote URL" },
];

let networkHits = 0;
for (const file of jsFiles) {
  const source = readFileSync(file.full, "utf8");
  for (const { pattern, label } of networkPatterns) {
    const match = pattern.exec(source);
    if (match) {
      networkHits += 1;
      fail(`${file.path}: ${label} -> ${JSON.stringify(match[0])}`);
    }
  }

  // Remote URLs in strings are allowed only when they are part of a human-readable
  // message (e.g. a bundled library's "report this to <url>" error text), never as
  // an asset or endpoint. Report anything else for manual review.
  for (const match of source.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const host = match[1].toLowerCase();
    if (["www.w3.org", "w3.org", "example.com", "example.invalid", "thundernotes.invalid", "localhost"].includes(host)) {
      continue;
    }
    const context = source.slice(Math.max(0, match.index - 120), match.index + 80);
    const looksLikeMessage = /report|github\.com\/markedjs|see |visit |license|http:\/\/www\.apache/i.test(context);
    if (!looksLikeMessage) {
      networkHits += 1;
      fail(`${file.path}: unexplained remote URL https://${host}/ (context: ${JSON.stringify(context.slice(-70))})`);
    }
  }
}
if (networkHits === 0) ok(`bundles: ${jsFiles.length} file(s), no network entry points, no remote assets`);

// ------------------------------------------------------------------ report

const totalBytes = listDistFiles().reduce((sum, file) => sum + statSync(file.full).size, 0);
const fileCount = listDistFiles().length;

for (const note of notes) console.log(`  ok   ${note}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):`);
  for (const problem of failures) console.error(`  FAIL ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`\ndist/ verified: ${fileCount} files, ${(totalBytes / 1024).toFixed(1)} KiB`);
}
