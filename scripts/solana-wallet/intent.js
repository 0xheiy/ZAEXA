import { PublicKey, VersionedTransaction, AddressLookupTableAccount } from '@solana/web3.js';
import schema from './jupiter-schema.json' with { type: 'json' };

const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SYSTEM = '11111111111111111111111111111111';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SOL = 'So11111111111111111111111111111111111111112';
const fail = () => { throw new Error('Refused: transaction does not match the reviewed swap, or uses an unsupported instruction.'); };
const eq = (a,b) => a?.toString() === b?.toString();
const uint = x => typeof x === 'string' && /^[0-9]+$/.test(x) && BigInt(x)>0n && BigInt(x)<2n**64n;

export function validateQuote(q, { inputMint, outputMint, amount, exactOut, slippageBps }) {
  if (!q || q.inputMint!==inputMint || q.outputMint!==outputMint || inputMint===outputMint ||
      q.swapMode!==(exactOut?'ExactOut':'ExactIn') || q.slippageBps!==slippageBps ||
      !uint(q.inAmount) || !uint(q.outAmount) || !uint(q.otherAmountThreshold) ||
      (exactOut?q.outAmount:q.inAmount)!==String(amount) || !Array.isArray(q.routePlan) || !q.routePlan.length ||
      q.routePlan.length>64 || (q.platformFee && q.platformFee.feeBps!==0) ||
      typeof q.priceImpactPct!=='string' || !/^-?[0-9]+(?:\.[0-9]+)?$/.test(q.priceImpactPct) || !Number.isFinite(Number(q.priceImpactPct))) fail();
  const slip=BigInt(slippageBps);
  if (slip<0n || slip>5000n) fail();
  if (exactOut) {
    const product=BigInt(q.inAmount)*(10000n+slip),floor=product/10000n,ceil=(product+9999n)/10000n;
    if(BigInt(q.otherAmountThreshold)<floor || BigInt(q.otherAmountThreshold)>ceil)fail();
    // Display a conservative bound regardless of upstream integer rounding.
    q.otherAmountThreshold=ceil.toString();
  } else {
    const product=BigInt(q.outAmount)*(10000n-slip),floor=product/10000n,ceil=(product+9999n)/10000n;
    if(floor===0n || BigInt(q.otherAmountThreshold)<floor || BigInt(q.otherAmountThreshold)>ceil)fail();
    q.otherAmountThreshold=floor.toString();
  }
  return q;
}

// Decode the pinned Jupiter ABI. The fixed trailing arguments are always read from
// the END of the data, independent of how routePlan is encoded, so a Swap variant
// newer than the pinned schema (Jupiter adds them often) cannot hide or shift them.
// When every Swap variant is known the routePlan is fully decoded too (offset must
// land exactly on the trailer); with an unknown variant only that structural
// decode is skipped - every amount/slippage/fee/account check still applies.
// BUT an unknown variant means the bytes Anchor reads on chain (right after the
// route) are NOT proven to be the bytes we read from the end: a hostile response can
// put real amounts after the route and append a quote-matching 19-byte trailer.
// So such a result is reported as routeUnverified, and the decoded amounts are never
// trusted alone: the page's simulated balance check (checkSimulatedBalances) is the
// authority on what the transaction really does to the wallet.
const TRAILER = 8 + 8 + 2 + 1;
function decodeRoute(data) {
  const instruction=schema.instructions.find(i=>i.discriminator.every((v,n)=>data[n]===v));
  if(!instruction)fail();
  if(data.length<8+4+TRAILER)fail();
  const names=instruction.args.map(a=>a.name).slice(-4);
  const at=(start,size)=>{let x=0n;for(let i=0;i<size;i++)x|=BigInt(data[start+i])<<BigInt(i*8);return x;};
  const base=data.length-TRAILER;
  const args={[names[0]]:at(base,8),[names[1]]:at(base+8,8),[names[2]]:at(base+16,2),[names[3]]:at(base+18,1)};
  const UNKNOWN=Symbol('unknown-variant');
  let offset=8;
  const number=n=>{if(offset+n>base)fail();let x=0n;for(let i=0;i<n;i++)x|=BigInt(data[offset++])<<BigInt(i*8);return x;};
  const fields=xs=>Object.fromEntries(xs.map(f=>[f.name,read(f.type)]));
  function read(t){
    if(typeof t==='string'){
      if(t==='bool'){const v=number(1);if(v>1n)fail();return v===1n;}
      const sizes={u8:1,u16:2,u32:4,u64:8};if(!sizes[t])fail();return number(sizes[t]);
    }
    if(t.vec){const n=Number(number(4));if(n<1||n>64)fail();return Array.from({length:n},()=>read(t.vec));}
    if(t.defined){const def=schema.types.find(x=>x.name===t.defined)?.type;if(!def)fail();
      if(def.kind==='struct')return fields(def.fields);
      if(def.kind==='enum'){const variant=def.variants[Number(number(1))];
        if(!variant){if(t.defined==='Swap')throw UNKNOWN;fail();}
        return {name:variant.name,...fields(variant.fields||[])};}
    }
    fail();
  }
  let known=true;
  try{
    const head=fields(instruction.args.slice(0,-4));
    if(offset!==base)fail();
    Object.assign(args,head);
  }catch(e){if(e!==UNKNOWN)throw e;known=false;}
  return {...instruction,args,routePlanKnown:known};
}

const ata=(wallet,mint,program)=>PublicKey.findProgramAddressSync(
  [new PublicKey(wallet).toBytes(),new PublicKey(program).toBytes(),new PublicKey(mint).toBytes()],new PublicKey(ATA))[0].toBase58();

// Returns {routeUnverified, targets}: routeUnverified is true when the routePlan holds a
// Swap variant unknown to the pinned schema (see decodeRoute); targets are the wallet
// accounts the balance check (checkSimulatedBalances) must read before/after simulation.
export async function inspectTransaction(bytes, quote, wallet, rpc) {
  if(!(bytes instanceof Uint8Array)||bytes.length>1232)fail();
  const bound=quote.swapMode==='ExactOut'?
    (BigInt(quote.inAmount)*(10000n+BigInt(quote.slippageBps))+9999n)/10000n:
    BigInt(quote.outAmount)*(10000n-BigInt(quote.slippageBps))/10000n;
  if(BigInt(quote.otherAmountThreshold)!==bound)fail();
  const tx=VersionedTransaction.deserialize(bytes),m=tx.message;
  if(m.header.numRequiredSignatures!==1 || !eq(m.staticAccountKeys[0],wallet))fail();
  const lookups=[];
  for(const lookup of m.addressTableLookups||[]){
    const result=await rpc('getAccountInfo',[lookup.accountKey.toBase58(),{encoding:'base64'}]);
    const value=result?.value;
    if(!value||value.owner!=='AddressLookupTab1e1111111111111111111111111'||value.data?.[1]!=='base64')fail();
    const raw=Uint8Array.from(atob(value.data[0]),c=>c.charCodeAt(0));
    lookups.push(new AddressLookupTableAccount({key:lookup.accountKey,state:AddressLookupTableAccount.deserialize(raw)}));
  }
  const keys=m.getAccountKeys({addressLookupTableAccounts:lookups});
  const programs=await Promise.all([quote.inputMint,quote.outputMint].map(async mint=>{
    const result=await rpc('getAccountInfo',[mint,{encoding:'jsonParsed'}]);
    const value=result?.value;
    if(!value||![TOKEN,TOKEN22].includes(value.owner)||value.data?.parsed?.type!=='mint')fail();
    return value.owner;
  }));
  const source=ata(wallet,quote.inputMint,programs[0]),destination=ata(wallet,quote.outputMint,programs[1]);
  const wrapped=ata(wallet,SOL,TOKEN),exactOut=quote.swapMode==='ExactOut';
  const maxIn=BigInt(exactOut?quote.otherAmountThreshold:quote.inAmount);
  let swaps=0,transfer=0n,units=1400000n,price=0n,routeUnverified=false;
  const seen=new Set();
  for(const ix of m.compiledInstructions){
    const program=keys.get(ix.programIdIndex).toBase58(),accounts=ix.accountKeyIndexes.map(i=>keys.get(i).toBase58()),data=ix.data;
    const n=(start,size)=>{if(data.length<start+size)fail();let v=0n;for(let i=0;i<size;i++)v|=BigInt(data[start+i])<<BigInt(i*8);return v;};
    if(program===JUP){
      if(++swaps!==1)fail();
      const decoded=decodeRoute(data),a=decoded.args;
      routeUnverified=!decoded.routePlanKnown;
      // A split cannot spend the same input allocation more than once. Reject
      // cycles and over-allocation even if the outer inAmount looks correct.
      const available=new Set([0n]),shares=new Map();
      for(const step of (decoded.routePlanKnown?a.routePlan:[])){
        if(!available.has(step.inputIndex)||step.outputIndex<=step.inputIndex||step.outputIndex>64n||step.percent<1n||step.percent>100n)fail();
        const total=(shares.get(step.inputIndex)||0n)+step.percent;
        if(total>100n)fail();shares.set(step.inputIndex,total);available.add(step.outputIndex);
      }
      const shared=decoded.name.startsWith('sharedAccounts'),out=decoded.name==='sharedAccountsExactOutRoute';
      if(out!==exactOut||a.platformFeeBps!==0n||a.slippageBps!==BigInt(quote.slippageBps)||
        (out?(a.outAmount!==BigInt(quote.outAmount)||a.quotedInAmount!==BigInt(quote.inAmount)):
          (a.inAmount!==BigInt(quote.inAmount)||a.quotedOutAmount!==BigInt(quote.outAmount))))fail();
      const ac=Object.fromEntries(decoded.accounts.map((name,i)=>[name,accounts[i]]));
      if(![TOKEN,TOKEN22].includes(ac.tokenProgram)||(shared&&![TOKEN22,JUP].includes(ac.token2022Program)))fail();
      if(!eq(ac.userTransferAuthority,wallet)||!eq(shared?ac.sourceTokenAccount:ac.userSourceTokenAccount,source)||
        !eq(shared?ac.destinationTokenAccount:ac.userDestinationTokenAccount,destination)||
        !eq(ac.destinationMint,quote.outputMint)||!eq(ac.program,JUP)||!eq(ac.platformFeeAccount,JUP))fail();
      if(shared&&!eq(ac.sourceMint,quote.inputMint))fail();
      // The optional destination override would permit delivery elsewhere.
      if(!shared&&!eq(ac.destinationTokenAccount,JUP))fail();
    }else if(program===COMPUTE){
      if(accounts.length||seen.has('compute'+data[0]))fail();seen.add('compute'+data[0]);
      if(data[0]===2&&data.length===5)units=n(1,4);
      else if(data[0]===3&&data.length===9)price=n(1,8);
      else fail();
    }else if(program===ATA){
      if(![0,1].includes(data[0]??0)||data.length>1||accounts.length<6||!eq(accounts[0],wallet)||!eq(accounts[2],wallet)||
        ![quote.inputMint,quote.outputMint].includes(accounts[3])||accounts[4]!==SYSTEM||![TOKEN,TOKEN22].includes(accounts[5])||
        accounts[1]!==ata(wallet,accounts[3],accounts[5])||seen.has(accounts[1]))fail();
      const index=accounts[3]===quote.inputMint?0:1;if(accounts[5]!==programs[index])fail();seen.add(accounts[1]);
    }else if(program===SYSTEM){
      // Only wrapping the exact input SOL into the user's own ATA is allowed.
      if(quote.inputMint!==SOL||data.length!==12||n(0,4)!==2n||accounts.length!==2||!eq(accounts[0],wallet)||accounts[1]!==wrapped)fail();
      transfer+=n(4,8);if(transfer>maxIn)fail();
    }else if([TOKEN,TOKEN22].includes(program)){
      if(program!==TOKEN||data.length!==1)fail();
      if(data[0]===17){if(quote.inputMint!==SOL||accounts.length!==1||accounts[0]!==wrapped)fail();}
      else if(data[0]===9){if(![quote.inputMint,quote.outputMint].includes(SOL)||accounts.length!==3||accounts[0]!==wrapped||!eq(accounts[1],wallet)||!eq(accounts[2],wallet))fail();}
      else fail(); // No approve, setAuthority, transfer or other token action.
    }else fail();
  }
  if(swaps!==1||units<1n||units>1400000n||(units*price+999999n)/1000000n>200000n)fail();
  // Jupiter's remaining accounts must not expose unrelated writable token
  // balances owned by this wallet to a routed CPI.
  // The wrapped-SOL ATA is only exempt when SOL is one of the two legs; otherwise it
  // must not be writable at all (a routed CPI has no business touching it).
  const solLeg=[quote.inputMint,quote.outputMint].includes(SOL);
  const remaining=[];
  for(let i=0;i<keys.length;i++){
    const address=keys.get(i).toBase58();
    if(!solLeg&&address===wrapped&&m.isAccountWritable(i))fail();
    if(m.isAccountWritable(i)&&![wallet,source,destination,JUP,...(solLeg?[wrapped]:[])].includes(address))remaining.push(address);
  }
  for(let i=0;i<remaining.length;i+=32){
    const addresses=remaining.slice(i,i+32);
    const result=await rpc('getMultipleAccounts',[addresses,{encoding:'base64'}]);
    if(!Array.isArray(result?.value)||result.value.length!==addresses.length)fail();
    for(const value of result.value){
      if(!value||![TOKEN,TOKEN22].includes(value.owner))continue;
      if(value.data?.[1]!=='base64')fail();
      const raw=Uint8Array.from(atob(value.data[0]),c=>c.charCodeAt(0));
      if(raw.length>=165&&new PublicKey(raw.slice(32,64)).toBase58()===wallet)fail();
    }
  }
  return {routeUnverified,targets:{wallet,input:source,output:destination,inputMint:quote.inputMint,outputMint:quote.outputMint,inputProgram:programs[0],outputProgram:programs[1]}};
}

export async function validateTransaction(bytes, quote, wallet, rpc) {
  await inspectTransaction(bytes, quote, wallet, rpc);
  return true;
}

// ---- Independent balance check (authority over what the swap really does) ----
// The instruction decoder above can be fooled (unknown Swap variant, see decodeRoute), so
// before signing the page simulates the exact bytes and compares the wallet's accounts
// before and after. This function is the pure comparison; every doubt refuses.

// Addresses to read before and to return from simulateTransaction (at most 3 unique).
export function balanceAddresses(targets){
  return [...new Set([targets.wallet,targets.input,targets.output])];
}

// Native SOL allowance (lamports) on top of the quoted amount, for legs that touch SOL:
//  - network fee: 1 signature x 5000 lamports
//  - priority fee: validateTransaction caps units x price at 200,000 lamports
//  - rent of accounts the tx creates (non-wSOL ATAs): computed from the simulated size
//    as (128 + size) x 6960 (3480 lamports/byte-year x 2 years); any excess over that
//    rent counts as a loss. The wSOL ATA needs no allowance: its lamports (rent included)
//    are counted in the SOL holdings, so create/close just moves lamports inside them.
export const NATIVE_FEE_ALLOWANCE=5000n+200000n;
const RENT_PER_BYTE=6960n,ACCOUNT_OVERHEAD=128n;
const refuse=()=>fail();
function lamportsOf(v){
  if(!v||typeof v!=='object'||!Number.isSafeInteger(v.lamports)||v.lamports<0)refuse();
  return BigInt(v.lamports);
}
function tokenAccount(v,{program,mint,wallet}){
  if(v===null)return null;
  if(!v||typeof v!=='object'||v.owner!==program||!Array.isArray(v.data)||v.data[1]!=='base64'||typeof v.data[0]!=='string')refuse();
  let raw;
  try{raw=Uint8Array.from(atob(v.data[0]),c=>c.charCodeAt(0));}catch{refuse();}
  if(raw.length<165||raw[108]!==1)refuse();
  if(new PublicKey(raw.slice(0,32)).toBase58()!==mint||new PublicKey(raw.slice(32,64)).toBase58()!==wallet)refuse();
  let amount=0n;for(let i=7;i>=0;i--)amount=(amount<<8n)|BigInt(raw[64+i]);
  return {lamports:lamportsOf(v),amount,size:BigInt(raw.length)};
}
// pre/post: account infos (RPC "base64" shape, or null when absent) in balanceAddresses() order;
// simErr: the simulation's err (must be exactly null).
export function checkSimulatedBalances({quote,targets,pre,post,simErr}){
  try{
    if(simErr!==null||!quote||!targets)refuse();
    const n=balanceAddresses(targets).length;
    if(!Array.isArray(pre)||!Array.isArray(post)||pre.length!==n||post.length!==n)refuse();
    const at=(list,address)=>list[balanceAddresses(targets).indexOf(address)];
    const exactOut=quote.swapMode==='ExactOut';
    const solIn=targets.inputMint===SOL,solOut=targets.outputMint===SOL;
    if(!uint(quote.inAmount)||!uint(quote.outAmount)||!uint(quote.otherAmountThreshold))refuse();
    const maxIn=BigInt(exactOut?quote.otherAmountThreshold:quote.inAmount);
    const minOut=BigInt(exactOut?quote.outAmount:quote.otherAmountThreshold);
    const w=targets.wallet;
    const side=(list,kind)=>tokenAccount(at(list,targets[kind]),{program:targets[kind+'Program'],mint:targets[kind+'Mint'],wallet:w});
    for(const list of [pre,post]){const v=at(list,w);if(!v||v.owner!==SYSTEM)refuse();}
    const wallet0=lamportsOf(at(pre,w)),wallet1=lamportsOf(at(post,w));
    const in0=side(pre,'input'),in1=side(post,'input'),out0=side(pre,'output'),out1=side(post,'output');
    // An absent account is 0 only where that is natural: a not-yet-created output ATA before,
    // the wSOL ATA on either side (created / closed by the tx). Anything else is unexpected.
    if(!solIn&&(!in0||!in1))refuse();
    if(!solOut&&!out1)refuse();
    // Native SOL holdings = wallet lamports + the wSOL ATA lamports (rent included).
    const wsol=(a,b)=>solIn?a:solOut?b:null;
    const held=(walletLamports,sol)=>walletLamports+(sol?sol.lamports:0n);
    const native0=held(wallet0,wsol(in0,out0)),native1=held(wallet1,wsol(in1,out1));
    let rent=0n;
    for(const [before,after,isSol] of [[in0,in1,solIn],[out0,out1,solOut]])
      if(!isSol&&!before&&after)rent+=(ACCOUNT_OVERHEAD+after.size)*RENT_PER_BYTE;
    const allowance=NATIVE_FEE_ALLOWANCE+rent;
    const nativeDrop=native0-native1;
    // Input side
    if(solIn){if(nativeDrop>maxIn+allowance)refuse();}
    else{if(in0.amount-in1.amount>maxIn)refuse();if(!solOut&&nativeDrop>allowance)refuse();}
    // Output side
    if(solOut){if(-nativeDrop+allowance<minOut)refuse();}
    else if(out1.amount-(out0?out0.amount:0n)<minOut)refuse();
    return true;
  }catch(e){
    if(e&&/^Refused/.test(e.message))throw e;
    fail();
  }
}

export function assertSameMessage(unsigned,signed){
  const a=VersionedTransaction.deserialize(unsigned).message.serialize();
  const b=VersionedTransaction.deserialize(signed).message.serialize();
  if(a.length!==b.length||a.some((v,i)=>v!==b[i]))fail();
}
