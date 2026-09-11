'use strict';
/*
 * Screen-record the bilibili drive, so the run can be watched instead of
 * described.
 *
 * The flow is the one tools/live-bilibili.js already drives -- home page,
 * recognise the search box from the snapshot, type 蜘蛛侠 into it, submit,
 * read the results -- with one change: submission is now _br.press Enter
 * (the P1 gap that did not exist when live-bilibili.js was written), with the
 * search-URL navigate kept only as a fallback so a bilibili redesign degrades
 * the recording instead of ending it.
 *
 * WHERE THE PICTURE COMES FROM, precisely, because it matters:
 *
 *   The AGENT drives the page through the relay chokepoint and may call only
 *   _br.* actions -- unchanged, nothing widened, relay/chokepoint.js and
 *   extension/policy.js are untouched by this file.
 *
 *   The CAMERA is this harness's own direct connection to the throwaway
 *   Chrome it launched (Page.startScreencast on the page target). That is the
 *   recording apparatus, not a capability handed to the agent: the agent
 *   socket cannot reach Page.* at all, and this file does not try to make it.
 *   Recording via the agent lane instead would mean polling _br.screenshot at
 *   a couple of frames a second, which is a slideshow of a typing demo.
 *
 * The extension attaches chrome.debugger to the tab for the actions that need
 * CDP. Chrome supports more than one CDP client per target, but the ORDER is
 * load-bearing here: one _br.screenshot is fired first so the extension's
 * chrome.debugger session exists before the camera attaches. If the camera
 * still cannot attach, the run continues without it and says so -- a recording
 * that silently records nothing is worse than a failure.
 *
 * No credentials, no login, same as live-bilibili.js: a throwaway profile.
 *
 * Run: node tools/record-bilibili.js [outDir]        (default /tmp/br-rec)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { start } = require('../relay/server');
const {
  launchChrome, startXvfb, devtoolsEndpoint, Cdp, attachToWorker, evalInWorker,
  getJson, waitFor, sleep, cdpCall,
} = require('./test-real-chrome');

const EXT_PORT = 3952;              // not 3932/3933 (real-chrome), 3942/3943 (live-bilibili)
const AGENT_PORT = 3953;
const TOKEN = 'record-bilibili-token-not-a-secret';
const HOME = 'https://www.bilibili.com/';
const QUERY = '蜘蛛侠';
const OUT_DIR = path.resolve(process.argv[2] || '/tmp/br-rec');
const FRAME_DIR = path.join(OUT_DIR, 'frames');
const MAX_FRAMES = 1500;
const OVERALL_TIMEOUT_MS = 300_000;
// 1280 is the window; the delivered frame is scaled down because every frame
// is also a byte the owner has to download to watch this.
const CAST = { format: 'jpeg', quality: 65, maxWidth: 1024, maxHeight: 800, everyNthFrame: 1 };

// ------------------------------------------------------------------ recording

/**
 * Attach a screencast to one page target and collect its frames.
 * Frames arrive only when the page actually changes, so the manifest carries
 * each frame's arrival time: the player reconstructs real pacing from that
 * rather than pretending a fixed frame rate.
 */
function makeCamera(browser, t0) {
  const frames = [];
  let session = null;
  let lastHash = null;
  let dropped = 0;
  let lastFrameAt = 0;
  let ackFailures = 0;
  let rearms = 0;
  let watchdog = null;

  browser.ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.method !== 'Page.screencastFrame' || !session || msg.sessionId !== session) return;
    lastFrameAt = Date.now();

    // Ack first and unconditionally: Chrome sends at most one unacked frame, so
    // a frame we drop for being a duplicate must still be acked or the
    // screencast stops after this one.
    browser.send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }, session)
      .catch(() => { ackFailures++; });

    if (frames.length >= MAX_FRAMES) { dropped++; return; }
    const buf = Buffer.from(msg.params.data, 'base64');
    const hash = crypto.createHash('sha1').update(buf).digest('hex');
    if (hash === lastHash) { dropped++; return; }   // the page redrew identically
    lastHash = hash;

    const file = `f${String(frames.length).padStart(5, '0')}.jpg`;
    fs.writeFileSync(path.join(FRAME_DIR, file), buf);
    frames.push({ file, t: Date.now() - t0, bytes: buf.length });
  });

  return {
    frames,
    get dropped() { return dropped; },
    get attached() { return session !== null; },
    get stats() { return { ackFailures, rearms }; },
    async attach(targetId) {
      const open = async () => {
        const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
        session = sessionId;
        await browser.send('Page.enable', {}, session);
        await browser.send('Page.startScreencast', CAST, session);
        lastFrameAt = Date.now();
      };
      await open();

      // Frame delivery stops for two different reasons, and both happened while
      // building this: the page stops being VISIBLE (bilibili's Enter opens a
      // new foreground tab -- handled in main by closing it and re-activating
      // the armed tab), and a navigation swaps the renderer out from under the
      // screencast, after which re-asking on the SAME session is silently
      // ignored. So recovery escalates rather than repeating: re-ask, then
      // re-attach a fresh session. Behavioural, not event-driven -- the trigger
      // is "no frame for 1.5s", which is true whatever the cause.
      let staleTicks = 0;
      watchdog = setInterval(() => {
        if (!session || Date.now() - lastFrameAt < 1500) { staleTicks = 0; return; }
        staleTicks++;
        rearms++;
        lastFrameAt = Date.now();      // don't re-ask every tick on a static page
        if (staleTicks < 2) {
          browser.send('Page.enable', {}, session)
            .then(() => browser.send('Page.startScreencast', CAST, session))
            .catch(() => { /* target gone */ });
        } else {
          staleTicks = 0;
          open().catch(() => { /* target gone */ });
        }
      }, 500);
      watchdog.unref?.();
    },
    async stop() {
      if (watchdog) clearInterval(watchdog);
      if (!session) return;
      try { await browser.send('Page.stopScreencast', {}, session); } catch { /* gone */ }
    },
  };
}

// ------------------------------------------------------------------ main

async function main() {
  const watchdog = setTimeout(() => {
    console.error('\nFATAL: overall timeout; something hung.');
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);
  watchdog.unref?.();

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(FRAME_DIR, { recursive: true });

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-rec-profile-'));
  const relay = await start({ token: TOKEN, extPort: EXT_PORT, agentPort: AGENT_PORT });
  const xvfb = startXvfb();
  const chrome = launchChrome({ userDataDir, display: xvfb && xvfb.display });
  let browser = null;
  let agent = null;
  let camera = null;

  const t0 = Date.now();
  const steps = [];
  /** One narrated beat of the run, stamped against the same clock as the frames. */
  const step = (label, detail = '') => {
    const s = { t: Date.now() - t0, label, detail };
    steps.push(s);
    console.log(`[${String(s.t).padStart(6)}ms] ${label}${detail ? ` -- ${detail}` : ''}`);
    return s;
  };

  const cleanup = () => {
    try { agent?.close(); } catch { /* gone */ }
    try { browser?.close(); } catch { /* gone */ }
    try { chrome.proc.kill('SIGKILL'); } catch { /* gone */ }
    try { xvfb?.proc?.kill('SIGKILL'); } catch { /* gone */ }
    try { relay.close(); } catch { /* gone */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* fine */ }
  };

  try {
    const endpoint = await devtoolsEndpoint(userDataDir, chrome);
    browser = await Cdp.connect(endpoint.wsUrl);
    const { sessionId } = await attachToWorker(browser);
    step('extension loaded in a throwaway Chrome');

    const { targetId } = await browser.send('Target.createTarget', { url: HOME });
    const tabId = await waitFor('the bilibili tab', () => evalInWorker(browser, sessionId,
      'chrome.tabs.query({}).then(ts => { const t = ts.find(x => /bilibili\\.com/.test(x.url || "")); return t ? t.id : null; })'),
    30_000);
    step('opened bilibili home', HOME);

    await evalInWorker(browser, sessionId, `chrome.storage.local.set({
      relayUrl: 'ws://127.0.0.1:${EXT_PORT}/ext',
      token: ${JSON.stringify(TOKEN)}, armedTabId: ${tabId}, enabled: false })`);
    await evalInWorker(browser, sessionId, 'chrome.storage.local.set({enabled: true})');
    await waitFor('the extension to dial the relay', () => relay.ext.isConnected(), 30_000);
    await waitFor('the armed tab to be reported', () => relay.ext.tabs.length || null, 15_000);

    const list = await getJson(`http://127.0.0.1:${AGENT_PORT}/json/list`);
    agent = await Cdp.connect(list.body[0].webSocketDebuggerUrl);
    await sleep(500);
    step(`agent attached to tab ${tabId} through the relay`);

    // Warm-up screenshot: forces the extension's chrome.debugger attach to
    // happen BEFORE the camera's, per the header note.
    const warm = await cdpCall(agent, '_br.screenshot', { format: 'jpeg', quality: 40 });
    console.log(`      warm-up _br.screenshot: ${warm.ok ? `${warm.result.bytes} b64 bytes` : warm.error}`);

    camera = makeCamera(browser, t0);
    try {
      await camera.attach(targetId);
      step('recording started');
    } catch (err) {
      step('recording UNAVAILABLE', String(err.message || err));
    }
    await sleep(2000);                        // a beat of the home page as it sits

    // ---- 1. find the search box the way a model would: from the snapshot ----
    const home = await cdpCall(agent, '_br.snapshot', { maxElements: 400 });
    if (!home.ok) throw new Error(`snapshot failed: ${home.error}`);
    const box = home.result.elements.find((e) =>
      (e.tag === 'input' || e.role === 'combobox') &&
      /搜索|search/i.test(`${e.label || ''} ${e.selector}`));
    step('read the page: snapshot',
      `${home.result.elements.length}/${home.result.elementsTotal} interactive elements, title ${JSON.stringify(home.result.title)}`);
    if (!box) throw new Error('no search box in the snapshot; bilibili markup changed');
    step('recognised the search box', `${box.selector}  label=${JSON.stringify(box.label || '')}`);
    await sleep(800);

    // ---- 2. type the query into the real page ----
    const fill = await cdpCall(agent, '_br.fill', { selector: box.selector, text: QUERY });
    if (!fill.ok) throw new Error(`fill failed: ${fill.error}`);
    step(`typed ${QUERY} into it`, `value read back: ${JSON.stringify(fill.result.value)}`);
    await sleep(1500);                        // the suggestion dropdown renders

    // ---- 3. submit with the new named-key action ----
    const before = home.result.url;
    const press = await cdpCall(agent, '_br.press', { key: 'Enter', selector: box.selector, timeoutMs: 8000 });
    step(press.ok ? 'pressed Enter (_br.press)' : 'Enter refused',
      press.ok ? `armed tab url now ${press.result.url}, settled=${press.result.settled}` : press.error);
    await sleep(2500);

    let where = press.ok ? press.result.url : before;
    let how = press.ok && /search\.bilibili\.com|\/search/.test(where)
      ? 'typed into bilibili\'s own box and pressed Enter'
      : null;

    // Where did Enter actually go? bilibili's header search opens its results in
    // a NEW tab, and this extension drives exactly one armed tab -- so "the
    // armed tab is still on the home page" can mean the submit worked and the
    // result landed somewhere we deliberately do not follow. Worth recording as
    // a fact rather than guessing at it in a report afterwards.
    if (!how) {
      const tabs = await cdpCall(agent, '_br.listTabs', {});
      if (tabs.ok) {
        const elsewhere = tabs.result.tabs.filter((t) => /search\.bilibili\.com|\/search\?|keyword=/.test(t.url || ''));
        step('checked where Enter went',
          elsewhere.length
            ? `bilibili opened the results in a NEW tab (${elsewhere.map((t) => `#${t.id} armed=${t.armed}`).join(', ')}); ` +
              'the extension drives only the armed tab, so it does not follow'
            : `no results tab appeared; ${tabs.result.tabs.length} tab(s) open`);

        // Camera housekeeping, not an agent action: a screencast only delivers
        // frames for a VISIBLE page, so bilibili's new foreground tab silently
        // ended the recording in the first two runs. Close what Enter spawned
        // and put the armed tab back in front.
        for (const t of elsewhere.filter((x) => !x.armed)) {
          await evalInWorker(browser, sessionId, `chrome.tabs.remove(${t.id}).then(() => true)`);
        }
        await evalInWorker(browser, sessionId, `chrome.tabs.update(${tabId}, {active: true}).then(() => true)`);
        await sleep(500);
      }
    }

    // ---- 4. fallback, so a redesign degrades the recording instead of ending it ----
    if (!how) {
      const url = `https://search.bilibili.com/all?keyword=${encodeURIComponent(QUERY)}`;
      const nav = await cdpCall(agent, '_br.navigate', { url });
      step(nav.ok ? 'brought the results into the armed tab (_br.navigate)' : 'navigate refused',
        nav.ok ? url : nav.error);
      if (nav.ok) { how = 'typed + Enter in the page, then _br.navigate to bring the results into the armed tab'; where = url; }
      await sleep(3000);
    }

    // ---- 5. read the results back ----
    await sleep(2000);
    const results = await cdpCall(agent, '_br.snapshot', { maxElements: 400, maxChars: 6000 });
    if (!results.ok) throw new Error(`results snapshot failed: ${results.error}`);
    const hits = results.result.elements
      .filter((e) => e.href && /video\/BV|bangumi/.test(e.href) && (e.label || '').length > 4)
      .slice(0, 10);
    const mentions = (results.result.text.match(new RegExp(QUERY, 'g')) || []).length;
    step('read the results back',
      `${hits.length} result links, "${QUERY}" appears ${mentions}x, title ${JSON.stringify(results.result.title)}`);
    for (const h of hits) console.log(`        - ${h.label.slice(0, 60)}`);
    await sleep(1500);

    await camera.stop();
    const frames = camera.frames;

    const manifest = {
      recordedAt: new Date(t0).toISOString(),
      query: QUERY,
      home: HOME,
      resultsUrl: results.result.url,
      resultsTitle: results.result.title,
      how,
      durationMs: Date.now() - t0,
      viewport: { width: 1280, height: 1000 },
      cameraAttached: camera.attached,
      cameraStats: camera.stats,
      framesDroppedAsDuplicate: camera.dropped,
      steps,
      resultLinks: hits.map((h) => ({ label: h.label, href: h.href })),
      frames,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const totalBytes = frames.reduce((n, f) => n + f.bytes, 0);
    console.log(`\n${frames.length} frames kept (${(totalBytes / 1e6).toFixed(1)} MB), ` +
      `${camera.dropped} dropped as duplicates, over ${(manifest.durationMs / 1000).toFixed(1)}s`);
    console.log(`manifest: ${path.join(OUT_DIR, 'manifest.json')}`);
    if (!frames.length) console.log('WARNING: no frames were captured; nothing to publish.');
  } catch (err) {
    console.error(`\nFAILED: ${err.stack}`);
    if (chrome.log.length) console.error(chrome.log.join('').slice(-1200));
    cleanup();
    process.exit(1);
  }
  cleanup();
  process.exit(0);
}

main();
