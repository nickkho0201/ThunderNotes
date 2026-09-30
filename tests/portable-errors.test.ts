import assert from "node:assert/strict";
import { describe, it } from "node:test";

import enMessages from "../_locales/en/messages.json" with { type: "json" };
import ruMessages from "../_locales/ru/messages.json" with { type: "json" };
import type { ThunderbirdBrowser } from "../src/api/browser.ts";
import {
  PortableDataError,
  type PortableDataErrorCode,
  type PortableDataErrorParameters,
} from "../src/portable/types.ts";
import { localizePortableError } from "../src/ui/portable-errors.ts";

type Catalogue = Record<string, { message: string }>;

function withLocale<T>(locale: "en" | "ru", run: () => T): T {
  const previous = globalThis.browser;
  const catalogue = (locale === "ru" ? ruMessages : enMessages) as Catalogue;
  globalThis.browser = {
    i18n: {
      getUILanguage: () => locale,
      getMessage: (key: string, substitutions?: string | string[]) => {
        const template = catalogue[key]?.message ?? "";
        const values = substitutions === undefined
          ? []
          : Array.isArray(substitutions)
            ? substitutions
            : [substitutions];
        return template.replace(/\$(\d+)/g, (match, position: string) =>
          values[Number(position) - 1] ?? match
        );
      },
    },
    runtime: { getURL: (path: string) => `moz-extension://fake/${path}` },
  } as unknown as ThunderbirdBrowser;
  try {
    return run();
  } finally {
    globalThis.browser = previous;
  }
}

function domainError(
  code: PortableDataErrorCode,
  parameters: PortableDataErrorParameters = {},
): PortableDataError {
  return new PortableDataError(code, "raw technical English must not reach the UI", parameters);
}

describe("portable error localization", () => {
  it("localizes known codes and placeholders in English and Russian", () => {
    const error = domainError("unsupported-format-version", { actual: 999, supported: 1 });
    assert.equal(
      withLocale("en", () => localizePortableError(error)),
      "Backup format version 999 is newer than supported version 1.",
    );
    assert.equal(
      withLocale("ru", () => localizePortableError(error)),
      "Версия формата резервной копии (999) новее поддерживаемой версии (1).",
    );
  });

  it("has localized UI text for every expected Portable Data error code", () => {
    const cases: Array<[PortableDataErrorCode, PortableDataErrorParameters]> = [
      ["empty-file", {}],
      ["file-read-failed", {}],
      ["file-too-large", { actual: 20, maximum: 10 }],
      ["invalid-utf8", {}],
      ["malformed-json", {}],
      ["wrong-format", {}],
      ["unsupported-format-version", { actual: 2, supported: 1 }],
      ["unsupported-note-schema", { actual: 2, supported: 1 }],
      ["missing-field", { field: "portable.notes" }],
      ["unknown-field", { field: "portable.extra" }],
      ["invalid-shape", { path: "portable.notes" }],
      ["invalid-value", { field: "portable.exportedAt" }],
      ["duplicate-note-id", {}],
      ["too-many-notes", { actual: 100_001, maximum: 100_000 }],
      ["max-depth", { maximum: 32 }],
      ["invalid-meta", { path: "portable.notes[0].meta" }],
    ];

    for (const locale of ["en", "ru"] as const) {
      for (const [code, parameters] of cases) {
        const localized = withLocale(locale, () => localizePortableError(domainError(code, parameters)));
        assert.ok(localized.length > 0, `${locale}/${code} was empty`);
        assert.equal(localized.includes("raw technical English"), false, `${locale}/${code} leaked message`);
        assert.equal(localized.includes("$"), false, `${locale}/${code} left a placeholder`);
      }
    }
  });

  it("uses a localized generic fallback and logs an unexpected error for debugging", () => {
    const original = console.error;
    const logged: unknown[][] = [];
    console.error = (...values: unknown[]) => logged.push(values);
    const unexpected = new Error("low-level English detail");
    try {
      assert.equal(
        withLocale("ru", () => localizePortableError(unexpected)),
        "произошла внутренняя ошибка.",
      );
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 1);
    assert.equal(logged[0]?.[1], unexpected);
  });
});
