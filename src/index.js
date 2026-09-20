#!/usr/bin/env node
//
// Component entry point, as declared by package.json "main" and SKILL.md "entry".
//
// The implementation deliberately stays in relay/server.js rather than moving
// here. The machine-local ~/zylos/pm2/ecosystem.config.cjs keys its PM2
// registration off fs.existsSync(<repo>/relay/server.js): if that file moves,
// the app is not merely failed to start, it is never registered at all — and
// silently, at the next container restart, with the running process masking it
// until then. Keeping the file in place makes that failure mode unreachable.
//
// So this is a shim: it re-exports the public surface and, when run as the
// process main, hands off to the same startup routine PM2 reaches directly.

const server = require("../relay/server.js");

if (require.main === module) {
  server.main();
}

module.exports = server;
