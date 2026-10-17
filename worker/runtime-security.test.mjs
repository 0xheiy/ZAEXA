import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, createFetchMock } from 'miniflare';

test('Worker runs with AsyncLocalStorage on the Cloudflare runtime',async()=>{
  const fetchMock=createFetchMock();fetchMock.disableNetConnect();
  fetchMock.get(/.*/).intercept({path:/.*/,method:'GET'}).reply(200,JSON.stringify({data:[]})).persist();
  fetchMock.get(/.*/).intercept({path:/.*/,method:'HEAD'}).reply(200,'').persist();
  const mf=new Miniflare({modules:true,modulesRules:[{type:'ESModule',include:['**/*.js']}],scriptPath:fileURLToPath(new URL('./entry.js',import.meta.url)),
    compatibilityDate:'2026-08-10',compatibilityFlags:['nodejs_als'],
    kvNamespaces:['ZX_KV'],bindings:{RUN_KEY:'local-test-secret'},fetchMock});
  try{
    assert.equal((await mf.dispatchFetch('https://zaexa.test/vd/src')).status,404);
    const r=await mf.dispatchFetch('https://zaexa.test/vd/passes');
    assert.equal(r.status,200);assert.deepEqual(await r.json(),{passes:[]});
    const huge=await mf.dispatchFetch('https://zaexa.test/ev',{method:'POST',body:'x'.repeat(257)});
    assert.equal(huge.status,413);
    const pass=await mf.dispatchFetch('https://zaexa.test/report/run',{headers:{'x-run-key':'local-test-secret'}});
    const result=await pass.json();assert.equal(pass.status,200);assert.equal(result.ran,true);
    assert.ok(result.sub.total>=3);assert.equal(result.sub.cache,0);
  }finally{await mf.dispose();}
});
