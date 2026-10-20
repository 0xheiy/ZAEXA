import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, Keypair, TransactionMessage, VersionedTransaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram, AddressLookupTableAccount } from '@solana/web3.js';
import { validateTransaction, validateQuote, assertSameMessage } from './intent.js';
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
