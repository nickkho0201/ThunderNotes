# Architecture

This document describes ThunderNotes 0.2.2. For build and contributor workflows,
see [Development](DEVELOPMENT.md); for user-facing features, see the
[README](../README.md).

## Overview

ThunderNotes is a local-first Thunderbird extension using Manifest V3 and the
modern `spaces` API. A framework-free extension page owns the note list, editor
and store. The background module registers the Space and coordinates its theme
icon; it does not own the note dataset.

The main flow is:

```text
editor/toolbar event → NoteStore → derived query + views
                            ↓
                     NotesRepository → IndexedDB
```

The store updates in-memory state immediately and persists through the repository.
Pure domain/query functions do not access the DOM or Thunderbird APIs. Portable
Data encoding and import planning are separate from file delivery and UI.

## Project structure

| Location | Responsibility |
| --- | --- |
| [src/notes/](../src/notes/) | Note model, normalization, content-derived previews and query functions. |
| [src/storage/](../src/storage/) | Repository contract, IndexedDB, migrations, memory fallback and UI preferences. |
| [src/ui/](../src/ui/) | Store, page wiring, list/editor views, dialogs, calendar and source-editing helpers. |
| [src/markdown/](../src/markdown/) | Bundled `marked` rendering and strict sanitizer. |
| [src/portable/](../src/portable/) | Portable Data codec, import planning/commit coordination and backup file transport. |
| [src/background/](../src/background/) | Space registration and serialized icon/theme updates. |
| [src/theme/](../src/theme/), [src/i18n/](../src/i18n/) | Effective theme detection, localization and locale-aware formatting. |
| [src/api/](../src/api/) | Hand-written types and access boundary for the Thunderbird APIs used. |
| [_locales/](../_locales/), [assets/](../assets/) | English/Russian catalogues and local static assets. |
| [tests/](../tests/), [scripts/](../scripts/) | Regression coverage, build, packaging and artifact checks. |

## Note model

[Note](../src/notes/model.ts) stores:

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier; newly created notes normally use a UUID. |
| `content` | Source text, shared by Plain Text and Markdown. |
| `format` | `plain` or `markdown`; changing it does not convert content. |
| `color` | One of six palette colours, or `null`. |
| `createdAt`, `updatedAt` | Millisecond timestamps. |
| `revision` | Starts at 1; increments once per real content/format/colour change. |
| `schemaVersion` | Optional in the local TypeScript shape for historical records; current schema is 1. |
| `meta` | Optional extension bag; Portable Data requires JSON-compatible values. |

There is no stored title. The list derives a title from the first non-empty
readable line and an excerpt from subsequent text, with truncation and simple
Markdown stripping. This cheap display derivation is distinct from full rendering.

Revision/timestamp changes happen in memory before autosave. Unchanged edits keep
the original object and do not queue writes. Revision also participates in
Portable Data equality/conflict checks; it is not a synchronization service.

## State and UI

### Store and views

[NoteStore](../src/ui/store.ts) owns notes, lookup/search caches, selection,
filters, save status and persistence coordination. Typed events notify the views.
The editor avoids assigning textarea content when it has not changed, preserving
caret and selection during rendering. The list renders a window of fixed-height
68 px rows rather than materializing the entire dataset.

The page uses two panes at normal widths and a list/editor single-pane workflow
below 780 px. Other CSS breakpoints adjust list width and toolbar wrapping.
The footer reports visible/total counts; row timestamps follow the active sort field.

### Query and preferences

The [query pipeline](../src/notes/query.ts) applies search, colour, format and
created-date filters with AND semantics, then sorts by Created/Updated in either
direction. Search is a trimmed, case-insensitive substring match on cached
lowercase content. Equal timestamps use the note ID as a deterministic tie-break.
The format filter exists in store/query/preferences but has no separate toolbar
filter control in 0.2.2; the editor format switch changes the selected note.

Date boundaries are local midnight and the calendar day after the selected end,
using calendar arithmetic rather than adding 24 hours. Both user-selected dates
are inclusive. Invalid ranges do not apply a date restriction. The calendar keeps
a draft first click separately from the applied range; the second click orders
the endpoints and applies it. Navigating months/years does not change the filter.

Preferences under `thundernotes.ui.v1` in `browser.storage.local` include sort,
colour filter, format filter and last selected ID. Search and date range are
session-only. Initial selection restores an ID only if it exists and is visible;
otherwise it selects the first visible note. Creating a note clears excluding
filters as needed so capture does not hide the newly created note.

### Autosave and deletion

Autosave uses a 400 ms debounce. A note switch, page hide or page exit initiates
pending writes immediately. Errors are exposed through save/error state, with
failed surviving edits retained for retry. A flush is best effort: it cannot
guarantee completion if the page/process is immediately destroyed.

The delete button and list-context Delete key share one confirmation request.
The shortcut accepts only the focused list or its selected direct row, never
editor/Preview/control focus. The store removes queued edits for the deleted
note, waits for earlier writes before repository deletion and tracks pending
deletes, preventing a late update from recreating the record. Confirmation is
not an undo/recycle-bin mechanism.

## Storage

[NotesRepository](../src/storage/repository.ts) is the persistence boundary.
Normal editing updates one note record; imports use its atomic `replaceAll`.
The extension-owned IndexedDB database is `thundernotes`, with `notes` keyed by
ID and a `meta` store recording schema version. Created/Updated indexes exist,
while the UI currently queries its in-memory dataset.

`DB_VERSION` and `CURRENT_SCHEMA_VERSION` are both 1. Ordered migrations run during
`onupgradeneeded`. A future persistent schema change must coordinate the database
version, migration chain and model version. Local record normalization tolerates
historical/partially corrupt input and skips unreadable records with a warning;
external imports use a different, strict validator.

Opening failures select [MemoryNotesRepository](../src/storage/memory.ts) and a
visible non-persistence warning. This is a session fallback, not recovery of the
unavailable database. Preferences degrade separately if `storage.local` fails.

## Markdown

### Rendering and security

[Rendering](../src/markdown/markdown.ts) uses bundled `marked`, with GFM enabled
by default. Raw HTML tokens are escaped. A detached-template sanitizer restricts
elements, attributes and URL schemes, removes executable/unsafe content and
comments, and stabilizes serialization through repeated passes. Links receive
safe `rel` values. User HTML is not a supported feature.

CSP is an independent restriction: `default-src 'none'`, local scripts/styles,
`connect-src 'none'`, `img-src 'self' data:`, and no objects, base changes or form
actions. HTTP(S) link targets may be followed explicitly, but remote images do
not load inside Preview. This does not make the extension a network client or
prevent the user from opening a link outside it.

### Preview and source editing

Existing Markdown notes enter Preview; new notes are Plain Text/Edit. Switching
the current note to Markdown keeps Edit. The pane is view state, not a stored
Note property. Empty-background double-click uses text-fragment geometry rather
than root target identity; selection is checked before the gesture, while rendered
text, links and painted content surfaces retain normal interaction.

[Markdown editing](../src/ui/markdown-edit.ts) binds only to the actual focused,
visible Markdown textarea and ignores composition. Formatting toggles remove
only unambiguous immediate delimiter pairs; links retain insert/wrap semantics.
List continuation, empty-item exit and predictable `[]`, `()` and backtick pairs
share the same source-mutation/input path. No curly-brace or aggressive emphasis
pairing is added.

Tab/Shift+Tab use four spaces, preserve selection/scroll, and move an ordered
subtree together. [Ordered-level helpers](../src/ui/ordered-levels.ts) identify
parents/sibling groups by indentation within continuous list lines. They adjust
only affected source/destination groups of consecutive numbering. Enter and
structural deletion keep child sequences independent. Blank lines, unrelated
text, fences and marker-style changes bound the scan; ambiguous numbering is
preserved rather than globally normalized. This is not a full Markdown parser.

Saved source always uses standard ordered markers, never `3.1. item`. Preview's
`li::marker` uses CSS `counters(list-item, ".")` for hierarchical labels, including
deeper levels, while retaining `ol[start]`. Bullet markers remain disc/circle/square.
Mixed bullet/ordered trees can include the intermediate bullet counter in the
hierarchical label; the saved source is unaffected.

## Portable Data

Portable Data v1 is a UTF-8 JSON envelope with `format` equal to
`thundernotes-portable-data`, `formatVersion: 1`, `exportedAt`, `appVersion` and
`notes`. Portable notes require the core fields plus `schemaVersion`; optional
`meta` must be JSON-compatible. The codec produces canonical output independent
of object-key/note input order. UI preferences are not part of the backup.

External validation rejects unsupported versions/schemas, unknown or missing
fields, duplicate IDs, invalid values/UTF-8 and malformed JSON before mutation.
Limits include 256 MiB, 100,000 notes and JSON depth 32. This boundary does not
silently repair imports using local-storage normalization.

Merge distinguishes new, identical and conflicting IDs. Policies are Keep both
(new collision-free IDs for conflicts), Keep current and Use imported. Restore
replaces the entire dataset with imported notes.

Before a confirmed import commits, the controller acquires the store's mutation
lock, establishes a write barrier for queued/in-flight writes and pending deletes,
and recalculates the plan from the authoritative snapshot. Changed plans require
reconfirmation. Repository replacement is atomic: IndexedDB clears/writes in one
readwrite transaction; memory replacement prepares a new map before swapping it.
The store adopts the replacement only after repository success.

Restore additionally requires a completed safety-backup export, explicit
acknowledgment and confirmation. The backup snapshot must still match at commit;
local changes invalidate the safety step. Export snapshots current in-memory
notes, including pending edits, rather than reading potentially older disk state.

Backup delivery uses `downloads.download` with `saveAs: true`, suggested name
`thundernotes-backup-<timestamp>.json`, and terminal download-state tracking.
Success follows completion; cancellation is neutral and failure is reported.
The Blob URL is retained until completion/interruption and then revoked.

## Thunderbird integration

The [manifest](../manifest.json) declares MV3 module `background.scripts`, not a
`background.service_worker` entry. The platform boundary uses only the required
Thunderbird APIs; note data stays in the page/repository layer. Space registration
queries before creating and runs at startup, installation and background boot.

Effective theme detection uses the declared colour scheme, background luminance,
then the page's media-query fallback. The page sends its resolved mode to the
background; icon changes are serialized and the last page-resolved mode is saved
under `thundernotes.resolvedThemeMode` for later background initialization.

The Space uses concrete `defaultIcons`: dark glyphs for Light, light glyphs for
Dark. `themeIcons` is explicitly cleared because updates merge properties.
Manual Thunderbird testing disproved reliable automatic `themeIcons` selection
and showed invisible custom icons with context paint. Self-contained literal-colour
SVGs remain the working strategy; Add-ons Manager icons are separate artwork.
If a glyph disappears, check the Browser Console for `Invalid icon data:` and
compare the page's resolved theme with the selected glyph.

English is the default locale; Russian is included. Strings use `browser.i18n`
with bundled fallbacks, positional substitutions and UI-locale `Intl` formatting.
`downloads` is the only permission. It grants platform download capabilities,
but backup tracking queries only the extension's active download ID. No host or
optional permissions, experiments, remote assets or telemetry are introduced.

## Safety invariants

The architecture keeps these boundaries explicit:

- Local source text is authoritative; no hidden sync or runtime code download.
- UI persistence uses `NotesRepository`, including atomic bulk replacement.
- Destructive UI actions require confirmation; Restore also requires a current
  safety backup and revalidated plan.
- Schema changes need a migration path, not deletion of the user's database.
- Imported data is strictly validated before mutation; Portable Data v1 remains
  separate from storage and UI-preference schemas.
- Sanitizer and CSP are independent protections; the permission set is minimized.

## Known runtime boundaries

Headless tests cover logic and DOM contracts, not Thunderbird integration pixels
or lifecycle guarantees. The 0.2.2 runtime QA confirmed Preview background/content
gestures, deep Gecko counter numbering, nested edits, Undo/Redo and restart
persistence. Changes in these areas still require fresh runtime QA.

Native undo uses the browser editing command when available, with `setRangeText`
as a fallback whose history behavior depends on the runtime. A final async flush
cannot guarantee data reaches disk after immediate page/process termination.
Keep the notes page open until an export finishes: its Blob URL belongs to that
page context. Theme reporting differs across themes/platforms; there is no single
unconditional effective-theme signal.
