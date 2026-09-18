"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-cli-"));
process.env.BROWSER_REMOTE_OBS_DIR = path.join(dir, "images");
const { materializeImages } = require("../scripts/attachments");
const { verifyKey, loadKeys } = require("../relay/keys");
try {
  const file = path.join(dir, "keys.json");
  const run = (args) =>
    spawnSync(process.execPath, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        BROWSER_REMOTE_KEYS_FILE: file,
        BROWSER_REMOTE_KEY: "",
      },
    });
  const created = run(["scripts/key.js", "new", "--label", "fixture"]);
  assert.equal(created.status, 0);
  const key = created.stdout.match(/key:\s+([a-f0-9]+)/)[1];
  const keyId = created.stdout.match(/keyId:\s+([a-f0-9]+)/)[1];
  assert.equal(verifyKey(key, JSON.parse(fs.readFileSync(file))).keyId, keyId);
  assert(!fs.readFileSync(file, "utf8").includes(key));
  assert.equal(run(["scripts/key.js", "revoke", keyId]).status, 0);
  assert.equal(verifyKey(key, JSON.parse(fs.readFileSync(file))), null);
  assert.equal(run(["scripts/decision.js", "bad", "id"]).status, 2);
  const image = Buffer.from("89504e470d0a1a0a" + "00".repeat(64), "hex");
  const raw = { mimeType: "image/png", data: image.toString("base64") };
  const result = materializeImages({
    observation: { page: { screenshot: raw } },
    another: [raw],
  });
  const shot = result.observation.page.screenshot;
  assert.equal(shot.data, undefined);
  assert.equal(shot.imageReadRequired, true);
  assert.deepEqual(fs.readFileSync(shot.path), image);
  assert(!JSON.stringify(result).includes(raw.data));
  assert.equal(fs.statSync(shot.path).mode & 0o777, 0o600);
  assert.throws(
    () => materializeImages({ mimeType: "image/jpeg", data: raw.data }),
    /Invalid/,
  );
  assert.throws(
    () => materializeImages(Array.from({ length: 13 }, () => raw)),
    /Too many/,
  );
  console.log(
    "PASS key CLI, decision usage, nested attachments, MIME validation and private image files",
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
