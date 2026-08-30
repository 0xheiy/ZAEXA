import asyncio, base64, glob, os, re, sys
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))

def vendor_path(prefix):
    """مسیر باندل وندور با هر هشی که در نامش هست. دقیقاً یکی باید باشد."""
    matches = glob.glob(os.path.join(HERE, "..", prefix + ".*.js"))
    assert len(matches) == 1, (
        "expected exactly one %s.<hash>.js next to index.html, found %d: %s"
        % (prefix, len(matches), matches))
    return matches[0]

def build_harness():
    """harness = index.html با لودر ethers که به stub محلی اشاره می‌کند.

    ⚠️ هش SRI هم خالی می‌شود. هش فایل واقعی به استاب نمی‌خورد، و روی `file://`
    اصلاً SRI اجازه‌ی اجرا نمی‌دهد. اینکه هارنس هش ندارد اشکالی نیست —
    check_no_remote_code جداگانه می‌سنجد که *نسخه‌ی منتشرشده* هش دارد و
    هشش با خودِ فایل vendor‌شده یکی است."""
    src = open(os.path.join(HERE, "..", "index.html"), encoding="utf-8").read()
    # ⚠️ حضور را می‌سنجیم نه تغییر را. نسخه‌ی اول این را با «قبل != بعد» چک
    # می‌کرد و وقتی مقدار از قبل همان جایگزین بود (SRI خالی) بی‌ربط می‌افتاد و
    # جای نگهبان واقعی را می‌گرفت — یعنی خطای درست را با پیام غلط نشان می‌داد.
    assert re.search(r'const ETHERS_SRC="[^"]*";', src), \
        "the harness cannot find ETHERS_SRC — did the ethers loader get renamed?"
    assert re.search(r'const ETHERS_SRI="[^"]*";', src), \
        "the harness cannot find ETHERS_SRI — did the ethers loader get renamed?"
    src3 = re.sub(r'const ETHERS_SRC="[^"]*";',
                  'const ETHERS_SRC="./stub-ethers.js";', src, count=1)
    src3 = re.sub(r'const ETHERS_SRI="[^"]*";', 'const ETHERS_SRI="";', src3, count=1)
    path = os.path.join(HERE, "harness.html")
    open(path, "w", encoding="utf-8").write(src3)
    return path

# The product opens on its marketing route; UI probes explicitly target the app route.
URL = "file://" + build_harness() + "#swap"

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
    m = re.search(r'const ETHERS_SRC="([^"]*)";', src)
    assert m, "ETHERS_SRC is gone — the ethers loader was rewritten, re-check this guard"
    decl = m.group(1)
    assert not decl.startswith("http://") and not decl.startswith("https://"), \
        "ethers must not be loaded from a remote origin: " + decl
    # آرایه‌ی چندمقداری برنگردد. سنجش روی *اعلان* است نه روی نام، وگرنه یک
    # کامنت که ماجرا را توضیح می‌دهد هم نگهبان را می‌انداخت.
    assert not re.search(r'\bconst\s+ETHERS_CDNS\s*=', src), \
        "the ETHERS_CDNS list is back — a list with a fallback loop invites exactly the " \
        "remote fallback this guard exists to prevent. One source, loaded directly."
    # و خودِ لودر نباید حلقه داشته باشد: حلقه یعنی «عضو بعدی» یعنی fallback.
    ld = re.search(r'function loadEthers\(\)\{.*?\n\}', src, re.S)
    assert ld, "loadEthers is gone or reshaped — re-check this guard"
    body = ld.group(0)
    assert not re.search(r'\bfor\s*\(|\bwhile\s*\(|\bi\+\+', body), \
        "loadEthers loops over sources again — one source, no fallthrough:\n" + body[:300]
    # و اعمالِ هش باید به پروتکل مشروط بماند. بدون این شرط، صفحه‌ای که با
    # file:// باز شود اصلاً بالا نمی‌آید: مبدأ «null» است، کروم برای طرح file
    # هیچ CORS نمی‌دهد، و اسکریپت *پیش از* مقایسه‌ی هش بلاک می‌شود. README
    # همان مسیر را به کاربر پیشنهاد می‌دهد، پس این یک شاخه‌ی تزئینی نیست.
    gate = re.search(r'if\(ETHERS_SRI&&/\^https\?:\$/\.test\(location\.protocol\)\)', src)
    assert gate, (
        "the integrity attribute is no longer gated on the protocol. Applying it over "
        "file:// blocks the script before the hash is ever compared, and the whole app "
        "dies with a message that blames the user's connection. Keep the gate; SRI "
        "defends against a tampered host, which a local file does not have.")

    vendored = vendor_path("ethers.umd.min")

    # هش SRI باید ناخالی باشد *و* با خودِ فایل بخواند. تا امروز آن sha384 فقط
    # یک کامنت بود؛ حالا مرورگر اعمالش می‌کند، پس اگر فایل عوض شود و هش عقب
    # بماند، سایت زنده می‌شکند. این نگهبان همان اتفاق را قبل از انتشار می‌گیرد.
    import base64, hashlib
    sri = re.search(r'const ETHERS_SRI="([^"]*)";', src)
    assert sri, "ETHERS_SRI is gone — the integrity hash must ship with the page"
    want = sri.group(1)
    assert want.startswith("sha384-"), \
        "ETHERS_SRI must be a sha384- value in the shipped page, got: %r" % want
    actual = "sha384-" + base64.b64encode(
        hashlib.sha384(open(vendored, "rb").read()).digest()).decode()
    assert want == actual, (
        "the integrity hash in index.html does not match %s.\n"
        "  page:  %s\n  file:  %s\n"
        "Either the vendored file changed without updating ETHERS_SRI (the live site "
        "would refuse to run ethers at all), or the file is not the one we pinned."
        % (os.path.basename(vendored), want, actual))

    # ethers تنها اسکریپت بیرونی نیست. هر جای دیگری هم که کد بار می‌شود باید
    # محلی باشد — WalletConnect با یک <script> پویا می‌آید و اگر روزی کسی
    # آدرسش را به یک CDN عوض کند، بررسی بالا اصلاً نمی‌بیندش.
    remote_srcs = [m for m in re.findall(r"""(?:src|s\.src)\s*=\s*["']([^"']+)["']""", src)
                   if m.startswith("http://") or m.startswith("https://")]
    assert not remote_srcs, \
        "code must never be loaded from a remote origin: %s" % remote_srcs
    wc = vendor_path("walletconnect.bundle")
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

def check_asset_cache_headers():
    """باندل‌های وندور یک سال immutable کش می‌شوند (web/_headers) و این فقط
    وقتی بی‌خطر است که نام هر فایل شامل هش محتوایش باشد — وگرنه یک باگ در
    باندل یک سال روی مرورگر کاربر گیر می‌کند و هیچ انتشار تازه‌ای نجاتش
    نمی‌دهد. این نگهبان همان پیش‌شرط را روی خودِ فایل‌ها می‌سنجد، نه روی حرف."""
    import hashlib
    webdir = os.path.join(HERE, "..")

    # ۱) خودِ فایل باید باشد.
    headers_path = os.path.join(webdir, "_headers")
    assert os.path.exists(headers_path), \
        "web/_headers is missing — the vendor bundles fall back to Cloudflare's default " \
        "of max-age=0, must-revalidate and every page load revalidates 2.5MB for nothing"
    headers_src = open(headers_path, encoding="utf-8").read()

    # ۲) الگو را می‌پارسیم، نه کل فایل را substring-match — یک max-age روی
    #    یک الگوی دیگر نباید این را قبول‌شده جا بزند.
    blocks, cur_pattern, cur_lines = {}, None, []
    for raw in headers_src.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if raw[:1] not in (" ", "\t"):
            if cur_pattern is not None:
                blocks[cur_pattern] = cur_lines
            cur_pattern, cur_lines = raw.strip(), []
        else:
            cur_lines.append(raw.strip())
    if cur_pattern is not None:
        blocks[cur_pattern] = cur_lines
    assert "/*.js" in blocks, \
        "web/_headers has no /*.js pattern — the vendor bundles are not covered: %r" \
        % list(blocks)
    cc = None
    for line in blocks["/*.js"]:
        if line.lower().startswith("cache-control:"):
            cc = line.split(":", 1)[1].strip()
    assert cc, "the /*.js block in web/_headers sets no Cache-Control header"
    mage = re.search(r"max-age=(\d+)", cc)
    assert mage and int(mage.group(1)) >= 31536000, \
        "the /*.js Cache-Control max-age is too short to call this immutable: %r" % cc
    assert "immutable" in cc, \
        "the /*.js Cache-Control is missing 'immutable': %r" % cc

    # ۲ب) و قرینه‌اش، که مهم‌تر است: index.html هرگز نباید immutable شود.
    #     نامش هش ندارد و هیچ‌وقت هم نخواهد داشت — آدرسش همان `/` است. اگر
    #     روزی کسی قاعده‌ای بنویسد که به آن هم بخورد، هر انتشار تازه تا یک
    #     سال به کاربرهای فعلی نمی‌رسد و هیچ‌کس نمی‌فهمد چرا.
    for pat, lines in blocks.items():
        if pat not in ("/", "/*", "/index.html", "/*.html"):
            continue
        for line in lines:
            if not line.lower().startswith("cache-control:"):
                continue
            v = line.split(":", 1)[1].strip()
            m2 = re.search(r"max-age=(\d+)", v)
            assert "immutable" not in v.lower() and not (m2 and int(m2.group(1)) > 300), (
                "the pattern %r in web/_headers caches index.html hard (%r). index.html "
                "carries no content hash, so a new deployment would never reach anyone "
                "who already has the old one." % (pat, v))

    # ۳) پیش‌شرط ایمنی‌ِ قاعده‌ی بالا: هر js کنار index.html باید نامش هشِ
    #    خودش را حمل کند، وگرنه یک بازسازی بی‌سروصدا زیر یک آدرس immutable
    #    یک سال گم می‌شود.
    js_files = sorted(f for f in os.listdir(webdir)
                       if f.endswith(".js") and os.path.isfile(os.path.join(webdir, f)))
    name_re = re.compile(r"^(.+)\.([0-9a-f]{8})\.js$")
    for f in js_files:
        m = name_re.match(f)
        assert m, (
            "web/%s sits next to index.html without a content hash in its name. The "
            "blanket immutable rule in web/_headers applies to every *.js file here, so "
            "an unhashed one would be cached for a year with no way to invalidate it." % f)
        want = hashlib.sha256(open(os.path.join(webdir, f), "rb").read()).hexdigest()[:8]
        assert m.group(2) == want, (
            "web/%s claims hash %s but its real sha256 starts with %s — the file changed "
            "without its name changing, which is exactly what the immutable rule cannot "
            "survive." % (f, m.group(2), want))

    # ۴) هر ارجاعی در index.html باید به فایلی که واقعاً وجود دارد باشد —
    #    وگرنه یک تغییرِ نام جاماندهْ سایت را از کار می‌اندازد.
    idx_src = open(os.path.join(webdir, "index.html"), encoding="utf-8").read()
    refs = sorted(set(re.findall(r'"\./([A-Za-z0-9_.-]+\.js)"', idx_src)))
    assert refs, "no local .js script reference found in index.html — re-check this guard"
    for r_ in refs:
        assert os.path.exists(os.path.join(webdir, r_)), (
            "index.html references \"./%s\" but no such file exists next to it — "
            "the page would 404 loading it." % r_)

    # ۵) دستور ساخت مستندشده باید هم _headers و هم همه‌ی js را کپی کند.
    wr_src = open(os.path.join(HERE, "..", "..", "wrangler.toml"), encoding="utf-8").read()
    build_line = next((l for l in wr_src.splitlines() if "cp web/index.html" in l), None)
    assert build_line, "wrangler.toml no longer documents the Build command — re-check this guard"
    assert "web/_headers" in build_line, (
        "the documented Build command does not copy web/_headers, so the immutable cache "
        "rule silently never ships: %s" % build_line.strip())
    assert "web/*.js" in build_line, (
        "the documented Build command no longer globs web/*.js, so a rebuilt vendor bundle "
        "with a new hash in its name would need someone to remember to edit this line by "
        "hand: %s" % build_line.strip())

    print("[cache] vendor bundles are content-addressed and immutable: %s (max-age=%s)"
          % (", ".join(js_files), mage.group(1)))

def check_brand_palette():
    """پالت «ارکید» — سه چیز که هرکدام یک‌بار واقعاً شکسته بودند.

    ۱) هگزهای برندِ قبلی (#9688F7 و #A785F9) نباید هیچ‌جای index.html مانده
       باشند — نه در CSS/SVG متنِ صفحه، و نه داخل دیتا-یوآرآیِ base64ِ
       فاویکون. grep ساده دومی را نمی‌بیند چون رشته‌ی base64 هیچ شباهتی به
       هگزهای اصلی ندارد؛ این نگهبان قبل از مقایسه فاویکون را decode می‌کند.
    ۲) نشانِ هدر باید همان چهار توقفِ ثابتِ گرادیان را نگه داشته باشد
       (#22EFF6 #22D2F5 #43B5F7 #7396F8) به‌علاوه‌ی دو سرِ تازه
       (#9C82F9 #C56CF5) — یعنی این یک گرادیانِ نو نیست، همان گرادیان با دو
       سرِ عوض‌شده. اگر یکی از چهارتای میانی غایب شود یعنی کسی گرادیان را
       کامل بازنویسی کرده، نه فقط بازرنگ.
    ۳) --g1/--g2 باید *داخل* هر دو بلوکِ تم تعریف شده باشند، نه بیرون از
       آن‌ها. باگِ واقعی این بود: وقتی این دو بیرون از تم بودند، دکمه‌ی
       اصلی در هر دو تم همان یک گرادیانِ روشن را می‌گرفت و متنِ سفیدِ رویش
       در تمِ تیره کنتراستِ ۱.۸۱:۱ داشت (کفِ WCAG برای متن معمولی ۴.۵:۱
       است). این نگهبان کنتراست را از رویِ خودِ هگزهای فایل حساب می‌کند —
       عدد را اینجا هاردکد نکرده تا اگر رنگی روزی عوض شد و کنتراست دوباره
       افتاد، خودش را نشان بدهد، نه اینکه ساکت بماند چون «قبلاً درست
       بود». بدترین نقطه‌ی رمپ سنجیده می‌شود، نه فقط دو سرش، چون کمینه‌ی
       کنتراست معمولاً وسطِ گرادیان می‌افتد — جایی که هیچ توسعه‌دهنده‌ای با
       چشم نگاه نمی‌کند."""
    src = open(os.path.join(HERE, "..", "index.html"), encoding="utf-8").read()

    old_hexes = ["9688F7", "A785F9"]
    low = src.lower()
    leaked = [h for h in old_hexes if h.lower() in low]

    fm = re.search(
        r'<link rel="icon"[^>]*href="data:image/svg\+xml;base64,([A-Za-z0-9+/=]+)"', src)
    assert fm, "the favicon <link> is gone — this guard has nothing to decode"
    favicon_svg = base64.b64decode(fm.group(1)).decode("utf-8", "replace")
    leaked_fav = [h for h in old_hexes if h.lower() in favicon_svg.lower()]
    assert not leaked and not leaked_fav, (
        "an old Orchid hex survived the recolor (in the page: %s, inside the decoded "
        "favicon: %s)" % (leaked, leaked_fav))

    mm = re.search(r'<span class="glyph"><svg class="mark".*?</span>', src, re.S)
    assert mm, "the header mark svg is gone"
    mark_src = mm.group(0)
    unchanged = ["22EFF6", "22D2F5", "43B5F7", "7396F8"]
    new_stops = ["9C82F9", "C56CF5"]
    missing_unchanged = [h for h in unchanged if h.lower() not in mark_src.lower()]
    missing_new = [h for h in new_stops if h.lower() not in mark_src.lower()]
    assert not missing_unchanged and not missing_new, (
        "the header mark's gradient drifted — missing untouched stops %s, missing new "
        "stops %s" % (missing_unchanged, missing_new))

    lm = re.search(r':root\[data-theme="light"\]\{(.*?)\n\}', src, re.S)
    dm = re.search(r':root\[data-theme="dark"\]\{(.*?)\n\}', src, re.S)
    assert lm and dm, "could not find both :root[data-theme=...] blocks in index.html"
    light_block, dark_block = lm.group(1), dm.group(1)
    for label, block in (("light", light_block), ("dark", dark_block)):
        assert re.search(r"--g1:\s*#[0-9A-Fa-f]{3,6}", block), \
            "--g1 is not defined inside the %s theme block" % label
        assert re.search(r"--g2:\s*#[0-9A-Fa-f]{3,6}", block), \
            "--g2 is not defined inside the %s theme block" % label

    def expand(hexcolor):
        h = hexcolor.lstrip("#")
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        return "#" + h

    def toks(block):
        g1 = expand(re.search(r"--g1:\s*(#[0-9A-Fa-f]{3,6})", block).group(1))
        g2 = expand(re.search(r"--g2:\s*(#[0-9A-Fa-f]{3,6})", block).group(1))
        onacc = expand(re.search(r"--on-acc:\s*(#[0-9A-Fa-f]{3,6})", block).group(1))
        return g1, g2, onacc

    def srgb_lin(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    def rel_lum(hexcolor):
        h = hexcolor.lstrip("#")
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        return 0.2126 * srgb_lin(r) + 0.7152 * srgb_lin(g) + 0.0722 * srgb_lin(b)

    def contrast(h1, h2):
        l1, l2 = rel_lum(h1), rel_lum(h2)
        l1, l2 = max(l1, l2), min(l1, l2)
        return (l1 + 0.05) / (l2 + 0.05)

    def mix(h1, h2, t):
        a, b = h1.lstrip("#"), h2.lstrip("#")
        out = []
        for i in (0, 2, 4):
            va, vb = int(a[i:i + 2], 16), int(b[i:i + 2], 16)
            out.append(round(va + (vb - va) * t))
        return "#%02x%02x%02x" % tuple(out)

    def worst_ratio(g1, g2, text, steps=100):
        return min(contrast(text, mix(g1, g2, i / steps)) for i in range(steps + 1))

    lg1, lg2, lonacc = toks(light_block)
    dg1, dg2, donacc = toks(dark_block)
    light_ratio = worst_ratio(lg1, lg2, lonacc)
    dark_ratio = worst_ratio(dg1, dg2, donacc)
    # \u26a0\ufe0f \u06f1\u06f4\u06f0\u06f5/\u06f0\u06f6/\u06f0\u06f7 (\u06f2\u06f0\u06f2\u06f6-\u06f0\u06f8-\u06f2\u06f9): \u0645\u0627\u0644\u06a9 \u0645\u062d\u0635\u0648\u0644 \u0639\u0645\u062f\u0627\u064b \u0647\u0645\u06cc\u0646 \u06af\u0631\u0627\u062f\u06cc\u0627\u0646\u0650 \u0632\u0646\u062f\u0647\u0654 \u0628\u0631\u0646\u062f \u0631\u0627
    # \u0628\u0627 \u0645\u062a\u0646\u0650 \u0633\u0641\u06cc\u062f\u0650 \u0631\u0648\u06cc\u0634 \u062f\u0631 \u062a\u0645\u0650 \u0631\u0648\u0634\u0646 \u0627\u0646\u062a\u062e\u0627\u0628 \u06a9\u0631\u062f \u2014 \u0628\u0627 \u0639\u0644\u0645 \u0628\u0647 \u0627\u06cc\u0646\u200c\u06a9\u0647 \u06a9\u0646\u062a\u0631\u0627\u0633\u062a
    # \u0632\u06cc\u0631\u0650 \u06a9\u0641\u0650 \u06f4.\u06f5 WCAG \u0645\u06cc\u200c\u0627\u0641\u062a\u062f (\u0646\u0642\u0637\u0647\u200c\u06cc \u0628\u062f\u062a\u0631\u06cc\u0646 ~\u06f1.\u06f4\u06f2:\u06f1). \u0627\u06cc\u0646 \u06cc\u06a9 \u0646\u0642\u0635 \u0646\u06cc\u0633\u062a\u061b
    # \u06a9\u0641\u0650 \u06f4.\u06f5 \u062f\u06cc\u06af\u0631 \u0631\u0648\u06cc *\u0627\u06cc\u0646* \u06a9\u0646\u062a\u0631\u0644\u0650 \u0646\u0627\u0645\u200c\u0628\u0631\u062f\u0647 \u062f\u0631 \u062a\u0645\u0650 \u0631\u0648\u0634\u0646 \u0627\u0639\u0645\u0627\u0644 \u0646\u0645\u06cc\u200c\u0634\u0648\u062f. \u0648\u0644\u06cc
    # \u06a9\u0641 \u06a9\u0627\u0645\u0644\u0627\u064b \u0628\u0631\u062f\u0627\u0634\u062a\u0647 \u0646\u0634\u062f\u0647 \u2014 \u06a9\u0641\u0650 \u067e\u0627\u06cc\u06cc\u0646\u200c\u062a\u0631\u0650 \u062a\u0627\u0632\u0647 \u0647\u0645\u0627\u0646 \u0645\u0642\u062f\u0627\u0631\u0650 \u067e\u0630\u06cc\u0631\u0641\u062a\u0647\u200c\u0634\u062f\u0647\u200c\u06cc
    # \u0641\u0639\u0644\u06cc \u0627\u0633\u062a\u060c \u067e\u0633 \u0627\u06af\u0631 \u06a9\u0646\u062a\u0631\u0627\u0633\u062a \u0627\u0632 \u0647\u0645\u06cc\u0646\u200c\u062c\u0627 \u0647\u0645 \u067e\u0627\u06cc\u06cc\u0646\u200c\u062a\u0631 \u0631\u0641\u062a (\u0631\u0646\u06af\u06cc \u062d\u062a\u06cc
    # \u0631\u0648\u0634\u0646\u200c\u062a\u0631\u060c \u06cc\u0627 \u062a\u063a\u06cc\u06cc\u0631\u0650 \u0631\u0646\u06af\u0650 \u0645\u062a\u0646) \u0628\u0627\u0632 \u0647\u0645 \u0631\u062f \u0645\u06cc\u200c\u0634\u0648\u062f. \u062a\u0645\u0650 \u062a\u06cc\u0631\u0647 \u062f\u0633\u062a\u200c\u0646\u062e\u0648\u0631\u062f\u0647
    # \u0645\u0627\u0646\u062f\u0647 \u0648 \u06a9\u0641\u0650 \u06f4.\u06f5 WCAG \u0631\u0627 \u06a9\u0627\u0645\u0644 \u0646\u06af\u0647 \u0645\u06cc\u200c\u062f\u0627\u0631\u062f.
    LIGHT_GRAD_ACCEPTED_FLOOR = 1.35
    assert light_ratio >= LIGHT_GRAD_ACCEPTED_FLOOR, (
        "light theme: %s text on the %s\u2192%s button gradient bottoms out at %.2f:1 \u2014 "
        "even below the owner-accepted vivid-gradient exception of 2026-08-29 (floor %.2f:1). "
        "this is not the WCAG 4.5 floor (that was knowingly waived for this control), but "
        "this is a real further regression" % (
            lonacc, lg1, lg2, light_ratio, LIGHT_GRAD_ACCEPTED_FLOOR))
    assert dark_ratio >= 4.5, (
        "dark theme: %s text on the %s\u2192%s button gradient bottoms out at %.2f:1, "
        "under the 4.5 WCAG floor" % (donacc, dg1, dg2, dark_ratio))
    print("[brand palette] no old hex left, header mark gradient intact, button contrast "
          "%.2f:1 light / %.2f:1 dark" % (light_ratio, dark_ratio))


def check_og_tags():
    """کارت پیش‌نمایش لینک — دو چیزی که بی‌صدا خراب می‌شوند.

    ربات‌های تلگرام و ایکس جاوااسکریپت اجرا نمی‌کنند، پس تگ‌های og باید در
    خودِ HTML باشند. صفحه‌ی اصلی نسخه‌ی ثابت خودش را دارد؛ روی /t/<آدرس>
    همان‌ها را Worker برمی‌دارد و تگ‌های آن توکن را می‌گذارد.

    ۱) هر تگ og/twitter در index.html باید نشانه‌ی `data-og` داشته باشد.
       Worker با همین نشانه پیدایشان می‌کند. بدون آن، ربات دو og:title
       می‌بیند و انتخاب بین آن دو دست ما نیست — و هیچ‌چیز نمی‌شکند، فقط
       کارت گاهی غلط می‌شود. دقیقاً همان کلاسی که «عدد غلط شبیه عدد درست»
       است.
    ۲) آدرس تصویر در صفحه باید با `OG_IMAGE_PATH` و `OG_IMAGE_V` در
       worker/og.js یکی باشد. اگر یکی جلو برود و دیگری نه، یکی از دو کارت
       به تصویری اشاره می‌کند که وجود ندارد."""
    src = open(os.path.join(HERE, "..", "index.html"), encoding="utf-8").read()

    tags = re.findall(r"<meta\b[^>]*>", src)
    og = [t for t in tags if 'property="og:' in t or 'name="twitter:' in t]
    assert og, "index.html has no open graph tags — every shared link is a bare url"
    missing = [t for t in og if "data-og" not in t]
    assert not missing, (
        "these og tags carry no data-og marker, so the worker cannot replace them on a "
        "token page and a bot would see two of each:\n  " + "\n  ".join(missing))
    assert 'content="summary_large_image"' in src, \
        "without twitter:card=summary_large_image X shows a thumbnail, not a card"

    ogjs = os.path.join(HERE, "..", "..", "worker", "og.js")
    assert os.path.exists(ogjs), "worker/og.js is missing — the token card is gone"
    wsrc = open(ogjs, encoding="utf-8").read()
    mp = re.search(r'OG_IMAGE_PATH\s*=\s*"([^"]+)"', wsrc)
    mv = re.search(r'OG_IMAGE_V\s*=\s*"([^"]+)"', wsrc)
    assert mp and mv, "OG_IMAGE_PATH / OG_IMAGE_V are gone from worker/og.js"
    want = mp.group(1) + "?v=" + mv.group(1)
    page = re.findall(r'content="https?://[^"]*(/og\.png\?v=[^"]*)"', src)
    assert page, "index.html points at no og image at all"
    wrong = [p for p in page if p != want]
    assert not wrong, (
        "the page and the worker disagree about the card image: page has %s, worker "
        "builds %s. One of the two cards is pointing at a 404." % (wrong, want))


EV_PAGE_NAMES, EV_DETAILS = set(), set()
def check_event_allowlists():
    """دو نگهبان ثابت برای شمارش رویداد، قبل از اینکه مرورگر بالا بیاید.

    ۱) فهرست نام‌ها در صفحه و در Worker باید *یکی* باشد. اگر صفحه نامی
       بفرستد که Worker ندارد، با ۴۰۰ بی‌صدا دور ریخته می‌شود و ما فکر
       می‌کنیم «کسی این کار را نمی‌کند» — بدترین حالت، چون عدد غلط شبیه
       عدد درست است.
    ۲) هیچ فراخوانی ev() نباید یک *ویژگی* بخواند. این نگهبان حریم خصوصی
       است: ev("swap:done",tokenIn.symbol) یا ev("x",$("amtIn").value)
       اینجا می‌افتد، نه روی سایت زنده. مرز حریم خصوصی با ادعا در کامنت
       نگه داشته نمی‌شود."""
    global EV_PAGE_NAMES, EV_DETAILS
    src = open(os.path.join(HERE, "..", "index.html"), encoding="utf-8").read()
    page = set(re.findall(r'"([^"]+)"', re.search(
        r"const EV_NAMES=\[(.*?)\];", src, re.S).group(1)))
    wk = open(os.path.join(HERE, "..", "..", "worker", "index.js"), encoding="utf-8").read()
    worker_names = set(re.findall(r'"([^"]+)"', re.search(
        r"const EV_OK = new Set\(\[(.*?)\]\);", wk, re.S).group(1)))
    details = set(re.findall(r'"([^"]*)"', re.search(
        r"const EV_DETAIL_OK = new Set\(\[(.*?)\]\);", wk, re.S).group(1)))
    assert page == worker_names, (
        "the page and the worker disagree about event names — the page would send "
        "events the worker silently drops.\n  only in page:   %s\n  only in worker: %s"
        % (sorted(page - worker_names), sorted(worker_names - page)))

    calls = re.findall(r"(?<![A-Za-z0-9_.$])ev\(([^()]*(?:\([^()]*\)[^()]*)*)\)", src)
    calls = [c for c in calls if not c.startswith("name,")]        # خودِ تعریف
    assert len(calls) >= 12, "the ev() call sites vanished — found only %d" % len(calls)
    for c in calls:
        assert "." not in c and "`" not in c and "[" not in c, (
            "an ev() call reads a property, so user data could reach the analytics row: "
            "ev(%s)" % c)
        for lit in re.findall(r'"([^"]*)"', c):
            assert lit in page or lit in details or lit == "view:", (
                "ev(%s) uses the string %r, which is in neither allowlist" % (c, lit))
    EV_PAGE_NAMES, EV_DETAILS = page, details
    print("[events] %d names, page and worker agree; %d call sites, none reads a property"
          % (len(page), len(calls)))

RETIRED_EXECUTORS = [
    "0x6443C06bb117223DC818df54A09A642696D0489c",
    "0x9fc4608fA104b032B902650A4D12E0CA51a2F684",
    "0xC261E57cF5739A8a538884405600E4e45dF24802",
    "0x2fea35aaDae6Cbf9b9481B06164907ccF95DB081",   # v1
    "0xE980825d4B3911e35Be5804349be26eBBe93BcC6",   # v2
    "0xb6AE1C7157f877854C498C44ab5ea3d6742416DC",   # v3 — underflow on a sweeping recipient, see finding 04
]

def check_one_executor_address():
    """هیچ سندی نباید قرارداد بازنشسته را به‌عنوان قرارداد زنده معرفی کند.

    این نگهبان از یک اشتباه واقعی آمده، نه از احتیاط: هر دو README قرارداد v2
    را «Live contract» می‌نامیدند و به BaseScan با `#code` لینک می‌دادند — یک
    دعوت صریح به رفتن و ممیزی‌کردن قرارداد اشتباه — و `verify_dexes.sh` حتی
    یک نسل عقب‌تر، v1 را هاردکد کرده بود. کسی که README را می‌خواند
    integrator یا auditor است؛ گران‌ترین جای اشتباه‌بودن همین‌جاست.

    قاعده: `CHAIN.executor` در index.html تنها منبع حقیقت است. هر آدرس
    بازنشسته‌ای که در اسناد ظاهر شود باید در فاصله‌ی نزدیک، برچسب بازنشستگی
    داشته باشد."""
    idx = open(os.path.join(HERE, "..", "index.html"), encoding="utf-8").read()
    m = re.search(r'executor:"(0x[0-9a-fA-F]{40})"', idx)
    assert m, "CHAIN.executor is gone from index.html — this guard has nothing to compare against"
    live = m.group(1)
    assert live.lower() not in [a.lower() for a in RETIRED_EXECUTORS], \
        "the app itself points at a retired executor: " + live

    root = os.path.join(HERE, "..", "..")
    docs = [("README.md", os.path.join(root, "README.md")),
            ("contracts/README.md", os.path.join(root, "contracts", "README.md")),
            ("contracts/script/verify_dexes.sh",
             os.path.join(root, "contracts", "script", "verify_dexes.sh")),
            # هر اسکریپتی که آدرس قرارداد چاپ می‌کند باید زیر همین نگهبان باشد،
            # وگرنه فردا یکی آدرس بازنشسته را در آن هاردکد می‌کند و کسی نمی‌فهمد.
            ("contracts/script/verify_slipstream.sh",
             os.path.join(root, "contracts", "script", "verify_slipstream.sh")),
            ("contracts/script/compare_slipstream.sh",
             os.path.join(root, "contracts", "script", "compare_slipstream.sh")),
            ("contracts/script/probe_token_pools.sh",
             os.path.join(root, "contracts", "script", "probe_token_pools.sh")),
            ("contracts/script/diagnose_dead_dexes.sh",
             os.path.join(root, "contracts", "script", "diagnose_dead_dexes.sh"))]
    RETIRED_WORDS = ("retired", "abandoned", "do not use", "superseded", "replaced",
                     "بازنشسته", "استفاده نکن", "رها")
    problems = []
    for label, path in docs:
        if not os.path.exists(path):
            problems.append("%s is missing" % label); continue
        text = open(path, encoding="utf-8").read()
        low = text.lower()

        # ⚠️ برچسب بازنشستگی باید روی *همان خط* باشد، نه «جایی این نزدیکی».
        # نسخه‌ی اول پنجره‌ی ۴۰۰ نویسه‌ای داشت و چون جدول بازنشسته‌ها همان
        # پایین بود، یک خط «Live contract: <آدرس بازنشسته>» هم بخشیده می‌شد —
        # یعنی نگهبان دقیقاً همان باگی را که برایش نوشته شده بود نمی‌گرفت.
        for i, line in enumerate(low.splitlines(), 1):
            for old_addr in RETIRED_EXECUTORS:
                if old_addr.lower() in line and not any(w in line for w in RETIRED_WORDS):
                    problems.append("%s:%d names retired executor %s with no retirement "
                                    "label on that line" % (label, i, old_addr))

        # و ادعای صریح «قرارداد زنده این است» باید همان آدرس زنده را بدهد
        if label.endswith(".md"):
            claims = re.findall(r'(?i)live contract:\s*\[`(0x[0-9a-fA-F]{40})`\]', text)
            if not claims:
                problems.append("%s no longer states which contract is live" % label)
            for c in claims:
                if c.lower() != live.lower():
                    problems.append("%s says the live contract is %s, but the app uses %s"
                                    % (label, c, live))
            if live.lower() not in low:
                problems.append("%s never names the live executor %s" % (label, live))
    assert not problems, ("the executor address has drifted across the docs:\n  - "
                          + "\n  - ".join(problems))
    print("[one address] live executor %s — %d retired ones labelled as retired"
          % (live, len(RETIRED_EXECUTORS)))

async def check_real_page_from_disk(pw):
    """صفحه‌ی *واقعی* را با file:// باز کن و ببین ethers بالا می‌آید.

    نگهبان ایستا شرط پروتکل را می‌سنجد، ولی اگر لودر روزی بازنویسی شود آن
    الگو دیگر معنایی ندارد. این یکی نتیجه را می‌سنجد، نه شکل کد را — و
    عمداً روی index.html اصلی اجرا می‌شود نه هارنس: هارنس هش را خالی می‌کند
    و دقیقاً به همین دلیل نمی‌توانست این باگ را ببیند.

    ⚠️ هیچ درخواست شبکه‌ای اجازه ندارد؛ فقط بارگذاری فایل کنار صفحه سنجیده
    می‌شود."""
    real = os.path.join(HERE, "..", "index.html")
    b = await pw.chromium.launch()
    pg = await b.new_page()
    await pg.route("http://**", lambda r: asyncio.ensure_future(r.abort()))
    await pg.route("https://**", lambda r: asyncio.ensure_future(r.abort()))
    blocked = []
    pg.on("console", lambda m: blocked.append(m.text)
          if m.type == "error" and "integrity" in m.text.lower() else None)
    await pg.goto("file://" + real)
    await pg.wait_for_timeout(2500)
    kind = await pg.evaluate("() => typeof window.ethers")
    shown = await pg.evaluate(
        "() => (document.getElementById('notices')||{}).innerText || ''")
    await b.close()
    assert kind == "object", (
        "opening web/index.html directly from disk does not start the app: window.ethers "
        "is %r. Both READMEs tell people to open the file this way.\n"
        "  integrity errors: %s\n  on screen: %s" % (kind, blocked[:1], shown[:160]))
    print("[file://] the real page starts from disk — ethers loaded, no integrity block")


check_no_remote_code()
check_gt_proxy_worker()
check_asset_cache_headers()
check_event_allowlists()
check_og_tags()
check_brand_palette()
check_one_executor_address()

async def main():
    errors = []
    # خطاهایی که یک کاوشگر *عمداً* تولید می‌کند. اجازه‌ی عبور می‌گیرند ولی
    # جمع می‌شوند تا همان کاوشگر بتواند ادعا کند واقعاً رخ داده‌اند — وگرنه
    # allowlist فقط یک راه بی‌صدا برای پنهان‌کردن خطا می‌شد.
    gate_errs = []
    # خطاهای عمدیِ کاوشگر «کف fallback»: آن کاوشگر ارسال را وسط راه قطع می‌کند،
    # پس showError درست کار کرده و لاگ کرده. جمعشان می‌کنیم تا خودِ کاوشگر
    # بتواند ادعا کند رخ داده‌اند — وگرنه allowlist فقط یک راه بی‌صدا برای
    # قایم‌کردن خطای واقعی می‌شد.
    probe_errs = []
    # خطای عمدیِ کاوشگر «گیرنده‌ی جاروکننده»: showError درست کار کرده و لاگ
    # کرده. با نشانِ خودِ تشخیص جدا می‌شود، نه با متن revert — وگرنه یک شکست
    # واقعیِ لغزش هم بی‌صدا از همین در رد می‌شد.
    sweep_errs = []

    def on_console(m):
        if m.type != "error":
            return
        if "[zaexa] gate check failed" in m.text:
            gate_errs.append(m.text)
        elif "probe: stop before sending" in m.text:
            probe_errs.append(m.text)
        elif "recipient forwarded the output" in m.text:
            sweep_errs.append(m.text)
        else:
            errors.append(m.text)

    async with async_playwright() as p:
        await check_real_page_from_disk(p)
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
        await chk.add_script_tag(path=vendor_path("ethers.umd.min"))
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

        # ---- 1a. عددی که خودمان در فیلد خروجی می‌نویسیم باید خوانا باشد ----
        # قبلاً بی‌جداکننده و با ۸ رقم اعشار بود: 2148785.216084.
        # سه ادعا، چون گروه‌بندی به‌تنهایی می‌توانست تایپ در همین فیلد را بشکند:
        #   الف) شکل نمایش گروه‌بندی‌شده است،
        #   ب) با فوکوس به عدد خام برمی‌گردد تا ویرایش نشکند،
        #   ج) «1,5» — اعشار به سبک اروپایی — همچنان نامعتبر است و بی‌صدا
        #      ۱۵ خوانده نمی‌شود. این سومی مهم‌ترین است: یک replace ساده‌ی
        #      کاما همان‌جا یک باگ خاموشِ پولی می‌ساخت.
        shown = await pg.input_value("#amtOut")
        assert re.fullmatch(r"\d{1,3}(,\d{3})+\.\d{1,2}", shown), \
            "the receive field is not grouped and rounded for a large amount: " + shown
        await pg.focus("#amtOut"); await pg.wait_for_timeout(150)
        raw = await pg.input_value("#amtOut")
        assert "," not in raw and float(raw) > 0, \
            "focusing the receive field must hand back a raw number to edit, got: " + raw
        euro = await pg.evaluate("""() => {
            const el = document.getElementById("amtOut");
            el.value = "1,5";
            return parsedTargetOut() === null;
        }""")
        print("[amount grouping] shown=%s  on focus=%s  '1,5' still rejected=%s"
              % (shown, raw, euro))
        assert euro, \
            ("'1,5' is being read as 15 — a plain comma strip turns a European decimal into a "
             "number fifteen times too big")
        await pg.fill("#amtIn", "1000")
        await pg.wait_for_function("() => document.getElementById('amtOut').value !== ''", timeout=20000)
        assert await pg.evaluate("""() => {
            const el = document.getElementById("amtOut");
            el.value = "2,148,785.22";
            return parsedTargetOut() !== null;
        }"""), "the grouped amount we write ourselves does not parse back"

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

        # ---- 2a-bis. Bug 5 رگرسیون: حلقه‌ی ریسکِ نمای اصلی هم باید انیمیت شود ----
        # renderSafetyReport (صفحه‌ی توکن) از صفر پر می‌شد؛ renderSafety (نمای
        # اصلی) مستقیم مقدار نهایی را می‌نوشت و هرگز حرکت نمی‌کرد. اینجا هم
        # حرکتِ عادی سنجیده می‌شود و هم حالتِ prefers-reduced-motion.
        sf_key = await pg.evaluate("() => Object.keys(safetyCache)[0]")
        assert sf_key, "no safety scan is cached on the main view yet — nothing to re-animate"
        C_ring = 2 * 3.141592653589793 * 25
        pre_off = await pg.evaluate(
            """(k) => { renderSafety(safetyCache[k]);
               return document.getElementById("sf-arc").getAttribute("stroke-dashoffset"); }""",
            sf_key)
        assert abs(float(pre_off) - C_ring) < 0.5, (
            "the main-site ring must start fully empty (offset=circumference) the instant the "
            "scan lands, got %s" % pre_off)
        await pg.wait_for_timeout(1200)
        rs_text = await pg.inner_text("#safetyBody .rs")
        score_m = re.search(r"Risk (\d+)/100", rs_text)
        assert score_m, "could not read the score off the main safety panel: %r" % rs_text
        score = int(score_m.group(1))
        expected_off = C_ring * (1 - max(4, score) / 100)
        settled_off = float(await pg.get_attribute("#sf-arc", "stroke-dashoffset"))
        settled_num = (await pg.inner_text("#sf-score")).strip()
        print("[risk] main-site ring animates from empty: start=%.1f settled=%.1f expected=%.1f score=%s"
              % (float(pre_off), settled_off, expected_off, settled_num))
        assert abs(settled_off - expected_off) < 0.5, (
            "the ring did not settle where the scanned score says it should: got %.2f, "
            "expected %.2f" % (settled_off, expected_off))
        assert settled_num == str(score), (
            "the number never finished counting up to the final score: shows %r, scan says %d"
            % (settled_num, score))

        rmpg = await b.new_page(viewport={"width": 1240, "height": 1000})
        await rmpg.emulate_media(reduced_motion="reduce")
        await rmpg.goto(URL)
        await rmpg.wait_for_selector("#safetyBody .rhead", timeout=20000)
        rm_off = float(await rmpg.get_attribute("#sf-arc", "stroke-dashoffset"))
        rm_num = (await rmpg.inner_text("#sf-score")).strip()
        rm_rs = await rmpg.inner_text("#safetyBody .rs")
        rm_m = re.search(r"Risk (\d+)/100", rm_rs)
        assert rm_m, "could not read the score with reduced motion emulated: %r" % rm_rs
        rm_score = int(rm_m.group(1))
        rm_expected = C_ring * (1 - max(4, rm_score) / 100)
        await rmpg.close()
        print("[risk] prefers-reduced-motion is final immediately: offset=%.1f expected=%.1f score=%s"
              % (rm_off, rm_expected, rm_num))
        assert abs(rm_off - rm_expected) < 0.5, (
            "with prefers-reduced-motion: reduce the ring must land on the final value "
            "immediately, not mid-animation: got %.2f, expected %.2f" % (rm_off, rm_expected))
        assert rm_num == str(rm_score), (
            "with prefers-reduced-motion: reduce the number must show the final score right "
            "away: shows %r, scan says %d" % (rm_num, rm_score))

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
        EXIT_PROBE = """async ([msg, alw, down, cachedBal, cachedAlw]) => {
            const realContract = E.Contract;
            const realCall = readProvider.call.bind(readProvider);
            window.__STUB_ALLOWANCE__ = BigInt(alw);
            account = "0x8A0Dcb583C8CAdc481E34487c34f1B856fe97e23";
            signer = {}; walletChainId = CHAIN.id;
            /* state کش‌شده. پیش‌فرض «کافی» است، ولی تست می‌تواند عددی *بین*
               پای شبیه‌سازی و کل سفارش بگذارد — همان بازه‌ای که دو نگهبان
               زودهنگام قبلاً با مقدار اشتباه می‌سنجیدند. */
            balances[balKey(tokenIn)] = cachedBal ? BigInt(cachedBal) : 10n ** 30n;
            allowance = cachedAlw ? BigInt(cachedAlw) : 10n ** 30n;
            allowanceKnown = true;
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

        async def exit_case(label, msg, allowance="0", down=False,
                            cached_bal=None, cached_alw=None):
            r = await pg.evaluate(EXIT_PROBE, [msg, allowance, down, cached_bal, cached_alw])
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

        # ---- 2b-quater. مورد ۰۵ ریویو: پیش‌شرط با *مقدار شبیه‌سازی‌شده* ----
        # روی نقشه‌ی split، شبیه‌سازی روی بزرگ‌ترین پا اجرا می‌شود، پس مقداری
        # که لازم دارد از کل سفارش کمتر است. اگر پیش‌شرط با کل سفارش سنجیده
        # شود، کیف پولی که allowance‌اش بین این دو است پیام «اول approve کن»
        # می‌گیرد و پنل روی estimated می‌نشیند — در حالی که revert واقعاً از
        # سمت توکن آمده. یک `blocked` واقعی نرم می‌شود به «نتوانستیم بسنجیم»؛
        # همان «نمی‌دانم در نقش نه»، در گران‌ترین جهت.
        await pg.fill("#amtIn", "900000")            # مبلغی که مسیر را تقسیم می‌کند
        await pg.wait_for_timeout(3200)
        legs = await pg.evaluate("""() => {
            if (!currentPlan) return null;
            const big = currentPlan.parts.slice().sort((a,b)=>b.amountIn>a.amountIn?1:-1)[0];
            return {parts: currentPlan.parts.length,
                    total: currentPlan.totalIn.toString(),
                    biggest: big.amountIn.toString()};
        }""")
        assert legs and legs["parts"] > 1, \
            "this probe needs a split plan; got %s — the amount may no longer split" % legs
        # موجودی زیاد، ولی allowance دقیقاً *بین* پای بزرگ و کل سفارش
        between = (int(legs["biggest"]) + int(legs["total"])) // 2
        assert int(legs["biggest"]) < between < int(legs["total"])
        await pg.evaluate("v => { window.__STUB_BALANCE__ = v; }", str(10 ** 40))
        r = await exit_case("split-precondition",
                            'execution reverted: "Blacklisted"', allowance=str(between))
        await pg.evaluate("() => { delete window.__STUB_BALANCE__; }")
        print("[exit:split-precondition] parts=%s biggest=%s total=%s allowance=between"
              % (legs["parts"], legs["biggest"][:8] + "…", legs["total"][:8] + "…"))
        assert r["state"] == "blocked", (
            "the simulation only needed the biggest leg, and the wallet had approved more "
            "than that — a genuine sell-side revert was softened into %r (%s). This is the "
            "first rule of the project failing in its expensive direction."
            % (r["state"], (r["reason"] or "")[:90]))
        assert NEVER in r["title"], "a real block must still say so: " + r["title"]

        # همان مقدار اشتباه در دو نگهبان *زودهنگام* هم بود: موجودی و allowance
        # کش‌شده با کل سفارش سنجیده می‌شدند، پس شبیه‌سازی‌ای که موفق می‌شد
        # بی‌دلیل رد می‌شد و پنل هرگز به «blocked» نمی‌رسید.
        for label, kw in (("cached-balance", {"cached_bal": str(between)}),
                          ("cached-allowance", {"cached_alw": str(between)})):
            await pg.evaluate("v => { window.__STUB_BALANCE__ = v; }", str(10 ** 40))
            r2 = await exit_case(label, 'execution reverted: "Blacklisted"',
                                 allowance=str(10 ** 40), **kw)
            await pg.evaluate("() => { delete window.__STUB_BALANCE__; }")
            assert r2["state"] == "blocked", (
                "the %s guard was measured against the whole order instead of the leg that "
                "is actually simulated, so a real block came back as %r (%s)"
                % (label, r2["state"], (r2["reason"] or "")[:80]))

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

        # بررسی‌های آشتی: یک شبیه‌سازیِ واقعاً اجراشده باید بر یک کوت غالب شود،
        # و پنل ایمنی نباید چیزی خلاف پنل خروج بگوید (باگ ۹).

        # ۱) blocked باید یک "Sellable" مبتنی بر کوت را بی‌اثر کند
        rev = await pg.evaluate("""() => {
            const addr = "0x1111111111111111111111111111111111111111";
            const rep = {address: addr, symbol: "TST", native: false,
                findings: [
                    {level: "ok", title: "Sellable", detail: "Round-trip cost about 0.00%."},
                    {level: "ok", title: "Liquidity present", detail: "About $120,000 across known pools."}
                ],
                owner: null, isProxy: false, liqUsd: 120000,
                canBuy: true, canSell: true, unknown: 0};
            rep.score = riskScore(rep); rep.verdict = verdictOf(rep);
            const beforeScore = rep.score;
            exitCache[addr] = {state: "blocked", lossPct: null, at: Date.now()};
            const after = reconcileExit(rep);
            delete exitCache[addr];
            return {
                afterTitles: after.findings.map(f => f.title),
                afterLevels: after.findings.map(f => f.level),
                afterScore: after.score,
                afterCanSell: after.canSell,
                afterVerdict: after.verdict.txt,
                beforeScore,
                rawTitles: rep.findings.map(f => f.title)
            };
        }""")
        print("[risk] live sell revert overrides the quote: before=%s after=%s titles=%s"
              % (rev["beforeScore"], rev["afterScore"], rev["afterTitles"]))
        assert "Sellable" not in rev["afterTitles"], \
            "a live revert must remove the quote-based Sellable finding"
        assert "Sell simulation reverted" in rev["afterTitles"], \
            "a live revert must add its own finding"
        idx = rev["afterTitles"].index("Sell simulation reverted")
        assert rev["afterLevels"][idx] == "critical", \
            "a proven revert must be reported as critical, not softened"
        assert rev["afterScore"] > rev["beforeScore"], \
            "overriding to a proven revert must raise the score, not lower it"
        assert rev["afterCanSell"] is False, \
            "a proven revert must mark canSell false"
        assert "Sellable" in rev["rawTitles"], \
            "the cached report object must not be mutated in place"

        # ۲) verified باید یک "Cannot get a sell quote" بدبینانه را نجات دهد
        ver = await pg.evaluate("""() => {
            const addr = "0x2222222222222222222222222222222222222222";
            const rep = {address: addr, symbol: "TST2", native: false,
                findings: [
                    {level: "critical", title: "Cannot get a sell quote",
                     detail: "No pool would quote selling this token back."}
                ],
                owner: null, isProxy: false, liqUsd: 120000,
                canBuy: true, canSell: false, unknown: 0};
            rep.score = riskScore(rep); rep.verdict = verdictOf(rep);
            const beforeScore = rep.score;
            exitCache[addr] = {state: "verified", lossPct: 0.4, at: Date.now()};
            const after = reconcileExit(rep);
            delete exitCache[addr];
            return {
                afterTitles: after.findings.map(f => f.title),
                afterLevels: after.findings.map(f => f.level),
                afterScore: after.score,
                afterCanSell: after.canSell,
                beforeScore
            };
        }""")
        print("[risk] a verified round trip clears the quote-only honeypot flag: before=%s after=%s"
              % (ver["beforeScore"], ver["afterScore"]))
        assert "Cannot get a sell quote" not in ver["afterTitles"], \
            "a verified live sell must clear the pessimistic quote-only finding"
        assert "No sell quote from the reference pool" in ver["afterTitles"], \
            "a verified live sell must explain why the quote was pessimistic"
        idx = ver["afterTitles"].index("No sell quote from the reference pool")
        assert ver["afterLevels"][idx] == "info", \
            "a resolved false alarm must be informational, not scary"
        assert ver["afterCanSell"] is True, \
            "a verified live sell must mark canSell true"
        assert ver["afterScore"] < ver["beforeScore"], \
            "clearing a false honeypot flag must lower the score"

        # ۳) unknown/estimated/غایب چیزی را عوض نمی‌کنند و همان شیء برمی‌گردد
        untouched = await pg.evaluate("""() => {
            const addr = "0x3333333333333333333333333333333333333333";
            const mk = () => ({address: addr, symbol: "TST3", native: false,
                findings: [{level: "ok", title: "Sellable", detail: "x"}],
                owner: null, isProxy: false, liqUsd: 50000,
                canBuy: true, canSell: true, unknown: 0});
            const repU = mk();
            exitCache[addr] = {state: "unknown", lossPct: null, at: Date.now()};
            const sameU = reconcileExit(repU) === repU;

            const repE = mk();
            exitCache[addr] = {state: "estimated", lossPct: 1.2, at: Date.now()};
            const sameE = reconcileExit(repE) === repE;

            delete exitCache[addr];
            const repA = mk();
            const sameA = reconcileExit(repA) === repA;
            return {sameU, sameE, sameA};
        }""")
        print("[risk] an untested or estimated exit does not touch the report: unknown=%s estimated=%s absent=%s"
              % (untouched["sameU"], untouched["sameE"], untouched["sameA"]))
        assert untouched["sameU"] and untouched["sameE"] and untouched["sameA"], \
            "an unknown/estimated/absent exit result must return the very same report object"

        # ۴) پنل ایمنی روی صفحه واقعاً همان چیزی را نشان دهد که پنل خروج می‌گوید
        has_safety_body = await pg.evaluate("() => !!document.getElementById('safetyBody')")
        assert has_safety_body, \
            "the harness page has no #safetyBody element — cannot verify the rendered panel"
        dom = await pg.evaluate("""() => {
            const t = BASE_TOKENS.find(x => x.symbol === "cbBTC" && !x.native);
            const addr = t.address.toLowerCase();
            const savedRep = safetyCache[addr];
            const savedExit = exitCache[addr];
            const savedPage = tokenPage;
            tokenPage = false;
            safetyCache[addr] = {address: t.address, symbol: t.symbol, native: false,
                findings: [
                    {level: "ok", title: "Sellable", detail: "Round-trip cost about 0.00%."},
                    {level: "ok", title: "Liquidity present", detail: "About $200,000 across known pools."}
                ],
                owner: null, isProxy: false, liqUsd: 200000,
                canBuy: true, canSell: true, unknown: 0};
            safetyCache[addr].score = riskScore(safetyCache[addr]);
            safetyCache[addr].verdict = verdictOf(safetyCache[addr]);
            exitCache[addr] = {state: "blocked", lossPct: null, at: Date.now()};
            renderSafety(safetyCache[addr]);
            const text = document.getElementById("safetyBody").innerText;
            if (savedRep === undefined) delete safetyCache[addr]; else safetyCache[addr] = savedRep;
            if (savedExit === undefined) delete exitCache[addr]; else exitCache[addr] = savedExit;
            tokenPage = savedPage;
            if (safetyCache[addr]) renderSafety(safetyCache[addr]);
            else document.getElementById("safetyBody").innerHTML =
                '<div class="empty">Pick a token to scan its contract.</div>';
            return text;
        }""")
        print("[risk] the safety panel agrees with the live sell test: %r" % dom)
        assert "Sell simulation reverted" in dom, \
            "the rendered safety panel did not pick up the live sell revert"
        assert "Sellable" not in dom, \
            "the rendered safety panel still shows the contradicted quote-based verdict"

        # ------------------------------------------------------------
        # باگ ۱۲: «هزینه‌ی رفت‌وبرگشت −۰.۱۱٪» — یک عدد منفی هرگز نباید
        # به‌عنوان سود چاپ شود. یک تابع، چهار محل مصرف.
        # ------------------------------------------------------------

        # ۱) خودِ تابع خالص — جدول‌محور
        trip_cases = [-5, -1, -0.11, -0.004, 0, 0.004, 0.005, 0.10, 51.54, None]
        trip_results = await pg.evaluate(
            "(vals) => vals.map(v => tripCost(v))", trip_cases)
        for v, r in zip(trip_cases, trip_results):
            if v in (-5, -1):
                assert r["state"] == "implausible", \
                    "a large apparent gain must read as unpriceable, not a real discount: %r -> %r" % (v, r)
            elif v in (-0.11, -0.004, 0, 0.004):
                assert r["state"] == "zeroish" and r["text"] == "about 0%", \
                    "a small negative/zero cost must smooth to 'about 0%%': %r -> %r" % (v, r)
            elif v in (0.005, 0.10, 51.54):
                assert r["state"] == "normal" and r["text"].endswith("%") and not r["text"].startswith("-"), \
                    "a genuine cost must print plainly: %r -> %r" % (v, r)
            elif v is None:
                assert r["state"] == "unknown", "a non-finite loss must read as unknown: %r -> %r" % (v, r)
        assert all(not re.search(r"-\d", r["text"]) for r in trip_results), \
            "a negative cost leaked into the rendered text: %s" % trip_results
        print("[trip] no negative cost is ever printed: %s" % trip_results)

        # ۲) کارت سواپ (renderExit)
        swap_probe = await pg.evaluate("""() => {
            const box = document.getElementById("exitBox");
            const savedHTML = box.innerHTML;
            const savedTokenPage = tokenPage;
            tokenPage = false;
            const mk = loss => ({state: "estimated", lossPct: loss, recovered: null, reason: null});
            renderExit(mk(-0.11));
            const t1 = box.innerText;
            renderExit(mk(-5));
            const t2 = box.innerText;
            renderExit(mk(0.10));
            const t3 = box.innerText;
            box.innerHTML = savedHTML;
            tokenPage = savedTokenPage;
            return {t1, t2, t3};
        }""")
        print("[trip] swap card: %r | %r | %r" % (
            swap_probe["t1"][:40], swap_probe["t2"][:40], swap_probe["t3"][:40]))
        assert "about 0%" in swap_probe["t1"] and "-0.11" not in swap_probe["t1"], \
            "swap card: a -0.11%% round trip must read as ~0%%, not a printed negative"
        assert "could not price" in swap_probe["t2"].lower() and "-5" not in swap_probe["t2"], \
            "swap card: a -5%% apparent gain must read as unpriceable, not a printed negative"
        assert "0.10%" in swap_probe["t3"], \
            "swap card: a genuine 0.10%% cost must still be printed plainly"

        # ۳) صفحه‌ی توکن (renderRoundTrip)
        token_probe = await pg.evaluate("""() => {
            const box = document.getElementById("tk-exitBox");
            const savedHTML = box.innerHTML;
            const mk = loss => ({state: "estimated", lossPct: loss, recovered: null});
            renderRoundTrip(box, mk(-0.11));
            const t1 = box.innerText;
            renderRoundTrip(box, mk(-5));
            const t2 = box.innerText;
            renderRoundTrip(box, mk(0.10));
            const t3 = box.innerText;
            box.innerHTML = savedHTML;
            return {t1, t2, t3};
        }""")
        print("[trip] token page: %r | %r | %r" % (
            token_probe["t1"][:40], token_probe["t2"][:40], token_probe["t3"][:40]))
        assert "about 0%" in token_probe["t1"] and "-0.11" not in token_probe["t1"], \
            "token page: a -0.11%% round trip must read as ~0%%, not a printed negative"
        assert "not priced" in token_probe["t2"].lower() and "-5" not in token_probe["t2"], \
            "token page: a -5%% apparent gain must read as unpriced, not a printed negative"
        assert "0.10%" in token_probe["t3"], \
            "token page: a genuine 0.10%% cost must still be printed plainly"

        # ۴) نشان ردیف در انتخابگر توکن (exitBadge)
        badge_probe = await pg.evaluate("""() => {
            const t = BASE_TOKENS.find(x => x.symbol === "cbBTC" && !x.native);
            const key = balKey(t);
            const saved = exitCache[key];
            exitCache[key] = {state: "verified", lossPct: -3, at: Date.now()};
            const html = exitBadge(t);
            if (saved === undefined) delete exitCache[key]; else exitCache[key] = saved;
            return html;
        }""")
        print("[trip] picker badge on an implausible gain: %r" % badge_probe)
        assert "✓" not in badge_probe and "-3" not in badge_probe and "unclear" in badge_probe, \
            "picker badge: an implausible 'gain' must not wear a checkmark or a printed negative"

        # ۵) یافته‌ی پنل ایمنی باید با تست فروش زنده آشتی شود (رگرسیون باگ ۹)
        recon_probe = await pg.evaluate("""() => {
            const addr = "0x4444444444444444444444444444444444444444";
            const rep = {address: addr, symbol: "TST4", native: false,
                findings: [
                    {level: "info", title: "Round trip did not price cleanly",
                     detail: "Selling it straight back quoted more than the buy cost."}
                ],
                owner: null, isProxy: false, liqUsd: 80000,
                canBuy: true, canSell: null, unknown: 0};
            rep.score = riskScore(rep); rep.verdict = verdictOf(rep);
            exitCache[addr] = {state: "blocked", lossPct: null, at: Date.now()};
            const after = reconcileExit(rep);
            delete exitCache[addr];
            return { afterTitles: after.findings.map(f => f.title) };
        }""")
        print("[trip] the new finding is reconciled with the live sell test: %s"
              % recon_probe["afterTitles"])
        assert "Round trip did not price cleanly" not in recon_probe["afterTitles"], \
            "QUOTE_SELL_TITLES must cover the new title so a live revert replaces it, not sits beside it"
        assert "Sell simulation reverted" in recon_probe["afterTitles"], \
            "the live revert override must still be applied"

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
        # ⚠️ این خط درباره‌ی مین‌نت حرف نمی‌زند. `stub-ethers.js` عمداً برای
        #    CANDIDATE_ROUTERS «کد ندارد» برمی‌گرداند تا مسیرِ «کاندیدِ
        #    تأییدنشده» در UI آزموده شود. یک بار همین خط ماه‌ها به‌جای
        #    واقعیتِ زنجیره خوانده شد و «سه صرافی مرده‌اند» در حافظه ثبت شد؛
        #    روی زنجیره هر شش‌تا PASS دادند و هر شش‌تا لیست‌سفید بودند.
        #    برچسب زیر برای این است که آن اشتباه دوباره تکرار نشود.
        cov = await pg.inner_text("#coverage")
        print("[coverage] (FIXTURE, not mainnet - the stub forces the candidate "
              "routers to look code-less) %s" % cov.replace("\n", " | "))
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

            // آدرس data: از سرویس: نه ذخیره می‌شود و نه — از این نسخه — نمایش
            localStorage.removeItem(LS_LOGO);
            const DATA = "data:image/png;base64,iVBORw0KGgo=";
            window.fetch = async () => { hits++; return new Response(JSON.stringify(
                {data: [{attributes: {address: ADDR, image_url: DATA}}]}), {status: 200}); };
            reset();
            out.dataUrl = await tokenLogo(tok);
            out.dataStored = localStorage.getItem(LS_LOGO);

            // …ولی آیکون خودمان که یک data: درون‌فایل است باید سر جایش بماند.
            // سخت‌کردن مسیر نمایش نباید آیکون ETH را قربانی کند.
            out.ethIcon = await tokenLogo(allTokens().find(t => t.native));
            out.ethIsOurs = out.ethIcon === ETH_ICON;

            // و چیزی که واقعاً به img.src می‌رسد سنجیده می‌شود، نه فقط
            // خروجی tokenLogo — چاه همان جاست.
            const box = document.createElement("div");
            paintAvatar(box, allTokens().find(t => t.native));
            await new Promise(r => setTimeout(r, 60));
            out.ethImgSrc = (box.querySelector("img") || {}).src || null;

            const box2 = document.createElement("div");
            paintAvatar(box2, tok);
            await new Promise(r => setTimeout(r, 60));
            out.dataImgSrc = (box2.querySelector("img") || {}).src || null;

            /* دفاع دومِ سر چاه را جدا می‌سنجیم. با tokenLogo سالم، این خط
               هرگز اجرا نمی‌شود و برداشتنش هیچ تستی را نمی‌انداخت — یعنی
               نگهبانی داشتیم که هیچ چیزی ثابت نمی‌کرد. اینجا tokenLogo را
               موقتاً بی‌اثر می‌کنیم تا خودِ paintAvatar سنجیده شود. */
            const realTokenLogo = tokenLogo;
            tokenLogo = async () => "data:image/png;base64,iVBORw0KGgo=";
            const box3 = document.createElement("div");
            paintAvatar(box3, tok);
            await new Promise(r => setTimeout(r, 60));
            out.sinkGuard = (box3.querySelector("img") || {}).src || null;
            tokenLogo = realTokenLogo;

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
        # ⚠️ این قاعده در ۱۸ آگوست ۲۰۲۶ سخت‌تر شد و انتظار این تست عوض شد.
        # قبلاً نمایش هرچه سرویس می‌داد آزاد بود و فقط ذخیره به https محدود
        # بود — یعنی مسیر رندر، همان مسیری که یک نفوذ در سرویس قیمت اول از
        # همه به آن می‌رسد، شل‌ترینِ دو مسیر بود. حالا هر دو یک قاعده دارند.
        # ماک اینجا واقعیت را آینه نمی‌کند: در هارنس image_url یک data: url است
        # در حالی که GeckoTerminal واقعی https می‌دهد — و همین باعث شد این
        # حالت اصلاً قابل سنجش باشد.
        print("[logo cache] service data: url -> shown=%s | our ETH icon -> ours=%s src=%s"
              % (logo["dataUrl"], logo["ethIsOurs"], str(logo["ethImgSrc"])[:22]))
        assert logo["dataUrl"] is None, \
            ("a data: logo from the price service reached the display path — img.src must be "
             "held to the same https-only rule as localStorage: %s" % logo["dataUrl"])
        assert logo["dataImgSrc"] is None, \
            ("paintAvatar put a non-https url into img.src: %s" % logo["dataImgSrc"])
        assert logo["sinkGuard"] is None, \
            ("paintAvatar accepted a non-https url handed straight to it — the render sink "
             "must hold the line even when whatever feeds it does not: %s" % logo["sinkGuard"])
        assert not logo["dataStored"] or "data:" not in logo["dataStored"], \
            ("a data: url was written into localStorage — only https urls are safe to read "
             "back into img.src: %s" % logo["dataStored"])
        # و آیکون خودمان قربانی این سخت‌گیری نشده باشد
        assert logo["ethIsOurs"] and logo["ethImgSrc"] and \
               logo["ethImgSrc"].startswith("data:image/svg+xml"), \
            ("tightening the display path also killed our own built-in ETH icon: %s"
             % logo["ethImgSrc"])

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

        # ---- مبلغ نباید از رفرش جان سالم به در ببرد ----
        # مبلغ در localStorage ذخیره می‌شد و پس از رفرش دوباره در فیلد
        # می‌نشست — ولی بدون اینکه کوتی راه بیفتد، چون بازگردانی برنامه‌ای
        # رویداد `input` تولید نمی‌کند. نتیجه: دکمه روی «Finding best route…»
        # قفل می‌ماند تا کاربر خودش عدد را پاک کند و از نو بزند.
        # جفت توکن باید بماند (کمک است)، مبلغ نه (تصمیم همان لحظه است).
        rf = await b.new_page(viewport={"width": 1240, "height": 1000}, color_scheme="dark")
        await rf.goto(URL); await rf.wait_for_timeout(1200)
        await rf.evaluate("""() => {
            tokenIn = allTokens().find(t => t.symbol === "USDC");
            tokenOut = allTokens().find(t => t.symbol === "WETH");
            paintToken("in", tokenIn); paintToken("out", tokenOut); savePair();
        }""")
        await rf.fill("#amtIn", "5")
        await rf.dispatch_event("#amtIn", "input")
        await rf.wait_for_timeout(1600)
        typed = await rf.evaluate("""() => ({
            amt: document.getElementById("amtIn").value, plan: !!currentPlan,
            stored: localStorage.getItem("zaexa.pair")})""")
        await rf.reload(); await rf.wait_for_timeout(2600)
        after = await rf.evaluate("""() => ({
            amt: document.getElementById("amtIn").value,
            out: document.getElementById("amtOut").value,
            pair: document.getElementById("tokInSym").textContent + "/"
                + document.getElementById("tokOutSym").textContent})""")
        await rf.close()
        print("[refresh] typed=%r quoted=%s stored=%s -> after reload amt=%r pair=%s"
              % (typed["amt"], typed["plan"], typed["stored"], after["amt"], after["pair"]))
        assert typed["plan"], "the typed amount never produced a quote — probe is not testing anything"
        assert "amt" not in (typed["stored"] or ""), \
            ("the amount is still being written to localStorage (%s) — that is what came back "
             "after a refresh without a quote behind it" % typed["stored"])
        assert after["amt"] == "" and after["out"] == "", \
            ("the amount survived a refresh (%r): it comes back without a quote, so the button "
             "sits on 'Finding best route' until the field is retyped" % after["amt"])
        assert after["pair"] == "USDC/WETH", \
            ("the token pair should still be remembered across a refresh, only the amount is "
             "dropped: %s" % after["pair"])

        # هدر: ناوبری باید *وسطِ خودِ هدر* بماند — نه وسطِ فاصله‌ی باقی‌مانده.
        # ⚠️ ۲۹ اوت: این ادعا عوض شد چون *خواسته* عوض شد. قبلاً ناوبری کنار
        # لوگو می‌نشست (یک گروه در چپ) و یک فاصله‌ی کشسان همه‌ی فضای اضافه را
        # سمت راست جمع می‌کرد — یعنی ناوبری هرچه لوگو یا خوشه‌ی راست پهن‌تر یا
        # باریک‌تر می‌شد، جابه‌جا می‌شد. کاربر گفت ناوبری باید واقعاً وسط باشد،
        # فارغ از پهنای آن دو. با `grid-template-columns:1fr auto 1fr` این
        # تضمین ساختاری است، نه تصادفی: ستون میانی همیشه بین دو ستونِ هم‌اندازه
        # می‌نشیند. سنجه هم به همین اندازه ساده شد: مرکز ناوبری باید عملاً
        # مرکز هدر باشد.
        head = await pg.evaluate("""() => {
            const h = document.querySelector("header").getBoundingClientRect();
            const nav = document.getElementById("nav").getBoundingClientRect();
            return {navCenter: Math.round(nav.left + nav.width / 2),
                    hdrCenter: Math.round(h.left + h.width / 2),
                    navLeft: Math.round(nav.left), navRight: Math.round(nav.right),
                    vw: innerWidth};
        }""")
        print("[header] nav center=%s header center=%s  (nav %s..%s of %s)"
              % (head["navCenter"], head["hdrCenter"], head["navLeft"], head["navRight"], head["vw"]))
        assert abs(head["navCenter"] - head["hdrCenter"]) <= 2, \
            ("the nav is not centred in the header: nav center=%s header center=%s (%spx off) — "
             "grid-template-columns:1fr auto 1fr should keep it centred no matter how wide the "
             "logo or the right-hand cluster are" % (head["navCenter"], head["hdrCenter"],
                                                       abs(head["navCenter"] - head["hdrCenter"])))

        # هدر باید تمام‌عرضِ پنجره باشد.
        # ⚠️ ادعای این کاوشگر ۲۳ آگوست عوض شد چون *خواسته* عوض شد، نه چون
        # قرمز شده بود: قبلاً می‌سنجید که هدر دقیقاً هم‌عرض `main` است (۱۱۴۰
        # وسط صفحه)، و حسام گفت روی نمایشگر پهن شبیه ستون یک وبلاگ می‌شود.
        # ولی خطری که آن ادعا جلویش را می‌گرفت هنوز سر جایش است: `body` یک
        # ستون فلکس است و `margin:0 auto` کشیدگی محور عرضی را خنثی می‌کند، پس
        # هدر بدون `width:100%` به اندازه‌ی محتوای خودش جمع می‌شود (۷۸۵ در
        # برابر ۱۲۴۰). همان خطر، سنجه‌ی تازه: لبه تا لبه‌ی پنجره.
        align = await pg.evaluate("""() => {
            const h = document.querySelector("header").getBoundingClientRect();
            const m = document.querySelector("main").getBoundingClientRect();
            const cs = getComputedStyle(document.querySelector("header"));
            return {hl: Math.round(h.left), hr: Math.round(h.right),
                    ml: Math.round(m.left), mr: Math.round(m.right), vw: innerWidth,
                    surface: cs.backgroundColor, rule: cs.borderBottomWidth,
                    ruleColor: cs.borderBottomColor};
        }""")
        print("[header width] header %s..%s of %s (main %s..%s) surface=%s rule=%s"
              % (align["hl"], align["hr"], align["vw"], align["ml"], align["mr"],
                 align["surface"], align["rule"]))
        assert align["hl"] <= 0 and align["hr"] >= align["vw"], \
            ("the header no longer spans the window: it runs %s..%s of %s — without "
             "width:100%% a flex-column body shrinks it to its own content"
             % (align["hl"], align["hr"], align["vw"]))
        assert align["hr"] - align["hl"] > align["mr"] - align["ml"], \
            "the header is not wider than the cards below it, so it still reads as a column"
        # ۲۹ اوت: کاربر دیگر یک «نوار» بالای صفحه نمی‌خواست — فقط تمام‌عرض‌
        # بودن و خودِ محتوا (لوگو، ناوبری، چیپ‌ها) شناور روی زمینه‌ی صفحه.
        # پس نیمه‌ی «باید سطح/خط داشته باشد» این کاوشگر برداشته شد — دیگر
        # چیزی برای سنجیدن نیست، نبودشان دیگر نقص نیست، خواسته است.
        # ولی خطرِ زیربنایی که آن نیمه واقعاً جلویش را می‌گرفت چیز دیگری بود:
        # همین‌که هدر لبه‌به‌لبه بماند و هیچ‌کدام از دو تغییر بی‌صدا خنثی
        # نشوند. برای همین همان ادعای «تمام‌عرض و پهن‌تر از کارت‌ها» بالا
        # دست‌نخورده ماند و اینجا فقط یک چیز دیگر اضافه شده: ارتفاعِ هدر باید
        # با حذفِ سطح/خط عوض نشود — وگرنه هرچه زیرِ هدر است بی‌صدا یک پیکسل
        # جابه‌جا می‌شود و فاصله‌ی تازه‌ی ۳۰ پیکسلیِ کارت‌ها دیگر دقیقاً ۳۰
        # نیست. به‌همین‌خاطر خطِ زیرین کاملاً حذف نشد، فقط رنگش شفاف شد.
        assert align["surface"] in ("rgba(0, 0, 0, 0)", "transparent"), \
            ("the header still paints its own surface (%s) — it should float on the page "
             "background now, not read as a separate bar" % align["surface"])
        assert align["ruleColor"] in ("rgba(0, 0, 0, 0)", "transparent"), \
            "the bottom rule is still visible (%s) — it should be gone, not just faint" \
            % align["ruleColor"]
        # ⚠️ خودِ خط عمداً به‌جای حذف کامل، فقط بی‌رنگ شد: با
        # `box-sizing:border-box` یک پیکسلِ کادر جزوِ ارتفاعِ جعبه است. اگر
        # کاملاً حذف می‌شد هدر یک پیکسل کوتاه‌تر می‌شد و هرچه زیرش است — از
        # جمله فاصله‌ی تازه‌ی ۳۰ پیکسلیِ کارت‌ها — بی‌صدا یک پیکسل جابه‌جا
        # می‌شد و دیگر دقیقاً ۳۰ نبود. اینجا رابطه سنجیده می‌شود نه یک عددِ
        # مطلق: پهنای کادر باید همچنان چیزی غیرصفر باشد (فقط رنگش شفاف است)،
        # وگرنه یعنی کسی کادر را کامل حذف کرده و آن یک پیکسل دوباره گم شد.
        assert float(align["rule"].replace("px", "")) > 0, \
            ("the bottom border was removed outright (width=%s) instead of only being made "
             "transparent — that quietly shrinks the header by that many pixels and shifts "
             "everything below it" % align["rule"])

        # ---- 2c-bis. Bug 1 رگرسیون: وردمارک باید هم‌قدِ نشان بماند، نه درشت‌تر ----
        # نشان (glyph) و وردمارک دو viewBox با نسبتِ تصویریِ متفاوت دارند؛
        # اندازه‌ی CSS باید طوری تنظیم شود که «قدِ جوهر» دو طرف نزدیک هم بماند
        # (هدف ۰.۴۸ — این کامنت تا ۳۰ آگوست ۲۰۲۶ هنوز ۰.۶ می‌گفت، در حالی که
        # خودِ assert پایین‌تر درست بود؛ کامنتی که دروغ می‌گوید بدتر از کامنت
        # نداشتن است) و مرکزِ عمودیِ دو طرف عوض نشود. این روی صفحه‌ی *واقعی*
        # (نه هارنس) و در ۱۴۴۰×۹۰۰ سنجیده می‌شود، چون خودِ گزارش دقیقاً همین
        # سند و همین اندازه را اندازه گرفته بود.
        logopg = await b.new_page(viewport={"width": 1440, "height": 900})
        await logopg.goto("file://" + os.path.join(HERE, "..", "index.html"))
        await logopg.wait_for_timeout(700)
        logo = await logopg.evaluate("""() => {
            const mark = document.querySelector(".logo .glyph .mark").getBoundingClientRect();
            const word = document.querySelector(".logo .wordmark").getBoundingClientRect();
            const hdr = document.querySelector("header").getBoundingClientRect();
            return {markH: mark.height, wordH: word.height,
                    markCenter: mark.top + mark.height / 2,
                    wordCenter: word.top + word.height / 2,
                    hdrH: hdr.height};
        }""")
        await logopg.close()
        ratio = logo["wordH"] / logo["markH"]
        center_gap = abs(logo["markCenter"] - logo["wordCenter"])
        print("[header] wordmark is not oversized: mark=%.1fpx word=%.1fpx ratio=%.2f "
              "centers %.1f/%.1f headerH=%.1f"
              % (logo["markH"], logo["wordH"], ratio, logo["markCenter"], logo["wordCenter"],
                 logo["hdrH"]))
        # قاعده‌ی برند عوض شد: نسبتِ قدِ جوهرِ وردمارک به نشان دیگر ۰.۶۰ نیست،
        # ۰.۴۸ است (وردمارکِ کوچک‌تر، کنار نشانِ هم‌اندازه‌ی قبلی). باند هنوز
        # باریک است تا اگر کسی نسخه‌ی قدیمی (۰.۶۰) را برگرداند همچنان رد شود.
        assert 0.465 <= ratio <= 0.495, (
            "the wordmark's ink height is no longer sized to the mark's: ratio=%.3f (want "
            "0.465-0.495, target 0.48) — mark=%.1fpx word=%.1fpx" % (ratio, logo["markH"], logo["wordH"]))
        assert center_gap <= 1.5, (
            "resizing the wordmark moved it out of vertical alignment with the mark: "
            "%.2fpx apart" % center_gap)

        # کارت سواپ نباید کشیده شود تا هم‌قد نمودار شود — زیر دکمه فضای مرده
        # می‌ماند. ولی ارتفاع نمودار *از همان کشیدگی* تغذیه می‌شود، پس اگر کسی
        # به‌جای کارت، کل ردیف را از کشیدگی خارج کند، نمودار کوتاه می‌شود.
        # هر دو با هم سنجیده می‌شوند، وگرنه رفع یکی دیگری را می‌شکند.
        fit = await pg.evaluate("""async () => {
            const hero = document.querySelector(".row.hero");
            if (getComputedStyle(hero).gridTemplateColumns.split(" ").length < 2) return null;
            const [chart, swap] = [...hero.children];
            const H = e => Math.round(e.getBoundingClientRect().height);
            const settle = () => new Promise(r =>
                requestAnimationFrame(() => requestAnimationFrame(r)));
            const idle = H(swap);
            setNotice('<div class="note ok">Swap complete. <a href="#">View on BaseScan</a></div>');
            await settle();
            const withNote = H(swap);
            setNotice(""); await settle();
            const back = H(swap);
            return {chart: H(chart), plot: H(document.getElementById("plot")),
                    idle, withNote, back,
                    dead: Math.round(swap.getBoundingClientRect().bottom
                                     - document.getElementById("actBtn")
                                         .getBoundingClientRect().bottom)};
        }""")
        if fit:
            print("[card fit] chart=%s (plot %s) | swap card: idle=%s with a notice=%s back=%s "
                  "| room under the button=%s"
                  % (fit["chart"], fit["plot"], fit["idle"], fit["withNote"], fit["back"],
                     fit["dead"]))
            # این همان چیزی است که کاربر می‌بیند: کارت نباید با آمدن و رفتن
            # اعلان بالا و پایین بپرد. جای اعلان از پیش رزرو شده.
            assert fit["idle"] == fit["withNote"] == fit["back"], \
                ("the swap card changes height when a notice appears (%s -> %s -> %s) — the "
                 "notice slot is meant to be reserved so nothing jumps"
                 % (fit["idle"], fit["withNote"], fit["back"]))
            assert fit["dead"] <= 84, \
                ("%spx under the action button: that is more than the reserved notice slot, so "
                 "the card is being stretched to match the chart again" % fit["dead"])
            assert fit["plot"] >= 300, \
                ("the chart collapsed to %spx: with the row out of stretch the plot has nothing "
                 "to grow into, so it needs its own height. The two go together - taking the "
                 "row out of stretch without giving .plot a height starves the chart."
                 % fit["plot"])

        # نیمه‌ی دومِ کاوشگر [mobile order]: جابه‌جایی ترتیب فقط زیر ۹۴۱ پیکسل
        # است. اگر order به چیدمان دوستونه نشت کند، نمودار می‌رود سمت راست و
        # کل حساب‌های ارتفاعِ بالا بی‌معنا می‌شود.
        desk_order = await pg.evaluate("""() => {
            const c = [...document.querySelectorAll(".row.hero > .card")];
            const swap = c.find(x => x.querySelector("#amtIn"));
            const chart = c.find(x => x.querySelector("#plot"));
            return {chartLeft: Math.round(chart.getBoundingClientRect().left),
                    swapLeft: Math.round(swap.getBoundingClientRect().left)};
        }""")
        print("[desktop order] chart left=%s swap left=%s"
              % (desk_order["chartLeft"], desk_order["swapLeft"]))
        assert desk_order["chartLeft"] < desk_order["swapLeft"], \
            ("the two-column layout flipped: the chart is at %s and the swap card at %s — the "
             "mobile order override has leaked past its media query"
             % (desk_order["chartLeft"], desk_order["swapLeft"]))

        # ارتفاع نمودار نباید به کارت کناری وابسته باشد.
        # با `flex:1` ارتفاع نمودار از ارتفاع ردیف می‌آمد و ارتفاع ردیف از
        # کارت سواپ: نمودار روی بارگذاری ۵۷۲ پیکسل بود و با اولین تعویض توکن
        # روی ۵۱۰ می‌نشست. کاربر یک پرش ۶۲ پیکسلی می‌دید که ربطی به کارش نداشت.
        steady = await pg.evaluate("""async () => {
            const hero = document.querySelector(".row.hero");
            if (getComputedStyle(hero).gridTemplateColumns.split(" ").length < 2) return null;
            const chart = hero.firstElementChild;
            const H = e => Math.round(e.getBoundingClientRect().height);
            const wait = ms => new Promise(r => setTimeout(r, ms));
            const flip = () => { const t = tokenIn; tokenIn = tokenOut; tokenOut = t;
                                 if (typeof loadChart === "function") loadChart(); };
            const onLoad = H(chart);
            flip(); await wait(1300);
            const afterSwitch = H(chart);
            flip(); await wait(1300);
            const back = H(chart);
            /* و ادعای زیربنایی: ارتفاع نمودار نباید *اصلاً* به کارت کناری
               وابسته باشد. کارت سواپ را عمداً بلندتر می‌کنیم؛ اگر نمودار
               دنبالش برود یعنی هنوز از ردیف تغذیه می‌شود و همان پرش با هر
               تغییر محتوای کارت کناری برمی‌گردد. */
            const swap = hero.children[1];
            const keep = swap.style.minHeight;
            swap.style.minHeight = (H(swap) + 140) + "px";
            await wait(120);
            const whileNeighbourTaller = H(chart);
            swap.style.minHeight = keep;
            await wait(120);
            return {onLoad, afterSwitch, back, whileNeighbourTaller,
                    plot: H(document.getElementById("plot"))};
        }""")
        if steady:
            print("[chart steady] chart height on load=%s after switching tokens=%s back=%s "
                  "(plot %s)" % (steady["onLoad"], steady["afterSwitch"], steady["back"],
                                 steady["plot"]))
            assert steady["onLoad"] == steady["afterSwitch"] == steady["back"], \
                ("the chart card resized when the tokens were switched (%s -> %s -> %s) — its "
                 "height must come from itself, not from whatever the row happens to be"
                 % (steady["onLoad"], steady["afterSwitch"], steady["back"]))
            print("[chart steady] neighbour forced 140px taller -> chart=%s"
                  % steady["whileNeighbourTaller"])
            assert steady["whileNeighbourTaller"] == steady["back"], \
                ("making the swap card taller dragged the chart from %s to %s — the chart is "
                 "still sizing itself from the row, so any change in the card next to it will "
                 "move it again" % (steady["back"], steady["whileNeighbourTaller"]))

        # عرض‌های میانی جایی است که هدر معمولاً می‌شکند: ناوبری هنوز در هدر
        # است ولی جا تنگ شده. هیچ چیزی نباید از لبه بزند بیرون یا بپیچد.
        narrow = await b.new_page(viewport={"width": 760, "height": 900}, color_scheme="dark")
        await narrow.goto(URL); await narrow.wait_for_timeout(900)
        hn = await narrow.evaluate("""() => {
            const h = document.querySelector("header");
            const kids = [...h.children].map(e => e.getBoundingClientRect());
            // ⚠️ ارتفاع صفر هم فیلتر می‌شود، نه فقط عرض صفر. دو فاصله‌گذار
            // کشسان هدر عرض دارند ولی چیزی نشان نمی‌دهند؛ مرکزشان با بقیه
            // یکی نیست و به‌غلط «سطر دوم» شمرده می‌شدند.
            const tops = new Set(kids.filter(r => r.width > 0 && r.height > 0)
                                     .map(r => Math.round(r.top / 12)));
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
            def translate_path(self, path):
                # آینه‌ی همان قاعده در worker/index.js: /t/<آدرس> صفحه‌ی
                # اصلی را می‌گیرد. اگر آنجا عوض شد، اینجا هم باید عوض شود،
                # وگرنه تست چیزی را می‌سنجد که روی سایت وجود ندارد.
                clean = path.split("?")[0]
                if re.match(r"^/t/0x[0-9a-fA-F]{40}/?$", clean):
                    return os.path.join(HERE, "harness.html")
                # صفحه‌ی توکن یک <base href="/"> می‌گذارد، پس استاب از ریشه
                # خواسته می‌شود. روی سایت واقعی ethers هم دقیقاً کنار
                # index.html در ریشه است، پس این جانشینِ درستِ همان است.
                if clean == "/stub-ethers.js":
                    return os.path.join(HERE, "stub-ethers.js")
                return super().translate_path(path)
        srv = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0),
            functools.partial(Quiet, directory=os.path.join(HERE, "..")))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        port = srv.server_address[1]
        wcpg = await b.new_page()
        wc_errs = []
        wcpg.on("pageerror", lambda e: wc_errs.append(str(e)))
        await wcpg.goto("http://127.0.0.1:%d/" % port)
        wc_load = await wcpg.evaluate("""async (wcName) => {
            await new Promise((res, rej) => {
                const s = document.createElement("script");
                s.src = "./" + wcName;
                s.onload = res; s.onerror = () => rej(new Error("script failed"));
                document.head.appendChild(s);
            });
            const W = window.WCProvider;
            return {registered: !!W,
                    hasInit: !!(W && W.EthereumProvider &&
                                typeof W.EthereumProvider.init === "function")};
        }""", os.path.basename(vendor_path("walletconnect.bundle")))
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

        # ---- 2e-ter. ۶ ساعته نباید کپی‌ی ۱ ساعته باشد ----
        # علتِ اینکه باگِ بازه‌ی eth_getLogs تا حالا دیده نشده بود همین بود:
        # هارنس برای هر دو پنجره *همان* دسته‌ی ثابتِ لاگ را برمی‌گرداند، پس
        # [flow 1H] و [flow 6H] رقم به رقم یکی بودند و هیچ کاوشگری نمی‌توانست
        # فرقی ببیند که نبود. اینجا به‌جای آن مقدارِ ثابت، خودِ این کاوشگر
        # موقتاً `ethers.JsonRpcProvider.prototype.getLogs` را عوض می‌کند —
        # همان روشی که `[gate]` و `[quoter gate]` بالاتر برای شبیه‌سازی خطای
        # RPC استفاده کرده‌اند — و رفتار یک RPC عمومی واقعی را می‌سازد:
        #   ۱) هر بازه‌ی بزرگ‌تر از ۲۰۰۰ بلوک رد می‌شود (دقیقاً همان سقفی که
        #      باعث شد پنجره‌ی ۶ ساعته‌ی ۱۰۸۰۰ بلوکیِ تک‌درخواستی بشکند)،
        #   ۲) هر بازه‌ای که قبول می‌شود، رویدادهایی می‌سازد که از خودِ شماره‌
        #      بلوکش می‌آیند — پس دو بازه‌ی متفاوت، دو دسته لاگِ متفاوت
        #      می‌گیرند، نه یک کپی از یک دسته‌ی ثابت.
        # با این مسیر، کدِ قدیمیِ تک‌درخواستی همین‌جا رد می‌شد (بازه‌ی ۱۰۸۰۰
        # از ۲۰۰۰ رد می‌شود) و [flow 6H] یک خطای «نمی‌دانم» نشان می‌داد —
        # دقیقاً همان چیزی که کاربر واقعی دید. کدِ تکه‌تکه‌کننده باید چند
        # درخواست بزند و رد شود.
        flow_split = await pg.evaluate("""async () => {
            const realGetLogs = ethers.JsonRpcProvider.prototype.getLogs;
            const RANGE_CAP = 2000;
            const topic = iPool.getEvent("Swap").topicHash;
            /* ⚠️ لاگ باید به قالبِ خودِ استاب کدگذاری شود، نه ABI واقعی.
               stub-ethers.js چنین می‌کند:
                 data     = toHex(ser({amount0, amount1, recipient}))
                 parseLog = de(fromHex(lg.data))
               یعنی JSON، نه کلمه‌های ۳۲ بایتی. نسخه‌ی اول این کاوشگر کلمه‌های
               واقعیِ ABI می‌ساخت، `de` رویشان JSON.parse می‌خورد و می‌افتاد،
               و renderFlow با catch/continue همه را دور می‌ریخت — پس هر دو
               پنجره «۰ خرید · ۰ فروش» می‌شدند و *به همین دلیل* متنشان یکی
               بود، نه به‌خاطر باگی در تکه‌کردن. */
            const ser = (x) => JSON.stringify(x, (k, v) =>
                (typeof v === "bigint" ? { __b: v.toString() } : v));
            const toHex = (s) => "0x" + Array.from(new TextEncoder().encode(s))
                .map(b => b.toString(16).padStart(2, "0")).join("");
            let failMode = null, callIdx = 0;
            const calls = [];
            ethers.JsonRpcProvider.prototype.getLogs = async function (f) {
                const from = f.fromBlock, to = f.toBlock, i = callIdx++;
                calls.push([from, to]);
                if (to - from > RANGE_CAP)
                    throw Object.assign(new Error("eth_getLogs range exceeds the provider limit"),
                        { code: "SERVER_ERROR" });
                if (failMode && failMode(i, from))
                    throw Object.assign(new Error("temporary rpc hiccup"), { code: "SERVER_ERROR" });
                const logs = [];
                const start = Math.ceil(from / 97) * 97;
                for (let b = start; b <= to; b += 97) {
                    const isBuy = (b % 2) === 0;
                    const our = BigInt(1 + (b % 5)) * 10n ** 17n;
                    const ref = BigInt(200 + (b % 7) * 100) * 10n ** 6n;
                    logs.push({ blockNumber: b, data: toHex(ser({
                        amount0: isBuy ? -our : our,
                        amount1: isBuy ? ref : -ref,
                        recipient: "0x" + (b % 3 + 17).toString(16).repeat(20).slice(0, 40),
                    })) });
                }
                return logs;
            };

            async function run(id, fm) {
                failMode = fm; callIdx = 0; calls.length = 0;
                flowWindow = id;
                await renderFlow();
                await new Promise(r => setTimeout(r, 80));
                return { text: document.getElementById("flowBody").innerText,
                         html: document.getElementById("flowBody").innerHTML,
                         calls: calls.slice() };
            }

            const h1 = await run("h1", null);
            const h6 = await run("h6", null);
            /* ⚠️ شکست باید به خودِ *تکه* گره بخورد، نه به شماره‌ی فراخوانی:
               تلاش دوباره یک شماره‌ی تازه می‌گیرد و از شرطِ شماره‌ای فرار
               می‌کند، پس خواندن کامل می‌شود و مسیر «پوشش ناقص» هرگز اجرا
               نمی‌شود. با گره‌زدن به بلوکِ شروع، آن تکه هر بار می‌افتد. */
            /* دو سناریوی بعدی عمداً شکست می‌خورند و renderFlow درست عمل
               می‌کند که console.error بزند — ولی همان یک خط، بررسیِ
               «صفر خطای کنسول» در انتهای سوییت را قرمز می‌کرد. فقط برای
               همین دو اجرا خاموشش می‌کنیم و بلافاصله برمی‌گردانیم، تا یک
               خطای *غیرمنتظره* همچنان دیده شود. */
            const realConsoleError = console.error;
            console.error = () => {};
            const deadFrom = new Set();
            const h6partial = await run("h6", (i, from) => {
                if (deadFrom.size === 0 || deadFrom.has(from)) {
                    if (deadFrom.size < 2) deadFrom.add(from);
                    return deadFrom.has(from);
                }
                return false;
            });
            const h6dead = await run("h6", () => true);            // همه‌ی تکه‌ها شکست می‌خورند

            console.error = realConsoleError;
            ethers.JsonRpcProvider.prototype.getLogs = realGetLogs;
            flowWindow = "h1"; await renderFlow();   // حالت را برای بقیه‌ی تست‌ها برمی‌گرداند
            await new Promise(r => setTimeout(r, 200));

            return { h1, h6, h6partial, h6dead };
        }""")
        print("[flow split] 1H calls=%s 6H calls=%s (ranges<=1500: %s)"
              % (len(flow_split["h1"]["calls"]), len(flow_split["h6"]["calls"]),
                 all(t - f <= 1500 for f, t in flow_split["h6"]["calls"])))
        # ادعای اول: باگ اصلی. اگر ۱H و ۶H همان متن را بدهند، یعنی همان مشکلِ
        # «داده‌ی ساختگیِ یکسان برای دو پنجره» دوباره برگشته و این کاوشگر
        # دوباره کور شده.
        assert flow_split["h1"]["text"] != flow_split["h6"]["text"], \
            "1H and 6H rendered byte-identical text — the mock is hiding the window again"
        assert "Net" in flow_split["h6"]["text"], \
            "the 6H window did not render at all against a range-capped mock: %r" \
            % flow_split["h6"]["text"][:160]
        # ادعای دوم: بازه واقعاً تکه‌تکه شد. یک پنجره‌ی ۱۰۸۰۰ بلوکی با سقفِ
        # ۲۰۰۰ بلوکی فقط با بیش از یک درخواست ممکن است جواب بگیرد.
        assert len(flow_split["h6"]["calls"]) > 1, \
            "the 6H window answered from a single eth_getLogs call — chunking did not happen: %s" \
            % flow_split["h6"]["calls"]
        assert all(t - f <= 2000 for f, t in flow_split["h6"]["calls"]), \
            "a chunk still asked for more than the provider's 2000-block cap: %s" \
            % flow_split["h6"]["calls"]
        # ادعای سوم: بعضی تکه‌ها شکست بخورند، ولی نتیجه هنوز *ناقص* گزارش
        # شود، نه اینکه جمعِ ناقص را جمعِ کل جا بزند — قاعده‌ی اول همین پروژه.
        print("[flow split partial] %s" % flow_split["h6partial"]["text"].replace("\n", " | ")[:160])
        assert "did not answer" in flow_split["h6partial"]["text"], \
            ("a partial read must say so in the same words the rest of the file uses for "
             "unknown/partial states — got: %r" % flow_split["h6partial"]["text"][:200])
        assert "Coverage" in flow_split["h6partial"]["text"] or "~$" in flow_split["h6partial"]["text"], \
            "a partial result must be visibly marked as partial, not shown as a clean total"
        # ادعای چهارم: اگر همه‌ی تکه‌ها شکست بخورند، همان رفتارِ قدیمی —
        # «نمی‌دانم»، نه صفرِ ساختگی و نه جمعِ کامل.
        assert "unknown, not zero" in flow_split["h6dead"]["text"], \
            ("when every chunk fails the panel must fall back to the existing unknown-not-zero "
             "wording, not invent a total: %r" % flow_split["h6dead"]["text"][:200])
        assert "Net" not in flow_split["h6dead"]["text"], \
            "a totally failed read must not still show Bought/Sold/Net figures"

        # ---- 2e-quater. Bug 6 رگرسیون: نوارِ زیرِ Coverage خودش را معرفی می‌کند ----
        # آن نوار نسبتِ خرید-به-فروش است، نه نوارِ پوشش — قبلاً بدون برچسب
        # بود و درست کنار ردیفِ Coverage می‌نشست، پس چشم آن را مالِ Coverage
        # می‌خواند (یک بازه‌ی ۴.۳ از ۶ ساعت که همه‌فروش بود، یک نوارِ قرمزِ
        # تمام‌عرض نشان می‌داد که انگار «پوشش صفر است»).
        h6p_html = flow_split["h6partial"]["html"]
        print("[flow] split bar is labelled: %s" % (
            "flowbarCap" in h6p_html and "border-bottom" in h6p_html))
        assert "flowbarCap" in h6p_html, \
            "the bought/sold split bar has no caption class — it still reads as unlabelled"
        cap_m = re.search(r'<div class="flowbarCap">(.*?)</div>', h6p_html, re.S)
        assert cap_m, "no flowbarCap element was rendered next to the split bar"
        cap_text = cap_m.group(1)
        assert "Bought" in cap_text and "Sold" in cap_text and "%" in cap_text, \
            "the split-bar caption must name both sides and their share: %r" % cap_text[:160]
        cov_m = re.search(r'<div class="flowkv" style="([^"]*)">\s*<span class="k">Coverage</span>', h6p_html)
        assert cov_m, "the Coverage row markup changed shape — cannot check its separation style"
        assert "border-bottom" in cov_m.group(1), \
            "the Coverage row needs its own border so the split bar underneath it does not read " \
            "as belonging to Coverage: style=%r" % cov_m.group(1)

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

        # ---- 3b. مورد ۰۳ ریویو: کف روی صفحه = کفی که امضا می‌شود ----
        # وقتی مسیر بهتر در شبیه‌سازی می‌افتد، doSwap به یک صرافی تک برمی‌گردد
        # که minOut کمترى دارد. «Min received» از نقشه‌ی *اولیه* رندر شده بود و
        # دوباره رندر نمی‌شد، پس کاربر تراکنشی را امضا می‌کرد که ضمانتش پایین‌تر
        # از عدد روی صفحه بود — روی جفت کم‌عمق، بیشتر از لغزشی که خودش گذاشته.
        # raw string: the JS below contains \s, which is not a Python escape
        floor_probe = await pg.evaluate(r"""async () => {
            const realContract = E.Contract;
            const BIGV = 10n ** 40n;
            window.__STUB_ALLOWANCE__ = BIGV.toString();
            window.__STUB_BALANCE__ = BIGV.toString();   // وگرنه preflight همان‌جا می‌ایستد
            account = "0x8A0Dcb583C8CAdc481E34487c34f1B856fe97e23";
            signer = {}; walletChainId = CHAIN.id; walletIsRemote = false;
            balances[balKey(tokenIn)] = BIGV; allowance = BIGV; allowanceKnown = true;

            let cand = 0, seen = [], noticeAtSend = "";
            E.Contract = function () {
                const send = function () {
                    /* اعلان را همین‌جا برمی‌داریم — یک لحظه قبل از ارسال، که
                       دقیقاً همان چیزی است که کاربر می‌بیند. بعد از این،
                       showError جای اعلان را می‌گیرد. */
                    noticeAtSend = document.getElementById("notices").innerText
                                     .replace(/\s+/g, " ");
                    throw new Error("probe: stop before sending");
                };
                send.staticCall = async (...a) => {
                    /* ⚠️ doSwap اول runQuote را صدا می‌زند و آن هم runExitCheck را،
                       که یک مسیر *حلقه‌ای* (tokenIn == tokenOut) شبیه‌سازی می‌کند.
                       تلاش اول این تست همان تماس را با کاندید اول اشتباه گرفت و
                       حلقه‌ی کاندیدها هرگز به fallback نرسید. پس تفکیکش می‌کنیم. */
                    const isExitCheck = JSON.stringify(a[0]) === JSON.stringify(a[1]);
                    if (isExitCheck) return 1n;
                    cand++; seen.push(a[3].toString());
                    // کاندید اول «best» است و عمداً می‌افتد؛ دومی قبول می‌شود
                    if (cand === 1) throw new Error('execution reverted: "best route fails"');
                    return 1n;
                };
                send.estimateGas = async () => { throw new Error("probe: no estimate"); };
                return { executeSwap: send };
            };

            const before = document.getElementById("kMin").textContent;
            try { await doSwap(); } catch (e) {}
            E.Contract = realContract;

            delete window.__STUB_BALANCE__;
            const chosenMinOut = seen.length > 1 ? seen[1] : null;
            return {
                before, after: document.getElementById("kMin").textContent,
                calls: cand, chosenMinOut,
                expected: chosenMinOut === null ? null
                    : fmt(BigInt(chosenMinOut), tokenOut.decimals) + " " + tokenOut.symbol,
                notice: noticeAtSend
            };
        }""")
        print("[fallback floor] sims=%s  on screen before=%r after=%r"
              % (floor_probe["calls"], floor_probe["before"], floor_probe["after"]))
        assert floor_probe["calls"] >= 2, (
            "the probe never reached a fallback candidate (%s simulation calls) — preflight "
            "probably stopped doSwap first, so this test proves nothing"
            % floor_probe["calls"])
        assert floor_probe["expected"], "the fallback candidate's minOut was not captured"
        assert floor_probe["after"] == floor_probe["expected"], (
            "Min received on screen is not the floor that would have been signed.\n"
            "  on screen: %s\n  in the transaction: %s\n"
            "The user reads the panel, not the calldata."
            % (floor_probe["after"], floor_probe["expected"]))
        assert floor_probe["after"] != floor_probe["before"], (
            "the fallback floor happens to equal the original one, so this run cannot tell "
            "a re-render from a stale value — the probe needs a plan where they differ")
        assert "Minimum received is now" in floor_probe["notice"], (
            "the fallback notice names the venue but not the new floor: %s"
            % floor_probe["notice"][:160])

        # ---- 3c. مورد B پیگیری ریویو: پیامی که توصیه‌ی ناممکن نمی‌دهد ----
        # کلمپ پنیک را برداشت، ولی require(delivered >= minAmountOut) هنوز برای
        # گیرنده‌ای که پول را در همان تراکنش جلو می‌فرستد می‌افتد، چون minOut
        # هیچ‌وقت صفر نیست. پیام قدیمی «لغزش را بالا ببر» می‌گفت و آن توصیه
        # هرگز جواب نمی‌داد. حالا با یک شبیه‌سازی کف‌صفر تفکیک می‌شود.
        sweep_probe = await pg.evaluate(r"""async () => {
            const realContract = E.Contract;
            const BIGV = 10n ** 40n;
            window.__STUB_ALLOWANCE__ = BIGV.toString();
            window.__STUB_BALANCE__ = BIGV.toString();
            account = "0x8A0Dcb583C8CAdc481E34487c34f1B856fe97e23";
            signer = {}; walletChainId = CHAIN.id; walletIsRemote = false;
            balances[balKey(tokenIn)] = BIGV; allowance = BIGV; allowanceKnown = true;

            let zeroFloorCalls = 0, floors = [];
            E.Contract = function () {
                const send = function () { throw new Error("probe: stop before sending"); };
                send.staticCall = async (...a) => {
                    const isExitCheck = JSON.stringify(a[0]) === JSON.stringify(a[1]);
                    if (isExitCheck) return 1n;
                    const minOut = BigInt(a[3]);
                    floors.push(minOut.toString());
                    /* کیف پول جاروکننده: با هر کف واقعی می‌افتد، و با کف صفر
                       موفق می‌شود ولی صفر تحویل می‌دهد — دقیقاً همان چیزی که
                       روی زنجیره می‌بیند. */
                    if (minOut === 0n) { zeroFloorCalls++; return 0n; }
                    throw new Error('execution reverted: "slippage: output below minimum"');
                };
                send.estimateGas = async () => { throw new Error("probe: no estimate"); };
                return { executeSwap: send };
            };

            try { await doSwap(); } catch (e) {}
            E.Contract = realContract;
            delete window.__STUB_BALANCE__;
            return {
                zeroFloorCalls, floors,
                notice: document.getElementById("notices").innerText.replace(/\s+/g, " ")
            };
        }""")
        print("[recipient sweep] zero-floor sims=%s  says=%r"
              % (sweep_probe["zeroFloorCalls"], sweep_probe["notice"][:120]))
        assert sweep_probe["zeroFloorCalls"] == 1, (
            "the zero-floor diagnosis never ran (%s calls). Without it the page cannot tell "
            "'the price moved' from 'the recipient took the funds', and both arrive as the "
            "same revert string." % sweep_probe["zeroFloorCalls"])
        assert "moves the funds onward" in sweep_probe["notice"], (
            "a recipient that forwards the output is still told this was slippage: %s"
            % sweep_probe["notice"][:200])
        assert "Raise it in settings" not in sweep_probe["notice"], (
            "the page still tells the user to raise slippage. Raising it cannot help here — "
            "the cause is not price movement, so the advice can never succeed:\n  %s"
            % sweep_probe["notice"][:200])
        assert sweep_errs, (
            "the deliberate failure was allow-listed but never actually logged — the "
            "allowlist would then be a silent way to hide a real error")
        # خطای عمدی این کاوشگر واقعاً باید لاگ شده باشد — نه اینکه بی‌صدا رد شود
        assert probe_errs, \
            "doSwap swallowed the send failure instead of reporting it through showError"
        print("[fallback floor] the interrupted send was reported, not swallowed (%d log)"
              % len(probe_errs))

        await pg.evaluate("""() => {
            account = null; signer = null; walletChainId = null; walletIsRemote = false;
            balances = {}; allowance = 0n; allowanceKnown = false;
            delete window.__STUB_ALLOWANCE__; setNotice("");
        }""")
        await pg.fill("#amtIn", "900000"); await pg.wait_for_timeout(2500)

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
        # ---- 6c. پانویس نثری باید یک جمله‌ی پیوسته باشد، نه ستون‌های کنار هم ----
        # این پانویس‌ها از .frow استفاده می‌کردند و .frow یک ردیف فلکس است، پس
        # <b> وسط جمله یک آیتم فلکس می‌شد و ستون خودش را می‌گرفت. روی صفحه
        # این‌طور دیده می‌شد: «…This is | flow, not a forecast | : it shows…».
        # سنجه دقیقاً همان چیزی است که چشم می‌دید: عبارت پررنگ باید از هر دو
        # طرف به متن چسبیده باشد. در حالت فلکس، `gap:11px` هر طرف یازده پیکسل
        # فاصله می‌انداخت و `align-items:center` تکه‌ها را روی خط‌های متفاوت
        # می‌نشاند. با display هم می‌سنجیم تا برگشت به .frow از هر دو طرف بیفتد.
        # (دو سنجه‌ی دیگر را امتحان کردم و کنار گذاشتم چون باگ را جدا نمی‌کردند:
        #  «عرض تکه‌ها» — تکه‌ی اول به‌درستی وسط سطر تمام می‌شود؛ و «شروع افقی
        #  سطرها» — client rects به‌ازای هر تکه‌ی متن است، نه هر سطر.)
        await pg.click('.nav button[data-view="flow"]'); await pg.wait_for_timeout(1200)
        note = await pg.evaluate("""() => {
            const el = document.querySelector("#flowBody .fnote");
            if (!el) return {missing: true};
            const b = el.querySelector("b");
            if (!b) return {noBold: true};
            const cs = getComputedStyle(el), br = b.getBoundingClientRect();
            const edge = (start, end) => {
                const r = document.createRange();
                r.setStart(start[0], start[1]); r.setEnd(end[0], end[1]);
                const list = [...r.getClientRects()].filter(x => x.width > 1);
                return list.length ? list : null;
            };
            const before = edge([el.firstChild, 0], [b, 0]);
            const after  = edge([b, b.childNodes.length], [el.lastChild, el.lastChild.length]);
            const bl = before[before.length - 1], af = after[0];
            return {display: cs.display,
                    gapBefore: Math.round(br.left - bl.right),
                    lineBefore: Math.abs(br.top - bl.top) < 6,
                    gapAfter: Math.round(af.left - br.right),
                    lineAfter: Math.abs(af.top - br.top) < 6};
        }""")
        assert not note.get("missing"), "the Flow footnote is gone"
        assert not note.get("noBold"), "the Flow footnote lost the bold phrase this probe watches"
        print("[prose note] display=%s | bold touches text: before %spx/line=%s  after %spx/line=%s"
              % (note["display"], note["gapBefore"], note["lineBefore"],
                 note["gapAfter"], note["lineAfter"]))
        assert note["display"] == "block", \
            ("the prose footnote is display:%s — a flex parent turns the <b> mid-sentence "
             "into its own column" % note["display"])
        assert note["gapBefore"] <= 3 and note["lineBefore"], \
            ("the bold phrase is detached from the text before it: %spx away, same line=%s"
             % (note["gapBefore"], note["lineBefore"]))
        assert note["gapAfter"] <= 3 and note["lineAfter"], \
            ("the sentence does not continue straight after the bold phrase: %spx away, "
             "same line=%s" % (note["gapAfter"], note["lineAfter"]))

        # ---- 6d. حالت خالی باید بگوید صفحه چیست و راهِ ورود بدهد ----
        # این بلوک تنها چیزِ روی صفحه است وقتی والتی وصل نیست؛ یک جمله‌ی تنها
        # وسط صفحه‌ی خالی «اینجا چیزی نیست» خوانده می‌شد.
        # ⚠️ دکمه با delegation وصل است چون #folioBody با innerHTML بازنویسی
        # می‌شود. اینجا عمداً اول یک رندرِ دوباره می‌گیریم و بعد کلیک می‌کنیم —
        # یک onclick مستقیم دقیقاً همین‌جا می‌افتاد.
        # تا اینجای تست یک والت وصل شده، پس برای دیدن حالت خالی موقتاً قطعش
        # می‌کنیم. رندرِ دوباره هم عمداً همین‌جاست: کلیکِ بعدی روی محتوایی
        # می‌افتد که تازه با innerHTML ساخته شده.
        await pg.click('.nav button[data-view="folio"]'); await pg.wait_for_timeout(500)
        await pg.evaluate("window.__acct = account; account = null; renderFolio();")
        await pg.wait_for_timeout(400)
        intro = await pg.evaluate("""() => {
            const el = document.querySelector("#folioBody .empty.intro");
            if (!el) return {missing: true};
            const p = el.querySelector("p");
            return {h: Math.round(el.getBoundingClientRect().height),
                    title: (el.querySelector(".eTtl") || {textContent: ""}).textContent.trim(),
                    words: p ? p.textContent.trim().split(/\\s+/).length : 0,
                    btn: !!el.querySelector('[data-act="connect"]')};
        }""")
        assert not intro.get("missing"), "the portfolio empty state lost its intro block"
        print("[empty intro] height=%s title=%r body=%s words button=%s"
              % (intro["h"], intro["title"][:44], intro["words"], intro["btn"]))
        assert intro["h"] >= 280, \
            "the empty state is only %spx tall — it reads as a stub on a blank page" % intro["h"]
        assert intro["title"] and intro["words"] >= 6 and intro["btn"], \
            "the empty state needs a heading, a sentence of explanation and a way in"
        await pg.click('#folioBody [data-act="connect"]'); await pg.wait_for_timeout(400)
        assert await pg.evaluate('document.getElementById("walletOv").classList.contains("on")'), \
            ("the empty-state button did not open the wallet picker after a re-render "
             "— the delegated listener is gone")
        await pg.keyboard.press("Escape"); await pg.wait_for_timeout(250)
        await pg.evaluate("account = window.__acct; renderFolio();")
        await pg.wait_for_timeout(300)

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
        # ---- 8a. روی گوشی کارت سواپ باید بالای نمودار باشد ----
        # زیر ۹۴۱ پیکسل ستون یکی می‌شود و ترتیب DOM حکم می‌کرد، یعنی نمودار
        # اول می‌آمد و کارِ اصلی صفحه کامل زیر خط تاشو می‌افتاد.
        # دو ادعا، چون هرکدام جدا می‌تواند بشکند: ترتیب روی گوشی عوض شده باشد،
        # و ترتیب روی دسکتاپ عوض *نشده* باشد.
        order = await mob.evaluate("""() => {
            const c = [...document.querySelectorAll(".row.hero > .card")];
            const swap = c.find(x => x.querySelector("#amtIn"));
            const chart = c.find(x => x.querySelector("#plot"));
            const cta = document.getElementById("actBtn");
            return {swapTop: Math.round(swap.getBoundingClientRect().top + scrollY),
                    chartTop: Math.round(chart.getBoundingClientRect().top + scrollY),
                    ctaBottom: Math.round(cta.getBoundingClientRect().bottom + scrollY),
                    vh: innerHeight};
        }""")
        print("[mobile order] swap top=%s chart top=%s | swap CTA ends at %s of %s"
              % (order["swapTop"], order["chartTop"], order["ctaBottom"], order["vh"]))
        assert order["swapTop"] < order["chartTop"], \
            ("on a phone the swap card sits below the chart (%s vs %s) — the main action "
             "is pushed off the first screen" % (order["swapTop"], order["chartTop"]))
        assert order["ctaBottom"] <= order["vh"], \
            ("the swap button ends at %s in a %s viewport — it no longer fits the first screen"
             % (order["ctaBottom"], order["vh"]))

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
        # ---- 9. [events] شمارش رویداد، روی سیم ----
        # دو نگهبان ثابتش بالاتر اجرا شده (check_event_allowlists). اینجا آنچه
        # *واقعاً* روی سیم می‌رود سنجیده می‌شود، نه آنچه فکر می‌کنیم می‌رود.
        # روی http سرو می‌شود چون sendBeacon روی file:// مقصدی ندارد.
        ev_page, ev_detail = EV_PAGE_NAMES, EV_DETAILS

        async def watch_events(page):
            seen = []
            async def grab(route):
                seen.append(route.request.post_data or "")
                await route.fulfill(status=204, body="")
            await page.route("**/ev", grab)
            return seen

        evpg = await b.new_page(viewport={"width": 1240, "height": 1000})
        ev_seen = await watch_events(evpg)
        await evpg.goto("http://127.0.0.1:%d/test/harness.html#swap" % port)
        await evpg.wait_for_timeout(1400)
        for v in ("folio", "flow", "swap"):
            await evpg.click('#nav [data-view="%s"]' % v)
            await evpg.wait_for_timeout(320)
        await evpg.close()

        import json as _json
        ev_names = []
        for raw in ev_seen:
            body = _json.loads(raw)
            assert set(body) == {"e", "d", "v"}, "a beacon carried unexpected fields: %s" % raw
            assert body["e"] in ev_page, "a beacon carried an unknown event name: %s" % raw
            assert body["d"] in ev_detail, "a beacon carried an unknown detail: %s" % raw
            assert body["v"] in ("desktop", "mobile"), "a beacon carried an odd surface: %s" % raw
            assert "0x" not in raw, "AN ADDRESS REACHED THE ANALYTICS BEACON: %s" % raw
            ev_names.append(body["e"])
        print("[events] beacons on the wire: %s" % ev_names)
        for want in ("load", "view:swap", "view:folio", "view:flow"):
            assert want in ev_names, "the %r event never reached the wire (got %s)" % (want, ev_names)
        assert ev_names.count("load") == 1, "the load event fired %d times" % ev_names.count("load")

        # ---- لینک بررسی: کسی که بازش می‌کند بدون کیف پول جواب می‌گیرد ----
        # این تنها راه رشد بدون تبلیغات است که در خودِ محصول هست: سؤالی که در
        # گروه‌ها پرسیده می‌شود «این توکن سالم است؟»، و جوابش هیچ ریسکی برای
        # پرسنده ندارد. اگر لینک باز نشود یا شمرده نشود، آن حلقه وجود ندارد.
        srcpg = await b.new_page(viewport={"width": 1240, "height": 1000})
        await srcpg.goto("http://127.0.0.1:%d/test/harness.html" % port)
        await srcpg.wait_for_timeout(1200)
        # دکمه‌ی کپی نباید منتظر عدد بماند: لینک به *توکن* اشاره می‌کند نه به
        # یک کوت. روی صفحه‌ی تازه، با فیلد مبلغ خالی، باید همان‌جا دیده شود.
        share_amt = await srcpg.input_value("#amtIn")
        share_seen = await srcpg.is_visible("#checkShare")
        built = await srcpg.evaluate("() => tokenPageUrl() || checkUrl()")
        await srcpg.close()
        print("[check button] visible with an empty amount: %s (amount=%r)"
              % (share_seen, share_amt))
        assert share_amt == "", "the probe expected a fresh page with no amount typed"
        assert share_seen, (
            "the copy-check button only appears once a quote exists. The link points at a "
            "token, not at a quote, so it has no reason to wait for a number.")
        ck_path = built[built.index("/", 8):]   # پس از «http://host»
        # ⚠️ صفحه‌ی *تازه*. رفتن به همان سند با هشِ دیگر فقط hashchange می‌دهد،
        # نه بارگذاری — و تلاش اول همین بود و پنل خالی می‌ماند، که باگ لینک
        # نبود، باگ خودِ تست بود. گیرنده‌ی واقعی هم صفحه را از نو باز می‌کند.
        ckpg = await b.new_page(viewport={"width": 1240, "height": 1000})
        ck_seen = await watch_events(ckpg)
        await ckpg.goto("http://127.0.0.1:%d%s" % (port, ck_path))
        await ckpg.wait_for_timeout(4500)
        ck_box = (await ckpg.inner_text("#tk-exitBox")).replace("\n", " ")
        ck_out = await ckpg.inner_text("#tk-sym")
        ck_stats = (await ckpg.inner_text("#tk-tokStats")).replace("\n", " ")
        ck_risk = (await ckpg.inner_text("#tk-safetyBody")).replace("\n", " ")
        # هیچ اسکلتی نباید بعد از نشستن صفحه باقی بماند: اسکلتِ جامانده یعنی
        # چیزی هرگز نرسیده و کاربر به یک درخشش بی‌پایان نگاه می‌کند.
        ck_sk = await ckpg.eval_on_selector_all("#view-token .sk", "els => els.length")
        ck_score = await ckpg.inner_text("#tk-score")
        ck_swap_open = await ckpg.is_visible("#view-swap.on")
        # «Trade now» باید همان توکن را به فرم سواپ ببرد، نه اینکه صفحه را
        # از نو باز کند یا انتخاب را بریزد.
        # ⚠️ کلیک مشروط است. اگر صفحه‌ی توکن اصلاً باز نشده باشد، کلیک روی
        # دکمه‌ای که وجود ندارد ۳۰ ثانیه تایم‌اوت می‌دهد و پیامش «element is
        # not visible» است — که علت را پنهان می‌کند. این‌طور، همان ادعای
        # بالاتر که علت را می‌داند حرف می‌زند.
        ck_traded, ck_carried, ck_amt = False, "", ""
        if await ckpg.is_visible("#tk-trade"):
            await ckpg.click("#tk-trade")
            await ckpg.wait_for_timeout(1200)
            ck_traded = await ckpg.is_visible("#view-swap.on")
            ck_carried = await ckpg.inner_text("#tokOutSym")
            ck_amt = await ckpg.input_value("#amtIn")
        ck_names = [_json.loads(r)["e"] for r in ck_seen]
        await ckpg.close()
        print("[token page] %s -> %s | %s" % (ck_path, ck_out, ck_box[:52]))
        print("[token page] stats=%r risk=%r" % (ck_stats[:44], ck_risk[:44]))

        # ---- [stats] رد جفت مارکت‌کپ/FDV محال ----
        # روی همان تابع واقعی renderTokenStats و همان گره‌ی DOM واقعی، نه یک
        # کپی جدا از منطق. صفحه‌ی توکن را دوباره باز می‌کنیم چون tokenOut و
        # metaCache فقط آنجا برپا هستند؛ metaCache را موقتاً برای یک آدرس
        # سیم‌پیچی می‌کنیم تا داده‌ی ساختگی از همان مسیری بگذرد که داده‌ی
        # واقعی می‌گذرد.
        stpg = await b.new_page(viewport={"width": 1240, "height": 1000})
        await stpg.goto("http://127.0.0.1:%d%s" % (port, ck_path))
        await stpg.wait_for_timeout(3000)

        async def stats_case(fx):
            return await stpg.evaluate("""(fx) => {
                const key = (tokenOut.native ? WETH_ADDR : tokenOut.address).toLowerCase();
                const had = key in metaCache, orig = metaCache[key];
                metaCache[key] = fx;
                return renderTokenStats(tokenOut).then(() => {
                    const box = document.getElementById(tokenPage ? "tk-tokStats" : "tokStats");
                    const text = box.innerText;
                    if (had) metaCache[key] = orig; else delete metaCache[key];
                    return text;
                });
            }""", fx)

        fx_impossible = {"market_cap_usd": "72860000000", "fdv_usd": "4260000000",
                          "volume_usd": {"h24": "1000000"}, "total_reserve_in_usd": "500000"}
        fx_normal = {"market_cap_usd": "34670000", "fdv_usd": "212500000",
                     "volume_usd": {"h24": "1000000"}, "total_reserve_in_usd": "500000"}
        fx_tol = {"market_cap_usd": "100000000", "fdv_usd": "100000000",
                  "volume_usd": {"h24": "1000000"}, "total_reserve_in_usd": "500000"}

        txt_impossible = await stats_case(fx_impossible)
        txt_normal = await stats_case(fx_normal)
        txt_tol = await stats_case(fx_tol)
        await stpg.close()

        print("[stats] impossible pair is refused: mc=%r fdv=%r note=%s"
              % (fx_impossible["market_cap_usd"], fx_impossible["fdv_usd"],
                 "impossible" in txt_impossible))
        assert "$72.86B" not in txt_impossible and "$4.26B" not in txt_impossible, \
            "an impossible market cap/FDV pair was printed anyway: %r" % txt_impossible[:200]
        assert "impossible" in txt_impossible, \
            "the impossible-pair note never appeared: %r" % txt_impossible[:200]
        assert "$1.00M" in txt_impossible, \
            "hiding the impossible pair also hid volume, which was not implicated: %r" \
            % txt_impossible[:200]
        assert "$34.67M" in txt_normal and "$212.50M" in txt_normal, \
            "a legitimate market cap/FDV pair was hidden: %r" % txt_normal[:200]
        assert "impossible" not in txt_normal, \
            "a legitimate pair triggered the impossible-pair note: %r" % txt_normal[:200]
        assert "impossible" not in txt_tol, \
            "an equal market cap and FDV (fully circulating supply) was flagged as " \
            "impossible: %r" % txt_tol[:200]

        assert re.match(r"^/t/0x[0-9a-fA-F]{40}$", ck_path), \
            "the share button did not build a token-page link: %s" % ck_path
        assert not ck_swap_open, (
            "opening a token link still lands the reader on the swap form. They came with a "
            "question, not with a trade to place.")
        assert ck_out.strip() and ck_out != "—", \
            "the token page never named the token: %r" % ck_out
        assert ck_box.strip(), (
            "the token page shows an empty exit panel — the whole point is that the answer "
            "is already there when the page opens")
        assert ck_risk.strip() and "Reading the token" not in ck_risk, \
            "the risk panel never finished: %r" % ck_risk[:80]
        assert ck_stats.strip(), \
            "the token page shows no market figures: %r" % ck_stats[:80]
        assert ck_sk == 0, (
            "%d loading skeletons are still on the page after it settled — something never "
            "arrived and the reader is left looking at a shimmer." % ck_sk)
        assert ck_score.strip() not in ("", "0"), (
            "the risk score never counted up from zero (still %r). The ring animates from 0 "
            "on purpose; if it stops there, the scan result never reached the ring."
            % ck_score)
        assert ck_traded, "Trade now did not open the swap form"
        assert ck_amt == "", (
            "Trade now carried an amount into the swap form (%r). The figure on the token "
            "page is a reference size for the simulation, not an order the reader placed — "
            "and quoting it spends RPC calls nobody asked for." % ck_amt)
        assert ck_carried.strip() == ck_out.strip(), (
            "Trade now dropped the token the reader came for: page said %r, the form says %r"
            % (ck_out, ck_carried))
        assert "check:open" in ck_names, (
            "the check-link visit was not counted (%s). Without it there is no way to tell "
            "whether shared links bring anyone." % ck_names)

        # ---- 2b-sexies. Bug 3+4 رگرسیون: نوار ناوبری هم باید صفحه‌ی توکن را ترک کند ----
        # ریشه‌ی مشترک هر دو باگ یکی بود: setView هرگز tokenPage را خاموش
        # نمی‌کرد. دکمه‌ی Trade خودش دستی درستش می‌کرد، ولی نوار بالای صفحه
        # از کنارش رد می‌شد — کلیک روی Swap در ناوبری، tokenPage را روشن
        # نگه می‌داشت. اینجا از همان مسیر واقعی، نه دکمه‌ی Trade، عبور می‌کنیم.
        navpg = await b.new_page(viewport={"width": 1240, "height": 1000})
        await navpg.goto("http://127.0.0.1:%d%s" % (port, ck_path))
        await navpg.wait_for_timeout(4500)
        await navpg.click('#nav [data-view="swap"]')
        await navpg.wait_for_timeout(600)
        nv_tokenPage = await navpg.evaluate("() => tokenPage")
        nv_amt = await navpg.input_value("#amtIn")
        nv_hash = await navpg.evaluate("() => location.hash")
        nv_path = await navpg.evaluate("() => location.pathname")
        nv_safety = await navpg.inner_text("#safetyBody")
        await navpg.close()
        print("[token page] nav out of token page resets: tokenPage=%s amtIn=%r hash=%s path=%s"
              % (nv_tokenPage, nv_amt, nv_hash, nv_path))
        assert nv_tokenPage is False, (
            "clicking the nav Swap button left tokenPage=%r on — panel() still points at the "
            "hidden tk-* nodes instead of the main view" % nv_tokenPage)
        assert nv_amt == "", (
            "the nav Swap button carried the token page's reference amount into #amtIn (%r) — "
            "it now looks like an order the reader placed" % nv_amt)
        assert nv_hash == "#swap" and nv_path == "/", (
            "the nav Swap button did not really leave the token-page route: hash=%s path=%s"
            % (nv_hash, nv_path))
        assert "Pick a token to scan" not in nv_safety, (
            "the main view's safety card is still showing the initial placeholder after leaving "
            "the token page: %r" % nv_safety[:120])

        # Global Privacy Control یک «نه»ی صریح است و باید همه‌چیز را خاموش کند
        gpcpg = await b.new_page(viewport={"width": 1240, "height": 1000})
        await gpcpg.add_init_script(
            "Object.defineProperty(navigator,'globalPrivacyControl',{get:()=>true});")
        gpc_seen = await watch_events(gpcpg)
        await gpcpg.goto("http://127.0.0.1:%d/test/harness.html" % port)
        await gpcpg.wait_for_timeout(1400)
        await gpcpg.click('#nav [data-view="folio"]')
        await gpcpg.wait_for_timeout(400)
        await gpcpg.close()
        print("[events] with Global Privacy Control on: %d beacons" % len(gpc_seen))
        assert not gpc_seen, (
            "Global Privacy Control is an explicit opt-out and must silence every beacon: %s"
            % gpc_seen)

        # ---- [dev flag]: صاحب سایت باید بتواند آنالیتیکس را روی مرورگر خودش
        # برای همیشه خاموش کند، بدون شناسه و بدون رفت‌وبرگشت با سرور. سه
        # مرحله‌ی اول همه روی *یک* صفحه (یک context) پشت‌سرهم اجرا می‌شوند —
        # چون کل ادعا این است که پرچم بین بارگذاری‌ها زنده می‌ماند، و آن فقط
        # وقتی قابل آزمودن است که context عوض نشود. ----
        devpg = await b.new_page(viewport={"width": 1240, "height": 1000})
        dev_seen = await watch_events(devpg)

        # 1) خاموش‌کردن باید سرتاسری کار کند: صفر بیکن روی سیم.
        before = len(dev_seen)
        await devpg.goto("http://127.0.0.1:%d/test/harness.html?dev=1" % port)
        await devpg.wait_for_timeout(1400)
        # ⚠️ بنر از #notices خوانده نمی‌شود. نسخه‌ی اول همان‌جا می‌نشست و
        # روی سایت زنده در چند میلی‌ثانیه محو می‌شد، چون کوت‌گیری با هر
        # تغییر مبلغ `setNotice("")` می‌زند و روی صفحه‌ی خالیِ اول همین
        # بلافاصله اتفاق می‌افتد. تست وقت سبز بود چون *لحظه‌ی اول* را
        # می‌سنجید، نه حالت پایدار. حالا ظرف جداست و پایداری‌اش هم سنجیده
        # می‌شود: عمداً همان کاری که پاکش می‌کرد را می‌کنیم و باز می‌خوانیم.
        dev_notice_muted = await devpg.inner_text("#devBanner")
        await devpg.evaluate("() => setNotice('')")
        await devpg.fill("#amtIn", "5")
        await devpg.wait_for_timeout(500)
        await devpg.fill("#amtIn", "")
        await devpg.wait_for_timeout(900)
        dev_notice_survived = await devpg.inner_text("#devBanner")
        dev_banner_hidden = await devpg.evaluate(
            "() => document.getElementById('devBanner').hidden")
        dev_muted_beacons = len(dev_seen) - before

        # 2) باید ماندگار باشد: بارگذاریِ دوباره، بدون هیچ پارامتری، در همان
        # context، هنوز باید صفر بیکن بدهد. اگر ماندگار نبود کل قابلیت
        # بی‌فایده است.
        before = len(dev_seen)
        await devpg.goto("http://127.0.0.1:%d/test/harness.html" % port)
        await devpg.wait_for_timeout(1400)
        dev_persist_beacons = len(dev_seen) - before

        # 3) باید برگشت‌پذیر باشد: dev=0 پرچم را برمی‌دارد و بیکن‌ها دوباره
        # جاری می‌شوند — دستِ‌کم load.
        before = len(dev_seen)
        await devpg.goto("http://127.0.0.1:%d/test/harness.html?dev=0" % port)
        await devpg.wait_for_timeout(1400)
        dev_restored_raw = dev_seen[before:]
        await devpg.close()
        import json as _json2
        dev_restored_names = [_json2.loads(r)["e"] for r in dev_restored_raw]
        dev_restored_beacons = len(dev_restored_raw)

        print("[dev flag] muted: beacons=%d  persisted: beacons=%d  restored: beacons=%d"
              % (dev_muted_beacons, dev_persist_beacons, dev_restored_beacons))
        assert dev_muted_beacons == 0, (
            "?dev=1 must silence every beacon on the very first load, got %d"
            % dev_muted_beacons)
        assert "Analytics muted" in dev_notice_survived and not dev_banner_hidden, (
            "the mute banner vanished as soon as the quote path cleared the notice area "
            "(%r). It must live outside #notices, or the owner sees it for a few "
            "milliseconds on the live site and concludes the flag did not work."
            % dev_notice_survived[:120])
        assert dev_persist_beacons == 0, (
            "the mute flag did not survive a reload with no query string — a flag that resets "
            "on reload is useless, since the owner does not keep ?dev=1 in his address bar")
        assert dev_restored_beacons > 0 and "load" in dev_restored_names, (
            "?dev=0 must turn beacons back on (at least 'load'); got %s" % dev_restored_names)

        # 4) پاکسازی URL: بعد از یک بارِ dev=1 کنار یک لینک اشتراکی، پارامتر
        # dev باید ناپدید شود ولی in/out/amt دست‌نخورده بمانند، و پارسر لینک
        # نباید آن‌ها را به‌عنوان چیزی «باز نشدنی» ببیند — چون این‌ها اصلاً
        # روی location.hash نیستند، پارسر لینک اشتراکی اصلاً نمی‌بیندشان.
        # context تازه، تا حالت هیچ چیزی از مراحل بالا را به ارث نبرد.
        urlpg = await b.new_page(viewport={"width": 1240, "height": 1000})
        await urlpg.goto(
            "http://127.0.0.1:%d/test/harness.html?dev=1&in=USDC&out=WETH&amt=5" % port)
        await urlpg.wait_for_timeout(1400)
        url_search = await urlpg.evaluate("() => location.search")
        url_notice = await urlpg.inner_text("#devBanner")
        await urlpg.close()
        from urllib.parse import parse_qs
        url_q = parse_qs(url_search.lstrip("?"))
        print("[dev flag] url cleaned=%r notice=%r" % (url_search, url_notice[:120]))
        assert "dev" not in url_q, (
            "the dev param must be stripped from the address bar, or copying it hands someone "
            "else a link that silently mutes their analytics: %r" % url_search)
        for k in ("in", "out", "amt"):
            assert k in url_q, (
                "cleaning the dev param must not touch the other query params — %r vanished "
                "from %r" % (k, url_search))
        assert "could not be opened" not in url_notice, (
            "a leftover dev param (or its cleanup) confused the share-link parser: %r"
            % url_notice[:200])

        # 5) صاحب سایت نباید حدس بزند: پیام روی صفحه باید صریح بگوید خاموش شد.
        # همان context مرحله‌ی ۱ (dev_notice_muted) که تازه از dev=1 آمده.
        print("[dev flag] notice on mute contains 'Analytics muted': %s"
              % ("Analytics muted" in dev_notice_muted))
        assert "Analytics muted" in dev_notice_muted, (
            "the owner is not told muting worked: %r" % dev_notice_muted[:200])

        srv.shutdown()
        await b.close()

    print("\n--- console errors ---")
    if errors:
        for e in errors: print("  ", e)
        sys.exit(1)
    print("   none")

asyncio.run(main())
