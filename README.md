<p align="center">
  <img src="assets/icons/notes-solid-64.svg" alt="ThunderNotes logo" width="72" height="72" />
</p>

# ThunderNotes

A small, fast, **completely local** notes manager that lives inside a Mozilla
Thunderbird Space. Click the **Notes** button in the Spaces toolbar and start
typing — there is no save button, no account, no server, and no network traffic of
any kind.

ThunderNotes deliberately stays small. It is not a knowledge base, not a wiki and
not a Notion clone. It is the fastest possible way to jot something down and find
it again later, without leaving Thunderbird.

> **Download:** [Download latest XPI](https://github.com/nickkho0201/ThunderNotes/releases/latest)\
> Install via **Thunderbird → Tools → Add-ons and Themes → gear icon → Install Add-on From File…**

---

## Current features

Everything below is implemented in the current source and included in generated
`dist/` and XPI build artifacts; automated coverage and runtime gaps are described
in [Testing](#testing).

**Space integration**
- Registers its own **ThunderNotes** space and Spaces-toolbar button through the
  modern `spaces` API (not the deprecated `spacesToolbar` API).
- Order-independent, idempotent registration: restarting Thunderbird, reloading
  the extension, or an MV3 service-worker restart never produces duplicate buttons.

**Notes**
- Create, edit, and delete notes; the editor is focused automatically so you can
  type immediately after pressing "New note".
- **Autosave** with a 400 ms debounce, plus an immediate best-effort flush when
  you switch notes, hide the page, or close it. No manual saving, ever.
- Automatic preview text derived from the content — a separate title field is
  neither required nor stored. Markdown syntax is stripped for the preview, so the
  list never shows a wall of `#`, `**` or `[]()`.
- **Plain Text** and **Markdown** editing modes (the stored text is never
  converted when you switch), with an Edit/Preview toggle and rendered
  headings, bold, italic, lists, code, blockquotes, links and tables.
- Existing Markdown notes open in Preview; Plain Text and new notes open in Edit.
  Changing the current note from Plain Text to Markdown keeps Edit active.
  Double-clicking the empty Preview background enters Edit; rendered content
  and active text selections retain normal Preview interaction.
- In a focused Markdown textarea, Ctrl/Cmd+B, I and backtick toggle exact,
  immediately surrounding bold, italic and inline-code delimiters; selecting the
  whole isolated construct also removes them. Ambiguous marker runs are wrapped
  conservatively. Ctrl/Cmd+K continues to insert links. Enter continues indented
  bullet, numbered and
  task-list source; Enter on an empty item exits the list. Brackets, parentheses
  and backticks pair at text boundaries or around selected text. Only tracked,
  automatically inserted closing characters are skipped when typed again.
  Editing commands preserve native undo when supported, with `setRangeText` as
  a fallback whose undo behavior needs manual Thunderbird verification.
  Inserting an ordered item renumbers later same-level siblings of the same
  marker type within the continuous block; nested lists keep their own numbers.
  Explicit whole-item deletion or a boundary merge also shifts subsequent
  consecutive siblings back. Partial edits and ambiguous numbering stay native;
  deleting an item with an unselected nested subtree is left to native editing.
  Tab in Markdown Edit inserts four spaces at a plain caret, indents an entire
  list-item line, or indents all selected lines. Shift+Tab removes up to four
  leading spaces per affected line (or one legacy leading tab). Selections and
  scroll position are preserved; Plain Text and controls retain native Tab navigation.
- Seven-way colour marking (none + six colours) shown as a compact leading strip
  in the list — never as a full background.
- **Live search** across the whole note content, case-insensitive.
- **Portable Data v1** full backups as readable UTF-8 JSON, with strict import,
  non-destructive Merge conflict policies, and safety-gated Restore / Replace.
  Export uses the current in-memory note state, including pending edits.
  Export always opens the system Save As dialog through the Downloads API and
  reports success only after download completion; cancelling is neutral.
- **Colour filter** combined with search.
- **Created date range** in one compact toolbar control. Its calendar popover
  selects the range with two clicks in either order, supports month navigation
  and a clickable heading with direct year entry and a twelve-month grid,
  highlights endpoints/interior/today, and offers a dedicated reset. Dates are
  inclusive local calendar days. It combines with search, colour and the existing
  format query. Dates reset on reopening and may be cleared
  when creating a note to keep the new note visible.
- **Four sort orders**: created newest/oldest first, updated newest/oldest first
  (default: created, newest first). Each row shows the timestamp of the field the
  list is **currently sorted by** — `Created` for a creation sort, `Edited` for a
  modification sort — so the visible date always explains the visible order. The
  sort *direction* never changes which timestamp is shown.
- Delete confirmation, and a sensible neighbouring note is selected afterwards.
- Delete also requests that same confirmation while the list or selected row
  has keyboard focus. Editor, Preview and other controls never trigger it.

**Interface**
- Two-pane layout: the note list on the left, the editor on the right, a compact
  toolbar on top, and a status line showing the visible/total count and the save
  state. The status line is pinned to the bottom of the notes pane and does not
  move when the list is empty, filtered down to nothing, or very short.
- **Responsive**: see [Window width behaviour](#window-width-behaviour) below.
- Follows Thunderbird's Light/Dark theme automatically and live.
- Fully localized (**English** and **Russian**) through `browser.i18n`, with
  dates and times formatted via `Intl` using Thunderbird's UI locale.
- Virtualized note list: only the rows on screen are in the DOM.
- **Restores your view on reopening**: sort order, colour filter and the
  previously selected note. The search box is deliberately *not* restored — see
  [UI state persistence](#ui-state-persistence).

**Data**
- Notes live in the extension's own **IndexedDB** database on your computer.
- Versioned schema with a real migration mechanism (currently schema version 1).
- The UI only ever talks to a `NotesRepository` interface, so the storage backend
  can be replaced without touching the interface code.
- View preferences live in `browser.storage.local`, completely separate from the
  notes database — see [UI state persistence](#ui-state-persistence).

---

## Window width behaviour

The page itself never scrolls horizontally; each pane manages its own overflow.
Breakpoints are chosen from the layout's own needs rather than a framework
convention. Below a narrow window the app switches from two panes to a
**single-pane workflow** rather than crushing both panes.

| Window width | Layout |
| --- | --- |
| **≥ 1040 px** | Two panes. The note list is capped at 420 px (base 300 px) so the editor keeps the remaining width. |
| **900–1040 px** | Two panes. The list narrows (base 260 px, max 40%), toolbars may wrap onto a second row. |
| **780–900 px** | Two panes. The list narrows further (232 px), control labels collapse to icons (the `title`/`aria-label` attributes remain), and the editor bar wraps. |
| **< 780 px** | **Single pane.** The list is shown first; selecting a note (or pressing "New note") replaces it with the editor, which gains a **back** button. Escape also returns to the list. |
| **< 520 px** | The toolbar wraps: search gets a full-width row, and date controls wrap as needed. |

Why 780 px: that is where the editor pane would fall below roughly 480 px of
usable width, the point at which the editor's controls start competing with the
text. 1040 px is where the list reaches its maximum sensible width.

Behaviour that holds at every width:

- no horizontal scrolling of the page;
- long plain text wraps, including long unbroken strings (URLs, minified code);
- Markdown preview text, tables and fenced code wrap instead of pushing the pane
  sideways;
- delete, format, colour and Edit/Preview controls never disappear — in the
  single-pane layout the editor bar simply wraps onto more rows;
- returning to the list preserves the selection and all unsaved content.

---

## UI state persistence

Persisted, in `browser.storage.local` under a single namespaced key
(`thundernotes.ui.v1`):

- **sort mode**;
- **colour filter**;
- **last selected note id**.

Deliberately **not** persisted:

- the **search query**. It lives in the session only, so it survives while the
  space tab is open and resets when the tab is closed.
- the **created date range** follows the same session lifetime.

On reopening ThunderNotes the sort and filter are restored, and the previous note
is reselected **only if it still exists and is visible under the restored
filter**. Otherwise the first note in the current view is selected; if the view is
empty, nothing is selected. A stale, deleted, or unrecognised stored value is
normalized back to a default rather than being trusted, so restored state can
never make the app look broken.

This state is view configuration, not domain data: it is stored separately from
the notes database and is never written into individual `Note` records.

The background also stores the last page-resolved Light/Dark mode under
`thundernotes.resolvedThemeMode`, separately from the user-facing preferences, so
an MV3 worker restart cannot replace a confirmed Space glyph with its DOM-less
default.

---

## Requirements

- **Thunderbird 128.0 or newer** (`strict_min_version` is `128.0`).
  Developed and verified against the **Thunderbird 156** Manifest V3 API
  documentation.
- No other software. The extension bundles everything it needs; nothing is
  fetched from a CDN at runtime.

---

## Development

You need Node.js 20 or newer.

```bash
# 1. Install dependencies
pnpm install

# 2. Type-check (strict TypeScript, no emit)
pnpm run typecheck

# 3. Build the unpacked extension into dist/ and run the test suites
pnpm test

# 4. Verify the built artifact (manifest, locales, assets, no network calls)
pnpm run verify

# 5. Build dist/ and produce artifacts/thundernotes-<version>.xpi
pnpm run xpi

# Everything at once: typecheck -> build -> test -> package -> verify
pnpm run package
```

`pnpm run clean` removes `dist/`, `build/`, `artifacts/` and the generated locale
module; every other script regenerates whatever it needs, so a clean tree builds
without extra steps.

### Trying it without packaging

1. Run `pnpm run build`.
2. In Thunderbird open **Tools → Developer Tools → Debug Add-ons**.
3. Click **Load Temporary Add-on…** and select `dist/manifest.json`.
4. The **Notes** button appears in the Spaces toolbar.

A temporary add-on is removed when Thunderbird closes, which makes it the right
way to iterate: change the sources, run `pnpm run build`, then press **Reload** in
the Debug Add-ons page.

> Note: since the space is registered at extension startup, you may need to press
> **Reload** after the very first load for the toolbar button to appear.

### Installing the packaged XPI

See [Installation](#installation) below.

### Project layout

```text
ThunderNotes/
├── manifest.json              # MV3 manifest (localized via __MSG_*__)
├── _locales/{en,ru}/          # browser.i18n message catalogues (en = default)
├── assets/icons/              # toolbar/space icons (light, dark, 16/32/64 px)
├── src/
│   ├── api/browser.ts         # hand-written types for the used TB APIs
│   ├── background/            # service worker: space registration
│   ├── notes/                 # Note model, preview derivation, query pipeline
│   ├── storage/               # NotesRepository, IndexedDB impl, migrations
│   ├── markdown/              # marked + allowlist sanitizer
│   ├── theme/                 # Thunderbird light/dark detection
│   ├── i18n/                  # localization wrapper (+ generated EN fallback)
│   └── ui/                    # page entry point, store, list view, editor view
├── tests/                     # unit + headless (linkedom) tests
└── scripts/                   # build, test build, packaging, verification
```

---

## Installation

ThunderNotes installs as an ordinary Thunderbird extension. There is nothing else
to install.

**From a packaged XPI:** download the
[latest packaged XPI](https://github.com/nickkho0201/ThunderNotes/releases/latest).

1. Open Thunderbird.
2. **Tools → Add-ons and Themes** (`Ctrl+Shift+A`).
3. Click the gear icon → **Install Add-on From File…**
4. Select the `.xpi` file and confirm.

The manifest declares a fixed Thunderbird extension ID, so the packaged XPI can
be installed persistently through the Add-ons Manager.

**Temporarily, without packaging:** follow
[Trying it without packaging](#trying-it-without-packaging) above.

After installing, press the **Notes** button in the Spaces toolbar. On a fresh
profile there are no notes yet — press **New note** and start typing.

---

## Data storage

**All of your notes are stored locally on your computer. Nothing is ever sent
anywhere.**

- Notes live in an **IndexedDB** database named `thundernotes`, created and owned
  by the extension, inside your Thunderbird profile directory.
- Each note is a separate record keyed by a UUID. Editing one note writes exactly
  one record; it never rewrites the whole collection.
- The database carries an explicit schema version, and the code has a real
  migration path (`src/storage/migrations.ts`). A future data-model change upgrades
  existing records instead of discarding them.
  Adding a persistent schema migration requires updating `CURRENT_SCHEMA_VERSION`
  and IndexedDB `DB_VERSION` together, plus adding the migration step, because
  migrations run from `onupgradeneeded`.
- Unreadable or partially corrupt records are skipped with a console warning
  rather than taking the whole database down.

What ThunderNotes does **not** do:

- no server, no cloud, no account, no login;
- no telemetry, analytics or crash reporting;
- no network requests at all — `pnpm run verify` enforces this by scanning the
  built bundles for network entry points and remote assets;
- no third-party code fetched at runtime (the single dependency, `marked`, is
  bundled into the XPI).

The only manifest permission is **downloads**, used for explicit local backup
Save As and completion tracking. It also grants the platform's download-history
capability; ThunderNotes queries only the ID of its own active backup. There are
no host, optional, cloud/account or network permissions. The artifact verifier
rejects every permission set other than exactly `["downloads"]`.

If IndexedDB cannot be opened (for example in a restricted profile), ThunderNotes
keeps working for the current session with in-memory storage and shows a warning
banner that the notes will not be saved.

**To delete your notes**, delete them in the app, or remove the extension — your
Thunderbird add-on data is removed with it. Use **Data… → Export backup** before
removing the extension when you want to retain a portable copy.

---

## Architecture

The layers are deliberately separated so that each can change without disturbing
the others.

| Layer | Location | Responsibility |
| --- | --- | --- |
| Domain model | `src/notes/model.ts` | The `Note` shape, validation/normalization, and `revision`/`updatedAt` bumping. No I/O, no DOM. |
| Derived logic | `src/notes/preview.ts`, `src/notes/query.ts` | Preview text extraction, and the pure search → filter → sort pipeline. No I/O, no DOM. |
| Portable data | `src/portable/` | Canonical backup codec, strict external validation, import planning, conflict handling, file transport, and TOCTOU-safe commit coordination. |
| Storage | `src/storage/` | `NotesRepository` interface, the IndexedDB implementation, an in-memory implementation, and schema migrations. |
| Markdown | `src/markdown/` | `marked` plus a strict DOM-allowlist sanitizer. |
| Theme | `src/theme/` | Detects Thunderbird's light/dark theme and keeps it live. |
| Localization | `src/i18n/` | The `t()` wrapper and `Intl`-based date formatting. |
| State | `src/ui/store.ts` | Holds the notes, the filter state and the selection; owns autosave; emits typed change events. Framework-free and free of DOM access. |
| Views | `src/ui/list-view.ts`, `src/ui/editor-view.ts` | Virtualized list rendering and the editor pane. |
| Wiring | `src/ui/notes.ts` | Connects the store to the views and the toolbar. |
| Background | `src/background/` | Service worker whose only job is keeping the Space registered. |

Key decisions and why:

- **No UI framework.** The page is one toolbar, one virtualized list and one
  editor. A hand-written store plus keyed DOM updates keeps the bundle small,
  keeps re-render cost bounded and predictable, and avoids pulling in a runtime
  for a three-region layout.
- **A repository interface, not direct IndexedDB calls.** The UI cannot tell how
  notes are stored. Bulk replacement is one atomic repository operation, while
  the portable codec remains independent of its file-download transport.
- **Pure functions for search/filter/sort/preview.** These are the parts most
  likely to grow (and most likely to break silently), so they are synchronous,
  free of side effects, and directly unit-tested.
- **In-memory filtering over a cached lowercase haystack.** With 1 000–10 000
  small notes a single O(n) pass with a cheap colour/format check before the
  substring test is faster and far simpler than an index, and it can never go
  stale. Rows are only materialized for the visible window.
- **Sanitize by allowlist, never by blacklist.** Raw HTML inside Markdown is
  escaped at render time, and the result is additionally passed through a strict
  element/attribute/URL-scheme allowlist. See [Markdown safety](#markdown-safety).
- **Idempotent space registration.** Thunderbird keeps extension spaces in memory
  only, and `spaces.create()` throws if a space with the same name already exists,
  so registration always queries first and treats "already exists" as success.

### Markdown safety

User content is never inserted with a naive `innerHTML`. Two independent layers
apply:

1. **Raw HTML is not supported at all.** `marked`'s `renderer.html` is overridden
   so any HTML in a note body is emitted as escaped text instead of markup.
2. **Allowlist sanitization.** The rendered result is parsed in an inert
   `<template>`, walked, and every element outside a small allowlist is unwrapped
   or removed (with `<script>`, `<style>`, `<iframe>`, `<svg>`, `<form>` and
   friends dropped together with their content). Comments are removed. Attributes
   are restricted per tag, `href`/`src` values must use an allowed scheme (`http`,
   `https`, `mailto`, `tel`, `moz-extension`, or be relative), `rel` is limited to
   a safe set, and links get `rel="noreferrer noopener"`.

The page's Content Security Policy adds a third, independent layer:
`default-src 'none'`, `connect-src 'none'` and `img-src 'self' data:`, so even a
sanitizer bypass cannot turn a note into a network request.

`src/markdown/markdown.ts` exposes `sanitizeHtml`, which is idempotent and
unit-tested against scripts, event-handler attributes, `javascript:`/`data:`
URLs, control-character-obfuscated schemes, and unknown tags.

---

## Testing

`pnpm test` builds the extension and the test bundles with esbuild, then runs
Node's built-in test runner. The suites cover:

| Suite | Covers |
| --- | --- |
| `model` | Note normalization, invalid-record repair, `revision`/`updatedAt` semantics, format switching without content conversion. |
| `preview` | Title/excerpt derivation for plain and Markdown notes, markdown stripping, truncation, CRLF handling, empty notes. |
| `query` | All four sort orders, deterministic tie-breaking, case-insensitive substring search, colour and format filters, combined filters, and a 10 000-note performance guard. |
| `markdown` | Sanitizer behaviour (scripts, event handlers, URL schemes, `rel`, comments, unknown tags), idempotency, core Markdown rendering, escaped raw HTML. |
| `migrations` | Migration chain integrity, upgrade from version 0, dropping unreadable records, forward compatibility. |
| `store` | Autosave debounce/coalescing, flush on note switch, no-op suppression, failure handling and retry, selection after delete, cancelling a queued write for a deleted note, filter/sort recomputation, and initial-selection restore (valid id / deleted id / nonsense id / id hidden by the restored filter / empty list). |
| `preferences` | UI preference validation (unknown sort/colour/format, empty ids, non-objects), round-tripping through a fake `storage.local`, that the search query is not part of the stored shape, corrupt-record repair, and graceful degradation when storage throws or is absent. |
| `portable-codec`, `portable-file`, `portable-errors` | Canonical JSON backup round-trips, strict external validation, transport limits, structured/localized errors, and rejection of malformed or unsupported data. |
| `portable-plan`, `portable-controller` | Merge conflict policies, deterministic planning, 10 000-note scaling, write barriers, authoritative re-planning, stale-confirmation rejection, and collision-free Keep both materialization. |
| `repository-replace`, `indexeddb-replace` | Atomic whole-dataset replacement in memory and one IndexedDB transaction, including rollback after an injected write failure. |
| `data-dialog` | Export of current in-memory edits, import summaries, Restore safety steps, source changes, and TOCTOU-driven reconfirmation. |
| `space` | The Space button contract: the name matches Thunderbird's `^[a-zA-Z0-9_]+$` rule, the page URL is relative, `themeIcons` is explicitly cleared to `null`, and `defaultIcons` is selected **from the resolved theme** — dark glyph in the light theme, light glyph in the dark theme. Regression coverage includes the page-to-worker mode message, a DOM-less worker falling back to Light while the page resolved Dark, an in-flight startup race, and worker restart from the stored resolved mode. Also: only relative paths, exactly the 16/32 px sizes, every declared file exists, and the artwork is self-contained with no context paint keyword. |
| `theme` | Colour parsing (`#rgb`, `#rgba`, `#rrggbb`, `rgb()`, `rgba()`, arrays), luminance, `color_scheme` detection, colour-based fallback, media-query fallback. |
| `i18n` | `t()` resolution order and fallbacks, positional and named placeholder substitution (including placeholders the platform leaves unexpanded), not substituting a wrong value, catalogue integrity, locale-driven date formatting. |
| `ui` | Loads the **real** `src/ui/notes.html` and asserts every element id the page script looks up exists and every `data-i18n*` attribute resolves to a real key. Drives the real editor, list and store together against a linkedom DOM: caret preservation, format/colour switching through actual clicks, live list preview while typing, list re-ordering on sort change, the row timestamp following the sort field, the footer counter in every list situation, the panes' structural invariants, responsive CSS invariants, virtualized windowing, roving tabindex, empty state, and sanitized preview. Also checks the primary button's state colours: every state has an explicit foreground/background pair meeting a contrast floor, hover cannot wash out the label, the disabled state is distinct from hover and carries a non-interactive cursor, and no `filter` is applied. |

`pnpm run verify` then validates the **built artifact**:

- manifest correctness, `__MSG_*__` resolution and locale completeness;
- that the manifest version matches `package.json`;
- that every asset referenced by the page or the CSS exists;
- that the `[hidden]` reset rule is present;
- that the Space icon files contain **no** context paint keyword, carry a literal
  colour, and that each 16/32 px pair really differs between dark and light — so an
  invisible or never-changing icon cannot ship;
- that the page CSP blocks remote images and connections;
- that the bundles contain no network entry points or remote assets.

The suite deliberately includes regression tests for bugs found during
development — for example that changing a note's format actually updates the
editor controls, that changing a sort order actually re-orders the rendered rows,
that a row's date matches the sort field, that the footer counter always contains
both numbers, and that creating a note (which widens the filter) keeps the
colour-filter buttons in step with the applied filter.

### What the tests do not cover

The tests cannot launch Thunderbird, so the following were verified by
construction, source review and manual testing rather than by execution:

- the appearance and placement of the Spaces-toolbar button, whether Thunderbird
  displays the selected `defaultIcons` glyph correctly in Light and Dark themes,
  and live switching across built-in and third-party themes (see
  [Space icon and themes](#space-icon-and-themes));
- the real rendered geometry of the responsive breakpoints (the tests assert the
  CSS contract — breakpoints, `data-pane` switching, wrapping rules — not pixels);
- Thunderbird actually persisting and restoring the extension's IndexedDB and
  `storage.local` across restarts;
- that `theme.getCurrent()` reports `color_scheme` for every third-party theme;
- that a note's last edit always reaches disk if the space tab is discarded the
  instant you stop typing (the write is asynchronous by nature).

These are the first things to check when installing the XPI manually.

---

## Known limitations

These are real and deliberate, not oversights:

1. **Backup/import is user-initiated.** ThunderNotes does not automatically sync
   backups or choose a storage destination. Every export opens system Save As;
   the user chooses the folder/name, and completion is reported by Downloads API.
   Keep the ThunderNotes page open until saving finishes: Blob URLs belong to
   their page context. Closing/unloading that page can interrupt an active export.
2. **Theme detection has three tiers, not one guaranteed signal.** Thunderbird's
   built-in Light and Dark themes declare `properties.color_scheme`, which is
   detected exactly. For third-party themes that only set colours,
   ThunderNotes falls back to the luminance of the theme's background colours, and
   finally to `prefers-color-scheme`. A theme that sets neither a colour scheme nor
   a usable background colour may be classified by the media query alone, which in
   a Thunderbird document follows the embedding chrome window. There is no
   documented API that returns "is Thunderbird dark" unconditionally.
3. **The Space icon is chosen by the extension, and depends on the theme being
   resolved correctly.** A service worker has no DOM media query, so the page sends
   its resolved mode explicitly and the background serializes icon updates. The
   last page-resolved mode is retained as the worker-startup fallback. If
   Thunderbird rejects an icon path it logs `Invalid icon data:` and drops the
   property, leaving the button with no icon. See
   [Space icon and themes](#space-icon-and-themes).
4. **`themeIcons` is deliberately unused.** Automatic icon selection was manually
   demonstrated to produce contradictory results for a custom space button, so the
   extension decides instead. The property is explicitly cleared to `null` on every
   update, because `spaces.update()` merges button properties.
5. **Context paint must not be used for a Space icon.** The mechanism that makes
   Thunderbird's *built-in* space icons theme-aware does not reach a custom button:
   manual testing showed a `context-stroke` glyph rendered completely invisible.
   The artwork is therefore self-contained. This is recorded so the approach is not
   retried.
6. **The note list is windowed, not content-virtualized.** Row height is fixed at
   68 px (fixed in both CSS and TypeScript, with a test asserting they agree), so
   previews are truncated rather than allowed to grow a row. This is what makes
   10 000 notes scroll smoothly.
7. **Search is a plain case-insensitive substring match.** No fuzzy matching, no
   stemming, no word-boundary or ranking logic.
8. **No rich text and no attachments.** The editor is a plain `<textarea>`; all
   formatting is Markdown source.
9. **Remote images in notes do not load.** `img-src` is restricted to the
   extension's own files, so `![](https://…)` renders as a broken image rather
   than making a network request. This is intentional: the extension should not
   leak that you opened a note. Loading local (`moz-extension:`) images works.
10. **No folders, tags, or categories other than colour**, by design.
11. **Colour is a single value per note.** There is no multi-colour tagging.
12. **`revision` is maintained but not yet used.** It is incremented on every
    change so a future sync layer can do conflict resolution without a migration.
13. **Markdown raw HTML is unsupported**, again by design.
---

## Space icon and themes

The Space toolbar icon is **selected by the extension**, not by Thunderbird: the
effective Light/Dark theme is resolved at runtime and one concrete set of icons is
handed over through `defaultIcons`.

> **Runtime facts:** testing in a real Thunderbird 156 instance showed that letting
> Thunderbird choose the icon (via `themeIcons`) produced contradictory results,
> and that context paint renders nothing for a custom space button. A later runtime
> test also showed that independently resolving the theme in the DOM-less worker
> can leave the dark glyph active while the page is correctly Dark. The current
> synchronization path therefore still requires manual Thunderbird verification.

### Two disproved hypotheses, recorded so they are not retried

**1. Reusing the built-in icons' context-paint mechanism (tried in 0.1.1).**

Thunderbird's *built-in* space icons adapt because
`mail/themes/shared/mail/spacesToolbar.css` paints
`.spaces-toolbar-button > img` with `-moz-context-properties` and
`stroke: currentColor`, so a monochrome SVG follows the theme by itself.

**Manual testing disproved it**: with `defaultIcons` + `context-stroke` and no
`themeIcons`, the space button was created and its active background rendered
correctly, but the **glyph was completely invisible** — the context paint never
reached the custom button's image.

> The CSS that makes Thunderbird's built-in space icons theme-aware does **not**
> apply to a custom space button. `context-stroke` / `context-fill` must not be
> used for a Space icon.

**2. Letting Thunderbird pick between two glyphs with `themeIcons` (tried in
0.1.2 and 0.1.3).**

Thunderbird 156 documents `ThemeIcons` as `dark` = "the dark icon to use for
*light* themes" and `light` = "a light icon to use for *dark* themes", i.e. the
fields name the artwork and map to the opposite theme. Its implementation reads that
way too: `IconDetails._normalize` feeds `themeIcons.light` into the `light` CSS
variable, which `webextensions.css` selects under
`@media (prefers-color-scheme: dark)`.

Manual testing gave **contradictory results for both possible mappings**: with the
documented order the dark theme rendered the dark glyph, and inverting the order did
not reliably match the expectation either. Rather than swap the mapping a third
time, the automatic mechanism was dropped entirely.

### How the icon is chosen now

1. `src/theme/detect.ts` resolves the **effective theme mode** with a three-tier
   fallback:
   `theme.getCurrent().properties.color_scheme`, then the luminance of the theme's
   background colours, then `prefers-color-scheme`. The final media-query tier is
   available to the page, but not to the background service worker.
2. `buildButtonProperties()` maps that mode to one concrete icon set:

   | Effective theme | Glyph | Files |
   | --- | --- | --- |
   | light | **dark** | `notes-glyph-dark-16.svg`, `notes-glyph-dark-32.svg` |
   | dark | **light** | `notes-glyph-light-16.svg`, `notes-glyph-light-32.svg` |

3. That set is passed as `defaultIcons`, and `themeIcons` is explicitly set to
   `null` — `spaces.update()` **merges** properties, so this is what clears the
   sets registered by 0.1.2/0.1.3.

The page sends its already-resolved `light` or `dark` mode to the worker at page
startup and on every change. Space mutations are serialized, so an older worker
fallback cannot finish later and overwrite that mode.

### When it is re-evaluated

- **At registration / worker restart.** The worker uses a decisive theme API result
  when available; otherwise it falls back to the last page-resolved mode stored in
  `browser.storage.local`.
- **When the page starts or its effective mode changes.** The page sends the actual
  resolved mode over `runtime.sendMessage`, and the worker applies the matching
  `defaultIcons` directly.
- **On `theme.onUpdated`.** The worker consumes the event's new theme and queues the
  update through the same coordinator, preventing competing `spaces.update()` calls
  from completing out of order.

### Icon files

- The glyphs are **self-contained SVGs with literal colours** — no context paint
  keyword anywhere, since that renders nothing here.
- The two glyphs differ in colour, and the 16 px and 32 px file of each is the same
  artwork at exactly 2x (both asserted by tests).
- `manifest.icons` (add-ons manager, extension lists) uses separate
  `notes-solid-{16,32,64}.svg`, because that surface has no theme to match.

### If the icon still looks wrong

Check the Browser Console for an `Invalid icon data:` warning — Thunderbird logs it
(and drops the property) when it rejects an icon path. Otherwise the likely causes
are `defaultIcons` no longer being set, `themeIcons` not being cleared, or the
effective theme being resolved incorrectly — which would also make the page's own
Light/Dark styling wrong, so the two are easy to compare.

---


## Roadmap

Deliberately small next steps, in the order they make sense. The architecture is
already shaped for each of them — none requires a rewrite.

1. **Mail links.** Associate a note with a message; create a note from a selected
   message; open the linked message. This lands as optional fields on `Note`
   (already designed for via `schemaVersion` and the `meta` bag) plus one
   migration, and a link section in the editor pane.
2. **Calendar and task links.** The same pattern against the `calendar` APIs.
3. **Device sync.** Device identity, QR pairing, local/P2P transfer, and
   `revision`-based conflict resolution.

Out of scope by intent: cloud accounts, telemetry, collaboration, AI features,
folders, tags, rich text, and attachments.

---

## License

MIT.
