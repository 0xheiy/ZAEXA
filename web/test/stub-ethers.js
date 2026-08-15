/* ------------------------------------------------------------------
   Offline test double for ethers v6 + a fake Base network.
   Only used by test/harness.html — never shipped with index.html.
   It implements just enough of the ethers surface that index.html uses,
   plus a constant-product AMM so route search / split search / price
   impact produce realistic numbers without touching the network.
   ------------------------------------------------------------------ */
(function () {
  const ser = (x) => JSON.stringify(x, (k, v) => (typeof v === "bigint" ? { __b: v.toString() } : v));
  const de  = (s) => JSON.parse(s, (k, v) => (v && v.__b !== undefined ? BigInt(v.__b) : v));

  const toHex = (s) => "0x" + Array.from(new TextEncoder().encode(s))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  const fromHex = (h) => new TextDecoder().decode(
    new Uint8Array((h.slice(2).match(/../g) || []).map(x => parseInt(x, 16))));

  function Interface(abi) { this.abi = abi; }
  Interface.prototype.encodeFunctionData = function (name, args) {
    return toHex(ser({ name, args }));
  };
  Interface.prototype.decodeFunctionResult = function (name, data) {
    return de(fromHex(data)).ret;
  };
  Interface.prototype.getEvent = function () { return { topicHash: "0x" + "ee".repeat(32) }; };
  Interface.prototype.parseLog = function (lg) { return { args: de(fromHex(lg.data)) }; };
  const pack = (ret) => toHex(ser({ ret }));
  const unpack = (d) => de(fromHex(d));

  /* ---------------- fake liquidity ---------------- */
  const T = {
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    AERO: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
    cbBTC:"0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    DAI:  "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  };
  const DEC = { [T.WETH.toLowerCase()]:18, [T.USDC.toLowerCase()]:6, [T.AERO.toLowerCase()]:18,
                [T.cbBTC.toLowerCase()]:8, [T.DAI.toLowerCase()]:18 };
  // قیمت تقریبی هر توکن به دلار — برای ساختن ذخایر متقارن
  const USD = { [T.WETH.toLowerCase()]:3000, [T.USDC.toLowerCase()]:1, [T.AERO.toLowerCase()]:0.9,
                [T.cbBTC.toLowerCase()]:95000, [T.DAI.toLowerCase()]:1 };

  // عمق استخر (دلار) برای هر (venueKey, pair). عمدی نامتقارن تا تقسیم سفارش معنا پیدا کند.
  const DEPTH = {
    "uni-500|weth-usdc": 9_000_000, "uni-3000|weth-usdc": 1_200_000,
    "uni-100|weth-usdc": 0,         "uni-10000|weth-usdc": 90_000,
    "aero-vol|weth-usdc": 6_500_000, "aero-stb|weth-usdc": 0,
    "uni-3000|aero-usdc": 250_000,  "aero-vol|aero-usdc": 2_000_000,
    "uni-500|aero-weth": 0,         "aero-vol|aero-weth": 3_000_000,
    "uni-3000|cbbtc-weth": 800_000, "uni-500|cbbtc-usdc": 400_000,
    "aero-stb|usdc-dai": 1_500_000, "uni-100|usdc-dai": 4_000_000,
    // PancakeSwap V3 — نسل اول روتر، ولی از نظر استخر مثل بقیه‌ی V3
    "pcs-500|weth-usdc": 2_200_000, "pcs-2500|weth-usdc": 300_000,
    "pcs-100|weth-usdc": 0,         "pcs-10000|weth-usdc": 0,
  };
  // کلیدهای جفت‌ها را به همان شکلی که pairKey می‌سازد (مرتب‌شده) نرمال می‌کنیم
  for (const k of Object.keys(DEPTH)) {
    const [v, pr] = k.split("|");
    const norm = v + "|" + pr.split("-").sort().join("-");
    if (norm !== k) { DEPTH[norm] = DEPTH[k]; delete DEPTH[k]; }
  }

  const FEE = { "uni-100":1n, "uni-500":5n, "uni-3000":30n, "uni-10000":100n,
                "pcs-100":1n, "pcs-500":5n, "pcs-2500":25n, "pcs-10000":100n,
                "aero-vol":30n, "aero-stb":5n };  // در ده‌هزارم

  const QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a".toLowerCase();
  const PCS_Q  = "0xB048Bbc1Ee6b733FFfCFb9e9cEF7375518e25997".toLowerCase();
  // هر کوتر V3 به یک پیشوند venue نگاشت می‌شود، تا استخرهای دو صرافی قاطی نشوند
  const V3_QUOTERS = { [QUOTER]: "uni", [PCS_Q]: "pcs" };
  const AERO_R = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43".toLowerCase();
  const MC3    = "0xcA11bde05977b3631167028862bE2a173976CA11".toLowerCase();
  // باید با CHAIN.executor در index.html یکی باشد، وگرنه allowedRouter و feeBps
  // در استاب هرگز match نمی‌شوند و دروازه‌ی ۳ بی‌صدا از تست بیرون می‌ماند.
  const EXEC   = "0xE980825d4B3911e35Be5804349be26eBBe93BcC6".toLowerCase();

  const symOf = a => Object.keys(T).find(k => T[k].toLowerCase() === a.toLowerCase()) || "???";
  const pairKey = (a, b) => [symOf(a).toLowerCase(), symOf(b).toLowerCase()].sort().join("-");

  function venueKeyV3(prefix, fee) { return prefix + "-" + fee; }
  function venueKeySolidly(stable) { return stable ? "aero-stb" : "aero-vol"; }

  function reserves(vk, a, b) {
    const depth = DEPTH[vk + "|" + pairKey(a, b)];
    if (!depth) return null;
    const mk = (addr) => {
      const d = DEC[addr.toLowerCase()], p = USD[addr.toLowerCase()];
      return BigInt(Math.floor((depth / 2 / p) * 1e6)) * 10n ** BigInt(d) / 1000000n;
    };
    return { rIn: mk(a), rOut: mk(b) };
  }

  function amm(vk, a, b, amountIn) {
    const r = reserves(vk, a, b);
    if (!r || amountIn <= 0n) return null;
    const fee = FEE[vk] || 30n;
    const aIn = (amountIn * (10000n - fee)) / 10000n;
    const out = (aIn * r.rOut) / (r.rIn + aIn);
    return out > 0n ? out : null;
  }

  /* ---------------- provider ---------------- */
  /* هش غیررمزنگاری ولی قطعی — فقط برای اینکه selectorOf() چیزی برگرداند */
  function fakeId(s) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      h1 = (h1 ^ s.charCodeAt(i)) * 16777619 >>> 0;
      h2 = (h2 + s.charCodeAt(i) * (i + 7)) >>> 0;
    }
    const hx = n => n.toString(16).padStart(8, "0");
    return "0x" + (hx(h1) + hx(h2)).repeat(4);
  }

  // بایت‌کد ساختگی: عمداً سلکتور دو تابع خطرناک را داخلش می‌گذاریم
  const DANGER_IN_CODE = ["setFee(uint256)", "setMaxTxAmount(uint256)"];
  const FAKE_CODE = "0x60806040" +
    DANGER_IN_CODE.map(s => fakeId(s).slice(2, 10)).join("dead") + "00".repeat(40);

  // روترها/کوترهایی که در این تست «سالم»اند — بقیه عمداً کد ندارند تا
  // مسیر «صرافی تأیید نشد» هم آزموده شود.
  const GOOD_ROUTERS = [
    "0x2626664c2603336E57B271c5C0b26F421741e481",   // Uniswap V3 router (نسل ۰۲)
    "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",   // Aerodrome router
    "0x1b81D678ffb9C0263b24A97847620C99d213eB14",   // PancakeSwap V3 router (نسل ۰۱)
  ].map(a => a.toLowerCase());
  // کوترها کد جدا دارند: دروازه‌ی جدید سلکتور کوتر را در بایت‌کد می‌گردد،
  // پس اگر کد کوتر همان کد روتر باشد تست چیزی را ثابت نمی‌کند.
  const GOOD_QUOTERS = [
    "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",   // Uniswap V3 quoter
    "0xB048Bbc1Ee6b733FFfCFb9e9cEF7375518e25997",   // PancakeSwap V3 quoter
  ].map(a => a.toLowerCase());
  const SWAP_SIGS = [
    "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
    "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
    "swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)",
    "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
  ];
  const ROUTER_CODE = "0x60806040" + SWAP_SIGS.map(s => fakeId(s).slice(2, 10)).join("beef");
  const QUOTER_SIG  = "quoteExactInputSingle((address,address,uint256,uint24,uint160))";
  const QUOTER_CODE = "0x60806040" + fakeId(QUOTER_SIG).slice(2, 10) + "00".repeat(20);
  // آدرس‌هایی که روی زنجیره‌ی واقعی هم قرارداد ندارند. بدون این‌ها استاب
  // *هر* آدرسی را یک ERC-20 سالم نشان می‌داد و مسیر «توکن قابل تأیید نیست»
  // اصلاً آزموده نمی‌شد.
  const NOCODE = [
    "0x000000000000000000000000000000000000dEaD",
    "0x0000000000000000000000000000000000000000",
  ].map(a => a.toLowerCase());
  // عمداً بدون کد می‌مانند تا مسیر «صرافی تأیید نشد» هم آزموده شود
  const CANDIDATE_ROUTERS = [
    "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86",
    "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891",
    "0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7",
  ].map(a => a.toLowerCase());

  function JsonRpcProvider(url) { this.url = url; }
  JsonRpcProvider.prototype.getBalance = async function () { return 42n * 10n ** 15n; };
  JsonRpcProvider.prototype.getCode = async function (addr) {
    const a = String(addr || "").toLowerCase();
    if (NOCODE.includes(a)) return "0x";
    if (GOOD_ROUTERS.includes(a)) return ROUTER_CODE;
    if (GOOD_QUOTERS.includes(a)) return QUOTER_CODE;
    if (CANDIDATE_ROUTERS.includes(a)) return "0x";     // هنوز تأیید نشده
    return FAKE_CODE;                                    // توکن
  };
  JsonRpcProvider.prototype.getBlockNumber = async function () { return 50000000; };
  /* استاب باید بتواند اندپوینت *بد* را هم بازی کند، وگرنه مسیرهای خطای
     Custom RPC اصلاً آزموده نمی‌شوند و «ذخیره شد» بی‌معنی سبز می‌ماند.
     window.__STUB_RPC__ = { "https://…": 1 }            → زنجیره‌ی اشتباه
     window.__STUB_RPC__ = { "https://…": "unreachable" } → اصلاً جواب نمی‌دهد */
  JsonRpcProvider.prototype.getNetwork = async function () {
    const cfg = (window.__STUB_RPC__ || {})[this.url];
    if (cfg === "unreachable")
      throw Object.assign(new Error("fetch failed"), { code: "NETWORK_ERROR" });
    return { chainId: BigInt(cfg === undefined ? 8453 : cfg) };
  };
  JsonRpcProvider.prototype.getLogs = async function () {
    // چند سواپ ساختگی: amount منفی برای توکن ما = خرید
    const mk = (ourAmt, refAmt, who, block) => ({ blockNumber: block,
      data: toHex(ser({ amount0: ourAmt, amount1: refAmt, recipient: who })) });
    return [
      mk(-3n * 10n ** 17n,  600n * 10n ** 6n, "0x" + "11".repeat(20), 49999970),
      mk( 2n * 10n ** 17n, -390n * 10n ** 6n, "0x" + "22".repeat(20), 49999950),
      mk(-9n * 10n ** 17n, 1800n * 10n ** 6n, "0x" + "11".repeat(20), 49999900),
      mk(-1n * 10n ** 17n,  200n * 10n ** 6n, "0x" + "33".repeat(20), 49999800),
    ];
  };
  JsonRpcProvider.prototype.getStorage = async function () {
    return "0x" + "00".repeat(32);        // proxy نیست
  };
  JsonRpcProvider.prototype.call = async function (tx) {
    if (tx.to.toLowerCase() !== MC3) throw new Error("unexpected target");
    const outer = unpack(tx.data);
    const calls = outer.args[0];
    const results = calls.map(([target, allowFail, data]) => {
      const c = unpack(data);
      const t = target.toLowerCase();
      if (NOCODE.includes(t)) return [false, "0x"];
      try {
        if (V3_QUOTERS[t] && c.name === "quoteExactInputSingle") {
          const [tin, tout, amt, fee] = c.args[0];
          const o = amm(venueKeyV3(V3_QUOTERS[t], Number(fee)), tin, tout, amt);
          if (o === null) return [false, "0x"];
          return [true, pack([o, 0n, 0, 0n])];
        }
        if (t === AERO_R && c.name === "getAmountsOut") {
          const amt = c.args[0], routes = c.args[1];
          const [from, to, stable] = routes[0];
          const o = amm(venueKeySolidly(!!stable), from, to, amt);
          if (o === null) return [false, "0x"];
          return [true, pack([[amt, o]])];
        }
        if (c.name === "balanceOf") {
          const d = DEC[t] || 18;
          return [true, pack([2500n * 10n ** BigInt(d)])];
        }
        // allowance قابل تنظیم است تا تست بتواند «کاربر approve کرده» و
        // «نکرده» را از هم جدا کند. پیش‌فرض همان صفرِ قبلی است.
        if (c.name === "allowance")
          return [true, pack([window.__STUB_ALLOWANCE__ === undefined ? 0n : window.__STUB_ALLOWANCE__])];
        if (c.name === "totalSupply") return [true, pack([10n ** 24n])];
        if (c.name === "owner") return [true, pack(["0x1111111111111111111111111111111111111111"])];
        if (c.name === "token0") return [true, pack([T.WETH])];
        // هر (توکن، مرجع، tier/stable) باید آدرس *متفاوتی* بدهد، چون روی
        // زنجیره‌ی واقعی هم همین‌طور است. نسخه‌ی قبل برای همه یک آدرس ثابت
        // برمی‌گرداند؛ نتیجه این بود که measureLiquidity یک استخر را چند بار
        // می‌شمرد و هیچ تستی متوجه نمی‌شد.
        if (c.name === "getPool" || c.name === "getPair") {
          const key = target + "|" + JSON.stringify(c.args);
          return [true, pack(["0x" + fakeId(key).slice(2, 42)])];
        }
        if (c.name === "symbol")   return [true, pack([symOf(target)])];
        if (c.name === "name")     return [true, pack(["Test Token"])];
        if (c.name === "decimals") return [true, pack([DEC[t] || 18])];
        if (t === EXEC && c.name === "feeBps") return [true, pack([0n])];
        if (t === EXEC && c.name === "allowedRouter") return [true, pack([true])];
      } catch (e) { /* fallthrough */ }
      return [false, "0x"];
    });
    return pack([results]);
  };

  function BrowserProvider() {}
  function Contract() {}

  function formatUnits(v, d) {
    d = Number(d); const neg = v < 0n; if (neg) v = -v;
    const s = v.toString().padStart(d + 1, "0");
    const i = s.slice(0, s.length - d), f = d ? s.slice(s.length - d).replace(/0+$/, "") : "";
    return (neg ? "-" : "") + (f ? i + "." + f : i);
  }
  function parseUnits(s, d) {
    d = Number(d); const [i, f = ""] = String(s).split(".");
    return BigInt(i + (f + "0".repeat(d)).slice(0, d));
  }

  /* ---------------- fake GeckoTerminal ----------------
     مسیر قیمت قطعی (بدون تصادف) تا اسکرین‌شات‌ها قابل تکرار بمانند. */
  const realFetch = window.fetch && window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    if (!u.includes("api.geckoterminal.com")) {
      if (realFetch) return realFetch(url, opts);
      throw new Error("offline");
    }
    const ok = body => ({ ok: true, status: 200, json: async () => body });

    // اطلاعات توکن (برای لوگو) — یک PNG یک‌پیکسلی به‌صورت data URI
    if (/\/trades/.test(u)) {
      const now = Date.now();   // نسبت به زمان واقعی، تا داخل پنجره‌ی ۱ ساعته بیفتد
      const mk = (kind, usd, minsAgo) => ({ attributes: {
        kind, volume_in_usd: String(usd),
        block_timestamp: new Date(now - minsAgo * 60000).toISOString(),
        tx_hash: "0x" + "ab".repeat(32),
        tx_from_address: "0x" + (kind === "buy" ? "11" : "22").repeat(20) } });
      return ok({ data: [
        mk("buy", 42000, 4), mk("sell", 12000, 9), mk("buy", 18500, 17),
        mk("buy", 9100, 28), mk("sell", 30500, 41), mk("buy", 6400, 52),
        mk("sell", 2200, 300), mk("buy", 155000, 700) ] });
    }
    if (/\/tokens\/multi\//.test(u)) {
      const addrs = u.split("/multi/")[1].split("?")[0].split(",");
      return ok({ data: addrs.map(a => ({ attributes: {
        address: a, price_usd: "1908.85",
        image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" } })) });
    }
    if (/\/tokens\/0x[0-9a-fA-F]{40}$/.test(u)) {
      return ok({ data: { attributes: { price_usd: "1908.85", image_url:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" } } });
    }
    if (/\/tokens\/.+\/pools/.test(u)) {
      // GeckoTerminal فقط آدرس قرارداد می‌شناسد. تا امروز این ماک *هر*
      // رشته‌ای را یک توکن معتبر جا می‌زد، و برای همین باگ ETH بومی را
      // پنهان کرده بود: آدرس ETH در جدول ما "NATIVE" است، سرویس واقعی
      // ۴۰۴ می‌داد و کل نمودار می‌افتاد، ولی تست سبز بود.
      const who = u.split("/tokens/")[1].split("/")[0];
      if (!/^0x[0-9a-fA-F]{40}$/.test(who))
        return { ok: false, status: 404, json: async () => ({}) };
      return ok({ data: [{ id: "base_0x" + "cd".repeat(20) }] });
    }
    if (/\/ohlcv\//.test(u)) {
      const m = u.match(/limit=(\d+)/);
      const n = m ? Math.min(300, +m[1]) : 96;
      const step = 900;                     // ۱۵ دقیقه
      const t0 = 1785000000 - n * step;
      const list = [];
      for (let i = 0; i < n; i++) {
        const base = 1900;
        const c = base
          + Math.sin(i / 9) * 42
          + Math.sin(i / 3.3) * 11
          + i * 0.55;                       // روند ملایم صعودی
        list.push([t0 + i * step, c, c * 1.004, c * 0.996, c, 1e6]);
      }
      return ok({ data: { attributes: { ohlcv_list: list } } });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  window.ethers = {
    Interface, JsonRpcProvider, BrowserProvider, Contract,
    getAddress: a => a,
    id: fakeId,
    formatUnits, parseUnits,
    MaxUint256: (1n << 256n) - 1n,
  };
  window.__STUB_READY__ = true;
})();
