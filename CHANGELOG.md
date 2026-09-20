# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-09-20

First released version. Everything before this was developed in place on
`main` and installed by hand, never tagged — so `zylos add zylos-ai/zylos-browser-remote`
could not resolve a release to install. This release exists to make the
component installable and to close the gaps against
[`COMPONENT-SPEC.md`](https://github.com/zylos-ai/zylos-component-template)
tracked in issue #1.

No relay, extension-protocol, or CLI behavior changes: every runtime code
path is byte-identical to 0.3.0.

### Added
- `hooks/post-install.js` — creates the data directory, `logs/` (which
  `ecosystem.config.cjs` already pointed `error_file`/`out_file` into) and
  `observations/`, all 0700. Does not mint a connection key; keys are issued
  on request via `scripts/key.js`.
- `hooks/pre-upgrade.js` — backs up `keys.json` before an upgrade. Keys are
  stored as sha256 digests, so a lost `keys.json` cannot be reconstructed and
  every paired extension would have to be re-paired by hand.
- `hooks/post-upgrade.js` — creates `logs/` on installs that predate it, and
  tightens any data directory or `keys.json` left at permissive modes by an
  older version.
- `hooks/configure.js` — spec §5.2 conformance. The component declares no
  `config.required` items, so zylos collects nothing and this hook is a no-op
  in practice; it is the landing spot if a setting is ever added.
- `CHANGELOG.md`, `LICENSE` (MIT) — required by spec §2.1.

### Changed
- Unit tests moved from `tools/*.test.js` to `test/*.test.js` to match the
  spec layout and the `zylos-lark` reference component; `npm test` updated to
  match. `tools/smoke.js` and `tools/test-cli.js` stay in `tools/` — they are
  end-to-end harnesses, not unit tests, and are still run by `npm test`.
  Same 24 tests pass before and after the move.
- `SKILL.md` declares `lifecycle.hooks`, and its `version` (stale at 0.3.0)
  now matches this release.

### Known gaps
- The repository layout still uses `relay/server.js` as the entry point
  rather than the spec's `src/index.js` + `src/lib/` (issue #1, item 6).
  This is a layout deviation, not a defect: the entry is declared correctly
  in `lifecycle.service.entry` and works. Restructuring it is the one change
  that would touch the running service, so it is deliberately left out of
  this release and remains open for a separate decision.

### Upgrade Notes
Existing hand-installed deployments need no action. The service entry, ports
(3802 extension lane / 3803 agent lane), data directory layout and wire
protocol are unchanged, and `keys.json` is preserved across upgrades — no
re-pairing of connected extensions is required.
