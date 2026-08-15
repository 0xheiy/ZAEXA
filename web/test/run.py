import asyncio, os, re, sys
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
def build_harness():
    """harness = index.html با لودر ethers که به stub محلی اشاره می‌کند."""
    src = open(os.path.join(HERE, "..", "index.html"), encoding="utf-8").read()
    a = src.index("const ETHERS_CDNS=[")
    b = src.index("];", a) + 2
    out = src[:a] + 'const ETHERS_CDNS=["./stub-ethers.js"];' + src[b:]
    path = os.path.join(HERE, "harness.html")
    open(path, "w", encoding="utf-8").write(out)
    return path

URL = "file://" + build_harness()

def check_no_remote_code():
    """ethers باید از کنار index.html بیاید، نه از CDN.

    این یک تست رابط نیست، یک تست زنجیره‌ی تأمین است: هر اسکریپتی که از
    بیرون بارگذاری شود، کیف پول کاربر و مقصد تراکنش را در اختیار دارد.
    اگر روزی کسی برای «مطمئن‌تر شدن» یک fallback به CDN برگرداند، همین‌جا
    گیر می‌افتد."""
    src = open(os.path.join(HERE, "..", "index.html"), encoding="utf-8").read()
    a = src.index("const ETHERS_CDNS=[")
    decl = src[a:src.index("];", a) + 2]
    assert "http://" not in decl and "https://" not in decl, \
        "ethers must not be loaded from a remote origin:\n" + decl
    vendored = os.path.join(HERE, "..", "ethers.umd.min.js")
    assert os.path.exists(vendored), "ethers.umd.min.js is missing next to index.html"
    print("[supply chain] ethers is vendored (%.0f KB), no remote script tags"
          % (os.path.getsize(vendored) / 1024))

check_no_remote_code()

async def main():
    errors = []
    # خطاهایی که یک کاوشگر *عمداً* تولید می‌کند. اجازه‌ی عبور می‌گیرند ولی
    # جمع می‌شوند تا همان کاوشگر بتواند ادعا کند واقعاً رخ داده‌اند — وگرنه
    # allowlist فقط یک راه بی‌صدا برای پنهان‌کردن خطا می‌شد.
    gate_errs = []

    def on_console(m):
        if m.type != "error":
            return
        (gate_errs if "[zaexa] gate check failed" in m.text else errors).append(m.text)

    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1240, "height": 1000}, color_scheme="dark")
        pg.on("console", on_console)
        pg.on("pageerror", lambda e: errors.append(f"PAGEERROR {e}"))
        await pg.goto(URL)
        await pg.wait_for_timeout(900)

        # ---- 0-pre. چک‌سام EIP-55 هر آدرسی که در کد نوشته‌ایم ----
        # چرا با ethers *واقعی* و نه با استاب: در stub-ethers.js تابع getAddress
        # عملاً `a => a` است و هیچ اعتبارسنجی نمی‌کند. یعنی همان چیزی که باید
        # این باگ را می‌گرفت، خودش پنهانش کرده بود — کوتر پنکیک با `cEF` به‌جای
        # `CeF` نوشته شده بود و روی سایت زنده «شبکه جواب نداد» گزارش می‌شد.
        # ماک باید واقعیت را آینه کند؛ جایی که نمی‌تواند، با نسخه‌ی واقعی بسنج.
        src_all = open(os.path.join(HERE, "..", "index.html"), encoding="utf-8").read()
        cands = sorted(set(re.findall(r"0x[0-9a-fA-F]{40}", src_all)))
        chk = await b.new_page()
        await chk.set_content("<html></html>")
        await chk.add_script_tag(path=os.path.join(HERE, "..", "ethers.umd.min.js"))
        bad = await chk.evaluate(
            "list => list.filter(a => { try { ethers.getAddress(a); return false; }"
            " catch { return true; } })", cands)
        await chk.close()
        print("[checksum] %d addresses in index.html, %d with a bad EIP-55 checksum"
              % (len(cands), len(bad)))
        assert not bad, ("these addresses are written with the wrong capitalisation, so "
                         "ethers rejects them before any call is made: %s" % bad)

        assert await pg.inner_text("#tokInSym") == "USDC"
        assert await pg.inner_text("#tokOutSym") == "WETH"

        # ---- 0. price chart ----
        await pg.wait_for_selector("#plot svg", timeout=15000)
        pts = await pg.eval_on_selector_all("#plot svg path", "els => els.length")
        print("[chart] %s  %s  (%s svg paths)" % (
            await pg.inner_text("#pairName"), await pg.inner_text("#pxNow"), pts))
        print("        change: %s" % await pg.inner_text("#pxChg"))
        assert pts >= 2, "chart line + fill missing"
        assert "\u2014" not in await pg.inner_text("#pxNow"), "no headline price"
        box = await (await pg.query_selector("#plot svg")).bounding_box()
        await pg.mouse.move(box["x"] + box["width"] * 0.62, box["y"] + box["height"] * 0.5)
        await pg.wait_for_timeout(250)
        assert await pg.eval_on_selector("#tip", "e => getComputedStyle(e).opacity") == "1", "crosshair tooltip did not show"
        print("[chart] tooltip: %s" % (await pg.inner_text("#tip")).replace("\n", " "))
        for tf in ("1W", "1H"):
            await pg.click(f'#tfs [data-tf="{tf}"]'); await pg.wait_for_timeout(700)
            assert await pg.query_selector("#plot svg"), f"chart broke on {tf}"
        await pg.click('#tfs [data-tf="1D"]'); await pg.wait_for_timeout(600)

        # ---- 1. quote + venue comparison table ----
        await pg.fill("#amtIn", "1000")
        await pg.wait_for_function("() => document.getElementById('amtOut').value !== ''", timeout=20000)
        print("[quote 1000 USDC] out=%s  rate=%s  impact=%s  min=%s" % (
            await pg.input_value("#amtOut"), await pg.inner_text("#kRate"),
            await pg.inner_text("#kImpact"), await pg.inner_text("#kMin")))
        print("[venues] %s" % await pg.inner_text("#venueMeta"))
        # ردیف «نسبت به یونی‌سواپ» — ادعای رقابتی محصول، پس باید صادق بماند
        print("[vs uniswap] %s  (tip: %s)" % (
            await pg.inner_text("#kVs"),
            (await pg.get_attribute("#vsRow", "title") or "")[:80]))
        vs = await pg.inner_text("#kVs")
        assert vs in ("same", "—") or vs.startswith("+") or vs.startswith("-"), \
            "unexpected comparison value: " + vs
        assert vs != "+0.00%", "a zero difference must read as 'same', not as a win"

        # همان ردیف، در دو حالتی که دستی نمی‌شود به آن رسید
        async def vs_probe(mutator):
            return await pg.evaluate("""(m) => {
                const saved = lastDirect;
                lastDirect = lastDirect.map(r =>
                    r.venue && r.venue.dex.id === "uniswap-v3"
                        ? (m === "worse" && r.out ? Object.assign({}, r, {out: (r.out * 99n) / 100n})
                                                  : Object.assign({}, r, {out: null, status: "unknown"}))
                        : r);
                renderVsUniswap(currentPlan);
                const out = {v: document.getElementById("kVs").innerText,
                             t: document.getElementById("vsRow").title};
                lastDirect = saved; renderVsUniswap(currentPlan);
                return out;
            }""", mutator)

        r = await vs_probe("worse")
        print("[vs uniswap:cheaper-elsewhere] %s" % r["v"])
        assert r["v"].startswith("+") and float(r["v"].rstrip("%")) > 0.5, \
            "a real edge over Uniswap must be shown: " + r["v"]
        assert "gas" in r["t"].lower(), "the gas caveat must travel with the claim"

        r = await vs_probe("unknown")
        print("[vs uniswap:uniswap-silent] %s" % r["v"])
        assert r["v"] == "unknown", \
            "with no Uniswap quote we cannot claim an edge: " + r["v"]
        rows = await pg.eval_on_selector_all(
            "#venueBody .vrow", "els => els.map(e => e.innerText.replace(/\\n+/g, ' | '))")
        for r in rows:
            print("        ", r)
        assert any("best" in r.lower() for r in rows), "no best venue marked"
        assert any("no pool" in r for r in rows), "empty pools must be shown, not hidden"
        # هر دو نسل V3 باید در جدول باشند. پنکیک نسل اول است (0x414bf389) و
        # قبلاً با kind=V3 ثبت شده بود، یعنی به تابعی صدا زده می‌شد که ندارد.
        assert any("PancakeSwap" in r for r in rows), \
            "a legacy-generation V3 DEX must be quoted like any other V3"

        # ---- 2. safety panel (scanner.py port) ----
        await pg.wait_for_selector("#safetyBody .rhead", timeout=20000)
        print("[safety] %s | %s" % (
            await pg.inner_text("#safetyBody .rv"),
            (await pg.inner_text("#safetyBody .rs")).replace("\n", " ")))
        checks = await pg.eval_on_selector_all(
            "#safetyBody .chk", "els => els.filter(e => e.querySelector('b')).map(e => e.className + ': ' + e.querySelector('b').innerText)")
        for c in checks:
            print("        ", c)
        assert any("Fee is mutable" in c for c in checks), "bytecode selector scan did not fire"

        # ---- 2b. exit check (round-trip) ----
        await pg.wait_for_selector("#exitBox .exit", timeout=20000)
        print("[exit] %s | %s" % (
            await pg.inner_text("#exitBox .exitTtl"),
            await pg.inner_text("#exitBox .exitBadge")))
        print("      %s" % (await pg.inner_text("#exitBox")).replace("\n", " ")[:190])
        assert "estimated" in (await pg.inner_text("#exitBox .exitBadge")).lower(), \
            "with no wallet the exit check must be labelled an estimate, not a proof"
        await pg.screenshot(path=os.path.join(HERE, "shot-desk.png"), full_page=True)

        # ---- 2b-bis. THE exit-check regression test --------------------
        # پس‌زمینه: در اسکرین‌شات ۹ آگوست، USDC قرمز شد با
        # «SELL SIMULATION REVERTED — transferFrom failed»، در حالی که همان
        # پنل می‌گفت Sellable و round-trip صفر درصد. علت، توکن نبود: قرارداد
        # نتوانسته بود توکن را از کیف پول بکشد. یعنی یک مشکل پیش‌شرطِ سمت ما
        # به‌عنوان حکم علیه توکن نمایش داده شد — «نمی‌دانم» در نقش «نه».
        # این چهار حالت مرز را قفل می‌کنند.
        EXIT_PROBE = """async ([msg, alw, down]) => {
            const realContract = E.Contract;
            const realCall = readProvider.call.bind(readProvider);
            window.__STUB_ALLOWANCE__ = BigInt(alw);
            account = "0x8A0Dcb583C8CAdc481E34487c34f1B856fe97e23";
            signer = {}; walletChainId = CHAIN.id;
            balances[balKey(tokenIn)] = 10n ** 30n;   // state کش‌شده: کافی
            allowance = 10n ** 30n;                   // state کش‌شده: کافی
            E.Contract = function () {
                return { executeSwap: { staticCall: async () => { throw new Error(msg); } } };
            };
            if (down) readProvider.call = async () => { throw new Error("fetch failed"); };
            let res = null;
            try {
                res = await runExitCheck(currentPlan, parsedAmountIn());
                renderExit(res);
            } finally {
                E.Contract = realContract;
                readProvider.call = realCall;
            }
            return { state: res && res.state, reason: res && res.reason,
                     badge: document.querySelector("#exitBox .exitBadge").innerText,
                     title: document.querySelector("#exitBox .exitTtl").innerText };
        }"""

        async def exit_case(label, msg, allowance="0", down=False):
            r = await pg.evaluate(EXIT_PROBE, [msg, allowance, down])
            print("[exit:%s] state=%s  title=%r" % (label, r["state"], r["title"]))
            print("          %s" % (r["reason"] or "")[:120])
            return r

        BIG = str(10 ** 30)
        NEVER = "You may not be able to sell this back"

        # الف) همان باگ اسکرین‌شات: revert چون کیف پول approve نکرده.
        r = await exit_case("no-approval", 'execution reverted: "transferFrom failed"', allowance="0")
        assert r["state"] == "estimated", "a missing approval must not read as a verdict on the token"
        assert NEVER not in r["title"], "screenshot bug is back: " + r["title"]
        assert "approve" in (r["reason"] or "").lower()

        # ب) کیف پول approve کرده و باز هم revert → این بار واقعاً سیگنال توکن است.
        r = await exit_case("honeypot", 'execution reverted: "Blacklisted"', allowance=BIG)
        assert r["state"] == "blocked", "a real sell-side revert must still be reported"
        assert NEVER in r["title"]

        # ج) حتی با پیام transferFrom، اگر پیش‌شرط‌ها برقرارند revert مال توکن است.
        #     (رگرسیون نسخه‌ی قبل که فقط رشته را تطبیق می‌داد و اینجا کور بود.)
        r = await exit_case("hostile-msg", 'execution reverted: "transferFrom failed"', allowance=BIG)
        assert r["state"] == "blocked", "message matching must not excuse a genuine revert"

        # د) شبکه جواب نداد → «نمی‌دانم»، هرگز «نه».
        r = await exit_case("rpc-down", "fetch failed", allowance=BIG, down=True)
        assert r["state"] == "unknown", "an outage must never be reported as a verdict"
        assert NEVER not in r["title"], "outage reported as unsellable: " + r["title"]

        # پاک کردن کیف پول ساختگی تا تست‌های بعدی حالت «بدون کیف پول» ببینند
        await pg.evaluate("""() => {
            account = null; signer = null; walletChainId = null;
            balances = {}; allowance = 0n; delete window.__STUB_ALLOWANCE__;
        }""")
        await pg.fill("#amtIn", "1000")
        await pg.wait_for_timeout(2500)

        # ---- 2b-ter. shareable quote link ----
        # وضعیت باید در URL برود و برگردد، بدون بک‌اند. و مهم‌تر: لینکی که
        # توکن ناشناس دارد نباید بی‌صدا روی پیش‌فرض بنشیند.
        url = await pg.evaluate("() => shareUrl()")
        print("[share] %s" % url.split("#")[-1])
        assert "in=USDC" in url and "out=WETH" in url and "amt=1000" in url, url

        applied = await pg.evaluate("""async () => {
            location.hash = "swap?in=WETH&out=USDC&amt=2";
            await applyShareParams();
            return {inSym: document.getElementById("tokInSym").innerText,
                    outSym: document.getElementById("tokOutSym").innerText,
                    amt: document.getElementById("amtIn").value};
        }""")
        print("[share] round trip -> %s -> %s  amt=%s" % (
            applied["inSym"], applied["outSym"], applied["amt"]))
        assert applied["inSym"] == "WETH" and applied["outSym"] == "USDC" and applied["amt"] == "2", applied

        bad = await pg.evaluate("""async () => {
            location.hash = "swap?in=USDC&out=0x000000000000000000000000000000000000dEaD&amt=5";
            await applyShareParams();
            return {outSym: document.getElementById("tokOutSym").innerText,
                    notice: document.getElementById("notices").innerText};
        }""")
        print("[share] hostile link -> out=%s | %s" % (bad["outSym"], bad["notice"].replace("\n", " ")[:90]))
        assert "could not be opened" in bad["notice"].lower(), \
            "a link with a token we cannot verify must say so, not fall back silently"

        # برگشت به حالت اول برای بقیه‌ی تست‌ها
        await pg.evaluate("""async () => {
            location.hash = "swap?in=USDC&out=WETH&amt=1000";
            await applyShareParams();
        }""")
        await pg.wait_for_timeout(2500)

        # ---- 2b-quater. exit-check result carried into the token picker ----
        # فقط چیزی که همین جلسه واقعاً بررسی شده نشان داده می‌شود؛ پیکر
        # هیچ بررسی تازه‌ای اجرا نمی‌کند.
        await pg.click("#tokOutBtn"); await pg.wait_for_timeout(300)
        badges = await pg.eval_on_selector_all(
            "#tokList .trow",
            "els => els.map(e => { const b = e.querySelector('.xb');"
            " return {sym: e.querySelector('.s').innerText, badge: b ? b.innerText : null,"
            "         tip: b ? b.title : null}; })")
        shown = [row for row in badges if row["badge"]]
        for row in shown:
            print("[picker] %-6s %-9s %s" % (row["sym"], row["badge"], row["tip"]))
        assert shown, "the token we just checked must carry its result into the picker"
        assert all("checked" in row["tip"] for row in shown), "a cached result must always show its age"
        unchecked = [row for row in badges if not row["badge"]]
        assert unchecked, "tokens we never checked must have no badge at all — absence means unknown, not safe"
        await pg.keyboard.press("Escape"); await pg.wait_for_timeout(250)

        # یک نتیجه‌ی منفی هم باید تا پیکر برسد
        await pg.evaluate("""() => {
            exitCache[balKey(tokenOut)] = {state: "blocked", lossPct: null, at: Date.now()};
        }""")
        await pg.click("#tokOutBtn"); await pg.wait_for_timeout(300)
        neg = await pg.eval_on_selector_all(
            "#tokList .trow .xb", "els => els.map(e => e.innerText)")
        print("[picker] after a blocked result: %s" % neg)
        assert any("no exit" in n for n in neg), "a blocked exit must be visible in the picker"
        await pg.keyboard.press("Escape"); await pg.wait_for_timeout(250)

        # ---- 2b-quinquies. findings from the line-by-line review ----
        # الف) نماد توکن نباید به‌عنوان markup اجرا شود. توکن مهاجم می‌تواند
        #      هر رشته‌ای را از symbol() برگرداند و لینک اشتراکی آن را انتخابی کند.
        xss = await pg.evaluate("""() => {
            const saved = tokenOut;
            tokenOut = Object.assign({}, tokenOut, {symbol: '<img src=x onerror=window.__PWNED__=1>'});
            renderVenues(lastDirect, currentPlan);
            const html = document.getElementById("venueBody").innerHTML;
            const imgs = document.querySelectorAll("#venueBody img").length;
            tokenOut = saved; renderVenues(lastDirect, currentPlan);
            return {pwned: !!window.__PWNED__, imgs, escaped: html.includes("&lt;img")};
        }""")
        print("[xss] injected symbol -> imgs=%s pwned=%s escaped=%s"
              % (xss["imgs"], xss["pwned"], xss["escaped"]))
        assert xss["imgs"] == 0 and not xss["pwned"], "token symbol reached the DOM as markup"

        # ب) hash بدشکل نباید راه‌اندازی را بیندازد
        broken = await pg.evaluate("""() => {
            const h = location.hash;
            location.hash = "%";
            let ok = true;
            try { parseHash(); } catch (e) { ok = false; }
            location.hash = h;
            return ok;
        }""")
        print("[hash] malformed '#%%' survived: %s" % broken)
        assert broken, "a malformed hash must not throw — it runs during init"

        # ج) کوت فروش که نیامده، هانی‌پات نیست
        verdict = await pg.evaluate("""async () => {
            const real = quoteMany;
            let call = 0;
            quoteMany = async (specs, stats) => {
                call++;
                if (call === 1) return real(specs, stats);          // خرید: سالم
                stats.attempted += specs.length;                     // فروش: شبکه نداد
                stats.rpcFailed += specs.length;
                return specs.map(() => ({out: null, status: "unknown"}));
            };
            const t = await checkTradability(tokenOut);
            quoteMany = real;
            return t;
        }""")
        print("[tradability] buy ok, sell silent -> %s" % verdict)
        assert verdict["unknown"], "a failed sell quote must be flagged unknown, not as a honeypot"

        # د) allowance خوانده‌نشده نباید «approve نکرده» تفسیر شود
        btn = await pg.evaluate("""() => {
            const savedAcc = account, savedPlan = currentPlan;
            account = "0x8A0Dcb583C8CAdc481E34487c34f1B856fe97e23";
            walletChainId = CHAIN.id;
            balances[balKey(tokenIn)] = 10n ** 30n;
            allowance = 0n; allowanceKnown = false;      // یعنی: نخواندیم
            refreshButton();
            const label = document.getElementById("actBtn").textContent;
            account = savedAcc; walletChainId = null; balances = {}; currentPlan = savedPlan;
            refreshButton();
            return label;
        }""")
        print("[allowance] unread allowance -> button says %r" % btn)
        assert "Approve" not in btn, \
            "an unread allowance must not push the user into a needless approval"

        # ه) قیمت مرجع نامعلوم نباید «نقدینگی صفر» شود
        liq = await pg.evaluate("""async () => {
            const real = refPriceUsd, cached = _ethUsd;
            _ethUsd = null;
            refPriceUsd = async () => null;          // قیمت ETH خوانده نشد
            // توکنی که استخرهایش با WETH جفت شده‌اند — برای WETH خودش،
            // مرجع فقط USDC است و قیمت ETH اصلاً وارد محاسبه نمی‌شود.
            const t = BASE_TOKENS.find(x => x.symbol === "AERO");
            const v = await measureLiquidity(t);
            refPriceUsd = real; _ethUsd = cached;
            return v;
        }""")
        print("[liquidity] ETH price unknown -> %s" % liq)
        assert liq is None, \
            "an unknown ETH price must read as unknown, not as $0 of liquidity"

        # و) approve باید پیش‌فرض دقیق باشد، نه نامحدود
        appr = await pg.evaluate("""() => {
            let seen = null;
            const real = E.Contract;
            E.Contract = function () {
                return {approve: async (spender, amt) => {
                    seen = amt.toString();
                    return {hash: "0x" + "11".repeat(32), wait: async () => ({status: 1})};
                }};
            };
            const want = parsedAmountIn();
            const exact = (typeof unlimitedApprove !== "undefined") && !unlimitedApprove;
            E.Contract = real;
            return {exact, want: want.toString(), max: E.MaxUint256.toString()};
        }""")
        print("[approve] exact-by-default=%s" % appr["exact"])
        assert appr["exact"], "unlimited approval must not be the default"

        # ز) «مسیری نیست» فقط وقتی همه جواب داده باشند قطعی گفته شود
        note_txt = await pg.evaluate("""() => {
            const el = document.createElement("div");
            el.innerHTML = noRouteNote({attempted: 18, ok: 14, noPool: 0, rpcFailed: 4}, "detail here");
            return el.innerText;
        }""")
        print("[no route] partial data -> %s" % note_txt.replace("\n", " ")[:100])
        assert "not a complete picture" in note_txt, \
            "with venues that did not answer we cannot claim there is no route"

        clean = await pg.evaluate("""() => {
            const el = document.createElement("div");
            el.innerHTML = noRouteNote({attempted: 18, ok: 18, noPool: 18, rpcFailed: 0}, "detail here");
            return el.innerText;
        }""")
        assert "not a complete picture" not in clean, \
            "with full data the plain 'No route' wording should stand"

        # ح) ETH ↔ WETH باید wrap/unwrap بدهد، نه بن‌بست
        wrapui = await pg.evaluate("""async () => {
            const savedIn = tokenIn, savedOut = tokenOut, savedAcc = account, savedChain = walletChainId;
            account = "0x8A0Dcb583C8CAdc481E34487c34f1B856fe97e23";
            walletChainId = CHAIN.id;
            tokenIn  = BASE_TOKENS.find(t => t.symbol === "ETH");
            tokenOut = BASE_TOKENS.find(t => t.symbol === "WETH");
            balances[balKey(tokenIn)] = 10n ** 20n;
            document.getElementById("amtIn").value = "1";
            const dir = wrapDirection();
            refreshButton();
            const label = document.getElementById("actBtn").textContent;
            const disabled = document.getElementById("actBtn").disabled;
            tokenIn = savedIn; tokenOut = savedOut; account = savedAcc;
            walletChainId = savedChain; balances = {}; refreshButton();
            return {dir, label, disabled};
        }""")
        print("[wrap] ETH -> WETH  dir=%s  button=%r disabled=%s"
              % (wrapui["dir"], wrapui["label"], wrapui["disabled"]))
        assert wrapui["dir"] == "wrap", "ETH -> WETH must be recognised as a wrap"
        assert "Wrap" in wrapui["label"] and not wrapui["disabled"], \
            "the app must offer a working wrap, not point at a button that does not exist"

        # ط) قطع اتصال باید وضعیت را واقعاً پاک کند
        dis = await pg.evaluate("""() => {
            account = "0x8A0Dcb583C8CAdc481E34487c34f1B856fe97e23";
            walletChainId = CHAIN.id; balances["native"] = 5n; allowanceKnown = true;
            disconnect();
            return {account, allowanceKnown, balances: Object.keys(balances).length,
                    button: document.getElementById("connectBtn").textContent};
        }""")
        print("[disconnect] account=%s balances=%s button=%r"
              % (dis["account"], dis["balances"], dis["button"]))
        assert dis["account"] is None and dis["balances"] == 0 and not dis["allowanceKnown"], \
            "disconnect must clear wallet state, not just the label"
        assert dis["button"] == "Connect wallet"

        # ی) «نمی‌دانم» نباید در امتیاز ریسک جریمه شود
        risk = await pg.evaluate("""() => {
            const base = {findings: [], owner: null, isProxy: false, liqUsd: 100000,
                          canBuy: null, canSell: null, unknown: 1};
            const unknownScore = riskScore(Object.assign({}, base));
            const knownBad = riskScore(Object.assign({}, base, {canSell: false}));
            const knownGood = riskScore(Object.assign({}, base, {canSell: true}));
            return {unknownScore, knownBad, knownGood};
        }""")
        print("[risk] unknown=%s  known-unsellable=%s  known-sellable=%s"
              % (risk["unknownScore"], risk["knownBad"], risk["knownGood"]))
        assert risk["unknownScore"] == risk["knownGood"], \
            "an unknown sell test must not be scored as if the token failed it"
        assert risk["knownBad"] > risk["unknownScore"], \
            "a token we know cannot be sold must still be penalised"

        # ک) دکمه‌ی گزارش مشکل باید به ایمیل واقعی برود
        mail = await pg.evaluate("() => LINKS.email")
        print("[contact] %s" % mail)
        assert "@" in mail and "example" not in mail, "contact address must be real"

        # ل) ارسالی که هرگز برنمی‌گردد نباید دکمه را تا ابد بچرخاند
        stuck = await pg.evaluate("""async () => {
            // promiseای که هیچ‌وقت resolve نمی‌شود = دقیقاً همان چیزی که
            // روی سایت واقعی اتفاق افتاد: تراکنش رفت، جواب نیامد.
            const never = new Promise(() => {});
            const t0 = Date.now();
            const r = await sendOrLoseTrack(never, 300);
            return {result: r, ms: Date.now() - t0};
        }""")
        print("[stuck send] returned %s after %sms" % (stuck["result"], stuck["ms"]))
        assert stuck["result"] is None and stuck["ms"] < 3000, \
            "a send that never answers must time out, not spin forever"

        # و شکست واقعی نباید با «نمی‌دانم» قاطی شود
        real = await pg.evaluate("""async () => {
            try {
                await sendOrLoseTrack(Promise.reject(new Error("user rejected")), 5000);
                return "no throw";
            } catch (e) { return e.message; }
        }""")
        print("[stuck send] a real rejection still throws: %r" % real)
        assert real == "user rejected", \
            "a genuine failure must propagate, not be swallowed as unknown"

        # م) خطای HTTP از RPC نباید «قرارداد رد کرد» خوانده شود
        #    ethers برای 403/429 هم CALL_EXCEPTION می‌گذارد و پیامش
        #    «missing revert data» است — عیناً شبیه یک revert واقعی.
        transport = await pg.evaluate("""() => {
            const blocked = Object.assign(new Error("missing revert data"),
                {code: "CALL_EXCEPTION", data: "Request failed with status code 403"});
            const real = Object.assign(new Error('execution reverted: "Blacklisted"'),
                {code: "CALL_EXCEPTION"});
            return {
                blockedIsRevert: isRevert(blocked),
                blockedText: friendly(blocked),
                realIsRevert: isRevert(real),
                realText: friendly(real),
            };
        }""")
        print("[transport] 403 -> isRevert=%s | %s"
              % (transport["blockedIsRevert"], transport["blockedText"][:70]))
        print("[transport] real revert -> isRevert=%s | %s"
              % (transport["realIsRevert"], transport["realText"][:50]))
        assert transport["blockedIsRevert"] is False, \
            "an HTTP 403 from the RPC is not a revert — we never reached the chain"
        assert "could not reach" in transport["blockedText"].lower(), transport["blockedText"]
        assert "router" not in transport["blockedText"].lower(), \
            "do not blame the router for a network we never reached"
        assert transport["realIsRevert"] is True, \
            "a genuine revert must still be treated as one"

        # ---- 2c. DEX coverage gate ----
        cov = await pg.inner_text("#coverage")
        print("[coverage] %s" % cov.replace("\n", " | "))
        assert "Routing through" in cov
        assert "no contract" in cov, "unverified DEXes must be shown with a reason, not hidden"
        assert "PancakeSwap" not in cov, "PancakeSwap should now pass the gates, not sit in the excluded list"

        # ---- 2c-bis. every DEX is called with the signature its router actually has ----
        gens = await pg.evaluate(
            "() => DEXES.map(d => ({name: d.name, kind: d.kind, sig: swapSigOf(d),"
            " ok: !!(dexStatus[d.id] && dexStatus[d.id].ok)}))")
        for g in gens:
            print("[dex] %-16s kind=%s ok=%-5s %s" % (g["name"], g["kind"], g["ok"], g["sig"][:46]))
        pcs = next(g for g in gens if "PancakeSwap" in g["name"])
        assert pcs["ok"], "PancakeSwap must pass the gates once wired as legacy V3"
        assert "uint256,uint256,uint256,uint160" in pcs["sig"], \
            "a legacy router must be called with the 8-field struct, not the 7-field one"
        uni = next(g for g in gens if g["name"] == "Uniswap V3")
        assert "uint256,uint256,uint160)" in uni["sig"] and "uint256,uint256,uint256" not in uni["sig"], \
            "SwapRouter02 must keep the 7-field struct"

        # ---- 2c-ter. the quoter gate checks the selector, not just that code exists ----
        # نسخه‌ی قبل فقط می‌پرسید «قراردادی آنجا هست؟» — همان شکافی که در سمت
        # روتر باگ SwapRouter02 را ساخت، فقط یک قدم آن‌طرف‌تر.
        reason = await pg.evaluate("""async () => {
            const d = DEXES.find(x => x.id === "uniswap-v3"), real = d.quoter;
            d.quoter = d.router;              // قرارداد هست، ولی تابع کوت را ندارد
            await verifyDexes();
            const r = dexStatus["uniswap-v3"].reason;
            d.quoter = real; await verifyDexes();
            return r;
        }""")
        print("[quoter gate] %s" % reason)
        assert "quoter" in reason.lower(), \
            "a quoter that lacks the function we call must be rejected: " + reason

        # ---- 2c-quater. «نتوانستیم بپرسیم» یک حالت است، نه یک جمله ----
        # قبلاً تنها نشانه‌اش متن reason بود و حلقه‌ی retry با مقایسه‌ی همان
        # رشته تصمیم می‌گرفت؛ و هر خطای غیرشبکه‌ای هم «could not reach the
        # network» گزارش می‌شد — یعنی «نمی‌دانم چرا» به کاربر به‌شکل یک علت
        # قطعیِ غلط می‌رسید. سه ادعا:
        gate = await pg.evaluate("""async () => {
            const pcs = DEXES.find(d => d.id === "pancake-v3");

            // الف) خطای غیرشبکه‌ای: آدرس بدچک‌سام، بیرون از rpcSend
            const realGA = ethers.getAddress;
            ethers.getAddress = a => {
                if (String(a).toLowerCase() === pcs.router.toLowerCase())
                    throw new Error("bad address checksum");
                return realGA(a);
            };
            await verifyDexes();
            const ours = Object.assign({}, dexStatus["pancake-v3"]);
            ethers.getAddress = realGA;
            await verifyDexes();

            // ب) خطای انتقال: همان 403 که ethers CALL_EXCEPTION علامتش می‌زند
            const realCode = ethers.JsonRpcProvider.prototype.getCode;
            verifyTries = 3;                    // جلوی تایمر retry واقعی
            ethers.JsonRpcProvider.prototype.getCode = async () => {
                throw Object.assign(new Error("missing revert data"),
                    {code: "CALL_EXCEPTION", data: "Request failed with status code 403"});
            };
            await verifyDexes();
            const down = Object.assign({}, dexStatus["pancake-v3"]);
            ethers.JsonRpcProvider.prototype.getCode = realCode;
            verifyTries = 0;
            await verifyDexes();

            // ج) تلاش دوباره‌ی نقطه‌ای نباید صرافی سالم را قربانی کند
            const uniBefore = dexStatus["uniswap-v3"].ok;
            await verifyDexes([pcs]);
            return {ours, down, uniBefore, uniAfter: dexStatus["uniswap-v3"].ok,
                    uniReason: dexStatus["uniswap-v3"].reason};
        }""")
        print("[gate] our fault -> unreachable=%s | %s"
              % (gate["ours"]["unreachable"], gate["ours"]["reason"]))
        print("[gate] rpc 403   -> unreachable=%s | %s"
              % (gate["down"]["unreachable"], gate["down"]["reason"]))
        assert gate["ours"]["unreachable"] is False, \
            "a bad address is our bug, not an unreachable network — retrying never fixes it"
        assert "network" not in gate["ours"]["reason"].lower() \
            or "not the network" in gate["ours"]["reason"].lower(), \
            "do not blame the network for a fault on our side: " + gate["ours"]["reason"]
        assert "checksum" in (gate["ours"].get("err") or ""), \
            "the real error must be kept, not thrown away: %r" % gate["ours"].get("err")
        assert gate_errs, "a fault on our side must be logged, not swallowed"
        assert gate["down"]["unreachable"] is True, \
            "an HTTP 403 while verifying means we could not ask — that must be retried"
        assert "could not reach the network" in gate["down"]["reason"], gate["down"]["reason"]
        print("[gate] targeted retry -> uniswap ok=%s (%s)"
              % (gate["uniAfter"], gate["uniReason"]))
        assert gate["uniBefore"] is True and gate["uniAfter"] is True, \
            "a targeted retry must not wipe DEXes that already verified"
        assert gate["uniReason"] == "verified", gate["uniReason"]

        # ---- 2c-bis. token logos load, initials survive failure ----
        await pg.wait_for_timeout(800)
        logos = await pg.eval_on_selector_all("#tokInAv img, #tokOutAv img", "e => e.length")
        initials = await pg.inner_text("#tokInAv")
        print("[icons] logo images: %s   fallback initials: %r" % (logos, initials.strip()))
        assert initials.strip() != "", "initials must always be present as a fallback"

        # ---- 2c-quinquies. wallet picker lists every wallet that announces itself ----
        # قبلاً فقط window.ethereum خوانده می‌شد و ما کورکورانه متامسک را ترجیح
        # می‌دادیم؛ با نصب‌بودن ربی و متامسک با هم، کاربر اصلاً حق انتخاب نداشت.
        picker = await pg.evaluate("""async () => {
            const mk = (rdns, name) => ({
              info: {uuid: rdns, name, rdns,
                     icon: "data:image/svg+xml;utf8," + encodeURIComponent(
                       "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'/>")},
              provider: {__who: name, request: async () => [], on(){}, removeListener(){}}
            });
            const fake = [mk("io.rabby","Rabby"), mk("io.metamask","MetaMask"),
                          mk("io.zerion","Zerion")];
            window.addEventListener("eip6963:requestProvider", () => {
              fake.forEach(w => window.dispatchEvent(
                new CustomEvent("eip6963:announceProvider", {detail: w})));
            });
            const realConnect = connectWithProvider;
            let chosen = null;
            connectWithProvider = async (p) => { chosen = p.__who; };
            openWalletPicker();
            await new Promise(r => setTimeout(r, 120));
            const names = [...document.querySelectorAll("#walList .walName")]
                            .map(e => e.textContent);
            const icons = document.querySelectorAll("#walList img").length;
            // روی ردیف «Zerion» کلیک کن، نه اولی — تا ثابت شود انتخاب کاربر
            // واقعاً همان است که وصل می‌شود، نه هرچه بالای لیست بود.
            const row = [...document.querySelectorAll("#walList .walRow")]
                          .find(r => /Zerion/.test(r.textContent));
            if (row) row.click();   // نبودنش خودش یک شکست است، نه یک استثنا
            await new Promise(r => setTimeout(r, 80));
            const stillOpen = document.getElementById("walletOv")
                                .classList.contains("on");
            connectWithProvider = realConnect;
            return {names, icons, chosen, stillOpen};
        }""")
        print("[wallet picker] %s · icons=%s · clicked -> %s"
              % (picker["names"], picker["icons"], picker["chosen"]))
        for w in ["Rabby", "MetaMask", "Zerion"]:
            assert w in picker["names"], \
                "%s announced itself but is missing from the picker: %s" % (w, picker["names"])
        assert picker["chosen"] == "Zerion", \
            "the picker must connect the wallet the user clicked, not the first one: %r" % picker["chosen"]
        assert picker["icons"] == 3, "each announced wallet must show its own icon"
        assert not picker["stillOpen"], "the picker must close once a wallet is chosen"

        # ---- 2d. native ETH is offered and routes through WETH ----
        await pg.click("#tokOutBtn"); await pg.wait_for_timeout(250)
        await pg.fill("#tokSearch", "ETH"); await pg.wait_for_timeout(250)
        syms = await pg.eval_on_selector_all("#tokList .trow .s", "e => e.map(x => x.innerText)")
        print("[eth] picker shows: %s" % syms)
        assert "ETH" in syms, "native ETH must be selectable"
        await pg.click(".trow"); await pg.wait_for_timeout(300)
        assert await pg.inner_text("#tokOutSym") == "ETH"
        await pg.fill("#amtIn", "1000"); await pg.wait_for_timeout(3000)
        out_eth = await pg.input_value("#amtOut")
        print("[eth] USDC -> ETH quote: %s  route=%s" % (
            out_eth, (await pg.inner_text("#routeBody")).replace("\n", " | ")))
        assert out_eth not in ("", "0"), "ETH output must quote via WETH"
        notices = await pg.inner_text("#notices")
        assert "not supported" not in notices, "native ETH should no longer be rejected"

        # نمودار ETH هم باید بیاید. آدرس ETH در جدول ما "NATIVE" است و
        # GeckoTerminal آن را نمی‌شناسد؛ برای تاریخچه‌ی قیمت باید به WETH
        # نگاشت شود. روی سایت زنده این پیام «Price history is unavailable»
        # می‌داد در حالی که همان جفت با WETH درست کار می‌کرد.
        eth_chart = await pg.evaluate("""async () => {
            const t0 = Date.now();
            while (Date.now() - t0 < 9000) {
                const m = document.getElementById("chartMsg");
                const shown = getComputedStyle(m).display !== "none";
                if (shown && /unavailable/i.test(m.textContent))
                    return {ok: false, why: m.textContent.trim()};
                if (document.querySelectorAll("#plot svg path").length >= 2)
                    return {ok: true, why: "drawn"};
                await new Promise(r => setTimeout(r, 200));
            }
            return {ok: false, why: "no chart and no message after 9s"};
        }""")
        print("[eth chart] %s — %s" % (eth_chart["ok"], eth_chart["why"][:70]))
        assert eth_chart["ok"], \
            "native ETH must chart through WETH, not fall over: " + eth_chart["why"]
        await pg.wait_for_timeout(1200)
        eth_safety = await pg.inner_text("#safetyBody")
        print("[eth safety] %s" % eth_safety.replace("\n", " | ")[:120])
        assert "Native asset" in eth_safety, "native ETH must be explained, not reported as a network failure"
        assert "did not answer" not in eth_safety, "no contract is not the same as no answer"
        await pg.screenshot(path=os.path.join(HERE, "shot-eth.png"), full_page=True)
        # برگرد به WETH برای بقیه‌ی تست‌ها
        await pg.click("#tokOutBtn"); await pg.wait_for_timeout(250)
        await pg.fill("#tokSearch", "WETH"); await pg.wait_for_timeout(250)
        await pg.click(".trow"); await pg.wait_for_timeout(2500)

        # ---- 2e. portfolio + money flow live on their own pages ----
        assert not await pg.is_visible("#flowBody"), "flow must not sit on the swap page"
        assert not await pg.is_visible("#folioBody"), "portfolio must not sit on the swap page"

        await pg.click('#nav [data-view="flow"]'); await pg.wait_for_timeout(400)
        assert await pg.evaluate("location.hash") == "#flow", "view must be linkable"
        print("[nav] flow page token: %s" % await pg.inner_text("#flowTokSym"))
        await pg.wait_for_selector("#flowBody .flowkv", timeout=20000)
        flow = await pg.inner_text("#flowBody")
        print("[flow 1H] %s" % flow.replace("\n", " | ")[:170])
        addrs = await pg.eval_on_selector_all("#flowBody .trade a", "e => e.length")
        print("[flow] buyer addresses shown: %s" % addrs)
        assert addrs > 0, "largest buys should link the buying wallet"
        assert "Net" in flow, "flow panel missing net figure"
        assert "LARGEST BUYS" in flow.upper(), "largest buys list missing"
        await pg.click('#flowTfs [data-w="h6"]'); await pg.wait_for_timeout(900)
        print("[flow 6H] %s" % (await pg.inner_text("#flowBody")).replace("\n", " | ")[:120])
        await pg.click('#flowTfs [data-w="h1"]'); await pg.wait_for_timeout(600)
        await pg.screenshot(path=os.path.join(HERE, "shot-flow.png"), full_page=True)

        await pg.click('#nav [data-view="folio"]'); await pg.wait_for_timeout(500)
        folio = await pg.inner_text("#folioBody")
        print("[portfolio] %s" % folio.replace("\n", " | ")[:120])
        assert "Connect a wallet" in folio, "with no wallet the portfolio must say so, not show zeros"
        await pg.screenshot(path=os.path.join(HERE, "shot-folio.png"), full_page=True)

        # back to the swap page for the remaining tests
        await pg.click('#nav [data-view="swap"]'); await pg.wait_for_timeout(400)
        assert await pg.is_visible("#amtIn"), "swap page must come back"

        # ---- 2f. reverse quoting: type the amount you WANT to receive ----
        await pg.fill("#amtIn", "")
        await pg.fill("#amtOut", "0.5")
        await pg.wait_for_function(
            "() => document.getElementById('amtIn').value !== ''", timeout=25000)
        need = await pg.input_value("#amtIn")
        got = await pg.input_value("#amtOut")
        print("[reverse] want %s WETH -> pay %s USDC" % (got, need))
        assert float(need) > 0, "reverse solve produced no input amount"
        note = await pg.inner_text("#revNote")
        assert "Solved for your target" in note, "reverse mode must say the amount is solved, not exact"
        print("[reverse] %s" % note.replace("\n", " ")[:130])
        await pg.screenshot(path=os.path.join(HERE, "shot-reverse.png"), full_page=True)
        await pg.fill("#amtOut", "")
        await pg.fill("#amtIn", "1000"); await pg.wait_for_timeout(2500)

        # ---- 3. split order ----
        await pg.fill("#amtIn", "900000")
        await pg.wait_for_timeout(3000)
        print("[split] route=%s  impact=%s" % (
            await pg.inner_text("#routeMeta"), await pg.inner_text("#kImpact")))
        print("[route] %s" % (await pg.inner_text("#routeBody")).replace("\n", " | "))
        await pg.screenshot(path=os.path.join(HERE, "shot-split.png"), full_page=True)

        # ---- 4. multi-hop ----
        for target, sym in (("#tokInBtn", "cbBTC"), ("#tokOutBtn", "DAI")):
            await pg.click(target); await pg.wait_for_timeout(200)
            await pg.fill("#tokSearch", sym); await pg.wait_for_timeout(250)
            await pg.click(".trow"); await pg.wait_for_timeout(300)
        await pg.fill("#amtIn", "1")
        await pg.wait_for_timeout(3500)
        print("[multihop cbBTC->DAI] out=%s  route=%s" % (
            await pg.input_value("#amtOut"), (await pg.inner_text("#routeBody")).replace("\n", " | ")))

        # ---- 5. THE regression test: outage must read as unknown, never "no route"
        await pg.evaluate("""() => {
            readProvider.call = async () => { throw new Error('fetch failed'); };
            rotateRpc = () => {};
        }""")
        await pg.fill("#amtIn", "5")
        await pg.wait_for_timeout(3500)
        msg = await pg.inner_text("#notices")
        print("[rpc down] %s" % msg.replace("\n", " "))
        assert "did not answer" in msg, "outage misreported: " + msg
        assert "No route" not in msg, "outage reported as 'no route'"

        # ---- 6. wallet menu + light theme ----
        await pg.reload(); await pg.wait_for_timeout(900)
        await pg.fill("#amtIn", "1000"); await pg.wait_for_timeout(3000)
        await pg.evaluate("""() => {
            account = "0x8A0Dcb583C8CAdc481E34487c34f1B856fe97e23";
            walletChainId = CHAIN.id;
            paintWallet();
        }""")
        await pg.click("#connectBtn"); await pg.wait_for_timeout(150)
        assert await pg.locator("#walletPop").evaluate("e => e.classList.contains('on')"), \
            "a connected wallet must open its account menu"
        # کلید تم عمداً از منوی والت به تنظیمات رفته: ظاهر سایت ربطی به
        # «کدام حساب وصل است» ندارد و بدون والت هم باید در دسترس باشد.
        assert await pg.locator("#walletPop #themeBtn").count() == 0, \
            "the theme switch belongs in Settings, not in the wallet menu"
        await pg.keyboard.press("Escape")
        await pg.click("#setBtn"); await pg.wait_for_timeout(200)
        assert await pg.locator("#setPop #themeBtn").count() == 1, \
            "the theme switch must be reachable from Settings"
        await pg.click("#themeBtn"); await pg.wait_for_timeout(300)
        assert await pg.get_attribute("html", "data-theme") == "light"
        assert await pg.inner_text("#themeState") == "Light"
        print("[theme] moved to Settings, toggles to %s"
              % await pg.get_attribute("html", "data-theme"))
        await pg.keyboard.press("Escape")
        await pg.screenshot(path=os.path.join(HERE, "shot-light.png"), full_page=True)

        # ---- 6b. فوتر باید ته صفحه بماند، در هر سه نما ----
        # صفحه‌های Portfolio و Money Flow وقتی خالی‌اند کوتاه‌ترند؛ قبلاً فوتر
        # می‌چسبید زیر محتوا و وسط صفحه شناور می‌شد.
        foot = {}
        for view in ["swap", "folio", "flow"]:
            await pg.click(f'.nav button[data-view="{view}"]'); await pg.wait_for_timeout(400)
            foot[view] = await pg.evaluate("""() => {
                const f = document.querySelector("footer").getBoundingClientRect();
                return {bottom: Math.round(f.bottom), vh: innerHeight,
                        docH: Math.round(document.documentElement.scrollHeight)};
            }""")
            print("[footer %s] bottom=%s viewport=%s doc=%s"
                  % (view, foot[view]["bottom"], foot[view]["vh"], foot[view]["docH"]))
            f = foot[view]
            assert f["bottom"] >= f["vh"] - 4, \
                ("the footer floats mid-page on the %s view: it ends at %s in a %s viewport"
                 % (view, f["bottom"], f["vh"]))
        await pg.click('.nav button[data-view="swap"]'); await pg.wait_for_timeout(400)

        # ---- 7. settings + picker ----
        await pg.click("#setBtn"); await pg.wait_for_timeout(250)
        await pg.click('#slipSeg [data-bps="100"]'); await pg.wait_for_timeout(300)
        print("[slippage 1%%] min=%s" % await pg.inner_text("#kMin"))
        await pg.keyboard.press("Escape")
        await pg.click("#tokOutBtn"); await pg.wait_for_timeout(400)
        await pg.screenshot(path=os.path.join(HERE, "shot-picker.png"))
        await pg.keyboard.press("Escape")

        # ---- 8. mobile wallet menu ----
        mob = await b.new_page(viewport={"width": 390, "height": 844}, color_scheme="dark")
        await mob.goto(URL); await mob.wait_for_timeout(1000)
        await mob.evaluate("""() => {
            account = "0x8A0Dcb583C8CAdc481E34487c34f1B856fe97e23";
            walletChainId = CHAIN.id;
            paintWallet();
        }""")
        await mob.click("#connectBtn"); await mob.wait_for_timeout(150)
        mobile_menu = await mob.evaluate("""() => {
            const el = document.getElementById("walletPop"), box = el.getBoundingClientRect();
            // آیکون قطع اتصال: قبلاً یک حرف یونیکد («⏻») بود که روی گوشی فونت
            // ندارد و جایش خالی می‌ماند. «وجود عنصر» کافی نیست — باید واقعاً
            // ابعاد رسم‌شده داشته باشد و SVG باشد، نه متنی که به فونت وابسته است.
            const d = document.getElementById("disconnectBtn");
            const ic = d && d.querySelector("svg");
            const ib = ic ? ic.getBoundingClientRect() : null;
            return {open: el.classList.contains("on"), left: box.left, right: box.right,
                    width: innerWidth, disconnect: !!d,
                    iconIsSvg: !!ic, iconW: ib ? Math.round(ib.width) : 0,
                    iconH: ib ? Math.round(ib.height) : 0};
        }""")
        print("[wallet menu mobile] open=%s left=%.0f right=%.0f viewport=%s"
              % (mobile_menu["open"], mobile_menu["left"], mobile_menu["right"], mobile_menu["width"]))
        print("[disconnect icon] svg=%s size=%sx%s"
              % (mobile_menu["iconIsSvg"], mobile_menu["iconW"], mobile_menu["iconH"]))
        assert mobile_menu["open"] and mobile_menu["left"] >= 0 and mobile_menu["right"] <= mobile_menu["width"], \
            "wallet menu must remain usable inside a mobile viewport"
        assert mobile_menu["disconnect"], "disconnect must be inside the wallet menu on mobile too"
        assert mobile_menu["iconIsSvg"], \
            "the disconnect icon must be inline SVG — a unicode glyph is missing on many phone fonts"
        assert mobile_menu["iconW"] >= 10 and mobile_menu["iconH"] >= 10, \
            "the disconnect icon renders with no size: %sx%s" % (mobile_menu["iconW"], mobile_menu["iconH"])

        # ---- 8b. هر منوی بازشو باید کامل داخل صفحه‌ی گوشی جا شود ----
        # منوی تنظیمات با اضافه‌شدن ردیف Appearance بلندتر شد و از پایینِ
        # صفحه زد بیرون. سقف ارتفاع نداشت، پس هر ردیف تازه‌ای دوباره
        # می‌شکستش — این کاوشگر همه‌ی بازشوها را با هم می‌سنجد.
        await mob.keyboard.press("Escape")
        pops = []
        for opener, pop, label in [("#setBtn", "#setPop", "settings"),
                                   ("#connectBtn", "#walletPop", "wallet")]:
            await mob.click(opener); await mob.wait_for_timeout(220)
            box = await mob.evaluate("""sel => {
                const e = document.querySelector(sel), r = e.getBoundingClientRect();
                return {top: Math.round(r.top), bottom: Math.round(r.bottom),
                        left: Math.round(r.left), right: Math.round(r.right),
                        vw: innerWidth, vh: innerHeight,
                        scrolls: e.scrollHeight > e.clientHeight + 1};
            }""", pop)
            box["label"] = label
            pops.append(box)
            print("[pop %s mobile] top=%s bottom=%s left=%s right=%s viewport=%sx%s scrolls=%s"
                  % (label, box["top"], box["bottom"], box["left"], box["right"],
                     box["vw"], box["vh"], box["scrolls"]))
            await mob.keyboard.press("Escape"); await mob.wait_for_timeout(120)
        # ⚠️ عمداً `b` نه — نام مرورگر است و سایه‌انداختن رویش باعث شد
        #    await b.close() در انتهای تست بترکد.
        for pb in pops:
            assert pb["top"] >= 0 and pb["bottom"] <= pb["vh"], \
                ("the %s menu runs off the phone screen vertically: %s..%s in a %s-tall viewport"
                 % (pb["label"], pb["top"], pb["bottom"], pb["vh"]))
            assert pb["left"] >= 0 and pb["right"] <= pb["vw"], \
                ("the %s menu runs off the phone screen horizontally: %s..%s in a %s-wide viewport"
                 % (pb["label"], pb["left"], pb["right"], pb["vw"]))
        await mob.screenshot(path=os.path.join(HERE, "shot-mobile-wallet.png"))
        await mob.close()
        await b.close()

    print("\n--- console errors ---")
    if errors:
        for e in errors: print("  ", e)
        sys.exit(1)
    print("   none")

asyncio.run(main())
