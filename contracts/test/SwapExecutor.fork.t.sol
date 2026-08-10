// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "forge-std/console2.sol";
import "../src/SwapExecutor.sol";

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IV3FactoryLike {
    function getPool(address, address, uint24) external view returns (address);
}

/*
 * تست fork — مقابل قراردادهای *واقعی* روی Base.
 * ==========================================================================
 *
 * چرا لازم است: ماک‌ها فقط ثابت می‌کنند قرارداد با تصور ما از دنیا سازگار است.
 * این تست ثابت می‌کند با خودِ دنیا سازگار است. باگ SwapRouter02 دقیقاً در همان
 * فاصله زندگی می‌کرد.
 *
 * اجرا:
 *   export BASE_RPC_URL=https://base.drpc.org
 *   forge test --match-path 'test/SwapExecutor.fork.t.sol' -vv
 *
 * اگر BASE_RPC_URL تنظیم نباشد تست‌ها بی‌سروصدا رد می‌شوند، تا `forge test`
 * معمولی همچنان آفلاین کار کند.
 */
contract ForkTest is Test {

    // --- آدرس‌های واقعی Base ---
    address constant UNI_V3_ROUTER  = 0x2626664c2603336E57B271c5C0b26F421741e481; // SwapRouter02
    address constant UNI_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant AERO_ROUTER    = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant AERO_FACTORY   = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    // PancakeSwap V3 — نسل *اول* SwapRouter. بایت‌کد روترش 0x414bf389 دارد و
    // 0x04e45aaf ندارد؛ روی زنجیره بررسی شد. تنها صرافی‌ای که kind=3 می‌خواهد.
    address constant PCS_V3_ROUTER  = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;
    address constant PCS_V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;

    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;

    SwapExecutor exec;
    address user = address(0xBEEF);
    bool active;

    function setUp() public {
        string memory url = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            // ⚠️ رد شدن باید *دیده* شود. یک بار در این پروژه تست‌های سبزی
            //    داشتیم که هیچ چیزی را اثبات نمی‌کردند؛ تکرارش نمی‌کنیم.
            console2.log("");
            console2.log("  !! FORK TESTS SKIPPED - nothing was verified on-chain");
            console2.log("     export BASE_RPC_URL=https://base.drpc.org  and run again");
            console2.log("");
            return;
        }
        // 📌 پین کردن بلاک مهم است: فورج وضعیت را روی دیسک کش می‌کند، پس اجرای
        //    دوم تقریباً هیچ درخواستی به RPC نمی‌زند. بدون پین، RPCهای عمومی
        //    وسط کار 429 می‌دهند و تست‌ها به‌دلیلی بی‌ربط به کد شکست می‌خورند.
        uint256 pinned = vm.envOr("FORK_BLOCK", uint256(0));
        if (pinned > 0) vm.createSelectFork(url, pinned);
        else vm.createSelectFork(url);
        active = true;

        exec = new SwapExecutor(address(this), address(this), 0, WETH);
        address[] memory routers = new address[](3);
        routers[0] = UNI_V3_ROUTER;
        routers[1] = AERO_ROUTER;
        routers[2] = PCS_V3_ROUTER;
        exec.setRoutersAllowed(routers, true);
    }

    function _fund(address token, address to, uint256 amount) internal {
        deal(token, to, amount);
        vm.prank(to);
        IERC20Like(token).approve(address(exec), type(uint256).max);
    }

    function _part(uint8 kind, address router, address factory, uint24 fee,
                   address tin, address tout, uint256 amt)
        internal pure returns (SwapExecutor.RoutePart[] memory parts)
    {
        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](1);
        steps[0] = SwapExecutor.SwapStep({
            kind: kind, router: router, tokenIn: tin, tokenOut: tout,
            feeTier: fee, stable: false, poolFactory: factory
        });
        parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: amt});
    }

    /* ------------------------------------------------------------------
       ۱) همان سواپی که روی مین‌نت شکست می‌خورد: USDC → WETH از یونی‌سواپ V3.
          با اینترفیس قدیمی این تست revert می‌شد.
       ------------------------------------------------------------------ */
    function testRealUniswapV3Swap() public {
        if (!active) return;
        uint256 amountIn = 100e6;                    // ۱۰۰ USDC
        _fund(USDC, user, amountIn);

        uint256 before = IERC20Like(WETH).balanceOf(user);
        vm.prank(user);
        uint256 out = exec.executeSwap(
            USDC, WETH, amountIn, 1,
            _part(1, UNI_V3_ROUTER, UNI_V3_FACTORY, 500, USDC, WETH, amountIn),
            block.timestamp + 300
        );

        assertGt(out, 0, "Uniswap V3 swap returned nothing");
        assertEq(IERC20Like(WETH).balanceOf(user) - before, out, "user did not receive output");
        assertEq(IERC20Like(USDC).balanceOf(address(exec)), 0, "contract must keep no input token");
        assertEq(IERC20Like(WETH).balanceOf(address(exec)), 0, "contract must keep no output token");
    }

    /* ------------------------------------------------------------------
       ۲) ایرودروم واقعی
       ------------------------------------------------------------------ */
    function testRealAerodromeSwap() public {
        if (!active) return;
        uint256 amountIn = 100e6;
        _fund(USDC, user, amountIn);

        vm.prank(user);
        uint256 out = exec.executeSwap(
            USDC, WETH, amountIn, 1,
            _part(2, AERO_ROUTER, AERO_FACTORY, 0, USDC, WETH, amountIn),
            block.timestamp + 300
        );
        assertGt(out, 0, "Aerodrome swap returned nothing");
    }

    /* ------------------------------------------------------------------
       ۳) مسیر دومرحله‌ای واقعی — همان چیزی که در رابط وب می‌شکست
       ------------------------------------------------------------------ */
    function testRealTwoHopSwap() public {
        if (!active) return;
        uint256 amountIn = 100e6;
        _fund(USDC, user, amountIn);

        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](2);
        steps[0] = SwapExecutor.SwapStep({
            kind: 1, router: UNI_V3_ROUTER, tokenIn: USDC, tokenOut: WETH,
            feeTier: 500, stable: false, poolFactory: UNI_V3_FACTORY
        });
        steps[1] = SwapExecutor.SwapStep({
            kind: 2, router: AERO_ROUTER, tokenIn: WETH, tokenOut: USDC,
            feeTier: 0, stable: false, poolFactory: AERO_FACTORY
        });
        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: amountIn});

        // رفت‌وبرگشت USDC → WETH → USDC — دقیقاً همان چیزی که «شبیه‌سازی خروج»
        // در رابط اجرا می‌کند. اگر این تست بشکند، آن قابلیت هم شکسته است.
        uint256 before = IERC20Like(USDC).balanceOf(user);
        vm.prank(user);
        uint256 out = exec.executeSwap(USDC, USDC, amountIn, 1, parts, block.timestamp + 300);
        assertGt(out, 0, "round trip returned nothing");
        assertLt(out, amountIn, "round trip must lose to fees");
        assertEq(IERC20Like(USDC).balanceOf(user), before - amountIn + out, "user balance mismatch");
        assertEq(IERC20Like(WETH).balanceOf(address(exec)), 0, "contract must hold nothing");
    }

    /* ------------------------------------------------------------------
       ۴) تقسیم سفارش واقعی بین دو صرافی، در یک تراکنش
       ------------------------------------------------------------------ */
    function testRealSplitAcrossTwoDexes() public {
        if (!active) return;
        uint256 amountIn = 200e6;
        _fund(USDC, user, amountIn);

        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](2);

        SwapExecutor.SwapStep[] memory a = new SwapExecutor.SwapStep[](1);
        a[0] = SwapExecutor.SwapStep({kind: 1, router: UNI_V3_ROUTER, tokenIn: USDC,
            tokenOut: WETH, feeTier: 500, stable: false, poolFactory: UNI_V3_FACTORY});
        parts[0] = SwapExecutor.RoutePart({steps: a, amountIn: 120e6});

        SwapExecutor.SwapStep[] memory b = new SwapExecutor.SwapStep[](1);
        b[0] = SwapExecutor.SwapStep({kind: 2, router: AERO_ROUTER, tokenIn: USDC,
            tokenOut: WETH, feeTier: 0, stable: false, poolFactory: AERO_FACTORY});
        parts[1] = SwapExecutor.RoutePart({steps: b, amountIn: 80e6});

        vm.prank(user);
        uint256 out = exec.executeSwap(USDC, WETH, amountIn, 1, parts, block.timestamp + 300);
        assertGt(out, 0, "split swap returned nothing");
    }

    /* عمیق‌ترین استخر USDC/WETH پنکیک را از روی زنجیره پیدا می‌کند.
       fee tier را هاردکد نمی‌کنیم: اگر آن استخر خشک شود یا نباشد، تست باید
       بگوید «نتوانستم آزمایش کنم»، نه اینکه شکست را به گردن قرارداد بیندازد.
       این همان قاعده‌ی «نمی‌دانم ≠ نه» است، این بار داخل خودِ تست. */
    function _deepestPancakeFee() internal view returns (uint24 fee, uint256 depth) {
        uint24[4] memory tiers = [uint24(100), 500, 2500, 10000];
        for (uint256 i = 0; i < tiers.length; i++) {
            address pool = IV3FactoryLike(PCS_V3_FACTORY).getPool(USDC, WETH, tiers[i]);
            if (pool == address(0)) continue;
            uint256 bal = IERC20Like(WETH).balanceOf(pool);
            if (bal > depth) { depth = bal; fee = tiers[i]; }
        }
    }

    /* ------------------------------------------------------------------
       ۶) شاخه‌ی KIND_V3_LEGACY مقابل یک روتر نسل‌اول *واقعی*.
          تا امروز این شاخه‌ی قرارداد هرگز اجرا نشده بود — نه در تست واحد، نه
          در fork. نوشته شده بود، منطقی به نظر می‌رسید، و کسی امتحانش نکرده
          بود. دقیقاً همان وضعیتی که باگ SwapRouter02 از دلش درآمد.
       ------------------------------------------------------------------ */
    function testRealPancakeLegacySwap() public {
        if (!active) return;
        (uint24 fee, uint256 depth) = _deepestPancakeFee();
        if (fee == 0 || depth < 1 ether) {
            console2.log("");
            console2.log("  !! PANCAKE LEGACY SWAP NOT TESTED - no USDC/WETH pool with depth");
            console2.log("     the legacy branch is still unproven on-chain");
            console2.log("");
            return;
        }
        console2.log("pancake pool fee tier used:", fee);

        uint256 amountIn = 100e6;                    // ۱۰۰ USDC
        _fund(USDC, user, amountIn);

        uint256 before = IERC20Like(WETH).balanceOf(user);
        vm.prank(user);
        uint256 out = exec.executeSwap(
            USDC, WETH, amountIn, 1,
            _part(3, PCS_V3_ROUTER, PCS_V3_FACTORY, fee, USDC, WETH, amountIn),
            block.timestamp + 300
        );

        assertGt(out, 0, "legacy V3 swap returned nothing");
        assertEq(IERC20Like(WETH).balanceOf(user) - before, out, "user did not receive output");
        assertEq(IERC20Like(USDC).balanceOf(address(exec)), 0, "contract must keep no input token");
        assertEq(IERC20Like(WETH).balanceOf(address(exec)), 0, "contract must keep no output token");
    }

    /* ------------------------------------------------------------------
       ۷) قرینه‌ی تست ۵ — و همان باگی که همین امروز در رابط وب پیدا شد.
          پنکیک با kind=1 ثبت شده بود، یعنی 0x04e45aaf روی روتری صدا زده
          می‌شد که آن تابع را ندارد. باید revert کند.
       ------------------------------------------------------------------ */
    function testModernKindFailsAgainstLegacyRouter() public {
        if (!active) return;
        (uint24 fee, uint256 depth) = _deepestPancakeFee();
        if (fee == 0 || depth < 1 ether) return;

        uint256 amountIn = 10e6;
        _fund(USDC, user, amountIn);

        vm.prank(user);
        vm.expectRevert();      // سلکتور 0x04e45aaf روی SwapRouter نسل اول نیست
        exec.executeSwap(
            USDC, WETH, amountIn, 1,
            _part(1, PCS_V3_ROUTER, PCS_V3_FACTORY, fee, USDC, WETH, amountIn),
            block.timestamp + 300
        );
    }

    /* ------------------------------------------------------------------
       ۸) رفت‌وبرگشت با دو نسل مختلف در یک تراکنش — خرید از پنکیک (نسل اول)،
          فروش در یونی‌سواپ (نسل ۰۲). این همان چیزی است که «شبیه‌سازی خروج»
          در رابط اجرا می‌کند حالا که هر دو صرافی در مسیریابی هستند.
       ------------------------------------------------------------------ */
    function testRealMixedGenerationRoundTrip() public {
        if (!active) return;
        (uint24 fee, uint256 depth) = _deepestPancakeFee();
        if (fee == 0 || depth < 1 ether) return;

        uint256 amountIn = 100e6;
        _fund(USDC, user, amountIn);

        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](2);
        steps[0] = SwapExecutor.SwapStep({
            kind: 3, router: PCS_V3_ROUTER, tokenIn: USDC, tokenOut: WETH,
            feeTier: fee, stable: false, poolFactory: PCS_V3_FACTORY
        });
        steps[1] = SwapExecutor.SwapStep({
            kind: 1, router: UNI_V3_ROUTER, tokenIn: WETH, tokenOut: USDC,
            feeTier: 500, stable: false, poolFactory: UNI_V3_FACTORY
        });
        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: amountIn});

        uint256 before = IERC20Like(USDC).balanceOf(user);
        vm.prank(user);
        uint256 out = exec.executeSwap(USDC, USDC, amountIn, 1, parts, block.timestamp + 300);

        assertGt(out, 0, "mixed-generation round trip returned nothing");
        assertLt(out, amountIn, "round trip must lose to fees");
        assertEq(IERC20Like(USDC).balanceOf(user), before - amountIn + out, "user balance mismatch");
        assertEq(IERC20Like(WETH).balanceOf(address(exec)), 0, "contract must hold nothing");
    }

    /* ------------------------------------------------------------------
       ۵) نوع اشتباه روی روتر واقعی باید شکست بخورد — این همان باگ است،
          و از این به بعد به‌صورت یک انتظار صریح ثبت شده.
       ------------------------------------------------------------------ */
    function testLegacyKindFailsAgainstSwapRouter02() public {
        if (!active) return;
        uint256 amountIn = 10e6;
        _fund(USDC, user, amountIn);

        vm.prank(user);
        vm.expectRevert();      // سلکتور 0x414bf389 روی SwapRouter02 وجود ندارد
        exec.executeSwap(
            USDC, WETH, amountIn, 1,
            _part(3, UNI_V3_ROUTER, UNI_V3_FACTORY, 500, USDC, WETH, amountIn),
            block.timestamp + 300
        );
    }
}
