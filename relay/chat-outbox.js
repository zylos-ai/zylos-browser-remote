'use strict';

// Durable chat envelopes only. Browser commands are never stored or replayed.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { keysFile } = require('./keys');

const MAX_PENDING = 100;

class ChatOutbox {
  constructor(file = path.join(path.dirname(keysFile()), 'chat-outbox.json')) {
    this.file = file;
    this.messages = [];
    try {
      if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('Chat outbox is too large');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.messages) || saved.messages.length > MAX_PENDING ||
          saved.messages.some((m) => !m || !/^[a-f0-9]{12}$/.test(m.keyId) ||
            typeof m.id !== 'string' || !/^[a-f0-9-]{36}$/.test(m.id) ||
            m.role !== 'assistant' || m.final !== true || typeof m.text !== 'string' ||
            !m.text.length || m.text.length > 8000 || !Number.isSafeInteger(m.ts))) {
        throw new Error('Invalid chat outbox; preserve the file and inspect it');
      }
      this.messages = saved.messages;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  save(messages) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ version: 1, messages }));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, this.file);
      this.messages = messages;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch { /* renamed, or creation failed */ }
    }
  }

  enqueue(keyId, text) {
    if (this.messages.length >= MAX_PENDING) {
      throw Object.assign(new Error('Reply outbox is full; restore browser connections before sending more'), { code: 'OUTBOX_FULL' });
    }
    const message = { keyId, id: randomUUID(), role: 'assistant', text, ts: Date.now(), final: true };
    this.save([...this.messages, message]);
    return message;
  }

  first(keyId) { return this.messages.find((m) => m.keyId === keyId); }

  acknowledge(keyId, id) {
    this.save(this.messages.filter((m) => m.keyId !== keyId || m.id !== id));
  }

  discardRevoked(keys) {
    const retained = this.messages.filter((m) => Object.hasOwn(keys, m.keyId));
    if (retained.length !== this.messages.length) this.save(retained);
  }

  counts() {
    const counts = {};
    for (const m of this.messages) counts[m.keyId] = (counts[m.keyId] || 0) + 1;
    return counts;
  }
}

module.exports = { ChatOutbox, MAX_PENDING };
