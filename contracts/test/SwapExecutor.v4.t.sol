// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SwapExecutor.sol";
import "./Mocks.sol";

/**
 * The two findings from the 18 Aug 2026 review that touch the contract.
 *
 *   04 (MEDIUM) - the delivered-amount subtraction assumed a passive recipient.
 *                 A contract wallet that sweeps in its receive hook ends the
 *                 call with a balance *below* the recorded one, so the swap died
 *                 with an arithmetic panic (0x11) and no usable message.
 *   08 (INFO)   - rescue / rescueETH left no on-chain trace.
 *
 * The first three tests here MUST fail against the contract *before* the fix:
 * the two panic tests fail with Panic(0x11) and the shortfall test fails with a
 * panic instead of the slippage string. If any of them is green on the old
 * version, that test proves nothing - which is the whole reason this file
 * exists as a separate generation rather than as edits to the v3 file.
 */
contract SwapExecutorV4Test is Test {
    SwapExecutor exec;
    MockERC20 tokenIn;
    MockWETH weth;
    MockV2Router router;              // pays out MockERC20 / MockWETH
    MockHookRouter hookRouter;        // pays out MockHookToken
    MockHookToken hookOut;

    address owner   = address(0xA11CE);
    address feeSink = address(0xFEE5);
    address sink    = address(0x5111);

    function setUp() public {
        weth       = new MockWETH();
        tokenIn    = new MockERC20("In", "IN", 18);
        hookOut    = new MockHookToken();
        router     = new MockV2Router();
        hookRouter = new MockHookRouter();

        exec = new SwapExecutor(owner, feeSink, 0, address(weth));

        address[] memory rs = new address[](2);
        rs[0] = address(router);
        rs[1] = address(hookRouter);
        vm.prank(owner);
        exec.setRoutersAllowed(rs, true);
    }

    function _oneStep(address r, address a, address b)
        internal pure returns (SwapExecutor.SwapStep memory s)
    {
        s.kind = 0;                   // V2
        s.router = r;
        s.tokenIn = a;
        s.tokenOut = b;
    }

    function _onePart(address r, address a, address b, uint256 amount)
        internal pure returns (SwapExecutor.RoutePart[] memory parts)
    {
        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](1);
        steps[0] = _oneStep(r, a, b);
        parts = new SwapExecutor.RoutePart[](1);
        parts[0].steps = steps;
        parts[0].amountIn = amount;
    }

    // =================================================================
    // 04 - native branch
    // =================================================================

    /**
     * The wallet holds 1 ether of its own, then sweeps *everything* out of its
     * receive hook. Balance before the send: 1 ether. After: zero. The old
     * subtraction underflowed there.
     *
     * minAmountOut is 0 because this wallet moved its own funds onward on
     * purpose and is happy with the outcome - the question this test asks is
     * only whether the executor still functions, not whether it should pay out.
     */
    function test_nativeOut_sweepingWalletDoesNotPanic() public {
        SweepingWallet w = new SweepingWallet(sink);
        vm.deal(address(w), 1 ether);              // pre-existing balance
        vm.deal(address(this), 0);

        uint256 amount = 1 ether;
        tokenIn.mint(address(w), amount);

        // the wallet approves and calls from its own account
        w.call(address(tokenIn),
               abi.encodeWithSignature("approve(address,uint256)", address(exec), amount), 0);

        SwapExecutor.RoutePart[] memory parts =
            _onePart(address(router), address(tokenIn), address(weth), amount);

        // the router mints WETH to the executor, which unwraps it
        uint256 out = amount * 2;
        vm.deal(address(weth), out);               // so withdraw() can pay real ETH

        bytes memory data = abi.encodeWithSelector(
            SwapExecutor.executeSwap.selector,
            address(tokenIn), address(0), amount, uint256(0), parts, block.timestamp + 60
        );

        // Before the fix this reverts with Panic(0x11). After it, the call goes
        // through and reports zero delivered.
        bytes memory ret = w.call(address(exec), data, 0);
        uint256 delivered = abi.decode(ret, (uint256));

        assertEq(delivered, 0, "a wallet that swept its own funds should be reported as zero delivered");
        assertEq(sink.balance, 1 ether + out, "the sweep should have taken the payout plus its own balance");
    }

    /// A passive wallet must still be measured exactly as before - the clamp is
    /// not allowed to change the normal path.
    function test_nativeOut_passiveWalletUnchanged() public {
        SweepingWallet w = new SweepingWallet(sink);
        w.setSweeping(false);
        vm.deal(address(w), 1 ether);

        uint256 amount = 1 ether;
        tokenIn.mint(address(w), amount);
        w.call(address(tokenIn),
               abi.encodeWithSignature("approve(address,uint256)", address(exec), amount), 0);

        SwapExecutor.RoutePart[] memory parts =
            _onePart(address(router), address(tokenIn), address(weth), amount);
        uint256 out = amount * 2;
        vm.deal(address(weth), out);

        bytes memory ret = w.call(address(exec), abi.encodeWithSelector(
            SwapExecutor.executeSwap.selector,
            address(tokenIn), address(0), amount, out, parts, block.timestamp + 60), 0);

        assertEq(abi.decode(ret, (uint256)), out, "a passive recipient must be measured exactly");
        assertEq(address(w).balance, 1 ether + out, "the payout should be sitting in the wallet");
    }

    /**
     * The clamp must not weaken the guard. Same sweeping wallet, but this time
     * it asks for a real minimum - it has to fail, and it has to fail with the
     * slippage string rather than an arithmetic panic.
     */
    function test_nativeOut_genuineShortfallStillRevertsWithMessage() public {
        SweepingWallet w = new SweepingWallet(sink);
        vm.deal(address(w), 1 ether);

        uint256 amount = 1 ether;
        tokenIn.mint(address(w), amount);
        w.call(address(tokenIn),
               abi.encodeWithSignature("approve(address,uint256)", address(exec), amount), 0);

        SwapExecutor.RoutePart[] memory parts =
            _onePart(address(router), address(tokenIn), address(weth), amount);
        uint256 out = amount * 2;
        vm.deal(address(weth), out);

        vm.expectRevert(bytes("slippage: output below minimum"));
        w.call(address(exec), abi.encodeWithSelector(
            SwapExecutor.executeSwap.selector,
            address(tokenIn), address(0), amount, out, parts, block.timestamp + 60), 0);
    }

    // =================================================================
    // 04 - ERC-20 branch, same shape via a recipient hook
    // =================================================================

    function test_tokenOut_hookWalletDoesNotPanic() public {
        SweepingTokenWallet w = new SweepingTokenWallet(sink);
        hookOut.setHooked(address(w), true);
        hookOut.mint(address(w), 5 ether);          // pre-existing balance

        uint256 amount = 1 ether;
        tokenIn.mint(address(w), amount);
        w.call(address(tokenIn),
               abi.encodeWithSignature("approve(address,uint256)", address(exec), amount), 0);

        SwapExecutor.RoutePart[] memory parts =
            _onePart(address(hookRouter), address(tokenIn), address(hookOut), amount);

        bytes memory ret = w.call(address(exec), abi.encodeWithSelector(
            SwapExecutor.executeSwap.selector,
            address(tokenIn), address(hookOut), amount, uint256(0), parts,
            block.timestamp + 60), 0);

        assertEq(abi.decode(ret, (uint256)), 0,
                 "the hook moved the balance onward, so delivered is zero, not an underflow");
        assertEq(hookOut.balanceOf(sink), 5 ether + amount * 2,
                 "the sweep should hold the payout plus what the wallet already had");
    }

    function test_tokenOut_passiveRecipientUnchanged() public {
        SweepingTokenWallet w = new SweepingTokenWallet(sink);
        // deliberately NOT hooked: the ordinary path must be untouched
        hookOut.mint(address(w), 5 ether);

        uint256 amount = 1 ether;
        tokenIn.mint(address(w), amount);
        w.call(address(tokenIn),
               abi.encodeWithSignature("approve(address,uint256)", address(exec), amount), 0);

        SwapExecutor.RoutePart[] memory parts =
            _onePart(address(hookRouter), address(tokenIn), address(hookOut), amount);

        bytes memory ret = w.call(address(exec), abi.encodeWithSelector(
            SwapExecutor.executeSwap.selector,
            address(tokenIn), address(hookOut), amount, amount * 2, parts,
            block.timestamp + 60), 0);

        assertEq(abi.decode(ret, (uint256)), amount * 2, "passive recipient must be measured exactly");
    }

    // =================================================================
    // 08 - owner withdrawals must be observable
    // =================================================================

    function test_rescueEmitsAnEvent() public {
        MockERC20 stray = new MockERC20("Stray", "STR", 18);
        stray.mint(address(exec), 777);

        vm.expectEmit(true, true, false, true, address(exec));
        emit SwapExecutor.Rescued(address(stray), owner, 777);

        vm.prank(owner);
        exec.rescue(address(stray));

        assertEq(stray.balanceOf(owner), 777, "the rescue should still move the tokens");
    }

    function test_rescueETHEmitsAnEvent() public {
        vm.deal(address(exec), 3 ether);

        vm.expectEmit(true, false, false, true, address(exec));
        emit SwapExecutor.RescuedETH(owner, 3 ether);

        vm.prank(owner);
        exec.rescueETH();

        assertEq(owner.balance, 3 ether, "the rescue should still move the ETH");
    }
}
