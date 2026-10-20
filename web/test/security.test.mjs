import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function load(names,values){
  const context=vm.createContext({console,JSON,Date,Number,BigInt,Promise,Uint8Array,...values});
  for(const name of names){
    const start=html.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start>=0,name);vm.runInContext(html.slice(start,html.indexOf('\n}',start)+2),context);
  }
  return context;
}
for(const changed of [false,true])test(changed?'Base amount change during simulation cannot reach wallet submission':'unchanged Base swap reaches wallet submission',async()=>{
  let release,started;const gate=new Promise(r=>{release=r;}),began=new Promise(r=>{started=r;});
  const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,{value:id==='amtIn'?'100':'',textContent:'',style:{}});return elements.get(id);};
  const plan={totalIn:100n,totalOut:1000n,parts:[{route:{hops:[{venue:{dex:{}},tokenIn:{symbol:'IN'},tokenOut:{symbol:'OUT'}}]},amountIn:100n}]};
  let sends=0,error;
  const executeSwap=async()=>{sends++;return {hash:'test',wait:async()=>({status:0})};};
  executeSwap.staticCall=async()=>{started();await gate;return 1000n;};executeSwap.estimateGas=async()=>100000n;
  const c=load(['baseSwapContext','baseAssertSwapContext','doSwap'],{
    currentPlan:plan,quoteSeq:0,busy:false,mode:'exactIn',activeChain:'base',slippageBps:50,deadlineMin:3,
    tokenIn:{address:'input',symbol:'IN',decimals:0},tokenOut:{address:'output',symbol:'OUT',decimals:0},
    account:'wallet',signer:{},walletEip1193:{},CHAIN:{executor:'executor',explorer:'https://invalid.test'},ABI:{executor:[]},E:{Contract:function(){return {executeSwap};}},
    walletIsRemote:false,feeBps:0,baseSimArmedKey:null,baseSimFailedKey:null,
    parsedAmountIn:()=>BigInt(el('amtIn').value),$:el,ev(){},setBusy(){},runQuote:async()=>{},preflight:async()=>[],
    buildParts:()=>[],minOutOf:()=>995n,baseSimKey:()=> 'quote',venueLabel:()=> 'venue',isNative:()=>false,asArg:t=>t.address,
    balances:{},balKey:t=>t.address,fmt:String,esc:String,note:(_kind,h)=>h,setNotice(){},sendOrLoseTrack:async p=>p,
    withTimeout:async p=>p,shortAddr:String,isUserRejection:()=>false,showError:(_title,e)=>{error=e;},refreshButton(){},
  });
  const pending=c.doSwap();await began;if(changed){el('amtIn').value='1';c.currentPlan=null;c.quoteSeq++;}
  release();await pending;assert.equal(sends,changed?0:1);if(changed)assert.match(error.message,/changed/i);else assert.equal(error,undefined);
});
test('changed output, threshold, route or impact invalidates risk acknowledgement',()=>{
  const q={inputMint:'a',outputMint:'b',inAmount:'100',outAmount:'1000',otherAmountThreshold:'990',swapMode:'ExactIn',priceImpactPct:'0.15',routePlan:[{venue:'a'}]};
  const c=load(['solImpactKey','solNeedsImpactArm'],{solQuote:q,SOL_IMPACT_ARM_PCT:15,solQuoteImpactPct:q=>Number(q.priceImpactPct)*100});
  c.solImpactArmedKey=c.solImpactKey(q);assert.equal(c.solNeedsImpactArm(),false);
  for(const change of [{outAmount:'100'},{otherAmountThreshold:'1'},{priceImpactPct:'0.9'},{routePlan:[{venue:'b'}]}]){
    c.solQuote={...q,...change};assert.equal(c.solNeedsImpactArm(),true);
  }
});
for(const signOnly of [false,true])test(signOnly?'signTransaction-only wallet signs, message is compared, and verified bytes are broadcast':'ambiguous sign-and-send failure never builds or signs a replacement (even if signTransaction exists)',async()=>{
  const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,{value:'1',textContent:'',disabled:false});return elements.get(id);};
  let builds=0,signs=0,sends=0,finishes=0,compared=0;const notices=[];
  const c=load(['solDoSwap'],{
    solSwapBusy:false,solAccount:{address:'wallet'},solQuote:{},solNeedsArm:()=>false,solNeedsImpactArm:()=>false,solNeedsSimArm:()=>false,
    solBudgetCheck:()=>({ok:true}),solRequiredInput:()=>1,solSpendableTop:()=>10,solSwapContext:()=> 'ctx',solAssertSwapContext(){},
    solSide:'buy',solRefSymbol:'SOL',solTokenSymbol:'USDC',solIntentSeq:0,solInputMint:()=> 'USDC',SOL_MINT_ADDR:'SOL',$:el,ev(){},
    solBuildFreshTx:async()=>{builds++;return {txBytes:new Uint8Array([1]),lastValid:100};},
    window:{SolIntent:{assertSameMessage(){compared++;}}},solSendSignedWithRetry:async()=>{sends++;return 'sig';},
    solWatchWallet:p=>p,solLateWalletResult(){},solFinishSubmitted:()=>{finishes++;},solBs58Encode:()=> 'sig',
    solWalletApi:{features:signOnly?{'solana:signTransaction':{signTransaction:async({transaction})=>{signs++;return [{signedTransaction:transaction}];}}}:
      {'solana:signAndSendTransaction':{signAndSendTransaction:async()=>{throw new Error('connection lost after broadcast');}},
       'solana:signTransaction':{signTransaction:async({transaction})=>{signs++;return [{signedTransaction:transaction}];}}}},
    isUserRejection:()=>false,solSetNotice:n=>notices.push(n),note:(_kind,h)=>h,esc:String,solUpdateSwapBtn(){},solRefreshBalances(){},
  });
  await c.solDoSwap();assert.equal(builds,1);assert.equal(signs,signOnly?1:0);assert.equal(sends,signOnly?1:0);assert.equal(compared,signOnly?1:0);
  assert.equal(finishes,signOnly?1:0);if(!signOnly)assert.ok(notices.some(n=>n.includes('may have sent')));
});
test('wallet with signAndSend succeeds without any signed-message comparison (Phantom adds Lighthouse)',async()=>{
  const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,{value:'1',textContent:'',disabled:false});return elements.get(id);};
  let signs=0,compared=0,finishes=0;
  const c=load(['solDoSwap'],{
    solSwapBusy:false,solAccount:{address:'wallet'},solQuote:{},solNeedsArm:()=>false,solNeedsImpactArm:()=>false,solNeedsSimArm:()=>false,
    solBudgetCheck:()=>({ok:true}),solRequiredInput:()=>1,solSpendableTop:()=>10,solSwapContext:()=> 'ctx',solAssertSwapContext(){},
    solSide:'buy',solRefSymbol:'SOL',solTokenSymbol:'USDC',solIntentSeq:0,solInputMint:()=> 'USDC',SOL_MINT_ADDR:'SOL',$:el,ev(){},
    solBuildFreshTx:async()=>({txBytes:new Uint8Array([1]),lastValid:100}),window:{SolIntent:{assertSameMessage(){compared++;}}},
    solWatchWallet:p=>p,solLateWalletResult(){},solFinishSubmitted:()=>{finishes++;},solBs58Encode:()=> 'sig',
    solWalletApi:{features:{'solana:signAndSendTransaction':{signAndSendTransaction:async()=>[{signature:new Uint8Array([9])}]},
      'solana:signTransaction':{signTransaction:async()=>{signs++;return [];}}}},
    isUserRejection:()=>false,solSetNotice(){},note:(_k,h)=>h,esc:String,solUpdateSwapBtn(){},solRefreshBalances(){},
  });
  await c.solDoSwap();assert.equal(signs,0);assert.equal(compared,0);assert.equal(finishes,1);
});
test('RPC saving queries the endpoint chain ID and rejects wrong/offline nodes',async()=>{
  for(const reply of ['0x1',new Error('offline'),'0x2105']){
    let requests=0,saved=0;
    const c=load(['saveCustomRpc'],{CHAIN:{id:8453},RPC_KEY:'rpc',rpcState(){},maskRpc:String,isTransportError:()=>true,
      makeProvider:()=>({send:async(method,params)=>{assert.equal(method,'eth_chainId');assert.deepEqual(Array.from(params),[]);requests++;if(reply instanceof Error)throw reply;return reply;},destroy(){}}),
      withTimeout:p=>p,useRpc:()=>{saved++;},localStorage:{setItem(){}},
    });
    await c.saveCustomRpc('https://example.invalid/rpc');assert.equal(requests,1);assert.equal(saved,reply==='0x2105'?1:0);
  }
});
test('beacon proxy and renounced owner cannot become immutable or privilege-free claims',async()=>{
  const zero='0x'+'0'.repeat(40),beacon='0x'+'1'.repeat(64);
  const c=load(['riskScore','verdictOf','scanToken'],{
    E:{getAddress:x=>x},ZERO:zero,DEAD:'0x'+'d'.repeat(40),SLOT_IMPL:'impl',SLOT_BEACON:'beacon',DANGEROUS:[],
    getCode:async()=> '0x1234',multicall:async()=>[{ok:true,data:'owner'}],iOwn:{encodeFunctionData:()=> 'owner',decodeFunctionResult:()=>[zero]},
    getStorage:async(_address,slot)=>slot==='beacon'?beacon:'0x'+'0'.repeat(64),
    measureLiquidity:async()=>1000000,checkTradability:async()=>({buy:true,sell:true,roundTrip:0.2,unknown:false}),tripCost:()=>({state:'normal'}),fmtUsd:String,shortAddr:String,
  });
  const r=await c.scanToken({address:'token',symbol:'TOKEN'});assert.equal(r.isProxy,true);
  assert.ok(r.findings.some(f=>f.title==='Upgradeable (beacon proxy)'&&f.level==='high'));
  assert.ok(!r.findings.some(f=>/code is fixed|No one holds privileged/i.test(f.detail)));
  const score=c.riskScore({owner:zero,findings:[{level:'critical',title:'Mint'}],canSell:null,liqUsd:null,isProxy:false});
  assert.equal(score,25);
});
