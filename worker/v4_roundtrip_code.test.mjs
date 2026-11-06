// تساوی ثابتِ V4RT_CODE با یک ساختِ تازه‌ی forge از contracts/src/V4RoundTrip.sol.
// forge نباشد → تست با پیامِ روشن skip می‌شود (هرگز بی‌صدا سبز نمی‌شود).
// در کانتینر بدونِ دسترسی به binaries.soliditylang.org: SOLC=/مسیر/solc-static-linux
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { V4RT_CODE, V4RT_ADDRESS } from "./v4_roundtrip_code.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const forge = spawnSync("forge", ["--version"], { encoding: "utf8" });
const haveForge = forge.status === 0;
if (!haveForge) console.log("SKIPPED: forge is not installed, V4RT_CODE was NOT compared with a fresh build (run contracts/script/build_roundtrip.sh --print)");

test("V4RT_CODE equals a fresh forge build of V4RoundTrip.sol", { skip: haveForge ? false : "forge not installed" }, () => {
  const r = spawnSync("bash", ["contracts/script/build_roundtrip.sh", "--print"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, "build_roundtrip.sh failed: " + r.stderr);
  assert.equal(r.stdout.trim(), V4RT_CODE, "worker/v4_roundtrip_code.js is stale: run contracts/script/build_roundtrip.sh");
});

test("V4RT_CODE is runtime code, not creation code, and the address is a code-less constant", () => {
  assert.match(V4RT_CODE, /^0x[0-9a-f]+$/);
  assert.ok(V4RT_CODE.length > 2000 && V4RT_CODE.length % 2 === 0);
  assert.match(V4RT_ADDRESS, /^0x[0-9a-f]{40}$/);
  // PoolManager (web/index.html CHAIN.v4PoolManager) sits inside the code as a PUSH20 constant
  assert.ok(V4RT_CODE.includes("498581ff718922c3f8e6a244956af099b2652b2b"), "PoolManager address missing from the runtime code");
});
