import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { scheduledReportPass, rlHits } from './index.js';
import { fetch as scopedFetch, cacheStore, reportContext } from './request-context.js';
const req=(path,options={})=>new Request('https://zaexa.test'+path,options);
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});

test('anonymous and incorrect-key diagnostics perform no upstream work',async()=>{
  const previous=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return json({});};
  try{
    for(const path of ['/vd/src','/vd/rpc','/vd/logrpc','/vd/v4/0x'+'1'.repeat(40),'/vd/0x'+'1'.repeat(40)+'?probe=1']){
      for(const headers of [{},{'x-run-key':'wrong'}]){
        const r=await worker.fetch(req(path,{headers}),{RUN_KEY:'operator-secret'},{});
        assert.equal(r.status,404);
      }
    }
    assert.equal(calls,0);
    const allowed=await worker.fetch(req('/vd/src',{headers:{'x-run-key':'operator-secret'}}),{RUN_KEY:'operator-secret'},{});
    assert.equal(allowed.status,200);
    // /vd/passes عمداً عمومی می‌ماند: فقط KV را می‌خواند، هیچ تماسِ بیرونی نمی‌زند و فقط عدد و نامِ میزبان دارد
    const before=calls;
    const passes=await worker.fetch(req('/vd/passes'),{},{});
    assert.equal(passes.status,200);
    assert.equal(calls,before);
    const publicVerdict=await worker.fetch(req('/vd/0x'+'2'.repeat(40)),{},{});
    assert.equal(publicVerdict.status,200);
  }finally{globalThis.fetch=previous;rlHits.clear();}
});

test('byte limit cancels chunked bodies before reading the whole stream',async()=>{
  for(const path of ['/ev','/sol/swap','/sol/rpc']){
    let pulled=0,cancelled=false;
    const body=new ReadableStream({pull(controller){pulled++;controller.enqueue(new Uint8Array(1024));if(pulled===1000)controller.close();},cancel(){cancelled=true;}});
    const r=await worker.fetch(req(path,{method:'POST',duplex:'half',body,headers:{'content-type':'application/json'}}),{},{});
    assert.equal(r.status,413,path);assert.ok(pulled<70,path);assert.equal(cancelled,true,path);
  }
});

test('body size measures UTF-8 bytes rather than JavaScript characters',async()=>{
  const r=await worker.fetch(req('/ev',{method:'POST',body:JSON.stringify({e:'view',d:'ی'.repeat(125)})}),{},{});
  assert.equal(r.status,413);
});
test('a stalled body is cancelled at the read deadline',async()=>{
  let cancelled=false;
  const body=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}});
  const r=await worker.fetch(req('/ev',{method:'POST',duplex:'half',body}),{},{});
  assert.equal(r.status,400);assert.equal(cancelled,true);
});

test('parallel report passes leave public fetch/cache intact and keep independent budgets',async()=>{
  const originalFetch=globalThis.fetch,originalCaches=globalThis.caches;
  let started=0,release;const gate=new Promise(r=>{release=r;});
  let startedResolve;const bothStarted=new Promise(r=>{startedResolve=r;});
  const cache={match:async()=>json({cached:true}),put:async()=>{}};
  globalThis.caches={default:cache};
  const rawFetch=async url=>{
    if(String(url).includes('/networks/base/new_pools')){if(++started===2)startedResolve();await gate;}
    return json({data:[]});
  };
  globalThis.fetch=rawFetch;
  const kv=()=>{const data=new Map();return {get:async k=>data.get(k)||null,put:async(k,v)=>{data.set(k,v);}};};
  try{
    const first=scheduledReportPass({ZX_KV:kv()},{},{}),second=scheduledReportPass({ZX_KV:kv()},{},{});
    await bothStarted;
    assert.equal(globalThis.fetch,rawFetch);assert.equal(globalThis.caches.default.match,cache.match);
    assert.equal(reportContext.getStore(),undefined);
    assert.equal((await (await cacheStore().match(req('/public'))).json()).cached,true);
    await scopedFetch('https://public.invalid/unrelated');
    release();const [a,b]=await Promise.all([first,second]);
    assert.deepEqual(a.sub.byHost,b.sub.byHost);
    assert.equal(a.sub.byHost['public.invalid'],undefined);assert.equal(b.sub.byHost['public.invalid'],undefined);
    assert.equal(globalThis.fetch,rawFetch);assert.equal(globalThis.caches.default,cache);
  }finally{release();globalThis.fetch=originalFetch;globalThis.caches=originalCaches;}
});
