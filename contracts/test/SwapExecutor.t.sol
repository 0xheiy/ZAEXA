// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SwapExecutor.sol";
import "./Mocks.sol";

/*
 * تست‌های امنیتی SwapExecutor.
 *
 * هدف این تست‌ها این است که *رفتارهای خطرناک را غیرممکن ثابت کنند*.
 * هر تستی که پاس شود یعنی آن حمله یا اشتباه ممکن نیست.
 *
 * اجرا:
 *     forge test -vv
 *     forge test --match-test testCannotStealApprovedFunds -vvv
 */
contract SwapExecutorTest is Test {

    SwapExecutor exec;
    MockERC20 tokenA;
    MockERC20 tokenB;
    MockERC20 tokenC;
    MockV2Router v2;
    MockV3Router v3;
    MockWETH weth;
    MockSolidlyRouter solidly;

    address owner   = address(0xA11CE);
    address user    = address(0xB0B);
    address victim  = address(0xC0FFEE);
    address attacker= address(0xBAD);
    address feeTo   = address(0xFEE);

    function setUp() public {
        tokenA = new MockERC20("Token A", "A", 18);
        tokenB = new MockERC20("Token B", "B", 18);
        tokenC = new MockERC20("Token C", "C", 18);
        v2 = new MockV2Router();
        v3 = new MockV3Router();
        solidly = new MockSolidlyRouter();

        weth = new MockWETH();
        vm.deal(address(weth), 500 ether);   // تا withdraw بتواند ETH بفرستد

        vm.prank(owner);
        exec = new SwapExecutor(owner, feeTo, 0, address(weth));

        vm.startPrank(owner);
        exec.setRouterAllowed(address(v2), true);
        exec.setRouterAllowed(address(v3), true);
        exec.setRouterAllowed(address(solidly), true);
        vm.stopPrank();

        tokenA.mint(user, 1_000_000 ether);
        vm.prank(user);
        tokenA.approve(address(exec), type(uint256).max);
    }

    // -------------------------------------------------------------------
    // کمکی‌ها
    // -------------------------------------------------------------------

    function _step(uint8 kind, address router, address tin, address tout)
        internal pure returns (SwapExecutor.SwapStep memory)
    {
        return SwapExecutor.SwapStep({
            kind: kind, router: router, tokenIn: tin, tokenOut: tout,
            feeTier: 3000, stable: false, poolFactory: address(0)
        });
    }

    function _singlePart(uint8 kind, address router, address tin, address tout, uint256 amt)
        internal pure returns (SwapExecutor.RoutePart[] memory parts)
    {
        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](1);
        steps[0] = _step(kind, router, tin, tout);
        parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: amt});
    }

    // ===================================================================
    // ۱) سواپ ساده باید کار کند
    // ===================================================================
    function testSimpleSwapWorks() public {
        uint256 amt = 100 ether;
        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenB), amt);

        vm.prank(user);
        uint256 out = exec.executeSwap(
            address(tokenA), address(tokenB), amt, 0, parts, block.timestamp + 60);

        assertEq(out, 200 ether, "output should be 2x input (mock rate)");
        assertEq(tokenB.balanceOf(user), 200 ether, "user should receive tokens");
        assertEq(tokenA.balanceOf(user), 1_000_000 ether - amt, "input should be deducted");
    }

    // ===================================================================
    // ۲) 🔒 حیاتی: نمی‌توان دارایی کاربری که approve داده را دزدید
    // ===================================================================
    function testCannotStealApprovedFunds() public {
        // قربانی به قرارداد اجازه‌ی نامحدود می‌دهد (کار کاملاً عادی)
        tokenA.mint(victim, 10_000 ether);
        vm.prank(victim);
        tokenA.approve(address(exec), type(uint256).max);

        // مهاجم روتری می‌سازد که سعی می‌کند از قربانی بدزدد
        MaliciousRouter bad = new MaliciousRouter(
            victim, attacker, address(tokenA), address(exec));

        tokenA.mint(attacker, 1 ether);
        vm.startPrank(attacker);
        tokenA.approve(address(exec), type(uint256).max);

        SwapExecutor.RoutePart[] memory parts =
            _singlePart(0, address(bad), address(tokenA), address(tokenB), 1 ether);

        // باید رد شود چون روتر مخرب در لیست سفید نیست
        vm.expectRevert(bytes("router not allowed"));
        exec.executeSwap(address(tokenA), address(tokenB), 1 ether, 0,
                         parts, block.timestamp + 60);
        vm.stopPrank();

        assertEq(tokenA.balanceOf(victim), 10_000 ether, "victim balance must be untouched");
        assertEq(tokenA.balanceOf(attacker), 1 ether, "attacker must gain nothing");
    }

    // ===================================================================
    // ۳) روتر خارج از لیست سفید در هر حالتی رد می‌شود
    // ===================================================================
    function testRejectsUnknownRouter() public {
        MockV2Router rogue = new MockV2Router();
        SwapExecutor.RoutePart[] memory parts =
            _singlePart(0, address(rogue), address(tokenA), address(tokenB), 10 ether);

        vm.prank(user);
        vm.expectRevert(bytes("router not allowed"));
        exec.executeSwap(address(tokenA), address(tokenB), 10 ether, 0,
                         parts, block.timestamp + 60);
    }

    // ===================================================================
    // ۴) فقط owner می‌تواند لیست سفید را تغییر دهد
    // ===================================================================
    function testOnlyOwnerCanWhitelist() public {
        MockV2Router other = new MockV2Router();

        vm.prank(attacker);
        vm.expectRevert(bytes("not owner"));
        exec.setRouterAllowed(address(other), true);

        vm.prank(user);
        vm.expectRevert(bytes("not owner"));
        exec.setRouterAllowed(address(other), true);

        // owner می‌تواند
        vm.prank(owner);
        exec.setRouterAllowed(address(other), true);
        assertTrue(exec.allowedRouter(address(other)));
    }

    // ===================================================================
    // ۵) owner نمی‌تواند کارمزد را از سقف بالاتر ببرد
    // ===================================================================
    function testFeeCannotExceedCap() public {
        uint256 cap = exec.MAX_FEE_BPS();

        vm.prank(owner);
        vm.expectRevert(bytes("fee too high"));
        exec.setFee(cap + 1);

        vm.prank(owner);
        vm.expectRevert(bytes("fee too high"));
        exec.setFee(10_000);         // ۱۰۰٪

        // تا سقف مجاز است
        vm.prank(owner);
        exec.setFee(cap);
        assertEq(exec.feeBps(), cap);
    }

    function testCannotDeployWithExcessiveFee() public {
        vm.expectRevert(bytes("fee too high"));
        new SwapExecutor(owner, feeTo, 101, address(weth));
    }

    // ===================================================================
    // ۶) محافظت اسلیپیج: اگر خروجی کمتر از حداقل باشد، برمی‌گردد
    // ===================================================================
    function testSlippageProtection() public {
        uint256 amt = 100 ether;
        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenB), amt);

        // نرخ ساختگی ۲ برابر است، پس خروجی ۲۰۰ خواهد بود.
        // اگر ۲۵۰ بخواهیم، باید revert شود.
        vm.prank(user);
        vm.expectRevert(bytes("slippage: output below minimum"));
        exec.executeSwap(address(tokenA), address(tokenB), amt, 250 ether,
                         parts, block.timestamp + 60);
    }

    function testSlippageProtectionWhenRateDrops() public {
        uint256 amt = 100 ether;
        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenB), amt);

        // شبیه‌سازی افت ناگهانی قیمت بین محاسبه و اجرا
        v3.setRate(1, 1);            // حالا فقط ۱ برابر می‌دهد

        vm.prank(user);
        vm.expectRevert(bytes("slippage: output below minimum"));
        exec.executeSwap(address(tokenA), address(tokenB), amt, 190 ether,
                         parts, block.timestamp + 60);
    }

    // ===================================================================
    // ۷) deadline گذشته رد می‌شود
    // ===================================================================
    function testExpiredDeadlineReverts() public {
        vm.warp(1000);
        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenB), 10 ether);

        vm.prank(user);
        vm.expectRevert(bytes("deadline passed"));
        exec.executeSwap(address(tokenA), address(tokenB), 10 ether, 0, parts, 999);
    }

    // ===================================================================
    // ۸) جمع بخش‌ها باید دقیقاً برابر کل باشد
    // ===================================================================
    function testPartsSumMustMatch() public {
        SwapExecutor.SwapStep[] memory s1 = new SwapExecutor.SwapStep[](1);
        s1[0] = _step(1, address(v3), address(tokenA), address(tokenB));
        SwapExecutor.SwapStep[] memory s2 = new SwapExecutor.SwapStep[](1);
        s2[0] = _step(0, address(v2), address(tokenA), address(tokenB));

        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](2);
        parts[0] = SwapExecutor.RoutePart({steps: s1, amountIn: 60 ether});
        parts[1] = SwapExecutor.RoutePart({steps: s2, amountIn: 30 ether});  // جمع = ۹۰ نه ۱۰۰

        vm.prank(user);
        vm.expectRevert(bytes("parts sum mismatch"));
        exec.executeSwap(address(tokenA), address(tokenB), 100 ether, 0,
                         parts, block.timestamp + 60);
    }

    // ===================================================================
    // ۹) مراحل باید درست زنجیر شوند (خروجی هر مرحله = ورودی بعدی)
    // ===================================================================
    function testStepsMustChain() public {
        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](2);
        steps[0] = _step(1, address(v3), address(tokenA), address(tokenB));
        // مرحله‌ی دوم باید از tokenB شروع شود ولی از tokenC شروع می‌کند
        steps[1] = _step(1, address(v3), address(tokenC), address(tokenB));

        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: 10 ether});

        vm.prank(user);
        vm.expectRevert(bytes("steps not chained"));
        exec.executeSwap(address(tokenA), address(tokenB), 10 ether, 0,
                         parts, block.timestamp + 60);
    }

    // ===================================================================
    // ۱۰) مسیر باید از tokenIn شروع و به tokenOut ختم شود
    // ===================================================================
    function testPartMustStartAndEndCorrectly() public {
        SwapExecutor.RoutePart[] memory bad1 =
            _singlePart(1, address(v3), address(tokenC), address(tokenB), 10 ether);
        vm.prank(user);
        vm.expectRevert(bytes("part must start at tokenIn"));
        exec.executeSwap(address(tokenA), address(tokenB), 10 ether, 0,
                         bad1, block.timestamp + 60);

        SwapExecutor.RoutePart[] memory bad2 =
            _singlePart(1, address(v3), address(tokenA), address(tokenC), 10 ether);
        vm.prank(user);
        vm.expectRevert(bytes("part must end at tokenOut"));
        exec.executeSwap(address(tokenA), address(tokenB), 10 ether, 0,
                         bad2, block.timestamp + 60);
    }

    // ===================================================================
    // ۱۱) قرارداد بین تراکنش‌ها هیچ دارایی نگه نمی‌دارد
    // ===================================================================
    function testContractHoldsNothingAfterSwap() public {
        uint256 amt = 100 ether;
        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenB), amt);

        vm.prank(user);
        exec.executeSwap(address(tokenA), address(tokenB), amt, 0,
                         parts, block.timestamp + 60);

        assertEq(tokenA.balanceOf(address(exec)), 0, "must not hold tokenIn");
        assertEq(tokenB.balanceOf(address(exec)), 0, "must not hold tokenOut");
    }

    // ===================================================================
    // ۱۲) کارمزد درست محاسبه و پرداخت می‌شود
    // ===================================================================
    function testFeeIsCollectedFromInputToken() public {
        vm.prank(owner);
        exec.setFee(50);            // ۰.۵٪

        uint256 amt = 100 ether;
        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenB), amt);

        vm.prank(user);
        exec.executeSwap(address(tokenA), address(tokenB), amt, 0,
                         parts, block.timestamp + 60);

        // کارمزد ۰.۵٪ از *ورودی*: 100 × 0.5% = 0.5 tokenA
        assertEq(tokenA.balanceOf(feeTo), 0.5 ether, "fee must be in tokenIn");
        assertEq(tokenB.balanceOf(feeTo), 0, "fee must NOT be in tokenOut");

        // 99.5 tokenA سواپ شد × نرخ ۲ = 199 tokenB، همه به کاربر
        assertEq(tokenB.balanceOf(user), 199 ether, "user gets full output");
    }

    // ===================================================================
    // 🔑 سناریوی اصلی: کاربر به توکن پرریسک سواپ می‌کند
    //    کارمزد ما نباید به آن توکن باشد، چون ممکن است بی‌ارزش شود.
    // ===================================================================
    function testFeeNotExposedToRiskyOutputToken() public {
        vm.prank(owner);
        exec.setFee(100);           // ۱٪ (حداکثر)

        // tokenC را «توکن پرریسک مقصد» فرض می‌کنیم
        uint256 amt = 1000 ether;
        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenC), amt);

        vm.prank(user);
        exec.executeSwap(address(tokenA), address(tokenC), amt, 0,
                         parts, block.timestamp + 60);

        // کارمزد به tokenA (معتبر) است، نه tokenC (پرریسک)
        assertEq(tokenA.balanceOf(feeTo), 10 ether, "fee in safe input token");
        assertEq(tokenC.balanceOf(feeTo), 0, "no exposure to risky token");
    }

    // ===================================================================
    // کارمزد در حالت تقسیم سفارش هم درست کار می‌کند
    // ===================================================================
    function testFeeWithSplitRoutes() public {
        vm.prank(owner);
        exec.setFee(50);            // ۰.۵٪

        SwapExecutor.SwapStep[] memory s1 = new SwapExecutor.SwapStep[](1);
        s1[0] = _step(1, address(v3), address(tokenA), address(tokenB));
        SwapExecutor.SwapStep[] memory s2 = new SwapExecutor.SwapStep[](1);
        s2[0] = _step(0, address(v2), address(tokenA), address(tokenB));

        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](2);
        parts[0] = SwapExecutor.RoutePart({steps: s1, amountIn: 60 ether});
        parts[1] = SwapExecutor.RoutePart({steps: s2, amountIn: 40 ether});

        vm.prank(user);
        exec.executeSwap(address(tokenA), address(tokenB), 100 ether, 0,
                         parts, block.timestamp + 60);

        assertEq(tokenA.balanceOf(feeTo), 0.5 ether, "fee taken once from input");
        // 99.5 سواپ شد × ۲ = 199
        assertEq(tokenB.balanceOf(user), 199 ether, "split respects fee deduction");
    }

    // ===================================================================
    // مبلغ خیلی کوچک که پس از کارمزد صفر شود، رد می‌شود
    // ===================================================================
    function testRejectsAmountTooSmallAfterFee() public {
        vm.prank(owner);
        exec.setFee(100);           // ۱٪

        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenB), 1);

        vm.prank(user);
        // با ۱ واحد، کارمزد صفر می‌شود (گِرد به پایین) پس سواپ ادامه می‌یابد
        // ولی خروجی صفر → باید revert شود
        vm.expectRevert();
        exec.executeSwap(address(tokenA), address(tokenB), 1, 100 ether,
                         parts, block.timestamp + 60);
    }

    // ===================================================================
    // ۱۳) بدون allowance نمی‌توان سواپ کرد
    // ===================================================================
    function testCannotSwapWithoutApproval() public {
        address noApprove = address(0xDEAD1);
        tokenA.mint(noApprove, 100 ether);

        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenB), 10 ether);

        vm.prank(noApprove);
        vm.expectRevert();
        exec.executeSwap(address(tokenA), address(tokenB), 10 ether, 0,
                         parts, block.timestamp + 60);
    }

    // ===================================================================
    // ۱۴) نمی‌توان بیشتر از موجودی سواپ کرد
    // ===================================================================
    function testCannotSwapMoreThanBalance() public {
        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenB), 2_000_000 ether);

        vm.prank(user);
        vm.expectRevert();
        exec.executeSwap(address(tokenA), address(tokenB), 2_000_000 ether, 0,
                         parts, block.timestamp + 60);
    }

    // ===================================================================
    // ۱۵) تقسیم سفارش بین چند مسیر درست کار می‌کند
    // ===================================================================
    function testSplitAcrossRoutes() public {
        SwapExecutor.SwapStep[] memory s1 = new SwapExecutor.SwapStep[](1);
        s1[0] = _step(1, address(v3), address(tokenA), address(tokenB));
        SwapExecutor.SwapStep[] memory s2 = new SwapExecutor.SwapStep[](1);
        s2[0] = _step(0, address(v2), address(tokenA), address(tokenB));

        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](2);
        parts[0] = SwapExecutor.RoutePart({steps: s1, amountIn: 60 ether});
        parts[1] = SwapExecutor.RoutePart({steps: s2, amountIn: 40 ether});

        vm.prank(user);
        uint256 out = exec.executeSwap(address(tokenA), address(tokenB), 100 ether, 0,
                                       parts, block.timestamp + 60);
        assertEq(out, 200 ether, "both routes must execute");
    }

    // ===================================================================
    // ۱۶) مسیر چندمرحله‌ای درست کار می‌کند
    // ===================================================================
    function testMultiHopRoute() public {
        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](2);
        steps[0] = _step(1, address(v3), address(tokenA), address(tokenC));
        steps[1] = _step(1, address(v3), address(tokenC), address(tokenB));

        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: 100 ether});

        vm.prank(user);
        uint256 out = exec.executeSwap(address(tokenA), address(tokenB), 100 ether, 0,
                                       parts, block.timestamp + 60);
        assertEq(out, 400 ether, "two hops x rate 2 = 4x");
    }

    // ===================================================================
    // ۱۷) فقط owner می‌تواند تنظیمات را تغییر دهد
    // ===================================================================
    function testOnlyOwnerAdminFunctions() public {
        vm.startPrank(attacker);
        vm.expectRevert(bytes("not owner"));
        exec.setFee(10);
        vm.expectRevert(bytes("not owner"));
        exec.setFeeRecipient(attacker);
        vm.expectRevert(bytes("not owner"));
        exec.setOwner(attacker);
        vm.expectRevert(bytes("not owner"));
        exec.rescue(address(tokenA));
        vm.stopPrank();
    }

    // ===================================================================
    // ۱۸) ورودی صفر یا توکن یکسان رد می‌شود
    // ===================================================================
    function testRejectsInvalidInputs() public {
        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenB), 10 ether);

        vm.startPrank(user);
        vm.expectRevert(bytes("zero amount"));
        exec.executeSwap(address(tokenA), address(tokenB), 0, 0, parts, block.timestamp + 60);

        // یک *مرحله* هرگز نباید ورودی و خروجی یکسان داشته باشد
        SwapExecutor.RoutePart[] memory same =
            _singlePart(1, address(v3), address(tokenA), address(tokenA), 10 ether);
        vm.expectRevert(bytes("step same token"));
        exec.executeSwap(address(tokenA), address(tokenA), 10 ether, 0, same, block.timestamp + 60);
        vm.stopPrank();
    }

    // ===================================================================
    // ۱۸ب) مسیر حلقه‌ای A → B → A مجاز است و حسابداری‌اش درست است
    //
    // این همان چیزی است که «شبیه‌سازی خروج» در رابط به آن تکیه می‌کند: قبل از
    // خرید، کل رفت‌وبرگشت را در یک staticCall اجرا می‌کنیم تا ببینیم آیا و با
    // چه هزینه‌ای می‌شود بیرون آمد. تست fork نشان داد نسخه‌ی اول این را رد
    // می‌کرد، پس اینجا به‌صورت انتظار صریح ثبت می‌شود.
    // ===================================================================
    function testRoundTripSameTokenIsAllowed() public {
        v3.setRate(1, 1);                     // نرخ ۱:۱ تا محاسبه ساده بماند

        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](2);
        steps[0] = _step(1, address(v3), address(tokenA), address(tokenB));
        steps[1] = _step(1, address(v3), address(tokenB), address(tokenA));
        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: 10 ether});

        uint256 before = tokenA.balanceOf(user);
        vm.prank(user);
        uint256 out = exec.executeSwap(address(tokenA), address(tokenA),
                                       10 ether, 0, parts, block.timestamp + 60);

        assertEq(out, 10 ether, "round trip must return the swapped amount, not a delta");
        assertEq(tokenA.balanceOf(user), before, "user should end where they started at rate 1:1");
        assertEq(tokenA.balanceOf(address(exec)), 0, "contract must hold nothing");
        assertEq(tokenB.balanceOf(address(exec)), 0, "contract must hold nothing");
    }

    // ===================================================================
    // ۱۹) تعداد بخش‌ها و مراحل محدود است (جلوگیری از حمله‌ی گس)
    // ===================================================================
    function testLimitsPartsAndSteps() public {
        SwapExecutor.RoutePart[] memory many = new SwapExecutor.RoutePart[](6);
        for (uint256 i = 0; i < 6; i++) {
            SwapExecutor.SwapStep[] memory s = new SwapExecutor.SwapStep[](1);
            s[0] = _step(1, address(v3), address(tokenA), address(tokenB));
            many[i] = SwapExecutor.RoutePart({steps: s, amountIn: 10 ether});
        }
        vm.prank(user);
        vm.expectRevert(bytes("bad parts count"));
        exec.executeSwap(address(tokenA), address(tokenB), 60 ether, 0,
                         many, block.timestamp + 60);
    }

    // ===================================================================
    // ۲۰) تغییر مالکیت درست کار می‌کند
    // ===================================================================
    function testOwnershipTransfer() public {
        address newOwner = address(0x1234);

        vm.prank(owner);
        exec.setOwner(newOwner);
        assertEq(exec.owner(), newOwner);

        // مالک قبلی دیگر دسترسی ندارد
        vm.prank(owner);
        vm.expectRevert(bytes("not owner"));
        exec.setFee(10);

        // مالک جدید دارد
        vm.prank(newOwner);
        exec.setFee(10);
        assertEq(exec.feeBps(), 10);
    }

    // ===================================================================
    // ۲۱) 🔒 ورود مجدد (reentrancy) مسدود است — حتی از روتر تأییدشده
    //     این بدترین حالت را تست می‌کند: روتری که در لیست سفید است
    //     ولی مخرب شده (مثلاً ارتقا پیدا کرده) و سعی می‌کند دوباره وارد شود.
    // ===================================================================
    function testReentrancyIsBlocked() public {
        ReentrantRouter evil = new ReentrantRouter();

        // بدترین سناریو: روتر مخرب *در لیست سفید است*
        vm.prank(owner);
        exec.setRouterAllowed(address(evil), true);

        SwapExecutor.RoutePart[] memory parts =
            _singlePart(0, address(evil), address(tokenA), address(tokenB), 10 ether);

        // فراخوانی‌ای که روتر مخرب سعی می‌کند دوباره اجرا کند
        bytes memory payload = abi.encodeWithSelector(
            exec.executeSwap.selector,
            address(tokenA), address(tokenB), uint256(10 ether), uint256(0),
            parts, block.timestamp + 60);
        evil.setup(address(exec), payload);

        vm.prank(user);
        vm.expectRevert();      // باید شکست بخورد (nonReentrant جلویش را می‌گیرد)
        exec.executeSwap(address(tokenA), address(tokenB), 10 ether, 0,
                         parts, block.timestamp + 60);

        // مهم: هیچ دارایی‌ای از دست نرفته باشد
        assertEq(tokenA.balanceOf(address(exec)), 0, "contract must hold nothing");
        assertEq(tokenA.balanceOf(user), 1_000_000 ether, "user funds intact");
    }

    // ===================================================================
    // ۲۲) نوع سواپ نامعتبر رد می‌شود
    // ===================================================================
    function testRejectsUnknownSwapKind() public {
        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](1);
        steps[0] = SwapExecutor.SwapStep({
            kind: 4,                     // نوع نامعتبر (۰..۳ معتبرند)
            router: address(v3), tokenIn: address(tokenA), tokenOut: address(tokenB),
            feeTier: 3000, stable: false, poolFactory: address(0)
        });
        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: 10 ether});

        vm.prank(user);
        vm.expectRevert(bytes("bad kind"));
        exec.executeSwap(address(tokenA), address(tokenB), 10 ether, 0,
                         parts, block.timestamp + 60);
    }


    // ===================================================================
    // ۲۳) ETH بومی به‌عنوان *ورودی* — یک تراکنش، بدون approve
    //
    // قبلاً رابط مجبور بود اول wrap کند و بعد approve و بعد سواپ: سه امضا.
    // حالا ETH با خود تراکنش می‌آید و قرارداد داخلش wrap می‌کند.
    // ===================================================================
    function testNativeInputSwapsInOneTransaction() public {
        uint256 amt = 1 ether;
        vm.deal(user, amt);

        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(weth), address(tokenB), amt);

        vm.prank(user);
        uint256 out = exec.executeSwap{value: amt}(
            address(0), address(tokenB), amt, 0, parts, block.timestamp + 60);

        assertEq(out, 2 ether, "native input should swap at the mock rate");
        assertEq(tokenB.balanceOf(user), 2 ether, "user should receive the output token");
        assertEq(user.balance, 0, "the ETH should have been spent");
        assertEq(address(exec).balance, 0, "contract must hold no ETH afterwards");
    }

    // ===================================================================
    // ۲۴) ETH بومی به‌عنوان *خروجی* — قرارداد خودش unwrap می‌کند
    // ===================================================================
    function testNativeOutputUnwrapsInSameTransaction() public {
        uint256 amt = 100 ether;
        v3.setRate(1, 1);

        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(weth), amt);

        uint256 before = user.balance;
        vm.prank(user);
        uint256 out = exec.executeSwap(
            address(tokenA), address(0), amt, 0, parts, block.timestamp + 60);

        assertEq(out, amt, "output amount mismatch");
        assertEq(user.balance - before, amt, "user must receive real ETH, not WETH");
        assertEq(weth.balanceOf(user), 0, "user should not be left holding WETH");
        assertEq(address(exec).balance, 0, "contract must hold no ETH afterwards");
    }

    // ===================================================================
    // ۲۵) ارسال ETH همراه سواپ ERC-20 باید رد شود (وگرنه گیر می‌افتد)
    // ===================================================================
    function testRejectsUnexpectedValue() public {
        vm.deal(user, 1 ether);
        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenB), 10 ether);

        vm.prank(user);
        vm.expectRevert(bytes("unexpected value"));
        exec.executeSwap{value: 1 ether}(
            address(tokenA), address(tokenB), 10 ether, 0, parts, block.timestamp + 60);
    }

    // ===================================================================
    // ۲۶) msg.value باید دقیقاً برابر مبلغ اعلام‌شده باشد
    // ===================================================================
    function testNativeValueMustMatchAmount() public {
        vm.deal(user, 2 ether);
        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(weth), address(tokenB), 1 ether);

        vm.prank(user);
        vm.expectRevert(bytes("value != amountIn"));
        exec.executeSwap{value: 0.5 ether}(
            address(0), address(tokenB), 1 ether, 0, parts, block.timestamp + 60);
    }

    // ===================================================================
    // ۲۷) 🔒 فقط WETH می‌تواند به قرارداد ETH بفرستد
    //     وگرنه هر کسی می‌توانست ETH گیر بیندازد یا حسابداری را به هم بریزد
    // ===================================================================
    function testOnlyWethCanSendEth() public {
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        (bool ok, ) = address(exec).call{value: 1 ether}("");
        assertFalse(ok, "a stranger must not be able to send ETH to the executor");
        assertEq(address(exec).balance, 0);
    }
}
