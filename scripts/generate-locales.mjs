/**
 * Generates `src/i18n/fallback-messages.ts` from `_locales/xx/messages.json`.
 *
 * The English catalogue is the runtime fallback, so the UI shows English rather
 * than an empty string or a raw technical key when the Thunderbird i18n API
 * cannot resolve a message. It also carries the authoritative placeholder *names*
 * for each key (Thunderbird resolves those away, but the fallback path needs
 * them).
 *
 * The generated file is a build artifact: it is gitignored and always recreated.
 * Adding a language therefore means dropping in `_locales/<locale>/messages.json`
 * — no code change.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, "..");

/** Validate and normalize one `messages.json` file. */
function parseCatalogue(text, source) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${source}: ${error.message}`);
  }

  const catalogue = {};
  for (const [key, entry] of Object.entries(data)) {
    if (entry === null || typeof entry !== "object" || typeof entry.message !== "string") {
      throw new Error(`${source}: entry "${key}" is missing a string "message"`);
    }

    const placeholders = {};
    if (entry.placeholders !== undefined) {
      if (entry.placeholders === null || typeof entry.placeholders !== "object") {
        throw new Error(`${source}: entry "${key}" has a malformed "placeholders" object`);
      }
      for (const [name, definition] of Object.entries(entry.placeholders)) {
        if (definition === null || typeof definition !== "object" || typeof definition.content !== "string") {
          throw new Error(`${source}: placeholder "${name}" of "${key}" is malformed`);
        }
        placeholders[name] = { content: definition.content };
      }
    }

    catalogue[key] =
      Object.keys(placeholders).length > 0 ? { message: entry.message, placeholders } : { message: entry.message };
  }
  return catalogue;
}

/** Read every `_locales/<locale>/messages.json` under `root`. */
export function readLocales(root = projectRoot) {
  const localesDir = join(root, "_locales");
  const locales = {};
  for (const locale of readdirSync(localesDir)) {
    const file = join(localesDir, locale, "messages.json");
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // not a locale directory
    }
    locales[locale] = parseCatalogue(text, `_locales/${locale}/messages.json`);
  }
  return locales;
}

/**
 * Write the generated module. Throws when `default_locale` (English) is absent,
 * or when a non-English locale has unresolved `$PLACEHOLDER$` names.
 */
export function generateFallbackModule(root = projectRoot) {
  const locales = readLocales(root);
  const english = locales.en;
  if (!english) throw new Error("_locales/en/messages.json is required (default_locale)");

  // Validate every translation: no unknown keys, no unknown placeholders, and no
  // placeholder used in the translation that English does not declare.
  const problems = [];
  for (const [locale, catalogue] of Object.entries(locales)) {
    if (locale === "en") continue;
    for (const [key, entry] of Object.entries(catalogue)) {
      const reference = english[key];
      if (!reference) {
        problems.push(`${locale}: unknown key "${key}"`);
        continue;
      }
      const declared = new Set(Object.keys(reference.placeholders ?? {}).map((name) => name.toUpperCase()));
      for (const match of entry.message.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g)) {
        const name = match[1].toUpperCase();
        if (!declared.has(name)) {
          problems.push(`${locale}: "${key}" uses undeclared placeholder $${match[1]}$`);
        }
      }
    }
  }

  // Reject self-referential named placeholders.
  //
  // Thunderbird pre-expands `$NAME$` from the declared `placeholders` block BEFORE
  // it substitutes the caller's arguments, and replaces any `$NAME$` it cannot
  // resolve with the EMPTY STRING. A placeholder declared as
  // `{"count": {"content": "$1"}}` is therefore pure indirection: it rewrites
  // `$COUNT$` into `$1`, and if it is not declared the name form silently vanishes
  // altogether. Both outcomes have caused a real bug (a footer rendering
  // "из заметок" instead of "2 из 5 заметок"), so messages must use plain
  // positional substitutions and must not declare such a block.
  for (const locale of Object.keys(locales)) {
    for (const [key, entry] of Object.entries(locales[locale])) {
      const names = Object.keys(entry.placeholders ?? {});
      if (names.some((name) => /^\$\d+$/.test(entry.placeholders[name].content))) {
        problems.push(
          `${locale}: "${key}" declares a self-referential named placeholder; ` +
            "use plain positional substitutions ($1, $2, ...) and remove the placeholders block"
        );
      }
      // A `$NAME$` in the message that has no matching declaration is replaced
      // with an empty string at runtime, so it can never render.
      const declaredNames = new Set(names.map((name) => name.toUpperCase()));
      for (const match of entry.message.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g)) {
        if (!declaredNames.has(match[1].toUpperCase())) {
          problems.push(
            `${locale}: "${key}" uses $${match[1]}$ with no matching placeholder declaration, ` +
              "which Thunderbird replaces with an empty string"
          );
        }
      }
    }
  }

  const header = `/**
 * GENERATED FILE - do not edit by hand.
 * Produced by scripts/generate-locales.mjs from _locales/LOCALE/messages.json.
 */

export interface MessagePlaceholder {
  content: string;
}

export interface MessageEntry {
  message: string;
  /**
   * Legacy named placeholders. Not supported by this extension: Thunderbird
   * pre-expands \`$NAME$\` from this block before applying the caller's positional
   * substitutions, and replaces an undeclared \`$NAME$\` with an empty string. The
   * catalogue validation therefore rejects any block whose content is \`$1\`/\`$2\`.
   */
  placeholders?: Record<string, MessagePlaceholder>;
}

export type MessageCatalogue = Record<string, MessageEntry>;

/** The English catalogue (the extension's default locale), used as the runtime fallback. */
export const EN_MESSAGES: MessageCatalogue = ${JSON.stringify(english, null, 2)};

/** Locale codes shipped with this build, including the default locale. */
export const BUNDLED_LOCALES: readonly string[] = ${JSON.stringify(Object.keys(locales).sort())};
`;

  const target = join(root, "src", "i18n", "fallback-messages.ts");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, header, "utf8");

  return {
    target,
    keyCount: Object.keys(english).length,
    locales: Object.keys(locales).sort(),
    problems,
  };
}

/**
 * Runnable on its own (`npm run locales`), so a clean tree can be made
 * type-checkable without a full build.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = generateFallbackModule(projectRoot);
  const relativeTarget = result.target.slice(projectRoot.length + 1);
  console.log(`generated ${relativeTarget}: ${result.keyCount} keys, locales ${result.locales.join(", ")}`);
  for (const problem of result.problems) console.warn(`  ! ${problem}`);
  if (result.problems.length > 0) process.exitCode = 1;
}
