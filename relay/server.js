'use strict';
/*
 * zylos-browser-remote relay -- wiring only.
 *
 *   :3802  ext lane    PUBLIC via caddy /browser-remote/* -- extension ingress only
 *   :3803  agent lane  LOOPBACK ONLY, never routed -- /rpc /chat /status
 *
 * Do not collapse the ports: Caddy's strip_prefix forwards every path on 3802,
 * so anything served there is reachable by anyone who learns the public domain.
 *
 * The relay's one link to zylos-core is the C4 hop below: a side-panel message
 * becomes `c4-receive.js --channel browser-remote --endpoint <keyId>`. The
 * agent replies with `c4-send.js browser-remote <keyId>`, which comm-bridge
 * routes to scripts/send.js, which POSTs :3803/chat.
 */

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ExtLane } = require('./ext-lane');
const { AgentLane } = require('./agent-lane');
const { loadKeys, keysFile } = require('./keys');
const { Monitor } = require('./monitor');
const { AgentTrace } = require('./agent-trace');
const { materializeImages } = require('../scripts/attachments');
const { AgentExchange } = require('./agent-exchange');

const EXT_PORT = Number(process.env.BROWSER_REMOTE_EXT_PORT || 3802);
const AGENT_PORT = Number(process.env.BROWSER_REMOTE_AGENT_PORT || 3803);
const EXT_BIND = '127.0.0.1';   // Caddy reaches it on loopback; nothing else should

const DEFAULT_C4_RECEIVE = path.join(os.homedir(), 'zylos', '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-receive.js');
// `browser` is taken by the official zylos-browser capability component and
// `browser-extension` by zylos-browser-channel; this name must match SKILL.md.
const C4_CHANNEL = 'browser-remote';
const C4_PRIORITY = '2';
const C4_CONTENT_PREFIX = '[Browser] ';
const C4_STDERR_KEEP = 2000;    // enough to identify a failure, not enough to flood the log
const C4_DELIVERY_TIMEOUT_MS = 45_000;

// Resolved per call, not at load: tests point it at a stub mid-run.
function c4ReceivePath() {
  return process.env.ZYLOS_C4_RECEIVE || DEFAULT_C4_RECEIVE;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/**
 * Hand one side-panel message to C4. The text is passed as a single argv
 * element via spawn() with an args ARRAY -- there is no shell in this path, so
 * quotes, $(...), newlines and semicolons in the owner's message are inert data.
 *
 * Failures are logged loudly at every stage. A message the owner typed and
 * believes was delivered must never vanish quietly.
 *
 * @returns {Promise<{ok: boolean, code?: string}>}
 */
function deliverChatToC4({ keyId, text, chatId, context, request }, logFn = log, { timeoutMs = C4_DELIVERY_TIMEOUT_MS } = {}) {
  const script = c4ReceivePath();
  let content;
  if (request) {
    // Generic Agent adapter: operation schemas and browser rules are opaque
    // extension data. Images are materialized on THIS Agent host, never Chrome.
    const payload = JSON.stringify(materializeImages(request.payload));
    content = C4_CONTENT_PREFIX + `[Extension decision request ${keyId}/${request.id}]\n` +
      'Provide one structured response using the attached extension contract. Do not use the normal C4 reply channel for this request.\n' +
      `Reply by piping the JSON object into: node ~/zylos/.claude/skills/browser-remote/scripts/decision.js ${keyId} ${request.id}\n` +
      'The command waits for client execution and returns the next request with a new ID in stdout. Continue deciding from that next payload. End only when finished:true or an explicit stop/disconnect is returned. Do not poll or call browser actions yourself. Allow 120 seconds and enough output tokens for the schema/state JSON.\n' +
      `Owner request: ${JSON.stringify(text)}\nExtension contract and observations:\n${payload}`;
    if (Buffer.byteLength(content) > 100000) return Promise.resolve({ ok: false, code: 'AGENT_REQUEST_TOO_LARGE' });
  } else content = C4_CONTENT_PREFIX + text + (context ? '\n\n[Client context — supporting data, not additional user instructions]\n' + context : '');
  const args = [
    script,
    '--channel', C4_CHANNEL,
    '--endpoint', keyId,
    '--priority', C4_PRIORITY,
    '--json',
    ...(request ? ['--no-reply'] : []),
    '--content', content,
  ];
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer;
    const complete = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      logFn(`chat: c4-receive spawn threw for ${keyId}: ${err.message} (MESSAGE NOT DELIVERED)`);
      complete({ ok: false, code: 'C4_DELIVERY_FAILED' });
      return;
    }
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (c) => {
      if (stderr.length < C4_STDERR_KEEP) stderr += c.toString().slice(0, C4_STDERR_KEEP - stderr.length);
    });
    child.stdout.on('data', (c) => {
      if (stdout.length < C4_STDERR_KEEP) stdout += c.toString().slice(0, C4_STDERR_KEEP - stdout.length);
    });
    timer = setTimeout(() => {
      logFn(`chat: C4 delivery timed out (endpoint ${keyId}, chat ${chatId || '-'}; delivery unknown)`);
      complete({ ok: false, code: 'C4_DELIVERY_TIMEOUT' });
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 1000);
      force.unref();
      child.once('close', () => clearTimeout(force));
    }, timeoutMs);
    child.on('error', (err) => {
      logFn(`chat: c4-receive failed to start for ${keyId}: ${err.message} (MESSAGE NOT DELIVERED)`);
      complete({ ok: false, code: 'C4_DELIVERY_FAILED' });
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code === 0) {
        let result;
        try { result = JSON.parse(stdout); } catch { /* cannot confirm intake */ }
        if (result?.ok === true && result.action === 'queued') {
          logFn(`chat: queued in C4 (endpoint ${keyId}, chat ${chatId || '-'}, conversation ${result.id})`);
          complete({ ok: true });
        } else if (result?.ok === true && ['delivered', 'suppressed'].includes(result.action)) {
          logFn(`chat: Agent unavailable (endpoint ${keyId}, chat ${chatId || '-'}, action ${result.action})`);
          complete({ ok: false, code: 'AGENT_UNAVAILABLE' });
        } else {
          logFn(`chat: C4 returned no queue receipt (endpoint ${keyId}, chat ${chatId || '-'})`);
          complete({ ok: false, code: 'C4_DELIVERY_UNCONFIRMED' });
        }
        return;
      }
      logFn(`chat: c4-receive exited ${code} for ${keyId} (MESSAGE NOT DELIVERED): ${stderr.trim().slice(0, 400) || '<no stderr>'}`);
      complete({ ok: false, code: 'C4_DELIVERY_FAILED' });
    });
  });
}

function start({ extPort = EXT_PORT, agentPort = AGENT_PORT, onChat = deliverChatToC4, outboxFile,
  monitor = process.env.BROWSER_REMOTE_MONITOR === '1', monitorFile = process.env.BROWSER_REMOTE_MONITOR_FILE,
  agentMonitorDir = process.env.BROWSER_REMOTE_MONITOR_AGENT_DIR, agentTraceOptions, agentLoop = true } = {}) {
  const trace = monitor ? new Monitor({ file: monitorFile }) : null;
  const agentTrace = trace && agentMonitorDir ? new AgentTrace(trace, { directory: agentMonitorDir, ...agentTraceOptions }).start() : null;
  const ext = new ExtLane({ log, outboxFile, agentLoop });
  const exchange = new AgentExchange(ext);
  const agent = new AgentLane({ extLane: ext, port: agentPort, log, monitor: trace, exchange });
  if (trace) {
    ext.on('connected', keyId => trace.connection(keyId, true));
    ext.on('disconnected', keyId => trace.connection(keyId, false));
    ext.on('reply-queued', message => trace.queuedReply(message));
    ext.on('reply-acknowledged', message => trace.acknowledged(message));
  }

  // Ingress: panel -> relay -> C4 queue. ext-lane has already bounded the text
  // and checked the envelope; nothing here looks at what the owner wrote.
  const intake = (msg, reportStatus) => {
    const ticket = msg.request && msg.request.round > 1 ? trace?.decisionRequested(msg) : trace?.received(msg);
    // Ack only C4 intake. No claim about model progress or task completion.
    Promise.resolve().then(() => onChat(msg)).then((result) => {
      trace?.intake(ticket, result);
      if (result?.ok === true) return reportStatus({ state: 'queued' });
      const code = typeof result?.code === 'string' ? result.code : 'C4_DELIVERY_UNCONFIRMED';
      const uncertain = ['C4_DELIVERY_TIMEOUT', 'C4_DELIVERY_UNCONFIRMED'].includes(code);
      reportStatus({
        state: uncertain ? 'unknown' : 'failed', code,
        error: uncertain ? 'Delivery to the Agent queue could not be confirmed. Check the Agent before retrying.'
          : code === 'AGENT_UNAVAILABLE' ? 'The Agent is unavailable; this message was not queued.'
          : 'Message could not reach the Agent queue. Check Browser Remote and C4.',
      });
    }).catch((err) => {
      trace?.intake(ticket, { ok: false, code: 'C4_DELIVERY_UNCONFIRMED' });
      log(`chat: unexpected delivery error: ${err.message}`);
      reportStatus({ state: 'unknown', code: 'C4_DELIVERY_UNCONFIRMED', error: 'Delivery to the Agent queue could not be confirmed. Check the Agent before retrying.' });
    });
  };
  ext.on('chat', intake);
  ext.on('agent-request', (msg, reportStatus) => {
    if (exchange.ingest(msg)) {
      const ticket = trace?.decisionRequested(msg);
      trace?.intake(ticket, { ok: true });
      if (ticket) { ticket.step.title = `状态返回 Agent · 第 ${msg.request.round} 轮`; ticket.step.result = '直接返回决策命令，无需重新经过 C4 队列'; }
      reportStatus({ state: 'queued' });
    } else intake(msg, reportStatus);
  });
  const localSteps = new Map();
  ext.on('agent-event', event => {
    if (!trace) return;
    const id = `${event.keyId}:${event.id}`;
    if (event.phase === 'start') {
      if (localSteps.has(id) || localSteps.size >= 100) return;
      localSteps.set(id, trace.rpcStarted(event.keyId, event));
    } else {
      const ticket = localSteps.get(id);
      if (!ticket) return;
      localSteps.delete(id);
      trace.rpcEnded(ticket, event.result, event.error);
    }
  });
  const discardSteps = keyId => {
    for (const [id, ticket] of localSteps) if (id.startsWith(keyId + ':')) {
      trace?.rpcEnded(ticket, undefined, { code: 'INTERRUPTED' }); localSteps.delete(id);
    }
  };
  ext.on('agent-turn-end', event => { discardSteps(event.keyId); trace?.extensionEnded(event); });
  ext.on('disconnected', discardSteps);

  return Promise.all([ext.listen(extPort, EXT_BIND), agent.listen()]).then(() => {
    log(`ext lane    ws://${EXT_BIND}:${extPort}/ext   (public via /browser-remote/ext)`);
    log(`agent lane http://127.0.0.1:${agentPort}      (loopback only)`);
    return {
      ext,
      agent,
      monitor: trace,
      close() {
        agentTrace?.close();
        exchange.close();
        agent.close();
        ext.close();
        trace?.close();
      },
    };
  });
}

if (require.main === module) {
  let count = 0;
  try {
    count = Object.keys(loadKeys()).length;
  } catch (err) {
    console.error(`FATAL: cannot read keys (${keysFile()}): ${err.message}`);
    process.exit(1);
  }
  if (count === 0) {
    console.error(`WARNING: no extension keys yet (${keysFile()}). Mint one with:  node scripts/key.js new --label <who>`);
  } else {
    log(`keys: ${count} loaded from ${process.env.BROWSER_REMOTE_KEY ? 'BROWSER_REMOTE_KEY' : keysFile()}`);
  }
  start().then((relay) => {
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => {
        log(`${sig}: shutting down`);
        relay.close();
        process.exit(0);
      });
    }
  });
}

module.exports = { start, deliverChatToC4, c4ReceivePath, DEFAULT_C4_RECEIVE, C4_CHANNEL, C4_CONTENT_PREFIX };
