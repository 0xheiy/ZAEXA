import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import nacl from '../../scripts/solana-wallet/node_modules/tweetnacl/nacl-fast.js';
import bs58 from '../../scripts/solana-wallet/node_modules/bs58/src/esm/index.js';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function setup(){
 const kp=nacl.sign.keyPair(),acc={address:bs58.encode(kp.publicKey),publicKey:kp.publicKey};
 const messages=[],events=[],storage=new Map();let approval=async message=>({account:acc,signedMessage:message,signature:nacl.sign.detached(message,kp.secretKey),signatureType:'ed25519'});
 const wallet={name:'Test wallet',accounts:[acc],features:{
  'standard:connect':{connect:async()=>({accounts:[acc]})},
  'standard:disconnect':{disconnect:async()=>{}},
  'solana:signMessage':{signMessage:async({message})=>{messages.push(message);return [await approval(message)];}}
 }};
 const c=vm.createContext({Uint8Array,TextEncoder,Date,Array,crypto:webcrypto,location:{origin:'https://zaexa.com'},
  solAccount:null,solWalletApi:null,solPendingWallet:null,solConnectionBusy:false,solWalletConnectSeq:0,
  solBalanceSeq:0,solEventsUnsub:null,solDisconnectPending:Promise.resolve(),SOL_WALLET_LS_KEY:'wallet',
  localStorage:{setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
  solLoadMobileBundle:async()=>({nacl,bs58}),solSetWalletOff(){},solSubscribeWalletEvents(){},
  solPaintWallet(){},solRefreshBalances(){},solScheduleQuote(){},solPaintBalance(){},solInvalidateQuote(){},
  solSetNotice(text){c.notice=text;},note:(type,text)=>text,esc:s=>s,isUserRejection:e=>e.code===4001,
  ev:(...args)=>events.push(args),$:()=>({classList:{remove(){}}}),
 });
 for(const name of ['solBytesEq','solConfirmConnection','solConnectWallet','solDisconnectWallet','solMaybeSilentConnect','solSubscribeWalletEvents']){
  const match=new RegExp('(?:async )?function '+name+'\\(').exec(html);assert.ok(match,name);
  const end=html.indexOf('\n}',match.index);vm.runInContext(html.slice(match.index,end+2),c);
 }
 return {c,acc,kp,wallet,messages,events,setApproval:fn=>approval=fn};
}
test('returning an address never connects until fresh message approval completes',async()=>{
 const s=setup(),d=deferred();s.setApproval(message=>d.promise.then(()=>({account:s.acc,signedMessage:message,signature:nacl.sign.detached(message,s.kp.secretKey)})));
 const pending=s.c.solConnectWallet(s.wallet);while(!s.messages.length)await new Promise(r=>setImmediate(r));
 assert.equal(s.c.solAccount,null);assert.equal(s.c.solWalletApi,null);assert.equal(s.events.length,0);assert.equal(s.c.solConnectionBusy,true);
 d.resolve();await pending;assert.equal(s.c.solAccount.address,s.acc.address);assert.equal(s.events.length,1);
});
test('rejection leaves the site disconnected',async()=>{
 const s=setup();s.setApproval(async()=>{throw Object.assign(Error('Rejected'),{code:4001});});
 await s.c.solConnectWallet(s.wallet);assert.equal(s.c.solAccount,null);assert.equal(s.events.length,0);assert.match(s.c.notice,/cancelled/);assert.equal(s.c.solConnectionBusy,false);
});
test('manual disconnect invalidates an outstanding approval even if later signed',async()=>{
 const s=setup(),d=deferred();s.setApproval(message=>d.promise.then(()=>({account:s.acc,signedMessage:message,signature:nacl.sign.detached(message,s.kp.secretKey)})));
 const pending=s.c.solConnectWallet(s.wallet);while(!s.messages.length)await new Promise(r=>setImmediate(r));
 s.c.solDisconnectWallet(true);d.resolve();await pending;assert.equal(s.c.solAccount,null);assert.equal(s.events.length,0);
});
test('every reconnect gets a different nonce; previous approval cannot be replayed',async()=>{
 const s=setup();await s.c.solConnectWallet(s.wallet);assert.ok(s.c.solAccount);s.c.solDisconnectWallet(true);
 const previous=s.messages[0];s.setApproval(async()=>({account:s.acc,signedMessage:previous,signature:nacl.sign.detached(previous,s.kp.secretKey)}));
 await s.c.solConnectWallet(s.wallet);assert.equal(s.messages.length,2);assert.notDeepEqual(s.messages[0],s.messages[1]);assert.equal(s.c.solAccount,null);
});
test('invalid signatures and mismatched accounts cannot connect',async()=>{
 for(const mismatch of [false,true]){const s=setup();s.setApproval(async message=>({account:mismatch?{...s.acc,address:'wrong'}:s.acc,signedMessage:message,signature:new Uint8Array(64)}));await s.c.solConnectWallet(s.wallet);assert.equal(s.c.solAccount,null);assert.equal(s.events.length,0);}
});
test('wallets without message approval support cannot bypass confirmation',async()=>{
 const s=setup();delete s.wallet.features['solana:signMessage'];await s.c.solConnectWallet(s.wallet);assert.equal(s.c.solAccount,null);assert.match(s.c.notice,/message approval support/);
});
test('connection proof states domain, address and no spending permission',async()=>{
 const s=setup();await s.c.solConnectWallet(s.wallet);const text=new TextDecoder().decode(s.messages[0]);assert.ok(text.includes('https://zaexa.com'));assert.ok(text.includes(s.acc.address));assert.match(text,/No transaction\. No network fee\. No permission to spend funds\./);
});
test('remembered wallet never restores connected state on page load',async()=>{
 const s=setup();s.c.solLastWalletName=s.wallet.name;await s.c.solMaybeSilentConnect(s.wallet);assert.equal(s.c.solAccount,null);assert.equal(s.messages.length,0);
});
test('account removed during approval cannot connect',async()=>{
 const s=setup();s.setApproval(async message=>{s.wallet.accounts=[];return {account:s.acc,signedMessage:message,signature:nacl.sign.detached(message,s.kp.secretKey)};});
 await s.c.solConnectWallet(s.wallet);assert.equal(s.c.solAccount,null);assert.match(s.c.notice,/account changed/);
});
test('switching wallet account retires the approved connection',async()=>{
 const s=setup();let handler;s.wallet.features['standard:events']={on:(name,fn)=>{handler=fn;return ()=>{};}};
 await s.c.solConnectWallet(s.wallet);assert.ok(s.c.solAccount);handler({accounts:[{address:'different',publicKey:new Uint8Array(32)}]});assert.equal(s.c.solAccount,null);
});
