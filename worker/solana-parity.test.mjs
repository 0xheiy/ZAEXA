import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{solPoolsEmpty,buildSitemapTokens} from './index.js';
import {pickFollowUpTargets,pickRecheckTargets,publishGuardRow} from './report.js';
const MINT='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE='0x1111111111111111111111111111111111111111';
const pool=(chain,address,reserve)=>({attributes:{reserve_in_usd:reserve},relationships:{base_token:{data:{id:chain+'_'+address}}}});
async function mocked(fn,run){const old=globalThis.fetch;globalThis.fetch=fn;try{await run();}finally{globalThis.fetch=old;}}
test('Solana pool evidence is unknown for missing, malformed or unrelated pools',async()=>{
 for(const data of [[],[pool('solana',MINT,null)],[pool('solana',MINT,'bad')],[pool('base',BASE,'0')]]){
  await mocked(async()=>Response.json({data}),async()=>assert.equal(await solPoolsEmpty(MINT,{}),null));
 }
 await mocked(async()=>new Response('',{status:503}),async()=>assert.equal(await solPoolsEmpty(MINT,{}),null));
});
test('zero liquidity evidence requires all returned matching pools to be explicitly zero',async()=>{
 await mocked(async()=>Response.json({data:[pool('solana',MINT,'0')]}),async()=>assert.equal(await solPoolsEmpty(MINT,{}),true));
 await mocked(async()=>Response.json({data:[pool('solana',MINT,'0'),pool('solana',MINT,'1')]}),async()=>assert.equal(await solPoolsEmpty(MINT,{}),false));
});
test('sitemap contains both networks and survives one network outage',async()=>{
 await mocked(async url=>Response.json({data:[pool(String(url).includes('/solana/')?'solana':'base',String(url).includes('/solana/')?MINT:BASE,'10')]}),async()=>assert.deepEqual(await buildSitemapTokens({}),[BASE,MINT]));
 await mocked(async url=>String(url).includes('/base/')?new Response('',{status:503}):Response.json({data:[pool('solana',MINT,'10')]}),async()=>assert.deepEqual(await buildSitemapTokens({}),[MINT]));
});
test('hourly Solana targets retain age/cap boundaries and negative-publication policy',()=>{
 const now=Date.parse('2026-10-01T12:00:00Z');
 const row={chain:'solana',address:MINT,checkedAt:new Date(now-60*60000).toISOString(),v:'sell'};
 assert.deepEqual(pickFollowUpTargets({rows:[row]},now,1),[MINT]);
 assert.deepEqual(pickFollowUpTargets({rows:[{...row,checkedAt:new Date(now-54*60000).toISOString()}]},now),[]);
 assert.equal(pickRecheckTargets({rows:[{...row,v:null}]},now,1)[0].address,MINT);
 assert.equal(publishGuardRow({...row,v:'nosell',cause:'empty-pool'}).v,null);
});
test('analytics records only a closed network dimension, never arbitrary network strings',async()=>{
 const points=[];const env={ZX_EV:{writeDataPoint:p=>points.push(p)}};
 const req=c=>new Request('https://zaexa.test/ev',{method:'POST',body:JSON.stringify({e:'swap:sent',d:'',v:'mobile',c})});
 assert.equal((await worker.fetch(req('solana'),env,{})).status,204);
 assert.deepEqual(points[0].blobs,['swap:sent','','mobile','??','solana']);
 assert.equal((await worker.fetch(req('private-data'),env,{})).status,400);assert.equal(points.length,1);
});
test('direct comparison reaches Jupiter while unsupported switches are rejected',async()=>{
 let target='';await mocked(async url=>{target=String(url);return Response.json({outAmount:'1'});},async()=>{
  const path='https://zaexa.test/sol/quote?inputMint=So11111111111111111111111111111111111111112&outputMint='+MINT+'&amount=100&onlyDirectRoutes=';
  assert.equal((await worker.fetch(new Request(path+'true'),{},{})).status,200);assert.equal(new URL(target).searchParams.get('onlyDirectRoutes'),'true');
  assert.equal((await worker.fetch(new Request(path+'unsafe'),{},{})).status,400);
 });
});
test('safety RPC methods accept only bounded parameter shapes',async()=>{
 await mocked(async()=>Response.json({result:{value:[]}}),async()=>{
  for(const [method,params] of [['getAccountInfo',[MINT,{encoding:'jsonParsed'}]],['getTokenLargestAccounts',[MINT]],['getEpochInfo',[]]]){
   const req=p=>new Request('https://zaexa.test/sol/rpc',{method:'POST',body:JSON.stringify({method,params:p})});
   assert.equal((await worker.fetch(req(params),{},{})).status,200);
   assert.equal((await worker.fetch(req([...params,'extra']),{},{})).status,400);
  }
 });
});
