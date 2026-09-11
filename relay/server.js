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
const path = require('path');
const { ExtLane } = require('./ext-lane');
const { AgentLane } = require('./agent-lane');
const { LeaseManager } = require('./lease');

const EXT_PORT = Number(process.env.BROWSER_REMOTE_EXT_PORT || 3802);
const AGENT_PORT = Number(process.env.BROWSER_REMOTE_AGENT_PORT || 3803);
const EXT_BIND = '127.0.0.1';   // Caddy reaches it on loopback; nothing else should

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

function start({ token, extPort = EXT_PORT, agentPort = AGENT_PORT } = {}) {
  const leases = new LeaseManager();
  const ext = new ExtLane({ token, log });
  const agent = new AgentLane({ extLane: ext, leases, port: agentPort, log });

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

module.exports = { start, loadToken };
