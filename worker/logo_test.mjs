/* تستِ GET /logo.png — بدونِ شبکه، از راهِ خودِ worker.fetch. */
import worker from "./index.js";
import { LOGO_PNG_ETAG, LOGO_PNG_SIZE } from "./logo-image.js";
import { createHash } from "node:crypto";
import fs from "node:fs";

let fails = 0;
const ok = (c, w) => { if (!c) { fails++; console.log("FAIL " + w); } };
globalThis.fetch = async () => { throw new Error("no network in logo test"); };
const env = { ASSETS: { fetch: async () => new Response("the site", { status: 200 }) } };
const call = (init = {}) => worker.fetch(new Request("https://zaexa.com/logo.png", init), env, {});

let r = await call();
const buf = new Uint8Array(await r.arrayBuffer());
ok(r.status === 200, "GET 200");
ok(r.headers.get("content-type") === "image/png", "content-type png");
ok(buf.length === LOGO_PNG_SIZE && r.headers.get("content-length") === String(LOGO_PNG_SIZE), "length");
ok([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => buf[i] === v), "png signature");
const dv = new DataView(buf.buffer);
ok(buf.length >= 24 && dv.getUint32(16) === 1024 && dv.getUint32(20) === 1024, "1024x1024");
const h = '"' + createHash("sha256").update(buf).digest("hex").slice(0, 16) + '"';
ok(h === LOGO_PNG_ETAG && r.headers.get("etag") === LOGO_PNG_ETAG, "etag is the content hash");
ok(/max-age=86400/.test(r.headers.get("cache-control") || "") && !/immutable/.test(r.headers.get("cache-control")), "1-day cache, not immutable");
// بایت‌به‌بایت همان فایلِ حسام، اگر در دسترس باشد
const src = "/mnt/user-data/uploads/Downloads/zaexa-logo-1024.png";
if (fs.existsSync(src)) ok(Buffer.compare(fs.readFileSync(src), Buffer.from(buf)) === 0, "byte-identical to the source file");
r = await call({ method: "HEAD" });
ok(r.status === 200 && (await r.arrayBuffer()).byteLength === 0, "HEAD no body");
r = await call({ headers: { "if-none-match": LOGO_PNG_ETAG } });
ok(r.status === 304, "304 on matching etag");
r = await call({ method: "POST" });
ok(r.status === 405, "POST 405");
r = await worker.fetch(new Request("https://zaexa.com/logo.png/x"), env, {});
ok(r.headers.get("content-type") !== "image/png", "only the exact path");

if (fails === 0) console.log("[logo png] /logo.png serves the 1024x1024 square logo from the Worker (not _site): png, ETag = content hash, 304, HEAD, 405, 1-day cache");
process.exit(fails ? 1 : 0);
