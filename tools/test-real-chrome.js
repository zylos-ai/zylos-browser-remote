'use strict';
/*
 * End-to-end test: a REAL Chrome, with this extension actually installed,
 * driven through the REAL relay by a REAL CDP client.
 *
 * This is the one test with no stubs anywhere in the path:
 *
 *   agent CDP socket -> relay chokepoint -> ext lane -> Chrome MV3 worker
 *     -> chrome.debugger / chrome.scripting -> a real page's real DOM
 *
 * What only this file can prove, and tools/test-extension.js structurally
 * cannot:
 *  - the extension LOADS in Chrome at all (manifest, MV3 module worker, the
 *    permission set) rather than merely importing under Node;
 *  - the injected page functions in actions.js work against a real DOM --
 *    pageSnapshot's selector/label/visibility logic, pageLocateForClick's
 *    elementFromPoint occlusion check, pagePrepareFill's isolated-world write;
 *  - Input.insertText / Input.dispatchMouseEvent actually drive the page: the
 *    fixture's own click handler reads back what was typed, so the assertion
 *    fails unless the keystrokes and the click were real;
 *  - the two-sided guard on a page that navigates ITSELF somewhere blocklisted.
 *
 * The browser here is a throwaway Chrome for Testing profile with no login
 * state -- it proves the mechanism, not anything about the owner's browser.
 *
 * Run: node tools/test-real-chrome.js          (BR_CHROME=<path> to override,
 *      BR_HEADLESS=1 to skip Xvfb, BR_KEEP=1 to leave the profile behind)
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { start } = require('../relay/server');

const EXT_PORT = 3932;              // not 3802/3803 (live), 3902/3903 (smoke), 3912/3913 (ext test)
const AGENT_PORT = 3933;
const TOKEN = 'test-real-chrome-token-not-a-secret';
const AGENT_BASE = `http://127.0.0.1:${AGENT_PORT}`;
const EXT_DIR = path.resolve(__dirname, '..', 'extension');
const OVERALL_TIMEOUT_MS = 240_000;

let pass = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); return; }
  failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
}
function section(title) { console.log(`\n${title}`); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, predicate, timeoutMs = 20_000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(stepMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ------------------------------------------------------------------ fixture site

const PAGE1 = `<!doctype html>
<html><head><meta charset="utf-8"><title>BR fixture page one</title>
<style>
  body { font: 14px sans-serif; margin: 12px; }
  #covered { position: fixed; left: 620px; top: 420px; }
  #overlay { position: fixed; left: 600px; top: 400px; width: 220px; height: 90px;
             background: rgba(0,0,0,.5); z-index: 10; }
</style></head>
<body>
<p>fixture-marker-alpha</p>
<label for="name">Your name</label>
<input id="name" name="name" type="text">
<input id="pw" name="pw" type="password" value="hunter2-must-never-leave-the-browser">
<button id="go">Submit name</button>
<a id="docs" href="/page2">go to page two</a>
<button id="leave">go to checkout</button>
<div id="result"></div>
<button id="covered">covered button</button>
<div id="overlay"></div>
<script>
  document.getElementById('go').addEventListener('click', function () {
    // Reads the field back: this only says "clicked:<text>" if the fill wrote a
    // real value AND the click was a real, trusted event.
    var v = document.getElementById('name').value;
    document.getElementById('result').textContent = 'clicked:' + v;
    setTimeout(function () {
      var d = document.createElement('div');
      d.id = 'later';
      d.textContent = 'late element';
      document.body.appendChild(d);
    }, 600);
  });
  document.getElementById('leave').addEventListener('click', function () {
    location.href = '/checkout';
  });
</script>
</body></html>`;

const PAGE2 = `<!doctype html><html><head><meta charset="utf-8"><title>BR fixture page two</title></head>
<body><p>fixture-marker-beta</p><a id="back" href="/page1">back</a></body></html>`;

const CHECKOUT = `<!doctype html><html><head><meta charset="utf-8"><title>BR fixture checkout</title></head>
<body><p>fixture-marker-checkout</p><button id="pay">Pay now</button></body></html>`;

function startFixtureSite() {
  const routes = { '/page1': PAGE1, '/page2': PAGE2, '/checkout': CHECKOUT };
  const server = http.createServer((req, res) => {
    const body = routes[req.url.split('?')[0]];
    if (!body) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

// ------------------------------------------------------------------ chrome

function findChrome() {
  if (process.env.BR_CHROME) return process.env.BR_CHROME;
  const roots = ['/opt/ms-playwright', path.join(os.homedir(), '.cache/ms-playwright')];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const dir of entries.filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      const p = path.join(root, dir, 'chrome-linux64', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('no Chrome found; set BR_CHROME=<path to chrome binary>');
}

/**
 * Headful under Xvfb by default. An MV3 extension is a headful product; new
 * headless does load extensions, but when the two disagree the headful result
 * is the one that describes the owner's machine. (xvfb-run is unusable here --
 * it shells out to xauth, which this image does not ship.)
 */
function startXvfb() {
  if (process.env.BR_HEADLESS === '1') return null;
  if (process.env.DISPLAY) return { display: process.env.DISPLAY, proc: null };
  if (!fs.existsSync('/usr/bin/Xvfb')) return null;
  const display = `:${99 - (process.pid % 20)}`;
  const proc = spawn('/usr/bin/Xvfb', [display, '-screen', '0', '1280x1000x24', '-nolisten', 'tcp'], {
    stdio: 'ignore', detached: false,
  });
  return { display, proc };
}

function launchChrome({ userDataDir, display }) {
  const bin = findChrome();
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',            // real port lands in DevToolsActivePort
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--disable-dev-shm-usage', '--disable-background-networking', '--disable-sync',
    '--disable-component-update', '--metrics-recording-only', '--mute-audio',
    '--window-size=1280,1000',
    // Chrome 137+ ignores --load-extension unless this kill switch is disabled.
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    'about:blank',
  ];
  if (!display) args.unshift('--headless=new');

  const env = { ...process.env };
  if (display) env.DISPLAY = display;
  const proc = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  proc.stdout.on('data', (d) => log.push(d.toString()));
  proc.stderr.on('data', (d) => log.push(d.toString()));
  return { proc, log, bin, args };
}

async function devtoolsEndpoint(userDataDir, chrome) {
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
  return { httpBase: `http://127.0.0.1:${line.port}`, wsUrl: `ws://127.0.0.1:${line.port}${line.wsPath}` };
}

// ------------------------------------------------------------------ CDP client

/** Minimal CDP client: JSON-RPC over one socket, flat sessions. */
class Cdp {
  static connect(url, { subprotocols } = {}) {
    return new Promise((resolve, reject) => {
      const ws = subprotocols ? new WebSocket(url, subprotocols) : new WebSocket(url);
      const client = new Cdp(ws);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
        else resolve(msg.result);
        return;
      }
      if (msg.method) this.events.push(msg);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const frame = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(frame));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
    });
  }

  close() { try { this.ws.close(); } catch { /* gone */ } }
}

/** Run an expression inside the extension's service worker (test driver only). */
async function evalInWorker(browser, sessionId, expression) {
  const res = await browser.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, sessionId);
  if (res.exceptionDetails) {
    throw new Error(`worker eval threw: ${res.exceptionDetails.text} ${
      res.exceptionDetails.exception?.description || ''}`);
  }
  return res.result?.value;
}

async function attachToWorker(browser) {
  await browser.send('Target.setDiscoverTargets', { discover: true });
  // Chrome ships its own component-extension workers (thunk.js), so match on the
  // script name rather than on "a service worker exists".
  const target = await waitFor('the extension service worker to appear', async () => {
    const { targetInfos } = await browser.send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
  }, 45_000, 250);
  const { sessionId } = await browser.send('Target.attachToTarget', {
    targetId: target.targetId, flatten: true,
  });
  // Without Runtime.enable the session evaluates in a bare worker global where
  // `chrome` carries only loadTimes/csi -- no chrome.runtime, no chrome.storage.
  // Enabling it creates (and reports) the extension's real execution context.
  await browser.send('Runtime.enable', {}, sessionId);
  await waitFor('the extension APIs to be live in the worker', async () => {
    try {
      return await evalInWorker(browser, sessionId, 'typeof chrome.storage === "object"');
    } catch { return false; }
  }, 20_000, 200);
  return { sessionId, extensionId: new URL(target.url).host };
}

// ------------------------------------------------------------------ agent-side helpers

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

/** The agent lane speaks CDP, so a refusal arrives as an error, not a throw we invent. */
async function cdpCall(agent, method, params) {
  try {
    return { ok: true, result: await agent.send(method, params) };
  } catch (err) {
    return { ok: false, error: String(err.message || err), code: err.code };
  }
}

// ------------------------------------------------------------------ main

async function main() {
  const watchdog = setTimeout(() => {
    console.error('\nFATAL: overall timeout; something hung.');
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);
  watchdog.unref?.();

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-chrome-'));
  const site = await startFixtureSite();
  const relay = await start({ token: TOKEN, extPort: EXT_PORT, agentPort: AGENT_PORT });
  const xvfb = startXvfb();
  const chrome = launchChrome({ userDataDir, display: xvfb && xvfb.display });

  let browser = null;
  let agent = null;

  const cleanup = () => {
    try { agent?.close(); } catch { /* gone */ }
    try { browser?.close(); } catch { /* gone */ }
    try { chrome.proc.kill('SIGKILL'); } catch { /* gone */ }
    try { xvfb?.proc?.kill('SIGKILL'); } catch { /* gone */ }
    try { relay.close(); } catch { /* gone */ }
    try { site.server.close(); } catch { /* gone */ }
    if (process.env.BR_KEEP !== '1') {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* fine */ }
    }
  };

  try {
    section(`browser: ${chrome.bin}  (${xvfb ? `headful on ${xvfb.display}` : 'headless'})`);
    const endpoint = await devtoolsEndpoint(userDataDir, chrome);
    browser = await Cdp.connect(endpoint.wsUrl);

    // ---------------------------------------------------------------- install
    section('extension loads in a real Chrome');
    const { sessionId, extensionId } = await attachToWorker(browser);
    ok('extension service worker is running', Boolean(sessionId), `id ${extensionId}`);

    const manifest = await evalInWorker(browser, sessionId, 'JSON.stringify(chrome.runtime.getManifest())');
    const parsed = JSON.parse(manifest);
    ok('manifest v3 loaded from disk', parsed.manifest_version === 3 && parsed.name === 'Zylos Browser Remote');
    ok('debugger + scripting permissions granted',
      parsed.permissions.includes('debugger') && parsed.permissions.includes('scripting'));

    // ---------------------------------------------------------------- arm a tab
    section('owner arms one tab');
    await browser.send('Target.createTarget', { url: `${site.base}/page1` });
    const tabId = await waitFor('the fixture tab to exist in chrome.tabs', async () => {
      const id = await evalInWorker(browser, sessionId,
        `chrome.tabs.query({url: ${JSON.stringify(`${site.base}/page1`)}}).then(t => t.length ? t[0].id : null)`);
      return id;
    }, 20_000);
    ok('fixture tab open in the real browser', Number.isInteger(tabId), `tabId ${tabId}`);

    // enabled:false first, so flipping it back to true is what triggers connect()
    // -- exactly the path the options page uses when the owner saves settings.
    await evalInWorker(browser, sessionId, `chrome.storage.local.set({
      relayUrl: 'ws://127.0.0.1:${EXT_PORT}/ext',
      token: ${JSON.stringify(TOKEN)},
      armedTabId: ${tabId},
      enabled: false
    })`);
    await evalInWorker(browser, sessionId, 'chrome.storage.local.set({enabled: true})');

    await waitFor('the extension to dial the relay', () => relay.ext.isConnected(), 30_000);
    ok('extension connected to the relay over the ext lane', relay.ext.isConnected());
    const tabs = await waitFor('the armed tab to be reported', () =>
      relay.ext.tabs.length ? relay.ext.tabs : null, 15_000);
    ok('relay sees exactly the armed tab', tabs.length === 1 && String(tabs[0].id) === String(tabId),
      JSON.stringify(tabs));

    // ---------------------------------------------------------------- discovery
    section('a stock CDP client can attach');
    const version = await getJson(`${AGENT_BASE}/json/version`);
    ok('/json/version is Chrome-shaped', version.body['Protocol-Version'] === '1.3');
    const list = await getJson(`${AGENT_BASE}/json/list`);
    const target = list.body[0];
    ok('/json/list offers one page target with a webSocketDebuggerUrl',
      list.body.length === 1 && target.type === 'page' && /^ws:\/\/127\.0\.0\.1:/.test(target.webSocketDebuggerUrl));
    ok('the target carries the real page title', target.title === 'BR fixture page one', target.title);

    agent = await Cdp.connect(target.webSocketDebuggerUrl);
    // Attach happens relay-side on connect; if it failed the socket is closed by now.
    await sleep(500);
    ok('agent socket stayed open (chrome.debugger attached)', agent.ws.readyState === WebSocket.OPEN);

    // ---------------------------------------------------------------- real DOM
    section('structured actions against a real DOM');
    const info = await cdpCall(agent, '_br.info', {});
    ok('_br.info round-trips through the real worker',
      info.ok && info.result.capabilities.includes('_br.snapshot'), JSON.stringify(info));

    const snap1 = await cdpCall(agent, '_br.snapshot', {});
    ok('_br.snapshot returns the real page', snap1.ok && snap1.result.title === 'BR fixture page one',
      JSON.stringify(snap1).slice(0, 200));
    const sels = (snap1.result?.elements || []).map((e) => e.selector);
    ok('snapshot found the real interactive elements',
      ['#name', '#go', '#docs', '#leave'].every((s) => sels.includes(s)), sels.join(' '));
    ok('snapshot read the label from the real <label for>',
      (snap1.result?.elements || []).find((e) => e.selector === '#name')?.label === 'Your name');
    ok('snapshot carries the page text', (snap1.result?.text || '').includes('fixture-marker-alpha'));

    const pw = (snap1.result?.elements || []).find((e) => e.selector === '#pw');
    ok('password field is reported but its value is redacted',
      Boolean(pw) && pw.redacted === true && pw.value === undefined, JSON.stringify(pw));
    ok('no password value anywhere in the snapshot payload',
      !JSON.stringify(snap1.result).includes('hunter2'));

    const fill = await cdpCall(agent, '_br.fill', { selector: '#name', text: 'zylos-real' });
    ok('_br.fill typed into the real field', fill.ok && fill.result.value === 'zylos-real',
      JSON.stringify(fill));

    const click = await cdpCall(agent, '_br.click', { selector: '#go' });
    ok('_br.click dispatched a real mouse event', click.ok && click.result.clicked === '#go',
      JSON.stringify(click));

    const waited = await cdpCall(agent, '_br.waitFor', { selector: '#later', state: 'visible', timeoutMs: 5000 });
    ok('_br.waitFor observed an element the page added later', waited.ok && waited.result.satisfied === true,
      JSON.stringify(waited));

    const snap2 = await cdpCall(agent, '_br.snapshot', {});
    ok("the page's own handler read back what was typed and clicked",
      snap2.ok && (snap2.result.text || '').includes('clicked:zylos-real'),
      (snap2.result?.text || '').slice(0, 120));

    const shot = await cdpCall(agent, '_br.screenshot', { format: 'jpeg', quality: 60 });
    const shotOk = shot.ok && typeof shot.result.data === 'string' && shot.result.data.length > 1000;
    ok('_br.screenshot captured real pixels',
      shotOk && Buffer.from(shot.result.data.slice(0, 16), 'base64')[0] === 0xff,
      shotOk ? `${shot.result.bytes} base64 chars` : JSON.stringify(shot).slice(0, 160));

    // ---------------------------------------------------------------- raw CDP
    section('allowlisted raw CDP');
    const nav = await cdpCall(agent, 'Page.navigate', { url: `${site.base}/page2` });
    ok('Page.navigate forwarded to chrome.debugger', nav.ok, JSON.stringify(nav));
    const snap3 = await waitFor('page two to be the current page', async () => {
      const s = await cdpCall(agent, '_br.snapshot', {});
      return s.ok && s.result.title === 'BR fixture page two' ? s : null;
    }, 15_000, 250);
    ok('the real tab actually navigated', snap3.result.url === `${site.base}/page2`, snap3.result.url);

    const back = await cdpCall(agent, '_br.navigate', { url: `${site.base}/page1` });
    ok('_br.navigate settled on the target page', back.ok && back.result.settled === true &&
      back.result.url === `${site.base}/page1`, JSON.stringify(back));

    // ---------------------------------------------------------------- refusals
    section('refusals, in a real browser');
    const evil = await cdpCall(agent, 'Runtime.evaluate', { expression: 'document.cookie' });
    ok('Runtime.evaluate refused at the chokepoint',
      !evil.ok && /banned/.test(evil.error), evil.error);

    const rawInput = await cdpCall(agent, 'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1 });
    ok('raw Input.* refused at the chokepoint', !rawInput.ok && /banned/.test(rawInput.error), rawInput.error);

    const toCheckout = await cdpCall(agent, '_br.navigate', { url: `${site.base}/checkout` });
    ok('navigating to a checkout URL refused', !toCheckout.ok && /blocklist/.test(toCheckout.error),
      toCheckout.error);

    const fillPw = await cdpCall(agent, '_br.fill', { selector: '#pw', text: 'secret' });
    ok('_br.fill refuses a password field', !fillPw.ok && /password/.test(fillPw.error), fillPw.error);

    const coveredClick = await cdpCall(agent, '_br.click', { selector: '#covered' });
    ok('_br.click refuses an element covered by an overlay (real elementFromPoint)',
      !coveredClick.ok && /covered by/.test(coveredClick.error), coveredClick.error);

    const ghost = await cdpCall(agent, '_br.click', { selector: '#does-not-exist' });
    ok('_br.click reports a missing element as an error', !ghost.ok && /no element matches/.test(ghost.error),
      ghost.error);

    // The one that needs a real browser: the PAGE navigates itself somewhere
    // blocklisted. The relay's cached URL is stale for a moment; the extension
    // re-screens against the tab's live URL and refuses regardless.
    section('the page navigates itself to a blocklisted URL');
    const leave = await cdpCall(agent, '_br.click', { selector: '#leave' });
    ok('clicking a button that self-navigates is allowed (its href is not blocked)', leave.ok,
      JSON.stringify(leave).slice(0, 160));

    const refusedOnCheckout = await waitFor('a refusal once the tab is on /checkout', async () => {
      const s = await cdpCall(agent, '_br.snapshot', {});
      return !s.ok && /blocklist/.test(s.error) ? s : null;
    }, 15_000, 200);
    ok('every action on the checkout page is refused', Boolean(refusedOnCheckout),
      refusedOnCheckout.error);

    const stillRefused = await cdpCall(agent, '_br.screenshot', {});
    ok('not even a screenshot of the checkout page', !stillRefused.ok && /blocklist/.test(stillRefused.error),
      stillRefused.error);
  } catch (err) {
    failures.push(`harness error: ${err.message}`);
    console.log(`\n  FAIL harness error -- ${err.stack}`);
    if (chrome.log.length) console.log(`\nchrome output tail:\n${chrome.log.join('').slice(-1500)}`);
  } finally {
    cleanup();
    clearTimeout(watchdog);
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) main();

// Exported for tools/live-bilibili.js, which drives a REAL public site with the
// same launch/attach/arm machinery instead of the local fixture.
module.exports = {
  findChrome, startXvfb, launchChrome, devtoolsEndpoint,
  Cdp, attachToWorker, evalInWorker, getJson, waitFor, sleep, cdpCall,
};
