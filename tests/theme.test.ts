import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  modeFromColorScheme,
  modeFromColors,
  parseColor,
  relativeLuminance,
  startTheme,
} from "../src/theme/index.ts";
import type { ThemeType } from "../src/api/browser.ts";

describe("theme: parseColor", () => {
  it("parses 6-digit and 3-digit hex", () => {
    assert.deepEqual(parseColor("#ffffff"), [255, 255, 255, 1]);
    assert.deepEqual(parseColor("#000000"), [0, 0, 0, 1]);
    assert.deepEqual(parseColor("#f00"), [255, 0, 0, 1]);
    assert.deepEqual(parseColor("#123456"), [18, 52, 86, 1]);
  });

  it("parses 8-digit and 4-digit hex with alpha", () => {
    assert.deepEqual(parseColor("#00000000"), [0, 0, 0, 0]);
    assert.equal(parseColor("#ff000080")?.[3], 128 / 255);
  });

  it("parses rgb() and rgba()", () => {
    assert.deepEqual(parseColor("rgb(12, 34, 56)"), [12, 34, 56, 1]);
    assert.deepEqual(parseColor("rgba(12, 34, 56, 0.5)"), [12, 34, 56, 0.5]);
    assert.deepEqual(parseColor("RGB(1,2,3)"), [1, 2, 3, 1]);
  });

  it("accepts RGBA arrays as Thunderbird reports them", () => {
    assert.deepEqual(parseColor([1, 2, 3, 4]), [1, 2, 3, 4]);
    assert.deepEqual(parseColor([1, 2, 3]), [1, 2, 3, 1]);
    assert.equal(parseColor([1, 2]), null);
  });

  it("parses named colours it knows and rejects the rest", () => {
    assert.deepEqual(parseColor("white"), [255, 255, 255, 1]);
    assert.equal(parseColor("rebeccapurple"), null);
  });

  it("rejects unusable values", () => {
    for (const value of [null, undefined, 42, {}, "", "   ", "#12345", "#gggggg", "rgb(1,2)"]) {
      assert.equal(parseColor(value), null, JSON.stringify(value));
    }
  });
});

describe("theme: relativeLuminance", () => {
  it("returns 0 for black and ~1 for white", () => {
    assert.equal(relativeLuminance([0, 0, 0, 1]), 0);
    // The HSP formula is not exactly 1 for white; assert closeness.
    assert.ok(Math.abs(relativeLuminance([255, 255, 255, 1]) - 1) < 1e-9);
  });

  it("weights green more than blue", () => {
    assert.ok(relativeLuminance([0, 255, 0, 1]) > relativeLuminance([0, 0, 255, 1]));
  });
});

describe("theme: modeFromColorScheme", () => {
  it("uses the declared color_scheme", () => {
    assert.equal(modeFromColorScheme({ properties: { color_scheme: "dark" } }), "dark");
    assert.equal(modeFromColorScheme({ properties: { color_scheme: "light" } }), "light");
  });

  it("returns null for auto/system and for missing data", () => {
    for (const value of ["auto", "system", undefined]) {
      assert.equal(modeFromColorScheme({ properties: { color_scheme: value } }), null);
    }
    assert.equal(modeFromColorScheme({}), null);
    assert.equal(modeFromColorScheme({ colors: null, images: null, properties: null }), null);
    assert.equal(modeFromColorScheme(null), null);
    assert.equal(modeFromColorScheme(undefined), null);
  });
});

describe("theme: modeFromColors", () => {
  it("detects a dark toolbar background", () => {
    assert.equal(modeFromColors({ colors: { toolbar: "#1c1b22" } }), "dark");
  });

  it("detects a light toolbar background", () => {
    assert.equal(modeFromColors({ colors: { toolbar: "rgb(255,255,255)" } }), "light");
  });

  it("falls through the background keys in priority order", () => {
    const theme: ThemeType = { colors: { popup: "#000000", toolbar: "not-a-color" } };
    assert.equal(modeFromColors(theme), "dark");
  });

  it("ignores fully transparent backgrounds", () => {
    assert.equal(modeFromColors({ colors: { toolbar: "#00000000", popup: "#ffffff" } }), "light");
  });

  it("returns null when nothing usable is present", () => {
    assert.equal(modeFromColors({ colors: null }), null);
    assert.equal(modeFromColors({}), null);
    assert.equal(modeFromColors({ colors: { unrelated: "#000" } }), null);
  });
});

describe("theme: startTheme outside Thunderbird", () => {
  /** A stand-in for the root element, so no DOM is needed. */
  function fakeTarget() {
    const attributes: Record<string, string> = {};
    const style: Record<string, string> = {};
    return {
      attributes,
      style,
      setAttribute(name: string, value: string) {
        attributes[name] = value;
      },
    };
  }

  function fakeMedia(matches: boolean) {
    return { matches, addEventListener() {}, removeEventListener() {} };
  }

  it("falls back to the media query and applies the attribute", async () => {
    const target = fakeTarget();
    const controller = await startTheme({
      target: target as unknown as HTMLElement,
      mediaQuery: fakeMedia(true) as unknown as MediaQueryList,
    });

    assert.equal(controller.state.mode, "dark");
    assert.equal(controller.state.source, "media");
    assert.equal(target.attributes["data-tn-theme"], "dark");
    assert.equal(target.style["colorScheme"], "dark");
    controller.dispose();
  });

  it("reports the light mode when the media query does not match", async () => {
    const target = fakeTarget();
    const controller = await startTheme({
      target: target as unknown as HTMLElement,
      mediaQuery: fakeMedia(false) as unknown as MediaQueryList,
    });
    assert.equal(controller.state.mode, "light");
    assert.equal(controller.state.source, "media");
    // The attribute is always written, even for the default light mode, so CSS
    // never has to depend on the attribute being absent.
    assert.equal(target.attributes["data-tn-theme"], "light");
    controller.dispose();
  });

  it("does nothing when there is no target and no media query", async () => {
    const controller = await startTheme({ mediaQuery: null });
    assert.equal(controller.state.source, "default");
    controller.dispose();
  });
});
