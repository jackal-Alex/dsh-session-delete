# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-10-18

### Fixed

- The two Session-row menu entries rendered one size larger than the shipped
  menu items. The rows used a bare `<button>` with `font: inherit`, and the
  menu's `font-size: 13px` lives on its own `.item` class rather than on an
  ancestor, so `inherit` picked up the page's 16px. Rows now get an injected
  stylesheet that mirrors the shipped menu cell exactly: `font-size: 13px`,
  `line-height: 20px`, `min-height: 34px`, `padding: 6px 8px`, the
  `--dsw-radius-md` corner, and the `--dsw-alias-interactive-bg-hover` fill.

### Added

- Hover and `:focus-visible` states for both rows.
- The destructive row uses `--dsw-alias-state-error-primary` text with
  `--dsw-alias-interactive-bg-hover-danger` hover, matching the primitive's
  own danger row.
- A hairline separator above the group of two entries
  (`0.5px solid var(--dsw-alias-border-l2)`).
- `tests/client.test.mjs` now asserts the injected metrics, so this regression
  cannot come back unnoticed.

## [0.1.0] — 2026-10-18

### Added

- Two Session-row menu entries under `sidebar.workspaces.session.menu.item`:
  move a session to `~/.dsh/session-trash` (restorable), or move and purge it.
- Host routes under `/api/session-delete`: `list`, `trash`, `delete`,
  `restore`, `purge`, all exact paths and JSON.
- Mutations require an `x-dsh-session-delete: 1` header as a CSRF fence.
- Deletion is a directory `rename`, so a session that is still open on Windows
  fails as `in-use` instead of being half-removed; every delete is reversible
  until purged, and `meta.json` records the original workspace.
- Tests: host file operations, route behaviour (405/403/404/400 edges), and the
  browser bundle's module-loader wiring.
