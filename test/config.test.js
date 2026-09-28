"use strict";
// Resolution order, validation and the deliberate port exclusion for
// src/lib/config.js, plus proof that src/index.js actually consumes it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CONFIG_ENV = [
  "BROWSER_REMOTE_ACTIVITY",
  "BROWSER_REMOTE_MONITOR",
  "BROWSER_REMOTE_MONITOR_FILE",
  "BROWSER_REMOTE_MONITOR_AGENT_DIR",
];

// config.js resolves CONFIG_PATH from the home directory at load time, so each
// case gets its own HOME and its own module instance. Nothing here touches the
// real ~/zylos/components/browser-remote.
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
  const modulePath = require.resolve("../src/lib/config");
  delete require.cache[modulePath];
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return run(require("../src/lib/config"), warnings);
  } finally {
    console.warn = realWarn;
    delete require.cache[modulePath];
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
    assert.equal(config.setting("monitor"), false);
    assert.equal(config.setting("monitorFile"), null);
    // A missing file must not be reported as a problem.
    assert.deepEqual(warnings, []);
  });
});

test("config.json values are honoured when the environment is silent", () => {
  withConfig(
    { activityEnabled: false, monitor: true, monitorFile: "/tmp/trace.jsonl" },
    (config) => {
      assert.equal(config.setting("activityEnabled"), false);
      assert.equal(config.setting("monitor"), true);
      assert.equal(config.setting("monitorFile"), "/tmp/trace.jsonl");
      // Untouched keys keep their defaults.
      assert.equal(config.setting("agentMonitorDir"), null);
    },
  );
});

test("environment wins over config.json in both directions", () => {
  withConfig({ activityEnabled: false, monitor: true }, (config) => {
    process.env.BROWSER_REMOTE_ACTIVITY = "1";
    process.env.BROWSER_REMOTE_MONITOR = "0";
    assert.equal(config.setting("activityEnabled"), true);
    assert.equal(config.setting("monitor"), false);
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
    // MONITOR: only "1" enables.
    process.env.BROWSER_REMOTE_MONITOR = "true";
    assert.equal(config.setting("monitor"), false);
    process.env.BROWSER_REMOTE_MONITOR = "1";
    assert.equal(config.setting("monitor"), true);
  });
});

test("wrongly typed values are rejected with a warning, not honoured", () => {
  withConfig(
    { activityEnabled: "no", monitor: 1, monitorFile: "" },
    (config, warnings) => {
      assert.equal(config.setting("activityEnabled"), true);
      assert.equal(config.setting("monitor"), false);
      assert.equal(config.setting("monitorFile"), null);
      assert.equal(warnings.length, 3);
      assert.ok(warnings.every((line) => /ignoring/.test(line)));
    },
  );
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

test("unknown keys are ignored, including the configure-hook marker", () => {
  withConfig({ enabled: true, activtyEnabled: false }, (config) => {
    assert.equal(config.setting("activityEnabled"), true);
    assert.equal(Object.keys(config.getConfig()).length, 4);
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
  for (const name of ["../src/lib/config", "../src/index"]) {
    delete require.cache[require.resolve(name)];
  }
  let relay;
  try {
    const { start } = require("../src/index");
    // Ephemeral ports: this must never touch the real 3802/3803 listeners.
    relay = await start({ extPort: 0, agentPort: 0 });
    assert.equal(relay.activity, null, "config.json did not reach start()");
  } finally {
    relay?.close();
    for (const name of ["../src/lib/config", "../src/index"]) {
      delete require.cache[require.resolve(name)];
    }
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
  for (const name of ["../src/lib/config", "../src/index"]) {
    delete require.cache[require.resolve(name)];
  }
  let relay;
  try {
    const { start } = require("../src/index");
    relay = await start({ extPort: 0, agentPort: 0 });
    assert.notEqual(relay.activity, null);
  } finally {
    relay?.close();
    for (const name of ["../src/lib/config", "../src/index"]) {
      delete require.cache[require.resolve(name)];
    }
    process.env.HOME = savedHome;
    if (savedActivity === undefined) delete process.env.BROWSER_REMOTE_ACTIVITY;
    else process.env.BROWSER_REMOTE_ACTIVITY = savedActivity;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
