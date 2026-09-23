'use strict';

// Display-only copies. These strings are never used to execute a command.
const MAX_INPUT_BYTES = 16 * 1024;
const HIDDEN = '[已隐藏]';
// Strip separators so api_key / X-API-Key / accessToken all normalize to one
// spelling. Matching the raw key misses every variant the caller happened to
// punctuate differently.
function normalizeKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

// Suffix matching catches the common compounds (access_token, userApiKey…)
// that an exact list never enumerates completely.
const SECRET_SUFFIX = /(?:password|passwd|secret|token|apikey|accesskey|privatekey)$/;

function sensitiveKey(key) {
  const normalized = normalizeKey(key);
  return /^(?:key|password|passwd|pwd|secret|token|authorization|proxyauthorization|cookie|setcookie|credentials|connectionkey|privatekey|signature|sig)$/.test(normalized) ||
    SECRET_SUFFIX.test(normalized);
}

function redactText(text) {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, HIDDEN)
    .replace(/data:image\/[\w.+-]+;base64,[a-z0-9+/=\s]+/gi, '[图片编码已省略]')
    .replace(/\b(?:sk-(?:proj-)?[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{20,})\b/gi, HIDDEN)
    .replace(/\b(Bearer|Basic)\s+[a-z0-9._~+/=-]+/gi, `$1 ${HIDDEN}`)
    .replace(/(https?:\/\/)[^/\s"']+@/gi, `$1${HIDDEN}@`)
    // JSON embedded in a shell command, e.g. curl --data '{"token":"..."}'.
    .replace(/(["'])([\w-]+)\1(\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\s]+)/g,
      (all, quote, key, gap) => sensitiveKey(key) ? `${quote}${key}${quote}${gap}"${HIDDEN}"` : all)
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)(\s*:\s*)[^\r\n"']+/gi, `$1$2${HIDDEN}`)
    // Shell assignments, CLI flags and URL query parameters.
    .replace(/(\b[\w-]+\s*=\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;&|"']+)/g,
      (all, prefix) => sensitiveKey(prefix.split('=')[0].trim()) ? `${prefix}${HIDDEN}` : all)
    .replace(/(--([\w-]+)\s+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;&|]+)/g,
      (all, prefix, key) => sensitiveKey(key) ? `${prefix}${HIDDEN}` : all)
    .replace(/[a-z0-9+/]{256,}={0,2}/gi, '[长编码已省略]');
}

function inputDetails(input) {
  const original = typeof input === 'string' ? input : JSON.stringify(input ?? null);
  let value = input ?? null;
  if (typeof input === 'string') { try { value = JSON.parse(input); } catch { /* raw command / message */ } }
  let redacted = false, truncated = false;
  const visit = (item, depth = 0) => {
    if (depth > 6) { truncated = true; return '[深层参数已省略]'; }
    if (typeof item === 'string') {
      const cleaned = redactText(item); if (cleaned !== item) redacted = true;
      if (cleaned.length > MAX_INPUT_BYTES) { truncated = true; return cleaned.slice(0, MAX_INPUT_BYTES) + '… [已截断]'; }
      return cleaned;
    }
    if (!item || typeof item !== 'object') return item;
    if (Array.isArray(item)) {
      if (item.length > 64) truncated = true;
      return item.slice(0, 64).map(child => visit(child, depth + 1));
    }
    const result = Object.create(null), entries = Object.entries(item);
    if (entries.length > 64) truncated = true;
    for (const [key, child] of entries.slice(0, 64)) {
      if (key === 'data' && (item.type === 'image' || item.type === 'file' ||
        (typeof item.mimeType === 'string' && item.mimeType.startsWith('image/')))) {
        result[key] = '[附件编码已省略]'; redacted = true;
      }
      else if (sensitiveKey(key)) { result[key] = HIDDEN; redacted = true; }
      else result[key] = visit(child, depth + 1);
    }
    return result;
  };
  let json = JSON.stringify(visit(value), null, 2);
  if (Buffer.byteLength(json) > MAX_INPUT_BYTES) {
    // Keep the JSON envelope parseable even when a huge command is truncated.
    // Escaping the preview can expand it, so reduce until the byte limit holds.
    let preview = Buffer.from(json).subarray(0, MAX_INPUT_BYTES / 2).toString('utf8');
    do { json = JSON.stringify({ preview, note: '参数过长，已截断' }); if (Buffer.byteLength(json) <= MAX_INPUT_BYTES) break; preview = preview.slice(0, Math.floor(preview.length / 2)); } while (preview);
    truncated = true;
  }
  return { json, originalBytes: Buffer.byteLength(original), redacted, truncated };
}

module.exports = { inputDetails, MAX_INPUT_BYTES, normalizeKey, SECRET_SUFFIX };
