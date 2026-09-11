const WebSocket = require('ws');
const http = require('http');
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let b=''; r.on('data',d=>b+=d); r.on('end',()=>{try{res(JSON.parse(b))}catch(e){rej(e)}}); }).on('error', rej));
(async () => {
  const list = await getJson('http://127.0.0.1:3803/json/list');
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } else console.log('EVENT', JSON.stringify(m).slice(0,200)); });
  await new Promise(r => ws.on("open", r)); await new Promise(r => setTimeout(r, 4000));
  const call = (method, params={}, ms=20000) => new Promise((res) => {
    const i = ++id; const t = setTimeout(() => { pending.delete(i); res({TIMEOUT: method}); }, ms);
    pending.set(i, (m) => { clearTimeout(t); res(m); });
    ws.send(JSON.stringify({id: i, method, params}));
  });
  for (const m of ['_br.info', '_br.listTabs']) {
    console.log(m, '->', JSON.stringify(await call(m)).slice(0, 600));
  }
  console.log('_br.snapshot ->', JSON.stringify(await call('_br.snapshot', {maxElements: 5, maxChars: 200}, 25000)).slice(0, 700));
  process.exit(0);
})();
