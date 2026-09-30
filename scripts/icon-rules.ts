/**
 * Inspection of the SVG icon assets.
 *
 * Two kinds of asset, with different rules, plus the cross-checks that make the
 * explicitly selected `defaultIcons` glyphs trustworthy:
 *
 *  - **Space glyphs** (`notes-glyph-*.svg`) are selected by the extension after
 *    it resolves the effective theme and are handed to Thunderbird through one
 *    concrete `defaultIcons` set. `themeIcons` is explicitly cleared to `null`.
 *    The glyphs must therefore be self-contained with a literal colour — a manual
 *    test in Thunderbird 156 showed that the context paint mechanism does not
 *    reach a custom space button, so any context keyword renders nothing.
 *  - **Manifest icons** are shown by the add-ons manager, where there is no theme
 *    to match. They are separate self-contained artwork and are not reused as the
 *    Space button glyphs.
 *
 * Beyond "no context keywords", the light and dark glyphs must actually differ in
 * colour (or the pair is pointless), and the 16px and 32px file at each colour
 * must be the same artwork at 2x.
 *
 * The build verifier loads this module through esbuild, so there is a single
 * implementation for both callers.
 */

/**
 * Paint values that are ink, i.e. *not* a colour of their own.
 *
 * An ALLOWLIST on purpose: anything unrecognised is reported as a concrete
 * colour. A denylist would silently accept whatever it did not know, and a
 * mis-written pattern would turn the whole check into a no-op. (That is not
 * hypothetical: an earlier version ended an alternative with `$`, which matches
 * the empty string, so every value looked theme-independent.)
 */
const NON_COLOUR_PAINT = /^(?:none|currentColor|transparent|inherit)$/i;

/** Context paint keywords, which never render for a custom space button. */
const CONTEXT_PAINT = /\bcontext-(?:fill|stroke|fill-opacity|stroke-opacity)\b/;

/** Remove XML comments, so prose in the artwork's documentation is not inspected. */
function stripComments(svg: string): string {
  return svg.replace(/<!--[\s\S]*?-->/g, "");
}

/** Every paint value declared on an element, in document order. */
export function paintValues(svg: string): string[] {
  const values: string[] = [];
  for (const match of stripComments(svg).matchAll(/(?:fill|stroke|stop-color)\s*(?:=\s*"|:\s*)([^";]+)/g)) {
    const value = match[1]?.trim() ?? "";
    if (value.length > 0) values.push(value);
  }
  return values;
}

/**
 * Find paint declarations that are not a literal colour.
 *
 * Returns the offending declarations, so a caller can report exactly what is
 * wrong. An empty result means "every paint value is a concrete colour", which is
 * what a theme glyph must be.
 */
export function findNonLiteralPaint(svg: string): string[] {
  const found: string[] = [];
  for (const match of stripComments(svg).matchAll(/(?:fill|stroke|stop-color)\s*(?:=\s*"|:\s*)([^";]+)/g)) {
    const value = match[1]?.trim() ?? "";
    if (value.length === 0 || NON_COLOUR_PAINT.test(value)) continue;
    found.push(match[0].trim());
  }
  return found;
}

/** True when the SVG uses a context paint keyword, which cannot render here. */
export function usesContextPaint(svg: string): boolean {
  return CONTEXT_PAINT.test(stripComments(svg));
}

/** True when the SVG declares a viewBox, so it can be scaled to any size. */
export function hasViewBox(svg: string): boolean {
  return /viewBox\s*=\s*"[^"]+"/.test(svg);
}

/** Extract the `d` attribute of every `<path>` element, in document order. */
export function pathData(svg: string): string[] {
  return [...stripComments(svg).matchAll(/<path\s+d="([^"]+)"/g)].map((match) => match[1] ?? "");
}

/**
 * Render a path's command stream with every number normalised by `size`.
 *
 * Two files that depict the same artwork at different canvas sizes produce
 * identical normalised streams, which is what makes drift detectable.
 */
export function normalizePathData(d: string, size: number): string {
  return (d.match(/-?(?:\d+\.?\d*|\.\d+)|[A-Za-z]/g) ?? [])
    .map((token) => {
      const value = Number(token);
      return Number.isFinite(value) ? (value / size).toFixed(4) : token;
    })
    .join(" ");
}

/** The `stroke-width` of the first path, or NaN when absent. */
export function firstStrokeWidth(svg: string): number {
  const value = Number(/stroke-width\s*=\s*"([\d.]+)"/.exec(svg)?.[1]);
  return Number.isFinite(value) ? value : Number.NaN;
}
