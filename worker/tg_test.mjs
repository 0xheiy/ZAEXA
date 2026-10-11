/* تست بات تلگرام — بدون شبکه.
   اجرا:  node worker/tg_test.mjs */

import worker from "./index.js";
import {
  tgRoute, tgSecrets, extractAddresses, verdictText, tgRateReset,
  TG_CHAT_LIMIT, TG_GLOBAL_LIMIT, TG_WINDOW_MS,
  LAST_LINE, START_TEXT, headerLine, REPORT_URL, NOT_ADDRESS, ONE_ADDRESS, CHAT_LIMIT, GLOBAL_LIMIT, HELP_TEXT,
} from "./tg.js";
import { plainWhy } from "./report_page.js";

let fails = 0;
function ok(cond, what) {
  if (!cond) { fails++; console.log("FAIL " + what); }
}
let section = 0;
function done(name) {
  if (fails === section) console.log("[tg " + name + "] ok");
  section = fails;
}

// fetch جاسوس: هر فراخوانی ثبت و ۵۰۰ برمی‌گردد
const fetchCalls = [];
globalThis.fetch = async (...a) => { fetchCalls.push(a); return new Response("x", { status: 500 }); };

const TOKEN = "123456:TESTTOKEN_abc";
const USER = "ZaexaTestBot";
const ASSETS = { fetch: async () => new Response("the site", { status: 200 }) };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const { path: P, header: H } = await tgSecrets(TOKEN);
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OTHER = "0x4200000000000000000000000000000000000006";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/* ---- 1. extract ---- */
{
  const x = extractAddresses;
  ok(JSON.stringify(x(USDC)) === JSON.stringify([USDC]), "base plain");
  ok(x("https://zaexa.com/t/" + USDC)[0] === USDC, "base in zaexa url");
  ok(x("https://basescan.org/token/" + USDC + "#code")[0] === USDC, "base in basescan url");
  ok(x(USDC.toLowerCase())[0] === USDC.toLowerCase(), "base lower");
  ok(x(USDC + " " + USDC.toLowerCase()).length === 1, "same base twice other case -> 1");
  ok(x(USDC + " " + USDC.toLowerCase())[0] === USDC, "keeps first spelling");
  ok(x("0x" + "a".repeat(39)).length === 0, "39 hex none");
  ok(x("0x" + "a".repeat(41)).length === 0, "41 hex none");
  ok(x("0x" + "a".repeat(64)).length === 0, "tx hash none");
  ok(x("0X" + USDC.slice(2)).length === 0, "uppercase 0X none");
  ok(JSON.stringify(x(MINT)) === JSON.stringify([MINT]), "solana mint");
  ok(x("https://pump.fun/coin/" + MINT)[0] === MINT, "pump.fun url mint");
  for (const ch of ["0", "O", "I", "l"])
    ok(x(MINT.slice(0, 10) + ch + MINT.slice(11)).length === (ch === "0" || ch === "O" || ch === "I" || ch === "l" ? 0 : 1), "base58 bad char " + ch);
  ok(x("A".repeat(31)).length === 0, "31 chars none");
  ok(x("A".repeat(45)).length === 0, "45 chars none");
  ok(x(USDC + " " + MINT).length === 2, "base + solana -> 2");
  ok(x("hello").length === 0, "no address");
}
done("extract");

/* ---- 2. replies ---- */
{
  const outs = [HELP_TEXT, START_TEXT];
  const fixed = [NOT_ADDRESS, ONE_ADDRESS, CHAT_LIMIT, GLOBAL_LIMIT];
  const t = (chain, r) => { const s = verdictText(chain, r); outs.push(s); return s; };
  let s = t("base", { v: "sell", ret: 97.4 });
  ok(s.includes("returned 97%"), "base sell ret 97");
  s = t("base", { v: "sell", ret: 140 });
  ok(s === "✓ Sell route quoted.\n\n" + LAST_LINE, "ret 140 not shown");
  s = t("base", { v: "sell" });
  ok(s === "✓ Sell route quoted.\n\n" + LAST_LINE, "base sell no ret");
  s = t("solana", { v: "sell" });
  ok(s.startsWith("✓ Passed a simulated buy and sell."), "sol simulated");
  s = t("solana", { v: "sell", basis: "quote", ret: 88 });
  ok(!s.includes("simulated buy") && s.startsWith("✓ Sell route quoted, not simulated.") && s.includes("returned 88%"), "sol quote");
  s = t("solana", { v: "sell", basis: "quote", ret: 150 });
  ok(!s.includes("%"), "sol quote ret 150 hidden");
  s = t("base", { v: "nosell", cause: "empty-pool" });
  ok(s.startsWith("⚠ No sell route quoted · pool is empty"), "empty-pool");
  s = t("base", { v: "nosell", cause: "sell-reverts" });
  ok(s.startsWith("⚠ No sell route quoted · the sell reverts"), "sell-reverts");
  s = t("base", { v: "nosell" });
  ok(s.startsWith("? Could not be checked\n" + plainWhy("base", "cause:unproven")) && !s.includes("No sell route quoted"), "base nosell no cause");
  s = t("solana", { v: "nosell", cause: "sell-reverts" });
  ok(s.startsWith("? Could not be checked") && !s.includes("No sell route quoted"), "solana nosell never");
  s = t("base", { v: null, why: "rpc-down" });
  ok(s.includes(plainWhy("base", "rpc-down")), "null rpc-down");
  s = t("base", { v: null, why: "zzz-unknown" });
  ok(s.includes(plainWhy("base", "zzz-unknown")), "null unknown why");
  t(null, { v: "sell" });
  for (const o of outs) {
    ok(o.endsWith(LAST_LINE), "ends with last line: " + o.slice(0, 30));
    ok(!/safe|risk/i.test(o), "no safe/risk: " + o.slice(0, 30));
  }
  for (const o of fixed) ok(!/safe|risk/i.test(o), "no safe/risk: " + o.slice(0, 30));
  for (const o of outs) {
    ok(!o.includes("rpc-down") && !o.includes("cause:") && !o.includes("sol:unconfirmed"), "no raw why: " + o.slice(0, 30));
  }
}
done("replies");

/* ---- helpers ---- */
let seq = 0;
function upd(message) { return { update_id: ++seq, message }; }
function msg(text, o = {}) {
  return { message_id: 7, chat: { id: o.chat || 555, type: o.type || "private" }, from: { id: 99, is_bot: false },
    date: 1, text, ...(o.entities ? { entities: o.entities } : {}), ...(o.from ? { from: o.from } : {}) };
}
function req(body, { method = "POST", header = H, raw = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (header !== null) headers["x-telegram-bot-api-secret-token"] = header;
  return new Request("https://zaexa.com/tg/" + P, { method, headers: method === "GET" ? {} : headers,
    body: method === "GET" ? undefined : (raw ? body : JSON.stringify(body)) });
}
function mkEnv(extra = {}) { return { ASSETS, TG_BOT_TOKEN: TOKEN, TG_BOT_USERNAME: USER, ...extra }; }
function run(body, { env = mkEnv(), now = 1_000_000, requestOpts, verdictReply } = {}) {
  let calls = 0;
  const deps = { now, verdict: async () => { calls++; return verdictReply || { v: "sell", ret: 99 }; } };
  return tgRoute(req(body, requestOpts), new URL("https://zaexa.com/tg/" + P), env, deps).then(async (r) => {
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}
    return { status: r.status, text, json, calls: () => calls };
  });
}
async function runCount(body, o = {}) { const r = await run(body, o); r.n = r.calls(); return r; }

/* ---- 3. auth ---- */
{
  const mk = (path, init) => worker.fetch(new Request("https://zaexa.com" + path, init), mkEnv(), ctx);
  const body = JSON.stringify(upd(msg("hi")));
  let r = await worker.fetch(new Request("https://zaexa.com/tg/" + P, { method: "POST", body, headers: { "x-telegram-bot-api-secret-token": H } }), { ASSETS }, ctx);
  ok(r.status === 404, "no token -> 404");
  r = await mk("/tg/" + "0".repeat(32), { method: "POST", body, headers: { "x-telegram-bot-api-secret-token": H } });
  ok(r.status === 404, "wrong path -> 404");
  r = await mk("/tg", { method: "POST", body, headers: { "x-telegram-bot-api-secret-token": H } });
  ok(r.status === 404, "/tg -> 404");
  r = await mk("/tg/" + P, { method: "GET" });
  ok(r.status === 405, "GET -> 405");
  r = await mk("/tg/" + P, { method: "POST", body });
  ok(r.status === 401, "no header -> 401");
  r = await mk("/tg/" + P, { method: "POST", body, headers: { "x-telegram-bot-api-secret-token": "x".repeat(64) } });
  ok(r.status === 401, "wrong header -> 401");
  r = await mk("/tg/" + P, { method: "POST", body, headers: { "x-telegram-bot-api-secret-token": H } });
  ok(r.status === 200, "valid -> 200");

  // رد شده‌ها هرگز verdict را صدا نمی‌زنند
  const good = JSON.stringify(upd(msg("/check " + USDC)));
  const cases = [
    [mkEnv({ TG_BOT_TOKEN: "" }), "/tg/" + P, "POST", H, 404],
    [mkEnv(), "/tg/bad", "POST", H, 404],
    [mkEnv(), "/tg/" + P, "GET", H, 405],
    [mkEnv(), "/tg/" + P, "POST", null, 401],
    [mkEnv(), "/tg/" + P, "POST", "nope", 401],
  ];
  for (const [env, path, method, hd, want] of cases) {
    let calls = 0;
    const headers = hd === null ? {} : { "x-telegram-bot-api-secret-token": hd };
    const rr = await tgRoute(new Request("https://zaexa.com" + path, { method, headers, body: method === "GET" ? undefined : good }),
      new URL("https://zaexa.com" + path), env, { verdict: async () => { calls++; return { v: "sell" }; } });
    ok(rr.status === want && calls === 0, "rejected " + want + " no verdict (got " + rr.status + "," + calls + ")");
    ok((await rr.text()) === "", "rejected body empty " + want);
  }

  // مسیر واقعی (fetch ۵۰۰) از طریق worker.fetch
  tgRateReset();
  r = await mk("/tg/" + P, { method: "POST", headers: { "x-telegram-bot-api-secret-token": H }, body: JSON.stringify(upd(msg("check " + USDC))) });
  const j = await r.json();
  ok(r.status === 200 && j.method === "sendMessage", "real path sendMessage");
  ok(j.reply_markup.inline_keyboard[0][0].url === "https://zaexa.com/t/" + USDC, "button url");
  ok(j.text.endsWith(LAST_LINE), "real path ends with last line");
  ok(j.text.startsWith("0x8335…2913 · Base\n? Could not be checked"), "real path with 500 stub -> could not be checked");
}
done("auth");

/* ---- 4. updates ignored ---- */
{
  const bad = [
    ["{not json", true],
    [{ update_id: 1, edited_message: msg("/check " + USDC) }],
    [{ update_id: 1, channel_post: msg("/check " + USDC) }],
    [{ update_id: 1, callback_query: { id: "1", data: USDC } }],
    [upd({ message_id: 1, chat: { id: 1, type: "private" }, from: { id: 1, is_bot: false }, photo: [] })],
    [upd(msg("/check " + USDC, { from: { id: 5, is_bot: true } }))],
    [upd(msg("/check " + USDC, { type: "channel" }))],
    [upd(msg("/check@OtherBot " + USDC))],
    [JSON.stringify(upd(msg("x".repeat(70000)))), true],
  ];
  for (const [b, raw] of bad) {
    tgRateReset();
    const r = await runCount(b, { requestOpts: { raw: !!raw } });
    ok(r.status === 200 && r.text === "" && r.n === 0, "ignored update " + String(JSON.stringify(b)).slice(0, 50));
  }
}
done("updates");

/* ---- 5. groups & private ---- */
{
  const g = (text, o = {}) => runCount(upd(msg(text, { type: "supergroup", chat: -100, ...o })));
  tgRateReset();
  let r = await g(USDC);
  ok(r.text === "" && r.n === 0, "group plain ignored");
  r = await g("/check " + USDC);
  ok(r.json && r.json.method === "sendMessage" && r.n === 1, "group /check replies");
  r = await g("/check@OtherBot " + USDC);
  ok(r.text === "" && r.n === 0, "group /check@OtherBot ignored");
  r = await g("/check@zaexatestbot " + USDC);
  ok(r.json && r.n === 1, "group /check@zaexatestbot replies");
  const t = "@ZaexaTestBot " + USDC;
  r = await g(t, { entities: [{ type: "mention", offset: 0, length: 13 }] });
  ok(r.json && r.n === 1 && r.json.reply_markup, "group mention replies");
  const t2 = "@SomeoneElse " + USDC;
  r = await g(t2, { entities: [{ type: "mention", offset: 0, length: 12 }] });
  ok(r.text === "" && r.n === 0, "group other mention ignored");
  r = await g("/foo " + USDC);
  ok(r.text === "" && r.n === 0, "group unknown command ignored");
  r = await g("/help");
  ok(r.json && r.json.text === HELP_TEXT && !r.json.reply_markup, "group /help");
  const noUser = await runCount(upd(msg("/check " + USDC, { type: "group", chat: -5 })), { env: mkEnv({ TG_BOT_USERNAME: undefined }) });
  ok(noUser.text === "" && noUser.n === 0, "group without username ignored");
  r = await runCount(upd(msg("/check")));
  ok(r.json.text === NOT_ADDRESS && r.n === 0, "private /check no arg");
  r = await runCount(upd(msg("hello")));
  ok(r.json.text === NOT_ADDRESS, "private hello");
  r = await runCount(upd(msg(USDC + " " + OTHER)));
  ok(r.json.text === ONE_ADDRESS && r.n === 0, "private two addresses");
  r = await runCount(upd(msg("/start")));
  ok(r.json.text === START_TEXT && START_TEXT.endsWith(HELP_TEXT), "private /start");
  r = await runCount(upd(msg("/whatever " + USDC)));
  ok(r.json && r.n === 1, "private unknown command extracts");
  ok(r.json.chat_id === 555 && r.json.reply_parameters.message_id === 7 && r.json.link_preview_options.is_disabled && !("parse_mode" in r.json), "reply shape");
}
done("groups");

/* ---- 6. rate ---- */
{
  tgRateReset();
  const T = 5_000_000;
  let calls = 0;
  const go = async (chat, now) => {
    const deps = { now, verdict: async () => { calls++; return { v: "sell" }; } };
    const r = await tgRoute(req(upd(msg("/check " + USDC, { chat }))), new URL("https://zaexa.com/tg/" + P), mkEnv(), deps);
    return (await r.json()).text;
  };
  for (let i = 0; i < TG_CHAT_LIMIT; i++) ok((await go(1, T)).includes("\n✓ Sell route quoted"), "chat A #" + (i + 1));
  ok((await go(1, T)) === CHAT_LIMIT, "11th -> CHAT_LIMIT");
  ok(calls === TG_CHAT_LIMIT, "verdict calls stay 10");
  ok((await go(2, T)).includes("\n✓ Sell route quoted"), "chat B ok");
  ok((await go(1, T + TG_WINDOW_MS + 1)).includes("\n✓ Sell route quoted"), "chat A ok after window");
  tgRateReset();
  calls = 0;
  for (let i = 0; i < TG_GLOBAL_LIMIT; i++) ok((await go(1000 + i, T)).includes("\n✓ Sell route quoted"), "global #" + (i + 1));
  ok((await go(5000, T)) === GLOBAL_LIMIT, "31st -> GLOBAL_LIMIT");
  ok(calls === TG_GLOBAL_LIMIT, "verdict calls stay 30");
  tgRateReset();
}
done("rate");

/* ---- 6b. ux: header, marks, buttons, anonymous admin ---- */
{
  tgRateReset();
  // عنوان: نماد + شبکه؛ نمادِ بد یا دارای safe/risk → آدرسِ کوتاه
  ok(headerLine("base", "USDC", USDC) === "USDC · Base", "header symbol");
  ok(headerLine("solana", "BONK", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263") === "BONK · Solana", "header solana");
  ok(headerLine("base", undefined, USDC) === "0x8335…2913 · Base", "header no symbol -> short address");
  ok(headerLine("base", "SAFEMOON", USDC) === "0x8335…2913 · Base", "header 'safe' symbol dropped");
  ok(headerLine("base", "lowRISK", USDC) === "0x8335…2913 · Base", "header 'risk' symbol dropped");
  ok(headerLine("base", "A B", USDC) === "0x8335…2913 · Base", "header symbol with space dropped");
  ok(headerLine("base", "<b>x</b>", USDC) === "0x8335…2913 · Base", "header markup symbol dropped");
  ok(headerLine("base", "ABCDEFGHIJKLMNOPQ", USDC) === "0x8335…2913 · Base", "header 17-char symbol dropped");
  // جوابِ کامل از مسیر
  let r = await runCount(upd(msg(USDC)), { verdictReply: { v: "sell", ret: 99.6, symbol: "USDC" } });
  ok(r.json && r.json.text === "USDC · Base\n✓ Sell route quoted. A $100 sell quote returned 100%.\n\n" + LAST_LINE, "full reply text");
  const kb = r.json && r.json.reply_markup && r.json.reply_markup.inline_keyboard;
  ok(kb && kb.length === 1 && kb[0].length === 2 && kb[0][0].text === "Open on Zaexa" && kb[0][0].url === "https://zaexa.com/t/" + USDC
     && kb[0][1].text === "Daily report" && kb[0][1].url === REPORT_URL && REPORT_URL === "https://zaexa.com/report", "two buttons");
  r = await runCount(upd(msg(USDC)), { verdictReply: { v: "sell", symbol: "SAFE" } });
  ok(r.json && !/safe|risk/i.test(r.json.text) && r.json.text.startsWith("0x8335…2913 · Base\n"), "symbol SAFE never printed");
  r = await runCount(upd(msg(USDC)), { verdictReply: { v: "nosell", cause: "empty-pool", symbol: "ZZ" } });
  ok(r.json && r.json.text.startsWith("ZZ · Base\n⚠ No sell route quoted · pool is empty"), "nosell mark");
  r = await runCount(upd(msg(USDC)), { verdictReply: { v: null, why: "rpc-down" } });
  ok(r.json && r.json.text.includes("\n? Could not be checked\n"), "unknown mark");
  // help/start/limit/invalid بی‌دکمه
  r = await runCount(upd(msg("/help")));
  ok(r.json && r.json.text === HELP_TEXT && !r.json.reply_markup, "help no buttons");
  ok(!/safe|risk/i.test(START_TEXT) && START_TEXT.startsWith("Zaexa is a DEX aggregator"), "start text");
  // ادمینِ ناشناس در گروه: from رباتِ سیستمی + sender_chat = خودِ گروه
  const anon = { from: { id: 1087968824, is_bot: true, username: "GroupAnonymousBot" } };
  const am = msg("/check " + USDC, { type: "supergroup", chat: -1001, ...anon });
  am.sender_chat = { id: -1001, type: "supergroup", title: "Zaexa chat" };
  r = await runCount(upd(am));
  ok(r.json && r.n === 1, "anonymous admin /check answered");
  const am2 = msg("@ZaexaTestBot " + USDC, { type: "supergroup", chat: -1001, ...anon, entities: [{ type: "mention", offset: 0, length: 13 }] });
  am2.sender_chat = { id: -1001, type: "supergroup", title: "Zaexa chat" };
  r = await runCount(upd(am2));
  ok(r.json && r.n === 1, "anonymous admin mention answered");
  // رباتِ واقعی بدونِ sender_chat هنوز نادیده
  r = await runCount(upd(msg("/check " + USDC, { type: "supergroup", chat: -1001, from: { id: 5, is_bot: true } })));
  ok(r.text === "" && r.n === 0, "real bot still ignored");
  // رونوشتِ خودکارِ کانال نادیده
  const af = msg("/check " + USDC, { type: "supergroup", chat: -1001 });
  af.is_automatic_forward = true; af.sender_chat = { id: -1002, type: "channel" };
  r = await runCount(upd(af));
  ok(r.text === "" && r.n === 0, "automatic forward ignored");
}
done("ux");

/* ---- 7. privacy ---- */
{
  tgRateReset();
  fetchCalls.length = 0;
  const points = [];
  const kv = new Proxy({}, { get() { throw new Error("ZX_KV touched"); }, has() { throw new Error("ZX_KV touched"); } });
  const env = mkEnv({ ZX_KV: kv, ZX_EV: { writeDataPoint: (p) => points.push(p) } });
  const bodies = [];
  const send = async (m, v) => {
    const r = await run(upd(m), { env, verdictReply: v });
    bodies.push(r.text);
    return r;
  };
  const T1 = "/check " + USDC;
  await send(msg(T1, { chat: 424242 }), { v: "sell", ret: 90 });
  await send(msg("/check " + OTHER, { chat: 424242 }), { v: "nosell", cause: "empty-pool" });
  await send(msg("check " + MINT, { chat: 424242 }), { v: "nosell" });
  await send(msg("/check", { chat: 424242 }));
  await send(msg("/help", { chat: 424242 }));
  await send(msg(USDC + " " + OTHER, { chat: 424242 }));
  ok(points.length === 3, "only 3 checks wrote datapoints (got " + points.length + ")");
  const want = [["sell", "base"], ["nosell", "base"], ["na", "solana"]];
  points.forEach((p, i) => {
    ok(JSON.stringify(p.blobs) === JSON.stringify(["tg:check", want[i][0], "bot", "??", want[i][1]]), "blobs " + i + " " + JSON.stringify(p.blobs));
    ok(JSON.stringify(p.doubles) === "[1]" && JSON.stringify(p.indexes) === '["tg:check"]', "doubles/indexes");
    for (const b of p.blobs) {
      ok(![String(424242), "99", T1, USDC, OTHER, MINT, USDC.toLowerCase()].includes(b), "blob leaks " + b);
    }
  });
  // محدودشده چیزی نمی‌نویسد
  tgRateReset();
  const before = points.length;
  for (let i = 0; i < TG_CHAT_LIMIT + 2; i++) await send(msg("/check " + USDC, { chat: 777 }), { v: "sell" });
  ok(points.length - before === TG_CHAT_LIMIT, "limited attempts write nothing");
  ok(fetchCalls.length === 0, "no outbound fetch (" + fetchCalls.length + ")");
  for (const b of bodies) ok(!b.includes(TOKEN) && !b.includes("TESTTOKEN") && !b.includes(H) && !b.includes(P), "body leaks secret");
}
done("privacy");

console.log("[tg positive control] live USDC check is manual after deploy (not run here)");

if (fails) { console.log(fails + " failure(s)"); process.exit(1); }
