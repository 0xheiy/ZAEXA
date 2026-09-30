import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const SOL='So11111111111111111111111111111111111111112';
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const account={address:'11111111111111111111111111111111'};
function ctx(names,extra={}){
  const elements={};
  const c=vm.createContext({console,URLSearchParams,Date,Map,Set,BigInt,
    SOL_MINT_ADDR:SOL,SOL_MINT_RE:/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    SOL_TOKEN_PROGRAMS:['legacy','2022'],SERIES:['red','blue'],GT:'https://example.test/gt',
    folioSeq:0,flowSeq:0,flowWindow:'h1',activeChain:'solana',solAccount:account,solMintCur:USDC,
    $:id=>elements[id]??={innerHTML:'',textContent:''},paintFlowToken(){},
    esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    shortAddr:s=>s.slice(0,5),...extra});
  for(const name of names){
    const m=new RegExp(`(?:async )?function ${name}\\(`).exec(source);assert.ok(m,name);
    vm.runInContext(source.slice(m.index,source.indexOf('\n}',m.index)+2),c);
  }return c;
}
function token(pubkey,mint,amount,decimals=6){return {pubkey,account:{data:{parsed:{info:{mint,tokenAmount:{amount,decimals}}}}}};}
const ok=value=>({status:'fulfilled',value});
test('holdings sum raw integers without losing precision',()=>{
  const c=ctx(['solCollectHoldings','solFormatUnits']);
  const r=c.solCollectHoldings([ok({value:1000000000}),ok({value:[token('a',USDC,'9007199254740993'),token('b',USDC,'1')]}),ok({value:[]})]);
  assert.equal(r.rows[1].raw,9007199254740994n);assert.equal(r.incomplete,false);
  assert.equal(c.solFormatUnits(r.rows[1].raw,6),'9007199254.740994');
});
test('native and wrapped SOL remain separate',()=>{
  const c=ctx(['solCollectHoldings']);
  const r=c.solCollectHoldings([ok({value:100}),ok({value:[token('a',SOL,'200',9)]}),ok({value:[]})]);
  assert.equal(r.rows.length,2);assert.equal(r.rows[0].native,true);assert.equal(r.rows[1].native,false);
});
test('failed program response is partial, not a complete empty wallet',()=>{
  const c=ctx(['solCollectHoldings']);
  const r=c.solCollectHoldings([ok({value:0}),{status:'rejected'},ok({value:[]})]);
  assert.equal(r.incomplete,true);assert.equal(r.rows.length,0);
});
test('duplicate accounts count once and inconsistent decimals mark partial data',()=>{
  const c=ctx(['solCollectHoldings']);const a=token('a',USDC,'100');
  const r=c.solCollectHoldings([ok({value:0}),ok({value:[a,a,token('b',USDC,'200',9)]}),ok({value:[]})]);
  assert.equal(r.rows[0].raw,100n);assert.equal(r.incomplete,true);
});
test('unknown prices remain visible and do not become a zero total',async()=>{
  const c=ctx(['renderSolFolio','solCollectHoldings','solFormatUnits'],{
    solRpcCall:async method=>method==='getBalance'?{value:1000000000}:{value:[]},fetchSolMetaMulti:async()=>({}),
  });await c.renderSolFolio();
  assert.equal(c.$('folioTotal').textContent,'Value unavailable');assert.match(c.$('folioBody').innerHTML,/no price/);
});
test('old portfolio cannot overwrite a newly selected network',async()=>{
  let finish;const pending=new Promise(r=>finish=r);
  const c=ctx(['renderSolFolio','solCollectHoldings','solFormatUnits'],{solRpcCall:()=>pending,fetchSolMetaMulti:async()=>({})});
  const work=c.renderSolFolio();c.activeChain='base';c.$('folioBody').innerHTML='Base portfolio';
  finish({value:[]});await work;assert.equal(c.$('folioBody').innerHTML,'Base portfolio');
});
function trade(id,from,to,time,value='5'){
  return {id,attributes:{from_token_address:from,to_token_address:to,block_timestamp:new Date(time).toISOString(),volume_in_usd:value}};
}
test('flow uses token direction, excludes unrelated and old trades, and deduplicates',()=>{
  const c=ctx(['solFlowTrades']);const now=Date.now();const buy=trade('a',SOL,USDC,now);
  const r=c.solFlowTrades([buy,buy,trade('b',USDC,SOL,now),trade('c',SOL,'other',now),trade('d',SOL,USDC,now-7200000)],USDC,now-3600000,now);
  assert.equal(r.length,2);assert.equal(r[0].isBuy,true);assert.equal(r[1].isBuy,false);
});
test('missing dollar value does not become priced zero',()=>{
  const c=ctx(['solFlowTrades']);const now=Date.now();
  assert.equal(c.solFlowTrades([trade('a',SOL,USDC,now,null)],USDC,now-1,now)[0].usd,null);
});
test('flow renders sample coverage and safe pool labels',async()=>{
  const now=Date.now();
  const c=ctx(['renderSolFlow','solFlowTrades'],{gtJson:async url=>url.endsWith('/trades')?
    {data:[trade('a',SOL,USDC,now,'8'),trade('b',USDC,SOL,now,'3')]}:
    {data:[{attributes:{address:SOL,name:'<img src=x>',reserve_in_usd:'100'},relationships:{base_token:{data:{id:'solana_'+USDC}}}}]},
  });await c.renderSolFlow();const html=c.$('flowBody').innerHTML;
  assert.match(html,/Recent-trade sample/);assert.match(html,/1 buys · 1 sells/);
  assert.match(html,/\$8/);assert.match(html,/\$3/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
});
test('history outage stays unknown instead of zero activity',async()=>{
  const c=ctx(['renderSolFlow','solFlowTrades'],{gtJson:async()=>{throw Error('offline');}});
  await c.renderSolFlow();assert.match(c.$('flowBody').innerHTML,/unknown, not zero/);
});

test('periodic refresh does not supersede a slow portfolio response',()=>{
  let calls=0;
  const c=ctx(['refreshSolanaViews'],{view:'folio',solViewJobs:{folio:Promise.resolve(),flow:null},renderFolio(){calls++;}});
  c.refreshSolanaViews();assert.equal(calls,0);
  c.solViewJobs.folio=null;c.refreshSolanaViews();assert.equal(calls,1);
});
test('finishing a superseded view request does not unlock the newer request',async()=>{
  let finish;const old=new Promise(r=>finish=r);const current=Promise.resolve();
  const c=ctx(['solRunView'],{solViewJobs:{folio:null}});
  const pending=c.solRunView('folio',()=>old);c.solViewJobs.folio=current;
  finish();await pending;assert.equal(c.solViewJobs.folio,current);
});
