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

test('Base RPC read fallback runs on Cloudflare and never follows or exposes upstream redirects', async () => {
  const secret = 'BASE-RUNTIME-FAKE-SECRET';
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  fetchMock.get('https://base.publicnode.com').intercept({ path: '/rpc/' + secret, method: 'POST' })
    .reply(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2105' }),
      { headers: { 'x-upstream-secret': secret } });
  fetchMock.get('https://base.publicnode.com').intercept({ path: '/rpc/' + secret, method: 'POST' })
    .reply(302, secret, { headers: { location: 'https://base.publicnode.com/redirect/' + secret } });
  const mf = new Miniflare({ modules: true, modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    scriptPath: fileURLToPath(new URL('./entry.js', import.meta.url)),
    compatibilityDate: '2026-08-10', compatibilityFlags: ['nodejs_als'],
    bindings: { BASE_RPC: 'https://base.publicnode.com/rpc/' + secret }, fetchMock });
  const request = method => mf.dispatchFetch('https://zaexa.com/base/rpc', { method: 'POST',
    headers: { origin: 'https://zaexa.com', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 73, method, params: [] }) });
  try {
    const res = await request('eth_chainId');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://zaexa.com');
    assert.equal(res.headers.get('x-upstream-secret'), null);
    assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 73, result: '0x2105' });
    const redirect = await request('eth_chainId');
    assert.equal(redirect.status, 502);
    assert.equal(redirect.headers.get('location'), null);
    assert.ok(!(await redirect.text()).includes(secret));
    assert.equal((await request('eth_sendRawTransaction')).status, 400);
    assert.equal((await request('eth_getLogs')).status, 400);
  } finally { await mf.dispose(); }
});
