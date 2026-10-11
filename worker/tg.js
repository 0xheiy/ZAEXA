/* بات تلگرام — بررسیِ فروش‌پذیریِ یک توکن.
   قواعد سخت:
   • هیچ درخواستِ خروجی نمی‌زند؛ جواب در بدنه‌ی خودِ پاسخِ وب‌هوک است.
   • توکنِ بات هرگز در URL، هدر، بدنه، لاگ یا پیامِ خطا نمی‌آید.
   • هیچ شناسه‌ای ذخیره نمی‌شود: نه چت، نه کاربر، نه متن، نه آدرس.
   • این ماژول index.js را import نمی‌کند (چرخه می‌سازد). */

import { chainOf } from "./chains.js";
import { plainWhy } from "./report_page.js";

export const TG_CHAT_LIMIT = 10;
export const TG_GLOBAL_LIMIT = 30;
export const TG_WINDOW_MS = 60000;
const TG_MAX_BODY = 65536;

export const LAST_LINE = "A check of the exit, not a price call.";
export const NOT_ADDRESS = "That is not a token address";
export const ONE_ADDRESS = "One address per message.";
export const CHAT_LIMIT = "Too many checks from this chat. Try again in a minute.";
export const GLOBAL_LIMIT = "Too many checks right now. Try again in a minute.";
export const HELP_TEXT =
  "Send a token address and I check whether it can be sold back.\n\n" +
  "Base: 0x followed by 40 hex characters.\n" +
  "Solana: the token's mint address.\n" +
  "In a group: /check <address>, or mention me with the address.\n\n" +
  "Example:\n/check 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\n\n" + LAST_LINE;

/* ---------- رمزها ---------- */

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  let out = "";
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, "0");
  return out;
}

// کشِ یک‌عضویِ هر isolate
const secretCache = new Map();

export async function tgSecrets(token) {
  const hit = secretCache.get(token);
  if (hit) return hit;
  const path = (await sha256hex("zaexa-tg-path:" + token)).slice(0, 32);
  const header = await sha256hex("zaexa-tg-header:" + token);
  const v = { path, header };
  secretCache.clear();
  secretCache.set(token, v);
  return v;
}

// مقایسه‌ی زمان-ثابت: هم‌طول بودن، بعد XOR روی کدِ نویسه‌ها
function ctEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ---------- محدودیتِ نرخ (همان الگوی rateOk) ---------- */

function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const chatHits = new Map();
let globalHit = { n: 0, reset: 0 };

export function tgRateReset() {
  chatHits.clear();
  globalHit = { n: 0, reset: 0 };
}

function chatOk(chatId, now) {
  const key = fnv1a("tg:" + String(chatId)); // فقط هش، نه شناسه‌ی خام
  let e = chatHits.get(key);
  if (!e || now >= e.reset) {
    e = { n: 0, reset: now + TG_WINDOW_MS };
    chatHits.set(key, e);
  }
  e.n++;
  // سقفِ حافظه: اول منقضی‌ها، بعد پاک‌سازیِ کامل
  if (chatHits.size > 2000) {
    for (const [k, v] of chatHits) if (now >= v.reset) chatHits.delete(k);
  }
  if (chatHits.size > 5000) chatHits.clear();
  return e.n <= TG_CHAT_LIMIT;
}

function globalOk(now) {
  if (now >= globalHit.reset) globalHit = { n: 0, reset: now + TG_WINDOW_MS };
  globalHit.n++;
  return globalHit.n <= TG_GLOBAL_LIMIT;
}

/* ---------- استخراجِ آدرس ---------- */

const BASE_RE = /(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/g;
const SOL_RE = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![0-9A-Za-z])/g;

export function extractAddresses(text) {
  const found = [];
  if (typeof text !== "string") return found;
  const hits = [];
  for (const m of text.matchAll(BASE_RE)) hits.push({ i: m.index, a: m[0], base: true });
  for (const m of text.matchAll(SOL_RE)) hits.push({ i: m.index, a: m[0], base: false });
  hits.sort((x, y) => x.i - y.i);
  const seen = new Set();
  for (const h of hits) {
    const k = h.base ? "b:" + h.a.toLowerCase() : "s:" + h.a;
    if (seen.has(k)) continue;
    seen.add(k);
    found.push(h.a);
  }
  return found;
}

/* ---------- متنِ جواب ---------- */

const goodRet = (ret) => typeof ret === "number" && Number.isFinite(ret) && ret > 0 && ret <= 100;

// body و outcome را با هم می‌دهد؛ outcome فقط برای شمارنده است
function classify(chain, r) {
  r = r && typeof r === "object" ? r : {};
  const { v, cause, ret, basis } = r;
  let why = r.why;
  if (v === "sell" && chain === "base") {
    return { outcome: "sell", body: goodRet(ret)
      ? "Sell route quoted. A $100 sell quote returned " + Math.round(ret) + "%."
      : "Sell route quoted." };
  }
  if (v === "sell" && chain === "solana") {
    if (basis !== "quote") return { outcome: "sell", body: "Passed a simulated buy and sell." };
    return { outcome: "sell", body: "Sell route quoted, not simulated." +
      (goodRet(ret) ? " A $100 sell quote returned " + Math.round(ret) + "%." : "") };
  }
  if (v === "nosell" && chain === "base") {
    if (cause === "empty-pool") return { outcome: "nosell", body: "No sell route quoted · pool is empty" };
    if (cause === "sell-reverts") return { outcome: "nosell", body: "No sell route quoted · the sell reverts" };
    why = "cause:unproven";
  } else if (v === "nosell" && chain === "solana") {
    why = "sol:unconfirmed"; // سولانا هرگز nosell منتشر نمی‌کند
  }
  return { outcome: "na", body: "Could not be checked\n" + plainWhy(chain, why) };
}

export function verdictText(chain, r) {
  return classify(chain, r).body + "\n\n" + LAST_LINE;
}

/* ---------- مسیر ---------- */

const NS = { "cache-control": "no-store" };
const empty = (status) => new Response(null, { status, headers: NS });

function replyObj(message, text, address) {
  const o = {
    method: "sendMessage",
    chat_id: message.chat.id,
    text,
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    link_preview_options: { is_disabled: true },
  };
  if (address) {
    o.reply_markup = { inline_keyboard: [[{ text: "Open on Zaexa", url: "https://zaexa.com/t/" + address }]] };
  }
  return o;
}

function jsonReply(o) {
  return new Response(JSON.stringify(o), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// تصمیم می‌گیرد پیام چه بکند: null = نادیده، {help}، {extract: متن}
function plan(message, username) {
  const text = message.text;
  const priv = message.chat.type === "private";
  if (!priv && !username) return null; // بدون نامِ بات، گروه ساکت است
  const t = text.trim();
  if (t.startsWith("/")) {
    const word = t.split(/\s+/)[0];
    const arg = t.slice(word.length).trim();
    const at = word.indexOf("@");
    const name = (at < 0 ? word.slice(1) : word.slice(1, at)).toLowerCase();
    if (at >= 0) {
      const suffix = word.slice(at + 1).toLowerCase();
      if (!username || suffix !== username) return null; // مالِ بات دیگری
    }
    if (name === "start" || name === "help") return { help: true };
    if (name === "check") return { extract: arg };
    return priv ? { extract: text } : null;
  }
  if (priv) return { extract: text };
  if (!username || !Array.isArray(message.entities)) return null;
  const want = "@" + username;
  for (const e of message.entities) {
    if (!e || e.type !== "mention" || typeof e.offset !== "number" || typeof e.length !== "number") continue;
    if (text.substr(e.offset, e.length).toLowerCase() === want) {
      return { extract: text.slice(0, e.offset) + " " + text.slice(e.offset + e.length) };
    }
  }
  return null;
}

function count(env, outcome, chain) {
  const ds = env && env.ZX_EV;
  if (!ds || typeof ds.writeDataPoint !== "function") return;
  try {
    ds.writeDataPoint({
      blobs: ["tg:check", outcome, "bot", "??", chain],
      doubles: [1],
      indexes: ["tg:check"],
    });
  } catch (e) { /* شمارنده نباید جواب را بشکند */ }
}

export async function tgRoute(request, url, env, deps) {
  const token = env && typeof env.TG_BOT_TOKEN === "string" ? env.TG_BOT_TOKEN : "";
  if (!token) return empty(404);
  const sec = await tgSecrets(token);
  if (!ctEq(url.pathname, "/tg/" + sec.path)) return empty(404);
  if (request.method !== "POST") return empty(405);
  if (!ctEq(request.headers.get("x-telegram-bot-api-secret-token"), sec.header)) return empty(401);

  // از اینجا به بعد همیشه ۲۰۰ — تلگرام روی غیر-۲۰۰ دوباره می‌فرستد
  try {
    if (Number(request.headers.get("content-length") || "0") > TG_MAX_BODY) return empty(200);
    const buf = await request.arrayBuffer();
    if (buf.byteLength > TG_MAX_BODY) return empty(200);
    let update;
    try { update = JSON.parse(new TextDecoder().decode(buf)); } catch (e) { return empty(200); }
    const message = update && typeof update === "object" ? update.message : null;
    if (!message || typeof message !== "object" || typeof message.text !== "string") return empty(200);
    if (message.from && message.from.is_bot === true) return empty(200);
    const chat = message.chat;
    if (!chat || !["private", "group", "supergroup"].includes(chat.type)) return empty(200);

    let username = typeof env.TG_BOT_USERNAME === "string" ? env.TG_BOT_USERNAME : "";
    username = username.replace(/^@/, "").toLowerCase();

    const p = plan(message, username);
    if (!p) return empty(200);
    if (p.help) return jsonReply(replyObj(message, HELP_TEXT));

    const addrs = extractAddresses(p.extract);
    if (addrs.length === 0) return jsonReply(replyObj(message, NOT_ADDRESS));
    if (addrs.length > 1) return jsonReply(replyObj(message, ONE_ADDRESS));
    const addr = addrs[0];
    const chain = chainOf(addr);
    if (chain === null) return jsonReply(replyObj(message, NOT_ADDRESS));

    const now = deps && typeof deps.now === "number" ? deps.now : Date.now();
    if (!chatOk(chat.id, now)) return jsonReply(replyObj(message, CHAT_LIMIT));
    if (!globalOk(now)) return jsonReply(replyObj(message, GLOBAL_LIMIT));

    let r;
    try { r = await deps.verdict(addr); } catch (e) { r = { v: null, why: "internal" }; }
    const { outcome, body } = classify(chain, r);
    count(env, outcome, chain);
    return jsonReply(replyObj(message, body + "\n\n" + LAST_LINE, addr));
  } catch (e) {
    return empty(200);
  }
}
