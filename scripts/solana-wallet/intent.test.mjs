import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, Keypair, TransactionMessage, VersionedTransaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram, AddressLookupTableAccount } from '@solana/web3.js';
import { validateTransaction, validateQuote, assertSameMessage, inspectTransaction, checkSimulatedBalances, balanceAddresses, NATIVE_FEE_ALLOWANCE } from './intent.js';
import schema from './jupiter-schema.json' with { type:'json' };
import * as real from './real-swap.mjs';
import { MessageV0 } from '@solana/web3.js';

const wallet=Keypair.generate(),other=Keypair.generate().publicKey;
const JUP=new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const TOKEN=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',SOL='So11111111111111111111111111111111111111112';
const associated=mint=>PublicKey.findProgramAddressSync([wallet.publicKey.toBytes(),TOKEN.toBytes(),new PublicKey(mint).toBytes()],ATA)[0];
const quote={inputMint:USDC,outputMint:SOL,inAmount:'1000000',outAmount:'6000000',otherAmountThreshold:'5970000',swapMode:'ExactIn',slippageBps:50,routePlan:[{}],priceImpactPct:'0.01'};
const intent={inputMint:USDC,outputMint:SOL,amount:1000000n,exactOut:false,slippageBps:50};
const rpc=async()=>({value:{owner:TOKEN.toBase58(),data:{parsed:{type:'mint'}}}});
function route(changes={}){
  const def=schema.instructions.find(i=>i.name==='route');
  const data=Buffer.alloc(8+4+4+8+8+2+1);
  data.set(def.discriminator);data.writeUInt32LE(1,8);
  data[12]=schema.types.find(t=>t.name==='Swap').type.variants.findIndex(x=>x.name==='TokenSwap');
  data[13]=100;data[14]=0;data[15]=1;data.writeBigUInt64LE(changes.amount??1000000n,16);data.writeBigUInt64LE(6000000n,24);data.writeUInt16LE(50,32);
  const accounts=[TOKEN,wallet.publicKey,associated(changes.input??USDC),changes.destination??associated(changes.output??SOL),changes.override??JUP,new PublicKey(changes.output??SOL),JUP,other,JUP];
  return new TransactionInstruction({programId:JUP,data,keys:accounts.map((pubkey,i)=>({pubkey,isSigner:i===1,isWritable:[2,3,4,6].includes(i)}))});
}
function transaction(instructions,version='v0',tables=[]){
  const msg=new TransactionMessage({payerKey:wallet.publicKey,recentBlockhash:other.toBase58(),instructions});
  return new VersionedTransaction(version==='legacy'?msg.compileToLegacyMessage():msg.compileToV0Message(tables)).serialize();
}
for(const version of ['legacy','v0']){
  test(`${version}: genuine supported swap passes and direct transfer is refused`,async()=>{
    await validateTransaction(transaction([route()],version),quote,wallet.publicKey.toBase58(),rpc);
    const transfer=SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:other,lamports:1000000000});
    await assert.rejects(validateTransaction(transaction([transfer],version),quote,wallet.publicKey.toBase58(),rpc),/Refused/);
  });
}
test('quote response is bound to mints, amount, mode, slippage and threshold',()=>{
  assert.equal(validateQuote(quote,intent),quote);
  for(const change of [{inputMint:SOL},{outAmount:'0'},{inAmount:'1000000000'},{swapMode:'ExactOut'},{slippageBps:5000},{otherAmountThreshold:'1'},{otherAmountThreshold:'6000000'},{priceImpactPct:'NaN'},{platformFee:{feeBps:10}}]){
    assert.throws(()=>validateQuote({...quote,...change},intent),/Refused/);
  }
});
test('no destination override, arbitrary transfer, extra swap, delegation or unbounded fee',async()=>{
  const transfer=SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:other,lamports:1});
  const approve=new TransactionInstruction({programId:TOKEN,keys:[],data:Buffer.from([4])});
  for(const instructions of [[route({destination:other})],[route({override:other})],[route({amount:2n})],[route(),transfer],[route(),route()],[route(),approve],
    [route(),ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000000})]]){
    await assert.rejects(validateTransaction(transaction(instructions),quote,wallet.publicKey.toBase58(),rpc),/Refused/);
  }
});
test('lookup table addresses are resolved from RPC, never from the swap response',async()=>{
  const table=new AddressLookupTableAccount({key:Keypair.generate().publicKey,state:{deactivationSlot:2n**64n-1n,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,authority:undefined,addresses:[associated(USDC),associated(SOL)]}});
  const raw=Buffer.alloc(56+64);raw.writeUInt32LE(1);raw.writeBigUInt64LE(2n**64n-1n,4);raw.set(associated(USDC).toBytes(),56);raw.set(associated(SOL).toBytes(),88);
  const lookupRpc=async(method,params)=>params[0]===table.key.toBase58()?{value:{owner:'AddressLookupTab1e1111111111111111111111111',data:[raw.toString('base64'),'base64']}}:rpc();
  await validateTransaction(transaction([route()],'v0',[table]),quote,wallet.publicKey.toBase58(),lookupRpc);
  await assert.rejects(validateTransaction(transaction([route()],'v0',[table]),quote,wallet.publicKey.toBase58(),rpc));
});
test('wallet may add a signature but may not change the message',()=>{
  const original=transaction([route()]),signed=VersionedTransaction.deserialize(original);signed.sign([wallet]);
  assert.doesNotThrow(()=>assertSameMessage(original,signed.serialize()));
  assert.throws(()=>assertSameMessage(original,transaction([route({amount:2n})])),/Refused/);
});
test('shared exact-in and exact-out routes bind both mints and amounts',async()=>{
  for(const exactOut of [false,true]){
    const def=schema.instructions.find(i=>i.name===(exactOut?'sharedAccountsExactOutRoute':'sharedAccountsRoute'));
    const data=Buffer.alloc(36);data.set(def.discriminator);data.writeUInt32LE(1,9);
    data[13]=3;data[14]=100;data[16]=1;
    data.writeBigUInt64LE(exactOut?6000000n:1000000n,17);data.writeBigUInt64LE(exactOut?1000000n:6000000n,25);data.writeUInt16LE(50,33);
    const accounts=[TOKEN,other,wallet.publicKey,associated(USDC),other,other,associated(SOL),new PublicKey(USDC),new PublicKey(SOL),JUP,new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),other,JUP];
    const ix=new TransactionInstruction({programId:JUP,data,keys:accounts.map((pubkey,i)=>({pubkey,isSigner:i===2,isWritable:[3,6].includes(i)}))});
    const q={...quote,swapMode:exactOut?'ExactOut':'ExactIn',otherAmountThreshold:exactOut?'1005000':'5970000'};
    validateQuote(q,{...intent,exactOut,amount:exactOut?6000000n:1000000n});
    await validateTransaction(transaction([ix]),q,wallet.publicKey.toBase58(),rpc);
    data.writeBigUInt64LE(1n,17);
    await assert.rejects(validateTransaction(transaction([ix]),q,wallet.publicKey.toBase58(),rpc),/Refused/);
  }
});
test('native SOL wrapping is allowed only into the wallet ATA and within input budget',async()=>{
  const q={...quote,inputMint:SOL,outputMint:USDC};
  const wrap=SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:associated(SOL),lamports:1000000});
  const sync=new TransactionInstruction({programId:TOKEN,keys:[{pubkey:associated(SOL),isSigner:false,isWritable:true}],data:Buffer.from([17])});
  await validateTransaction(transaction([wrap,sync,route({input:SOL,output:USDC})]),q,wallet.publicKey.toBase58(),rpc);
  await assert.rejects(validateTransaction(transaction([wrap,wrap,sync,route({input:SOL,output:USDC})]),q,wallet.publicKey.toBase58(),rpc),/Refused/);
});
test('unrelated wallet-owned writable token balances cannot be included',async()=>{
  const ix=route();ix.keys.push({pubkey:other,isSigner:false,isWritable:true});
  const raw=Buffer.alloc(165);raw.set(wallet.publicKey.toBytes(),32);
  const ownedRpc=async(method,params)=>method==='getMultipleAccounts'?{value:params[0].map(()=>({owner:TOKEN.toBase58(),data:[raw.toString('base64'),'base64']}))}:rpc();
  await assert.rejects(validateTransaction(transaction([ix]),quote,wallet.publicKey.toBase58(),ownedRpc),/Refused/);
});
test('route allocations cannot exceed the reviewed input or cycle through it',async()=>{
  for(const change of [[13,255],[15,0]]){
    const ix=route();ix.data[change[0]]=change[1];
    await assert.rejects(validateTransaction(transaction([ix]),quote,wallet.publicKey.toBase58(),rpc),/Refused/);
  }
});

// --- Real mainnet swap (Phantom, 2026-10-19): Swap enum variant 181 is NOT in the pinned schema, and
// Phantom appends two Lighthouse instructions to what it signs. Blocker 1: trailer read from the end.
{
  const msgOf=bytes=>VersionedTransaction.deserialize(bytes).message;
  const rebuild=(edit)=>{
    const m=real.message,ixs=m.compiledInstructions.map(i=>({programIdIndex:i.programIdIndex,accountKeyIndexes:[...i.accountKeyIndexes],data:Uint8Array.from(i.data)}));
    const out=edit(ixs,m)||ixs;
    return new VersionedTransaction(new MessageV0({header:m.header,staticAccountKeys:m.staticAccountKeys,recentBlockhash:m.recentBlockhash,compiledInstructions:out,addressTableLookups:m.addressTableLookups})).serialize();
  };
  const jupIx=ixs=>ixs.find(i=>real.message.staticAccountKeys[i.programIdIndex]?.toBase58()===JUP.toBase58());
  const check=(bytes,q=real.quote)=>validateTransaction(bytes,q,real.wallet,real.rpc);
  test('real mainnet swap: fixture has the shape the blockers describe',()=>{
    assert.equal(real.removed,2);
    const ix=jupIx(real.message.compiledInstructions.map(i=>({programIdIndex:i.programIdIndex,data:i.data})));
    assert.ok(ix);
    const variants=schema.types.find(t=>t.name==='Swap').type.variants.length;
    assert.ok(variants<=181,'the real route uses a Swap variant the pinned schema does not know');
  });
  test('real mainnet swap (unknown Swap variant, minus Lighthouse) passes with the quote built from route_args',async()=>{
    assert.equal(real.quote.otherAmountThreshold,String(BigInt(real.fixture.route_args.quotedOutAmount)*9950n/10000n));
    validateQuote(real.quote,{inputMint:real.SOL,outputMint:real.USDC,amount:Number(real.quote.inAmount),exactOut:false,slippageBps:50});
    assert.equal(await check(real.strippedBytes),true);
  });
  test('real swap with the wallet-added Lighthouse instructions is rejected by the validator',async()=>{
    await assert.rejects(check(real.fullBytes),/Refused/);
  });
  test('real swap tampering is rejected',async()=>{
    const cases={
      'destination ATA swapped':b=>rebuild(ixs=>{const j=jupIx(ixs);j.accountKeyIndexes[3]=0;}),
      'extra SPL Token transfer':b=>rebuild((ixs,m)=>{const t=m.staticAccountKeys.findIndex(k=>k.toBase58()===TOKEN.toBase58());assert.ok(t>=0);
        ixs.push({programIdIndex:t,accountKeyIndexes:[0,0,0],data:Uint8Array.from([3,1,0,0,0,0,0,0,0])});}),
      'priority fee above the 200,000-lamport cap':b=>rebuild((ixs,m)=>{
        const cb=ixs.find(i=>m.staticAccountKeys[i.programIdIndex]?.toBase58()==='ComputeBudget111111111111111111111111111111'&&i.data[0]===3);
        assert.ok(cb,'fixture has a compute unit price instruction');Buffer.from(cb.data.buffer).writeBigUInt64LE(10_000_000_000n,1);}),
      'inAmount + 1':b=>rebuild(ixs=>{const d=jupIx(ixs).data,o=d.length-19;const v=Buffer.from(d.buffer,d.byteOffset);v.writeBigUInt64LE(v.readBigUInt64LE(o)+1n,o);}),
      'quotedOutAmount changed':b=>rebuild(ixs=>{const d=jupIx(ixs).data,o=d.length-11;const v=Buffer.from(d.buffer,d.byteOffset);v.writeBigUInt64LE(v.readBigUInt64LE(o)+1n,o);}),
      'slippage changed':b=>rebuild(ixs=>{const d=jupIx(ixs).data;Buffer.from(d.buffer,d.byteOffset).writeUInt16LE(51,d.length-3);}),
      'platform fee set':b=>rebuild(ixs=>{const d=jupIx(ixs).data;d[d.length-1]=1;}),
      'unknown discriminator':b=>rebuild(ixs=>{jupIx(ixs).data[0]^=0xff;}),
      'data shorter than the trailer':b=>rebuild(ixs=>{const j=jupIx(ixs);j.data=j.data.slice(0,20);}),
    };
    for(const [name,make] of Object.entries(cases)){
      await assert.rejects(check(make()),/Refused/,name);
    }
  });
  test('real swap: unchanged bytes still pass after the tamper helpers rebuild them (control)',async()=>{
    assert.equal(await check(rebuild(()=>null)),true);
  });
}

// --- Independent balance check (checkSimulatedBalances) + route-unverified marking + wSOL ATA exemption ---
{
  const OTHER='JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',SYS='11111111111111111111111111111111',TOKEN_S=TOKEN.toBase58();
  const sys=l=>({lamports:l,owner:SYS,data:['','base64']});
  // حساب توکن: mint(0..32) owner(32..64) amount(64) state(108)=1
  const tok=(mint,amount,{owner=wallet.publicKey,lamports=2039280,program=TOKEN_S,state=1,size=165}={})=>{
    const raw=Buffer.alloc(size);raw.set(new PublicKey(mint).toBytes(),0);raw.set(owner.toBytes(),32);raw.writeBigUInt64LE(BigInt(amount),64);raw[108]=state;
    return {lamports,owner:program,data:[raw.toString('base64'),'base64']};
  };
  const W=wallet.publicKey.toBase58();
  const targetsFor=(i,o)=>({wallet:W,input:associated(i).toBase58(),output:associated(o).toBase58(),inputMint:i,outputMint:o,inputProgram:TOKEN_S,outputProgram:TOKEN_S});
  const exin={inputMint:USDC,outputMint:OTHER,inAmount:'1000000',outAmount:'6000000',otherAmountThreshold:'5970000',swapMode:'ExactIn',slippageBps:50};
  const exout={...exin,swapMode:'ExactOut',otherAmountThreshold:'1005000'};
  const tt=targetsFor(USDC,OTHER);
  const run=(q,t,pre,post,simErr=null)=>checkSimulatedBalances({quote:q,targets:t,pre,post,simErr});
  const ok=(...a)=>assert.equal(run(...a),true);
  const no=(...a)=>assert.throws(()=>run(...a),/Refused/);
  // [wallet, input, output]
  const tokPre=[sys(5e9),tok(USDC,5e6),tok(OTHER,100)],tokPost=(spent,got)=>[sys(5e9-5000),tok(USDC,5e6-spent),tok(OTHER,100+got)];

  test('native allowance is exactly 5000 (fee) + 200000 (priority cap) lamports',()=>{assert.equal(NATIVE_FEE_ALLOWANCE,205000n);});
  test('balance check: honest ExactIn and ExactOut token swaps pass, the edges are exact',()=>{
    ok(exin,tt,tokPre,tokPost(1000000,5970000));
    ok(exin,tt,tokPre,tokPost(999999,7000000));
    ok(exout,tt,tokPre,tokPost(1005000,6000000));
    ok(exout,tt,tokPre,tokPost(900000,6500000));
    // خروجی ساخته‌نشده (ATA خروجی هنوز نیست) = صفر پیش از swap؛ کرایه‌ی ساخت در سقفِ مجاز
    ok(exin,tt,[sys(5e9),tok(USDC,5e6),null],[sys(5e9-5000-2039280),tok(USDC,4e6),tok(OTHER,5970000)]);
  });
  test('balance check: input drop above inAmount / threshold is refused (ExactIn and ExactOut)',()=>{
    no(exin,tt,tokPre,tokPost(1000001,6000000));
    no(exout,tt,tokPre,tokPost(1005001,6000000));
  });
  test('balance check: lamports leaking from a non-SOL swap beyond fee+rent are refused',()=>{
    const post=tokPost(1000000,5970000);
    post[0]=sys(5e9-Number(NATIVE_FEE_ALLOWANCE));ok(exin,tt,tokPre,post);
    post[0]=sys(5e9-Number(NATIVE_FEE_ALLOWANCE)-1);no(exin,tt,tokPre,post);
  });
  test('balance check: output below otherAmountThreshold / outAmount is refused',()=>{
    no(exin,tt,tokPre,tokPost(1000000,5969999));
    no(exout,tt,tokPre,tokPost(1000000,5999999));
    no(exin,tt,tokPre,tokPost(1000000,0));
    no(exin,tt,tokPre,tokPost(0,0));
  });
  test('balance check: unreadable / unexpected state refuses (fail closed)',()=>{
    const good=tokPost(1000000,5970000);
    ok(exin,tt,tokPre,good);
    no(exin,tt,null,good);no(exin,tt,tokPre,null);no(exin,tt,undefined,undefined);no(exin,tt,{},{});
    no(exin,tt,tokPre.slice(0,2),good);no(exin,tt,tokPre,good.slice(0,2));no(exin,tt,tokPre,[...good,null]);
    no(exin,tt,tokPre,good,{InstructionError:[1,{Custom:6001}]});assert.throws(()=>checkSimulatedBalances({quote:exin,targets:tt,pre:tokPre,post:good}),/Refused/);no(exin,tt,tokPre,good,'Failure');
    // حساب جاافتاده
    for(const i of [0,1,2]){const a=[...good];a[i]=null;no(exin,tt,tokPre,a);}
    for(const i of [0,1]){const a=[...tokPre];a[i]=null;no(exin,tt,a,good);}
    // شکلِ غیرمنتظره
    const bad=[
      tok(USDC,1,{program:'Tokenz'+'QdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'}),            // برنامه‌ی دیگر
      tok(OTHER,5e6),                                                                   // mint اشتباه
      tok(USDC,5e6,{owner:Keypair.generate().publicKey}),                               // مالکِ دیگر
      tok(USDC,5e6,{state:2}),                                                          // فریز
      tok(USDC,5e6,{size:100}),                                                         // کوتاه
      {...tok(USDC,5e6),data:['!!!','base64']},{...tok(USDC,5e6),data:['AAAA','base58']},{...tok(USDC,5e6),data:'x'},
      {...tok(USDC,5e6),lamports:'1'},{...tok(USDC,5e6),lamports:-1},{...tok(USDC,5e6),lamports:2**60},
      'x',42,
    ];
    for(const [n,b] of bad.entries()){try{no(exin,tt,[sys(5e9),b,tok(OTHER,100)],good);no(exin,tt,tokPre,[good[0],good[1],b]);no(exin,tt,tokPre,[good[0],b,good[2]]);}catch(e){e.message+=' (bad #'+n+')';throw e;}}
    no(exin,tt,[{...sys(5e9),owner:TOKEN_S},tokPre[1],tokPre[2]],good);
    no(exin,tt,tokPre,[{...sys(5e9-5000),owner:TOKEN_S},good[1],good[2]]);
    no(exin,tt,tokPre,[{lamports:1.5,owner:SYS,data:['','base64']},good[1],good[2]]);
    no(null,tt,tokPre,good);no(exin,null,tokPre,good);no({...exin,inAmount:'0'},tt,tokPre,good);
  });

  const t1=targetsFor(SOL,USDC),t2=targetsFor(USDC,SOL);
  const wsol=associated(SOL).toBase58();
  test('balance check: native SOL in - wSOL ATA create/close and output ATA rent stay inside the documented allowance',()=>{
    const q={...exin,inputMint:SOL,outputMint:USDC,inAmount:'1000000000',outAmount:'150000000',otherAmountThreshold:'149250000'};
    // [wallet, wSOL ATA (=input), USDC ATA (=output)]
    const base=5_000_000_000;
    const rentTok=(128+165)*6960; // 2,039,280
    // wSOL ATA ساخته و در پایان بسته شد → فقط کیف‌پول می‌ماند
    ok(q,t1,[sys(base),null,tok(USDC,10)],[sys(base-1e9-5000),null,tok(USDC,10+149250000)]);
    // ATA خروجی ساخته شد: کرایه‌اش مجاز
    ok(q,t1,[sys(base),null,null],[sys(base-1e9-Number(NATIVE_FEE_ALLOWANCE)-rentTok),null,tok(USDC,149250000)]);
    // یک لامپورت بیشتر
    no(q,t1,[sys(base),null,null],[sys(base-1e9-Number(NATIVE_FEE_ALLOWANCE)-rentTok-1),null,tok(USDC,149250000)]);
    // ATA خروجی وجود داشت: کرایه مجاز نیست، فقط کارمزد
    ok(q,t1,[sys(base),null,tok(USDC,0)],[sys(base-1e9-Number(NATIVE_FEE_ALLOWANCE)),null,tok(USDC,149250000)]);
    no(q,t1,[sys(base),null,tok(USDC,0)],[sys(base-1e9-Number(NATIVE_FEE_ALLOWANCE)-1),null,tok(USDC,149250000)]);
    // wSOL ATA ساخته شد و کرایه‌اش در آن ماند (لامپورتِ خودِ کاربر): شمرده می‌شود، نه ضرر
    ok(q,t1,[sys(base),null,tok(USDC,0)],[sys(base-1e9-5000-2039280),tok(SOL,0,{lamports:2039280,}),tok(USDC,149250000)]);
    // ATA از قبل پر بود و باقی‌مانده‌اش ماند
    ok(q,t1,[sys(base),tok(SOL,0,{lamports:2039280+1e8}),tok(USDC,0)],[sys(base-1e9+1e8-5000),tok(SOL,0,{lamports:2039280+1e8}),tok(USDC,149250000)].map((x,i)=>i===0?sys(base-9e8-5000):x));
    // ExactOut: سقفِ ورودی = otherAmountThreshold
    const qo={...q,swapMode:'ExactOut',inAmount:'1000000000',outAmount:'150000000',otherAmountThreshold:'1005000000'};
    ok(qo,t1,[sys(base),null,tok(USDC,0)],[sys(base-1005000000-Number(NATIVE_FEE_ALLOWANCE)),null,tok(USDC,150000000)]);
    no(qo,t1,[sys(base),null,tok(USDC,0)],[sys(base-1005000000-Number(NATIVE_FEE_ALLOWANCE)-1),null,tok(USDC,150000000)]);
    no(qo,t1,[sys(base),null,tok(USDC,0)],[sys(base-1005000000-5000),null,tok(USDC,149999999)]);
    // خروجی کم
    no(q,t1,[sys(base),null,tok(USDC,0)],[sys(base-1e9-5000),null,tok(USDC,149249999)]);
  });
  test('balance check: native SOL out - proceeds are measured on wallet + wSOL ATA, allowance is fee only',()=>{
    const q={...exin,inputMint:USDC,outputMint:SOL,inAmount:'150000000',outAmount:'1000000000',otherAmountThreshold:'995000000'};
    const base=5_000_000_000;
    // [wallet, USDC ATA (=input), wSOL ATA (=output)]
    ok(q,t2,[sys(base),tok(USDC,150000000),null],[sys(base+995000000-5000),tok(USDC,0),null]);
    // دقیقاً روی مرز: خروجی + ۲۰۵۰۰۰ - کارمزد
    ok(q,t2,[sys(base),tok(USDC,150000000),null],[sys(base+995000000-Number(NATIVE_FEE_ALLOWANCE)),tok(USDC,0),null]);
    no(q,t2,[sys(base),tok(USDC,150000000),null],[sys(base+995000000-Number(NATIVE_FEE_ALLOWANCE)-1),tok(USDC,0),null]);
    // خروجی در wSOL ATA ماند (بسته نشد): شمرده می‌شود
    ok(q,t2,[sys(base),tok(USDC,150000000),null],[sys(base-5000-2039280),tok(USDC,0),tok(SOL,995000000,{lamports:995000000+2039280})]);
    no(q,t2,[sys(base),tok(USDC,150000000),null],[sys(base-5000-2039280),tok(USDC,0),tok(SOL,994000000,{lamports:994000000+2039280})]);
    // ورودیِ توکن بیش از inAmount
    ok(q,t2,[sys(base),tok(USDC,200000000),null],[sys(base+995000000-5000),tok(USDC,50000000),null]);
    no(q,t2,[sys(base),tok(USDC,200000000),null],[sys(base+995000000-5000),tok(USDC,49999999),null]);
  });
  test('balance check: the output ATA is only a free pass when it is the SOL leg',()=>{
    // خروجیِ توکنی نباید بعد از swap ناپدید شود
    const good=tokPost(1000000,5970000);
    no(exin,tt,tokPre,[good[0],good[1],null]);
    no(exin,tt,tokPre,[good[0],null,good[2]]);
  });

  test('auditor attack: real fixture + unknown Swap variant + real amounts after the route and a quote-matching trailer at the end',async()=>{
    const m=real.message,ixs=m.compiledInstructions.map(i=>({programIdIndex:i.programIdIndex,accountKeyIndexes:[...i.accountKeyIndexes],data:Uint8Array.from(i.data)}));
    const j=ixs.find(i=>m.staticAccountKeys[i.programIdIndex].toBase58()===JUP.toBase58());
    const honest=j.data,head=honest.slice(0,honest.length-19);
    const evil=Buffer.alloc(19);evil.writeBigUInt64LE(2n**63n,0);evil.writeBigUInt64LE(1n,8);evil.writeUInt16LE(10000,16);evil[18]=0;
    j.data=Uint8Array.from(Buffer.concat([head,evil,honest.slice(honest.length-19)]));
    const bytes=new VersionedTransaction(new MessageV0({header:m.header,staticAccountKeys:m.staticAccountKeys,recentBlockhash:m.recentBlockhash,compiledInstructions:ixs,addressTableLookups:m.addressTableLookups})).serialize();
    const info=await inspectTransaction(bytes,real.quote,real.wallet,real.rpc);
    // رمزگشا فریب می‌خورد (و باید اعلام کند که مسیر تأییدنشده است)...
    assert.equal(info.routeUnverified,true);
    // ...ولی مقایسه‌ی موجودی که واقعاً شبیه‌سازی شد او را می‌گیرد
    const inAmount=BigInt(real.quote.inAmount),out=BigInt(real.quote.otherAmountThreshold),base=500_000_000_000n;
    const w=info.targets.wallet;
    const pre=[sys(Number(base)),null,tok(USDC,0,{owner:new PublicKey(w)})];
    const stolen=inAmount*3n;
    const post=[sys(Number(base-stolen-5000n)),null,tok(USDC,out,{owner:new PublicKey(w)})];
    assert.throws(()=>checkSimulatedBalances({quote:real.quote,targets:info.targets,pre,post,simErr:null}),/Refused/);
    // همان تراکنش وقتی واقعاً فقط inAmount خرج کند پاس است (کنترل)
    const fine=[sys(Number(base-inAmount-5000n)),null,tok(USDC,out,{owner:new PublicKey(w)})];
    assert.equal(checkSimulatedBalances({quote:real.quote,targets:info.targets,pre,post:fine,simErr:null}),true);
    assert.deepEqual(balanceAddresses(info.targets),[w,info.targets.input,info.targets.output]);
  });
  test('known Swap variants are not marked route-unverified; the real fixture (variant 181) is',async()=>{
    const known=await inspectTransaction(transaction([route()]),quote,W,rpc);
    assert.equal(known.routeUnverified,false);
    assert.equal((await inspectTransaction(real.strippedBytes,real.quote,real.wallet,real.rpc)).routeUnverified,true);
  });
  test('wSOL ATA may be writable only when SOL is one of the legs',async()=>{
    const q2={...quote,outputMint:OTHER};
    // rpc که getMultipleAccounts را درست جواب می‌دهد (همه null)، تا فقط خودِ قاعده‌ی wSOL تعیین‌کننده باشد
    const rpc=async(method,params)=>method==='getMultipleAccounts'?{value:params[0].map(()=>null)}:{value:{owner:TOKEN.toBase58(),data:{parsed:{type:'mint'}}}};
    const withWsol=(ix,writable)=>{ix.keys.push({pubkey:associated(SOL),isSigner:false,isWritable:writable});return ix;};
    // بدونِ ساق SOL: writable رد؛ فقط‌خواندنی مجاز (کنترل)
    await assert.rejects(validateTransaction(transaction([withWsol(route({output:OTHER}),true)]),q2,W,rpc),/Refused/);
    await validateTransaction(transaction([withWsol(route({output:OTHER}),false)]),q2,W,rpc);
    // با ساق SOL: همان حسابِ writable مجاز
    await validateTransaction(transaction([withWsol(route(),true)]),quote,W,rpc);
  });
}
