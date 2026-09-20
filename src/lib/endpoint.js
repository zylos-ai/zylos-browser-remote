"use strict";

// Route identifiers are public addresses, not credentials. Keep this grammar
// shared by HTTP, CLI, C4 replies and diagnostic trace parsing.
const BROWSER_ID_SOURCE =
  "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const BROWSER_ID_RE = new RegExp(`^${BROWSER_ID_SOURCE}$`);
const ENDPOINT_SOURCE = `[a-f0-9]{12}(?:\\.${BROWSER_ID_SOURCE})?`;
const ENDPOINT_RE = new RegExp(`^${ENDPOINT_SOURCE}$`);
const INSTANCE_CAPABILITY = "browser-instance-v1";

module.exports = {
  BROWSER_ID_RE,
  ENDPOINT_SOURCE,
  ENDPOINT_RE,
  INSTANCE_CAPABILITY,
};
