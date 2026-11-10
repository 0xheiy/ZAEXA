// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SwapExecutor.sol";
import "./Mocks.sol";

/*
 * v6 tests: fee-token allowlist and fee side, fee-skip on a failing fee
 * transfer, and refund of unspent input / intermediate tokens.
 *
 * Every guard added in v6 was broken on purpose once and one of the tests below
 * went red - see the break-test table in the v6 commit message. A test that stays
 * green against the broken guard proves nothing.
 */

/// V2-style router that only spends part of what it is told to - a pool that runs
/// out of depth mid-swap, or a price limit. The rest of the input stays behind
/// in the executor, which is exactly the case v6's refund exists for.
contract MockPartialRouter {
    uint256 public consumeBps = 6000;   // spends 60% of amountIn
    uint256 public rateNum = 2;
    uint256 public rateDen = 1;

    function setConsume(uint256 bps) external { consumeBps = bps; }

    function swapExactTokensForTokens(
        uint256 amountIn, uint256, address[] calldata path, address to, uint256
    ) external returns (uint256[] memory amounts) {
        uint256 used = amountIn * consumeBps / 10_000;
        MockERC20(path[0]).transferFrom(msg.sender, address(this), used);
        uint256 out = used * rateNum / rateDen;
        MockERC20(path[path.length - 1]).mint(to, out);
        amounts = new uint256[](2);
        amounts[0] = used;
        amounts[1] = out;
    }
}

/**
 * A token that refuses transfers to blocked addresses - USDC and USDT both keep
 * blacklists, and a blacklisted fee recipient is the realistic way a fee transfer
 * fails. `mode` selects HOW it refuses, because a low-level call has to survive
 * all of them:
 *   0 = revert, 1 = return false, 2 = return a non-bool word (2), 3 = return 1 byte
 *   4 = MOVE the funds, then return false (lies about failure)
 *   5 = burn all gas it is given
 *   6 = succeed, then return ~200 KB of data
 */
contract MockBlockingToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;
    uint8 public mode;

    function setBlocked(address who, bool v) external { blocked[who] = v; }
    function setMode(uint8 m) external { mode = m; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a; return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        if (blocked[to] && mode >= 4) {
            require(balanceOf[msg.sender] >= a, "insufficient");
            if (mode == 5) { while (true) {} }
            balanceOf[msg.sender] -= a; balanceOf[to] += a;
            if (mode == 4) return false;
            assembly { mstore(0, 1) return(0, 200000) }
        }
        if (blocked[to]) {
            if (mode == 0) revert("blocked");
            if (mode == 1) return false;
            if (mode == 2) assembly { mstore(0, 2) return(0, 32) }
            assembly { mstore(0, 0) return(0, 1) }
        }
        require(balanceOf[msg.sender] >= a, "insufficient");
        balanceOf[msg.sender] -= a; balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(balanceOf[f] >= a, "insufficient");
        uint256 al = allowance[f][msg.sender];
        require(al >= a, "not allowed");
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a; balanceOf[t] += a;
        return true;
    }
}

/// A contract wallet that records, from inside a refund's token hook, how much of the
/// output it already held - so a test can prove the output was delivered BEFORE any
/// refund ran (settlement order).
contract OrderProbeWallet is ITokenReceiver {
    address public outToken;
    uint256 public outAtRefund = type(uint256).max;
    bool public sawRefund;

    constructor(address _out) { outToken = _out; }

    function onTokenReceived(address, uint256) external {
        sawRefund = true;
        outAtRefund = MockERC20(outToken).balanceOf(address(this));
    }
    function approve(address token, address spender) external {
        MockERC20(token).approve(spender, type(uint256).max);
    }
    function call(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) { assembly { revert(add(ret, 0x20), mload(ret)) } }
        return ret;
    }
}

contract SwapExecutorV6Test is Test {
    SwapExecutor exec;
    MockERC20 usdc;        // allowlisted fee token (passed to the constructor)
    MockERC20 meme;        // unknown token - not a fee token
    MockERC20 mid;         // intermediate / second unknown token
    MockWETH weth;
    MockV2Router v2;       // rate 2, spends everything
    MockPartialRouter partialR;

    address owner = address(0xA11CE);
    address user  = address(0xB0B);
    address feeTo = address(0xFEE);

    event Swapped(
        address indexed user, address indexed tokenIn, address indexed tokenOut,
        uint256 amountIn, uint256 amountOut, uint256 fee, address feeToken
    );
    event FeeTokenSet(address indexed token, bool allowed);
    event FeeSkipped(address indexed token, address indexed recipient, uint256 amount);
    event Refunded(address indexed token, uint256 amount);
    event FeeTaken(address indexed token, address indexed recipient, uint256 amount);

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 18);
        meme = new MockERC20("Meme", "MEME", 18);
        mid  = new MockERC20("Mid", "MID", 18);
        weth = new MockWETH();
        vm.deal(address(weth), 1_000_000 ether);
        v2 = new MockV2Router();
        partialR = new MockPartialRouter();

        address[] memory ft = new address[](1);
        ft[0] = address(usdc);
        exec = new SwapExecutor(owner, feeTo, 100, address(weth), ft);   // 1% fee

        vm.startPrank(owner);
        exec.setRouterAllowed(address(v2), true);
        exec.setRouterAllowed(address(partialR), true);
        vm.stopPrank();

        usdc.mint(user, 1_000_000 ether);
        meme.mint(user, 1_000_000 ether);
        mid.mint(user, 1_000_000 ether);
        vm.startPrank(user);
        usdc.approve(address(exec), type(uint256).max);
        meme.approve(address(exec), type(uint256).max);
        mid.approve(address(exec), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers
    function _st(address r, address a, address b) internal pure returns (SwapExecutor.SwapStep memory) {
        return SwapExecutor.SwapStep({kind: 0, router: r, tokenIn: a, tokenOut: b,
            feeTier: 0, stable: false, poolFactory: address(0), tickSpacing: 0});
    }
    function _one(address r, address a, address b, uint256 amt)
        internal pure returns (SwapExecutor.RoutePart[] memory parts)
    {
        SwapExecutor.SwapStep[] memory s = new SwapExecutor.SwapStep[](1);
        s[0] = _st(r, a, b);
        parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: s, amountIn: amt});
    }
    function _two(address r1, address r2, address a, address b, address c, uint256 amt)
        internal pure returns (SwapExecutor.RoutePart[] memory parts)
    {
        SwapExecutor.SwapStep[] memory s = new SwapExecutor.SwapStep[](2);
        s[0] = _st(r1, a, b);
        s[1] = _st(r2, b, c);
        parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: s, amountIn: amt});
    }
    function _swap(address tin, address tout, uint256 amt, uint256 minOut,
                   SwapExecutor.RoutePart[] memory parts) internal returns (uint256) {
        vm.prank(user);
        return exec.executeSwap(tin, tout, amt, minOut, parts, block.timestamp + 60);
    }
    function _countEvents(bytes32 topic) internal returns (uint256 n) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(exec) && logs[i].topics[0] == topic) n++;
        }
    }

    // ==================================================================
    // 1) Fee side
    // ==================================================================

    /// Buy: input is a fee token -> fee from the input (as v5).
    function testBuyTakesFeeFromInput() public {
        vm.expectEmit(true, true, true, true, address(exec));
        emit Swapped(user, address(usdc), address(meme), 1000 ether, 1980 ether, 10 ether, address(usdc));
        uint256 out = _swap(address(usdc), address(meme), 1000 ether, 1980 ether,
                            _one(address(v2), address(usdc), address(meme), 1000 ether));
        assertEq(out, 1980 ether);
        assertEq(usdc.balanceOf(feeTo), 10 ether, "1% of the input");
        assertEq(meme.balanceOf(feeTo), 0, "no fee in the unknown token");
        assertEq(meme.balanceOf(user), 1_000_000 ether + 1980 ether);
    }

    /// Sell: input unknown, output a fee token -> fee from the output.
    function testSellTakesFeeFromOutput() public {
        uint256 usdcBefore = usdc.balanceOf(user);
        vm.expectEmit(true, true, true, true, address(exec));
        emit Swapped(user, address(meme), address(usdc), 1000 ether, 1980 ether, 20 ether, address(usdc));
        uint256 out = _swap(address(meme), address(usdc), 1000 ether, 0,
                            _one(address(v2), address(meme), address(usdc), 1000 ether));
        assertEq(out, 1980 ether, "2000 out minus 1%");
        assertEq(usdc.balanceOf(feeTo), 20 ether, "fee is 1% of the output");
        assertEq(meme.balanceOf(feeTo), 0, "nothing taken in the unknown token");
        assertEq(usdc.balanceOf(user) - usdcBefore, 1980 ether);
        assertEq(usdc.balanceOf(address(exec)), 0);
        assertEq(meme.balanceOf(address(exec)), 0);
    }

    /// minAmountOut is checked against what the user receives, net of the output fee:
    /// exactly the net amount passes...
    function testSellMinOutNetOfFeeExactBoundaryPasses() public {
        uint256 out = _swap(address(meme), address(usdc), 1000 ether, 1980 ether,
                            _one(address(v2), address(meme), address(usdc), 1000 ether));
        assertEq(out, 1980 ether);
    }

    /// ...and one wei more fails, even though the contract itself received 2000.
    function testSellMinOutNetOfFeeOneWeiAboveFails() public {
        SwapExecutor.RoutePart[] memory p = _one(address(v2), address(meme), address(usdc), 1000 ether);
        vm.prank(user);
        vm.expectRevert(bytes("slippage: output below minimum"));
        exec.executeSwap(address(meme), address(usdc), 1000 ether, 1980 ether + 1, p, block.timestamp + 60);
    }

    /// Output fee token that also charges a transfer tax: the check is net of both.
    function testSellMinOutNetOfFeeAndTransferTax() public {
        MockFeeToken taxed = new MockFeeToken(500);               // 5% tax
        vm.prank(owner);
        exec.setFeeToken(address(taxed), true);

        // contract receives 2000; fee 20 (feeTo gets 19); user is sent 1980, receives 1881
        uint256 net = 1881 ether;
        SwapExecutor.RoutePart[] memory p = _one(address(v2), address(meme), address(taxed), 1000 ether);
        vm.prank(user);
        vm.expectRevert(bytes("slippage: output below minimum"));
        exec.executeSwap(address(meme), address(taxed), 1000 ether, net + 1, p, block.timestamp + 60);

        uint256 out = _swap(address(meme), address(taxed), 1000 ether, net, p);
        assertEq(out, net);
        assertEq(taxed.balanceOf(user), net);
        assertEq(taxed.balanceOf(feeTo), 19 ether);
    }

    /// token -> token, neither allowlisted -> fee from the input (v5 behaviour).
    function testTokenToTokenFallsBackToInputFee() public {
        vm.expectEmit(true, true, true, true, address(exec));
        emit Swapped(user, address(meme), address(mid), 1000 ether, 1980 ether, 10 ether, address(meme));
        _swap(address(meme), address(mid), 1000 ether, 0,
              _one(address(v2), address(meme), address(mid), 1000 ether));
        assertEq(meme.balanceOf(feeTo), 10 ether);
        assertEq(mid.balanceOf(feeTo), 0);
    }

    /// Both sides are fee tokens -> the input wins.
    function testBothFeeTokensUsesInput() public {
        _swap(address(usdc), address(weth), 1000 ether, 0,
              _one(address(v2), address(usdc), address(weth), 1000 ether));
        assertEq(usdc.balanceOf(feeTo), 10 ether);
        assertEq(weth.balanceOf(feeTo), 0);
    }

    // ==================================================================
    // 2) Allowlist administration
    // ==================================================================

    function testSetFeeTokenOnlyOwnerAndEmits() public {
        vm.prank(user);
        vm.expectRevert(bytes("not owner"));
        exec.setFeeToken(address(meme), true);

        vm.expectEmit(true, false, false, true, address(exec));
        emit FeeTokenSet(address(meme), true);
        vm.prank(owner);
        exec.setFeeToken(address(meme), true);
        assertTrue(exec.feeToken(address(meme)));

        vm.expectEmit(true, false, false, true, address(exec));
        emit FeeTokenSet(address(meme), false);
        vm.prank(owner);
        exec.setFeeToken(address(meme), false);
        assertFalse(exec.feeToken(address(meme)));
    }

    function testWethAlwaysFeeTokenAndCannotBeRemoved() public {
        assertTrue(exec.feeToken(address(weth)));
        vm.prank(owner);
        vm.expectRevert(bytes("weth is always a fee token"));
        exec.setFeeToken(address(weth), false);
        vm.prank(owner);
        vm.expectRevert(bytes("zero token"));
        exec.setFeeToken(address(0), true);
    }

    function testConstructorSeedsListAndEmits() public {
        address[] memory ft = new address[](2);
        ft[0] = address(usdc);
        ft[1] = address(mid);
        vm.expectEmit(true, false, false, true);
        emit FeeTokenSet(address(weth), true);
        vm.expectEmit(true, false, false, true);
        emit FeeTokenSet(address(usdc), true);
        vm.expectEmit(true, false, false, true);
        emit FeeTokenSet(address(mid), true);
        SwapExecutor e = new SwapExecutor(owner, feeTo, 0, address(weth), ft);
        assertTrue(e.feeToken(address(weth)) && e.feeToken(address(usdc)) && e.feeToken(address(mid)));
        assertFalse(e.feeToken(address(meme)));

        ft[1] = address(0);
        vm.expectRevert(bytes("zero token"));
        new SwapExecutor(owner, feeTo, 0, address(weth), ft);
    }

    // ==================================================================
    // 3) A failing fee transfer never blocks the swap
    // ==================================================================

    function _blockingSetup(uint8 mode) internal returns (MockBlockingToken b) {
        b = new MockBlockingToken();
        b.setMode(mode);
        b.setBlocked(feeTo, true);
        b.mint(user, 1_000_000 ether);
        vm.prank(user);
        b.approve(address(exec), type(uint256).max);
        vm.prank(owner);
        exec.setFeeToken(address(b), true);
    }

    /// Input side: fee recipient refuses -> swap succeeds, whole input is swapped.
    function _checkInputSideSkip(uint8 mode) internal {
        MockBlockingToken b = _blockingSetup(mode);
        vm.expectEmit(true, true, false, true, address(exec));
        emit FeeSkipped(address(b), feeTo, 10 ether);
        uint256 out = _swap(address(b), address(meme), 1000 ether, 2000 ether,
                            _one(address(v2), address(b), address(meme), 1000 ether));
        assertEq(out, 2000 ether, "user gets the fee's worth too");
        assertEq(b.balanceOf(feeTo), 0);
        assertEq(b.balanceOf(address(exec)), 0, "skipped fee must not stay in the contract");
    }

    /// Output side: fee recipient refuses -> swap succeeds, user gets the full output.
    function _checkOutputSideSkip(uint8 mode) internal {
        MockBlockingToken b = _blockingSetup(mode);
        uint256 before = b.balanceOf(user);
        vm.expectEmit(true, true, false, true, address(exec));
        emit FeeSkipped(address(b), feeTo, 20 ether);
        uint256 out = _swap(address(meme), address(b), 1000 ether, 2000 ether,
                            _one(address(v2), address(meme), address(b), 1000 ether));
        assertEq(out, 2000 ether);
        assertEq(b.balanceOf(user) - before, 2000 ether);
        assertEq(b.balanceOf(address(exec)), 0);
    }

    function testFeeSkipInputReverting() public { _checkInputSideSkip(0); }
    function testFeeSkipInputReturnsFalse() public { _checkInputSideSkip(1); }
    function testFeeSkipInputBadReturnWord() public { _checkInputSideSkip(2); }
    function testFeeSkipInputShortReturn() public { _checkInputSideSkip(3); }
    function testFeeSkipOutputReverting() public { _checkOutputSideSkip(0); }
    function testFeeSkipOutputReturnsFalse() public { _checkOutputSideSkip(1); }
    function testFeeSkipOutputBadReturnWord() public { _checkOutputSideSkip(2); }
    function testFeeSkipOutputShortReturn() public { _checkOutputSideSkip(3); }

    // ==================================================================
    // 4) Refund of unspent input / intermediate
    // ==================================================================

    /// Router spends 60% -> the other 40% of the swapped amount comes back.
    function testPartialFillRefundsInput() public {
        uint256 before = usdc.balanceOf(user);
        // received 1000, fee 10, swap 990, router spends 594, 396 left
        vm.expectEmit(true, false, false, true, address(exec));
        emit Refunded(address(usdc), 396 ether);
        vm.expectEmit(true, true, true, true, address(exec));
        emit Swapped(user, address(usdc), address(meme), 604 ether, 1188 ether, 10 ether, address(usdc));
        uint256 out = _swap(address(usdc), address(meme), 1000 ether, 0,
                            _one(address(partialR), address(usdc), address(meme), 1000 ether));
        assertEq(out, 1188 ether);
        assertEq(before - usdc.balanceOf(user), 604 ether, "user paid only fee + what was spent");
        assertEq(usdc.balanceOf(address(exec)), 0, "nothing stranded");
    }

    /// Second hop spends 50% of the intermediate -> the intermediate dust comes back.
    function testMultiHopIntermediateDustRefunded() public {
        vm.prank(owner);
        exec.setFee(0);
        partialR.setConsume(5000);
        uint256 midBefore = mid.balanceOf(user);
        // 1000 usdc -> 2000 mid; second hop spends 1000 mid -> 2000 meme; 1000 mid left
        vm.expectEmit(true, false, false, true, address(exec));
        emit Refunded(address(mid), 1000 ether);
        uint256 out = _swap(address(usdc), address(meme), 1000 ether, 0,
            _two(address(v2), address(partialR), address(usdc), address(mid), address(meme), 1000 ether));
        assertEq(out, 2000 ether);
        assertEq(mid.balanceOf(user) - midBefore, 1000 ether);
        assertEq(mid.balanceOf(address(exec)), 0);
        assertEq(usdc.balanceOf(address(exec)), 0);
    }

    /// Balances the contract held before the call are never refunded or counted.
    function testPreExistingBalancesAreNotRefunded() public {
        vm.prank(owner);
        exec.setFee(0);
        partialR.setConsume(5000);
        usdc.mint(address(exec), 7 ether);    // stuck input-token dust
        mid.mint(address(exec), 5 ether);     // stuck intermediate dust
        uint256 usdcBefore = usdc.balanceOf(user);
        uint256 midBefore = mid.balanceOf(user);

        _swap(address(usdc), address(meme), 1000 ether, 0,
            _two(address(v2), address(partialR), address(usdc), address(mid), address(meme), 1000 ether));

        assertEq(usdcBefore - usdc.balanceOf(user), 1000 ether, "no input refund: all of it was spent");
        assertEq(mid.balanceOf(user) - midBefore, 1000 ether, "only the dust THIS call made");
        assertEq(usdc.balanceOf(address(exec)), 7 ether, "pre-existing input dust stays");
        assertEq(mid.balanceOf(address(exec)), 5 ether, "pre-existing intermediate dust stays");
    }

    /// A full fill with pre-existing dust emits no Refunded at all.
    function testFullFillWithDustEmitsNoRefund() public {
        usdc.mint(address(exec), 7 ether);
        vm.recordLogs();
        _swap(address(usdc), address(meme), 1000 ether, 0,
              _one(address(v2), address(usdc), address(meme), 1000 ether));
        assertEq(_countEvents(Refunded.selector), 0, "nothing to refund");
        assertEq(usdc.balanceOf(address(exec)), 7 ether);
    }

    // ==================================================================
    // 5) Loop route still works
    // ==================================================================

    /// Loop route with a partial first hop: the unspent input IS output-token, so it is
    /// delivered as output (not refunded); pre-existing dust is still untouched.
    function testLoopRouteUnspentInputIsDeliveredNotRefunded() public {
        usdc.mint(address(exec), 3 ether);
        uint256 before = usdc.balanceOf(user);
        // received 1000, fee 10 (usdc is a fee token: input side), swap 990
        // hop 1 spends 594 -> 1188 meme; hop 2 -> 2376 usdc; 396 unspent usdc
        vm.recordLogs();
        uint256 out = _swap(address(usdc), address(usdc), 1000 ether, 0,
            _two(address(partialR), address(v2), address(usdc), address(meme), address(usdc), 1000 ether));
        assertEq(_countEvents(Refunded.selector), 0, "output token is never 'leftover'");
        assertEq(out, 2376 ether + 396 ether);
        assertEq(usdc.balanceOf(user), before - 1000 ether + out);
        assertEq(usdc.balanceOf(address(exec)), 3 ether, "dust must survive a loop route");
        assertEq(meme.balanceOf(address(exec)), 0);
    }

    /// Loop route whose second hop leaves intermediate dust: that dust IS refunded.
    function testLoopRouteIntermediateDustRefunded() public {
        vm.prank(owner);
        exec.setFee(0);
        partialR.setConsume(5000);
        uint256 memeBefore = meme.balanceOf(user);
        // 1000 usdc -> 2000 meme; hop 2 spends 1000 meme -> 2000 usdc; 1000 meme left
        vm.expectEmit(true, false, false, true, address(exec));
        emit Refunded(address(meme), 1000 ether);
        uint256 out = _swap(address(usdc), address(usdc), 1000 ether, 0,
            _two(address(v2), address(partialR), address(usdc), address(meme), address(usdc), 1000 ether));
        assertEq(out, 2000 ether);
        assertEq(meme.balanceOf(user) - memeBefore, 1000 ether);
        assertEq(meme.balanceOf(address(exec)), 0);
    }

    // ==================================================================
    // 6) Native ETH
    // ==================================================================

    /// ETH in (WETH is a fee token -> input side); partial fill refunds WETH as WETH.
    function testNativeInFeeFromInputAndWethRefund() public {
        vm.deal(user, 10 ether);
        // received 10, fee 0.1 WETH, swap 9.9, router spends 5.94, 3.96 WETH refunded
        vm.expectEmit(true, false, false, true, address(exec));
        emit Refunded(address(weth), 3.96 ether);
        vm.prank(user);
        uint256 out = exec.executeSwap{value: 10 ether}(address(0), address(meme), 10 ether, 0,
            _one(address(partialR), address(weth), address(meme), 10 ether), block.timestamp + 60);
        assertEq(out, 11.88 ether);
        assertEq(user.balance, 0);
        assertEq(weth.balanceOf(user), 3.96 ether, "unspent ETH comes back as WETH");
        assertEq(weth.balanceOf(feeTo), 0.1 ether, "fee paid in WETH");
        assertEq(weth.balanceOf(address(exec)), 0);
        assertEq(address(exec).balance, 0);
    }

    /// ETH out (meme is not a fee token, WETH is -> output side); fee stays WETH,
    /// the user gets real ETH net of the fee, and minAmountOut is net of it.
    function testNativeOutFeeFromOutput() public {
        SwapExecutor.RoutePart[] memory p = _one(address(v2), address(meme), address(weth), 10 ether);
        vm.prank(user);
        vm.expectRevert(bytes("slippage: output below minimum"));
        exec.executeSwap(address(meme), address(0), 10 ether, 19.8 ether + 1, p, block.timestamp + 60);

        vm.expectEmit(true, true, true, true, address(exec));
        emit Swapped(user, address(meme), address(0), 10 ether, 19.8 ether, 0.2 ether, address(weth));
        vm.prank(user);
        uint256 out = exec.executeSwap(address(meme), address(0), 10 ether, 19.8 ether, p, block.timestamp + 60);
        assertEq(out, 19.8 ether);
        assertEq(user.balance, 19.8 ether, "real ETH, net of fee");
        assertEq(weth.balanceOf(feeTo), 0.2 ether, "fee taken as WETH");
        assertEq(weth.balanceOf(address(exec)), 0);
        assertEq(address(exec).balance, 0);
    }

    // ==================================================================
    // 7) Audit round 1 - fee point: the fee is charged at each leg's first
    //    fee-token hop, so value cannot leave fee-free as a "refund"
    // ==================================================================

    /// The audit's scenario: unknown -> USDC (real pool) -> junk through a dust pool
    /// that spends 0.01%. v6-draft charged 1% of the unknown input and returned the
    /// USDC fee-free. Now 1% of the USDC is taken at the USDC hop - once: the USDC
    /// refund is not charged again, and nothing is taken in the unknown input.
    function testAuditBypassFeeTakenAtFirstFeeTokenHop() public {
        partialR.setConsume(1);                                  // 0.01%
        uint256 usdcBefore = usdc.balanceOf(user);
        _swap(address(meme), address(mid), 1000 ether, 0,
              _two(address(v2), address(partialR), address(meme), address(usdc), address(mid), 1000 ether));
        // hop 1: 2000 USDC, fee 20, 1980 in flight; hop 2 spends 0.198
        assertEq(usdc.balanceOf(feeTo), 20 ether, "fee in USDC, on the full USDC amount");
        assertEq(meme.balanceOf(feeTo), 0, "no fee in the unknown input");
        assertEq(mid.balanceOf(feeTo), 0, "no fee in the junk output");
        assertEq(usdc.balanceOf(user) - usdcBefore, 1979.802 ether, "refund is not charged twice");
        assertEq(usdc.balanceOf(address(exec)), 0);
    }

    /// Same trick on a sell into WETH: v6-draft charged only the dust-sized WETH output.
    function testAuditBypassSellToWethViaUsdcDust() public {
        partialR.setConsume(1);
        _swap(address(meme), address(weth), 1000 ether, 0,
              _two(address(v2), address(partialR), address(meme), address(usdc), address(weth), 1000 ether));
        assertEq(usdc.balanceOf(feeTo), 20 ether, "fee at the first fee-token hop");
        assertEq(weth.balanceOf(feeTo), 0, "not charged a second time on the output");
    }

    /// An intermediate that was swapped BEFORE its leg's fee point and is left over
    /// would leave uncharged, in an unvetted token: the swap reverts instead.
    function testLeftoverBeforeFeePointReverts() public {
        partialR.setConsume(5000);
        SwapExecutor.RoutePart[] memory p =
            _two(address(v2), address(partialR), address(meme), address(mid), address(usdc), 1000 ether);
        vm.prank(user);
        vm.expectRevert(bytes("leftover before fee point"));
        exec.executeSwap(address(meme), address(usdc), 1000 ether, 0, p, block.timestamp + 60);
    }

    /// Split order whose legs resolve to different fee tokens: leg A pays in USDC at its
    /// USDC hop, leg B (no fee token at all) pays from its input share. Swapped reports
    /// feeToken 0 / fee 0 and the FeeTaken events carry the breakdown.
    function testMixedFeeTokensAcrossLegs() public {
        SwapExecutor.SwapStep[] memory a = new SwapExecutor.SwapStep[](2);
        a[0] = _st(address(v2), address(meme), address(usdc));
        a[1] = _st(address(v2), address(usdc), address(mid));
        SwapExecutor.SwapStep[] memory b = new SwapExecutor.SwapStep[](1);
        b[0] = _st(address(v2), address(meme), address(mid));
        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](2);
        parts[0] = SwapExecutor.RoutePart({steps: a, amountIn: 600 ether});
        parts[1] = SwapExecutor.RoutePart({steps: b, amountIn: 400 ether});

        vm.expectEmit(true, true, false, true, address(exec));
        emit FeeTaken(address(usdc), feeTo, 12 ether);
        vm.expectEmit(true, true, false, true, address(exec));
        emit FeeTaken(address(meme), feeTo, 4 ether);
        vm.expectEmit(true, true, true, true, address(exec));
        emit Swapped(user, address(meme), address(mid), 1000 ether, 3168 ether, 0, address(0));
        uint256 out = _swap(address(meme), address(mid), 1000 ether, 0, parts);
        assertEq(out, 3168 ether);   // A: 1188 USDC -> 2376; B: 396 -> 792
    }

    /// Loop route through a fee token: fee in USDC in flight; loop accounting intact.
    function testLoopRouteThroughFeeTokenInFlight() public {
        meme.mint(address(exec), 3 ether);                       // dust must survive
        vm.expectEmit(true, true, true, true, address(exec));
        emit Swapped(user, address(meme), address(meme), 1000 ether, 3960 ether, 20 ether, address(usdc));
        uint256 out = _swap(address(meme), address(meme), 1000 ether, 0,
            _two(address(v2), address(v2), address(meme), address(usdc), address(meme), 1000 ether));
        assertEq(out, 3960 ether);
        assertEq(meme.balanceOf(address(exec)), 3 ether);
        assertEq(usdc.balanceOf(address(exec)), 0);
    }

    // ==================================================================
    // 8) Audit round 1 - the fee is measured by balance delta, gas-capped,
    //    and copies no return data
    // ==================================================================

    function _lying() internal returns (MockBlockingToken l) {
        l = _blockingSetup(4);                // moves the fee, then returns false
        l.mint(address(exec), 50 ether);      // pre-existing dust the route must not eat
    }

    /// A token that moves the fee but returns false: the fee counts as taken, so the
    /// route spends only what the contract really holds and the dust is untouched.
    function testFeeMovedButReturnedFalseIsCounted() public {
        MockBlockingToken l = _lying();
        vm.expectEmit(true, true, false, true, address(exec));
        emit FeeTaken(address(l), feeTo, 10 ether);
        uint256 out = _swap(address(l), address(meme), 1000 ether, 0,
                            _one(address(v2), address(l), address(meme), 1000 ether));
        assertEq(out, 1980 ether, "990 routed, not 1000");
        assertEq(l.balanceOf(address(exec)), 50 ether, "dust must not fund the route");
        assertEq(l.balanceOf(feeTo), 10 ether);
    }

    /// Same token on a loop route: the loop base must use the measured fee.
    function testFeeMovedButReturnedFalseLoopBase() public {
        MockBlockingToken l = _lying();
        uint256 out = _swap(address(l), address(l), 1000 ether, 0,
            _two(address(v2), address(v2), address(l), address(meme), address(l), 1000 ether));
        assertEq(out, 3960 ether, "990 -> 1980 -> 3960");
        assertEq(l.balanceOf(address(exec)), 50 ether);
    }

    /// A token that burns all gas on the fee transfer: the call is capped, the fee is
    /// skipped, and the swap completes within an ordinary gas limit.
    function testGasBurningFeeTransferIsCapped() public {
        MockBlockingToken g = _blockingSetup(5);
        SwapExecutor.RoutePart[] memory p = _one(address(v2), address(g), address(meme), 1000 ether);
        vm.expectEmit(true, true, false, true, address(exec));
        emit FeeSkipped(address(g), feeTo, 10 ether);
        vm.prank(user);
        uint256 out = exec.executeSwap{gas: 3_000_000}(address(g), address(meme), 1000 ether, 0,
                                                       p, block.timestamp + 60);
        assertEq(out, 2000 ether);
    }

    /// A token that returns ~200 KB from the fee transfer: none of it is copied, so the
    /// swap costs no more than the token's own (capped) work.
    function testHugeReturnDataIsNotCopied() public {
        MockBlockingToken h = _blockingSetup(6);
        MockBlockingToken plain = _blockingSetup(6);
        plain.setBlocked(feeTo, false);                          // same token, normal transfer
        SwapExecutor.RoutePart[] memory ph = _one(address(v2), address(h), address(meme), 1000 ether);
        SwapExecutor.RoutePart[] memory pp = _one(address(v2), address(plain), address(meme), 1000 ether);

        vm.prank(user);
        uint256 g0 = gasleft();
        exec.executeSwap(address(plain), address(meme), 1000 ether, 0, pp, block.timestamp + 60);
        uint256 base = g0 - gasleft();

        vm.prank(user);
        g0 = gasleft();
        exec.executeSwap(address(h), address(meme), 1000 ether, 0, ph, block.timestamp + 60);
        uint256 used = g0 - gasleft();
        // the token's own 200 KB costs it ~95k inside the cap; copying it would cost
        // the executor another ~110k on top
        assertLt(used - base, 150_000, "return data was copied into the executor's memory");
        assertEq(h.balanceOf(feeTo), 10 ether, "the fee itself still went through");
    }

    // ==================================================================
    // 9) Settlement order and refund failure
    // ==================================================================

    /// Output is delivered before any refund runs: a refund hook already sees it.
    function testOutputDeliveredBeforeRefunds() public {
        OrderProbeWallet w = new OrderProbeWallet(address(meme));
        MockHookToken hook = new MockHookToken();
        hook.setHooked(address(w), true);
        usdc.mint(address(w), 1000 ether);
        w.approve(address(usdc), address(exec));
        partialR.setConsume(5000);

        SwapExecutor.RoutePart[] memory p =
            _two(address(v2), address(partialR), address(usdc), address(hook), address(meme), 1000 ether);
        w.call(address(exec), abi.encodeCall(exec.executeSwap,
            (address(usdc), address(meme), 1000 ether, 0, p, block.timestamp + 60)));
        // received 1000, fee 10, 990 -> 1980 HOOK; half spent -> 1980 MEME; 990 HOOK back
        assertTrue(w.sawRefund(), "a refund must have happened");
        assertEq(w.outAtRefund(), 1980 ether, "output must already be delivered when the refund lands");
        assertEq(hook.balanceOf(address(w)), 990 ether);
    }

    /// A refund that cannot be delivered reverts the whole swap - intended: the
    /// user's own money is never silently kept.
    function testRefundFailureRevertsWholeSwap() public {
        MockBlockingToken blk = new MockBlockingToken();
        blk.setBlocked(user, true);                               // mode 0: revert
        partialR.setConsume(5000);
        uint256 before = usdc.balanceOf(user);
        SwapExecutor.RoutePart[] memory p =
            _two(address(v2), address(partialR), address(usdc), address(blk), address(meme), 1000 ether);
        vm.prank(user);
        vm.expectRevert(bytes("transfer failed"));
        exec.executeSwap(address(usdc), address(meme), 1000 ether, 0, p, block.timestamp + 60);
        assertEq(usdc.balanceOf(user), before);
    }

    // ==================================================================
    // 10) Missing coverage from the audit
    // ==================================================================

    /// The input token reappears mid-route (A->B->A->C) and the last hop under-spends:
    /// the A refund exceeds what arrived, so "consumed" clamps to 0 instead of panicking.
    /// (On a loop route the input cannot appear mid-route: with at most 3 steps and no
    /// same-token step, A->B->A->? cannot end at A.)
    function testInputMidRouteRefundClampsConsumedToZero() public {
        vm.prank(owner);
        exec.setFee(0);
        MockERC20 junk = new MockERC20("Junk", "J", 18);
        partialR.setConsume(1000);                                // 10%
        SwapExecutor.SwapStep[] memory st = new SwapExecutor.SwapStep[](3);
        st[0] = _st(address(v2), address(meme), address(mid));
        st[1] = _st(address(v2), address(mid), address(meme));
        st[2] = _st(address(partialR), address(meme), address(junk));
        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: st, amountIn: 1000 ether});

        uint256 before = meme.balanceOf(user);
        vm.expectEmit(true, false, false, true, address(exec));
        emit Refunded(address(meme), 3600 ether);
        vm.expectEmit(true, true, true, true, address(exec));
        emit Swapped(user, address(meme), address(junk), 0, 800 ether, 0, address(meme));
        uint256 out = _swap(address(meme), address(junk), 1000 ether, 0, parts);
        assertEq(out, 800 ether);
        assertEq(meme.balanceOf(user) - before, 2600 ether);     // -1000 in, +3600 back
        assertEq(meme.balanceOf(address(exec)), 0);
    }

    /// Multi-part sell into a fee token: each leg pays at its last hop; one fee token,
    /// so Swapped reports the total; minAmountOut is net of it at the exact boundary.
    function testMultiPartOutputSideFee() public {
        MockV2Router v2b = new MockV2Router();
        v2b.setRate(3, 1);
        vm.prank(owner);
        exec.setRouterAllowed(address(v2b), true);
        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](2);
        SwapExecutor.SwapStep[] memory a = new SwapExecutor.SwapStep[](1);
        a[0] = _st(address(v2), address(meme), address(usdc));
        SwapExecutor.SwapStep[] memory b = new SwapExecutor.SwapStep[](1);
        b[0] = _st(address(v2b), address(meme), address(usdc));
        parts[0] = SwapExecutor.RoutePart({steps: a, amountIn: 600 ether});
        parts[1] = SwapExecutor.RoutePart({steps: b, amountIn: 400 ether});

        vm.prank(user);
        vm.expectRevert(bytes("slippage: output below minimum"));
        exec.executeSwap(address(meme), address(usdc), 1000 ether, 2376 ether + 1, parts, block.timestamp + 60);

        vm.expectEmit(true, true, true, true, address(exec));
        emit Swapped(user, address(meme), address(usdc), 1000 ether, 2376 ether, 24 ether, address(usdc));
        uint256 out = _swap(address(meme), address(usdc), 1000 ether, 2376 ether, parts);
        assertEq(out, 2376 ether);            // (1200 - 12) + (1200 - 12)
        assertEq(usdc.balanceOf(feeTo), 24 ether);
    }

    /// address(0) as an intermediate token: the balance snapshot reverts before any
    /// asset moves.
    function testZeroAddressIntermediateRevertsBeforeAnythingMoves() public {
        uint256 before = meme.balanceOf(user);
        SwapExecutor.RoutePart[] memory p =
            _two(address(v2), address(v2), address(meme), address(0), address(usdc), 1000 ether);
        vm.prank(user);
        vm.expectRevert();
        exec.executeSwap(address(meme), address(usdc), 1000 ether, 0, p, block.timestamp + 60);
        assertEq(meme.balanceOf(user), before);
    }

    // ==================================================================
    // 11) Invariant: every token touched ends where it started in the contract
    // ==================================================================

    function testFuzz_ContractBalancesUnchanged(
        uint8 scen, uint256 amt, uint256 consume, uint64 dust, uint256 fbps
    ) public {
        scen = uint8(bound(scen, 0, 7));
        amt = bound(amt, 1e6, 1e24);
        partialR.setConsume(bound(consume, 1, 10_000));
        vm.prank(owner);
        exec.setFee(bound(fbps, 0, 100));

        address[4] memory toks = [address(usdc), address(meme), address(mid), address(weth)];
        uint256[4] memory before;
        for (uint256 i = 0; i < 4; i++) {
            MockERC20(toks[i]).mint(address(exec), dust);
            before[i] = MockERC20(toks[i]).balanceOf(address(exec));
        }

        _runScenario(scen, amt);

        for (uint256 i = 0; i < 4; i++) {
            assertEq(MockERC20(toks[i]).balanceOf(address(exec)), before[i], "contract balance moved");
        }
        assertEq(address(exec).balance, 0, "contract holds no ETH");
    }

    // split out of the fuzz test for stack depth
    function _runScenario(uint8 scen, uint256 amt) internal {
        if (scen == 0) {          // buy
            _swap(address(usdc), address(meme), amt, 0, _one(address(partialR), address(usdc), address(meme), amt));
        } else if (scen == 1) {   // sell (fee at the last hop)
            _swap(address(meme), address(usdc), amt, 0, _one(address(partialR), address(meme), address(usdc), amt));
        } else if (scen == 2) {   // token -> token (fallback)
            _swap(address(meme), address(mid), amt, 0, _one(address(partialR), address(meme), address(mid), amt));
        } else if (scen == 3) {   // loop
            _swap(address(usdc), address(usdc), amt, 0,
                  _two(address(partialR), address(v2), address(usdc), address(meme), address(usdc), amt));
        } else if (scen == 4) {   // multi-part, one leg partial
            SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](2);
            parts[0] = _one(address(v2), address(usdc), address(meme), amt / 3)[0];
            parts[1] = _one(address(partialR), address(usdc), address(meme), amt - amt / 3)[0];
            _swap(address(usdc), address(meme), amt, 0, parts);
        } else if (scen == 5) {   // multi-hop, partial second hop
            _swap(address(usdc), address(meme), amt, 0,
                  _two(address(v2), address(partialR), address(usdc), address(mid), address(meme), amt));
        } else if (scen == 6) {   // in-flight fee at USDC, partial after it
            _swap(address(meme), address(mid), amt, 0,
                  _two(address(v2), address(partialR), address(meme), address(usdc), address(mid), amt));
        } else {                  // native in
            vm.deal(user, amt);
            vm.prank(user);
            exec.executeSwap{value: amt}(address(0), address(meme), amt, 0,
                _one(address(partialR), address(weth), address(meme), amt), block.timestamp + 60);
        }
    }

    // ==================================================================
    // 12) Audit round 2
    // ==================================================================

    /// Output token produced BEFORE the leg's fee point: A->B in full, B->USDC through a
    /// dust pool (fee point, on a few units), USDC->B. The unspent B from hop 1 would be
    /// delivered as output with the fee charged on dust only - reverts instead.
    function testOutputTokenBeforeFeePointReverts() public {
        partialR.setConsume(1);
        SwapExecutor.SwapStep[] memory st = new SwapExecutor.SwapStep[](3);
        st[0] = _st(address(v2), address(meme), address(mid));
        st[1] = _st(address(partialR), address(mid), address(usdc));
        st[2] = _st(address(v2), address(usdc), address(mid));
        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: st, amountIn: 1000 ether});
        vm.prank(user);
        vm.expectRevert(bytes("output before fee point"));
        exec.executeSwap(address(meme), address(mid), 1000 ether, 0, parts, block.timestamp + 60);
    }

    /// The honest shape the new check must not touch: unknown -> USDC -> unknown.
    function testHonestUnknownToUsdcToTokenUnaffected() public {
        vm.expectEmit(true, true, true, true, address(exec));
        emit Swapped(user, address(meme), address(mid), 1000 ether, 3960 ether, 20 ether, address(usdc));
        uint256 out = _swap(address(meme), address(mid), 1000 ether, 0,
            _two(address(v2), address(v2), address(meme), address(usdc), address(mid), 1000 ether));
        assertEq(out, 3960 ether);
    }

    /// A three-hop loop whose fee point is the middle hop: the output token (= input)
    /// only appears at the end, so the new check must not fire.
    function testThreeHopLoopThroughFeeTokenUnaffected() public {
        SwapExecutor.SwapStep[] memory st = new SwapExecutor.SwapStep[](3);
        st[0] = _st(address(v2), address(meme), address(mid));
        st[1] = _st(address(v2), address(mid), address(usdc));
        st[2] = _st(address(v2), address(usdc), address(meme));
        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: st, amountIn: 1000 ether});
        // 1000 -> 2000 MID -> 4000 USDC, fee 40 -> 3960 -> 7920 MEME
        uint256 out = _swap(address(meme), address(meme), 1000 ether, 0, parts);
        assertEq(out, 7920 ether);
        assertEq(usdc.balanceOf(feeTo), 40 ether);
    }

    function testFeeRecipientCannotBeSelf() public {
        vm.prank(owner);
        vm.expectRevert(bytes("fee recipient is self"));
        exec.setFeeRecipient(address(exec));

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(bytes("fee recipient is self"));
        new SwapExecutor(owner, predicted, 0, address(weth), new address[](0));
    }
}
