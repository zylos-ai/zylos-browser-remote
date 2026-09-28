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
- **CommonJS** — this repository is `"type": "commonjs"` throughout, a
  deliberate deviation from the Zylos component template. Do not introduce
  ESM syntax in new files, and do not "fix" the module system as a side
  effect of an unrelated change; see AGENTS.md, "Open: ESM migration".
