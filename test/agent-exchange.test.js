'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AgentExchange } = require('../relay/agent-exchange');
const message = (id, round = 1, taskId = 'task') => ({keyId:'key',chatId:taskId,text:'owner request',request:{id,round,payload:{state:id}}});
function setup(t) {
  const ext = new EventEmitter();
  const exchange = new AgentExchange(ext);
  t.after(()=>exchange.close());
  exchange.ingest(message('r1'));
  return {ext,exchange};
}
test('exchange arms before acknowledgement, returns fresh state, and preserves a retry receipt',async t=>{
  const {ext,exchange}=setup(t);
  let calls=0;
  ext.request=async()=>{if(++calls===1) exchange.ingest(message('r2',2)); return {accepted:true};};
  const first=await exchange.respond('key','r1',{anything:true});
  assert.equal(first.next.id,'r2');
  const retry=await exchange.respond('key','r1',{anything:true});
  assert.equal(retry.replayed,true); assert.equal(retry.next.id,'r2');
  ext.request=async()=>{throw Object.assign(new Error('changed decision'),{code:'DECISION_CONFLICT'});};
  assert.equal((await exchange.respond('key','r1',{changed:true})).code,'DECISION_CONFLICT');
});
test('invalid decisions leave the request available for correction; completion waits for client end',async t=>{
  const {ext,exchange}=setup(t);
  ext.request=async()=>{throw Object.assign(new Error('schema'),{code:'BAD_DECISION'});};
  assert.equal((await exchange.respond('key','r1',{})).code,'BAD_DECISION');
  ext.request=async()=>{ext.emit('agent-turn-end',{keyId:'key',taskId:'task',status:'done'});};
  assert.deepEqual(await exchange.respond('key','r1',{final:true}),{ok:true,accepted:true,finished:true,status:'done'});
});
test('disconnect releases a blocked decision and no old receipt survives the connection',async t=>{
  const {ext,exchange}=setup(t);
  ext.request=async()=>({accepted:true});
  const pending=exchange.respond('key','r1',{});
  assert.equal((await exchange.respond('key','r1',{})).code,'DECISION_BUSY');
  ext.emit('disconnected','key');
  assert.equal((await pending).code,'EXT_OFFLINE');
  assert.equal((await exchange.respond('key','r1',{})).code,'STALE_DECISION');
});
test('a stopped task returns its terminal status and cannot leak the next task state',async t=>{
  const {ext,exchange}=setup(t);
  ext.request=async()=>({accepted:true});
  const pending=exchange.respond('key','r1',{});
  ext.emit('agent-turn-end',{keyId:'key',taskId:'task',status:'stopped'});
  assert.equal((await pending).status,'stopped');
  assert.equal(exchange.ingest(message('new',1,'new-task')),false);
});
