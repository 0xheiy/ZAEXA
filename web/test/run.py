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

# آدرس مستقیم GeckoTerminal. درخواست‌ها روی سیم از /gt روی دامنه‌ی خودمان
# می‌روند، ولی کلید کش همین می‌ماند — کاوشگر [gt proxy] هر دو را می‌سنجد.
GT_DIRECT = "https://api.geckoterminal.com/api/v2"

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

    # ethers تنها اسکریپت بیرونی نیست. هر جای دیگری هم که کد بار می‌شود باید
    # محلی باشد — WalletConnect با یک <script> پویا می‌آید و اگر روزی کسی
    # آدرسش را به یک CDN عوض کند، بررسی بالا اصلاً نمی‌بیندش.
    remote_srcs = [m for m in re.findall(r"""(?:src|s\.src)\s*=\s*["']([^"']+)["']""", src)
                   if m.startswith("http://") or m.startswith("https://")]
    assert not remote_srcs, \
        "code must never be loaded from a remote origin: %s" % remote_srcs
    wc = os.path.join(HERE, "..", "walletconnect.bundle.js")
    assert os.path.exists(wc), \
        "walletconnect.bundle.js is missing next to index.html — rebuild it with " \
        "scripts/build_walletconnect.sh"
    # بسته‌ی WalletConnect باید *واقعاً* خودکفا باشد. نسخه‌ی رسمی UMD خودشان
    # نیست: در مرورگر انتظار دارد viem/lit/bs58 از قبل روی صفحه باشند و بی‌صدا
    # شکست می‌خورد. اگر روزی کسی فایل رسمی را جایگزین کند، این می‌گیردش.
    wc_head = open(wc, encoding="utf-8", errors="replace").read(600)
    assert 'require("viem")' not in wc_head, \
        "this is WalletConnect's own UMD file, which is not self-contained — " \
        "build the bundle with scripts/build_walletconnect.sh instead"
    print("[supply chain] vendored: ethers %.0f KB, walletconnect %.0f KB — no remote scripts"
          % (os.path.getsize(vendored) / 1024, os.path.getsize(wc) / 1024))

def check_gt_proxy_worker():
    """پراکسی GeckoTerminal یک Worker جداست و در مرورگر بار نمی‌شود، پس
    سوییت پلی‌رایت نمی‌بیندش. با node آزموده می‌شود، بدون شبکه.

    چرا اینجا و نه جدا: این کد روی همان دامنه‌ای اجرا می‌شود که کارش امضای
    تراکنش است. اگر allowlist مسیرش شل شود، دامنه‌ی ما پراکسی باز می‌شود.
    آن آزمون باید هر بار با بقیه اجرا شود، نه وقتی کسی یادش بیفتد."""
    import subprocess
    w = os.path.join(HERE, "..", "..", "worker", "test.mjs")
    if not os.path.exists(w):
        raise AssertionError("worker/test.mjs is missing — the GeckoTerminal proxy is untested")
    r = subprocess.run(["node", w], capture_output=True, text=True,
                       cwd=os.path.dirname(w))
    sys.stdout.write(r.stdout)
    assert r.returncode == 0, "the GeckoTerminal proxy worker failed its tests:\n" + r.stderr

check_no_remote_code()
check_gt_proxy_worker()

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

        # پیش‌فرض عمداً ETH → USDC است: کسی که تازه می‌رسد معمولاً ETH دارد
        # و می‌خواهد بفروشد، نه برعکس.
        print("[default pair] %s -> %s"
              % (await pg.inner_text("#tokInSym"), await pg.inner_text("#tokOutSym")))
        assert await pg.inner_text("#tokInSym") == "ETH"
        assert await pg.inner_text("#tokOutSym") == "USDC"

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

        # این بخش مسیر approve را می‌سنجد، پس ورودی باید یک ERC-20 باشد.
        # ETH بومی approve نمی‌خواهد، و از وقتی پیش‌فرضِ صفحه ETH شد این
        # کاوشگرها به جفتِ پیش‌فرض گره خورده بودند. حالا صریح است.
        await pg.evaluate("""() => {
            tokenIn = allTokens().find(t => t.symbol === "USDC");
            tokenOut = allTokens().find(t => t.symbol === "WETH");
            paintToken("in", tokenIn); paintToken("out", tokenOut);
            loadChart();
        }""")
        await pg.fill("#amtIn", "1000")
        await pg.wait_for_timeout(3000)

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

        # ---- 2a-pre. the token list itself ----
        toks = await pg.evaluate(
            "() => BASE_TOKENS.map(t => ({s: t.symbol, d: t.decimals,"
            " a: t.address, st: !!t.stable, n: t.native}))")
        print("[token list] %s" % ", ".join(f"{t['s']}/{t['d']}" for t in toks))
        seen = {}
        for t in toks:
            assert t["s"] not in seen, "duplicate symbol in the token list: %s" % t["s"]
            seen[t["s"]] = t
            if not t["n"]:
                assert t["a"].startswith("0x") and len(t["a"]) == 42, \
                    "%s has a malformed address: %s" % (t["s"], t["a"])
            assert isinstance(t["d"], int) and 0 < t["d"] <= 18, \
                "%s has implausible decimals: %s" % (t["s"], t["d"])
        # ⚠️ `stable` یعنی «تقریباً یک دلار» و مستقیم در قیمت‌گذاری می‌نشیند.
        #    EURC به یورو وصل است؛ اگر روزی کسی این پرچم را برایش بگذارد،
        #    قیمت‌ها بی‌صدا حدود ۸٪ غلط می‌شوند.
        assert not seen["EURC"]["st"], \
            "EURC is euro-pegged — marking it stable makes every price using it wrong"
        for s in ["USDC", "USDT", "USDbC", "DAI"]:
            assert seen[s]["st"], "%s is dollar-pegged and must be marked stable" % s
        # اعشار خوانده‌شده از زنجیره (۱۶ آگوست ۲۰۲۶) — قفلش می‌کنیم
        for s, d in [("USDT", 6), ("USDbC", 6), ("EURC", 6), ("cbETH", 18),
                     ("wstETH", 18), ("VIRTUAL", 18), ("MORPHO", 18), ("DEGEN", 18)]:
            assert seen[s]["d"] == d, \
                "%s decimals drifted from what the contract reports: %s" % (s, seen[s]["d"])

        # ---- 2a-bis. Disconnect must actually stay disconnected ----
        # باگ واقعی روی سایت زنده: disconnect فقط وضعیت سمت ما را پاک می‌کرد،
        # ولی والت هنوز سایت را مجاز می‌دانست. پس رفرش بعدی با eth_accounts
        # بی‌صدا دوباره وصل می‌شد و آدرس کاربر برمی‌گشت، بدون هیچ پرسشی.
        dis = await pg.evaluate("""async () => {
            localStorage.removeItem("zaexa.disconnected");
            const fake = {__who: "ghost", request: async ({method}) =>
                method === "eth_accounts" || method === "eth_requestAccounts"
                    ? ["0x8A0Dcb583C8CAdc481E34487c34f1B856fe97e23"] : null,
                on(){}, removeListener(){}};
            const out = {};
            out.autoBefore = !userDisconnected();

            account = "0x8A0Dcb583C8CAdc481E34487c34f1B856fe97e23";
            walletChainId = CHAIN.id; walletProvider = {}; paintWallet();
            await disconnect();

            out.cleared = account === null;
            out.flagged = userDisconnected();
            // همان کاری که بارگذاری صفحه می‌کند
            const accs = await fake.request({method: "eth_accounts"});
            out.walletStillAllows = !!(accs && accs.length);
            out.wouldAutoConnect = !userDisconnected();
            // و انتخاب صریح خودِ کاربر باید دوباره اجازه بدهد
            markDisconnected(false);
            out.afterExplicit = !userDisconnected();
            localStorage.removeItem("zaexa.disconnected");
            return out;
        }""")
        print("[disconnect] cleared=%s remembered=%s walletStillAllows=%s autoReconnect=%s"
              % (dis["cleared"], dis["flagged"], dis["walletStillAllows"], dis["wouldAutoConnect"]))
        assert dis["cleared"], "disconnect must clear the account"
        assert dis["flagged"], "disconnect must be remembered across reloads"
        assert dis["walletStillAllows"], \
            "the probe is wrong: the wallet is supposed to still allow the site"
        assert not dis["wouldAutoConnect"], \
            "the site would silently reconnect after the user pressed Disconnect"
        assert dis["afterExplicit"], \
            "picking a wallet explicitly must undo the disconnect, or connecting breaks"

        # ---- 2a-ter. reads must never be routed through a remote wallet ----
        # با WalletConnect هر eth_call باید از رله به گوشی برود و برگردد. اگر
        # خواندن‌ها از آنجا بروند، هر کوت و هر allowance ثانیه‌ها طول می‌کشد و
        # عملاً سواپ هرگز آماده نمی‌شود — حتی بعد از approve نامحدود، چون
        # تأیید approve خودش یک خواندن است. امضا فرق دارد و باید برود.
        remote = await pg.evaluate("""async () => {
            const realWP = walletProvider, realId = walletChainId;
            let viaWallet = 0;
            walletProvider = {call: async () => { viaWallet++; throw new Error("fetch failed"); }};
            walletChainId = CHAIN.id;

            walletIsRemote = false;
            const injectedReady = walletReady();
            walletIsRemote = true;
            const remoteReady = walletReady();
            try { await chainCall({to: CHAIN.multicall3, data: "0x"}); } catch {}
            const callsWhileRemote = viaWallet;

            walletProvider = realWP; walletChainId = realId; walletIsRemote = false;
            return {injectedReady, remoteReady, callsWhileRemote};
        }""")
        print("[wallet reads] injected=%s remote=%s (remote calls made: %s)"
              % (remote["injectedReady"], remote["remoteReady"], remote["callsWhileRemote"]))
        assert remote["injectedReady"], \
            "an injected wallet is the best read source — do not stop using it"
        assert not remote["remoteReady"] and remote["callsWhileRemote"] == 0, \
            "reads went through the WalletConnect relay; every quote would round-trip to the phone"

        # ---- 2a-quater. approve through a remote wallet must not carry our gas ----
        # زریون روی eth_sendTransaction خطای {code:404,"Internal error"} می‌داد و
        # ethers آن را در «could not coalesce error» می‌پیچید. تراکنشی که ethers
        # می‌سازد `gas` دارد — تخمینِ RPC *ما*، نه والت. با {gasLimit:null} هم
        # همان است (آزموده شد). برای والت راه‌دور خام می‌فرستیم.
        appr = await pg.evaluate("""async () => {
            const sent = [];
            const realProv = walletEip1193, realAcct = account,
                  realSigner = signer, realRemote = walletIsRemote,
                  realTok = tokenIn, realWait = waitForAllowance;
            account = "0x8A0Dcb583C8CAdc481E34487c34f1B856fe97e23";
            tokenIn = allTokens().find(t => t.symbol === "USDC");
            document.getElementById("amtIn").value = "1.5";
            walletEip1193 = {request: async ({method, params}) => {
                if (method === "eth_sendTransaction") { sent.push(params[0]); return "0x" + "ab".repeat(32); }
                return null; }};
            walletIsRemote = true;
            waitForAllowance = async () => true;
            await doApprove();
            walletEip1193 = realProv; account = realAcct; signer = realSigner;
            walletIsRemote = realRemote; tokenIn = realTok; waitForAllowance = realWait;
            return {calls: sent.length, keys: sent[0] ? Object.keys(sent[0]).sort() : null,
                    to: sent[0] && sent[0].to};
        }""")
        # همان قاعده برای خودِ سواپ: نه گسِ ما، و برای ETH بومی value لازم است
        swp = await pg.evaluate("""async () => {
            const sent = [];
            const realProv = walletEip1193, realAcct = account, realRemote = walletIsRemote;
            account = "0x8A0Dcb583C8CAdc481E34487c34f1B856fe97e23";
            walletEip1193 = {request: async ({method, params}) => {
                if (method === "eth_sendTransaction") { sent.push(params[0]); return "0x" + "cd".repeat(32); }
                return null; }};
            walletIsRemote = true;
            const eth = allTokens().find(t => t.native);
            const parts = [[[[1, "0x2626664c2603336E57B271c5C0b26F421741e481",
                              "0x4200000000000000000000000000000000000006",
                              "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 100, false,
                              "0x33128a8fC17869897dcE68Ed026d694621f6FDfD"]], 1000n]];
            const data = iExec.encodeFunctionData("executeSwap",
              [routable(eth).address, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
               1000n, 1n, parts, 99999999999]);
            const p = {from: account, to: ethers.getAddress(CHAIN.executor), data,
                       value: "0x" + (1000n).toString(16)};
            await walletEip1193.request({method: "eth_sendTransaction", params: [p]});
            walletEip1193 = realProv; account = realAcct; walletIsRemote = realRemote;
            return {keys: Object.keys(sent[0]).sort(), value: sent[0].value};
        }""")
        print("[swap remote] fields=%s value=%s" % (swp["keys"], swp["value"]))
        assert "gas" not in swp["keys"], "the swap must not carry our own gas estimate either"
        assert swp["value"] == "0x3e8", "native ETH swaps must still send value"

        print("[approve remote] fields=%s" % (appr["keys"],))
        assert appr["calls"] == 1, "approve did not reach the wallet: %s" % appr
        assert "gas" not in (appr["keys"] or []), \
            ("we sent our own gas estimate to a remote wallet: %s — let the wallet estimate"
             % appr["keys"])
        assert set(appr["keys"]) == {"data", "from", "to"}, \
            "unexpected fields in the approve payload: %s" % appr["keys"]

        # ---- 2b-pre. GeckoTerminal request budget ----
        # صف GeckoTerminal تک‌خطی و با فاصله‌ی اجباری است، پس *تعداد*
        # درخواست‌ها مستقیماً می‌شود تأخیری که کاربر می‌بیند: لوگوها دیر
        # می‌آمدند و نمودار گاهی اصلاً نمی‌آمد. دو چیز را می‌سنجیم:
        # هیچ URLی دو بار روی سیم نرود، و هر توکن درخواست جدا نسازد.
        budget = await pg.evaluate("""async () => {
            const seen = [];
            const realFetch = window.fetch;
            window.fetch = function (u, o) { seen.push(String(u)); return realFetch(u, o); };
            gtCache.clear(); gtInflight.clear();
            Object.keys(metaCache).forEach(k => delete metaCache[k]);

            const toks = allTokens().filter(t => !t.native).map(t => t.address);
            await Promise.all(toks.map(a => tokenMeta(a)));      // مثل رسم آواتارها
            await Promise.all(toks.map(a => tokenMeta(a)));      // بار دوم باید رایگان باشد
            const metaCalls = seen.filter(u => /\\/tokens\\//.test(u)).length;

            const before = seen.length;
            const u = GT + "/networks/base/tokens/" + toks[0] + "/pools?page=1";
            await Promise.all([gtJson(u), gtJson(u), gtJson(u)]);  // همزمان
            await gtJson(u);                                       // و یک بار بعدش
            const dupCalls = seen.length - before;

            window.fetch = realFetch;
            return {tokens: toks.length, metaCalls, dupCalls};
        }""")
        print("[gt budget] %s tokens -> %s metadata calls; 4 identical urls -> %s call"
              % (budget["tokens"], budget["metaCalls"], budget["dupCalls"]))
        assert budget["metaCalls"] <= 2, \
            ("%s tokens caused %s metadata requests — they must batch, not queue one by one"
             % (budget["tokens"], budget["metaCalls"]))
        assert budget["dupCalls"] == 1, \
            "four requests for the same url hit the network %s times" % budget["dupCalls"]

        # وقتی سرویس پشت سر هم شکست می‌خورد، ادامه‌ی درخواست‌ها هم بی‌فایده است
        # هم وضع را بدتر می‌کند. روی سایت زنده همین اتفاق افتاد: دسته ۴۲۹ خورد،
        # loadMetas تک‌تک پرسید، و یک درخواست به چهل‌ودو تا تبدیل شد.
        storm = await pg.evaluate("""async () => {
            const realFetch = window.fetch;
            let hits = 0;
            window.fetch = async () => { hits++; throw new TypeError("Failed to fetch"); };
            gtCache.clear(); gtInflight.clear(); gtFails = 0; gtCoolUntil = 0;
            Object.keys(metaCache).forEach(k => delete metaCache[k]);

            const toks = allTokens().filter(t => !t.native).map(t => t.address);
            try { await loadMetas(toks); } catch {}
            const afterBatch = hits;
            // و درخواست‌های بعدی، تا وقتی در حالت خنک‌شدن هستیم، به شبکه نزنند
            try { await gtJson(GT + "/networks/base/tokens/" + toks[0]); } catch {}
            const afterCooldown = hits;

            window.fetch = realFetch; gtFails = 0; gtCoolUntil = 0;
            return {tokens: toks.length, afterBatch, extra: afterCooldown - afterBatch};
        }""")
        print("[gt storm] %s tokens, everything failing -> %s network hits, %s more while cooling"
              % (storm["tokens"], storm["afterBatch"], storm["extra"]))
        assert storm["afterBatch"] <= 4, \
            ("a failing batch fanned out into %s requests for %s tokens - when the service "
             "is down, asking one address at a time only makes it worse"
             % (storm["afterBatch"], storm["tokens"]))
        assert storm["extra"] == 0, \
            "requests still reached the network while the circuit breaker was open"

        # ---- 2b-quater. GeckoTerminal proxy routing ----
        # سقف نرخ روی IP کاربر است، پس درخواست‌ها از /gt روی دامنه‌ی خودمان
        # رد می‌شوند. دو چیز باید درست باشد و هیچ‌کدام بدیهی نیست:
        # ۱) وقتی پراکسی هست، آدرس *بازنویسی* شود ولی کلید کش همان بماند —
        #    وگرنه هر آدرس دو بار روی سیم می‌رود.
        # ۲) وقتی پراکسی نیست (استقرار ناقص)، سایت زنده نباید کور شود.
        #    ولی یک ۴۰۴ واقعیِ خودِ GeckoTerminal *نباید* پراکسی را خاموش کند.
        proxy = await pg.evaluate("""async () => {
            const realFetch = window.fetch, seen = [];
            const out = {};
            const reply = (status, marked) => new Response("{}", {
                status, headers: marked ? {"x-zaexa-proxy": "upstream-" + status} : {},
            });

            // ۱) با پراکسی: آدرس بازنویسی می‌شود، کلید کش همان می‌ماند
            gtProxy = "https://zaexa.com/gt";
            gtCache.clear(); gtInflight.clear(); gtFails = 0; gtCoolUntil = 0;
            window.fetch = async (u) => { seen.push(String(u)); return reply(200, true); };
            const u = GT + "/networks/base/tokens/0xabc";
            await gtJson(u);
            out.wire = seen[0];
            out.cachedUnder = [...gtCache.keys()][0];

            // ۲) ۴۰۴ *با* نشان = خود GeckoTerminal گفته نیست. پراکسی سالم است.
            seen.length = 0; gtCache.clear(); gtInflight.clear();
            gtFails = 0; gtCoolUntil = 0;
            window.fetch = async (x) => { seen.push(String(x)); return reply(404, true); };
            try { await gtJson(GT + "/networks/base/tokens/0xdead"); } catch {}
            out.realMissCalls = seen.length;
            out.proxyStillOn = !!gtProxy;

            // ۳) ۴۰۴ *بدون* نشان = /gt وجود ندارد. یک بار مستقیم، بعد خاموش.
            seen.length = 0; gtCache.clear(); gtInflight.clear();
            gtFails = 0; gtCoolUntil = 0;
            window.fetch = async (x) => {
                seen.push(String(x));
                return String(x).startsWith("https://zaexa.com/gt")
                    ? reply(404, false) : reply(200, false);
            };
            // ⚠️ اگر fallback نباشد این throw می‌کند و کل کاوشگر با یک خطای
            // خام می‌افتد به‌جای ادعای روشن — پس خودمان می‌گیریمش.
            out.recovered = true;
            try { await gtJson(GT + "/networks/base/tokens/0xabc"); }
            catch (e) { out.recovered = false; }
            out.firstTry = seen[0];
            out.retry = seen[1];
            out.proxyOffAfter = !gtProxy;

            seen.length = 0; gtCache.clear(); gtInflight.clear();
            gtFails = 0; gtCoolUntil = 0;
            try { await gtJson(GT + "/networks/base/tokens/0xbeef"); } catch (e) {}
            out.afterGiveUp = seen[0];

            window.fetch = realFetch;
            gtProxy = null; gtCache.clear(); gtInflight.clear();
            gtFails = 0; gtCoolUntil = 0;
            return out;
        }""")
        # ⚠️ کوتاه‌کننده باید None را هم تحمل کند: وقتی کاوشگر می‌افتد، معمولاً
        # یکی از این کلیدها اصلاً پر نشده، و آن‌وقت خودِ چاپ می‌ترکد و پیام
        # واقعی گم می‌شود.
        sh = lambda s: str(s).replace("https://", "")
        print("[gt proxy] wire=%s cached-as=%s | missing proxy -> %s then %s, later %s"
              % (sh(proxy["wire"]), sh(proxy["cachedUnder"]), sh(proxy["firstTry"]),
                 sh(proxy["retry"]), sh(proxy["afterGiveUp"])))
        assert proxy["wire"] == "https://zaexa.com/gt/networks/base/tokens/0xabc", \
            "the request did not go through our own proxy: %s" % proxy["wire"]
        assert proxy["cachedUnder"] == GT_DIRECT + "/networks/base/tokens/0xabc", \
            ("the cache key must stay the canonical geckoterminal url, otherwise the same "
             "response is fetched twice: %s" % proxy["cachedUnder"])
        assert proxy["realMissCalls"] == 1 and proxy["proxyStillOn"], \
            ("a 404 that came *from* geckoterminal turned the proxy off — "
             "an unknown token must not disable proxying for the whole session")
        assert proxy["firstTry"].startswith("https://zaexa.com/gt"), \
            "the first attempt should try the proxy: %s" % proxy["firstTry"]
        assert proxy["recovered"], \
            ("a deployment without /gt made the request fail outright — the page must "
             "fall back to geckoterminal instead of losing charts and logos")
        assert proxy["retry"] == GT_DIRECT + "/networks/base/tokens/0xabc", \
            ("when /gt is missing the page must fall back to geckoterminal directly, "
             "not go dark: %s" % proxy["retry"])
        assert proxy["proxyOffAfter"], "the proxy stayed on after it answered 404"
        assert proxy["afterGiveUp"] == GT_DIRECT + "/networks/base/tokens/0xbeef", \
            ("after giving up on the proxy every later request must go direct: %s"
             % proxy["afterGiveUp"])

        # ---- 2b-quinquies. what survives a refresh ----
        # حسام پیدایش کرد: چند رفرش پیاپی و لوگوها و نمودار می‌افتند. علتش
        # سرویس نیست — هر رفرش حافظه‌ی صفحه را دور می‌ریزد و همه‌چیز از نو
        # پرسیده می‌شود، و سقف ۳۰ درخواست در دقیقه است. پس چیزهای واقعاً
        # ثابت باید بین بازدیدها بمانند.
        # و چون آدرس لوگو مستقیم در img.src می‌نشیند، هرچه از انبار مرورگر
        # بیرون می‌آید باید بی‌اعتبار فرض شود.
        logo = await pg.evaluate("""async () => {
            const realFetch = window.fetch;
            let hits = 0;
            const ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            const IMG  = "https://assets.example/token.png";
            const tok  = {address: ADDR, symbol: "FAKE"};
            const reset = () => {
                Object.keys(metaCache).forEach(k => delete metaCache[k]);
                Object.keys(poolCache).forEach(k => delete poolCache[k]);
                gtCache.clear(); gtInflight.clear(); gtFails = 0; gtCoolUntil = 0;
            };
            window.fetch = async (u) => {
                hits++;
                return /\\/pools/.test(String(u))
                  ? new Response(JSON.stringify({data: [{id: "base_0xPOOL"}]}), {status: 200})
                  : new Response(JSON.stringify(
                      {data: [{attributes: {address: ADDR, image_url: IMG}}]}), {status: 200});
            };
            localStorage.removeItem(LS_LOGO); localStorage.removeItem(LS_POOL);
            const out = {};

            reset();
            out.first = await tokenLogo(tok);
            out.firstHits = hits;

            // رفرش شبیه‌سازی‌شده: حافظه‌ی صفحه پاک، انبار مرورگر دست‌نخورده
            reset(); hits = 0;
            out.second = await tokenLogo(tok);
            out.secondHits = hits;

            reset(); hits = 0;
            out.pool1 = await topPoolFor(tok);
            const poolFirstHits = hits;
            reset(); hits = 0;
            out.pool2 = await topPoolFor(tok);
            out.poolHits = [poolFirstHits, hits];

            // انبار مسموم — نباید هرگز به img.src برسد
            localStorage.setItem(LS_LOGO, JSON.stringify(
                {[ADDR]: {v: "javascript:alert(1)", t: Date.now()}}));
            reset(); hits = 0;
            out.poisoned = await tokenLogo(tok);
            out.poisonHits = hits;

            localStorage.setItem(LS_POOL, JSON.stringify(
                {[ADDR]: {v: "../../evil", t: Date.now()}}));
            reset();
            out.poisonedPool = await topPoolFor(tok);

            // منقضی‌شده باید دوباره پرسیده شود، نه اینکه تا ابد بماند
            localStorage.setItem(LS_LOGO, JSON.stringify(
                {[ADDR]: {v: "https://stale.example/a.png", t: Date.now() - 8 * 864e5}}));
            reset(); hits = 0;
            out.expired = await tokenLogo(tok);
            out.expiredHits = hits;

            // «لوگو ندارد» باید زود منقضی شود. یک پاسخ ناقصِ گذرا نباید یک
            // هفته به «این توکن لوگو ندارد» تبدیل شود.
            localStorage.setItem(LS_LOGO, JSON.stringify(
                {[ADDR]: {v: "", t: Date.now() - 2 * 36e5}}));
            reset(); hits = 0;
            out.staleNone = await tokenLogo(tok);
            out.staleNoneHits = hits;
            // ولی همان «ندارد» تازه باید نگه داشته شود
            localStorage.setItem(LS_LOGO, JSON.stringify(
                {[ADDR]: {v: "", t: Date.now()}}));
            reset(); hits = 0;
            out.freshNone = await tokenLogo(tok);
            out.freshNoneHits = hits;

            // آدرس data: نمایش داده می‌شود ولی در انبار نمی‌ماند
            localStorage.removeItem(LS_LOGO);
            const DATA = "data:image/png;base64,iVBORw0KGgo=";
            window.fetch = async () => { hits++; return new Response(JSON.stringify(
                {data: [{attributes: {address: ADDR, image_url: DATA}}]}), {status: 200}); };
            reset();
            out.dataUrl = await tokenLogo(tok);
            out.dataStored = localStorage.getItem(LS_LOGO);

            window.fetch = realFetch;
            localStorage.removeItem(LS_LOGO); localStorage.removeItem(LS_POOL);
            reset();
            return out;
        }""")
        print("[logo cache] first=%s hit(s)=%s | after a refresh=%s hit(s)=%s | pool hits=%s"
              % (logo["first"], logo["firstHits"], logo["second"],
                 logo["secondHits"], logo["poolHits"]))
        assert logo["first"] == "https://assets.example/token.png", \
            "the logo did not come back on the first ask: %s" % logo["first"]
        assert logo["secondHits"] == 0 and logo["second"] == logo["first"], \
            ("a refresh asked for the logo again (%s network calls) — this is exactly what "
             "burns the 30-per-minute budget" % logo["secondHits"])
        assert logo["pool1"] == "0xPOOL" and logo["pool2"] == "0xPOOL", \
            "the top pool id changed across a refresh: %s then %s" % (logo["pool1"], logo["pool2"])
        assert logo["poolHits"] == [1, 0], \
            "the pool id was fetched again after a refresh: %s" % logo["poolHits"]
        print("[logo cache] poisoned store -> logo=%s (%s call), pool=%s | expired -> %s (%s call)"
              % (logo["poisoned"], logo["poisonHits"], logo["poisonedPool"],
                 logo["expired"], logo["expiredHits"]))
        assert logo["poisoned"] == "https://assets.example/token.png", \
            ("a javascript: url from localStorage came back as a logo and would have gone "
             "straight into img.src: %s" % logo["poisoned"])
        assert logo["poisonHits"] >= 1, "the poisoned entry was refused but nothing was refetched"
        assert logo["poisonedPool"] == "0xPOOL", \
            "a poisoned pool id was trusted: %s" % logo["poisonedPool"]
        assert logo["expired"] == "https://assets.example/token.png" and logo["expiredHits"] >= 1, \
            "an expired logo entry was served instead of being refreshed: %s" % logo["expired"]
        print("[logo cache] 'no logo' -> kept %s call when fresh, %s call when 2h old | "
              "data: url shown=%s stored=%s"
              % (logo["freshNoneHits"], logo["staleNoneHits"],
                 str(logo["dataUrl"])[:24], logo["dataStored"]))
        assert logo["freshNoneHits"] == 0 and logo["freshNone"] is None, \
            "a fresh 'this token has no logo' answer was asked for again: %s" % logo["freshNoneHits"]
        assert logo["staleNoneHits"] >= 1, \
            ("a 'no logo' answer older than an hour was reused — a transient gap in the "
             "response must not turn into 'this token has no logo' for a week")
        # ماک اینجا واقعیت را آینه نمی‌کند: در هارنس image_url یک data: url است،
        # در حالی که GeckoTerminal واقعی https می‌دهد. پس هر دو حالت سنجیده
        # می‌شوند — نمایش باید کار کند، ذخیره نباید.
        assert logo["dataUrl"] == "data:image/png;base64,iVBORw0KGgo=", \
            "a data: logo from the service must still be displayed: %s" % logo["dataUrl"]
        assert not logo["dataStored"] or "data:" not in logo["dataStored"], \
            ("a data: url was written into localStorage — only https urls are safe to read "
             "back into img.src: %s" % logo["dataStored"])

        # ---- 2b-ter. the action button must not move between pairs ----
        # اعلان‌ها بین جدول و دکمه بودند و ارتفاعشان به جفت توکن بستگی دارد،
        # پس دکمه با هر تعویض توکن تا ۷۸ پیکسل بالا و پایین می‌پرید — درست
        # همان لحظه‌ای که کاربر می‌خواهد کلیک کند.
        tops = {}
        # ⚠️ نه `a, b` — `b` نام مرورگر است و سایه‌انداختن رویش قبلاً
        #    await b.close() را در انتهای تست ترکانده بود.
        for sIn, sOut in [("USDC", "WETH"), ("ETH", "USDC"),
                          ("cbBTC", "DAI"), ("USDC", "AERO")]:
            await pg.evaluate("""([i, o]) => {
                tokenIn = allTokens().find(t => t.symbol === i);
                tokenOut = allTokens().find(t => t.symbol === o);
                paintToken("in", tokenIn); paintToken("out", tokenOut);
                loadChart(); runScan(tokenOut);
            }""", [sIn, sOut])
            await pg.fill("#amtIn", "1")
            await pg.wait_for_timeout(3200)
            tops[f"{sIn}->{sOut}"] = await pg.evaluate("""() => {
                const r = document.getElementById("actBtn").getBoundingClientRect();
                const n = document.getElementById("notices").getBoundingClientRect();
                return {top: Math.round(r.top), notice: Math.round(n.height)};
            }""")
        for k, v in tops.items():
            print("[cta %s] top=%s (notice height %s)" % (k, v["top"], v["notice"]))
        uniq = {v["top"] for v in tops.values()}
        assert len(uniq) == 1, \
            ("the swap button jumps between pairs: %s — anything whose height depends on the "
             "pair must sit below it, not above" % tops)
        assert any(v["notice"] > 0 for v in tops.values()), \
            "the probe is toothless: no pair produced a notice, so nothing was actually tested"

        # ---- 2b-bis. clear button, header layout, token stats ----
        clr = await pg.evaluate("""async () => {
            const inp = document.getElementById("amtIn"),
                  btn = document.getElementById("amtClear");
            const hid = () => btn.hidden || getComputedStyle(btn).display === "none";
            // فیلد از کاوشگرهای قبلی مقدار دارد؛ اول واقعاً خالی‌اش کن
            inp.value = ""; inp.dispatchEvent(new Event("input"));
            await new Promise(r => setTimeout(r, 200));
            const empty = hid();
            inp.value = "12.5"; inp.dispatchEvent(new Event("input"));
            await new Promise(r => setTimeout(r, 200));
            const typed = hid();
            btn.click();
            await new Promise(r => setTimeout(r, 200));
            return {whenEmpty: empty, whenTyped: typed,
                    afterClick: hid(), value: inp.value, out: document.getElementById("amtOut").value};
        }""")
        print("[clear btn] empty=hidden:%s typed=hidden:%s afterClick=hidden:%s value=%r"
              % (clr["whenEmpty"], clr["whenTyped"], clr["afterClick"], clr["value"]))
        assert clr["whenEmpty"], "the clear button must not sit on an empty field"
        assert not clr["whenTyped"], "the clear button must appear once an amount is typed"
        assert clr["value"] == "" and clr["out"] == "", \
            "clearing must empty both sides, not just the one you typed in"
        assert clr["afterClick"], "the clear button must disappear again after clearing"

        # هدر: ناوبری باید بین لوگو و چیپ‌های راست وسط بماند، نه چسبیده به لوگو
        head = await pg.evaluate("""() => {
            const logo = document.querySelector(".logo").getBoundingClientRect();
            const nav = document.getElementById("nav").getBoundingClientRect();
            const chip = document.getElementById("srcChip").getBoundingClientRect();
            return {gapLeft: Math.round(nav.left - logo.right),
                    gapRight: Math.round(chip.left - nav.right),
                    navLeft: Math.round(nav.left), navRight: Math.round(nav.right),
                    vw: innerWidth};
        }""")
        print("[header] logo|%spx|nav|%spx|chips  (nav %s..%s of %s)"
              % (head["gapLeft"], head["gapRight"], head["navLeft"], head["navRight"], head["vw"]))
        assert head["gapLeft"] > 8 and head["gapRight"] > 8, \
            "the nav touches the logo or the chips: %s" % head
        lo, hi = sorted((head["gapLeft"], head["gapRight"]))
        assert lo / hi >= 0.3, \
            ("the nav is not balanced between logo and chips (%spx vs %spx) — it should "
             "sit between them, not be shoved to one side" % (head["gapLeft"], head["gapRight"]))

        # عرض‌های میانی جایی است که هدر معمولاً می‌شکند: ناوبری هنوز در هدر
        # است ولی جا تنگ شده. هیچ چیزی نباید از لبه بزند بیرون یا بپیچد.
        narrow = await b.new_page(viewport={"width": 760, "height": 900}, color_scheme="dark")
        await narrow.goto(URL); await narrow.wait_for_timeout(900)
        hn = await narrow.evaluate("""() => {
            const h = document.querySelector("header");
            const kids = [...h.children].map(e => e.getBoundingClientRect());
            const tops = new Set(kids.filter(r => r.width > 0).map(r => Math.round(r.top / 12)));
            return {right: Math.round(Math.max(...kids.map(r => r.right))),
                    left: Math.round(Math.min(...kids.map(r => r.left))),
                    rows: tops.size, vw: innerWidth,
                    docW: Math.round(document.documentElement.scrollWidth)};
        }""")
        await narrow.close()
        print("[header 760] left=%s right=%s rows=%s doc=%s viewport=%s"
              % (hn["left"], hn["right"], hn["rows"], hn["docW"], hn["vw"]))
        assert hn["left"] >= 0 and hn["right"] <= hn["vw"] + 1, \
            "the header runs off the edge at 760px: %s" % hn
        assert hn["docW"] <= hn["vw"] + 1, \
            "the page scrolls sideways at 760px — something in the header is too wide: %s" % hn
        assert hn["rows"] == 1, "the header wrapped onto %s rows at 760px" % hn["rows"]

        # آمار توکن خروجی
        stats = await pg.evaluate("""async () => {
            for (let i = 0; i < 40; i++) {
                const b = document.getElementById("tokStats");
                if (!b.hidden && b.children.length) break;
                await new Promise(r => setTimeout(r, 150));
            }
            const b = document.getElementById("tokStats");
            return {hidden: b.hidden,
                    keys: [...b.querySelectorAll(".k")].map(e => e.textContent),
                    vals: [...b.querySelectorAll(".v")].map(e => e.textContent)};
        }""")
        print("[token stats] %s = %s" % (stats["keys"], stats["vals"]))
        assert not stats["hidden"], "the output token's stats never appeared"
        for k in ["Market cap", "FDV", "Volume 24h"]:
            assert k in stats["keys"], "%s is missing from the token stats: %s" % (k, stats["keys"])
        # «هولدرز» عمداً نیست: منبع دادهٔ ما نمی‌دهدش و عدد ساختن بدتر از
        # نداشتن است. اگر روزی اضافه شد، باید از یک منبع واقعی بیاید.
        assert not any("older" in k for k in stats["keys"]), \
            "holders is not available from GeckoTerminal — do not invent it"

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
        # WalletConnect همیشه در لیست هست — تنها راهِ کیف پول موبایل، و چیزی
        # لازم ندارد نصب شود. پس گزینه‌ها = افزونه‌های کشف‌شده + یک ردیف WC.
        assert "WalletConnect" in picker["names"], \
            "WalletConnect must always be offered, even with extensions installed"
        assert picker["icons"] == len(picker["names"]), \
            "every row must show its own icon, not a letter fallback"
        assert not picker["stillOpen"], "the picker must close once a wallet is chosen"

        # ---- 2c-sexies. the vendored WalletConnect bundle really is self-contained ----
        # نسخه‌ی رسمی UMD خودِ WalletConnect در مرورگر بی‌صدا می‌شکند چون
        # viem/lit/bs58 را از روی صفحه انتظار دارد. ما خودمان بسته‌اش کردیم و
        # این کاوشگر همان ادعا را می‌سنجد: با یک <script> تنها بار شود و
        # EthereumProvider.init واقعاً وجود داشته باشد.
        # روی http سرو می‌شود نه file:// — بسته موقع بار شدن به localStorage
        # دست می‌زند و مبدأ مبهم اجازه نمی‌دهد.
        import functools, http.server, threading
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *a):     # خروجی تست باید خوانا بماند
                pass
        srv = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0),
            functools.partial(Quiet, directory=os.path.join(HERE, "..")))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        port = srv.server_address[1]
        wcpg = await b.new_page()
        wc_errs = []
        wcpg.on("pageerror", lambda e: wc_errs.append(str(e)))
        await wcpg.goto("http://127.0.0.1:%d/" % port)
        wc_load = await wcpg.evaluate("""async () => {
            await new Promise((res, rej) => {
                const s = document.createElement("script");
                s.src = "./walletconnect.bundle.js";
                s.onload = res; s.onerror = () => rej(new Error("script failed"));
                document.head.appendChild(s);
            });
            const W = window.WCProvider;
            return {registered: !!W,
                    hasInit: !!(W && W.EthereumProvider &&
                                typeof W.EthereumProvider.init === "function")};
        }""")
        await wcpg.close()
        print("[walletconnect] bundle loads standalone: registered=%s init=%s errors=%s"
              % (wc_load["registered"], wc_load["hasInit"], len(wc_errs)))
        assert wc_load["registered"] and wc_load["hasInit"], \
            "the WalletConnect bundle did not register a usable EthereumProvider"
        assert not wc_errs, "the WalletConnect bundle threw while loading: %s" % wc_errs[:2]
        # ⚠️ چیزی که این تست *نمی‌سنجد*: خودِ دست‌دادن با رله‌ی WalletConnect.
        #    آن به سرور بیرونی نیاز دارد و آفلاین قابل آزمودن نیست.

        # ---- 2c-septies. Custom RPC ----
        # روی http سرو می‌شود چون file:// مبدأ مبهم دارد و localStorage
        # آنجا اصلاً کار نمی‌کند — یعنی ماندگاری روی file:// قابل آزمودن نیست.
        rpcpg = await b.new_page()
        await rpcpg.goto("http://127.0.0.1:%d/test/harness.html?rpc=https://evil.example" % port)
        await rpcpg.wait_for_timeout(1200)

        # مهم‌ترین ادعای این بخش: یک *لینک* هرگز نباید منبع داده را عوض کند.
        from_link = await rpcpg.evaluate(
            "() => ({field: document.getElementById('rpcCustom').value,"
            " first: CHAIN.rpcs[0], custom: customRpc})")
        print("[rpc link] field=%r first=%s custom=%s"
              % (from_link["field"], from_link["first"][:34], from_link["custom"]))
        assert from_link["field"] == "" and "evil" not in from_link["first"], \
            "a URL parameter must never set the RPC endpoint: %s" % from_link

        rpc = await rpcpg.evaluate("""async () => {
            const out = {};
            const state = () => document.getElementById("rpcState").textContent;
            const fill = v => { document.getElementById("rpcCustom").value = v; };
            const wait = async () => { for (let i = 0; i < 40; i++) {
                if (!/Testing/.test(state())) return; await new Promise(r=>setTimeout(r,50)); } };

            fill("http://plain.example"); await saveCustomRpc("http://plain.example");
            out.http = {msg: state(), first: CHAIN.rpcs[0], saved: localStorage.getItem("zaexa.rpc")};

            window.__STUB_RPC__ = {"https://wrong.example": 1,
                                   "https://dead.example": "unreachable"};
            await saveCustomRpc("https://wrong.example"); await wait();
            out.wrongChain = {msg: state(), first: CHAIN.rpcs[0],
                              saved: localStorage.getItem("zaexa.rpc")};

            await saveCustomRpc("https://dead.example"); await wait();
            out.dead = {msg: state(), saved: localStorage.getItem("zaexa.rpc")};

            await saveCustomRpc("https://good.example/k/SECRET123"); await wait();
            out.good = {msg: state(), first: CHAIN.rpcs[0],
                        saved: localStorage.getItem("zaexa.rpc"),
                        fallbackKept: CHAIN.rpcs.length > 1};
            return out;
        }""")
        for k in ["http", "wrongChain", "dead", "good"]:
            print("[rpc %s] %s" % (k, rpc[k]["msg"][:64]))
        assert rpc["http"]["saved"] is None and "https" in rpc["http"]["msg"], \
            "an http endpoint must be refused: %s" % rpc["http"]
        assert rpc["wrongChain"]["saved"] is None and "Base" in rpc["wrongChain"]["msg"], \
            "an endpoint on another chain must be refused: %s" % rpc["wrongChain"]
        assert rpc["dead"]["saved"] is None, \
            "an endpoint that never answers must not be saved: %s" % rpc["dead"]
        assert rpc["good"]["saved"] == "https://good.example/k/SECRET123", \
            "a working endpoint must persist: %s" % rpc["good"]
        assert "SECRET123" not in rpc["good"]["msg"], \
            "the endpoint may carry a private key — never print it in full: %s" % rpc["good"]["msg"]
        assert rpc["good"]["fallbackKept"], \
            "the public endpoints must stay as a fallback behind the custom one"

        # ماندگاری بعد از رفرش، و اینکه Clear واقعاً پاک می‌کند
        await rpcpg.goto("http://127.0.0.1:%d/test/harness.html" % port)
        await rpcpg.wait_for_timeout(1200)
        after = await rpcpg.evaluate("""async () => {
            const before = {field: document.getElementById("rpcCustom").value,
                            first: CHAIN.rpcs[0]};
            clearCustomRpc();
            return {before, after: {field: document.getElementById("rpcCustom").value,
                                    first: CHAIN.rpcs[0],
                                    saved: localStorage.getItem("zaexa.rpc")}};
        }""")
        await rpcpg.close()
        print("[rpc reload] restored=%s → cleared=%s"
              % (after["before"]["first"][:28], after["after"]["first"][:28]))
        assert after["before"]["field"] == "https://good.example/k/SECRET123", \
            "a saved endpoint must come back after a reload: %s" % after["before"]
        assert after["after"]["saved"] is None and "good.example" not in after["after"]["first"], \
            "Clear must remove it from storage and stop using it: %s" % after["after"]

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
        srv.shutdown()
        await b.close()

    print("\n--- console errors ---")
    if errors:
        for e in errors: print("  ", e)
        sys.exit(1)
    print("   none")

asyncio.run(main())
