import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Run the real index.html functions in a vm with stubbed page state.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
function context(names, extras = {}) {
  const elements = new Map();
  const ctx = vm.createContext({
    console, URLSearchParams, Uint8Array, Date, Math, BigInt, Number, String, Array, isFinite,
    setTimeout: () => 1, clearTimeout: () => {},
    $: id => {
      if (!elements.has(id)) elements.set(id, { value: '', textContent: '', hidden: false, disabled: false, style: {}, appendChild() {}, classList: { remove() {}, add() {} } });
      return elements.get(id);
    },
    SOL_MINT_ADDR: SOL, SOL_MINT_RE: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, SOL_APP_TOKENS: { USDC },
    solSide: 'buy', solMode: 'exactIn', solMintCur: JUP, solTokenDecimals: 6, solTokenSymbol: 'JUP',
    solRefMint: SOL, solRefDecimals: 9, solRefSymbol: 'SOL', solRefVerdict: null, solBalRef: null, solRefAtaExists: null,
    solBalSol: null, solBalTok: null, solOutAtaExists: null, solAccount: { address: 'w' }, solBalanceSeq: 0, solBalanceKey: null,
    solTokenSeq: 0, solVerdictV: null, solVerdictWhy: null, solRefVerdictWhy: null, SOL_UNCONF: 'sol:unconfirmed', solArmedMints: new Set(), solRenderVenues() {}, solDirectQuote: null, SOL_PRIO_FEE_RESERVE: 0.0002, slippageBps: 50,
    solPaintLegs() {}, solSetReference: async () => {}, activeChain: "base", view: "swap", solOnAmtInput() {}, solPaintBalance() {}, solPaintFeeRows() {}, solSwapApplyGate() {}, solRenderReadout() {}, solUpdateSwapBtn() {},
    ...extras,
  });
  const all = [...new Set(['solInputMint', 'solOutputMint', 'solInputDecimals', 'solOutputDecimals', 'solAmountRaw', 'solFormatUnits', 'solNeedsArm', ...names])];
  for (const name of all) {
    const match = new RegExp(`(?:async )?function ${name}\\(`).exec(html);
    assert.ok(match, `missing ${name}`);
    vm.runInContext(html.slice(match.index, html.indexOf('\n}', match.index) + 2), ctx);
  }
  return ctx;
}
const FRAC = ['setSolPayFraction', 'solSpendableTop', 'solReserveSol', 'solMaxSolAmount'];

// ---- 1: MAX / 50% floor to token decimals ----
test('MAX on a 9-decimal token keeps every digit and never rounds up', () => {
  const c = context(FRAC, { solSide: 'sell', solTokenDecimals: 9, solBalTok: 1.123456789 });
  c.setSolPayFraction(1, 1);
  assert.equal(c.$('solAmt').value, '1.123456789');
});
test('50% floors instead of rounding half up', () => {
  const c = context(FRAC, { solSide: 'sell', solTokenDecimals: 6, solBalTok: 0.000003 });
  c.setSolPayFraction(1, 2);
  assert.equal(c.$('solAmt').value, '0.000001');
});
test('SOL input keeps the native reserve and floors to lamports', () => {
  const c = context(FRAC, { solSide: 'buy', solBalSol: 1.123456789, solOutAtaExists: true });
  c.setSolPayFraction(1, 1);
  assert.equal(c.$('solAmt').value, '1.123246789');   // 1.123456789 - (0.0002 + 0.00001)
  c.setSolPayFraction(1, 3);
  assert.equal(c.$('solAmt').value, '0.374415596');   // floor((1123246789)/3) lamports
});

// ---- 2: native SOL as the token leg ----
test('native SOL token leg uses the native balance, with the reserve, not a wSOL lookup', async () => {
  const methods = [];
  const c = context(['solRefreshBalances', 'solSpendableTop', 'solReserveSol', 'solMaxSolAmount', 'solBudgetCheck', 'solRequiredInput'], {
    solMintCur: SOL, solRefMint: JUP, solRefDecimals: 6, solSide: 'sell', solTokenDecimals: 9,
    solRpcCall: async (m, params) => {
      methods.push(m + ':' + (params[1]?.mint || ''));
      return m === 'getBalance' ? { value: 2000000000 } : { value: [] };
    },
  });
  await c.solRefreshBalances();
  assert.equal(c.solBalSol, 2);
  assert.equal(c.solBalTok, 2);
  assert.ok(!methods.includes('getTokenAccountsByOwner:' + SOL), 'must not look up a wSOL token account');
  const spendable = c.solSpendableTop();
  assert.ok(spendable < 2 && spendable > 1.99, 'native reserve must be held back, got ' + spendable);
});
test('swap button blocks spending more native SOL than balance minus reserve (SOL as token leg)', () => {
  const names = ['solUpdateSwapBtn', 'solSpendableTop', 'solReserveSol', 'solMaxSolAmount', 'solBudgetCheck', 'solRequiredInput'];
  const mk = spend => context(names, {
    solMintCur: SOL, solRefMint: JUP, solSide: 'sell', solTokenDecimals: 9, solRefDecimals: 6, solBalSol: 2, solBalTok: 2,
    solRefAtaExists: true, solSwapBusy: false, tokenPage: false, solConnectionBusy: false,
    solQuote: { inAmount: String(spend), swapMode: 'ExactIn' },
  });
  const over = mk(1999900000);                 // within balance, but inside the reserve
  over.solUpdateSwapBtn();
  assert.equal(over.$('solSwapBtn').disabled, true);
  const fine = mk(1000000000);
  fine.solUpdateSwapBtn();
  assert.equal(fine.$('solSwapBtn').textContent, 'Swap');
});

// ---- 4: one-sided share links ----
async function share(query) {
  const loads = [], refs = [], notes = [];
  const c = context(['solApplyShare'], {
    setChain() {}, solAppDefaulted: false, solPaintLegs() {}, solScheduleQuote() {},
    note: (t, x) => x, solSetNotice: x => notes.push(x),
    solAppLoadToken: async m => { loads.push(m); }, solSetReference: async m => { refs.push(m); },
  });
  await c.solApplyShare(new URLSearchParams(query));
  return { token: loads[0], ref: refs[0], side: c.solSide, notes };
}
test('share link with only in=USDC defaults out to SOL', async () => {
  const r = await share('in=' + USDC);
  assert.equal(r.ref, SOL); assert.equal(r.token, USDC); assert.equal(r.side, 'sell');
});
test('share link with only in=SOL defaults out to USDC', async () => {
  const r = await share('in=' + SOL);
  assert.equal(r.token, USDC); assert.equal(r.ref, SOL); assert.equal(r.side, 'buy');
});
test('share link with only out=SOL defaults in to USDC; only out=USDC defaults in to SOL', async () => {
  let r = await share('out=' + SOL);
  assert.equal(r.token, USDC); assert.equal(r.side, 'sell');
  r = await share('out=' + USDC);
  assert.equal(r.token, USDC); assert.equal(r.ref, SOL); assert.equal(r.side, 'buy');
});
test('share link with neither side keeps SOL -> USDC; equal sides are an invalid pair', async () => {
  let r = await share('');
  assert.equal(r.token, USDC); assert.equal(r.side, 'buy');
  r = await share('in=' + JUP + '&out=' + JUP);
  assert.match(r.notes[0], /invalid token pair/);
  assert.equal(r.token, undefined);
});

// ---- 5: price impact colour ----
function readout(impact) {
  const c = context(['solRenderReadout'], {
    solQuote: { inAmount: '1000000000', outAmount: '1000000', otherAmountThreshold: '990000', priceImpactPct: impact },
    solRouteLabel: () => 'r', solRenderRouteBar() {},
  });
  c.solRenderReadout();
  return [c.$('solImpactF').textContent, c.$('solImpactF').style.color];
}
test('Solana price impact: >=1.5 warns, >=5 is bad, like Base', () => {
  assert.deepEqual(readout('0.0149'), ['1.49%', '']);
  assert.deepEqual(readout('0.015'), ['1.50%', 'var(--warn)']);
  assert.deepEqual(readout('0.05'), ['5.00%', 'var(--neg)']);
});
test('missing price impact shows a dash with no colour', () => {
  for (const v of [null, undefined, '', 'abc']) assert.deepEqual(readout(v), ['—', '']);
});

// ---- 6: decimals fallback ----
function loader(metaFor, decimalsFor) {
  const repaints = [];
  const c = context(['solAppLoadToken'], {
    SOL_APP_TOKEN_LIST: [], solCloseTokenPicker() {}, solSwapReset(m) { c.solMintCur = m; c.solTokenDecimals = null; ++c.solTokenSeq; },
    renderSolExit() {}, solPaintSellPill() {}, renderSolStats() {}, solLoadChart() {}, solLoadDetails() {},
    fetchSolMeta: async m => metaFor(m), fetchVdVerdict: async () => ({ v: 'sell' }), solReadMintDecimals: m => decimalsFor(m),
    solRenderReadout() { repaints.push(c.solTokenDecimals); },
  });
  return { c, repaints };
}
test('missing GeckoTerminal decimals fall back to the chain and repaint the readout', async () => {
  const { c, repaints } = loader(() => ({ symbol: 'X' }), async () => 6);
  await c.solAppLoadToken(JUP);
  await new Promise(r => setImmediate(r));
  assert.equal(c.solTokenDecimals, 6);
  assert.deepEqual(repaints, [6]);
});
test('a stale on-chain decimals result never repaints a newer token', async () => {
  let release;
  const slow = new Promise(r => { release = r; });
  const { c, repaints } = loader(m => ({ symbol: m === JUP ? 'A' : 'B', ...(m === USDC ? { decimals: 6 } : {}) }), () => slow);
  await c.solAppLoadToken(JUP);
  await c.solAppLoadToken(USDC);
  release(9);
  await new Promise(r => setImmediate(r));
  assert.equal(c.solTokenDecimals, 6);
  assert.deepEqual(repaints, []);
});

// ---- 7: ExactOut fill is a plain number ----
test('ExactOut writes a plain number string into the pay field', async () => {
  const c = context(['solFetchQuote'], {
    solMode: 'exactOut', solQuoteSeq: 0, solQuote: null, solQuoteAt: 0, location: { origin: 'https://x.test' },
    withTimeout: p => p, ev() {}, solCompareDirect() {}, solSetNotice() {}, note: (t, x) => x,
    fetch: async () => ({ ok: true, json: async () => ({ inAmount: '1234567890123', outAmount: '1000000', otherAmountThreshold: '1', priceImpactPct: '0' }) }),
  });
  c.$('solOutRead').value = '1';
  await c.solFetchQuote();
  assert.equal(c.$('solAmt').value, '1234.567890123');
  assert.ok(!/[,\s]/.test(c.$('solAmt').value));
});
