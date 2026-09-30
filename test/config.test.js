// Resolution order, validation and the two deliberate exclusions (ports and
// the debug trace) for src/lib/config.js, plus proof that src/index.js
// actually consumes it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as config from "../src/lib/config.js";
import { start } from "../src/index.js";
// A .cjs file under an ESM package: default import, never named.
import eco from "../ecosystem.config.cjs";

const CONFIG_ENV = [
  "BROWSER_REMOTE_ACTIVITY",
  "BROWSER_REMOTE_MONITOR",
  "BROWSER_REMOTE_MONITOR_FILE",
  "BROWSER_REMOTE_MONITOR_AGENT_DIR",
];

// config.js resolves its paths lazily from the home directory on every read, so
// each case gets its own HOME and a cleared cache rather than its own module
// instance -- ESM evaluates a module once per process and has no require.cache
// to drop. Nothing here touches the real ~/zylos/components/browser-remote.
function withConfig(contents, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "br-config-"));
  const dir = path.join(home, "zylos", "components", "browser-remote");
  fs.mkdirSync(dir, { recursive: true });
  if (contents !== null) {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  }
  const savedHome = process.env.HOME;
  const savedEnv = {};
  for (const name of CONFIG_ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  process.env.HOME = home;
  config.resetConfigCache();
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return run(config, warnings);
  } finally {
    console.warn = realWarn;
    config.resetConfigCache();
    process.env.HOME = savedHome;
    for (const name of CONFIG_ENV) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("no config.json is the normal case and yields the built-in defaults", () => {
  withConfig(null, (config, warnings) => {
    assert.deepEqual(config.getConfig(), config.DEFAULT_CONFIG);
    assert.equal(config.setting("activityEnabled"), true);
    // A missing file must not be reported as a problem.
    assert.deepEqual(warnings, []);
  });
});

test("config.json values are honoured when the environment is silent", () => {
  withConfig({ activityEnabled: false }, (config) => {
    assert.equal(config.setting("activityEnabled"), false);
  });
});

test("environment wins over config.json in both directions", () => {
  withConfig({ activityEnabled: false }, (config) => {
    process.env.BROWSER_REMOTE_ACTIVITY = "1";
    assert.equal(config.setting("activityEnabled"), true);
  });
  withConfig({ activityEnabled: true }, (config) => {
    process.env.BROWSER_REMOTE_ACTIVITY = "0";
    assert.equal(config.setting("activityEnabled"), false);
  });
});

test("historical environment parsing is preserved exactly", () => {
  withConfig(null, (config) => {
    // ACTIVITY: anything other than "0" enables, including the empty string.
    process.env.BROWSER_REMOTE_ACTIVITY = "0";
    assert.equal(config.setting("activityEnabled"), false);
    process.env.BROWSER_REMOTE_ACTIVITY = "";
    assert.equal(config.setting("activityEnabled"), true);
    process.env.BROWSER_REMOTE_ACTIVITY = "false";
    assert.equal(config.setting("activityEnabled"), true);
  });
});

test("wrongly typed values are rejected with a warning, not honoured", () => {
  withConfig({ activityEnabled: "no" }, (config, warnings) => {
    assert.equal(config.setting("activityEnabled"), true);
    assert.equal(warnings.length, 1);
    assert.ok(/ignoring activityEnabled: expected a boolean/.test(warnings[0]));
  });
});

test("a malformed config.json warns and still starts on defaults", () => {
  withConfig("{ not json", (config, warnings) => {
    assert.deepEqual(config.getConfig(), config.DEFAULT_CONFIG);
    assert.equal(warnings.length, 1);
    assert.ok(/not valid JSON/.test(warnings[0]));
  });
  withConfig("[1,2,3]", (config, warnings) => {
    assert.deepEqual(config.getConfig(), config.DEFAULT_CONFIG);
    assert.ok(/must contain a JSON object/.test(warnings[0]));
  });
});

test("a misspelled key is ignored LOUDLY, the hook marker silently", () => {
  withConfig({ enabled: true, activtyEnabled: false }, (config, warnings) => {
    // The typo must not be honoured...
    assert.equal(config.setting("activityEnabled"), true);
    assert.equal(Object.keys(config.getConfig()).length, 1);
    // ...and must not be swallowed either: exactly one warning, naming the
    // typo, with nothing said about the configure-hook marker.
    assert.equal(warnings.length, 1);
    assert.ok(/ignoring unknown key activtyEnabled/.test(warnings[0]));
    assert.ok(!/enabled\b(?!Enabled)/.test(warnings[0].replace(/activtyEnabled/g, "")));
  });
});

test("an unknown setting name is a programming error, not a silent undefined", () => {
  withConfig(null, (config) => {
    assert.throws(() => config.setting("extPort"), /unknown setting extPort/);
  });
});

// NEGATIVE CONTROL for the deliberate exclusion: ports must stay
// environment-only while SKILL.md http_routes and the scripts/ clients hard-code
// them. If someone adds a port here, this fails and they must update
// SKILL.md and the CLI clients in the same change.
test("ports are deliberately not configurable from config.json", () => {
  withConfig(null, (config) => {
    assert.equal(config.PORTS_ARE_ENV_ONLY, true);
    for (const name of Object.keys(config.SETTINGS)) {
      assert.ok(
        !/port/i.test(name),
        `${name} looks like a port; see src/lib/config.js`,
      );
    }
    assert.ok(!("extPort" in config.DEFAULT_CONFIG));
    assert.ok(!("agentPort" in config.DEFAULT_CONFIG));
  });
});

// NEGATIVE CONTROL for the second exclusion: ecosystem.config.cjs pins
// BROWSER_REMOTE_MONITOR=0 on every deployment and the environment outranks
// this file, so a config.json trace switch would resolve to false under pm2
// and lie to whoever set it. If someone adds the trace back here, this fails
// and they must deal with the ecosystem pin in the same change.
test("the debug trace is deliberately not configurable from config.json", () => {
  withConfig(null, (config) => {
    assert.equal(config.MONITOR_IS_ENV_ONLY, true);
    for (const name of Object.keys(config.SETTINGS)) {
      assert.ok(
        !/monitor/i.test(name),
        `${name} looks like the debug trace; see src/lib/config.js`,
      );
    }
    for (const name of ["monitor", "monitorFile", "agentMonitorDir"]) {
      assert.ok(!(name in config.DEFAULT_CONFIG));
    }
  });
});

// The pin this exclusion exists for. If a future edit drops it from
// ecosystem.config.cjs, the reasoning above stops holding and this fails.
test("ecosystem.config.cjs still pins the trace off for deployments", () => {
  assert.equal(eco.apps[0].env.BROWSER_REMOTE_MONITOR, "0");
});

test("start() honours config.json: activity is off when the file says so", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "br-config-start-"));
  const dir = path.join(home, "zylos", "components", "browser-remote");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ activityEnabled: false }),
  );
  const savedHome = process.env.HOME;
  const savedActivity = process.env.BROWSER_REMOTE_ACTIVITY;
  delete process.env.BROWSER_REMOTE_ACTIVITY;
  process.env.HOME = home;
  config.resetConfigCache();
  let relay;
  try {
    // Ephemeral ports: this must never touch the real 3802/3803 listeners.
    relay = await start({ extPort: 0, agentPort: 0 });
    assert.equal(relay.activity, null, "config.json did not reach start()");
  } finally {
    relay?.close();
    config.resetConfigCache();
    process.env.HOME = savedHome;
    if (savedActivity === undefined) delete process.env.BROWSER_REMOTE_ACTIVITY;
    else process.env.BROWSER_REMOTE_ACTIVITY = savedActivity;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("start() leaves activity on when nothing disables it", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "br-config-start-on-"));
  fs.mkdirSync(path.join(home, "zylos", "components", "browser-remote"), {
    recursive: true,
  });
  const savedHome = process.env.HOME;
  const savedActivity = process.env.BROWSER_REMOTE_ACTIVITY;
  delete process.env.BROWSER_REMOTE_ACTIVITY;
  process.env.HOME = home;
  config.resetConfigCache();
  let relay;
  try {
    relay = await start({ extPort: 0, agentPort: 0 });
    assert.notEqual(relay.activity, null);
  } finally {
    relay?.close();
    config.resetConfigCache();
    process.env.HOME = savedHome;
    if (savedActivity === undefined) delete process.env.BROWSER_REMOTE_ACTIVITY;
    else process.env.BROWSER_REMOTE_ACTIVITY = savedActivity;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
