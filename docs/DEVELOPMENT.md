# Development

This document covers contributor workflows. See [Architecture](ARCHITECTURE.md)
for implementation boundaries and the [README](../README.md) for installation
and features. Coding agents must also read [AGENTS.md](../AGENTS.md).

## Requirements

- Node.js 22 or newer is recommended: test/verifier bundles target
  Node 22. `package.json` does not pin an engine; some locked dependencies require
  at least Node 20.19, so the old broad "Node 20+" guidance is insufficient.
- pnpm. Use the checked-in `pnpm-lock.yaml` and workspace configuration; the
  repository does not pin a package-manager version.
- Thunderbird 128.0 or newer for runtime testing, matching `strict_min_version`.
  API documentation alone is not evidence that a specific runtime path works.

## Setup

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
```

Make changes on a feature/fix/docs branch from current stable `main`. Keep
generated output and local user data out of Git. Preserve useful artifacts before
running clean or packaging commands that replace output directories.

## Commands

These are the scripts in [package.json](../package.json):

| Command | Effect |
| --- | --- |
| `pnpm run locales` | Generates the bundled localization fallback module. |
| `pnpm run typecheck` | Regenerates locales, then runs strict TypeScript checking without emit. |
| `pnpm run build` | Bundles the extension and copies static files into `dist/`. |
| `pnpm run build:test` | Bundles TypeScript test files into `build/test/`. |
| `pnpm test` | Builds the extension/tests and runs Node's built-in test runner. |
| `pnpm run build:verify` | Bundles the artifact verifier into `build/`. |
| `pnpm run verify` | Builds/runs the verifier against existing `dist/`; does not rebuild the extension. |
| `pnpm run xpi` | Builds, packages the XPI and verifies `dist/`. |
| `pnpm run package` | Typecheck → build/tests → XPI build/package → artifact verification. |
| `pnpm run clean` | Removes `dist/`, `build/`, `artifacts/` and the generated locale module. |

Build and typecheck regenerate the locale module when needed. There is no
separate release-publishing script and no watch script in `package.json`.

## Testing

Tests use `node:test` and `node:assert`; esbuild bundles the TypeScript sources
before execution. `linkedom` supplies a headless DOM. Storage and platform fakes
exercise failures and races without opening the user's Thunderbird profile.

The 0.2.2 release passed **533 tests in 79 suites across 25 test files**. Use the
actual runner summary for future reports rather than treating this as a target.

| Area | Coverage |
| --- | --- |
| Model/query | Normalization, revisions, derived previews, filters, local/DST dates, sorting and performance guards. |
| Storage/store | Autosave, selection, preferences, migration behavior, memory/IndexedDB replacement and rollback. |
| Markdown/editor | Sanitization, formatting toggles, autocomplete, Tab/Shift+Tab, nested renumber, caret/input flow and Preview hit geometry. |
| Portable Data | Strict codec validation, Merge policies, Restore safety, authoritative re-planning, barriers, Save As/cancel/error and URL lifecycle. |
| Platform/UI | Space/theme synchronization, i18n, permission allowlist, calendar/focus contracts, responsive CSS and real-page DOM wiring. |

CSS/layout tests assert contracts, not rendered pixels. Geometry helpers use
controlled rectangles; headless history-input coverage does not prove native
Undo/Redo. Runtime checks remain separate.

## Packaging

`dist/` is the unpacked extension: two browser-targeted bundles plus the manifest,
page, stylesheet, catalogues and local assets. Runtime `marked` is bundled; it is
not downloaded when the extension runs. `artifacts/thundernotes-<version>.xpi` is
the installable ZIP-format package.

The XPI writer sorts entries and uses fixed ZIP timestamps and uncompressed
contents. Packaging the same `dist/` produces the same bytes; full build
reproducibility also depends on the same source and resolved toolchain. Packaging
recreates `artifacts/`, so archive previous outputs elsewhere if they are needed.

The verifier checks version agreement, manifest/locales, exactly
`["downloads", "messagesRead"]`,
absence of host/optional/experiment permissions, asset resolution, hidden-state
CSS, theme-icon rules, CSP, network entry points and remote assets. These are
artifact checks, not a guarantee covering every possible runtime action.

The verifier checks `dist/`, not ZIP payload equality. For a release, also inspect
the XPI manifest, compare archive entries byte-for-byte with `dist/`, record its
SHA-256 and confirm the final main build reproduces that hash.

### Temporary installation

1. Run `pnpm run build`.
2. Thunderbird → Tools → Developer Tools → Debug Add-ons.
3. Choose **Load Temporary Add-on…** and select `dist/manifest.json`.
4. After rebuilding, use **Reload** on the Debug Add-ons page.

A temporary add-on disappears when Thunderbird closes. If the Space button is
missing on its first load, try Reload and inspect the Browser Console. For
persistent installation/restart testing, use the XPI through the Add-ons Manager
as described in [Installation](../README.md#installation).

## Verification pipeline

For implementation candidates and release preparation:

```bash
pnpm install --frozen-lockfile
pnpm run clean
pnpm run typecheck
pnpm test
pnpm run package
git diff --check
```

`package` repeats typecheck/tests intentionally and is the combined artifact
gate. Inspect its verifier output, not just whether an XPI exists. Check source,
package, dist and XPI versions agree and no unexpected tracked files changed.
On final `main`, repeat `pnpm run package`, `git diff --check`, manifest/hash checks
and clean-working-tree checks before pushing.

For documentation reviews, check relative links/anchors, script names, source
claims and docs-only scope; follow any additional checks required by the task or
agent contract. Never weaken tests or artifact rules to pass a gate.

## Manual Thunderbird QA

Use a packaged candidate in real Thunderbird. Automated success alone does not
authorize releasing runtime changes. Check the affected paths and nearby
regressions, especially:

- Focus after capture, contextual shortcuts and native navigation outside the editor.
- Preview geometry, selection, word double-click, links and empty-background gestures.
- Markdown indentation/nested lists, native Undo/Redo, autosave and reopen/restart.
- Space registration after install/reload/restart and absence of duplicate buttons.
- Light/Dark page/icon switching, narrow layouts and RU/EN labels/date formatting.
- System Save As: cancel, successful file creation and backup contents.
- Merge/Restore confirmations, safety backup and persistence after restart.
- Native message-action placement/state in multiple tabs/windows; cold/warm Space
  navigation, repeated clicks, unlink/delete and moved/unavailable message resolution.
- Markdown `/mail` focus, cancellation, keyboard navigation, subject escaping,
  recent/search ordering and internal Preview links, including saved-draft re-saving.

The message-link QA candidate retains manifest version 0.2.2 and is named
`thundernotes-0.2.2-message-links-qa.xpi`. Preserve the published artifact outside
`artifacts/` before clean/package replaces it. Temporary `dist/manifest.json`
testing is useful when same-version installation is refused; use persistent XPI
installation for restart tests. Do not remove the installed extension merely to
force an update: preserve notes with a backup and let the owner choose the setup.

Use the Browser Console for integration errors. A page exit only initiates
best-effort async writes; abrupt context destruction cannot be tested into an
unconditional durability guarantee. Relevant architectural limits are documented
in [Known runtime boundaries](ARCHITECTURE.md#known-runtime-boundaries).

## Release workflow

```text
feature/fix branch → implementation → automated verification → manual QA
→ approved version bump → release preparation → verified main
→ annotated tag → stable GitHub Release + verified XPI
```

Keep a candidate at the current published version until the owner approves its
runtime QA. A functional implementation commit and a separate release-preparation
commit keep the history understandable. Version sources are `manifest.json` and
`package.json`; do not change dependencies/lockfile merely for a version bump.
Update user-visible changes under [Unreleased](../CHANGELOG.md#unreleased), then
move them into the dated release entry during preparation.

Fetch and review before merging. Current practice is `--ff-only` into up-to-date
`main`; stop on unexpected remote changes or conflicts. After the main gate, push
without force, verify local/remote agreement, create an annotated version tag on
the exact release commit and publish a non-draft, non-prerelease GitHub Release.
Attach the verified XPI and compare the server digest when available.

Merge, push, tag and publication require explicit owner authorization; passing
tests is not that authorization. Keep working-tree changes for review when a
task has not authorized commits. See [AGENTS.md](../AGENTS.md) for the operational
contract rather than duplicating its full rules here.
