import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Run the actual browser functions with controlled network completion order.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function context(names, extras = {}) {
  const elements = new Map();
  const ctx = vm.createContext({
    console, URLSearchParams, Uint8Array, Date, Math, BigInt,
    setTimeout: () => 1, clearTimeout: () => {},
    $: id => {
      if (!elements.has(id)) elements.set(id, { value: '', textContent: '', hidden: false, appendChild() {}, style: {}, classList: { remove() {} } });
      return elements.get(id);
    },
    solQuote: { inAmount: '1000000000' }, solQuoteSeq: 0, solQuoteAt: Date.now(),
    solQuoteTimer: null, solMode: 'exactIn', solSide: 'buy', solMintCur: 'mintA',
    solTokenDecimals: 6, solAccount: { address: 'walletA', publicKey: new Uint8Array(32) },
    solWalletApi: {}, solBalanceSeq: 0, solBalanceKey: null, solTokenSeq: 0, solIntentSeq: 0, activeChain: 'solana', view: 'swap',
    SOL_MINT_ADDR:"SOL",solRefMint:"SOL",solRefDecimals:9,solRefSymbol:"SOL",solRefVerdict:null,solBalRef:null,solRefAtaExists:null,
    solCompareDirect(){},ev(){},solLoadDetails(){},solLoadChart(){},
    solConnectionBusy:false,solPendingWallet:null,solConfirmConnection:async()=>{},
    note:(type,text)=>text,isUserRejection:()=>false,esc:s=>s,
    solBalSol: null, solBalTok: null, solOutAtaExists: null, slippageBps: 50, solSimFailedKey: null, solSimArmedKey: null,
    solRenderReadout() {}, solUpdateSwapBtn() {}, solPaintLegs() {}, solPaintBalance() {},
    solPaintFeeRows() {}, solSwapApplyGate() {}, solFetchQuote() {}, solSetNotice() {}, hideDoneBlock() {},
    ...extras,
  });
  for (const name of [...new Set(["solInputMint","solOutputMint","solInputDecimals","solOutputDecimals","solAmountRaw","solImpactKey",...names])]) {
    const match = new RegExp(`(?:async )?function ${name}\\(`).exec(html);
    assert.ok(match, `missing ${name}`);
    const end = html.indexOf('\n}', match.index);
    vm.runInContext(html.slice(match.index, end + 2), ctx);
  }
  return ctx;
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('editing amount immediately retires the old quote before debounce', () => {
  const c = context(['solScheduleQuote', 'solInvalidateQuote']);
  c.solScheduleQuote();
  assert.equal(c.solQuote, null);
  assert.equal(c.solQuoteSeq, 1);
});

test('flipping direction retires an outstanding quote request', () => {
  const c = context(['solOnSideChange', 'solInvalidateQuote']);
  c.solOnSideChange();
  assert.equal(c.solQuoteSeq, 1);
  assert.equal(c.solQuote, null);
});

test('late balances from a previous account cannot overwrite current balances', async () => {
  const old = deferred();
  const c = context(['solRefreshBalances'], {
    solRpcCall: async (method, params) => {
      if (params[0] === 'walletA') return old.promise;
      return method === 'getBalance' ? { value: 2000000000 } : { value: [] };
    },
  });
  const pending = c.solRefreshBalances();
  c.solAccount = { address: 'walletB' };
  await c.solRefreshBalances();
  old.resolve({ value: 9000000000 });
  await pending;
  assert.equal(c.solBalSol, 2);
});

test('disconnect while fetching balances leaves balances cleared', async () => {
  const old = deferred();
  const c = context(['solRefreshBalances'], { solRpcCall: () => old.promise });
  const pending = c.solRefreshBalances();
  c.solAccount = null;
  old.resolve({ value: 9000000000 });
  await pending;
  assert.equal(c.solBalSol, null);
  assert.equal(c.solBalTok, null);
});

test('late token metadata cannot replace a newer token selection', async () => {
  const old = deferred();
  const c = context(['solAppLoadToken'], {
    SOL_MINT_RE: /./, SOL_APP_TOKEN_LIST: [], solCloseTokenPicker() {},
    solSwapReset(mint) { c.solMintCur = mint; ++c.solTokenSeq; },
    renderSolExit() {}, solPaintSellPill() {}, renderSolStats() {}, solLoadChart() {},
    fetchSolMeta: mint => mint === 'mintA' ? old.promise : Promise.resolve({ symbol: 'B', decimals: 6 }),
    fetchVdVerdict: async () => ({ v: 'sell' }),
  });
  const pending = c.solAppLoadToken('mintA');
  await c.solAppLoadToken('mintB');
  old.resolve({ symbol: 'A', decimals: 9 });
  await pending;
  assert.equal(c.solTokenSymbol, 'B');
  assert.equal(c.solTokenDecimals, 6);
});

test('changing amount during transaction build prevents wallet handoff', async () => {
  const build = deferred();
  const c = context(['solBuildFreshTx', 'solSwapContext', 'solAssertSwapContext'], {
    location: { origin: 'https://example.test' }, fetch: () => build.promise,
    withTimeout: p => p, solB64ToBytes: () => new Uint8Array(32),
    solParseFeePayer: () => new Uint8Array(32), solBytesEq: () => true,
    solRpcCall: async () => ({ value: { err: null } }),
  });
  c.$('solAmt').value = '1';
  const pending = c.solBuildFreshTx(null);
  c.$('solAmt').value = '2';
  build.resolve({ ok: true, json: async () => ({ swapTransaction: 'test' }) });
  await assert.rejects(pending, /changed/i);
});

test('an old quote arriving within the debounce window stays discarded', async () => {
  const quote = deferred();
  const c = context(['solFetchQuote', 'solScheduleQuote', 'solInvalidateQuote'], {
    SOL_MINT_ADDR: 'SOL', location: { origin: 'https://example.test' },
    withTimeout: p => p, fetch: () => quote.promise,
  });
  c.$('solAmt').value = '1';
  const pending = c.solFetchQuote();
  c.$('solAmt').value = '2';
  c.solScheduleQuote();
  quote.resolve({ ok: true, json: async () => ({ inAmount: '1000000000' }) });
  await pending;
  assert.equal(c.solQuote, null);
});

test('unchanged swap still builds successfully', async () => {
  const c = context(['solBuildFreshTx', 'solSwapContext', 'solAssertSwapContext'], {
    location: { origin: 'https://example.test' },
    fetch: async () => ({ ok: true, json: async () => ({ swapTransaction: 'test' }) }),
    withTimeout: p => p, solB64ToBytes: () => new Uint8Array(32),
    solParseFeePayer: () => new Uint8Array(32), solBytesEq: () => true,
    solRpcCall: async () => ({ value: { err: null } }),
  });
  c.$('solAmt').value = '1';
  assert.equal((await c.solBuildFreshTx(null)).swapTxB64, 'test');
});

test('changing wallet during simulation cancels the prepared transaction', async () => {
  const simulation = deferred();
  const started = deferred();
  const c = context(['solBuildFreshTx', 'solSwapContext', 'solAssertSwapContext'], {
    location: { origin: 'https://example.test' },
    fetch: async () => ({ ok: true, json: async () => ({ swapTransaction: 'test' }) }),
    withTimeout: p => p, solB64ToBytes: () => new Uint8Array(32),
    solParseFeePayer: () => new Uint8Array(32), solBytesEq: () => true,
    solRpcCall: () => { started.resolve(); return simulation.promise; },
  });
  const pending = c.solBuildFreshTx(null);
  await started.promise;
  c.solAccount = { address: 'walletB' };
  simulation.resolve({ value: { err: null } });
  await assert.rejects(pending, /changed/i);
});

test('remembered wallet permission never triggers a silent connection', async () => {
  let calls=0;
  const c=context(['solMaybeSilentConnect'],{solAccount:null,solLastWalletName:'Fake',solWalletOff:()=>false});
  await c.solMaybeSilentConnect({name:'Fake',features:{'standard:connect':{connect:async()=>{++calls;return {accounts:[{address:'walletA'}]};}}}});
  assert.equal(calls,0);
  assert.equal(c.solAccount,null);
});

test('explicit reconnect waits for the previous wallet disconnect to finish', async () => {
  const disconnect=deferred();let calls=0;
  const c=context(['solConnectWallet'],{solDisconnectPending:disconnect.promise,solWalletConnectSeq:0,
    solSetWalletOff(){},solSubscribeWalletEvents(){},solPaintWallet(){},solRefreshBalances(){},solScheduleQuote(){},
    solAccount:null,solWalletApi:null});
  const wallet={name:'Fake',features:{'standard:connect':{connect:async()=>{++calls;return {accounts:[{address:'walletA'}]};}}}};
  const pending=c.solConnectWallet(wallet);
  await Promise.resolve();assert.equal(calls,0);
  disconnect.resolve();await pending;
  assert.equal(calls,1);assert.equal(c.solAccount.address,'walletA');
});

test('wallet-originated disconnect does not call disconnect recursively', () => {
  let calls = 0;
  const c = context(['solDisconnectWallet', 'solInvalidateQuote'], {
    solWalletConnectSeq: 0, solEventsUnsub: null, solSetWalletOff() {}, solPaintWallet() {},
    solWalletApi: { features: { 'standard:disconnect': { disconnect() { ++calls; } } } },
  });
  c.solDisconnectWallet(false);
  assert.equal(calls, 0);
  assert.equal(c.solAccount, null);
});

test('resetting token does not unlock a wallet request already in progress', () => {
  const c = context(['solSwapReset', 'solInvalidateQuote'], {
    solSwapBusy: true, solAccount: null, solPaintSellPill() {}, solPaintWallet() {},
  });
  c.solSwapReset('mintB');
  assert.equal(c.solSwapBusy, true);
  assert.equal(c.solMintCur, 'mintB');
});

test('token page with missing metadata still initializes the wallet', async () => {
  let initialized = false;
  const c = context(['openSolanaTokenPage'], {
    SOL_APP_TOKEN_LIST: [], shortAddr: s => s, solTokenUrl: s => s,
    paintSolAvatar() {}, paintReportNetwork() {}, paintWallet() {}, renderRoundTrip() {}, ev() {}, renderSolStats() {},
    renderSolExit() {}, solPaintSellPill() {}, solTryAutoRestoreName() {},
    solWalletStandardInit() { initialized = true; },
    solSwapReset(mint) { c.solMintCur = mint; ++c.solTokenSeq; },
    fetchSolMeta: async () => null, fetchVdVerdict: async () => ({ v: null }),
  });
  await c.openSolanaTokenPage('mintA');
  assert.equal(c.solTokenSymbol, 'Unknown');
  assert.equal(initialized, true);
});

test('same-account balance refresh preserves a known low balance until its response', async () => {
  const balance = deferred();
  const c = context(['solRefreshBalances'], {
    solBalanceKey: 'walletA:mintA:SOL', solBalSol: 0.0001,
    solRpcCall: method => method === 'getBalance' ? balance.promise : Promise.resolve({ value: [] }),
  });
  const pending = c.solRefreshBalances();
  assert.equal(c.solBalSol, 0.0001);
  balance.resolve({ value: 2000000000 });
  await pending;
  assert.equal(c.solBalSol, 2);
});

test('token amounts preserve integers above the floating-point safe range',()=>{
  const c=context([]);
  assert.equal(c.solAmountRaw('9007199254.740993',6),9007199254740993n);
  assert.equal(c.solAmountRaw('0.0000001',6),null);
  assert.equal(c.solAmountRaw('1e3',6),null);
  assert.equal(c.solAmountRaw('0.000001',6),1n);
});
test('ExactOut budget uses the maximum input threshold',()=>{
  const c=context(['solRequiredInput'],{solSide:'sell',solTokenDecimals:6,solQuote:{swapMode:'ExactOut',inAmount:'1000000',otherAmountThreshold:'1100000'}});
  assert.equal(c.solRequiredInput(),1.1);
});
test('selecting a pay token on a reversed pair retains direction',async()=>{
  const c=context(['solSelectToken'],{solPickerLeg:'token',solSide:'sell',solCloseTokenPicker(){},solOnSideChange(){},solAppLoadToken:async()=>{c.solSide='buy';}});
  await c.solSelectToken('anotherMint');assert.equal(c.solSide,'sell');
});
test('Solana sharing preserves both mints and ExactOut mode',()=>{
  const c=context(['solShareUrl'],{solRefMint:'USDCmint',solMintCur:'CaseSensitiveMint',solMode:'exactOut',location:{origin:'https://zaexa.test'}});
  c.$('solOutRead').value='1.25';
  const params=new URLSearchParams(c.solShareUrl().split('?')[1]);
  assert.equal(params.get('chain'),'solana');assert.equal(params.get('in'),'USDCmint');
  assert.equal(params.get('out'),'CaseSensitiveMint');assert.equal(params.get('mode'),'exactOut');assert.equal(params.get('amt'),'1.25');
});
