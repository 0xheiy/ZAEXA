// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SwapExecutor.sol";
import "./Mocks.sol";

/*
 * تست‌هایی که از بازبینی خط‌به‌خط بیرون آمدند.
 * ==========================================================================
 * هر کدام یک ادعای مشخص را می‌بندند که تا امروز *گفته* شده بود ولی هیچ‌جا
 * اثبات نشده بود. ترتیبشان به ترتیب همان یافته‌هاست.
 */
contract V2Test is Test {

    SwapExecutor exec;
    MockERC20 tokenA;
    MockERC20 tokenB;
    MockWETH  weth;
    MockV2Router v2;
    MockV3LegacyRouter legacy;

    address owner = address(this);
    address user  = address(0xBEEF);

    /* بدون این، owner (که خودِ قرارداد تست است) نمی‌تواند ETH بگیرد و
       rescueETH با "eth transfer failed" می‌افتد — ایراد تست بود نه قرارداد. */
    receive() external payable {}

    function setUp() public {
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        weth   = new MockWETH();
        v2     = new MockV2Router();
        legacy = new MockV3LegacyRouter();

        exec = new SwapExecutor(owner, owner, 0, address(weth));
        address[] memory rs = new address[](2);
        rs[0] = address(v2);
        rs[1] = address(legacy);
        exec.setRoutersAllowed(rs, true);

        tokenA.mint(user, 1_000_000 ether);
        vm.prank(user);
        tokenA.approve(address(exec), type(uint256).max);
    }

    function _part(uint8 kind, address router, address tin, address tout, uint256 amt)
        internal pure returns (SwapExecutor.RoutePart[] memory parts)
    {
        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](1);
        steps[0] = SwapExecutor.SwapStep({
            kind: kind, router: router, tokenIn: tin, tokenOut: tout,
            feeTier: 500, stable: false, poolFactory: address(0)
        });
        parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: amt});
    }

    /* ------------------------------------------------------------------
       ۱) نسل اول V3 باید *کار کند*، نه فقط در حالت اشتباه شکست بخورد.
          `MockV3LegacyRouter` از قبل نوشته شده بود ولی هرگز ساخته نمی‌شد،
          پس شاخه‌ی KIND_V3_LEGACY هیچ‌وقت با موفقیت اجرا نشده بود.
       ------------------------------------------------------------------ */
    function testLegacyV3RouterActuallyWorks() public {
        vm.prank(user);
        uint256 out = exec.executeSwap(
            address(tokenA), address(tokenB), 10 ether, 1,
            _part(3, address(legacy), address(tokenA), address(tokenB), 10 ether),
            block.timestamp + 60
        );
        assertEq(out, 20 ether, "legacy router path produced nothing");
        assertEq(tokenB.balanceOf(user), 20 ether);
    }

    /* ------------------------------------------------------------------
       ۲) باقی‌مانده‌ی قبلی قرارداد نباید به کاربر برسد.
          کل ادعای حسابداری `outBefore` روی این استوار است، ولی هیچ تستی
          قرارداد را از قبل پر نمی‌کرد — پس اصلاحیه در دنیایی آزموده می‌شد
          که هیچ‌وقت چیزی برای از دست دادن نداشت.
       ------------------------------------------------------------------ */
    function testPreExistingDustIsNotHandedToTheUser() public {
        tokenB.mint(address(exec), 7 ether);      // باقی‌مانده‌ی اتفاقی

        vm.prank(user);
        uint256 out = exec.executeSwap(
            address(tokenA), address(tokenB), 10 ether, 1,
            _part(0, address(v2), address(tokenA), address(tokenB), 10 ether),
            block.timestamp + 60
        );
        assertEq(out, 20 ether, "user must receive only what the swap produced");
        assertEq(tokenB.balanceOf(address(exec)), 7 ether, "dust must stay put");
    }

    /* همان ادعا، این بار روی مسیر حلقه‌ای — جایی که تصحیح واقعاً کار می‌کند */
    function testDustSurvivesLoopRoute() public {
        tokenA.mint(address(exec), 3 ether);

        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](2);
        steps[0] = SwapExecutor.SwapStep({kind: 0, router: address(v2),
            tokenIn: address(tokenA), tokenOut: address(tokenB),
            feeTier: 0, stable: false, poolFactory: address(0)});
        steps[1] = SwapExecutor.SwapStep({kind: 0, router: address(v2),
            tokenIn: address(tokenB), tokenOut: address(tokenA),
            feeTier: 0, stable: false, poolFactory: address(0)});
        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: 10 ether});

        vm.prank(user);
        uint256 out = exec.executeSwap(address(tokenA), address(tokenA), 10 ether, 1,
                                       parts, block.timestamp + 60);
        assertEq(out, 40 ether, "round trip output mis-measured");
        assertEq(tokenA.balanceOf(address(exec)), 3 ether, "dust must survive a loop route");
    }

    /* ------------------------------------------------------------------
       ۳) توکن کارمزددار در مسیر چندمرحله‌ای.
          v1 مقدار hop را از عدد برگشتی روتر می‌خواند؛ برای این توکن‌ها آن
          عدد از چیزی که واقعاً رسیده بیشتر است.
       ------------------------------------------------------------------ */
    function testFeeOnTransferIntermediateToken() public {
        MockFeeToken fot = new MockFeeToken(200);          // ۲٪ در هر انتقال
        MockReserveRouter r = new MockReserveRouter();
        vm.prank(owner);
        exec.setRouterAllowed(address(r), true);

        // روتر باید ذخیره داشته باشد، چون mint نمی‌کند
        r.fund(address(tokenB), 1_000 ether);
        fot.mint(address(r), 1_000 ether);

        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](2);
        steps[0] = SwapExecutor.SwapStep({kind: 0, router: address(r),
            tokenIn: address(tokenA), tokenOut: address(fot),
            feeTier: 0, stable: false, poolFactory: address(0)});
        steps[1] = SwapExecutor.SwapStep({kind: 0, router: address(r),
            tokenIn: address(fot), tokenOut: address(tokenB),
            feeTier: 0, stable: false, poolFactory: address(0)});
        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: 10 ether});

        vm.prank(user);
        uint256 out = exec.executeSwap(address(tokenA), address(tokenB), 10 ether, 1,
                                       parts, block.timestamp + 60);
        assertGt(out, 0, "fee-on-transfer path must complete");
        assertEq(fot.balanceOf(address(exec)), 0, "no fee token may be left behind");
    }

    /* ------------------------------------------------------------------
       ۴) توکن سبک USDT — نه مقدار برمی‌گرداند، نه allowance غیرصفر را
          مستقیم عوض می‌کند. هر دو شاخه‌ی سازگاری تا امروز اجرا نشده بودند.
       ------------------------------------------------------------------ */
    function testNoReturnValueTokenIsSupported() public {
        MockNoReturnToken usdtl = new MockNoReturnToken();
        MockReserveRouter r = new MockReserveRouter();
        vm.prank(owner);
        exec.setRouterAllowed(address(r), true);
        r.fund(address(tokenB), 1_000 ether);

        usdtl.mint(user, 1_000e6);
        vm.prank(user);
        usdtl.approve(address(exec), type(uint256).max);

        vm.prank(user);
        uint256 out = exec.executeSwap(
            address(usdtl), address(tokenB), 100e6, 1,
            _part(0, address(r), address(usdtl), address(tokenB), 100e6),
            block.timestamp + 60
        );
        assertGt(out, 0, "a token that returns no bool must still work");
    }

    /* ------------------------------------------------------------------
       ۵) بخشی که سهمش به صفر گرد شود باید صدا کند، نه اینکه بی‌صدا رد شود
          و پول کاربر همان‌جا بماند.
       ------------------------------------------------------------------ */
    function testPartThatRoundsToZeroReverts() public {
        vm.prank(owner);
        exec.setFee(100);                                  // ۱٪، تا گرد کردن معنا پیدا کند

        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](2);
        SwapExecutor.SwapStep[] memory a = new SwapExecutor.SwapStep[](1);
        a[0] = SwapExecutor.SwapStep({kind: 0, router: address(v2),
            tokenIn: address(tokenA), tokenOut: address(tokenB),
            feeTier: 0, stable: false, poolFactory: address(0)});
        parts[0] = SwapExecutor.RoutePart({steps: a, amountIn: 1});          // یک wei

        SwapExecutor.SwapStep[] memory b = new SwapExecutor.SwapStep[](1);
        b[0] = a[0];
        parts[1] = SwapExecutor.RoutePart({steps: b, amountIn: 1000 ether - 1});

        vm.prank(user);
        vm.expectRevert(bytes("part rounds to zero"));
        exec.executeSwap(address(tokenA), address(tokenB), 1000 ether, 1,
                         parts, block.timestamp + 60);
    }

    /* ------------------------------------------------------------------
       ۶) ETH گیرافتاده باید قابل برگشت باشد.
          `receive()` جلوی ارسال معمولی را می‌گیرد، ولی selfdestruct نه.
       ------------------------------------------------------------------ */
    function testRescueETH() public {
        vm.deal(address(exec), 1 ether);                   // شبیه‌سازی ETH تحمیلی
        uint256 before = owner.balance;

        exec.rescueETH();
        assertEq(address(exec).balance, 0, "ETH must leave the contract");
        assertEq(owner.balance, before + 1 ether, "owner must receive it");

        vm.expectRevert(bytes("nothing to rescue"));
        exec.rescueETH();
    }

    function testRescueETHIsOwnerOnly() public {
        vm.deal(address(exec), 1 ether);
        vm.prank(user);
        vm.expectRevert(bytes("not owner"));
        exec.rescueETH();
    }

    /* ------------------------------------------------------------------
       ۷) روتری که از لیست سفید حذف می‌شود باید بشود allowanceاش را هم بست.
       ------------------------------------------------------------------ */
    function testRevokeApprovalsAfterDelisting() public {
        vm.prank(user);
        exec.executeSwap(address(tokenA), address(tokenB), 10 ether, 1,
                         _part(0, address(v2), address(tokenA), address(tokenB), 10 ether),
                         block.timestamp + 60);
        assertGt(tokenA.allowance(address(exec), address(v2)), 0, "approval should exist");

        vm.prank(owner);
        exec.setRouterAllowed(address(v2), false);
        // حذف از لیست سفید به‌تنهایی allowance را نمی‌بندد — این عمدی است و
        // مستند شده، پس همین‌جا ثبتش می‌کنیم تا اگر عوض شد بدانیم.
        assertGt(tokenA.allowance(address(exec), address(v2)), 0);

        address[] memory toks = new address[](1);
        toks[0] = address(tokenA);
        vm.prank(owner);
        exec.revokeApprovals(toks, address(v2));
        assertEq(tokenA.allowance(address(exec), address(v2)), 0, "approval must be gone");
    }

    /* ------------------------------------------------------------------
       ۸) رویدادها. هیچ تستی تا امروز محتوایشان را چک نکرده بود — و به همین
          دلیل بود که v1 مقدار *اعلام‌شده* را لاگ می‌کرد نه مقدار دریافتی.
       ------------------------------------------------------------------ */
    event Swapped(
        address indexed user, address indexed tokenIn, address indexed tokenOut,
        uint256 amountIn, uint256 amountOut, uint256 fee
    );

    function testSwappedEventReportsWhatReallyHappened() public {
        vm.expectEmit(true, true, true, true);
        emit Swapped(user, address(tokenA), address(tokenB), 10 ether, 20 ether, 0);

        vm.prank(user);
        exec.executeSwap(address(tokenA), address(tokenB), 10 ether, 1,
                         _part(0, address(v2), address(tokenA), address(tokenB), 10 ether),
                         block.timestamp + 60);
    }

    /* ------------------------------------------------------------------
       ۹) مالکیت دومرحله‌ای — یک آدرس اشتباه نباید قرارداد را فریز کند.
       ------------------------------------------------------------------ */
    function testMistypedOwnerCannotFreezeTheContract() public {
        address typo = address(0xDEADBEEF);        // آدرسی که کلیدش را نداریم

        exec.transferOwnership(typo);
        assertEq(exec.owner(), owner, "a pending transfer must not take effect");

        // مالک اصلی هنوز کار می‌کند و می‌تواند اشتباهش را پس بگیرد
        exec.setFee(10);
        exec.transferOwnership(address(0x1234));
        assertEq(exec.pendingOwner(), address(0x1234));
    }
}
