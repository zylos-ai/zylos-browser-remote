'use strict';
/*
 * Step-by-step drive of the owner's real browser: search YouTube for 蜘蛛侠 and
 * play the first result.
 *
 * Differences from drive-youtube.js, both learned the hard way against the live
 * relay:
 *   1. The relay registers its agent-frame handler only AFTER round-tripping an
 *      `attach` to the extension. Frames sent before that are dropped with no
 *      response, no error and no log line. Hence the settle wait below.
 *   2. `_br.navigate` did not return within 45s against this tab, while
 *      snapshot/fill/press/click all answer promptly. So this script does not
 *      navigate: it drives the YouTube page already open in the armed tab,
 *      which is what a person would do anyway.
 *
 * Each call prints what it got back, so a failure says which step failed
 * instead of just "it didn't work".
 *
 * Run: node tools/drive-youtube2.js
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const AGENT_LANE = 'http://127.0.0.1:3803';
const QUERY = '蜘蛛侠';
const SHOT = '/tmp/youtube-spiderman.jpg';
const SETTLE_MS = 4000;
const CALL_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    let b = '';
    res.on('data', (d) => { b += d; });
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); p(m); }
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      // Never rejects: returns {ok,result} or {ok:false,error} so one bad step
      // reports itself instead of killing the run.
      call(method, params = {}) {
        const i = ++id;
        return new Promise((res) => {
          const t = setTimeout(() => { pending.delete(i); res({ ok: false, error: `timed out after ${CALL_TIMEOUT_MS}ms` }); }, CALL_TIMEOUT_MS);
          pending.set(i, (m) => {
            clearTimeout(t);
            if (m.error) res({ ok: false, error: JSON.stringify(m.error) });
            else res({ ok: true, result: m.result });
          });
          ws.send(JSON.stringify({ id: i, method, params }));
        });
      },
      close() { try { ws.close(); } catch { /* gone */ } },
    }));
  });
}

async function main() {
  const list = await getJson(`${AGENT_LANE}/json/list`);
  if (!list.length) throw new Error('no armed tab — the owner has not armed one');
  console.log(`armed tab: ${JSON.stringify(list[0].title)} @ ${list[0].url}`);

  const a = await connect(list[0].webSocketDebuggerUrl);
  await sleep(SETTLE_MS);

  // ---- 1. where are we? ----
  let snap = await a.call('_br.snapshot', { maxElements: 400 });
  if (!snap.ok) throw new Error(`snapshot failed: ${snap.error}`);
  console.log(`PAGE  ${JSON.stringify(snap.result.title)} @ ${snap.result.url}`);

  // ---- 2. type the query into YouTube's own search box ----
  const box = snap.result.elements.find((e) =>
    e.selector === 'input[name="search_query"]')
    || snap.result.elements.find((e) =>
      (e.tag === 'input' || e.role === 'combobox') &&
      /search|搜索|搜尋/i.test(`${e.label || ''} ${e.selector} ${e.placeholder || ''}`));
  if (!box) throw new Error('no search box in the snapshot');
  console.log(`BOX   ${JSON.stringify(box)}`);

  const fill = await a.call('_br.fill', { selector: box.selector, text: QUERY });
  console.log(`FILL  -> ${JSON.stringify(fill).slice(0, 250)}`);
  if (!fill.ok) throw new Error(`fill failed: ${fill.error}`);

  const press = await a.call('_br.press', { selector: box.selector, key: 'Enter' });
  console.log(`ENTER -> ${JSON.stringify(press).slice(0, 250)}`);

  // If Enter did not take, click YouTube's own search button.
  await sleep(4000);
  snap = await a.call('_br.snapshot', { maxElements: 600, maxChars: 3000 });
  if (!snap.ok) throw new Error(`post-search snapshot failed: ${snap.error}`);
  console.log(`PAGE  ${JSON.stringify(snap.result.title)} @ ${snap.result.url}`);

  if (!/results\?search_query|\/results/.test(snap.result.url || '')) {
    const btn = snap.result.elements.find((e) => /^search$|搜索/i.test(e.label || '') && e.tag === 'button');
    if (btn) {
      const c = await a.call('_br.click', { selector: btn.selector });
      console.log(`CLICK search button -> ${JSON.stringify(c).slice(0, 200)}`);
      await sleep(4500);
      snap = await a.call('_br.snapshot', { maxElements: 600, maxChars: 3000 });
      console.log(`PAGE  ${JSON.stringify(snap.result?.title)} @ ${snap.result?.url}`);
    }
  }

  // ---- 3. first real video result ----
  const videos = (snap.result.elements || []).filter((e) =>
    e.href && /\/watch\?v=/.test(e.href) && (e.label || '').trim().length > 3);
  console.log(`\n${videos.length} video links; first few:`);
  for (const v of videos.slice(0, 5)) console.log(`  - ${(v.label || '').slice(0, 70)}  ${v.href.slice(0, 60)}`);
  if (!videos.length) {
    fs.writeFileSync('/tmp/yt-dump.json', JSON.stringify(snap.result, null, 2));
    throw new Error('no /watch?v= links found (dumped /tmp/yt-dump.json)');
  }

  // ---- 4. play it ----
  const first = videos[0];
  console.log(`\nPLAY  ${JSON.stringify((first.label || '').slice(0, 100))}`);
  const click = await a.call('_br.click', { selector: first.selector });
  console.log(`CLICK -> ${JSON.stringify(click).slice(0, 250)}`);
  await sleep(6000);

  // ---- 5. confirm + screenshot ----
  const watch = await a.call('_br.snapshot', { maxElements: 60, maxChars: 800 });
  if (watch.ok) {
    console.log(`\nWATCH ${JSON.stringify(watch.result.title)} @ ${watch.result.url}`);
    console.log(`      on a watch page: ${/\/watch\?v=/.test(watch.result.url || '')}`);
  } else {
    console.log(`\nWATCH snapshot failed: ${watch.error}`);
  }

  const shot = await a.call('_br.screenshot', { format: 'jpeg', quality: 70 });
  if (shot.ok && shot.result?.data) {
    fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
    console.log(`      screenshot ${SHOT} (${fs.statSync(SHOT).size} bytes)`);
  } else {
    console.log(`      screenshot: ${JSON.stringify(shot).slice(0, 200)}`);
  }

  a.close();
  console.log('\nDONE');
  process.exit(0);
}

main().catch((e) => { console.error(`\nFAILED: ${e.message}`); process.exit(1); });
