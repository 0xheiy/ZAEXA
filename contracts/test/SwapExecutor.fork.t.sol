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
 * Fork test - against the *real* contracts on Base.
 * ==========================================================================
 *
 * Why it is needed: mocks only prove the contract agrees with our idea of the world.
 * This test proves it agrees with the world itself. The SwapRouter02 bug lived exactly
 * in that gap.
 *
 * Run:
 *   export BASE_RPC_URL=https://base.drpc.org
 *   forge test --match-path 'test/SwapExecutor.fork.t.sol' -vv
 *
 * If BASE_RPC_URL is not set the tests skip silently, so that a plain `forge test`
 * still works offline.
 */
contract ForkTest is Test {

    // --- real Base addresses ---
    address constant UNI_V3_ROUTER  = 0x2626664c2603336E57B271c5C0b26F421741e481; // SwapRouter02
    address constant UNI_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant AERO_ROUTER    = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant AERO_FACTORY   = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    // PancakeSwap V3 - the *first*-generation SwapRouter. Its router bytecode has
    // 0x414bf389 and not 0x04e45aaf; checked on-chain. The only DEX that needs kind=3.
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
            // !! A skip has to be *seen*. We once had green tests in this project
            //    that proved nothing; we are not repeating that.
            console2.log("");
            console2.log("  !! FORK TESTS SKIPPED - nothing was verified on-chain");
            console2.log("     export BASE_RPC_URL=https://base.drpc.org  and run again");
            console2.log("");
            return;
        }
        // NOTE: pinning the block matters: forge caches state on disk, so the second run
        //    makes almost no RPC requests. Without pinning, public RPCs start returning 429
        //    mid-run and the tests fail for a reason unrelated to the code.
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
       1) The same swap that was failing on mainnet: USDC -> WETH on Uniswap V3.
          With the old interface this test reverted.
       ------------------------------------------------------------------ */
    function testRealUniswapV3Swap() public {
        if (!active) return;
        uint256 amountIn = 100e6;                    // 100 USDC
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
       2) Real Aerodrome
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
       3) A real two-hop route - the same thing that was breaking in the web UI
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

        // USDC -> WETH -> USDC round trip - exactly what the "exit simulation"
        // in the UI does. If this test breaks, that feature is broken too.
        uint256 before = IERC20Like(USDC).balanceOf(user);
        vm.prank(user);
        uint256 out = exec.executeSwap(USDC, USDC, amountIn, 1, parts, block.timestamp + 300);
        assertGt(out, 0, "round trip returned nothing");
        assertLt(out, amountIn, "round trip must lose to fees");
        assertEq(IERC20Like(USDC).balanceOf(user), before - amountIn + out, "user balance mismatch");
        assertEq(IERC20Like(WETH).balanceOf(address(exec)), 0, "contract must hold nothing");
    }

    /* ------------------------------------------------------------------
       4) A real order split between two DEXes, in one transaction
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

    /* Finds the deepest Pancake USDC/WETH pool on-chain.
       We do not hardcode the fee tier: if that pool dries up or is not there, the test
       should say "I could not test this", rather than blame the failure on the contract.
       This is the same "don't know != no" rule, this time inside the test itself. */
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
       6) The KIND_V3_LEGACY branch against a *real* first-generation router.
          Until today this branch of the contract had never run - not in a unit test,
          not in a fork test. It was written, it looked reasonable, and nobody had
          tried it. Exactly the situation the SwapRouter02 bug came out of.
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

        uint256 amountIn = 100e6;                    // 100 USDC
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
       7) The mirror of test 5 - and the same bug that was found in the web UI
          today. Pancake had been registered with kind=1, meaning 0x04e45aaf was
          called on a router that does not have that function. It must revert.
       ------------------------------------------------------------------ */
    function testModernKindFailsAgainstLegacyRouter() public {
        if (!active) return;
        (uint24 fee, uint256 depth) = _deepestPancakeFee();
        if (fee == 0 || depth < 1 ether) return;

        uint256 amountIn = 10e6;
        _fund(USDC, user, amountIn);

        vm.prank(user);
        vm.expectRevert();      // selector 0x04e45aaf is not on the first-generation SwapRouter
        exec.executeSwap(
            USDC, WETH, amountIn, 1,
            _part(1, PCS_V3_ROUTER, PCS_V3_FACTORY, fee, USDC, WETH, amountIn),
            block.timestamp + 300
        );
    }

    /* ------------------------------------------------------------------
       8) A round trip across two different generations in one transaction - buy on
          Pancake (first generation), sell on Uniswap (02). This is what the "exit
          simulation" in the UI does now that both DEXes are in the routing.
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
       5) The wrong kind against a real router must fail - this is the bug, and
          from now on it is recorded as an explicit expectation.
       ------------------------------------------------------------------ */
    function testLegacyKindFailsAgainstSwapRouter02() public {
        if (!active) return;
        uint256 amountIn = 10e6;
        _fund(USDC, user, amountIn);

        vm.prank(user);
        vm.expectRevert();      // selector 0x414bf389 does not exist on SwapRouter02
        exec.executeSwap(
            USDC, WETH, amountIn, 1,
            _part(3, UNI_V3_ROUTER, UNI_V3_FACTORY, 500, USDC, WETH, amountIn),
            block.timestamp + 300
        );
    }
}
