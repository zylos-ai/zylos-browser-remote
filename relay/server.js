'use strict';
/*
 * zylos-browser-remote relay -- wiring only. The two lanes and the chokepoint
 * carry the logic; this file loads the token, starts them, and shuts them down.
 *
 *   :3802  ext lane    PUBLIC via caddy /browser-remote/* -- extension ingress only
 *   :3803  agent lane  LOOPBACK ONLY, never routed -- CDP surface for the agent
 *
 * Do not collapse the ports: Caddy's strip_prefix forwards every path on 3802,
 * so anything served there is reachable by anyone who learns the public domain.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ExtLane } = require('./ext-lane');
const { AgentLane } = require('./agent-lane');
const { LeaseManager } = require('./lease');

const EXT_PORT = Number(process.env.BROWSER_REMOTE_EXT_PORT || 3802);
const AGENT_PORT = Number(process.env.BROWSER_REMOTE_AGENT_PORT || 3803);
const EXT_BIND = '127.0.0.1';   // Caddy reaches it on loopback; nothing else should

// Side-panel chat ingress (SIDEPANEL-SPEC.md A): the owner's message is handed
// to the C4 bridge, which queues it for the same agent session Lark talks to.
const DEFAULT_C4_RECEIVE = path.join(os.homedir(), 'zylos', '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-receive.js');
const C4_CHANNEL = 'browser';
const C4_PRIORITY = '2';
const C4_STDERR_KEEP = 2000;    // enough to identify a failure, not enough to flood the log

// Resolved per call, not at load: tests point it at a stub mid-run.
function c4ReceivePath() {
  return process.env.ZYLOS_C4_RECEIVE || DEFAULT_C4_RECEIVE;
}

function log(...args) {
  // Never log the token itself, only whether one was present.
  console.log(new Date().toISOString(), ...args);
}

function loadToken() {
  if (process.env.BROWSER_REMOTE_TOKEN) return process.env.BROWSER_REMOTE_TOKEN.trim();
  const f = path.join(__dirname, 'token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return null;
}

/**
 * Hand one side-panel message to C4. The text is passed as a single argv
 * element via spawn() with an args ARRAY -- there is no shell in this path, so
 * quotes, $(...), newlines and semicolons in the owner's message are inert data
 * and no escaping is (or may be) applied to them.
 *
 * Failures are logged loudly at every stage. A message the owner typed and
 * believes was delivered must never vanish quietly.
 *
 * @returns {Promise<{ok: boolean, code: number|null, error?: string}>}
 */
function deliverChatToC4({ sessionId, text }, logFn = log) {
  const script = c4ReceivePath();
  const args = [
    script,
    '--channel', C4_CHANNEL,
    '--endpoint', sessionId,
    '--priority', C4_PRIORITY,
    '--content', text,
  ];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      logFn(`chat: c4-receive spawn threw for ${sessionId}: ${err.message} (MESSAGE NOT DELIVERED)`);
      resolve({ ok: false, code: null, error: err.message });
      return;
    }
    let stderr = '';
    child.stderr.on('data', (c) => {
      if (stderr.length < C4_STDERR_KEEP) stderr += c.toString();
    });
    child.stdout.resume();
    child.on('error', (err) => {
      logFn(`chat: c4-receive failed to start for ${sessionId}: ${err.message} (MESSAGE NOT DELIVERED)`);
      resolve({ ok: false, code: null, error: err.message });
    });
    child.on('close', (code) => {
      if (code === 0) {
        logFn(`chat: delivered to C4 (endpoint ${sessionId}, ${text.length} chars)`);
        resolve({ ok: true, code: 0 });
        return;
      }
      logFn(`chat: c4-receive exited ${code} for ${sessionId} (MESSAGE NOT DELIVERED): ${stderr.trim().slice(0, 400) || '<no stderr>'}`);
      resolve({ ok: false, code, error: stderr.trim() });
    });
  });
}

function start({ token, extPort = EXT_PORT, agentPort = AGENT_PORT } = {}) {
  const leases = new LeaseManager();
  const ext = new ExtLane({ token, log });
  const agent = new AgentLane({ extLane: ext, leases, port: agentPort, log });

  // Ingress: panel -> relay -> C4 queue. ext-lane has already bounded the text
  // and checked the envelope; nothing here looks at what the owner wrote.
  ext.on('chat', (msg) => {
    deliverChatToC4(msg).catch((err) => log(`chat: unexpected delivery error: ${err.message}`));
  });

  return Promise.all([ext.listen(extPort, EXT_BIND), agent.listen()]).then(() => {
    log(`ext lane    ws://${EXT_BIND}:${extPort}/ext   (public via /browser-remote/ext)`);
    log(`agent lane http://127.0.0.1:${agentPort}      (loopback only)`);
    return {
      ext,
      agent,
      leases,
      close() {
        agent.close();
        ext.close();
        leases.stop();
      },
    };
  });
}

if (require.main === module) {
  const token = loadToken();
  if (!token) {
    console.error('FATAL: no token. Set BROWSER_REMOTE_TOKEN or create relay/token (chmod 600).');
    console.error('Mint one with:  openssl rand -hex 32 > relay/token && chmod 600 relay/token');
    process.exit(1);
  }
  start({ token }).then((relay) => {
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => {
        log(`${sig}: shutting down`);
        relay.close();
        process.exit(0);
      });
    }
  });
}

module.exports = { start, loadToken, deliverChatToC4, c4ReceivePath, DEFAULT_C4_RECEIVE };
