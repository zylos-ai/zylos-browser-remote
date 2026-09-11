'use strict';
/*
 * Side-panel chat bridge tests (SIDEPANEL-SPEC.md A + C).
 *
 * Covers the two halves that carry the owner's words:
 *   ingress  panel --WS {type:'chat'}--> relay --spawn--> c4-receive
 *   egress   agent --POST /chat (:3803 loopback)--> relay --WS--> panel
 *
 * c4-receive is stubbed through ZYLOS_C4_RECEIVE, and the stub records its own
 * argv: the point of the ingress assertions is that the owner's text arrives as
 * ONE argv element, byte-identical, with no shell anywhere in the path. The
 * sample text is deliberately full of shell metacharacters -- if any layer ever
 * routes this through `sh -c`, these assertions are what notices.
 *
 * Offline, loopback only, ephemeral ports (never 3802/3803: a live relay may
 * hold those). Run: node tools/test-chat-bridge.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { start } = require('../relay/server');
const { SUBPROTOCOL, MAX_CHAT_TEXT } = require('../relay/ext-lane');
const chokepoint = require('../relay/chokepoint');

const TOKEN = 'chat-bridge-token-not-a-secret';
// Not 3802/3803 (a live relay holds those), not 3902/3903 (smoke), not
// 3912/3913 (test-extension).
const EXT_PORT = 3922;
const AGENT_PORT = 3923;
const BASE = `http://127.0.0.1:${AGENT_PORT}`;
const SESSION = 'f7c1a9e2-0b44-4a51-9d0e-2c3b5a7e1d88';

let pass = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); return; }
  failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- c4-receive stubs ------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zbr-chat-'));
const ARGV_LOG = path.join(tmp, 'argv.jsonl');
const OK_STUB = path.join(tmp, 'c4-receive-ok.js');
const FAIL_STUB = path.join(tmp, 'c4-receive-fail.js');

fs.writeFileSync(OK_STUB, `'use strict';
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(ARGV_LOG)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(0);
`);
fs.writeFileSync(FAIL_STUB, `'use strict';
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(ARGV_LOG)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stderr.write('stub refused the message\\n');
process.exit(1);
`);

function recordedArgv() {
  if (!fs.existsSync(ARGV_LOG)) return [];
  return fs.readFileSync(ARGV_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Wait until the stub has been invoked `n` times, or give up. */
async function waitForArgv(n, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (recordedArgv().length >= n) return recordedArgv();
    await sleep(25);
  }
  return recordedArgv();
}

// --- fake side panel (extension socket) ------------------------------------

function fakeExtension() {
  const ws = new WebSocket(`ws://127.0.0.1:${EXT_PORT}/ext`, [SUBPROTOCOL, `token.${TOKEN}`]);
  const seen = { chat: [], chatStatus: [] };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', version: '0.1.0', capabilities: [], tabs: [] })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
    if (msg.type === 'chat') return seen.chat.push(msg);
    if (msg.type === 'chat-status') return seen.chatStatus.push(msg);
  });
  return { ws, seen, say: (frame) => ws.send(JSON.stringify(frame)) };
}

function postChat(body, { raw = false } = {}) {
  return fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });
}

// --- run -------------------------------------------------------------------

(async () => {
  process.env.ZYLOS_C4_RECEIVE = OK_STUB;
  const logLines = [];
  const realLog = console.log;
  console.log = (...a) => { logLines.push(a.join(' ')); realLog(...a); };

  const relay = await start({ token: TOKEN, extPort: EXT_PORT, agentPort: AGENT_PORT });
  const ext = fakeExtension();
  await new Promise((resolve) => ext.ws.once('open', resolve));
  await sleep(50);

  // == A. ingress: a chat frame spawns c4-receive with exactly the right argv ==

  // Every shell metacharacter that matters, plus a newline and non-ASCII. If
  // this text ever reaches a shell, it does not survive intact.
  const TEXT = `打开B站搜"蜘蛛侠"; rm -rf ~ && echo $(whoami) \`id\` 'quoted' | tee /tmp/x\nsecond line`;
  ext.say({ type: 'chat', sessionId: SESSION, text: TEXT, ts: Date.now() });

  const argv = await waitForArgv(1);
  ok('a chat frame spawns c4-receive', argv.length === 1, `invocations: ${argv.length}`);
  const expected = ['--channel', 'browser', '--endpoint', SESSION, '--priority', '2', '--content', TEXT];
  ok('c4-receive argv is exactly the spec contract',
     JSON.stringify(argv[0]) === JSON.stringify(expected),
     JSON.stringify(argv[0]));
  ok('the owner text is one argv element, byte-identical (no shell, no escaping)',
     argv[0] && argv[0][argv[0].length - 1] === TEXT,
     JSON.stringify(argv[0] && argv[0][argv[0].length - 1]));
  ok('the relay did not interpret or rewrite the text',
     argv[0] && !argv[0].some((a, i) => i !== argv[0].length - 1 && /rm -rf|whoami/.test(a)),
     JSON.stringify(argv[0]));

  // == B. oversized text is refused, not truncated ==
  const huge = 'x'.repeat(MAX_CHAT_TEXT + 1);
  ext.say({ type: 'chat', sessionId: SESSION, text: huge, ts: Date.now() });
  await sleep(400);
  const afterHuge = recordedArgv();
  ok('oversized text does not reach c4-receive at all', afterHuge.length === 1, `invocations: ${afterHuge.length}`);
  ok('oversized text is never truncated and forwarded',
     !afterHuge.some((a) => a[a.length - 1].startsWith('xxxx')),
     JSON.stringify(afterHuge.map((a) => a[a.length - 1].slice(0, 12))));
  ok('the refusal is told to the panel, not swallowed',
     ext.seen.chatStatus.some((m) => /too long/.test(m.error || '')),
     JSON.stringify(ext.seen.chatStatus));
  ok('the refusal is logged', logLines.some((l) => /chat REFUSED.*too long/.test(l)));

  // A text exactly at the cap is still accepted: the boundary is inclusive.
  ext.say({ type: 'chat', sessionId: SESSION, text: 'y'.repeat(MAX_CHAT_TEXT), ts: Date.now() });
  const atCap = await waitForArgv(2);
  ok('text exactly at the cap is accepted',
     atCap.length === 2 && atCap[1][atCap[1].length - 1].length === MAX_CHAT_TEXT,
     `invocations: ${atCap.length}`);

  // A chat frame with no sessionId has no C4 endpoint to reach -- refuse it
  // rather than queue a message the agent can never answer.
  ext.say({ type: 'chat', text: 'orphan', ts: Date.now() });
  await sleep(300);
  ok('a chat frame without a sessionId is refused', recordedArgv().length === 2, String(recordedArgv().length));

  // == C. a failing c4-receive is never silent ==
  process.env.ZYLOS_C4_RECEIVE = FAIL_STUB;
  ext.say({ type: 'chat', sessionId: SESSION, text: 'this delivery will fail', ts: Date.now() });
  await waitForArgv(3);
  await sleep(300);
  ok('a non-zero c4-receive exit is logged loudly',
     logLines.some((l) => /c4-receive exited 1/.test(l) && /NOT DELIVERED/.test(l)),
     logLines.filter((l) => /c4-receive/.test(l)).join(' | '));

  process.env.ZYLOS_C4_RECEIVE = path.join(tmp, 'does-not-exist.js');
  ext.say({ type: 'chat', sessionId: SESSION, text: 'missing binary', ts: Date.now() });
  await sleep(600);
  ok('a c4-receive that cannot run at all is logged loudly',
     logLines.some((l) => /NOT DELIVERED/.test(l) && /exited 1|failed to start|spawn threw/.test(l)));
  process.env.ZYLOS_C4_RECEIVE = OK_STUB;

  // == D. egress: POST /chat delivers to the connected panel ==
  const REPLY = '好，开了 — "已打开" & done';
  const res = await postChat({ text: REPLY, sessionId: SESSION });
  const body = await res.json();
  await sleep(100);
  ok('POST /chat returns 200', res.status === 200, String(res.status));
  ok('POST /chat body is {ok:true,delivered:true}',
     body.ok === true && body.delivered === true, JSON.stringify(body));
  const bubble = ext.seen.chat[ext.seen.chat.length - 1];
  ok('the panel receives a chat frame', Boolean(bubble), JSON.stringify(ext.seen.chat));
  ok('the frame is shaped {type,role:assistant,text,ts}',
     bubble && bubble.type === 'chat' && bubble.role === 'assistant'
       && bubble.text === REPLY && typeof bubble.ts === 'number',
     JSON.stringify(bubble));

  // sessionId is optional: one connected panel makes it unambiguous.
  const res2 = await postChat({ text: 'no session id' });
  ok('POST /chat works without a sessionId', res2.status === 200, String(res2.status));

  // == E. malformed / oversized bodies ==
  const bad = await postChat('{"text": "unterminated', { raw: true });
  const badBody = await bad.json();
  ok('malformed JSON is 400', bad.status === 400, String(bad.status));
  ok('malformed JSON says why', /JSON/i.test(badBody.error || ''), JSON.stringify(badBody));

  const noText = await postChat({ sessionId: SESSION });
  ok('a body without text is 400', noText.status === 400, String(noText.status));

  const longText = await postChat({ text: 'z'.repeat(MAX_CHAT_TEXT + 1) });
  ok('over-cap text on POST /chat is refused, not truncated', longText.status === 400, String(longText.status));

  const oversized = await postChat({ text: 'ok', pad: 'p'.repeat(80 * 1024) });
  ok('an oversized body is refused by the size cap', oversized.status === 413, String(oversized.status));
  ok('the oversized body never became a chat bubble',
     ext.seen.chat.every((m) => !/pppp/.test(m.text)), '');

  // == F. no extension connected -> 503 ==
  ext.ws.close();
  await sleep(200);
  const res503 = await postChat({ text: 'nobody home' });
  const body503 = await res503.json();
  ok('POST /chat is 503 with no extension connected', res503.status === 503, String(res503.status));
  ok('503 body is {ok:false,error:"extension not connected"}',
     body503.ok === false && body503.error === 'extension not connected', JSON.stringify(body503));

  // == G. /chat lives on the loopback lane only -- never on the public one ==
  const onPublic = await fetch(`http://127.0.0.1:${EXT_PORT}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'from the public lane' }),
  }).then((r) => r.status).catch(() => 'refused');
  ok('the public ext lane serves no /chat endpoint', onPublic === 426 || onPublic === 'refused', String(onPublic));

  // == H. session methods + /json/list honesty (SIDEPANEL-SPEC.md D) ==
  // These belong with the chat work -- the panel's whole flow is
  // chat -> openTarget -> setState -> endTask -- but tools/test-chokepoint.js is
  // owned elsewhere, so the assertions live here.
  ok('_br.openTarget is allowlisted',
     chokepoint.check({ method: '_br.openTarget', params: { url: 'https://www.bilibili.com/' } }) === null);
  ok('_br.setState working|waiting|stopped are allowlisted',
     ['working', 'waiting', 'stopped'].every(
       (s) => chokepoint.check({ method: '_br.setState', params: { state: s } }) === null));
  ok('_br.endTask is allowlisted', chokepoint.check({ method: '_br.endTask', params: {} }) === null);
  ok('_br.clearFinished is allowlisted', chokepoint.check({ method: '_br.clearFinished', params: {} }) === null);
  ok('_br.setState refuses a state outside the three',
     /working\|waiting\|stopped/.test(String(chokepoint.check({ method: '_br.setState', params: { state: 'green' } }))),
     String(chokepoint.check({ method: '_br.setState', params: { state: 'green' } })));
  ok('_br.openTarget still goes through the URL guard',
     /blocklisted/.test(String(chokepoint.check({ method: '_br.openTarget', params: { url: 'https://shop.test/checkout' } }))));
  ok('_br.openTarget without a url is refused',
     typeof chokepoint.check({ method: '_br.openTarget', params: {} }) === 'string');
  ok('opening a target is treated as mutating (retry must not open twice)',
     chokepoint.isMutating('_br.openTarget') === true);

  // /json/list must say "no tab yet" rather than advertise a phantom page, and
  // must still hand back a lease so the agent can call _br.openTarget at all.
  const ext2 = fakeExtension();           // hello carries tabs: []
  await new Promise((resolve) => ext2.ws.once('open', resolve));
  await sleep(80);
  const noTab = await (await fetch(`${BASE}/json/list`)).json();
  ok('/json/list still mints a session lease with zero tabs', noTab.length === 1, JSON.stringify(noTab));
  ok('the tabless session is labelled honestly, not as a phantom page',
     noTab[0] && noTab[0].zylosHasTab === false && /no tab yet/.test(noTab[0].title) && noTab[0].url === 'about:blank',
     JSON.stringify(noTab[0]));
  ok('the tabless session is still drivable (webSocketDebuggerUrl present)',
     /devtools\/page\//.test(noTab[0].webSocketDebuggerUrl || ''));

  ext2.ws.send(JSON.stringify({ type: 'state', tabs: [{ id: 77, url: 'https://www.bilibili.com/v/x', title: 'B站' }] }));
  await sleep(80);
  const withTab = await (await fetch(`${BASE}/json/list`)).json();
  ok('once a tab exists the real title/url are reported',
     withTab[0].zylosHasTab === true && withTab[0].url === 'https://www.bilibili.com/v/x' && withTab[0].title === 'B站',
     JSON.stringify(withTab[0]));
  ext2.ws.close();
  await sleep(50);

  relay.close();
  await sleep(50);
  console.log = realLog;
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(failures.length
    ? `\nchat-bridge: ${pass} passed, ${failures.length} FAILED`
    : `\nchat-bridge: ${pass} assertions passed`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error('chat-bridge: crashed', err);
  process.exit(1);
});
