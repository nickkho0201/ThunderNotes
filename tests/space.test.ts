/**
 * Space button registration.
 *
 * The toolbar icon is the one part of the extension that cannot be unit-tested in
 * a browser, so these tests pin the application-level contract instead: glyph
 * mapping, page-to-worker synchronization, worker restart fallback, update order,
 * file presence, and artwork that genuinely differs in colour.
 *
 * The API being targeted (Thunderbird 156, `spaces` MV3 docs):
 *
 *   ThemeIcons
 *     dark  (ExtensionURL)  "The dark icon to use for light themes"
 *     light (ExtensionURL)  "A light icon to use for dark themes"
 *     size  (integer)
 *   SpaceButtonProperties.themeIcons — "At least the set for 16px icons should be
 *   specified. The set for 32px icons will be used on screens with a very high
 *   pixel density, if specified."
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  SPACE_ICONS,
  SPACE_NAME,
  SPACE_PAGE,
  buildButtonProperties,
  iconsForMode,
} from "../src/background/space.ts";
import { SpaceThemeSync } from "../src/background/theme-sync.ts";
import type { ThunderbirdBrowser } from "../src/api/browser.ts";
import {
  createThemeChangedMessage,
  synchronizeResolvedTheme,
  themeModeFromMessage,
} from "../src/theme/message.ts";
import type { ThemeMode, ThemeState } from "../src/theme/detect.ts";
import {
  findNonLiteralPaint,
  firstStrokeWidth,
  hasViewBox,
  normalizePathData,
  paintValues,
  pathData,
  usesContextPaint,
} from "../scripts/icon-rules.ts";

/** Locate the project root by walking up from the test bundle's cwd. */
function findRoot(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(directory, "manifest.json")) && existsSync(join(directory, "src", "background", "space.ts"))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`could not locate the project root from ${process.cwd()}`);
}

const PROJECT_ROOT = findRoot();

function readProjectFile(relativePath: string): string {
  return readFileSync(join(PROJECT_ROOT, relativePath), "utf8");
}

describe("space: identifiers", () => {
  it("uses a space name Thunderbird accepts", () => {
    // The schema enforces ^[a-zA-Z0-9_]+$ and per-extension uniqueness.
    assert.match(SPACE_NAME, /^[a-zA-Z0-9_]+$/);
    // A technical identifier, never a localized string.
    assert.equal(SPACE_NAME, "thundernotes");
  });

  it("opens the extension's own page, not a remote URL", () => {
    assert.equal(SPACE_PAGE, "notes.html");
    assert.ok(!/^[a-z]+:/i.test(SPACE_PAGE), "the space URL must be relative to the extension");
  });
});

describe("space: button properties", () => {
  const restoreStack: (() => void)[] = [];

  /** Install a fake `browser.theme` reporting the given colour scheme. */
  function withTheme(colorScheme: string | undefined): void {
    const previous = globalThis.browser;
    restoreStack.push(() => {
      globalThis.browser = previous;
    });
    globalThis.browser = {
      i18n: { getMessage: () => "", getUILanguage: () => "en-US" },
      runtime: { getURL: (path: string) => `moz-extension://fake/${path}` },
      theme: {
        getCurrent: async () => (colorScheme === undefined ? {} : { properties: { color_scheme: colorScheme } }),
        onUpdated: { addListener() {}, removeListener() {}, hasListener: () => false },
      },
    } as unknown as ThunderbirdBrowser;
  }

  after(() => {
    while (restoreStack.length > 0) restoreStack.pop()!();
  });

  it("titles the button with the localized extension name", async () => {
    withTheme("light");
    assert.equal((await buildButtonProperties()).title, "ThunderNotes");
  });

  it("does NOT use themeIcons, and explicitly clears it", async () => {
    // Automatic selection was manually demonstrated to produce contradictory
    // results, so the extension decides instead. `null` is the documented reset
    // value and is what clears the sets registered by older builds, because
    // `spaces.update()` merges properties.
    withTheme("light");
    const properties = await buildButtonProperties();
    assert.ok("themeIcons" in properties, "themeIcons must be present, if only to clear it");
    assert.equal(properties.themeIcons, null);
  });

  it("selects the dark glyph in the light theme", async () => {
    withTheme("light");
    const { defaultIcons } = await buildButtonProperties();
    assert.deepEqual(defaultIcons, {
      16: "assets/icons/notes-glyph-dark-16.svg",
      32: "assets/icons/notes-glyph-dark-32.svg",
    });
  });

  it("selects the light glyph in the dark theme", async () => {
    withTheme("dark");
    const { defaultIcons } = await buildButtonProperties();
    assert.deepEqual(defaultIcons, {
      16: "assets/icons/notes-glyph-light-16.svg",
      32: "assets/icons/notes-glyph-light-32.svg",
    });
  });

  it("satisfies the acceptance criterion for both themes", async () => {
    // Light theme -> dark glyph. Dark theme -> light glyph. Stated as the plain
    // requirement so the selection cannot be inverted without failing here.
    for (const [scheme, expected] of [
      ["light", /notes-glyph-dark-/],
      ["dark", /notes-glyph-light-/],
    ] as const) {
      withTheme(scheme);
      const icons = (await buildButtonProperties()).defaultIcons as Record<string, string>;
      for (const size of ["16", "32"]) {
        assert.match(icons[size]!, expected, `${scheme} theme, ${size}px`);
      }
    }
  });

  it("declares exactly the sizes the button can request", async () => {
    withTheme("light");
    const { defaultIcons } = await buildButtonProperties();
    // 16px is the documented mandatory size; 32px is used on high-density screens.
    assert.deepEqual(Object.keys(defaultIcons as Record<string, string>).sort(), ["16", "32"]);
  });

  it("uses only relative paths for the icons", async () => {
    withTheme("dark");
    const { defaultIcons } = await buildButtonProperties();
    for (const [size, path] of Object.entries(defaultIcons as Record<string, string>)) {
      assert.ok(path.length > 0, `${size}: empty path`);
      assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(path), `${size}: must be relative, got ${path}`);
      assert.ok(!path.startsWith("/"), `${size}: must not be absolute, got ${path}`);
    }
  });

  it("points every declared icon at a file that exists", async () => {
    for (const scheme of ["light", "dark"]) {
      withTheme(scheme);
      const icons = (await buildButtonProperties()).defaultIcons as Record<string, string>;
      for (const path of Object.values(icons)) {
        assert.ok(existsSync(join(PROJECT_ROOT, path)), `declared icon does not exist: ${path}`);
      }
    }
  });

  it("has a deterministic worker fallback for an unresolved auto/system theme", async () => {
    // `color_scheme: "auto"` gives no decision, so a DOM-less direct caller falls
    // through to Light. The coordinator normally replaces this with the page's
    // resolved or previously stored mode.
    withTheme("auto");
    const icons = (await buildButtonProperties()).defaultIcons as Record<string, string>;
    assert.equal(icons["16"], "assets/icons/notes-glyph-dark-16.svg");
  });

  it("uses the shared detector when the theme API gives a decisive mode", async () => {
    const { detectTheme } = await import("../src/theme/detect.ts");
    for (const scheme of ["light", "dark"] as const) {
      withTheme(scheme);
      const mode = await detectTheme();
      assert.equal(mode, scheme, `detectTheme should report ${scheme}`);

      const icons = (await buildButtonProperties()).defaultIcons as Record<string, string>;
      const expectedGlyph = mode === "dark" ? "light" : "dark";
      assert.match(icons["16"]!, new RegExp(`notes-glyph-${expectedGlyph}-`));
    }
  });

  it("uses the four shipped glyph files", () => {
    assert.deepEqual(
      Object.values(SPACE_ICONS).sort(),
      [
        "assets/icons/notes-glyph-dark-16.svg",
        "assets/icons/notes-glyph-dark-32.svg",
        "assets/icons/notes-glyph-light-16.svg",
        "assets/icons/notes-glyph-light-32.svg",
      ]
    );
  });
});

describe("space: resolved theme synchronization", () => {
  function icon16(mode: ThemeMode): string {
    return iconsForMode(mode)["16"]!;
  }

  it("carries the page-resolved mode in the runtime message", () => {
    const message = createThemeChangedMessage("dark");
    assert.deepEqual(message, { type: "thundernotes:theme-changed", mode: "dark" });
    assert.equal(themeModeFromMessage(message), "dark");
    assert.equal(themeModeFromMessage({ type: message.type }), null);
    assert.equal(themeModeFromMessage({ type: message.type, mode: "system" }), null);
  });

  it("sends the page's initial mode and every later resolved change", () => {
    let listener: ((state: ThemeState) => void) | null = null;
    const messages: unknown[] = [];
    const unsubscribe = synchronizeResolvedTheme(
      {
        state: { mode: "dark", source: "media" },
        onModeChange(next) {
          listener = next;
          return () => {
            listener = null;
          };
        },
      },
      (message) => messages.push(message)
    );

    assert.deepEqual(messages, [createThemeChangedMessage("dark")]);
    assert.ok(listener);
    (listener as (state: ThemeState) => void)({ mode: "light", source: "media" });
    assert.deepEqual(messages, [createThemeChangedMessage("dark"), createThemeChangedMessage("light")]);
    unsubscribe();
    assert.equal(listener, null);
  });

  it("uses the page's dark mode when the DOM-less worker defaults to light", async () => {
    let stored: ThemeMode | null = null;
    const operations: Array<{ kind: "register" | "apply"; mode: ThemeMode; icon: string }> = [];
    const dependencies = {
      detect: async (): Promise<ThemeState> => ({ mode: "light", source: "default" }),
      load: async () => stored,
      save: async (mode: ThemeMode) => {
        stored = mode;
      },
      register: async (mode: ThemeMode) => {
        operations.push({ kind: "register", mode, icon: icon16(mode) });
      },
      apply: async (mode: ThemeMode) => {
        operations.push({ kind: "apply", mode, icon: icon16(mode) });
      },
    };

    const firstWorker = new SpaceThemeSync(dependencies);
    await firstWorker.boot();
    await firstWorker.pageResolved(themeModeFromMessage(createThemeChangedMessage("dark"))!);

    assert.deepEqual(operations, [
      { kind: "register", mode: "light", icon: SPACE_ICONS.dark16 },
      { kind: "apply", mode: "dark", icon: SPACE_ICONS.light16 },
    ]);
    assert.equal(stored, "dark");

    operations.length = 0;
    const restartedWorker = new SpaceThemeSync(dependencies);
    await restartedWorker.boot();
    assert.deepEqual(operations, [
      { kind: "register", mode: "dark", icon: SPACE_ICONS.light16 },
    ]);
  });

  it("does not let an in-flight worker fallback overwrite a newer page mode", async () => {
    let finishDetection!: (state: ThemeState) => void;
    const detection = new Promise<ThemeState>((resolve) => {
      finishDetection = resolve;
    });
    const operations: Array<{ kind: "register" | "apply"; mode: ThemeMode }> = [];
    const sync = new SpaceThemeSync({
      detect: () => detection,
      load: async () => null,
      save: async () => {},
      register: async (mode) => {
        operations.push({ kind: "register", mode });
      },
      apply: async (mode) => {
        operations.push({ kind: "apply", mode });
      },
    });

    const boot = sync.boot();
    const pageUpdate = sync.pageResolved("dark");
    finishDetection({ mode: "light", source: "default" });
    await Promise.all([boot, pageUpdate]);

    assert.deepEqual(operations, [
      { kind: "register", mode: "dark" },
      { kind: "apply", mode: "dark" },
    ]);
  });

  it("keeps the page-resolved mode for an ambiguous auto-theme event", async () => {
    const applied: ThemeMode[] = [];
    const sync = new SpaceThemeSync({
      detect: async (): Promise<ThemeState> => ({ mode: "light", source: "default" }),
      load: async () => null,
      save: async () => {},
      register: async () => {},
      apply: async (mode) => {
        applied.push(mode);
      },
    });

    await sync.pageResolved("dark");
    await sync.themeUpdated({ properties: { color_scheme: "auto" } });
    assert.deepEqual(applied, ["dark", "dark"]);
  });

  it("lets a decisive Thunderbird theme event replace an older page mode", async () => {
    const applied: ThemeMode[] = [];
    const sync = new SpaceThemeSync({
      detect: async (): Promise<ThemeState> => ({ mode: "dark", source: "color_scheme" }),
      load: async () => null,
      save: async () => {},
      register: async () => {},
      apply: async (mode) => {
        applied.push(mode);
      },
    });

    await sync.pageResolved("dark");
    await sync.themeUpdated({ properties: { color_scheme: "light" } });
    assert.deepEqual(applied, ["dark", "light"]);
  });
});

describe("space: icon rules (the shared detector)", () => {
  // These rules decide whether an icon ships, so they are tested directly: a
  // detector that cannot fail would let a broken icon through.
  it("flags concrete colours as concrete", () => {
    for (const svg of [
      '<path stroke="#15141a"/>',
      '<path fill="black"/>',
      '<path stroke="rgb(1,2,3)"/>',
      '<path style="stroke:#f00"/>',
      '<path fill="rebeccapurple"/>',
    ]) {
      assert.ok(findNonLiteralPaint(svg).length > 0, `should have flagged: ${svg}`);
    }
  });

  it("does not flag paint that carries no colour of its own", () => {
    for (const svg of ['<path fill="none"/>', '<path stroke="currentColor"/>', '<path fill="transparent"/>']) {
      assert.deepEqual(findNonLiteralPaint(svg), [], `should not have flagged: ${svg}`);
    }
  });

  it("detects the context paint keywords", () => {
    for (const svg of [
      '<path stroke="context-stroke"/>',
      '<path fill="context-fill"/>',
      '<path stroke-width="1" stroke="context-stroke"/>',
    ]) {
      assert.equal(usesContextPaint(svg), true, `should have detected: ${svg}`);
    }
    assert.equal(usesContextPaint('<path stroke="#000"/>'), false);
  });

  it("ignores paint mentioned inside an XML comment", () => {
    // The artwork documents the mechanism, so its comments mention colours.
    assert.deepEqual(paintValues('<!-- fill: red would be wrong --><path stroke="#15141a"/>'), ["#15141a"]);
    assert.equal(usesContextPaint('<!-- context-stroke does not work --><path stroke="#000"/>'), false);
  });

  it("detects a missing viewBox", () => {
    assert.equal(hasViewBox('<svg viewBox="0 0 16 16"/>'), true);
    assert.equal(hasViewBox("<svg/>"), false);
  });

  it("normalises path data by canvas size", () => {
    assert.equal(normalizePathData("M 8 8 L 16 16", 16), "M 0.5000 0.5000 L 1.0000 1.0000");
    assert.equal(normalizePathData("M 16 16 L 32 32", 32), "M 0.5000 0.5000 L 1.0000 1.0000");
  });

  it("extracts every path and the first stroke width", () => {
    assert.equal(pathData('<path d="M 1 1"/><path d="M 2 2"/>').length, 2);
    assert.equal(firstStrokeWidth('<path stroke-width="1.4"/>'), 1.4);
    assert.ok(Number.isNaN(firstStrokeWidth("<svg/>")));
  });
});

describe("space: the theme glyphs", () => {
  const glyphs = () => Object.values(SPACE_ICONS);

  it("is self-contained artwork with a literal colour", () => {
    // A manual test in Thunderbird 156 showed the context paint mechanism renders
    // nothing for a custom space button, so every glyph must carry its own colour.
    for (const path of glyphs()) {
      const svg = readProjectFile(path);
      assert.equal(usesContextPaint(svg), false, `${path} uses a context paint keyword and would be invisible`);

      const colours = paintValues(svg).filter((value) => /^#[0-9a-f]{3,8}$/i.test(value) || /^rgb/i.test(value));
      assert.ok(colours.length > 0, `${path} declares no literal colour, so it would render as nothing`);
    }
  });

  it("actually differs between the dark and light glyph", () => {
    // Identical artwork would make the pair pointless: the icon could never
    // change. Compare the literal colours, not the whole file.
    const coloursOf = (path: string): string[] =>
      paintValues(readProjectFile(path))
        .filter((value) => /^#[0-9a-f]{3,8}$/i.test(value))
        .map((value) => value.toLowerCase());

    /** HSP brightness of a 6-digit hex colour, 0..1. */
    const luminance = (value: string): number => {
      const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
      if (!hex) return Number.NaN;
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return Math.sqrt(0.299 * r * r + 0.587 * g * g + 0.114 * b * b) / 255;
    };

    for (const size of [16, 32]) {
      const dark = coloursOf(SPACE_ICONS[`dark${size}` as keyof typeof SPACE_ICONS]);
      const light = coloursOf(SPACE_ICONS[`light${size}` as keyof typeof SPACE_ICONS]);

      assert.ok(dark.length > 0, `size ${size}: the dark glyph declares no colour`);
      assert.ok(light.length > 0, `size ${size}: the light glyph declares no colour`);
      assert.notDeepEqual([...dark].sort(), [...light].sort(), `size ${size}: both glyphs use the same colours`);

      // Average the glyph's colours: the dark one must genuinely be darker, or the
      // pair is the wrong way round for the themeIcons contract.
      const mean = (values: string[]): number =>
        values.reduce((total, value) => total + luminance(value), 0) / values.length;
      const darkMean = mean(dark);
      const lightMean = mean(light);

      assert.ok(
        darkMean < lightMean,
        `size ${size}: the "dark" glyph (${dark.join(", ")}, brightness ${darkMean.toFixed(2)}) must be darker ` +
          `than the "light" glyph (${light.join(", ")}, brightness ${lightMean.toFixed(2)})`
      );
    }
  });

  it("declares a viewBox and a matching intrinsic size", () => {
    for (const path of glyphs()) {
      const svg = readProjectFile(path);
      assert.ok(hasViewBox(svg), `${path} needs a viewBox`);
      assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${path} needs the SVG namespace`);
      const size = /-(\d+)\.svg$/.exec(path)?.[1];
      assert.ok(size, `cannot read the size from ${path}`);
      assert.match(svg, new RegExp(`width="${size}"`), `${path} should be drawn at ${size}px`);
    }
  });

  it("is valid, non-empty SVG", () => {
    for (const path of glyphs()) {
      const svg = readProjectFile(path).trim();
      assert.ok(svg.startsWith("<svg"), path);
      assert.ok(svg.endsWith("</svg>"), path);
      assert.ok(svg.length > 120, `${path} looks suspiciously empty`);
    }
  });

  it("depicts the same glyph at a proportional scale in both sizes", () => {
    // The two sizes are separate files, so they can silently drift apart. Compare
    // every path's command stream, normalised by the canvas size: the 32px file
    // must be the 16px file scaled 2x.
    const normalized = (path: string, size: number): string[] =>
      pathData(readProjectFile(path)).map((d) => normalizePathData(d, size));

    for (const shade of ["dark", "light"] as const) {
      const small = normalized(SPACE_ICONS[`${shade}16`], 16);
      const large = normalized(SPACE_ICONS[`${shade}32`], 32);

      assert.equal(small.length, large.length, `${shade}: both sizes must have the same number of paths`);
      for (let index = 0; index < small.length; index += 1) {
        assert.deepEqual(
          large[index]!.split(" "),
          small[index]!.split(" "),
          `${shade}: path ${index} differs between 16px and 32px (the 32px file must be 2x the 16px artwork)`
        );
      }

      const relative = (path: string, size: number): number => firstStrokeWidth(readProjectFile(path)) / size;
      assert.ok(
        Math.abs(relative(SPACE_ICONS[`${shade}16`], 16) - relative(SPACE_ICONS[`${shade}32`], 32)) < 0.005,
        `${shade}: the 32px stroke must be 2x the 16px stroke`
      );
    }
  });

  it("draws the dark and light glyph with the same geometry", () => {
    // Only the colour may differ between the pair; a different shape would mean
    // the icon visibly changes form when the theme flips.
    for (const size of [16, 32] as const) {
      const darkPaths = pathData(readProjectFile(SPACE_ICONS[`dark${size}`]));
      const lightPaths = pathData(readProjectFile(SPACE_ICONS[`light${size}`]));
      assert.deepEqual(lightPaths, darkPaths, `size ${size}: the two glyphs must be the same shape`);
    }
  });
});

describe("space: manifest icons", () => {
  it("is self-contained and never the context-painted artwork", () => {
    const manifest = JSON.parse(readProjectFile("manifest.json")) as { icons: Record<string, string> };
    const glyphs = new Set(Object.values(SPACE_ICONS));

    for (const [size, path] of Object.entries(manifest.icons)) {
      assert.ok(existsSync(join(PROJECT_ROOT, path)), `manifest.icons["${size}"] does not exist: ${path}`);
      assert.ok(!glyphs.has(path as never), `manifest.icons["${size}"] must not reuse a theme glyph`);

      const svg = readProjectFile(path);
      assert.equal(usesContextPaint(svg), false, `${path} uses context paint, which renders nothing here`);
      const paints = paintValues(svg);
      assert.ok(paints.length > 0, `${path} needs a concrete colour or it renders as nothing`);
    }
  });
});
