# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.1] - 2026-09-20

Fixes a crash path found while reviewing 0.6.0: an exception thrown by
`ws.close()` could take the whole relay process down, dropping every connected
browser rather than the one socket involved.

29 tests, 28 pass / 1 skip.

### Fixed
- `ws.close()` is now called through a guarded `safeClose()` helper everywhere
  in `src/lib/ext-lane.js`, matching the style `_beat()` and `close()` already
  used. `close()` throws on a socket that is already torn down, and every one
  of these call sites runs inside a `message` handler or a timer callback —
  so the error escaped into the `ws` emitter as an uncaught exception and
  killed the process.
- The worst of them was the supersede path: it closes a **different** socket
  (the older, possibly half-dead instance) than the one whose message is being
  handled, so a stale peer could kill the relay for everyone by reconnecting.
  Regression test added — it reproduces as an `uncaughtException` without
  the fix.

## [0.6.0] - 2026-09-20

Several browser instances can now share one Key. Until this release `keyId`
was both the credential and the route, so a second browser connecting with the
same Key evicted the first. The route is now `endpointId = keyId.browserId`,
where `browserId` is a UUID v4 the plugin generates once per installation and
persists in `chrome.storage.local`. Instances coexist; only a reconnect of the
*same* instance replaces its own socket.

This isolates **browser routing only**. The Agent's conversation context and
memory stay shared across every instance under the Key — two different people
sharing one Key still share a context, and should be issued two Keys instead.

28 tests, 27 pass / 1 skip.

### Added
- `src/lib/endpoint.js` — the `browserId` / `endpointId` grammar, shared by the
  WebSocket lane, the HTTP lane, the CLIs, C4 reply routes and trace parsing.
- `browser-instance-v1` capability and WebSocket subprotocol
  `zylos-browser-remote.v3`. `hello` carries `browserId`; `ready` returns the
  authenticated `endpointId`, which the plugin verifies before enabling chat.
- Per-Key connection limit of 32 instances, close code `4003` when exceeded,
  and a 10-second handshake deadline.
- `test/browser-instances.test.js` — registry isolation, replacement semantics,
  limits and handshake validation.

### Changed
- Identity is fixed by the authenticated socket at handshake and is immutable
  for that socket's lifetime; routing metadata sent in later frames is ignored.
- Close code `4001` now means "this same instance was replaced", not "another
  connection took this Key".
- `scripts/decision.js`, `scripts/reply-route.js` and the generated
  `replyCommands` take `<endpointId>` where they previously took `<keyId>`.
  `agent-trace` and the monitor report per instance.

### Upgrade Notes
**Upgrade Remote before the plugin.** New plugins offer only v3, and an old
Remote rejects them outright — there is no downgrade path. During rollout this
Remote still accepts v2 plugins on the separate bare-`keyId` route, so an
existing 1.3.0 plugin keeps working unchanged; a v2 connection cannot replace
a v3 instance.

Ports (3802 / 3803), data directory layout and `keys.json` are unchanged; no
re-pairing. Hand-installed deployments upgrading from 0.3.x must also repoint
`~/zylos/pm2/ecosystem.config.cjs` `script` from `relay/server.js` to
`src/index.js` — see the 0.5.0 notes.

## [0.5.0] - 2026-09-20

Closes the last open item from the component-spec pass (issue #1, item 6):
the implementation modules now live under `src/`, so the declared entry point
and the tree below it are both spec-shaped. 0.4.0 shipped `src/index.js` as a
shim over `relay/server.js`; that indirection is gone.

No relay, extension-protocol, or CLI behavior changes. Same 24 tests, same
23 pass / 1 skip, before and after.

### Changed
- `relay/server.js` → `src/index.js`; the other seven modules
  (`agent-exchange`, `agent-lane`, `agent-trace`, `ext-lane`, `keys`,
  `monitor-input`, `monitor`) → `src/lib/`. The 0.4.0 shim is deleted — after
  the move there is only one file, so the indirection has nothing to bridge.
  `main()` stays exported and the `require.main === module` self-start is
  unchanged.
- `ecosystem.config.cjs` `script` → `src/index.js`, matching `package.json`
  `main`/`start` and `SKILL.md` `entry` (which already pointed there in
  0.4.0). All four declarations now agree.
- Requires updated across `test/`, `tools/`, `scripts/`. Two paths needed a
  depth change rather than a rename, because the modules moved one level
  deeper: `agent-exchange.js`'s `../scripts/*` requires, and the
  `__dirname`-relative lookup of the `monitor/` UI assets in `monitor.js`.
  The latter is not a `require` and so resolves only at request time — it was
  caught by the monitor test, not by module loading.

### Upgrade Notes
Ports (3802 extension lane / 3803 agent lane), data directory layout, wire
protocol and `keys.json` are unchanged; no re-pairing.

Hand-installed deployments that are launched by a machine-local
`~/zylos/pm2/ecosystem.config.cjs` need that file's `script` path — and the
`fs.existsSync` guard above it, if present — repointed at `src/index.js` in
the same batch as the file sync, then verified with a real restart. A stale
guard path silently de-registers the service at the next container restart
rather than failing visibly. See "部署路径注意事项" in the README.

## [0.4.0] - 2026-09-20

First released version. Everything before this was developed in place on
`main` and installed by hand, never tagged — so `zylos add zylos-ai/zylos-browser-remote`
could not resolve a release to install. This release exists to make the
component installable and to close the gaps against
[`COMPONENT-SPEC.md`](https://github.com/zylos-ai/zylos-component-template)
tracked in issue #1.

No relay, extension-protocol, or CLI behavior changes. The only edit to a
runtime file wraps `relay/server.js`'s existing startup block in a `main()`
function so a second entry point can reach it; the block's contents and its
`require.main === module` trigger are unchanged.

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
- `src/index.js` — the entry point the spec asks for (issue #1, item 6).
  It is a shim: it re-exports `relay/server.js` and, when run as the process
  main, calls the `main()` it now exports. See "Why the implementation is not
  in `src/index.js`" in the README for why the implementation stays put —
  short version: `~/zylos/pm2/ecosystem.config.cjs` uses the existence of
  `relay/server.js` as its registration switch, and losing that file
  de-registers the service silently at the next container restart.

### Changed
- Unit tests moved from `tools/*.test.js` to `test/*.test.js` to match the
  spec layout and the `zylos-lark` reference component; `npm test` updated to
  match. `tools/smoke.js` and `tools/test-cli.js` stay in `tools/` — they are
  end-to-end harnesses, not unit tests, and are still run by `npm test`.
  Same 24 tests pass before and after the move.
- `SKILL.md` declares `lifecycle.hooks`, and its `version` (stale at 0.3.0)
  now matches this release.

### Changed (continued)
- `package.json` `main`/`start` and `SKILL.md` `entry` now point at
  `src/index.js`. `ecosystem.config.cjs` intentionally still launches
  `relay/server.js` directly — that is the path that has been running in
  production, and the shim adds nothing to it.

### Known gaps
- The implementation modules live in `relay/` rather than the spec's
  `src/lib/`. The declared entry point is now spec-shaped, but the tree
  below it is not. Moving those files is safe in principle — nothing outside
  the repository references them — but it is a wide rename with no user-
  visible benefit, so it is left for a later release.

### Upgrade Notes
Existing hand-installed deployments need no action. The service entry, ports
(3802 extension lane / 3803 agent lane), data directory layout and wire
protocol are unchanged, and `keys.json` is preserved across upgrades — no
re-pairing of connected extensions is required.
