'use strict';
/*
 * Live-site drive: bilibili, search for 蜘蛛侠, read the results back.
 *
 * Same machinery as tools/test-real-chrome.js (real Chrome, real extension,
 * real relay, real CDP client) pointed at a real public website instead of a
 * local fixture. The fixture proves the mechanism; a site nobody built for this
 * test is what proves the snapshot/selector logic survives contact with real
 * markup -- lazy-loaded chrome, framework-generated class names, overlays.
 *
 * NOT a login test, on purpose. This extension refuses to type into a password
 * field (actions.js pagePrepareFill), and it is designed to run inside the
 * owner's ALREADY logged-in browser -- reusing their session is the whole point,
 * so there is nothing for the agent to log into. This process has no credentials
 * and asks for none.
 *
 * It reports what happened rather than asserting: a public site can change or
 * rate-limit at any time, and a test that turns red because bilibili redesigned
 * its header is a test nobody trusts.
 *
 * Run: node tools/live-bilibili.js
 */

const { start } = require('../relay/server');
const {
  launchChrome, startXvfb, devtoolsEndpoint, Cdp, attachToWorker, evalInWorker,
  getJson, waitFor, sleep, cdpCall,
} = require('./test-real-chrome');

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const EXT_PORT = 3942;
const AGENT_PORT = 3943;
const TOKEN = 'live-bilibili-token-not-a-secret';
const HOME = 'https://www.bilibili.com/';
const QUERY = '蜘蛛侠';
const SHOT = '/tmp/bilibili-search.jpg';

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-live-'));
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
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* fine */ }
  };

  try {
    const endpoint = await devtoolsEndpoint(userDataDir, chrome);
    browser = await Cdp.connect(endpoint.wsUrl);
    const { sessionId } = await attachToWorker(browser);
    console.log('extension loaded, service worker attached');

    await browser.send('Target.createTarget', { url: HOME });
    const tabId = await waitFor('the bilibili tab', () => evalInWorker(browser, sessionId,
      'chrome.tabs.query({}).then(ts => { const t = ts.find(x => /bilibili\\.com/.test(x.url || "")); return t ? t.id : null; })'),
    30_000);
    console.log(`armed tab ${tabId} on ${HOME}`);

    await evalInWorker(browser, sessionId, `chrome.storage.local.set({
      relayUrl: 'ws://127.0.0.1:${EXT_PORT}/ext',
      token: ${JSON.stringify(TOKEN)}, armedTabId: ${tabId}, enabled: false })`);
    await evalInWorker(browser, sessionId, 'chrome.storage.local.set({enabled: true})');
    await waitFor('the extension to dial the relay', () => relay.ext.isConnected(), 30_000);
    await waitFor('the armed tab to be reported', () => relay.ext.tabs.length || null, 15_000);

    const list = await getJson(`http://127.0.0.1:${AGENT_PORT}/json/list`);
    agent = await Cdp.connect(list.body[0].webSocketDebuggerUrl);
    await sleep(500);
    console.log(`agent attached via ${list.body[0].webSocketDebuggerUrl}\n`);

    // ---- 1. what does the agent actually see on the home page? ----
    const home = await cdpCall(agent, '_br.snapshot', { maxElements: 400 });
    if (!home.ok) throw new Error(`snapshot failed: ${home.error}`);
    console.log(`HOME  title=${JSON.stringify(home.result.title)}  url=${home.result.url}`);
    console.log(`      ${home.result.elements.length} interactive elements visible (of ${home.result.elementsTotal})`);

    // The agent picks the search box from the snapshot the same way a model
    // would: by what the page says about it, not by a selector we hardcoded.
    const box = home.result.elements.find((e) =>
      (e.tag === 'input' || e.role === 'combobox') &&
      /搜索|search/i.test(`${e.label || ''} ${e.selector}`));
    console.log(`      search box guessed from the snapshot: ${box ? JSON.stringify(box) : 'NOT FOUND'}`);

    // ---- 2. type the query into the real page ----
    let searched = null;
    if (box) {
      const fill = await cdpCall(agent, '_br.fill', { selector: box.selector, text: QUERY });
      console.log(`FILL  ${JSON.stringify(fill).slice(0, 200)}`);
      if (fill.ok) {
        const btn = home.result.elements.find((e) =>
          /搜索|search/i.test(`${e.label || ''}`) && e.selector !== box.selector);
        if (btn) {
          const click = await cdpCall(agent, '_br.click', { selector: btn.selector });
          console.log(`CLICK ${btn.selector} -> ${JSON.stringify(click).slice(0, 200)}`);
          if (click.ok) searched = 'typed into the page and clicked its own search control';
        } else {
          console.log('CLICK no search button in the snapshot (bilibili submits on Enter, which P0 has no action for)');
        }
      }
    }

    // ---- 3. fall back to navigating to the search URL ----
    if (!searched) {
      const url = `https://search.bilibili.com/all?keyword=${encodeURIComponent(QUERY)}`;
      const nav = await cdpCall(agent, '_br.navigate', { url });
      console.log(`NAV   ${url} -> ${JSON.stringify(nav).slice(0, 200)}`);
      if (nav.ok) searched = 'navigated straight to the search URL';
    }

    // ---- 4. read the results back ----
    await sleep(2500);                      // results render client-side
    const results = await cdpCall(agent, '_br.snapshot', { maxElements: 400, maxChars: 6000 });
    if (!results.ok) throw new Error(`results snapshot failed: ${results.error}`);
    console.log(`\nRESULTS via: ${searched}`);
    console.log(`  title=${JSON.stringify(results.result.title)}`);
    console.log(`  url=${results.result.url}`);
    const hits = results.result.elements
      .filter((e) => e.href && /video\/BV|bangumi/.test(e.href) && (e.label || '').length > 4)
      .slice(0, 10);
    console.log(`  ${hits.length} result links recognised by the snapshot:`);
    for (const h of hits) console.log(`   - ${h.label.slice(0, 60)}  ${h.href.slice(0, 60)}`);
    const mentions = (results.result.text.match(new RegExp(QUERY, 'g')) || []).length;
    console.log(`  "${QUERY}" appears ${mentions}x in the page text the agent got back`);

    const shot = await cdpCall(agent, '_br.screenshot', { format: 'jpeg', quality: 70 });
    if (shot.ok) {
      fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
      console.log(`  screenshot: ${SHOT} (${fs.statSync(SHOT).size} bytes)`);
    } else {
      console.log(`  screenshot refused: ${shot.error}`);
    }

    // ---- 5. the login question, answered by the code rather than by opinion ----
    console.log('\nLOGIN, for the record:');
    const loginNav = await cdpCall(agent, '_br.navigate', { url: 'https://passport.bilibili.com/login' });
    console.log(`  navigate to the login page -> ${loginNav.ok ? 'allowed' : `refused: ${loginNav.error}`}`);
    if (loginNav.ok) {
      await sleep(2000);
      const lsnap = await cdpCall(agent, '_br.snapshot', {});
      const pwField = lsnap.ok && lsnap.result.elements.find((e) => e.type === 'password');
      console.log(`  password field on that page: ${pwField ? JSON.stringify(pwField) : 'none visible'}`);
      if (pwField) {
        const typed = await cdpCall(agent, '_br.fill', { selector: pwField.selector, text: 'whatever' });
        console.log(`  typing into it -> ${typed.ok ? 'ALLOWED (bug!)' : `refused: ${typed.error}`}`);
      }
    }
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
