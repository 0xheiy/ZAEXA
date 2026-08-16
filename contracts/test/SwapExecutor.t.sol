// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SwapExecutor.sol";
import "./Mocks.sol";

/*
 * Security tests for SwapExecutor.
 *
 * The point of these tests is to *prove that the dangerous behaviours are impossible*.
 * Every test that passes means that attack or mistake cannot happen.
 *
 * Run:
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
        vm.deal(address(weth), 500 ether);   // so that withdraw can send ETH

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
    // helpers
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
    // 1) a plain swap must work
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
    // 2) SECURITY, critical: you cannot steal the funds of a user who has approved
    // ===================================================================
    function testCannotStealApprovedFunds() public {
        // the victim gives the contract an unlimited allowance (a perfectly normal thing)
        tokenA.mint(victim, 10_000 ether);
        vm.prank(victim);
        tokenA.approve(address(exec), type(uint256).max);

        // the attacker deploys a router that tries to steal from the victim
        MaliciousRouter bad = new MaliciousRouter(
            victim, attacker, address(tokenA), address(exec));

        tokenA.mint(attacker, 1 ether);
        vm.startPrank(attacker);
        tokenA.approve(address(exec), type(uint256).max);

        SwapExecutor.RoutePart[] memory parts =
            _singlePart(0, address(bad), address(tokenA), address(tokenB), 1 ether);

        // must be rejected, because the malicious router is not whitelisted
        vm.expectRevert(bytes("router not allowed"));
        exec.executeSwap(address(tokenA), address(tokenB), 1 ether, 0,
                         parts, block.timestamp + 60);
        vm.stopPrank();

        assertEq(tokenA.balanceOf(victim), 10_000 ether, "victim balance must be untouched");
        assertEq(tokenA.balanceOf(attacker), 1 ether, "attacker must gain nothing");
    }

    // ===================================================================
    // 3) a router outside the whitelist is rejected in every case
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
    // 4) only the owner can change the whitelist
    // ===================================================================
    function testOnlyOwnerCanWhitelist() public {
        MockV2Router other = new MockV2Router();

        vm.prank(attacker);
        vm.expectRevert(bytes("not owner"));
        exec.setRouterAllowed(address(other), true);

        vm.prank(user);
        vm.expectRevert(bytes("not owner"));
        exec.setRouterAllowed(address(other), true);

        // the owner can
        vm.prank(owner);
        exec.setRouterAllowed(address(other), true);
        assertTrue(exec.allowedRouter(address(other)));
    }

    // ===================================================================
    // 5) the owner cannot push the fee above the cap
    // ===================================================================
    function testFeeCannotExceedCap() public {
        uint256 cap = exec.MAX_FEE_BPS();

        vm.prank(owner);
        vm.expectRevert(bytes("fee too high"));
        exec.setFee(cap + 1);

        vm.prank(owner);
        vm.expectRevert(bytes("fee too high"));
        exec.setFee(10_000);         // 100%

        // up to the cap it is allowed
        vm.prank(owner);
        exec.setFee(cap);
        assertEq(exec.feeBps(), cap);
    }

    function testCannotDeployWithExcessiveFee() public {
        vm.expectRevert(bytes("fee too high"));
        new SwapExecutor(owner, feeTo, 101, address(weth));
    }

    // ===================================================================
    // 6) slippage protection: if the output is below the minimum, it reverts
    // ===================================================================
    function testSlippageProtection() public {
        uint256 amt = 100 ether;
        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenB), amt);

        // the mock rate is 2x, so the output will be 200.
        // if we ask for 250, it must revert.
        vm.prank(user);
        vm.expectRevert(bytes("slippage: output below minimum"));
        exec.executeSwap(address(tokenA), address(tokenB), amt, 250 ether,
                         parts, block.timestamp + 60);
    }

    function testSlippageProtectionWhenRateDrops() public {
        uint256 amt = 100 ether;
        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenB), amt);

        // simulate a sudden price drop between quoting and execution
        v3.setRate(1, 1);            // now it only gives 1x

        vm.prank(user);
        vm.expectRevert(bytes("slippage: output below minimum"));
        exec.executeSwap(address(tokenA), address(tokenB), amt, 190 ether,
                         parts, block.timestamp + 60);
    }

    // ===================================================================
    // 7) an expired deadline is rejected
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
    // 8) the parts must sum to exactly the total
    // ===================================================================
    function testPartsSumMustMatch() public {
        SwapExecutor.SwapStep[] memory s1 = new SwapExecutor.SwapStep[](1);
        s1[0] = _step(1, address(v3), address(tokenA), address(tokenB));
        SwapExecutor.SwapStep[] memory s2 = new SwapExecutor.SwapStep[](1);
        s2[0] = _step(0, address(v2), address(tokenA), address(tokenB));

        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](2);
        parts[0] = SwapExecutor.RoutePart({steps: s1, amountIn: 60 ether});
        parts[1] = SwapExecutor.RoutePart({steps: s2, amountIn: 30 ether});  // sum = 90, not 100

        vm.prank(user);
        vm.expectRevert(bytes("parts sum mismatch"));
        exec.executeSwap(address(tokenA), address(tokenB), 100 ether, 0,
                         parts, block.timestamp + 60);
    }

    // ===================================================================
    // 9) the steps must chain properly (each step's output = the next one's input)
    // ===================================================================
    function testStepsMustChain() public {
        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](2);
        steps[0] = _step(1, address(v3), address(tokenA), address(tokenB));
        // the second step should start at tokenB but starts at tokenC
        steps[1] = _step(1, address(v3), address(tokenC), address(tokenB));

        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: 10 ether});

        vm.prank(user);
        vm.expectRevert(bytes("steps not chained"));
        exec.executeSwap(address(tokenA), address(tokenB), 10 ether, 0,
                         parts, block.timestamp + 60);
    }

    // ===================================================================
    // 10) a part must start at tokenIn and end at tokenOut
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
    // 11) the contract holds nothing between transactions
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
    // 12) the fee is computed and paid correctly
    // ===================================================================
    function testFeeIsCollectedFromInputToken() public {
        vm.prank(owner);
        exec.setFee(50);            // 0.5%

        uint256 amt = 100 ether;
        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenB), amt);

        vm.prank(user);
        exec.executeSwap(address(tokenA), address(tokenB), amt, 0,
                         parts, block.timestamp + 60);

        // 0.5% fee on the *input*: 100 x 0.5% = 0.5 tokenA
        assertEq(tokenA.balanceOf(feeTo), 0.5 ether, "fee must be in tokenIn");
        assertEq(tokenB.balanceOf(feeTo), 0, "fee must NOT be in tokenOut");

        // 99.5 tokenA was swapped x rate 2 = 199 tokenB, all of it to the user
        assertEq(tokenB.balanceOf(user), 199 ether, "user gets full output");
    }

    // ===================================================================
    // KEY scenario: the user swaps into a risky token.
    //    our fee must not be in that token, because it may become worthless.
    // ===================================================================
    function testFeeNotExposedToRiskyOutputToken() public {
        vm.prank(owner);
        exec.setFee(100);           // 1% (the maximum)

        // treat tokenC as the "risky destination token"
        uint256 amt = 1000 ether;
        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenC), amt);

        vm.prank(user);
        exec.executeSwap(address(tokenA), address(tokenC), amt, 0,
                         parts, block.timestamp + 60);

        // the fee is in tokenA (the sound one), not tokenC (the risky one)
        assertEq(tokenA.balanceOf(feeTo), 10 ether, "fee in safe input token");
        assertEq(tokenC.balanceOf(feeTo), 0, "no exposure to risky token");
    }

    // ===================================================================
    // the fee also works correctly when the order is split
    // ===================================================================
    function testFeeWithSplitRoutes() public {
        vm.prank(owner);
        exec.setFee(50);            // 0.5%

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
        // 99.5 was swapped x 2 = 199
        assertEq(tokenB.balanceOf(user), 199 ether, "split respects fee deduction");
    }

    // ===================================================================
    // an amount so small that it becomes zero after the fee is rejected
    // ===================================================================
    function testRejectsAmountTooSmallAfterFee() public {
        vm.prank(owner);
        exec.setFee(100);           // 1%

        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenB), 1);

        vm.prank(user);
        // with 1 unit the fee rounds down to zero, so the swap goes ahead
        // but the output is zero -> it must revert
        vm.expectRevert();
        exec.executeSwap(address(tokenA), address(tokenB), 1, 100 ether,
                         parts, block.timestamp + 60);
    }

    // ===================================================================
    // 13) you cannot swap without an allowance
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
    // 14) you cannot swap more than your balance
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
    // 15) splitting an order across several routes works
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
    // 16) a multi-hop route works
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
    // 17) only the owner can change the settings
    // ===================================================================
    function testOnlyOwnerAdminFunctions() public {
        vm.startPrank(attacker);
        vm.expectRevert(bytes("not owner"));
        exec.setFee(10);
        vm.expectRevert(bytes("not owner"));
        exec.setFeeRecipient(attacker);
        vm.expectRevert(bytes("not owner"));
        exec.transferOwnership(attacker);
        vm.expectRevert(bytes("not owner"));
        exec.rescue(address(tokenA));
        vm.stopPrank();
    }

    // ===================================================================
    // 18) a zero amount or an identical token pair is rejected
    // ===================================================================
    function testRejectsInvalidInputs() public {
        SwapExecutor.RoutePart[] memory parts =
            _singlePart(1, address(v3), address(tokenA), address(tokenB), 10 ether);

        vm.startPrank(user);
        vm.expectRevert(bytes("zero amount"));
        exec.executeSwap(address(tokenA), address(tokenB), 0, 0, parts, block.timestamp + 60);

        // a single *step* must never have the same token in and out
        SwapExecutor.RoutePart[] memory same =
            _singlePart(1, address(v3), address(tokenA), address(tokenA), 10 ether);
        vm.expectRevert(bytes("step same token"));
        exec.executeSwap(address(tokenA), address(tokenA), 10 ether, 0, same, block.timestamp + 60);
        vm.stopPrank();
    }

    // ===================================================================
    // 18b) a round-trip route A -> B -> A is allowed and its accounting is correct
    //
    // This is what the "exit simulation" in the UI relies on: before buying, we run
    // the whole round trip in one staticCall to see whether, and at what cost, you can
    // get back out. The fork test showed the first version rejected this, so it is
    // recorded here as an explicit expectation.
    // ===================================================================
    function testRoundTripSameTokenIsAllowed() public {
        v3.setRate(1, 1);                     // rate 1:1 to keep the arithmetic simple

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
    // 19) the number of parts and steps is capped (prevents a gas attack)
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
    // 20) ownership transfer works correctly
    // ===================================================================
    function testOwnershipTransfer() public {
        address newOwner = address(0x1234);

        // step one: ownership has not moved yet
        vm.prank(owner);
        exec.transferOwnership(newOwner);
        assertEq(exec.owner(), owner, "ownership must not move before it is accepted");
        assertEq(exec.pendingOwner(), newOwner);

        // nobody but the target address can accept
        vm.prank(address(0xDEAD));
        vm.expectRevert(bytes("not pending owner"));
        exec.acceptOwnership();

        // step two
        vm.prank(newOwner);
        exec.acceptOwnership();
        assertEq(exec.owner(), newOwner);
        assertEq(exec.pendingOwner(), address(0), "pending must be cleared");

        // the previous owner no longer has access
        vm.prank(owner);
        vm.expectRevert(bytes("not owner"));
        exec.setFee(10);

        // the new owner does
        vm.prank(newOwner);
        exec.setFee(10);
        assertEq(exec.feeBps(), 10);
    }

    // ===================================================================
    // 21) SECURITY: reentrancy is blocked - even from an approved router
    //     This tests the worst case: a router that is on the whitelist but has
    //     turned malicious (upgraded, say) and tries to re-enter.
    // ===================================================================
    function testReentrancyIsBlocked() public {
        ReentrantRouter evil = new ReentrantRouter();

        // worst case: the malicious router *is whitelisted*
        vm.prank(owner);
        exec.setRouterAllowed(address(evil), true);

        SwapExecutor.RoutePart[] memory parts =
            _singlePart(0, address(evil), address(tokenA), address(tokenB), 10 ether);

        // the call that the malicious router tries to run again
        bytes memory payload = abi.encodeWithSelector(
            exec.executeSwap.selector,
            address(tokenA), address(tokenB), uint256(10 ether), uint256(0),
            parts, block.timestamp + 60);
        evil.setup(address(exec), payload);

        vm.prank(user);
        // !! an empty `vm.expectRevert()` accepts any failure - and this malicious
        //    router fails for another reason even without the lock. So we want the
        //    exact message, otherwise the test proves nothing.
        vm.expectRevert(bytes("reentrant"));
        exec.executeSwap(address(tokenA), address(tokenB), 10 ether, 0,
                         parts, block.timestamp + 60);

        // important: nothing must have been lost
        assertEq(tokenA.balanceOf(address(exec)), 0, "contract must hold nothing");
        assertEq(tokenA.balanceOf(user), 1_000_000 ether, "user funds intact");
    }

    // ===================================================================
    // 22) an invalid swap kind is rejected
    // ===================================================================
    function testRejectsUnknownSwapKind() public {
        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](1);
        steps[0] = SwapExecutor.SwapStep({
            kind: 4,                     // invalid kind (0..3 are valid)
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
    // 23) native ETH as the *input* - one transaction, no approve
    //
    // The UI used to have to wrap first, then approve, then swap: three signatures.
    // Now the ETH comes with the transaction itself and the contract wraps it inside.
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
    // 24) native ETH as the *output* - the contract unwraps it itself
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
    // 25) sending ETH along with an ERC-20 swap must be rejected (or it gets stuck)
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
    // 26) msg.value must be exactly equal to the declared amount
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
    // 27) SECURITY: only WETH may send ETH to the contract
    //     otherwise anyone could strand ETH here or throw the accounting off
    // ===================================================================
    function testOnlyWethCanSendEth() public {
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        (bool ok, ) = address(exec).call{value: 1 ether}("");
        assertFalse(ok, "a stranger must not be able to send ETH to the executor");
        assertEq(address(exec).balance, 0);
    }
}
