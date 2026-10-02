# Architecture

This document describes the 0.2.2 baseline and the Unreleased message-link candidate.
The owner has confirmed the initial message → note → message and unlink flow in
real Thunderbird. Header polish and remaining message integration paths still
require QA. For build and contributor workflows,
see [Development](DEVELOPMENT.md); for user-facing features, see the
[README](../README.md).

## Overview

ThunderNotes is a local-first Thunderbird extension using Manifest V3 and the
modern `spaces` API. A framework-free extension page owns the note list, editor
and store. The background module registers the Space and coordinates its theme
icon and message actions; it does not own the note dataset. It may read the
repository for action labels, with a live-page fallback when IndexedDB is unavailable.

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
| [src/background/](../src/background/) | Space registration, serialized icon/theme updates and native message actions. |
| [src/theme/](../src/theme/), [src/i18n/](../src/i18n/) | Effective theme detection, localization and locale-aware formatting. |
| [src/api/](../src/api/) | Hand-written types and access boundary for the Thunderbird APIs used. |
| [src/messages/](../src/messages/) | Durable locators, metadata queries, relation helpers and acknowledged Space navigation. |
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
| `revision` | Starts at 1; increments once per real content/format/colour/metadata change. |
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
`downloads` grants platform download capabilities,
but backup tracking queries only the extension's active download ID. No host or
optional permissions, experiments, remote assets or telemetry are introduced.

## Message-linked notes and Markdown references

### Primary relation and persistence

One note owns at most one primary reference, in the typed
`meta["thundernotes.primaryMessage.v1"]` extension entry. It contains a version-1
locator (`headerMessageId`) and a subject snapshot. Optional `kind`, `author`,
`recipients` (To) and `date` (epoch milliseconds) extend that display snapshot;
there is never a body, attachment, whole MessageHeader or runtime numeric ID.
The locator remains authoritative and separate from display data. No localized
values or folder/account paths are stored. Note metadata is the only authoritative relation
store. Unlink uses the normal revision/autosave path and requires confirmation;
it leaves content, inline references and unrelated metadata untouched. Missing
messages keep their saved relation and display an unavailable state.

The note-header formatter uses the existing UI-locale date/time formatter.
Incoming displays author; outgoing/draft displays To recipients; unknown displays
explicit From/To labels instead of guessing direction. A compact localized kind
badge and a readable, truncated navigation link share a full title/ARIA identity.
The secondary unlink control reuses the local close icon and keyboard/focus states.
Unavailable presentation retains all saved identity fields and manual unlink.

Subject-only candidate references and incomplete optional snapshots remain valid.
When an old relation resolves, missing display fields are enriched through the
store's normal revision/autosave path. Enrichment does not rewrite content,
unrelated metadata or an already captured kind, and does not recreate an unlinked
relation. Unresolved references retain their previous snapshot without writes.

`NotesRepository.createForMessage` checks/adopts the existing owner or adds the
new record in a single IndexedDB readwrite transaction. The memory backend makes
the equivalent atomic decision. The page establishes a store write barrier and
mutation lock before this operation. Repeated requests and concurrent pages
cannot create two primary owners through the capture path. No database/schema
version or index changes are needed. After the write barrier, capture reloads the
repository dataset so a stale page cannot reopen an owner removed by another page.

Portable Data stays v1: its existing JSON `meta` area preserves relations, and
metadata remains part of equality/conflict planning. Imports without relations
remain valid. Valid relation-bearing imports preserve them; a resulting dataset
with two valid primary owners for one RFC identity is rejected before replacement,
including a Keep both conflict that would duplicate that relation. No imported
relation is silently stripped or reassigned. Choose Keep current/Use imported or
unlink the conflict first. Older builds preserve the unknown metadata bag.

### Native action and navigation

The supported `message_display_action` has no popup or chrome DOM injection.
Per-tab titles/enabled states derive from the displayed message and note owners,
with sequence guards against stale async updates. Labels read the repository;
only an unavailable persistent backend uses the live page's memory state.
A single displayed message
with a usable durable header offers New note or Open note. Physical placement
and toolbar customization belong to Thunderbird, not ThunderNotes.

Background capture queues a short-lived navigation intent under
`thundernotes.messageNavigation.v1`, opens the Space and wakes existing pages.
An existing Space window is reused through `tabs.query({ spaceId })` and focused;
the active background routes delivery only to that window. No `tabs` permission
or mail-tab URL inspection is needed.
A ready page claims a 30-second lease, creates/adopts the owner through its store,
selects it and acknowledges completion. Unacked intents survive background
restart; page readiness/visibility and a page-local retry recover delivery.
Repeated clicks coalesce by locator. Intents expire after 24 hours and are not
a relationship index. Newly created notes remain Plain Text and receive editor
focus; existing notes retain the normal Preview/Edit entry behavior.

### Locator, query and runtime boundaries

The official [messages API](https://webextension-api.thunderbird.net/en/latest/messages.html)
defines runtime numeric IDs as restart/move-unstable. The RFC `headerMessageId`
is queried against current local metadata before opening the resolved runtime ID
through [messageDisplay](https://webextension-api.thunderbird.net/en/latest/messageDisplay.html).
No match, multiple copies sharing that header, external file messages or malformed
locators fail safely. Copies are not guessed by stale folder paths.

Saved drafts can be referenced by their saved-instance header. Thunderbird's
[compose implementation](https://github.com/mozilla/releases-comm-central/blob/master/mailnews/compose/src/nsMsgCompose.cpp)
generates a new Message-ID for each draft save: these references do not follow a
logical draft through re-saving or sending. Missing old instances remain unavailable
without altering notes. Unsaved composition windows are outside the message-display
action. Picker dates use MessageHeader.date (the message's Date header), not
fabricated received timestamps or draft-creation times.

Primary snapshot dates have the same Date-header semantics: they are not claimed
to be received-at, draft-created or draft-last-updated timestamps.
`MessageHeader.folder` is withheld without `accountsRead`; this candidate does
not request it. Consequently normal runtime capture uses `kind: "unknown"` for
Inbox, Sent, Drafts and custom folders under the current permissions. The helper
can consume supplied `specialUse` evidence (`inbox`, `sent`, `drafts`); absent,
custom or conflicting evidence stays unknown. Sender-address and new/read-state
heuristics are not used. A previously captured known kind is preserved after a
move; folder use alone is not a universal persistent direction classifier.

### Message-list indicator boundary

No thread-pane marker is implemented. The supported
[mailTabs API](https://webextension-api.thunderbird.net/en/latest/mailTabs.html)
exposes selection, layout and sorting of existing columns, not a custom per-row
indicator. `message_display_action` applies to the opened-message toolbar.
The public custom-column API remains tracked in
[Thunderbird bug 1615801](https://bugzilla.mozilla.org/show_bug.cgi?id=1615801);
its documented implementation discussion explicitly excludes a backport to 128.
Internal `ThreadPaneColumns` hooks/Experiments are not a supported API for this
candidate. No chrome injection, tags, star/read changes or mail writes substitute
for a marker. Future support needs a shipped public API and a fresh version and
permission review; increasing the minimum version alone currently proves nothing.

### Metadata picker queries

The picker queries subject and author separately (OR, deduplicated by current ID),
following Thunderbird's author name/address matching semantics. No fullText,
body/attachment retrieval, account enumeration or online queries are used.
`messages.query` has no global date-sort parameter: bounded recent time windows
are bisected newest-first when a page fills, then collected headers are sorted
descending locally. Results are limited to 50 and 64 queries, with full lists
aborted rather than exhaustively loaded. A visible limited-results status covers
overflow, including many identical-date messages. The initial window includes up
to a year of future-dated mail, then expands backwards to the Unix epoch. Mail
outside these timestamp bounds is not included. No folder/account permission is
requested solely for result decoration.

`messagesRead` is the only new permission. The hand-written platform surface
exposes metadata query/pagination and message display, not MIME/body APIs.
ThunderNotes does not update message metadata, maintain backlinks in emails,
or send metadata over the network. Opening a message explicitly invokes normal
Thunderbird display behavior; Thunderbird itself may fetch that message.

### Markdown command and security

The focused Markdown textarea recognizes `/` tokens at line start/after whitespace;
URLs/paths/embedded words do not trigger the menu. `/mail` is explicitly confirmed
by Enter or mouse. A modal metadata picker owns search/results keyboard handling.
Cancellation leaves the command token untouched and restores editor selection.
An inserted reference uses the existing native-edit/range fallback and input flow.
Stale note/source offsets are checked before applying an asynchronous result.

Inline links are independent of primary metadata. The normal Markdown shape is
`[subject](thundernotes-message:v1/<canonical-percent-encoded-headerMessageId>)`.
The payload is versioned, deterministic and strictly validated; Markdown punctuation
in subjects is escaped. Sanitization permits only this exact internal destination
on anchors, not images or arbitrary protocols. Preview intercepts click, auxiliary
click and context-menu navigation; internal links never use external URL handling.
Malformed targets lose their href. Existing dangerous-scheme blocking and CSP
remain unchanged. Plain Text shows the exact source and exposes no slash/picker
or inline-link navigation; primary metadata remains format-independent.

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
