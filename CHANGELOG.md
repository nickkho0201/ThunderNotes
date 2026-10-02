# Changelog

Significant user-visible changes to ThunderNotes are recorded here. New changes
start under Unreleased. Release dates below are GitHub publication dates in UTC.

## Unreleased

### Added

- Native opened-message action to create or open one primary linked note;
  note-header message navigation, confirmed unlink and unavailable-message state.
- Markdown `/mail` command with a local metadata picker and independent inline
  message references, without embedding email bodies or attachments.
- `messagesRead` permission for message metadata lookup/search and navigation.

### Changed

- Primary message header uses a local envelope icon, prominent subject link,
  secondary participant/date context and an explicit localized Unlink control.
  Unknown direction uses neutral author → recipients presentation. Saved context
  remains visible when a message is unavailable; older subject-only relations enrich safely when
  resolvable. Kind stays unknown where supported metadata cannot establish it.

Message linking is a development candidate pending manual Thunderbird QA.

## [0.2.2](https://github.com/nickkho0201/ThunderNotes/releases/tag/v0.2.2) — 2026-10-02

### Fixed

- Double-clicking empty space in non-empty Markdown Preview now opens Edit;
  hit-testing preserves text selection and rendered-content interaction.
- Ordered-list numbering stays independent across nesting levels during Enter,
  insertion and structural deletion.
- Tab / Shift+Tab move ordered items with their nested subtree and recalculate
  the affected sibling groups.
- Nested ordered lists display hierarchical Preview numbering, such as `1.2`
  and `1.2.1`, while saved Markdown keeps standard numbered markers.

## [0.2.1](https://github.com/nickkho0201/ThunderNotes/releases/tag/v0.2.1) — 2026-10-01

### Added

- Contextual Markdown bold, italic, link and inline-code shortcuts; conservative
  formatting toggles for bold, italic and inline code.
- List/task-list continuation and paired brackets, parentheses and backticks.
- Four-space Tab / Shift+Tab indentation in the Markdown editor.
- Safe Delete shortcut in the note list, using the existing confirmation flow.
- Session-only created-date range filtering with calendar and month/year navigation.
- Double-click empty Markdown Preview space to enter Edit.

### Changed

- Existing Markdown notes reopen in Preview by default.
- Ordered lists renumber after insertion and structural deletion within a list group.
- Added the `downloads` permission for explicit backup Save As.

### Fixed

- Backup export opens system Save As and reports success after download completion.

## [0.2.0](https://github.com/nickkho0201/ThunderNotes/releases/tag/v0.2.0) — 2026-09-30

### Added

- Portable Data v1 JSON backup export and strict import validation.
- Merge with Keep both, Keep current and Use imported conflict policies.
- Restore / Replace with a mandatory safety-backup workflow.
- Import preview showing new, identical, conflicting and resulting note counts.
- English/Russian validation messages for Portable Data errors.

### Changed

- Import commits use atomic dataset replacement and revalidate stale previews;
  malformed or unsupported backups cannot produce partial imports.
- Backup exports include current in-memory edits.

## [0.1.5](https://github.com/nickkho0201/ThunderNotes/releases/tag/v0.1.5) — 2026-09-30

### Fixed

- Space toolbar icon follows the page-resolved Light/Dark theme and retains the
  resolved state across background restarts.
- Serialized icon updates prevent stale background detection from overriding
  a newer page-resolved theme.

## [0.1.4](https://github.com/nickkho0201/ThunderNotes/releases/tag/v0.1.4) — 2026-09-30

First manually verified stable release.

### Added

- Dedicated Notes Space, immediate note creation and autosave.
- Plain Text and Markdown modes, search, colour filtering and Created/Updated sorting.
- Responsive two-pane/single-pane UI with Light/Dark themes and English/Russian localization.
- Local IndexedDB note storage without an account, backend, telemetry or network traffic.

## Historical sources

Entries were reconstructed from the linked published release notes, matching Git
tags and commit ranges. The confirmed published history starts at 0.1.4; earlier
development experiments are not reconstructed as releases. Internal refactors,
test counts and documentation-only changes are intentionally omitted.
