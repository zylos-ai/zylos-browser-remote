'use strict';
/*
 * What does agent-browser ACTUALLY send?
 *
 * The option-3 allowlist widening has to be a *minimal sufficient* subset, and
 * the only honest way to know the subset is to watch the client work. So this
 * tool puts a recording proxy between a stock agent-browser and a real Chrome:
 *
 *   agent-browser --cdp 127.0.0.1:<PROBE>  ->  this proxy  ->  real Chrome
 *                                               |
 *                                               +-- logs every client->Chrome method
 *
 * Chrome is REAL here on purpose. Probing against our own relay would only ever
 * report the first method it refuses, one round trip at a time, and would hide
 * everything the client does after a failure. Against a browser that answers
 * everything, one run yields the whole set.
 *
 * Output: methods grouped by the agent-browser command that caused them, plus a
 * merged set diffed against relay/chokepoint.js -- i.e. exactly the "what would
 * we have to add" list, with nothing added on a hunch.
 *
 * Run: node tools/probe-agent-browser.js            (BR_HEADLESS=1 to skip Xvfb)
 *      node tools/probe-agent-browser.js --json     (machine-readable)
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { WebSocket, WebSocketServer } = require('ws');

const { findChrome, startXvfb, waitFor, sleep } = require('./test-real-chrome');
const { ALLOWED_CDP_METHODS, ALLOWED_BR_METHODS, methodAllowed } = require('../relay/chokepoint');

const PROBE_PORT = Number(process.env.BR_PROBE_PORT || 3899);
const AB_BIN = path.join(__dirname, '..', 'node_modules', 'agent-browser', 'bin', 'agent-browser-linux-x64');
const JSON_OUT = process.argv.includes('--json');

// ---------------------------------------------------------------- recording

/** @type {{phase: string, method: string, hasSession: boolean}[]} */
const calls = [];
let phase = 'startup';
/** Fixed built-in expressions the client sends, so we can tell "runs its own
 *  helper" apart from "forwards arbitrary user JS". Keyed by method. */
const payloadSamples = new Map();

function record(method, frame) {
  calls.push({ phase, method, hasSession: Boolean(frame.sessionId) });
  if (!payloadSamples.has(method)) {
    const p = frame.params || {};
    const shape = p.expression ?? p.functionDeclaration ?? null;
    payloadSamples.set(method, shape ? String(shape).replace(/\s+/g, ' ').slice(0, 220) : null);
  }
}

// ------------------------------------------------------------------- chrome

function launchPlainChrome({ userDataDir, display }) {
  const bin = findChrome();
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--disable-dev-shm-usage', '--disable-background-networking', '--disable-sync',
    '--disable-component-update', '--metrics-recording-only', '--mute-audio',
    '--window-size=1280,1000',
    'about:blank',
  ];
  if (!display) args.unshift('--headless=new');
  const env = { ...process.env };
  if (display) env.DISPLAY = display;
  const proc = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  proc.stdout.on('data', (d) => log.push(d.toString()));
  proc.stderr.on('data', (d) => log.push(d.toString()));
  return { proc, log, bin };
}

async function chromeEndpoint(userDataDir, chrome) {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const line = await waitFor('Chrome to publish DevToolsActivePort', async () => {
    if (chrome.proc.exitCode !== null) {
      throw new Error(`Chrome exited (${chrome.proc.exitCode}):\n${chrome.log.join('').slice(-2000)}`);
    }
    try {
      const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
      return port && wsPath ? { port: Number(port), wsPath } : null;
    } catch { return null; }
  }, 30_000);
  return { port: line.port, httpBase: `http://127.0.0.1:${line.port}` };
}

// ------------------------------------------------------------- fixture page

const FIXTURE = `<!doctype html><meta charset="utf-8"><title>probe fixture</title>
<h1 id="h">Probe Fixture</h1>
<form id="f" onsubmit="event.preventDefault();document.getElementById('out').textContent='submitted:'+q.value">
  <label for="q">Search</label>
  <input id="q" name="q" type="text" placeholder="type here">
  <button id="go" type="submit">Go</button>
</form>
<p id="out">idle</p>
<a id="lnk" href="/page2">second page</a>`;

function startFixture() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// -------------------------------------------------------------- the proxy

function rewriteWs(obj, probePort) {
  if (Array.isArray(obj)) return obj.map((o) => rewriteWs(o, probePort));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = typeof v === 'string' && v.startsWith('ws://')
        ? v.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${probePort}`)
        : rewriteWs(v, probePort);
    }
    return out;
  }
  return obj;
}

const DEBUG = process.env.BR_DEBUG === '1';
const dbg = (...a) => { if (DEBUG) console.log('    [proxy]', ...a); };

function startProxy(chromePort) {
  const server = http.createServer((req, res) => {
    dbg('HTTP', req.method, req.url);
    // Discovery endpoints: proxy to Chrome, then point every ws:// back at us.
    const proxied = http.request(
      { host: '127.0.0.1', port: chromePort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${chromePort}` } },
      (up) => {
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => {
          let body = Buffer.concat(chunks);
          const ctype = up.headers['content-type'] || '';
          if (ctype.includes('json')) {
            try { body = Buffer.from(JSON.stringify(rewriteWs(JSON.parse(body.toString()), PROBE_PORT))); }
            catch { /* not JSON after all: pass through */ }
          }
          // Rewriting the body changes its length, so the upstream framing
          // headers must not survive: a stale content-length or a leftover
          // transfer-encoding would leave the client waiting for bytes that
          // never come (or reading past the body).
          const headers = { ...up.headers };
          delete headers['content-length'];
          delete headers['transfer-encoding'];
          headers['content-length'] = body.length;
          dbg('HTTP', up.statusCode, req.url, `${body.length}b`);
          res.writeHead(up.statusCode, headers);
          res.end(body);
        });
      });
    proxied.on('error', () => { res.writeHead(502); res.end('probe: upstream failed'); });
    req.pipe(proxied);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    dbg('WS upgrade', req.url);
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstreamUrl = `ws://127.0.0.1:${chromePort}${req.url}`;
      dbg('WS upstream ->', upstreamUrl);
      const upstream = new WebSocket(upstreamUrl, {
        perMessageDeflate: false, maxPayload: 256 * 1024 * 1024,
      });
      const pending = [];
      let open = false;

      upstream.on('open', () => { open = true; for (const m of pending) upstream.send(m); pending.length = 0; });

      // client -> chrome : the direction we care about
      client.on('message', (data) => {
        const raw = data.toString();
        try {
          const frame = JSON.parse(raw);
          if (frame.method) record(frame.method, frame);
        } catch { /* non-JSON frame: forward untouched */ }
        if (open) upstream.send(raw); else pending.push(raw);
      });

      upstream.on('message', (data) => {
        if (client.readyState === WebSocket.OPEN) client.send(data.toString());
      });

      const bye = () => {
        try { client.close(); } catch { /* already closed */ }
        try { upstream.close(); } catch { /* already closed */ }
      };
      client.on('close', (c) => { dbg('WS client closed', c); bye(); });
      upstream.on('close', (c) => { dbg('WS upstream closed', c); bye(); });
      client.on('error', (e) => { dbg('WS client error', e.message); bye(); });
      upstream.on('error', (e) => { dbg('WS upstream error', e.message); bye(); });
    });
  });

  return new Promise((resolve) => server.listen(PROBE_PORT, '127.0.0.1', () => resolve(server)));
}

// ------------------------------------------------------------------ driver

/*
 * MUST be async, never spawnSync. The recording proxy runs on THIS process's
 * event loop, so a synchronous child would block the very server the client is
 * trying to talk to: agent-browser would time out on every command, record zero
 * frames, and the proxy log would only drain once the run was over. That is
 * exactly the failure this tool hit before.
 */
function ab(args, { timeout = 90_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(AB_BIN, ['--cdp', String(PROBE_PORT), '--session', 'probe', ...args], {
      env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeout);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(chunks).toString().trim() });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: `spawn failed: ${e.message}` });
    });
  });
}

/** Run one agent-browser command under its own phase label. */
async function step(label, args) {
  phase = label;
  const before = calls.length;
  const r = await ab(args);
  const n = calls.length - before;
  const verdict = r.code === 0 ? 'ok' : `exit ${r.code}`;
  if (!JSON_OUT) {
    console.log(`  ${label.padEnd(14)} ${String(n).padStart(3)} calls  ${verdict}`);
    if (r.code !== 0) console.log(`      ${r.out.split('\n').slice(0, 4).join('\n      ')}`);
  }
  return r;
}

// ------------------------------------------------------------------- report

function report() {
  const byPhase = new Map();
  for (const c of calls) {
    if (!byPhase.has(c.phase)) byPhase.set(c.phase, new Set());
    byPhase.get(c.phase).add(c.method);
  }
  const all = [...new Set(calls.map((c) => c.method))].sort();
  const allowed = all.filter((m) => methodAllowed(m) === null);
  const missing = all.filter((m) => methodAllowed(m) !== null);

  // First phase that needed each missing method -- the justification for adding it.
  const firstNeed = new Map();
  for (const c of calls) if (!firstNeed.has(c.method)) firstNeed.set(c.method, c.phase);

  if (JSON_OUT) {
    console.log(JSON.stringify({
      total: calls.length,
      byPhase: Object.fromEntries([...byPhase].map(([k, v]) => [k, [...v].sort()])),
      allowedToday: allowed,
      wouldNeedAdding: missing.map((m) => ({
        method: m, firstNeededBy: firstNeed.get(m),
        refusal: methodAllowed(m),
        payloadSample: payloadSamples.get(m) || null,
        phases: [...byPhase].filter(([, s]) => s.has(m)).map(([p]) => p),
      })),
    }, null, 2));
    return;
  }

  const line = (s) => console.log(s);
  line('\n' + '='.repeat(74));
  line(`RECORDED ${calls.length} calls, ${all.length} distinct methods`);
  line('='.repeat(74));

  line('\n--- by agent-browser command ------------------------------------------');
  for (const [p, set] of byPhase) {
    line(`\n  ${p}:`);
    for (const m of [...set].sort()) {
      line(`      ${methodAllowed(m) === null ? '✓' : '✗'} ${m}`);
    }
  }

  line('\n--- already allowed by relay/chokepoint.js -----------------------------');
  line(allowed.length ? allowed.map((m) => `    ✓ ${m}`).join('\n') : '    (none)');

  line('\n--- WOULD NEED ADDING (the option-3 candidate set) ---------------------');
  for (const m of missing) {
    line(`    ✗ ${m}`);
    line(`        first needed by : ${firstNeed.get(m)}`);
    line(`        all commands    : ${[...byPhase].filter(([, s]) => s.has(m)).map(([p]) => p).join(', ')}`);
    const sample = payloadSamples.get(m);
    if (sample) line(`        payload sample  : ${sample}`);
  }
  line(`\n  ${missing.length} method(s) to justify. Relay allows ` +
       `${ALLOWED_CDP_METHODS.size} CDP + ${ALLOWED_BR_METHODS.size} _br.* today.`);
  line('');
}

// --------------------------------------------------------------------- main

async function main() {
  if (!fs.existsSync(AB_BIN)) throw new Error(`agent-browser not installed at ${AB_BIN}`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-probe-'));
  const xvfb = startXvfb();
  const chrome = launchPlainChrome({ userDataDir, display: xvfb && xvfb.display });
  const fixture = await startFixture();
  let proxy = null;

  const cleanup = () => {
    // Synchronous on purpose: this runs from process 'exit', where the event
    // loop is already done and an async ab() would never resolve. Blocking is
    // safe here precisely because no proxy traffic can still be in flight.
    try {
      spawnSync(AB_BIN, ['--cdp', String(PROBE_PORT), '--session', 'probe', 'close', '--all'],
        { encoding: 'utf8', timeout: 20_000 });
    } catch { /* best effort */ }
    try { proxy?.close(); } catch { /* not up */ }
    try { fixture.server.close(); } catch { /* not up */ }
    try { chrome.proc.kill('SIGKILL'); } catch { /* gone */ }
    try { xvfb?.proc?.kill('SIGKILL'); } catch { /* gone */ }
    if (!process.env.BR_KEEP) fs.rmSync(userDataDir, { recursive: true, force: true });
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  const { port } = await chromeEndpoint(userDataDir, chrome);
  proxy = await startProxy(port);
  if (!JSON_OUT) {
    console.log(`chrome  : ${chrome.bin} (${xvfb ? `headful ${xvfb.display}` : 'headless'})`);
    console.log(`proxy   : 127.0.0.1:${PROBE_PORT} -> chrome 127.0.0.1:${port}`);
    console.log(`fixture : ${fixture.base}\n`);
    console.log('driving agent-browser:');
  }

  // The P0 action set, in the order a real agent would use it.
  await step('connect', ['get', 'url']);
  await step('open', ['open', fixture.base]);
  await step('snapshot', ['snapshot']);
  await step('snapshot-i', ['snapshot', '-i']);
  await step('get-text', ['get', 'text', '#h']);
  await step('click', ['click', '#go']);
  await step('fill', ['fill', '#q', 'hello probe']);
  await step('type', ['type', '#q', 'more']);
  await step('press', ['press', 'Enter']);
  await step('screenshot', ['screenshot', path.join(os.tmpdir(), 'probe-shot.png')]);
  await step('tab-list', ['tab', 'list']);
  await step('reload', ['reload']);
  await step('back', ['back']);
  await sleep(200);

  report();
}

if (require.main === module) {
  main().catch((e) => { console.error(`\nprobe failed: ${e.stack || e.message}`); process.exit(1); });
}
