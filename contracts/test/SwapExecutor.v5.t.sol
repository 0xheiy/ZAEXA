// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SwapExecutor.sol";
import "./Mocks.sol";

/**
 * v5 additions.
 * ==============
 *
 *   (A) KIND_SLIPSTREAM - Aerodrome Slipstream (concentrated liquidity). Its
 *       ExactInputSingleParams struct has the SAME eight-field shape as the
 *       first-gen SwapRouter (KIND_V3_LEGACY), differing only in
 *       `int24 tickSpacing` vs `uint24 fee` - but the selector differs
 *       (0xa026383e vs 0x414bf389). Folding it into KIND_V3_LEGACY would send
 *       calldata to a function that does not exist on the Slipstream router.
 *       testSlipstreamSelectorIsNotTheLegacyOne and
 *       testSlipstreamKindAgainstLegacyOnlyRouterReverts exist specifically to
 *       catch that mistake.
 *
 *   (B) KIND_ADAPTER - an owner-registered adapter contract, on its own
 *       whitelist (`allowedAdapter`, separate from `allowedRouter`). The
 *       executor transfers the in-flight amount to the adapter directly and
 *       never grants it an allowance - strictly tighter than the router path.
 */
contract SwapExecutorV5Test is Test {
    SwapExecutor exec;
    MockERC20 tokenA;
    MockERC20 tokenB;
    MockERC20 tokenC;

    MockV3Router v3;
    MockSlipstreamRouter slip;
    MockLegacyOnlyRouter legacyOnly;
    MockAdapter adapter;

    address owner    = address(0xA11CE);
    address user     = address(0xB0B);
    address attacker = address(0xBAD);
    address feeTo    = address(0xFEE);

    function setUp() public {
        tokenA = new MockERC20("Token A", "A", 18);
        tokenB = new MockERC20("Token B", "B", 18);
        tokenC = new MockERC20("Token C", "C", 18);

        v3          = new MockV3Router();
        slip        = new MockSlipstreamRouter();
        legacyOnly  = new MockLegacyOnlyRouter();
        adapter     = new MockAdapter();

        MockWETH weth = new MockWETH();

        vm.prank(owner);
        exec = new SwapExecutor(owner, feeTo, 0, address(weth));

        vm.startPrank(owner);
        exec.setRouterAllowed(address(v3), true);
        exec.setRouterAllowed(address(slip), true);
        exec.setAdapterAllowed(address(adapter), true);
        vm.stopPrank();

        tokenA.mint(user, 1_000_000 ether);
        vm.prank(user);
        tokenA.approve(address(exec), type(uint256).max);
    }

    // -------------------------------------------------------------------
    // helpers
    // -------------------------------------------------------------------

    function _slipStep(address router, address tin, address tout, int24 tickSpacing)
        internal pure returns (SwapExecutor.SwapStep memory)
    {
        return SwapExecutor.SwapStep({
            kind: 4, router: router, tokenIn: tin, tokenOut: tout,
            feeTier: 0, stable: false, poolFactory: address(0), tickSpacing: tickSpacing
        });
    }

    function _v3Step(address router, address tin, address tout)
        internal pure returns (SwapExecutor.SwapStep memory)
    {
        return SwapExecutor.SwapStep({
            kind: 1, router: router, tokenIn: tin, tokenOut: tout,
            feeTier: 3000, stable: false, poolFactory: address(0), tickSpacing: 0
        });
    }

    function _adapterStep(
        address adp, address tin, address tout,
        uint24 feeTier, int24 tickSpacing, bool stable, address poolFactory
    ) internal pure returns (SwapExecutor.SwapStep memory) {
        return SwapExecutor.SwapStep({
            kind: 5, router: adp, tokenIn: tin, tokenOut: tout,
            feeTier: feeTier, stable: stable, poolFactory: poolFactory, tickSpacing: tickSpacing
        });
    }

    function _onePart(SwapExecutor.SwapStep memory s, uint256 amt)
        internal pure returns (SwapExecutor.RoutePart[] memory parts)
    {
        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](1);
        steps[0] = s;
        parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: amt});
    }

    // ===================================================================
    // Slipstream
    // ===================================================================

    function testSlipstreamSwapWorks() public {
        uint256 amt = 100 ether;
        SwapExecutor.RoutePart[] memory parts =
            _onePart(_slipStep(address(slip), address(tokenA), address(tokenB), 100), amt);

        vm.prank(user);
        uint256 out = exec.executeSwap(address(tokenA), address(tokenB), amt, 0,
                                       parts, block.timestamp + 60);

        assertEq(out, 200 ether, "slipstream mock rate is 2x");
        assertEq(tokenB.balanceOf(user), 200 ether, "Swapped amount must match the balance delta");
    }

    function testSlipstreamPassesTickSpacingThrough() public {
        uint256 amt = 10 ether;
        int24 spacing = 100;                    // a real, non-trivial Base tick spacing
        SwapExecutor.RoutePart[] memory parts =
            _onePart(_slipStep(address(slip), address(tokenA), address(tokenB), spacing), amt);

        vm.prank(user);
        exec.executeSwap(address(tokenA), address(tokenB), amt, 0, parts, block.timestamp + 60);

        assertEq(slip.lastTickSpacing(), spacing, "the tickSpacing must arrive at the router unchanged");
    }

    /// The guard against ever folding Slipstream into KIND_V3_LEGACY.
    function testSlipstreamSelectorIsNotTheLegacyOne() public pure {
        bytes4 slipstreamSelector = bytes4(keccak256(
            "exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))"
        ));
        bytes4 legacySelector = bytes4(keccak256(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))"
        ));

        assertEq(slipstreamSelector, bytes4(0xa026383e), "Slipstream selector must match the on-chain router");
        assertEq(legacySelector, bytes4(0x414bf389), "legacy selector must match the on-chain router");
        assertTrue(slipstreamSelector != legacySelector,
                   "identical shape, different selector - the two must never collide");
    }

    /// Proves the shape-similarity trap is real: pointed at a router that only
    /// knows the legacy (uint24 fee) shape, a Slipstream-kind call must revert.
    function testSlipstreamKindAgainstLegacyOnlyRouterReverts() public {
        vm.prank(owner);
        exec.setRouterAllowed(address(legacyOnly), true);

        uint256 amt = 10 ether;
        SwapExecutor.RoutePart[] memory parts =
            _onePart(_slipStep(address(legacyOnly), address(tokenA), address(tokenB), 100), amt);

        vm.prank(user);
        vm.expectRevert();   // the legacy-only router has no matching selector at all
        exec.executeSwap(address(tokenA), address(tokenB), amt, 0, parts, block.timestamp + 60);
    }

    function testSlipstreamRejectsZeroTickSpacing() public {
        uint256 amt = 10 ether;
        SwapExecutor.RoutePart[] memory parts =
            _onePart(_slipStep(address(slip), address(tokenA), address(tokenB), 0), amt);

        vm.prank(user);
        vm.expectRevert(bytes("bad tick spacing"));
        exec.executeSwap(address(tokenA), address(tokenB), amt, 0, parts, block.timestamp + 60);
    }

    function testSlipstreamRejectsNegativeTickSpacing() public {
        uint256 amt = 10 ether;
        SwapExecutor.RoutePart[] memory parts =
            _onePart(_slipStep(address(slip), address(tokenA), address(tokenB), -100), amt);

        vm.prank(user);
        vm.expectRevert(bytes("bad tick spacing"));
        exec.executeSwap(address(tokenA), address(tokenB), amt, 0, parts, block.timestamp + 60);
    }

    function testSlipstreamRouterMustBeWhitelisted() public {
        MockSlipstreamRouter unlisted = new MockSlipstreamRouter();
        uint256 amt = 10 ether;
        SwapExecutor.RoutePart[] memory parts =
            _onePart(_slipStep(address(unlisted), address(tokenA), address(tokenB), 100), amt);

        vm.prank(user);
        vm.expectRevert(bytes("router not allowed"));
        exec.executeSwap(address(tokenA), address(tokenB), amt, 0, parts, block.timestamp + 60);
    }

    function testSlipstreamInSplitRoute() public {
        SwapExecutor.SwapStep[] memory s1 = new SwapExecutor.SwapStep[](1);
        s1[0] = _v3Step(address(v3), address(tokenA), address(tokenB));
        SwapExecutor.SwapStep[] memory s2 = new SwapExecutor.SwapStep[](1);
        s2[0] = _slipStep(address(slip), address(tokenA), address(tokenB), 100);

        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](2);
        parts[0] = SwapExecutor.RoutePart({steps: s1, amountIn: 60 ether});
        parts[1] = SwapExecutor.RoutePart({steps: s2, amountIn: 40 ether});

        vm.prank(user);
        uint256 out = exec.executeSwap(address(tokenA), address(tokenB), 100 ether, 0,
                                       parts, block.timestamp + 60);
        assertEq(out, 200 ether, "both the V3 leg and the Slipstream leg must land");
    }

    function testSlipstreamMultiHop() public {
        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](2);
        steps[0] = _v3Step(address(v3), address(tokenA), address(tokenC));
        steps[1] = _slipStep(address(slip), address(tokenC), address(tokenB), 100);

        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: 100 ether});

        vm.prank(user);
        uint256 out = exec.executeSwap(address(tokenA), address(tokenB), 100 ether, 0,
                                       parts, block.timestamp + 60);
        assertEq(out, 400 ether, "V3 hop then Slipstream hop, rate 2 each");
    }

    // ===================================================================
    // Adapter
    // ===================================================================

    function testAdapterSwapWorks() public {
        uint256 amt = 100 ether;
        SwapExecutor.RoutePart[] memory parts =
            _onePart(_adapterStep(address(adapter), address(tokenA), address(tokenB),
                                  0, 0, false, address(0)), amt);

        vm.expectEmit(true, true, true, true, address(exec));
        emit SwapExecutor.Swapped(user, address(tokenA), address(tokenB), amt, 200 ether, 0);

        vm.prank(user);
        uint256 out = exec.executeSwap(address(tokenA), address(tokenB), amt, 0,
                                       parts, block.timestamp + 60);

        assertEq(out, 200 ether, "adapter mock rate is 2x");
        assertEq(tokenB.balanceOf(user), 200 ether);
    }

    function testAdapterReceivesAllStepFields() public {
        uint256 amt = 33 ether;
        address pf = address(0xF00D);
        SwapExecutor.RoutePart[] memory parts =
            _onePart(_adapterStep(address(adapter), address(tokenA), address(tokenB),
                                  500, 50, true, pf), amt);

        vm.prank(user);
        exec.executeSwap(address(tokenA), address(tokenB), amt, 0, parts, block.timestamp + 60);

        assertEq(adapter.lastTokenIn(), address(tokenA));
        assertEq(adapter.lastTokenOut(), address(tokenB));
        assertEq(adapter.lastAmountIn(), amt);
        assertEq(adapter.lastFeeTier(), uint24(500));
        assertEq(adapter.lastTickSpacing(), int24(50));
        assertEq(adapter.lastStable(), true);
        assertEq(adapter.lastPoolFactory(), pf);
        assertEq(adapter.lastRecipient(), address(exec));
    }

    function testAdapterMustBeWhitelisted() public {
        MockAdapter unlisted = new MockAdapter();
        uint256 amt = 10 ether;
        SwapExecutor.RoutePart[] memory parts =
            _onePart(_adapterStep(address(unlisted), address(tokenA), address(tokenB),
                                  0, 0, false, address(0)), amt);

        vm.prank(user);
        vm.expectRevert(bytes("adapter not allowed"));
        exec.executeSwap(address(tokenA), address(tokenB), amt, 0, parts, block.timestamp + 60);
    }

    /// v3 is on the router whitelist but never on the adapter whitelist.
    function testRouterListDoesNotGrantAdapterRights() public {
        uint256 amt = 10 ether;
        SwapExecutor.RoutePart[] memory parts =
            _onePart(_adapterStep(address(v3), address(tokenA), address(tokenB),
                                  0, 0, false, address(0)), amt);

        vm.prank(user);
        vm.expectRevert(bytes("adapter not allowed"));
        exec.executeSwap(address(tokenA), address(tokenB), amt, 0, parts, block.timestamp + 60);
    }

    /// `adapter` is on the adapter whitelist but never on the router whitelist.
    function testAdapterListDoesNotGrantRouterRights() public {
        uint256 amt = 10 ether;
        SwapExecutor.RoutePart[] memory parts =
            _onePart(_v3Step(address(adapter), address(tokenA), address(tokenB)), amt);

        vm.prank(user);
        vm.expectRevert(bytes("router not allowed"));
        exec.executeSwap(address(tokenA), address(tokenB), amt, 0, parts, block.timestamp + 60);
    }

    function testAdapterNeverReceivesAllowance() public {
        uint256 amt = 10 ether;
        SwapExecutor.RoutePart[] memory parts =
            _onePart(_adapterStep(address(adapter), address(tokenA), address(tokenB),
                                  0, 0, false, address(0)), amt);

        vm.prank(user);
        exec.executeSwap(address(tokenA), address(tokenB), amt, 0, parts, block.timestamp + 60);

        assertEq(tokenA.allowance(address(exec), address(adapter)), 0,
                 "an adapter must never hold a standing allowance");
    }

    function testLazyAdapterReverts() public {
        MockLazyAdapter lazy = new MockLazyAdapter();
        vm.prank(owner);
        exec.setAdapterAllowed(address(lazy), true);

        uint256 amt = 10 ether;
        SwapExecutor.RoutePart[] memory parts =
            _onePart(_adapterStep(address(lazy), address(tokenA), address(tokenB),
                                  0, 0, false, address(0)), amt);

        vm.prank(user);
        vm.expectRevert(bytes("zero step output"));
        exec.executeSwap(address(tokenA), address(tokenB), amt, 0, parts, block.timestamp + 60);
    }

    function testAdapterReentrancyIsBlocked() public {
        MockReentrantAdapter evil = new MockReentrantAdapter();
        vm.prank(owner);
        exec.setAdapterAllowed(address(evil), true);

        uint256 amt = 10 ether;
        SwapExecutor.RoutePart[] memory parts =
            _onePart(_adapterStep(address(evil), address(tokenA), address(tokenB),
                                  0, 0, false, address(0)), amt);

        bytes memory payload = abi.encodeWithSelector(
            exec.executeSwap.selector,
            address(tokenA), address(tokenB), uint256(amt), uint256(0),
            parts, block.timestamp + 60);
        evil.setup(address(exec), payload);

        vm.prank(user);
        vm.expectRevert(bytes("reentrant"));
        exec.executeSwap(address(tokenA), address(tokenB), amt, 0, parts, block.timestamp + 60);
    }

    function testSetAdapterAllowedOnlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert(bytes("not owner"));
        exec.setAdapterAllowed(address(adapter), true);
    }

    function testSetAdaptersAllowedBatchAndEvent() public {
        address a1 = address(0x1111);
        address a2 = address(0x2222);
        address a3 = address(0x3333);
        address[] memory adapters = new address[](3);
        adapters[0] = a1; adapters[1] = a2; adapters[2] = a3;

        vm.expectEmit(true, false, false, true, address(exec));
        emit SwapExecutor.AdapterAllowed(a1, true);
        vm.expectEmit(true, false, false, true, address(exec));
        emit SwapExecutor.AdapterAllowed(a2, true);
        vm.expectEmit(true, false, false, true, address(exec));
        emit SwapExecutor.AdapterAllowed(a3, true);

        vm.prank(owner);
        exec.setAdaptersAllowed(adapters, true);

        assertTrue(exec.allowedAdapter(a1));
        assertTrue(exec.allowedAdapter(a2));
        assertTrue(exec.allowedAdapter(a3));

        vm.prank(owner);
        vm.expectRevert(bytes("zero adapter"));
        exec.setAdapterAllowed(address(0), true);
    }

    function testAdapterInMultiHopWithRouter() public {
        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](2);
        steps[0] = _v3Step(address(v3), address(tokenA), address(tokenC));
        steps[1] = _adapterStep(address(adapter), address(tokenC), address(tokenB),
                                0, 0, false, address(0));

        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: 100 ether});

        vm.prank(user);
        uint256 out = exec.executeSwap(address(tokenA), address(tokenB), 100 ether, 0,
                                       parts, block.timestamp + 60);
        assertEq(out, 400 ether, "router hop then adapter hop, rate 2 each");
    }

    // ===================================================================
    // Kind bounds
    // ===================================================================

    function testKindSixIsRejected() public {
        uint256 amt = 10 ether;
        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](1);
        steps[0] = SwapExecutor.SwapStep({
            kind: 6, router: address(v3), tokenIn: address(tokenA), tokenOut: address(tokenB),
            feeTier: 3000, stable: false, poolFactory: address(0), tickSpacing: 0
        });
        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: amt});

        vm.prank(user);
        vm.expectRevert(bytes("bad kind"));
        exec.executeSwap(address(tokenA), address(tokenB), amt, 0, parts, block.timestamp + 60);
    }
}
