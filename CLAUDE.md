# CLAUDE.md

Engineering conventions for this repository live in [AGENTS.md](./AGENTS.md)
and apply equally to Claude and every other agent. Read it before any
development, review, or release work.

Two non-negotiables:

- **Release Process** — all four version files (package.json /
  package-lock.json / SKILL.md frontmatter / CHANGELOG.md) bump in the same
  commit of a dedicated release PR. `test/release-consistency.test.js`
  machine-enforces the resulting final-tree version consistency; the
  PR/commit discipline itself is guaranteed by the release flow and review
  gate.
- **ESM** — this repository is `"type": "module"` throughout, matching the
  Zylos component template. Do not introduce `require()`/`module.exports` in
  new files. Three ESM traps here fail *silently* rather than failing a test
  — the PM2 entry-point check, data-directory paths resolved at module load,
  and tests that expect to re-import a module to reset it. Read AGENTS.md,
  "ESM: three rules that are not optional", before touching any of them.
