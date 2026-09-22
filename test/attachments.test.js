"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-attachments-"));
process.env.BROWSER_REMOTE_OBS_DIR = dir;
const {
  materializeAttachments,
  materializeImages,
} = require("../scripts/attachments");
const { inputDetails } = require("../src/lib/monitor-input");
const { deliverRequestToC4 } = require("../src/index");
const file = {
  type: "file",
  id: "file-1",
  name: "说明.txt",
  mimeType: "text/plain",
  bytes: Buffer.byteLength("附件原文"),
  data: Buffer.from("附件原文").toString("base64"),
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const image = {
  type: "image",
  id: "image-1",
  name: "screenshot.png",
  mimeType: "image/png",
  bytes: png.length,
  data: png.toString("base64"),
};
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("ordinary tool metadata with a file or image type remains opaque", () => {
  const payload = {
    observation: [
      { type: "file", name: "upload", disabled: false },
      { type: "image", name: "submit", src: "https://example.com/icon.png" },
    ],
  };
  assert.deepEqual(materializeAttachments(payload), payload);
});

test("an attachment failure is reported before invoking the Agent queue", async () => {
  assert.deepEqual(
    await deliverRequestToC4({
      endpointId: "aaaaaaaaaaaa",
      text: "Read",
      request: {
        version: 2,
        id: "r1",
        message: { id: "t1", role: "user", content: [{ ...file, bytes: 1 }] },
        context: { pages: [] },
        execution: {},
      },
    }),
    { ok: false, code: "ATTACHMENT_FAILED" },
  );
});

test("quote, file and nested image attachments retain identity without leaking binary data into Agent text", () => {
  const quote = {
    type: "quote",
    id: "q1",
    text: "Quoted passage",
    source: { contextId: "t1" },
  };
  const raw = {
    attachments: [quote, file],
    observation: { screenshot: image },
  };
  const output = materializeAttachments(raw);
  assert.deepEqual(output.attachments[0], quote);
  assert.equal(output.attachments[1].fileReadRequired, true);
  assert.equal(output.attachments[1].id, file.id);
  assert.equal(output.attachments[1].name, file.name);
  assert.equal(fs.readFileSync(output.attachments[1].path, "utf8"), "附件原文");
  assert.equal(output.observation.screenshot.imageReadRequired, true);
  assert.deepEqual(fs.readFileSync(output.observation.screenshot.path), png);
  assert.ok(!JSON.stringify(output).includes(file.data));
  assert.ok(!JSON.stringify(output).includes(image.data));
  assert.equal(raw.attachments[1].data, file.data, "wire input is not mutated");
  assert.equal(fs.statSync(output.attachments[1].path).mode & 0o777, 0o600);
  const before = fs.readdirSync(dir);
  assert.deepEqual(
    materializeAttachments(output),
    output,
    "internal retries retain their resource paths",
  );
  assert.deepEqual(fs.readdirSync(dir), before);
  assert.throws(
    () => materializeAttachments(JSON.parse(JSON.stringify(output))),
    /metadata/,
    "a caller cannot submit a path to an arbitrary Agent-host file",
  );
  const legacy = materializeImages({
    mimeType: image.mimeType,
    data: image.data,
  });
  assert.deepEqual(fs.readFileSync(legacy.path), png);
});

test("invalid attachments fail before creating partial files, including forged size, MIME and paths", () => {
  for (const invalid of [
    { ...file, bytes: 999 },
    { ...file, name: "../secret.txt" },
    { ...file, path: "/etc/passwd" },
    { ...file, data: "@@@@" },
    { ...file, data: "aA==\n", bytes: 1 },
    { ...file, data: "aB==", bytes: 1 }, // Noncanonical pad bits.
    { ...file, bytes: 5_250_001 },
    { ...image, mimeType: "image/jpeg" },
    { ...image, type: "file" },
  ]) {
    const before = fs.readdirSync(dir);
    assert.throws(() =>
      materializeAttachments({ attachments: [file, invalid] }),
    );
    assert.deepEqual(fs.readdirSync(dir), before);
  }
  assert.throws(
    () => materializeAttachments(Array.from({ length: 13 }, () => image)),
    /Too many/,
  );
});

test("Monitor removes small file and image payloads as well as large Base64 strings", () => {
  for (const item of [file, image, { ...file, data: "aGk=", bytes: 2 }]) {
    const details = inputDetails({ attachments: [item] });
    assert.ok(!details.json.includes(item.data));
    assert.equal(details.redacted, true);
    assert.equal(JSON.parse(details.json).attachments[0].name, item.name);
  }
});

test("new observations retain active attachments, expire old files, and respect a bounded store", () => {
  const first = materializeAttachments(file).path;
  for (let i = 0; i < 13; i++) materializeAttachments(image);
  assert.equal(
    fs.readFileSync(first, "utf8"),
    "附件原文",
    "another browser must not evict a live task's file",
  );
  const expired = path.join(dir, "attachment-expired.txt");
  fs.writeFileSync(expired, "old");
  const past = new Date(Date.now() - 25 * 60 * 60_000);
  fs.utimesSync(expired, past, past);
  materializeAttachments(file);
  assert.equal(fs.existsSync(expired), false);
  const full = path.join(dir, "attachment-capacity.bin");
  fs.writeFileSync(full, "");
  fs.truncateSync(full, 128 * 1024 * 1024);
  assert.throws(() => materializeAttachments(file), /storage is full/);
  assert.equal(fs.existsSync(first), true);
  fs.unlinkSync(full);
});
