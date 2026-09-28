# AGENTS.md — zylos-browser-remote engineering conventions

This file binds every agent (Claude, Codex, or any other) that develops,
reviews, or releases in this repository. CLAUDE.md points here. Extend it
with component-specific rules as the project grows, but do not remove the
Release Process section below.

## Project Conventions

- **CommonJS** — `require()`/`module.exports`, with `"type": "commonjs"` in
  package.json. This is a deliberate, repository-wide deviation from the
  Zylos component template, which specifies ESM. Every file under `src/`,
  `scripts/`, `tools/`, `hooks/` and `test/` is CommonJS today, and
  `hooks/configure.js` documents the choice inline. A migration to ESM is an
  open decision, not a settled one — see "Open: ESM migration" below. Until
  it is settled, new files follow the existing CommonJS style; do not mix
  module systems within the repository.
- **Node.js 20+** — Minimum runtime version
- **Conventional commits** — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- **Runtime state lives in `~/zylos/components/browser-remote/`** — never
  committed; code is disposable, data is permanent. `config.json` there is
  **optional**: the component declares no `config.required` items, so a fresh
  install runs with no file at all. It carries exactly one key today,
  `activityEnabled`; connection keys are credentials minted by
  `scripts/key.js`, never configuration. Ports and the monitor trace are
  deliberately environment-only — before adding a key, read DESIGN.md §3.1,
  including both "Why … NOT in `config.json`" subsections.
- **English for code** — Comments, commit messages, PR descriptions, documentation

### Open: ESM migration

The Zylos registry `CONTRIBUTING.md` lists ESM as a prerequisite for
registration, and the component template ships `"type": "module"`. This
repository does not currently satisfy that. Converting is a breaking,
whole-repository change touching every `require()` call site, the PM2 entry
point, and all four lifecycle hooks; it is tracked as its own decision and
must not be done incidentally inside an unrelated PR.

## Release Process (hard gate)

Version bumps happen **only in a dedicated release PR** — feature PRs carry
source + tests + CHANGELOG entries under `## [Unreleased]`, never a version
change. The release PR must update **all four files in the same commit**:

1. **`package.json`** — Bump `version`
2. **`package-lock.json`** — Run `npm install` after bumping package.json to sync the lock file
3. **`SKILL.md`** — Update `version` in the YAML frontmatter to match. zylos-core registers the installed version from this field and uses it to decide upgrades; a stale value causes repeated upgrade prompts
4. **`CHANGELOG.md`** — Convert the `## [Unreleased]` section into a `## [X.Y.Z] - YYYY-MM-DD` entry ([Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format)

Version bump commit message: `chore: bump version to X.Y.Z`

After merge, create a GitHub Release with tag `vX.Y.Z` from the merge commit.

Machine gate vs process gate: `test/release-consistency.test.js` enforces the
**final-tree** half of this rule only — the suite fails whenever the four
version faces disagree in the working tree. The dedicated-release-PR and
same-commit requirements are process gates, guaranteed by the release flow
and review, not provable by this test. Keep the test passing and keep its
negative controls intact — a gate that cannot fail proves nothing.

## Testing

- `npm test` runs `node --test test/*.test.js`, then `tools/smoke.js` and
  `tools/test-cli.js`
- The release-consistency gate (above) ships with the scaffold and must stay
- When a test guards specific logic, prove it can fail: temporarily break the
  guarded behavior (a known-bad mutant), confirm the test goes red, restore
  the behavior, and confirm it goes green again

## Deployment surface

Exactly one port is publicly reachable: the extension lane on `:3802`,
key-authenticated, serving the single path `/ext`. The agent lane on `:3803`
is loopback-only and must never be given a public route. The public route is
declared in `SKILL.md` `http_routes` and applied by zylos-core; do not
instruct users to hand-edit the Caddyfile. See DESIGN.md §5.
