'use strict';
/*
 * Drive the owner's real browser (via the live relay agent lane) to:
 *   open YouTube -> search 蜘蛛侠 -> play the first result.
 *
 * Unlike tools/live-bilibili.js this launches NOTHING: no Chrome, no Xvfb, no
 * relay. It attaches to the already-running zylos-browser-relay agent lane on
 * 127.0.0.1:3803, which is wired to whatever tab the owner armed in the
 * extension. Everything happens in his browser, on his network, in his session.
 *
 * Run: node tools/drive-youtube.js
 */

const WebSocket = require('ws');

const AGENT_LANE = 'http://127.0.0.1:3803';
const QUERY = '蜘蛛侠';
const SHOT = '/tmp/youtube-spiderman.jpg';
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    require('http').get(url, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const c = new Cdp(ws);
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        const p = c.pending.get(msg.id);
        if (p) { c.pending.delete(msg.id); p(msg); }
      });
      ws.on('open', () => resolve(c));
      ws.on('error', reject);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method} timed out`)), 45_000);
      this.pending.set(id, (msg) => {
        clearTimeout(t);
        if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { try { this.ws.close(); } catch { /* gone */ } }
}

// _br.* actions resolve directly to the flat result object on success (e.g.
// {url,title,settled} for navigate, {clicked,tag,x,y,href} for click) and
// REJECT (agent.send throws) on refusal/error -- there is no {ok,result}
// envelope from the extension itself. Normalize to {ok,result|error} here so
// the call sites below can check `.ok`.
async function br(agent, action, params = {}) {
  try {
    const result = await agent.send(action, params);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function main() {
  const list = await getJson(`${AGENT_LANE}/json/list`);
  if (!list.length) throw new Error('no armed tab on the agent lane — owner has not armed a tab');
  console.log(`armed tab: ${JSON.stringify(list[0].title)} @ ${list[0].url}`);
  console.log(`           ${list[0].description}`);

  const agent = await Cdp.connect(list[0].webSocketDebuggerUrl);
  // The relay only registers its agent-frame handler AFTER it has round-tripped
  // an `attach` to the extension, so anything sent before that lands in a void:
  // no response, no error, no log line -- it just never happened. Until that is
  // fixed in agent-lane.js, a caller has to wait the handshake out.
  await sleep(4000);

  // ---- 1. open YouTube ----
  const nav = await br(agent, '_br.navigate', { url: 'https://www.youtube.com/' });
  console.log(`NAV   youtube.com -> ${JSON.stringify(nav).slice(0, 300)}`);
  if (!nav.ok) throw new Error(`navigate refused: ${nav.error}`);
  await sleep(4000);

  // ---- 2. search, preferring the page's own search box ----
  let searched = null;
  const home = await br(agent, '_br.snapshot', { maxElements: 400 });
  if (home.ok) {
    console.log(`HOME  title=${JSON.stringify(home.result.title)} url=${home.result.url}`);
    console.log(`      ${home.result.elements.length} interactive of ${home.result.elementsTotal}`);
    const box = home.result.elements.find((e) =>
      (e.tag === 'input' || e.role === 'combobox') &&
      /search|搜索|搜尋/i.test(`${e.label || ''} ${e.selector} ${e.placeholder || ''}`));
    console.log(`      search box: ${box ? JSON.stringify(box) : 'NOT FOUND in snapshot'}`);
    if (box) {
      const fill = await br(agent, '_br.fill', { selector: box.selector, text: QUERY });
      console.log(`FILL  -> ${JSON.stringify(fill).slice(0, 200)}`);
      if (fill.ok) {
        const press = await br(agent, '_br.press', { selector: box.selector, key: 'Enter' });
        console.log(`PRESS Enter -> ${JSON.stringify(press).slice(0, 200)}`);
        if (press.ok) searched = 'typed into YouTube\'s own search box and pressed Enter';
      }
    }
  } else {
    console.log(`HOME  snapshot failed: ${home.error}`);
  }

  // ---- 3. fall back to the search URL ----
  if (!searched) {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(QUERY)}`;
    const n2 = await br(agent, '_br.navigate', { url });
    console.log(`NAV   ${url} -> ${JSON.stringify(n2).slice(0, 200)}`);
    if (!n2.ok) throw new Error(`search navigate refused: ${n2.error}`);
    searched = 'navigated straight to the search-results URL';
  }
  await sleep(4500);

  // ---- 4. find the first real video result ----
  const results = await br(agent, '_br.snapshot', { maxElements: 600, maxChars: 4000 });
  if (!results.ok) throw new Error(`results snapshot failed: ${results.error}`);
  console.log(`\nRESULTS via: ${searched}`);
  console.log(`  title=${JSON.stringify(results.result.title)}`);
  console.log(`  url=${results.result.url}`);

  const videos = results.result.elements.filter((e) =>
    e.href && /\/watch\?v=/.test(e.href) && (e.label || '').trim().length > 3);
  console.log(`  ${videos.length} video links visible; first few:`);
  for (const v of videos.slice(0, 5)) {
    console.log(`   - ${(v.label || '').slice(0, 70)}  ${v.href.slice(0, 70)}`);
  }
  if (!videos.length) {
    fs.writeFileSync('/tmp/youtube-results-dump.json', JSON.stringify(results.result, null, 2));
    throw new Error('no /watch?v= links in the snapshot (dumped to /tmp/youtube-results-dump.json)');
  }

  // ---- 5. play it ----
  const first = videos[0];
  console.log(`\nPLAY  first result: ${JSON.stringify((first.label || '').slice(0, 90))}`);
  let played = null;
  const click = await br(agent, '_br.click', { selector: first.selector });
  console.log(`CLICK ${first.selector} -> ${JSON.stringify(click).slice(0, 200)}`);
  if (click.ok) played = 'clicked the first result';
  else {
    const n3 = await br(agent, '_br.navigate', { url: first.href });
    console.log(`NAV   ${first.href} -> ${JSON.stringify(n3).slice(0, 200)}`);
    if (n3.ok) played = 'navigated to the first result';
  }
  if (!played) throw new Error('could not open the first result');
  await sleep(6000);

  // ---- 6. confirm it is actually playing ----
  const watch = await br(agent, '_br.snapshot', { maxElements: 120, maxChars: 1500 });
  if (watch.ok) {
    console.log(`\nWATCH title=${JSON.stringify(watch.result.title)}`);
    console.log(`      url=${watch.result.url}`);
    const onWatch = /\/watch\?v=/.test(watch.result.url || '');
    console.log(`      on a watch page: ${onWatch}`);
  } else {
    console.log(`\nWATCH snapshot failed: ${watch.error}`);
  }

  const shot = await br(agent, '_br.screenshot', { format: 'jpeg', quality: 70 });
  if (shot.ok) {
    fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
    console.log(`      screenshot: ${SHOT} (${fs.statSync(SHOT).size} bytes)`);
  } else {
    console.log(`      screenshot refused: ${shot.error}`);
  }

  agent.close();
  console.log('\nDONE');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.stack}`);
  process.exit(1);
});
