// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SwapExecutor.sol";
import "./Mocks.sol";

/*
 * Tests that came out of the line-by-line review.
 * ==========================================================================
 * Each one nails down a specific claim that until now had been *stated* but never
 * proved anywhere. They are in the same order as the findings.
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

    /* Without this, owner (which is the test contract itself) cannot receive ETH and
       rescueETH fails with "eth transfer failed" - that was a bug in the test, not the contract. */
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
       1) The first-generation V3 path must *work*, not just fail in the wrong case.
          `MockV3LegacyRouter` had already been written but was never instantiated,
          so the KIND_V3_LEGACY branch had never once run successfully.
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
       2) Dust already sitting in the contract must not reach the user.
          The whole `outBefore` accounting claim rests on this, but no test
          pre-funded the contract - so the fix was being tested in a world that
          never had anything to lose.
       ------------------------------------------------------------------ */
    function testPreExistingDustIsNotHandedToTheUser() public {
        tokenB.mint(address(exec), 7 ether);      // accidental leftover

        vm.prank(user);
        uint256 out = exec.executeSwap(
            address(tokenA), address(tokenB), 10 ether, 1,
            _part(0, address(v2), address(tokenA), address(tokenB), 10 ether),
            block.timestamp + 60
        );
        assertEq(out, 20 ether, "user must receive only what the swap produced");
        assertEq(tokenB.balanceOf(address(exec)), 7 ether, "dust must stay put");
    }

    /* Same claim, this time on a loop route - where the correction actually works */
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
       3) Fee-on-transfer token in a multi-hop route.
          v1 read the hop amount from the router's return value; for these tokens
          that number is larger than what really arrived.
       ------------------------------------------------------------------ */
    function testFeeOnTransferIntermediateToken() public {
        MockFeeToken fot = new MockFeeToken(200);          // 2% on every transfer
        MockReserveRouter r = new MockReserveRouter();
        vm.prank(owner);
        exec.setRouterAllowed(address(r), true);

        // the router must hold reserves, since it does not mint
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
       4) USDT-style token - it neither returns a value nor lets a non-zero
          allowance be changed directly. Neither compatibility branch had run until now.
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
       5) A part whose share rounds down to zero must make noise, instead of being
          silently skipped with the user's money left sitting there.
       ------------------------------------------------------------------ */
    function testPartThatRoundsToZeroReverts() public {
        vm.prank(owner);
        exec.setFee(100);                                  // 1%, so that rounding means something

        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](2);
        SwapExecutor.SwapStep[] memory a = new SwapExecutor.SwapStep[](1);
        a[0] = SwapExecutor.SwapStep({kind: 0, router: address(v2),
            tokenIn: address(tokenA), tokenOut: address(tokenB),
            feeTier: 0, stable: false, poolFactory: address(0)});
        parts[0] = SwapExecutor.RoutePart({steps: a, amountIn: 1});          // one wei

        SwapExecutor.SwapStep[] memory b = new SwapExecutor.SwapStep[](1);
        b[0] = a[0];
        parts[1] = SwapExecutor.RoutePart({steps: b, amountIn: 1000 ether - 1});

        vm.prank(user);
        vm.expectRevert(bytes("part rounds to zero"));
        exec.executeSwap(address(tokenA), address(tokenB), 1000 ether, 1,
                         parts, block.timestamp + 60);
    }

    /* ------------------------------------------------------------------
       6) Trapped ETH must be recoverable.
          `receive()` blocks an ordinary send, but not selfdestruct.
       ------------------------------------------------------------------ */
    function testRescueETH() public {
        vm.deal(address(exec), 1 ether);                   // simulating forced-in ETH
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
       7) A router removed from the whitelist must also allow its allowance to be closed.
       ------------------------------------------------------------------ */
    function testRevokeApprovalsAfterDelisting() public {
        vm.prank(user);
        exec.executeSwap(address(tokenA), address(tokenB), 10 ether, 1,
                         _part(0, address(v2), address(tokenA), address(tokenB), 10 ether),
                         block.timestamp + 60);
        assertGt(tokenA.allowance(address(exec), address(v2)), 0, "approval should exist");

        vm.prank(owner);
        exec.setRouterAllowed(address(v2), false);
        // Delisting on its own does not close the allowance - that is deliberate and
        // documented, so we record it right here to know if it ever changes.
        assertGt(tokenA.allowance(address(exec), address(v2)), 0);

        address[] memory toks = new address[](1);
        toks[0] = address(tokenA);
        vm.prank(owner);
        exec.revokeApprovals(toks, address(v2));
        assertEq(tokenA.allowance(address(exec), address(v2)), 0, "approval must be gone");
    }

    /* ------------------------------------------------------------------
       8) Events. No test had ever checked their contents - and that is exactly why
          v1 logged the *declared* amount rather than the amount received.
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
       9) Two-step ownership - one wrong address must not freeze the contract.
       ------------------------------------------------------------------ */
    function testMistypedOwnerCannotFreezeTheContract() public {
        address typo = address(0xDEADBEEF);        // an address whose key we do not have

        exec.transferOwnership(typo);
        assertEq(exec.owner(), owner, "a pending transfer must not take effect");

        // the original owner still works and can take its mistake back
        exec.setFee(10);
        exec.transferOwnership(address(0x1234));
        assertEq(exec.pendingOwner(), address(0x1234));
    }
}
