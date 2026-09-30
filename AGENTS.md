# AGENTS.md — zylos-browser-remote engineering conventions

This file binds every agent (Claude, Codex, or any other) that develops,
reviews, or releases in this repository. CLAUDE.md points here. Extend it
with component-specific rules as the project grows, but do not remove the
Release Process section below.

## Project Conventions

- **ESM** — `import`/`export`, with `"type": "module"` in package.json, as
  the Zylos component template specifies. Every file under `src/`,
  `scripts/`, `tools/`, `hooks/` and `test/` is an ES module; new files
  follow suit, and the module systems are not mixed. Two deliberate
  exceptions: `ecosystem.config.cjs` stays CommonJS because PM2 reads it as
  a plain config file, and the throwaway scripts that tests write into temp
  directories are generated as CommonJS (`.cjs`, or extensionless with a
  shebang) because nothing above them declares a type. Three ESM constraints
  bind anything new here — see "ESM: three rules that are not optional".
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

### ESM: three rules that are not optional

The repository migrated from CommonJS to ESM in one dedicated change, which
also cleared the Zylos registry `CONTRIBUTING.md` prerequisite for
registration. Three traps surfaced during that migration. Each one fails
**silently**, so none of them is caught by a green unit-test run:

1. **Never test whether this file is the entry point with
   `import.meta.url === pathToFileURL(process.argv[1]).href`.** PM2 decides
   ESM-vs-CommonJS from package.json `"type"` and loads an ESM entry with a
   dynamic `import()` from inside its own wrapper, so `argv[1]` names the
   wrapper and that comparison is permanently false in the only deployment
   that matters — the service boots, reports healthy, logs nothing and never
   listens. Use `src/index.js`'s `isMainModule()`, which prefers
   `process.env.pm_exec_path` and `realpath`s both sides (a symlink in the
   path defeats a plain string compare).
2. **Never resolve a data-directory path at module load.** ESM evaluates
   every `import` before any statement in the importing module, so a test
   that sets `HOME` or `BROWSER_REMOTE_OBS_DIR` above its imports can no
   longer win that race. A load-time constant therefore captures the real
   `~/zylos/components/browser-remote/...` and the suite reads, writes and
   prunes the live store instead of its temp directory. `src/lib/config.js`
   and `scripts/attachments.js` resolve their paths per call for exactly
   this reason; keep it that way.
3. **Never assume a test can re-import a module to reset it.** There is no
   `require.cache` to delete and a module is evaluated once per process.
   Expose an explicit reset (`resetConfigCache()`) or a factory that takes
   its seams as arguments (`createClient()` in `scripts/relay-client.js`)
   rather than re-evaluating source text in a `vm` sandbox.

A `.cjs` file imported from ESM (`ecosystem.config.cjs`) exposes its
`module.exports` as the **default** export; named imports from it fail.

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
