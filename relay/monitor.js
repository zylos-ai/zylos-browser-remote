'use strict';

// Optional local diagnostics. Capturing a trace must never decide whether a
// browser command runs, or persist raw screenshots / connection credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_RUNS = 60;
const MAX_STEPS = 120;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const TERMINAL = new Set(['delivered', 'delivery_failed', 'interrupted']);
const ASSETS = {
  '/monitor/': ['index.html', 'text/html; charset=utf-8'],
  '/monitor/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/monitor/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};
const secret = /^(?:data|password|passwd|token|authorization|cookie|secret|apiKey|accessKey|connectionKey|promptText)$/i;

function summarize(value, depth = 0, input = false) {
  if (depth > 4) return '[省略深层内容]';
  if (typeof value === 'string') return value.length > 1000 ? value.slice(0, 1000) + '… [已截断]' : value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 12).map(item => summarize(item, depth + 1, input));
  const result = Object.create(null);
  for (const [key, item] of Object.entries(value).slice(0, 24)) {
    if (input && key === 'text' && typeof item === 'string') result[key] = `[输入 ${item.length} 个字符，内容未记录]`;
    else if (secret.test(key)) result[key] = '[内容未记录]';
    else if (key === 'url' && typeof item === 'string') {
      try { const url = new URL(item); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; result[key] = url.href; }
      catch { result[key] = '[无效 URL]'; }
    } else result[key] = summarize(item, depth + 1, input);
  }
  return result;
}

function detail(value, input = false) {
  const text = JSON.stringify(summarize(value, 0, input));
  return text && text.length > 3500 ? text.slice(0, 3500) + '… [已截断]' : text;
}

class Monitor {
  constructor({ file, now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.runs = [];
    this.active = new Map();
    this.replies = new Map();
    this.revision = crypto.randomUUID();
    this.startedAt = now();
    this.storageError = null;
    this.agentSource = { status: 'disabled', message: 'Agent 工具采集未启用；当前仅记录浏览器调用' };
    if (file) {
      try {
        if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error('监控记录超过大小限制');
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved.version !== 1 || !Array.isArray(saved.runs)) throw new Error('监控记录格式无效');
        this.runs = saved.runs.filter(run => run && typeof run.id === 'string' && Array.isArray(run.steps)).slice(-MAX_RUNS);
        for (const run of this.runs) {
          run.steps = run.steps.slice(-MAX_STEPS);
          if (run.status === 'reply_pending' && run.replyId) this.replies.set(run.replyId, run);
          else if (!TERMINAL.has(run.status)) {
            run.status = 'interrupted';
            run.endedAt = now();
          }
          for (const step of run.steps) if (step.status === 'running') {
            step.status = 'unknown'; step.endedAt = now();
            step.error = 'Relay 已重启，无法确认这一步的最终结果';
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') this.storageError = '历史记录读取失败；本次仅保存在内存中';
      }
    }
  }

  changed() {
    this.revision = crypto.randomUUID();
    if (!this.file || this.storageError || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.save(); }, 200);
    this.timer.unref();
  }

  save() {
    if (!this.file || this.storageError) return;
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      let data = JSON.stringify({ version: 1, runs: this.runs });
      while (Buffer.byteLength(data) > MAX_FILE_BYTES && this.runs.length > 1) {
        this.runs.shift();
        data = JSON.stringify({ version: 1, runs: this.runs });
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, data, { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch {
      this.storageError = '历史记录保存失败；本次仅保存在内存中';
      this.revision = crypto.randomUUID();
      try { fs.rmSync(temporary, { force: true }); } catch { /* diagnostics only */ }
    }
  }

  close() { clearTimeout(this.timer); this.save(); }

  countTool(run, group, name) {
    if (!run.toolCounts) {
      run.toolCounts = { browser: [], agent: [] };
      for (const step of run.steps) {
        const category = step.kind === 'command' ? 'browser' : step.kind === 'agent' ? 'agent' : null;
        if (category) this.countTool(run, category, step.title);
      }
    }
    const list = run.toolCounts[group];
    let item = list.find(entry => entry.name === name);
    if (!item) { item = { name, count: 0 }; list.push(item); }
    item.count++;
  }

  agentRun(keyId, at) {
    return [...this.runs].reverse().find(run => run.keyId === keyId && run.messages > 0 &&
      run.startedAt <= at && (!run.endedAt || at <= run.endedAt) && run.status !== 'interrupted') || null;
  }

  agentStarted(run, { name, callId, sessionId, turnId, params, invocation, at }) {
    this.countTool(run, 'agent', name);
    const step = this.add(run, 'agent', name, { status: 'running', callId, sessionId, turnId, params, invocation, startedAt: at });
    if (this.active.get(run.keyId) === run) run.status = 'running';
    return { run, step };
  }

  agentEnded(ticket, result, at) {
    if (!ticket) return;
    const { run, step } = ticket;
    Object.assign(step, result, { endedAt: at, durationMs: Math.max(0, at - step.startedAt) });
    if (this.active.get(run.keyId) === run) run.status = run.steps.some(item => item.status === 'running') ? 'running' : 'waiting';
    run.updatedAt = this.now(); this.changed();
  }

  run(keyId, label, question = '未捕获提问的浏览器调用') {
    let run = this.active.get(keyId);
    if (run) return run;
    run = { id: crypto.randomUUID(), keyId, label: label || keyId, question,
      startedAt: this.now(), updatedAt: this.now(), status: 'waiting', steps: [], messages: 0, omittedSteps: 0 };
    this.runs.push(run);
    if (this.runs.length > MAX_RUNS) {
      const removed = this.runs.shift();
      if (this.active.get(removed.keyId) === removed) this.active.delete(removed.keyId);
      if (removed.replyId) this.replies.delete(removed.replyId);
    }
    this.active.set(keyId, run);
    return run;
  }

  add(run, kind, title, fields = {}) {
    const step = { id: crypto.randomUUID(), kind, title, startedAt: this.now(), status: 'success', ...fields };
    if (step.status === 'success') step.endedAt = this.now();
    run.steps.push(step);
    if (run.steps.length > MAX_STEPS) { run.steps.shift(); run.omittedSteps++; }
    run.updatedAt = this.now();
    this.changed();
    return step;
  }

  received({ keyId, label, text, chatId, context }) {
    const run = this.run(keyId, label, text.slice(0, 300));
    if (!run.messages) { run.question = text.slice(0, 300); if (label) run.label = label; }
    run.messages++;
    this.add(run, 'question', run.messages > 1 ? '收到追加提问' : '收到提问', { text: text.slice(0, 8000), chatId,
      ...(context === undefined ? {} : { context: context.slice(0, 16000) }) });
    const step = this.add(run, 'queue', '投递到 Agent 队列', { status: 'running' });
    run.status = run.steps.some(item => item.kind === 'command' && item.status === 'running') ? 'running' : 'queuing';
    return { run, step };
  }

  intake(ticket, result) {
    if (!ticket) return;
    const { run, step } = ticket;
    step.endedAt = this.now(); step.durationMs = step.endedAt - step.startedAt;
    step.status = result?.ok ? 'success' : ['C4_DELIVERY_TIMEOUT', 'C4_DELIVERY_UNCONFIRMED'].includes(result?.code) ? 'unknown' : 'error';
    step.result = result?.ok ? '队列已接收，等待 Agent 调用工具或回复' : undefined;
    step.error = result?.code;
    if (['queuing', 'waiting'].includes(run.status)) {
      run.status = result?.ok || run.messages > 1 ? 'waiting' : step.status === 'unknown' ? 'uncertain' : 'delivery_failed';
      if (run.status === 'delivery_failed') { run.endedAt = this.now(); this.active.delete(run.keyId); }
    }
    run.updatedAt = this.now(); this.changed();
  }

  decisionRequested({ keyId, request }) {
    const run = this.run(keyId);
    const step = this.add(run, 'queue', `请求 Agent 决策 · 第 ${request.round} 轮`, { status: 'running' });
    run.status = 'queuing';
    return { run, step };
  }

  extensionEnded({ keyId, status, text }) {
    const run = this.active.get(keyId);
    if (!run) return;
    this.add(run, 'final', status === 'done' ? '插件已保存最终回复，本轮结束' : '插件结束本轮任务',
      { status: status === 'done' ? 'success' : 'unknown', text });
    run.status = status === 'done' ? 'delivered' : 'interrupted';
    run.endedAt = this.now(); run.updatedAt = this.now(); this.active.delete(keyId); this.changed();
  }

  rpcStarted(keyId, { method, params, requestId }) {
    const run = this.run(keyId);
    this.countTool(run, 'browser', method);
    const step = this.add(run, 'command', method, { status: 'running', requestId, params: detail(params || {}, true) });
    run.status = 'running';
    return { run, step };
  }

  rpcEnded(ticket, result, error) {
    if (!ticket) return;
    const { run, step } = ticket;
    step.endedAt = this.now(); step.durationMs = step.endedAt - step.startedAt;
    step.status = error ? 'error' : 'success';
    if (error) { step.error = String(error.code || 'EXT_ERROR'); step.result = detail({ message: error.message, details: error.details }); }
    else step.result = detail(result);
    // Display generic ordered result parts; this never schedules browser work.
    const parts = error?.details?.steps ?? result?.steps;
    if (Array.isArray(parts)) step.parts = parts.slice(0, 12).filter(part =>
      part && typeof part.method === 'string' && ['success', 'error', 'skipped'].includes(part.status)
    ).map(part => ({ method: part.method.slice(0, 128), status: part.status,
      ...(Number.isFinite(part.durationMs) ? { durationMs: Math.max(0, part.durationMs) } : {}),
      ...(typeof part.error?.code === 'string' ? { error: part.error.code.slice(0, 64) } : {}) }));
    if (this.active.get(run.keyId) === run) run.status = run.steps.some(item => item.status === 'running') ? 'running' : 'waiting';
    run.updatedAt = this.now(); this.changed();
  }

  progress(keyId, text) {
    this.add(this.run(keyId), 'progress', 'Agent 进度回复', { text: text.slice(0, 8000) });
  }

  replyFailed(keyId, code) {
    this.add(this.run(keyId), 'final', '回复提交失败', { status: 'error', error: code });
  }

  queuedReply({ keyId, messageId, text }) {
    const run = this.run(keyId, null, '未捕获提问的 Agent 回复');
    this.add(run, 'final', '最终回复已保存，等待插件确认', { status: 'waiting', text: text.slice(0, 8000), messageId });
    run.replyId = messageId; run.status = 'reply_pending';
    this.replies.set(messageId, run); this.active.delete(keyId); this.changed();
  }

  acknowledged({ keyId, messageId }) {
    const run = this.replies.get(messageId);
    if (!run || run.keyId !== keyId) return;
    const step = run.steps.find(item => item.messageId === messageId);
    if (step) { step.status = 'success'; step.title = '最终回复已送达，本轮结束'; step.endedAt = this.now(); step.durationMs = step.endedAt - step.startedAt; }
    run.status = 'delivered'; run.endedAt = this.now(); run.updatedAt = this.now();
    this.replies.delete(messageId); this.changed();
  }

  connection(keyId, connected) {
    const run = this.active.get(keyId);
    if (run) this.add(run, 'connection', connected ? '浏览器已连接' : '浏览器连接断开', { status: connected ? 'success' : 'unknown' });
    this.changed();
  }

  handle(req, res, url, connections) {
    if (!url.pathname.startsWith('/monitor')) return false;
    const host = req.headers.host;
    const port = req.socket.localPort;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
    if (!hosts.includes(host) || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403); res.end('Forbidden'); return true;
    }
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end('Read only'); return true; }
    if (url.pathname === '/monitor') { res.writeHead(302, { location: '/monitor/' }); res.end(); return true; }
    if (url.pathname === '/monitor/api') {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      const unchanged = url.searchParams.get('revision') === this.revision;
      res.end(JSON.stringify({ revision: this.revision, startedAt: this.startedAt, now: this.now(),
        connections, storageError: this.storageError, agentSource: this.agentSource, unchanged,
        ...(unchanged ? {} : { runs: [...this.runs].reverse() }) }));
      return true;
    }
    const asset = ASSETS[url.pathname];
    if (!asset) { res.writeHead(404); res.end('Not found'); return true; }
    res.setHeader('content-type', asset[1]);
    res.end(fs.readFileSync(path.join(__dirname, '../monitor', asset[0])));
    return true;
  }
}

module.exports = { Monitor, summarize, MAX_RUNS, MAX_STEPS };
