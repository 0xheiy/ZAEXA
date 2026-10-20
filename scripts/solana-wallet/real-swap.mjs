// Replay helper for the real mainnet SOL->USDC swap fixture (web/test/fixtures/sol_real_swap.json).
// Builds the Jupiter message without the wallet-added Lighthouse instructions and a faithful RPC stub.
import {VersionedTransaction,MessageV0,PublicKey} from '@solana/web3.js';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const FIX=fileURLToPath(new URL('../../web/test/fixtures/sol_real_swap.json',import.meta.url));
export const LIGHTHOUSE='L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
export const SOL='So11111111111111111111111111111111111111112',USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const fixture=JSON.parse(readFileSync(FIX,'utf8'));
export const wallet=fixture.wallet;
export const fullBytes=new Uint8Array(Buffer.from(fixture.tx_b64,'base64'));
const m=VersionedTransaction.deserialize(fullBytes).message;
export function strip(message,drop=LIGHTHOUSE){
  const keep=message.compiledInstructions.filter(ix=>message.staticAccountKeys[ix.programIdIndex].toBase58()!==drop);
  return new MessageV0({header:message.header,staticAccountKeys:message.staticAccountKeys,recentBlockhash:message.recentBlockhash,compiledInstructions:keep,addressTableLookups:message.addressTableLookups});
}
export const message=strip(m);
// Tampered variant for the browser harness: the Jupiter destination token account is swapped for the wallet itself.
export function tampered(){
  const ixs=message.compiledInstructions.map(i=>({programIdIndex:i.programIdIndex,accountKeyIndexes:[...i.accountKeyIndexes],data:i.data}));
  const j=ixs.find(i=>message.staticAccountKeys[i.programIdIndex].toBase58()==='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
  j.accountKeyIndexes[3]=0;
  return new VersionedTransaction(new MessageV0({header:message.header,staticAccountKeys:message.staticAccountKeys,recentBlockhash:message.recentBlockhash,compiledInstructions:ixs,addressTableLookups:message.addressTableLookups})).serialize();
}
export const strippedBytes=new VersionedTransaction(message).serialize();
export const removed=m.compiledInstructions.length-message.compiledInstructions.length;
const a=fixture.route_args;
export const quote={inputMint:SOL,outputMint:USDC,inAmount:a.inAmount,outAmount:a.quotedOutAmount,swapMode:'ExactIn',slippageBps:a.slippageBps,
  priceImpactPct:'0',routePlan:[{}],otherAmountThreshold:String(BigInt(a.quotedOutAmount)*BigInt(10000-a.slippageBps)/10000n)};
// ALT account bytes with only the indexes the message reads filled from the snapshot.
const lu=m.addressTableLookups[0],addrs=Array(256).fill(PublicKey.default);
lu.writableIndexes.forEach((ix,i)=>addrs[ix]=new PublicKey(fixture.loaded.writable[i]));
lu.readonlyIndexes.forEach((ix,i)=>addrs[ix]=new PublicKey(fixture.loaded.readonly[i]));
const hdr=Buffer.alloc(56);hdr.writeUInt32LE(1,0);hdr.writeBigUInt64LE(0xffffffffffffffffn,4);
export const altB64=Buffer.concat([hdr,...addrs.map(x=>x.toBuffer())]).toString('base64');
export const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export function accountsFor(method,params){
  if(method==='getAccountInfo'){
    if(params[0]===fixture.alt)return{value:{owner:'AddressLookupTab1e1111111111111111111111111',data:[altB64,'base64']}};
    return{value:{owner:TOKEN,data:{parsed:{type:'mint'}}}};
  }
  if(method==='getMultipleAccounts')return{value:params[0].map(k=>{const o=fixture.token_accounts[k];if(!o)return null;
    const b=Buffer.alloc(165);Buffer.from(o[1],'hex').copy(b,32);return{owner:o[0],data:[b.toString('base64'),'base64']};})};
  throw new Error('unexpected '+method);
}
export const rpc=async(method,params)=>accountsFor(method,params);
if(process.argv[2]==='--write'){
  // Derived, deterministic data for the browser harness (no node deps needed there).
  const out=fileURLToPath(new URL('../../web/test/fixtures/sol_real_swap_stripped.json',import.meta.url));
  writeFileSync(out,JSON.stringify({wallet,quote,swapTransaction:Buffer.from(strippedBytes).toString('base64'),swapTransactionTampered:Buffer.from(tampered()).toString('base64'),alt:fixture.alt,altB64,
    token_accounts:fixture.token_accounts,mints:{[SOL]:TOKEN,[USDC]:TOKEN},lighthouseRemoved:removed},null,1)+'\n');
  console.log('wrote',out);
}
