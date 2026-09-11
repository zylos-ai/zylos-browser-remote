// Measure whether the platform edge cuts a WebSocket the way it cuts streamed HTTP.
// Speaks just enough of the protocol (hello + pong) to not be killed by the
// relay's own 17s app-level heartbeat, which confounded the first attempt.
const WebSocket = require('ws');
const fs = require('fs');
const token = fs.readFileSync(__dirname + '/relay/token','utf8').trim();
const [url, SUB] = [process.argv[2], process.argv[3]];
const t0 = Date.now();
const el = () => ((Date.now()-t0)/1000).toFixed(1)+'s';
const ws = new WebSocket(url, [SUB, `token.${token}`]);
ws.on('open', () => {
  console.log(`[${el()}] OPEN  handshake ok, subprotocol=${ws.protocol}`);
  ws.send(JSON.stringify({type:'hello', version:'0.0.0-probe', tabs:[]}));
});
ws.on('message', (m) => {
  let msg = {}; try { msg = JSON.parse(m); } catch {}
  if (msg.type === 'ping') { ws.send(JSON.stringify({type:'pong', ts: msg.ts})); console.log(`[${el()}] ping->pong`); }
  else console.log(`[${el()}] MSG   ${m.toString().slice(0,80)}`);
});
ws.on('close', (c,r) => { console.log(`[${el()}] CLOSE code=${c} reason=${r.toString().slice(0,60)}`); process.exit(0); });
ws.on('error', (e) => console.log(`[${el()}] ERROR ${e.message}`));
setTimeout(() => { console.log(`[${el()}] STILL OPEN — survived the full window, no edge cut`); ws.close(); }, Number(process.argv[4]||95000));
