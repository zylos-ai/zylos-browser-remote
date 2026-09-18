"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

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
const OBS_KEEP = 12;

function stashImage(result, created) {
  if (!result || typeof result.data !== "string")
    throw new Error("Image data is missing");
  const image = Buffer.from(result.data, "base64");
  // Validate the declared MIME against the encoded bytes before materializing.
  const detectedType = image
    .subarray(0, 8)
    .equals(Buffer.from("89504e470d0a1a0a", "hex"))
    ? "image/png"
    : image.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
      ? "image/jpeg"
      : null;
  const mimeType = result.mimeType;
  if (!detectedType || mimeType !== detectedType)
    throw new Error("Invalid or unsupported image");
  const ext = mimeType === "image/png" ? "png" : "jpg";
  fs.mkdirSync(OBS_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(
    OBS_DIR,
    `shot-${Date.now()}-${crypto.randomUUID()}.${ext}`,
  );
  fs.writeFileSync(file, image, { mode: 0o600, flag: "wx" });
  created.add(path.basename(file));
  const { data, ...rest } = result;
  return {
    ...rest,
    mimeType,
    path: file,
    bytes: image.length,
    imageReadRequired: true,
  };
}

function materializeImages(result) {
  const created = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 32)
      throw new Error("Result nesting exceeds the attachment limit");
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value))
      return value.map((item) => visit(item, depth + 1));
    const isImage =
      typeof value.mimeType === "string" && value.mimeType.startsWith("image/");
    let mapped = value;
    if (isImage) {
      if (created.size >= OBS_KEEP)
        throw new Error("Too many image attachments in one result");
      mapped = stashImage(value, created);
    }
    return Object.fromEntries(
      Object.entries(mapped).map(([key, item]) => [
        key,
        visit(item, depth + 1),
      ]),
    );
  };
  const output = visit(result);
  if (created.size) {
    const previous = fs
      .readdirSync(OBS_DIR)
      .filter((f) => f.startsWith("shot-") && !created.has(f))
      .sort();
    for (const file of previous.slice(
      0,
      Math.max(0, previous.length + created.size - OBS_KEEP),
    )) {
      try {
        fs.unlinkSync(path.join(OBS_DIR, file));
      } catch {
        /* best effort */
      }
    }
  }
  return output;
}

module.exports = { materializeImages };
