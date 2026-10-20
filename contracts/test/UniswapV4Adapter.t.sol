// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SwapExecutor.sol";
import "../src/UniswapV4Adapter.sol";
import "./Mocks.sol";

/*
 * Mock v4 PoolManager: implements the unlock -> unlockCallback flow and the
 * flash-accounting rule (every currency delta must be zero when unlock ends),
 * and lets tests script what the pool reports. It is NOT a pricing model.
 */
contract MockPoolManager {
    mapping(address => int256) public deltas;
    address public syncedCurrency;
    uint256 public syncedReserve;
    address[2] touched;

    // scripts
    uint256 public rateX = 2;          // output = consumed input * rateX
    uint256 public fillBps = 10_000;   // fraction of the input the pool consumes
    uint256 public extraIn;            // a hook that charges more input
    uint256 public forceOut;           // used when useForceOut
    bool    public useForceOut;
    uint256 public dustEth;            // ETH pushed to the caller after the callback

    // captured
    V4PoolKey public lastKey;
    bool public lastZeroForOne;
    int256 public lastAmountSpecified;
    uint160 public lastLimit;
    uint256 public lastHookDataLen;

    function setScript(uint256 _rate, uint256 _fillBps, uint256 _extraIn, bool _use, uint256 _force, uint256 _dust) external {
        rateX = _rate; fillBps = _fillBps; extraIn = _extraIn;
        useForceOut = _use; forceOut = _force; dustEth = _dust;
    }

    receive() external payable {}

    function unlock(bytes calldata data) external returns (bytes memory r) {
        r = IV4UnlockCallback(msg.sender).unlockCallback(data);
        require(deltas[touched[0]] == 0 && deltas[touched[1]] == 0, "CurrencyNotSettled");
        if (dustEth > 0) { (bool ok,) = msg.sender.call{value: dustEth}(""); require(ok); }
    }

    function swap(V4PoolKey memory key, V4SwapParams memory p, bytes calldata hookData)
        external returns (int256 d)
    {
        lastKey = key; lastZeroForOne = p.zeroForOne; lastAmountSpecified = p.amountSpecified;
        lastLimit = p.sqrtPriceLimitX96; lastHookDataLen = hookData.length;
        require(key.currency0 < key.currency1, "unsorted");
        uint256 amtIn = uint256(-p.amountSpecified);
        uint256 consumed = amtIn * fillBps / 10_000;
        uint256 charged = consumed + extraIn;
        uint256 out = useForceOut ? forceOut : consumed * rateX;
        (address cIn, address cOut) = p.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        touched = [cIn, cOut];
        deltas[cIn] -= int256(charged);
        deltas[cOut] += int256(out);
        int256 a0 = p.zeroForOne ? -int256(charged) : int256(out);
        int256 a1 = p.zeroForOne ? int256(out) : -int256(charged);
        // exact v4-core packing: amount0 upper 128 bits, amount1 lower 128 bits
        d = (a0 << 128) | int256(uint256(a1) & type(uint128).max);
    }

    function sync(address c) external {
        syncedCurrency = c;
        syncedReserve = c == address(0) ? 0 : IV4ERC20(c).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        if (syncedCurrency == address(0)) {
            paid = msg.value;
            deltas[address(0)] += int256(paid);
        } else {
            paid = IV4ERC20(syncedCurrency).balanceOf(address(this)) - syncedReserve;
            deltas[syncedCurrency] += int256(paid);
            syncedCurrency = address(0);
        }
    }

    function take(address c, address to, uint256 amount) external {
        deltas[c] -= int256(amount);
        if (c == address(0)) { (bool ok,) = to.call{value: amount}(""); require(ok, "eth"); }
        else require(IV4ERC20(c).transfer(to, amount), "tok");
    }
}

contract UniswapV4AdapterTest is Test {
    MockPoolManager pm;
    MockWETH weth;
    MockERC20 tokenA;
    MockERC20 tokenB;
    UniswapV4Adapter adapter;
    address executor = address(this);     // the unit tests play the executor
    address recipient = address(0xCAFE);
    address hooks = address(0);

    function setUp() public {
        pm = new MockPoolManager();
        weth = new MockWETH();
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        adapter = new UniswapV4Adapter(address(pm), address(weth), executor);
        tokenA.mint(address(pm), 1e30);
        tokenB.mint(address(pm), 1e30);
        vm.deal(address(pm), 1_000 ether);
        vm.deal(address(this), 100 ether);
    }

    receive() external payable {}

    function _sendToken(MockERC20 t, uint256 amt) internal { t.mint(address(adapter), amt); }

    function _sendWeth(uint256 amt) internal {
        weth.deposit{value: amt}();
        weth.transfer(address(adapter), amt);
    }

    function _swap(address tin, address tout, uint256 amt, bool stable) internal {
        adapter.swap(tin, tout, amt, 500, 10, stable, hooks, recipient);
    }

    function _noFunds() internal view {
        assertEq(tokenA.balanceOf(address(adapter)), 0, "A left");
        assertEq(tokenB.balanceOf(address(adapter)), 0, "B left");
        assertEq(weth.balanceOf(address(adapter)), 0, "weth left");
        assertEq(address(adapter).balance, 0, "eth left");
    }

    // --- ERC20 -> ERC20, both directions -------------------------------------

    function testErc20BothDirections() public {
        _sendToken(tokenA, 100 ether);
        _swap(address(tokenA), address(tokenB), 100 ether, false);
        assertEq(tokenB.balanceOf(recipient), 200 ether);
        assertEq(pm.lastZeroForOne(), address(tokenA) < address(tokenB), "direction A->B");
        (address c0, address c1, uint24 fee, int24 ts, address h) = pm.lastKey();
        assertEq(c0, address(tokenA) < address(tokenB) ? address(tokenA) : address(tokenB));
        assertEq(c1, address(tokenA) < address(tokenB) ? address(tokenB) : address(tokenA));
        assertEq(fee, 500); assertEq(ts, 10); assertEq(h, hooks);
        assertEq(pm.lastAmountSpecified(), -int256(100 ether));
        assertEq(pm.lastHookDataLen(), 0);
        _noFunds();

        _sendToken(tokenB, 50 ether);
        _swap(address(tokenB), address(tokenA), 50 ether, false);
        assertEq(tokenA.balanceOf(recipient), 100 ether);
        assertEq(pm.lastZeroForOne(), address(tokenB) < address(tokenA), "direction B->A");
        _noFunds();
    }

    function testPriceLimitsFollowDirection() public {
        _sendToken(tokenA, 1 ether);
        _swap(address(tokenA), address(tokenB), 1 ether, false);
        assertEq(pm.lastLimit(), pm.lastZeroForOne() ? 4295128739 + 1
            : 1461446703485210103287273052203988822378723970342 - 1);
    }

    function testFeeTickAndHooksArePassedThrough() public {
        _sendToken(tokenA, 1 ether);
        adapter.swap(address(tokenA), address(tokenB), 1 ether, 3000, 60, false, address(0xBEEF0001), recipient);
        (,, uint24 fee, int24 ts, address h) = pm.lastKey();
        assertEq(fee, 3000); assertEq(ts, 60); assertEq(h, address(0xBEEF0001));
    }

    // --- native pools --------------------------------------------------------

    function testWethToTokenWithNativePool() public {
        _sendWeth(1 ether);
        _swap(address(weth), address(tokenB), 1 ether, true);
        (address c0, address c1,,,) = pm.lastKey();
        assertEq(c0, address(0), "native is currency0");
        assertEq(c1, address(tokenB));
        assertTrue(pm.lastZeroForOne());
        assertEq(tokenB.balanceOf(recipient), 2 ether);
        assertEq(address(pm).balance, 1_001 ether, "pool got the ETH");
        _noFunds();
    }

    function testTokenToWethWithNativePoolWraps() public {
        _sendToken(tokenB, 10 ether);
        _swap(address(tokenB), address(weth), 10 ether, true);
        (address c0,,,,) = pm.lastKey();
        assertEq(c0, address(0));
        assertFalse(pm.lastZeroForOne());
        assertEq(weth.balanceOf(recipient), 20 ether, "recipient gets WETH, not ETH");
        assertEq(recipient.balance, 0);
        _noFunds();
    }

    function testStableWithoutWethSideReverts() public {
        _sendToken(tokenA, 1 ether);
        vm.expectRevert("v4: no weth side");
        _swap(address(tokenA), address(tokenB), 1 ether, true);
    }

    function testWethAsPlainErc20WhenNotStable() public {
        _sendWeth(1 ether);
        weth.deposit{value: 5 ether}(); weth.transfer(address(pm), 5 ether); // pool inventory
        _swap(address(weth), address(tokenB), 1 ether, false);
        (address c0, address c1,,,) = pm.lastKey();
        assertTrue(c0 != address(0) && c1 != address(0), "no native currency");
        assertEq(weth.balanceOf(address(pm)), 6 ether);
        _noFunds();
    }

    // --- access control ------------------------------------------------------

    function testOnlyExecutorCanSwap() public {
        _sendToken(tokenA, 1 ether);
        vm.prank(address(0xBAD));
        vm.expectRevert("v4: only executor");
        adapter.swap(address(tokenA), address(tokenB), 1 ether, 500, 10, false, hooks, recipient);
    }

    function testCallbackFromNonPoolManagerRejected() public {
        vm.expectRevert("v4: only poolManager");
        adapter.unlockCallback("");
    }

    function testCallbackOutsideOurSwapRejected() public {
        vm.prank(address(pm));
        vm.expectRevert("v4: not in swap");
        adapter.unlockCallback(abi.encode(uint256(1)));
    }

    function testReceiveOnlyFromWethOrPoolManager() public {
        vm.expectRevert("v4: no eth");
        payable(address(adapter)).transfer(1 wei);
        vm.prank(address(pm));
        (bool ok,) = address(adapter).call{value: 1 wei}("");
        assertTrue(ok);
    }

    // --- delta checks --------------------------------------------------------

    function testHookChargingExtraInputReverts() public {
        _sendToken(tokenA, 100 ether);
        pm.setScript(2, 10_000, 1, false, 0, 0);
        vm.expectRevert("v4: input mismatch");
        _swap(address(tokenA), address(tokenB), 100 ether, false);
    }

    function testPartialFillReverts() public {
        _sendToken(tokenA, 100 ether);
        pm.setScript(2, 9_000, 0, false, 0, 0);
        vm.expectRevert("v4: input mismatch");
        _swap(address(tokenA), address(tokenB), 100 ether, false);
    }

    function testZeroOutputReverts() public {
        _sendToken(tokenA, 100 ether);
        pm.setScript(2, 10_000, 0, true, 0, 0);
        vm.expectRevert("v4: no output");
        _swap(address(tokenA), address(tokenB), 100 ether, false);
    }

    function testLeftoverEthReverts() public {
        _sendToken(tokenA, 100 ether);
        pm.setScript(2, 10_000, 0, false, 0, 1);
        vm.expectRevert("v4: eth left");
        _swap(address(tokenA), address(tokenB), 100 ether, false);
    }

    function testForceSentDustDoesNotBrickTheAdapter() public {
        vm.deal(address(adapter), 1 wei);   // selfdestruct-style donation
        _sendToken(tokenA, 1 ether);
        _swap(address(tokenA), address(tokenB), 1 ether, false);
        assertEq(address(adapter).balance, 1 wei);
    }

    function testTradesActualBalanceNotNominal() public {
        // fee-on-transfer style: executor said 100, only 90 arrived
        _sendToken(tokenA, 90 ether);
        _swap(address(tokenA), address(tokenB), 100 ether, false);
        assertEq(pm.lastAmountSpecified(), -int256(90 ether));
        assertEq(tokenB.balanceOf(recipient), 180 ether);
        _noFunds();
    }

    function testNothingReceivedReverts() public {
        vm.expectRevert("v4: nothing received");
        _swap(address(tokenA), address(tokenB), 1 ether, false);
    }

    function testConstructorRejectsZero() public {
        vm.expectRevert("v4: zero addr");
        new UniswapV4Adapter(address(0), address(weth), executor);
    }

    // --- end to end through the real SwapExecutor ----------------------------

    function _e2eSetup() internal returns (SwapExecutor exec, UniswapV4Adapter ad, address user) {
        user = address(0xB0B);
        exec = new SwapExecutor(address(this), address(0xFEE), 0, address(weth));
        ad = new UniswapV4Adapter(address(pm), address(weth), address(exec));
        exec.setAdapterAllowed(address(ad), true);
        tokenA.mint(user, 100 ether);
        vm.prank(user);
        tokenA.approve(address(exec), type(uint256).max);
    }

    function _parts(address ad, address tin, address tout, uint256 amt, bool stable)
        internal pure returns (SwapExecutor.RoutePart[] memory parts)
    {
        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](1);
        steps[0] = SwapExecutor.SwapStep({
            kind: 5, router: ad, tokenIn: tin, tokenOut: tout,
            feeTier: 500, stable: stable, poolFactory: address(0), tickSpacing: 10
        });
        parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: amt});
    }

    function testEndToEndThroughExecutor() public {
        (SwapExecutor exec, UniswapV4Adapter ad, address user) = _e2eSetup();
        SwapExecutor.RoutePart[] memory parts = _parts(address(ad), address(tokenA), address(tokenB), 100 ether, false);
        vm.prank(user);
        uint256 out = exec.executeSwap(address(tokenA), address(tokenB), 100 ether, 200 ether, parts, block.timestamp + 60);
        assertEq(out, 200 ether);
        assertEq(tokenB.balanceOf(user), 200 ether);
        assertEq(tokenA.balanceOf(address(exec)), 0);
        assertEq(tokenB.balanceOf(address(exec)), 0);
        assertEq(weth.balanceOf(address(exec)), 0);
        assertEq(address(exec).balance, 0);
        assertEq(tokenA.balanceOf(address(ad)), 0);
        assertEq(address(ad).balance, 0);
    }

    function testEndToEndNativePoolWethToToken() public {
        (SwapExecutor exec, UniswapV4Adapter ad, address user) = _e2eSetup();
        vm.deal(user, 1 ether);
        vm.startPrank(user);
        weth.deposit{value: 1 ether}();
        weth.approve(address(exec), type(uint256).max);
        SwapExecutor.RoutePart[] memory parts = _parts(address(ad), address(weth), address(tokenB), 1 ether, true);
        uint256 out = exec.executeSwap(address(weth), address(tokenB), 1 ether, 2 ether, parts, block.timestamp + 60);
        vm.stopPrank();
        assertEq(out, 2 ether);
        assertEq(weth.balanceOf(address(exec)), 0);
        assertEq(weth.balanceOf(address(ad)), 0);
        assertEq(address(ad).balance, 0);
    }

    function testExecutorEnforcesMinOut() public {
        (SwapExecutor exec, UniswapV4Adapter ad, address user) = _e2eSetup();
        SwapExecutor.RoutePart[] memory parts = _parts(address(ad), address(tokenA), address(tokenB), 100 ether, false);
        vm.prank(user);
        vm.expectRevert("slippage: output below minimum");
        exec.executeSwap(address(tokenA), address(tokenB), 100 ether, 200 ether + 1, parts, block.timestamp + 60);
        assertEq(tokenA.balanceOf(user), 100 ether, "reverted: user keeps input");
    }

    function testExecutorRejectsUnlistedAdapter() public {
        (SwapExecutor exec,, address user) = _e2eSetup();
        UniswapV4Adapter other = new UniswapV4Adapter(address(pm), address(weth), address(exec));
        SwapExecutor.RoutePart[] memory parts = _parts(address(other), address(tokenA), address(tokenB), 1 ether, false);
        vm.prank(user);
        vm.expectRevert("adapter not allowed");
        exec.executeSwap(address(tokenA), address(tokenB), 1 ether, 0, parts, block.timestamp + 60);
    }
}
