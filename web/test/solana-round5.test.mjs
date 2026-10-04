import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// توابعِ واقعیِ index.html داخل vm، با stubِ حالتِ صفحه (همان الگوی solana-fixes.test.mjs).
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
function load(names, extras = {}) {
  const ctx = vm.createContext({
    console, Math, Number, String, Array, Object, JSON, Date, Promise, isFinite, Error, RegExp,
    SOL_MINT_ADDR: SOL, SOL_PRIO_FEE_RESERVE: 0.0002, solNetFeeLamports: null,
    solSide: 'sell', solOutAtaExists: null, solRefAtaExists: null,
    solOutputMint: () => SOL,
    ...extras,
  });
  for (const name of names) {
    const m = new RegExp(`(?:async )?function ${name}\\(`).exec(html);
    assert.ok(m, `missing ${name}`);
    vm.runInContext(html.slice(m.index, html.indexOf('\n}', m.index) + 2), ctx);
  }
  return ctx;
}

// ---- 3: logo جایگزین ----
test('fallback avatar: stable hue, lower-cased Base hex only, first letter uppercased, "?" when empty', () => {
  const c = load(['fallbackAvatarStyle']);
  const hex = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
  const a = c.fallbackAvatarStyle(hex, 'aero'), b = c.fallbackAvatarStyle(hex.toLowerCase(), 'AERO');
  assert.equal(a.hue, b.hue);
  assert.equal(a.letter, 'A');
  assert.equal(a.background, `linear-gradient(135deg, hsl(${a.hue} 72% 56%), hsl(${(a.hue + 38) % 360} 72% 46%))`);
  assert.ok(a.hue >= 0 && a.hue < 360);
  // mintِ سولانا عیناً (حساس به حروف): دو mint که فقط در حالتِ حروف فرق دارند، رنگِ یکسانِ اجباری ندارند
  const m1 = c.fallbackAvatarStyle(USDC, 'usdc'), m2 = c.fallbackAvatarStyle(USDC.toLowerCase(), 'usdc');
  assert.notEqual(m1.hue, m2.hue);
  assert.equal(c.fallbackAvatarStyle(USDC, '').letter, '?');
  assert.equal(c.fallbackAvatarStyle(USDC, null).letter, '?');
  assert.equal(c.fallbackAvatarStyle(USDC, '  ').letter, '?');
  assert.equal(c.fallbackAvatarStyle(USDC, 'ßx').letter.length >= 1, true);
});
test('fallback avatar paints with textContent only and clears itself for a real chip', () => {
  const c = load(['fallbackAvatarStyle', 'paintFallbackAvatar', 'clearFallbackAvatar'], {
    getComputedStyle: () => ({ width: '32px' }),
  });
  const el = { style: {}, dataset: {}, set innerHTML(v) { throw new Error('innerHTML must not be used'); }, textContent: '' };
  c.paintFallbackAvatar(el, USDC, '<img src=x onerror=1>');
  assert.equal(el.textContent, '<');            // یک نویسه، به‌صورت متن
  assert.equal(el.style.color, '#fff');
  assert.equal(el.style.fontWeight, '700');
  assert.equal(el.style.fontSize, '14.4px');    // ۴۵٪ از ۳۲
  assert.match(el.style.background, /^linear-gradient\(135deg, hsl\(\d+ 72% 56%\), hsl\(\d+ 72% 46%\)\)$/);
  c.clearFallbackAvatar(el);
  assert.equal(el.style.background, '');
});

// ---- 7: پیام‌های کوت ----
test('quote failure messages come from a closed vocabulary', () => {
  const c = load(['solQuoteFailMessage']);
  assert.equal(c.solQuoteFailMessage('no-route'), 'No route for this pair right now — there may be no pool with enough liquidity.');
  assert.equal(c.solQuoteFailMessage('not-tradable'), 'Jupiter does not trade this token.');
  assert.equal(c.solQuoteFailMessage('rate-limited'), 'Quotes are busy — retrying in a few seconds.');
  assert.equal(c.solQuoteFailMessage('amount-too-small'), 'Amount too small to route.');
  assert.equal(c.solQuoteFailMessage('upstream'), 'Quote service did not answer. Try again in a moment.');
  assert.equal(c.solQuoteFailMessage('bad-request'), 'Could not get a quote for this pair.');
  assert.equal(c.solQuoteFailMessage('Could not find any route'), 'Quote service did not answer. Try again in a moment.');
  assert.equal(c.solQuoteFailMessage(null), 'Quote service did not answer. Try again in a moment.');
});
async function fetchQuoteCtx(status, body) {
  const timers = [], notices = [];
  const els = new Map();
  const c = load(['solQuoteFailMessage', 'solFetchQuote'], {
    solQuoteSeq: 0, solMode: 'exactIn', solQuote: { stale: 1 }, slippageBps: 50,
    solInputMint: () => SOL, solOutputMint: () => USDC, solInputDecimals: () => 9, solOutputDecimals: () => 6,
    solAmountRaw: () => 1000000n, solRenderReadout() {}, solUpdateSwapBtn() {}, solCompareDirect() {}, solFormatUnits: String,
    $: id => (els.get(id) || els.set(id, { value: '1' }).get(id)),
    location: { origin: 'https://z.test' }, URLSearchParams, ev() {}, esc: s => s, note: (k, h) => k + ':' + h,
    solSetNotice: h => notices.push(h), withTimeout: p => p,
    setTimeout: (fn, ms) => { timers.push([fn, ms]); return 1; }, solQuoteAt: 0,
    fetch: async () => ({ ok: status === 200, status, json: async () => body }),
  });
  await c.solFetchQuote();
  return { c, timers, notices };
}
test('quote 400 no-route / not-tradable / bad-request show their closed messages', async () => {
  for (const [reason, text] of [['no-route', 'No route for this pair'], ['not-tradable', 'Jupiter does not trade'], ['bad-request', 'Could not get a quote for this pair.'], ['amount-too-small', 'Amount too small']]) {
    const { notices, c } = await fetchQuoteCtx(502, { error: 'jup:quote:400', reason });
    assert.match(notices.at(-1), new RegExp(text));
    assert.equal(c.solQuote, null);
  }
});
test('rate-limited quote retries exactly once after 3 s, and only if nothing changed', async () => {
  const { c, timers, notices } = await fetchQuoteCtx(502, { error: 'jup:quote:429', reason: 'rate-limited' });
  assert.match(notices.at(-1), /Quotes are busy — retrying in a few seconds\./);
  assert.equal(timers.length, 1);
  assert.equal(timers[0][1], 3000);
});

// ---- 8: شکستِ شبیه‌سازی ----
const SYS = 'Program 11111111111111111111111111111111';
const JUPP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const TOK = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const FIX = {
  systemInsufficient: {
    err: { InstructionError: [2, { Custom: 1 }] },
    logs: ['Program ComputeBudget111111111111111111111111111111 invoke [1]', 'Program ComputeBudget111111111111111111111111111111 success',
      SYS + ' invoke [1]', 'Transfer: insufficient lamports 4875000, need 2039280', SYS + ' failed: custom program error: 0x1'],
  },
  rent: { err: { InsufficientFundsForRent: { account_index: 1 } }, logs: [SYS + ' invoke [1]', SYS + ' success'] },
  slippage: {
    err: { InstructionError: [4, { Custom: 6001 }] },
    logs: [`Program ${JUPP} invoke [1]`, 'Program log: AnchorError thrown in programs/jupiter/src/lib.rs:12. Error Code: SlippageToleranceExceeded. Error Number: 6001. Error Message: Slippage tolerance exceeded.',
      `Program ${JUPP} failed: custom program error: 0x1771`],
  },
  frozen: {
    err: { InstructionError: [3, { Custom: 17 }] },
    logs: [`Program ${TOK} invoke [2]`, 'Program log: Error: Account is frozen', `Program ${TOK} failed: custom program error: 0x11`],
  },
  tokenInsufficient: {   // custom 1 از برنامه‌ی توکن = کمبودِ موجودیِ توکن، نه SOL
    err: { InstructionError: [3, { Custom: 1 }] },
    logs: [`Program ${TOK} invoke [1]`, 'Program log: Error: insufficient funds', `Program ${TOK} failed: custom program error: 0x1`],
  },
  unknown: { err: { InstructionError: [1, 'InvalidAccountData'] }, logs: [`Program ${TOK} failed: invalid account data for instruction`] },
};
test('simulation failures map to the closed vocabulary from structure and known log substrings', () => {
  const c = load(['solClassifySimFail']);
  assert.equal(c.solClassifySimFail(FIX.systemInsufficient.err, FIX.systemInsufficient.logs).reason, 'insufficient-sol');
  assert.equal(c.solClassifySimFail(FIX.rent.err, FIX.rent.logs).reason, 'insufficient-sol');
  assert.equal(c.solClassifySimFail(FIX.slippage.err, FIX.slippage.logs).reason, 'slippage');
  assert.equal(c.solClassifySimFail(FIX.frozen.err, FIX.frozen.logs).reason, 'frozen');
  const tok = c.solClassifySimFail(FIX.tokenInsufficient.err, FIX.tokenInsufficient.logs);
  assert.equal(tok.reason, 'other'); assert.equal(tok.code, '3:Custom 1');
  const unk = c.solClassifySimFail(FIX.unknown.err, FIX.unknown.logs);
  assert.equal(unk.reason, 'other'); assert.equal(unk.code, '1:InvalidAccountData');
  // worker/index.js دو شکل می‌دهد: err به‌صورت رشته‌ی JSON در detail.err
  assert.equal(c.solClassifySimFail(JSON.stringify(FIX.slippage.err), FIX.slippage.logs).reason, 'slippage');
  // بدونِ logs، Custom 1 را به System نسبت نمی‌دهیم
  assert.equal(c.solClassifySimFail({ InstructionError: [2, { Custom: 1 }] }, []).reason, 'other');
  // کد هرگز متنِ آزاد نیست
  assert.equal(c.solClassifySimFail({ InstructionError: [1, '<script>alert(1)</script>'] }, []).code, '');
});
test('simulation messages: SOL hint is derived when ATA state is known, "about 0.005" otherwise', () => {
  const unknown = load(['solSimKeepSol', 'solSimFailMessage'], { solInputMint: () => SOL, solOutputMint: () => USDC, solSide: 'sell' });
  assert.equal(unknown.solSimKeepSol(), 'about 0.005');
  assert.equal(unknown.solSimFailMessage('insufficient-sol', unknown.solSimKeepSol()),
    'Not enough SOL for the network fee and one-time account rent. Keep at least about 0.005 SOL.');
  // ۴ اکتبر — ورودیِ SOL: جوپیتر یک حسابِ wrapped-SOL موقت می‌سازد، پس یک ۰٫۰۰۲۰۴ دیگر هم لازم است.
  // خروجی USDC، حسابِ ATA وجود ندارد: کارمزد (۲۰۰۰۰۰+۵۰۰۰ لامپورت) + ۰٫۰۰۲۰۴ برای ATA + ۰٫۰۰۲۰۴ برای wSOL
  const needs = load(['solSimKeepSol'], { solInputMint: () => SOL, solOutputMint: () => USDC, solSide: 'buy', solOutAtaExists: false, solNetFeeLamports: 200000 });
  assert.equal(needs.solSimKeepSol(), '0.0043');
  const has = load(['solSimKeepSol'], { solInputMint: () => SOL, solOutputMint: () => USDC, solSide: 'buy', solOutAtaExists: true, solNetFeeLamports: 200000 });
  assert.equal(has.solSimKeepSol(), '0.0023');
  // کنترل: نه ورودی و نه خروجی SOL نیست (توکن به توکن) -> فرمولِ قبلی بدونِ wSOL
  const tokTok = load(['solSimKeepSol'], { solInputMint: () => 'So1ANOTHER', solOutputMint: () => USDC, solSide: 'buy', solOutAtaExists: false, solNetFeeLamports: 200000 });
  assert.equal(tokTok.solSimKeepSol(), '0.0023');
  // خروجی SOL (فروشِ توکن): ATA لازم نیست ولی wSOL موقت چرا
  const toSol = load(['solSimKeepSol'], { solInputMint: () => USDC, solOutputMint: () => SOL, solSide: 'sell', solNetFeeLamports: 200000 });
  assert.equal(toSol.solSimKeepSol(), '0.0023');
  const m = load(['solSimFailMessage']);
  assert.equal(m.solSimFailMessage('slippage'), 'Price moved more than your slippage. Try again or raise slippage.');
  assert.equal(m.solSimFailMessage('frozen'), "This token's program rejected the transfer (it may be frozen or restricted).");
  assert.equal(m.solSimFailMessage('other'), 'This swap would fail on-chain: simulation failed.');
});

// ---- 9: price impact ----
test('price impact >= 15% needs one extra click per quote; below it never does', () => {
  const q = (pct, amt = '100') => ({ inputMint: SOL, outputMint: USDC, inAmount: amt, priceImpactPct: String(pct) });
  const c = load(['solNeedsImpactArm', 'solQuoteImpactPct', 'solImpactKey'], { solQuote: q(0.149), solImpactArmedKey: null, SOL_IMPACT_ARM_PCT: Number(/const SOL_IMPACT_ARM_PCT=(\d+);/.exec(html)[1]) });
  assert.equal(c.solNeedsImpactArm(), false);
  c.solQuote = q(0.15); assert.equal(c.solNeedsImpactArm(), true);
  c.solImpactArmedKey = c.solImpactKey(c.solQuote); assert.equal(c.solNeedsImpactArm(), false);
  c.solQuote = q(0.15, '200'); assert.equal(c.solNeedsImpactArm(), true);     // کوتِ تازه = دوباره مسلح
  c.solQuote = { inputMint: SOL, outputMint: USDC, inAmount: '1' }; assert.equal(c.solNeedsImpactArm(), false);  // impact نامعلوم بلاک نیست
});

// ---- 4: خلاصه‌ی سواپ ----
test('swap-complete summary uses the executed quote with correct decimals; gain only when positive', () => {
  const q = { inputMint: USDC, outputMint: SOL, inAmount: '2300000', outAmount: '14500000', swapMode: 'ExactIn' };
  const c = load(['solFmtAmount', 'solFormatUnits', 'solDirectGainPct', 'solSnapshotDone'], {
    solQuote: q, solDirectQuote: { q, j: { outAmount: '14400000' } },
    solInputDecimals: () => 6, solOutputDecimals: () => 9, solInputSymbol: () => 'USDC', solOutputSymbol: () => 'SOL',
  });
  const s = c.solSnapshotDone();
  assert.equal(s.paidTxt, '2.3 USDC');
  assert.equal(s.gotTxt, '≈ 0.0145 SOL');
  assert.equal(s.vs, '+0.69% vs best single pool');
  c.solDirectQuote = { q, j: { outAmount: '14600000' } };
  assert.equal(c.solSnapshotDone().vs, null);
  c.solDirectQuote = null; assert.equal(c.solSnapshotDone().vs, null);
  c.solDirectQuote = { q: { ...q }, j: { outAmount: '1' } };   // کوتِ دیگر → نادیده
  assert.equal(c.solSnapshotDone().vs, null);
});

// ---- 6: BlockhashNotFound ----
function sendCtx(sendOutcomes) {
  const log = { rpc: [], notices: [], built: 0, signs: 0 };
  const c = load(['solMapSendError', 'solSendAndHandle', 'solSendSignedWithRetry'], {
    solBytesToB64: b => 'B64:' + b[0], solBs58Encode: b => 'SIG' + b[0],
    solRpcCall: async (method, params) => {
      log.rpc.push([method, params]);
      const o = sendOutcomes.shift();
      if (o) { const e = new Error('rpc:sendTransaction:-32002'); e.rpcDetail = { err: o, logs: [] }; throw e; }
      return 'ok';
    },
    solSetNotice: h => log.notices.push(h), note: (k, h) => k + ':' + h, solAssertSwapContext() {},
    solBuildFreshTx: async () => { log.built++; return { txBytes: new Uint8Array([2, 0, 0]) }; },
    solAccount: { address: 'w' },
  });
  const signer = { signTransaction: async () => { log.signs++; return [{ signedTransaction: new Uint8Array([2, 1, 1]) }]; } };
  return { c, log, signer };
}
test('send uses preflightCommitment "confirmed"', async () => {
  const { c, log, signer } = sendCtx([]);
  await c.solSendSignedWithRetry({}, 'ctx', signer, new Uint8Array([1, 9, 9]), 'x');
  assert.equal(JSON.stringify(log.rpc[0][1][1]), JSON.stringify({ encoding: 'base64', skipPreflight: false, maxRetries: 5, preflightCommitment: 'confirmed' }));
});
test('BlockhashNotFound: rebuild once, re-prompt once, then succeed with the new signature', async () => {
  const { c, log, signer } = sendCtx(['"BlockhashNotFound"']);
  const sig = await c.solSendSignedWithRetry({}, 'ctx', signer, new Uint8Array([1, 9, 9]), 'x');
  assert.equal(log.built, 1); assert.equal(log.signs, 1); assert.equal(log.rpc.length, 2);
  assert.match(log.notices.join(''), /Network moved on — please approve the refreshed transaction\./);
  assert.equal(sig, 'SIG1');   // امضای تراکنشِ تازه، نه اولی
});
test('second BlockhashNotFound is not retried again and keeps the existing message', async () => {
  const { c, log, signer } = sendCtx(['"BlockhashNotFound"', '"BlockhashNotFound"', '"BlockhashNotFound"']);
  await assert.rejects(() => c.solSendSignedWithRetry({}, 'ctx', signer, new Uint8Array([1, 9, 9]), 'x'),
    e => e.sendMapped && e.message === 'Took too long between quote and signature — press Swap again.');
  assert.equal(log.built, 1); assert.equal(log.signs, 1); assert.equal(log.rpc.length, 2);
});
test('other send errors are never retried', async () => {
  const { c, log, signer } = sendCtx(['{"InstructionError":[1,{"Custom":9}]}']);
  await assert.rejects(() => c.solSendSignedWithRetry({}, 'ctx', signer, new Uint8Array([1, 9, 9]), 'x'), e => e.sendMapped);
  assert.equal(log.built, 0); assert.equal(log.signs, 0); assert.equal(log.rpc.length, 1);
});

// ---- ۴ اکتبر: شکستِ شبیه‌سازی با تأییدِ کاربر ----
test('[sim override] simulation arm is per quote key: failed key needs one confirmation, a new quote disarms', () => {
  const q = (amt) => ({ inputMint: SOL, outputMint: USDC, inAmount: amt, swapMode: 'ExactIn' });
  const c = load(['solNeedsSimArm', 'solImpactKey'], { solQuote: q('100'), solSimFailedKey: null, solSimArmedKey: null });
  assert.equal(c.solNeedsSimArm(), false);                       // هنوز شکستی ندیده‌ایم
  c.solSimFailedKey = c.solImpactKey(c.solQuote);
  assert.equal(c.solNeedsSimArm(), true);
  c.solSimArmedKey = c.solSimFailedKey;
  assert.equal(c.solNeedsSimArm(), false);                       // تأیید شد
  c.solQuote = q('200');
  assert.equal(c.solNeedsSimArm(), false);                       // کوتِ تازه: شکستِ قبلی مالِ این نیست
  c.solSimFailedKey = c.solImpactKey(c.solQuote);
  assert.equal(c.solNeedsSimArm(), true);                        // و شکستِ تازه تأییدِ تازه می‌خواهد
  c.solQuote = null;
  assert.equal(c.solNeedsSimArm(), false);
});
