"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ATTACHMENT_CAPABILITY = "attachments-v1";
const MAX_BYTES = 5_250_000; // Matches the client: 7 MB base64 below the 8 MiB frame cap.
const MAX_ITEMS = 12; // Includes generated screenshots as well as owner attachments.
const STORE_BYTES = 128 * 1024 * 1024;
const KEEP_MS = 24 * 60 * 60_000;
const OBS_DIR = path.resolve(
  process.env.BROWSER_REMOTE_OBS_DIR ||
    path.join(
      os.homedir(),
      "zylos",
      "components",
      "browser-remote",
      "observations",
    ),
);
const materialized = new WeakSet();

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")))
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")))
    return "image/gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return null;
}
function validateBinary(value) {
  const typed = value.type === "image" || value.type === "file";
  if (typed) {
    if (
      typeof value.id !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(value.id) ||
      typeof value.name !== "string" ||
      !value.name ||
      value.name.length > 255 ||
      /[\\/\u0000-\u001f]/.test(value.name) ||
      typeof value.mimeType !== "string" ||
      value.mimeType.length > 128 ||
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value.mimeType) ||
      !Number.isInteger(value.bytes) ||
      value.bytes < 1 ||
      value.bytes > MAX_BYTES ||
      Object.keys(value).some(
        (key) =>
          !["id", "type", "name", "mimeType", "bytes", "data"].includes(key),
      )
    )
      throw new Error("Invalid attachment metadata");
  }
  if (
    typeof value.data !== "string" ||
    !value.data.length ||
    value.data.length > 7_000_000 ||
    value.data.length % 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)
  )
    throw new Error("Invalid attachment encoding");
  const bytes = Buffer.from(value.data, "base64");
  if (
    !bytes.length ||
    bytes.length > MAX_BYTES ||
    bytes.toString("base64") !== value.data ||
    (typed && bytes.length !== value.bytes)
  )
    throw new Error("Attachment size or encoding mismatch");
  const isImage =
    value.type === "image" || (!typed && value.mimeType?.startsWith("image/"));
  if (isImage && imageType(bytes) !== value.mimeType)
    throw new Error("Invalid or unsupported image");
  if (value.type === "file" && value.mimeType.startsWith("image/"))
    throw new Error("Images must use an image attachment");
  return { bytes, isImage, typed };
}
function extensionFor(mimeType) {
  return (
    {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "application/pdf": ".pdf",
      "application/json": ".json",
      "text/plain": ".txt",
      "text/markdown": ".md",
      "text/csv": ".csv",
    }[mimeType] || ".bin"
  );
}

// Validate the whole payload before writing. No caller-supplied path or URL is read.
// Paths below belong to THIS Agent host, never to the owner's Chrome machine.
function materializeAttachments(result) {
  const binaries = [];
  const visit = (value, depth = 0) => {
    if (depth > 32)
      throw new Error("Result nesting exceeds the attachment limit");
    if (!value || typeof value !== "object" || materialized.has(value))
      return value;
    if (Array.isArray(value))
      return value.map((item) => visit(item, depth + 1));
    // A tool may describe a DOM input with type="file" or type="image".
    // Only binary envelopes carry these transport fields.
    const typed =
      (value.type === "image" || value.type === "file") &&
      ("data" in value || "mimeType" in value || "bytes" in value);
    const legacyImage =
      typeof value.mimeType === "string" && value.mimeType.startsWith("image/");
    if (typed || legacyImage) {
      if (binaries.length >= MAX_ITEMS)
        throw new Error("Too many attachments in one request");
      const binary = validateBinary(value);
      const metadata = binary.typed
        ? {
            id: value.id,
            type: value.type,
            name: value.name,
            mimeType: value.mimeType,
          }
        : Object.fromEntries(
            Object.entries(value).filter(([key]) => key !== "data"),
          );
      const output = { ...metadata, bytes: binary.bytes.length };
      binaries.push({ ...binary, output });
      return output;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, visit(item, depth + 1)]),
    );
  };
  const output = visit(result);
  if (!binaries.length) return output;
  const total = binaries.reduce((n, item) => n + item.bytes.length, 0);
  if (total > MAX_BYTES)
    throw new Error("Attachments exceed the request size limit");

  fs.mkdirSync(OBS_DIR, { recursive: true, mode: 0o700 });
  let stored = 0;
  for (const name of fs.readdirSync(OBS_DIR)) {
    if (!/^(?:shot|attachment)-/.test(name)) continue;
    const file = path.join(OBS_DIR, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) continue;
    // Keep active-task attachments; don't evict them when another browser takes screenshots.
    if (Date.now() - stat.mtimeMs > KEEP_MS) fs.unlinkSync(file);
    else stored += stat.size;
  }
  if (stored + total > STORE_BYTES)
    throw new Error("Attachment storage is full");
  const created = [];
  try {
    for (const item of binaries) {
      const file = path.join(
        OBS_DIR,
        "attachment-" +
          Date.now() +
          "-" +
          crypto.randomUUID() +
          extensionFor(item.output.mimeType),
      );
      fs.writeFileSync(file, item.bytes, { mode: 0o600, flag: "wx" });
      created.push(file);
      Object.assign(item.output, {
        path: file,
        ...(item.isImage
          ? { imageReadRequired: true }
          : { fileReadRequired: true }),
      });
      materialized.add(item.output);
    }
  } catch (error) {
    for (const file of created) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* retain the original failure */
      }
    }
    throw error;
  }
  return output;
}

// Older callers and nested {mimeType,data} screenshots remain compatible.
module.exports = {
  materializeAttachments,
  materializeImages: materializeAttachments,
  ATTACHMENT_CAPABILITY,
};
