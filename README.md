<p align="center">
  <img src="assets/icons/notes-solid-64.svg" alt="ThunderNotes logo" width="72" height="72" />
</p>

# ThunderNotes

ThunderNotes is a local notes extension for Mozilla Thunderbird. It adds a
dedicated Space where you can create a note and start typing, with autosave and
no required title. It needs no account or cloud backend and has no telemetry.

This source tree prepares **0.4.0**. Published builds are listed in GitHub Releases.

## Features

- Plain Text and Markdown notes; switching format preserves the source text.
- Autosave, content-derived list previews and immediate editing of new notes.
- Markdown Edit/Preview; existing Markdown notes reopen in Preview.
  Double-click empty Preview space to enter Edit without interrupting text selection.
- Contextual Markdown shortcuts: Ctrl/Cmd+B for bold, I for italic, K for links
  and backtick for inline code. Bold, italic and inline code support toggling.
- List/task-list continuation, paired brackets, parentheses and backticks,
  and four-space Tab / Shift+Tab indentation in the Markdown editor.
- Nested ordered-list numbering, subtree indentation and hierarchical markers
  in Preview; saved content remains standard Markdown.
- Live search, colour marking/filtering and Created/Updated sorting.
- Created-date range filter with a calendar and month/year navigation;
  inclusive local dates, reset and no persistence between sessions.
- Delete confirmation, also available through Delete when the note list has focus.
- Portable Data v1 JSON backup, Merge import and Restore with a safety backup;
  export opens the system Save As dialog.
- Favorites, pinned-first ordering, and local one-shot reminders with system notifications.
- Native message action to create/open a primary note, with a confirmed unlink
  control in the note header. Markdown `/mail` inserts independent message links
  through a searchable picker with a lightweight hover text preview.
- Responsive two-pane/single-pane layout, live Light/Dark themes, English and Russian.

## Privacy / local-first

Notes are stored locally in the extension's IndexedDB database. ThunderNotes
does not sync notes over the network, collect telemetry or load remote assets.
The required permissions are `alarms` for local reminder scheduling, `downloads`
for explicit backup export and `messagesRead` for local message metadata search,
identification and navigation. The optional `notifications` permission is requested
only from the explicit Set reminder action. ThunderNotes
does not read attachments. The `/mail` picker can show a small text excerpt after
deliberate hover; excerpts are temporary and are not saved in notes or backups.

If persistent storage is unavailable, a warning explains that notes are held
only for the current session. Keep backups before removing the extension.

## Installation

Requires **Thunderbird 128.0 or newer**. Download the XPI from
[GitHub Releases](https://github.com/nickkho0201/ThunderNotes/releases/latest).

1. Open Thunderbird → **Tools → Add-ons and Themes**.
2. Open the gear menu → **Install Add-on From File…**.
3. Select the downloaded XPI and confirm installation.
4. Open the **Notes** Space and choose **New note**.

## Development

Use Node.js 22 or newer and pnpm; see the
[development requirements](docs/DEVELOPMENT.md#requirements) for details.

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run package
```

Build commands, temporary installation, verification and the release workflow
are documented in [Development](docs/DEVELOPMENT.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md): data model, state, storage, Markdown,
  Portable Data and Thunderbird integration.
- [Development](docs/DEVELOPMENT.md): setup, scripts, tests, packaging and runtime QA.
- [Changelog](CHANGELOG.md): user-visible release history.
- [AGENTS.md](AGENTS.md): operational rules for coding agents.

## License

[MIT](LICENSE).
