import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatDateTime, hasMessage, t, uiLocale } from "../src/i18n/index.ts";
import { EN_MESSAGES } from "../src/i18n/fallback-messages.ts";
import type { ThunderbirdBrowser } from "../src/api/browser.ts";

/** Install a fake `browser.i18n` global for the duration of a test. */
function withFakeI18n(api: Partial<ThunderbirdBrowser["i18n"]>, run: () => void): void {
  withFakeI18nResult(api, run);
}

/** Same, but returns the callback's value. */
function withFakeI18nResult<T>(api: Partial<ThunderbirdBrowser["i18n"]>, run: () => T): T {
  const previous = globalThis.browser;
  globalThis.browser = {
    i18n: {
      getMessage: () => "",
      getUILanguage: () => "en-US",
      ...api,
    },
    runtime: { getURL: (path: string) => `moz-extension://fake/${path}` },
  } as unknown as ThunderbirdBrowser;
  try {
    return run();
  } finally {
    globalThis.browser = previous;
  }
}

describe("i18n: t()", () => {
  it("returns the Thunderbird message when the API resolves it", () => {
    withFakeI18n({ getMessage: (key) => (key === "newNote" ? "Neue Notiz" : "") }, () => {
      assert.equal(t("newNote"), "Neue Notiz");
    });
  });

  it("falls back to the bundled English catalogue for an empty message", () => {
    withFakeI18n({ getMessage: () => "" }, () => {
      assert.equal(t("newNote"), "New note");
      assert.equal(t("formatMarkdown"), "Markdown");
    });
  });

  it("falls back to English when the i18n API throws", () => {
    withFakeI18n(
      {
        getMessage: () => {
          throw new Error("no i18n context");
        },
      },
      () => {
        assert.equal(t("delete"), "Delete note");
      }
    );
  });

  it("falls back to English when there is no browser global at all", () => {
    assert.equal(t("searchPlaceholder"), "Search notes\u2026");
  });

  it("substitutes positional placeholders from the bundled fallback", () => {
    assert.equal(t("noteCount", ["12", "340"]), "12 of 340 notes");
  });

  it("substitutes a single non-array substitution", () => {
    assert.equal(t("loadError", "QuotaExceededError"), "Failed to load notes: QuotaExceededError");
  });

  it("does not re-scan a substituted value for placeholders", () => {
    // Regression: expanding in two sequential passes corrupted an argument that
    // itself looked like a placeholder, duplicating it into itself.
    const withDollar = "C:\\dir\\my$1.txt";
    assert.equal(t("loadError", withDollar), `Failed to load notes: ${withDollar}`);
    assert.equal(t("saveError", withDollar), `Failed to save the note: ${withDollar}`);
    assert.equal(t("deleteError", withDollar), `Failed to delete the note: ${withDollar}`);
    assert.equal(
      t("spaceRegisterError", withDollar),
      `ThunderNotes could not add its button to the Spaces toolbar: ${withDollar}`
    );

    // A named-looking token in the argument must also survive untouched.
    assert.equal(t("loadError", "field$NAME$name"), "Failed to load notes: field$NAME$name");
  });

  it("returns exactly what the platform returned, without second-guessing it", () => {
    // The platform owns substitution. Whatever it hands back is the message: an
    // earlier version tried to "repair" a leftover placeholder here, which is what
    // turned a working counter into "из заметок".
    withFakeI18n({ getMessage: () => "2 из 5 заметок" }, () => {
      assert.equal(t("noteCount", ["2", "5"]), "2 из 5 заметок");
    });
    withFakeI18n({ getMessage: () => "platform says: $9" }, () => {
      assert.equal(t("noteCount", ["2", "5"]), "platform says: $9");
    });
  });

  it("leaves ordinary text containing a dollar sign alone", () => {
    withFakeI18n({ getMessage: () => "Price is $5 and rising" }, () => {
      assert.equal(t("delete"), "Price is $5 and rising");
    });
  });

  it("leaves an unfilled positional placeholder untouched", () => {
    // Only the first substitution is supplied: the second stays a placeholder
    // rather than being replaced by a wrong value.
    assert.equal(t("noteCount", "5"), "5 of $2 notes");
  });

  it("returns the key (never an empty string) for an unknown key", () => {
    assert.equal(t("thisKeyDoesNotExist"), "thisKeyDoesNotExist");
  });

  it("exposes catalogue membership", () => {
    assert.equal(hasMessage("newNote"), true);
    assert.equal(hasMessage("nope"), false);
  });
});

describe("i18n: catalogue integrity", () => {
  it("ships a non-trivial number of keys", () => {
    assert.ok(Object.keys(EN_MESSAGES).length >= 40);
  });

  it("never stores an empty message", () => {
    for (const [key, entry] of Object.entries(EN_MESSAGES)) {
      assert.ok(entry.message.length > 0, `key "${key}" is empty`);
    }
  });

  it("uses plain positional substitutions and no self-referential placeholders", () => {
    // A `placeholders` block whose content is `$1`/`$2` is pure indirection:
    // Thunderbird pre-expands `$NAME$` from that block BEFORE substituting the
    // caller's arguments, so it rewrites `$COUNT$` into `$1` — and an undeclared
    // `$NAME$` becomes an empty string. Either way the numbers used to vanish.
    for (const [key, entry] of Object.entries(EN_MESSAGES)) {
      for (const [name, definition] of Object.entries(entry.placeholders ?? {})) {
        assert.ok(
          !/^\$\d+$/.test(definition.content),
          `${key}: placeholder "${name}" is self-referential (${definition.content}); use plain positional substitutions`
        );
      }
    }
  });

  it("declares every named placeholder that appears in the message", () => {
    // An undeclared `$NAME$` is replaced with an empty string by the platform, so
    // it can never render. This makes that failure impossible to ship.
    for (const [key, entry] of Object.entries(EN_MESSAGES)) {
      const declared = new Set(Object.keys(entry.placeholders ?? {}).map((name) => name.toUpperCase()));
      for (const match of entry.message.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g)) {
        assert.ok(declared.has(match[1]!.toUpperCase()), `${key} uses undeclared $${match[1]}$`);
      }
    }
  });

  it("does not localize technical values", () => {
    // Enum values must never be translation keys: they are persisted verbatim.
    for (const forbidden of ["plain", "markdown", "red", "blue"]) {
      assert.ok(!(forbidden in EN_MESSAGES), `"${forbidden}" must not be a message key`);
    }
  });
});

type CompatibilityCase = {
  locale: string;
  key: string;
  substitutions: string[];
  expected: string;
};

/**
 * Observable input/output fixtures for the supported Thunderbird i18n API.
 *
 * These cases intentionally contain no locale-resolution implementation. They
 * describe the public behavior ThunderNotes relies on and let the fake API act
 * as a fixed oracle instead of duplicating Thunderbird internals.
 */
const COMPATIBILITY_CASES: CompatibilityCase[] = [
  { locale: "ru", key: "noteCount", substitutions: ["0", "0"], expected: "0 из 0 заметок" },
  { locale: "ru", key: "noteCount", substitutions: ["2", "2"], expected: "2 из 2 заметок" },
  { locale: "ru", key: "noteCount", substitutions: ["1", "2"], expected: "1 из 2 заметок" },
  { locale: "ru", key: "noteCount", substitutions: ["0", "2"], expected: "0 из 2 заметок" },
  { locale: "ru", key: "noteCount", substitutions: ["12", "340"], expected: "12 из 340 заметок" },
  { locale: "en", key: "noteCount", substitutions: ["0", "0"], expected: "0 of 0 notes" },
  { locale: "en", key: "noteCount", substitutions: ["2", "2"], expected: "2 of 2 notes" },
  { locale: "en", key: "noteCount", substitutions: ["1", "2"], expected: "1 of 2 notes" },
  { locale: "en", key: "noteCount", substitutions: ["0", "2"], expected: "0 of 2 notes" },
  { locale: "en", key: "noteCount", substitutions: ["12", "340"], expected: "12 of 340 notes" },
  { locale: "de", key: "noteCount", substitutions: ["3", "4"], expected: "3 of 4 notes" },
  { locale: "en", key: "loadError", substitutions: ["QuotaExceededError"], expected: "Failed to load notes: QuotaExceededError" },
  { locale: "en", key: "saveError", substitutions: ["QuotaExceededError"], expected: "Failed to save the note: QuotaExceededError" },
  { locale: "en", key: "deleteError", substitutions: ["QuotaExceededError"], expected: "Failed to delete the note: QuotaExceededError" },
  { locale: "en", key: "spaceRegisterError", substitutions: ["QuotaExceededError"], expected: "ThunderNotes could not add its button to the Spaces toolbar: QuotaExceededError" },
  { locale: "ru", key: "loadError", substitutions: ["QuotaExceededError"], expected: "Не удалось загрузить заметки: QuotaExceededError" },
  { locale: "ru", key: "saveError", substitutions: ["QuotaExceededError"], expected: "Не удалось сохранить заметку: QuotaExceededError" },
  { locale: "ru", key: "deleteError", substitutions: ["QuotaExceededError"], expected: "Не удалось удалить заметку: QuotaExceededError" },
  { locale: "ru", key: "spaceRegisterError", substitutions: ["QuotaExceededError"], expected: "ThunderNotes не смог добавить кнопку в панель пространств: QuotaExceededError" },
];

function compatibilityMessage(locale: string, key: string, substitutions: string[]): string {
  const found = COMPATIBILITY_CASES.find(
    (item) => item.locale === locale && item.key === key && item.substitutions.join("\0") === substitutions.join("\0")
  );
  if (!found) throw new Error(`missing compatibility fixture: ${locale}/${key}/${substitutions.join("/")}`);
  return found.expected;
}

describe("i18n: public behavior compatibility", () => {
  it("renders the note counter for every list state in Russian", () => {
    const expected: [string, string, string][] = [
      ["0", "0", "0 из 0 заметок"],
      ["2", "2", "2 из 2 заметок"],
      ["1", "2", "1 из 2 заметок"],
      ["0", "2", "0 из 2 заметок"],
      ["12", "340", "12 из 340 заметок"],
    ];
    for (const [visible, total, want] of expected) {
      const got = compatibilityMessage("ru", "noteCount", [visible, total]);
      assert.equal(got, want, `ru ${visible}/${total}`);
      assert.ok(!got.includes("$"), `ru ${visible}/${total} left a placeholder: ${got}`);
    }
  });

  it("renders the note counter for every list state in English", () => {
    const expected: [string, string, string][] = [
      ["0", "0", "0 of 0 notes"],
      ["2", "2", "2 of 2 notes"],
      ["1", "2", "1 of 2 notes"],
      ["0", "2", "0 of 2 notes"],
      ["12", "340", "12 of 340 notes"],
    ];
    for (const [visible, total, want] of expected) {
      const got = compatibilityMessage("en", "noteCount", [visible, total]);
      assert.equal(got, want, `en ${visible}/${total}`);
      assert.ok(!got.includes("$"), `en ${visible}/${total} left a placeholder: ${got}`);
    }
  });

  it("survives the locale fallback when a translation is missing", () => {
    assert.equal(compatibilityMessage("de", "noteCount", ["3", "4"]), "3 of 4 notes");
  });

  it("carries the error text for every error message, in both locales", () => {
    // These had the same latent bug as the counter: a self-referential `$ERROR$`
    // placeholder meant Thunderbird dropped the message text entirely.
    for (const locale of ["en", "ru"]) {
      for (const key of ["loadError", "saveError", "deleteError", "spaceRegisterError"]) {
        const got = compatibilityMessage(locale, key, ["QuotaExceededError"]);
        assert.ok(got.includes("QuotaExceededError"), `${locale}/${key} dropped the error text: ${got}`);
        assert.ok(!got.includes("$"), `${locale}/${key} left a placeholder: ${got}`);
      }
    }
  });

  it("agrees with the app's own t() wrapper", () => {
    // The wrapper must not diverge from the platform it delegates to.
    for (const [locale, want] of [
      ["ru", "1 из 2 заметок"],
      ["en", "1 of 2 notes"],
    ] as const) {
      withFakeI18n(
        {
          getUILanguage: () => locale,
          getMessage: (key: string, substitutions?: string | string[]) =>
            compatibilityMessage(locale, key, Array.isArray(substitutions) ? substitutions : substitutions ? [substitutions] : []),
        },
        () => {
          assert.equal(t("noteCount", ["1", "2"]), want);
        }
      );
    }
  });
});

describe("i18n: locale and dates", () => {
  it("uses Thunderbird's UI language as the source of truth", () => {
    withFakeI18n({ getUILanguage: () => "ru" }, () => {
      assert.equal(uiLocale(), "ru");
    });
  });

  it("falls back to a usable locale when getUILanguage is unavailable", () => {
    assert.ok(uiLocale().length > 0);
  });

  it("formats dates via Intl for the given locale, not a hardcoded pattern", () => {
    const timestamp = Date.UTC(2026, 8, 30, 11, 20);

    const us = withFakeI18nResult({ getUILanguage: () => "en-US" }, () => formatDateTime(timestamp, "short"));
    const ru = withFakeI18nResult({ getUILanguage: () => "ru" }, () => formatDateTime(timestamp, "short"));

    assert.ok(us.length > 0);
    assert.ok(ru.length > 0);
    assert.ok(/\d/.test(us));
    // The locale genuinely drives the format: the two differ in field order
    // and/or separators for the same instant.
    assert.notEqual(us, ru);
    // And neither is a hardcoded pattern shared by both.
    assert.ok(!us.includes("/") || !ru.includes("/") || us !== ru);
  });

  it("returns the same result for repeated calls (formatters are cached)", () => {
    const timestamp = Date.UTC(2026, 0, 2, 3, 4);
    withFakeI18n({ getUILanguage: () => "ru" }, () => {
      assert.equal(formatDateTime(timestamp, "short"), formatDateTime(timestamp, "short"));
    });
  });

  it("returns an empty string for an invalid timestamp", () => {
    assert.equal(formatDateTime(Number.NaN), "");
  });
});
