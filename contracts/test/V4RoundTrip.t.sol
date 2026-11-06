// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/V4RoundTrip.sol";
import "./Mocks.sol";

/*
 * Mock v4 PoolManager that mirrors v4-core's unlock / sync / settle / take
 * semantics: swap and take only while unlocked, per-currency deltas, settle()
 * credits native msg.value or (balance - synced reserve) for an ERC20, and
 * unlock() reverts CurrencyNotSettled if any delta is non-zero at the end.
 * Like v4-core, a swap that runs out of liquidity returns a PARTIAL fill; it
 * does not revert. The pool model is minimal: `poolQuote` is the quote the pool
 * can pay out; a buy adds the buyer's quote to it (that is the XTO case).
 */
contract RtMockPM {
    bool public unlocked;
    mapping(address => int256) public deltas;
    address[2] touched;
    address public syncedCurrency;
    uint256 public syncedReserve;
    uint256 public swaps;

    address public quote;       // the currency we pay with
    uint256 public rate;        // token out per quote in (set by script(); etched code keeps no initialisers)
    uint256 public poolQuote;   // quote the pool can pay out
    uint256 public buyFillBps = 10_000;
    uint256 public sellFillBps = 10_000;
    bytes   public revertOn1;   // swap #1 reverts with this
    bytes   public revertOn2;   // swap #2 reverts with this
    uint256 public lastHookDataLen;
    uint160 public lastLimit0;
    uint160 public lastLimit1;

    function script(address q, uint256 pq, uint256 bBps, uint256 sBps) external {
        quote = q; poolQuote = pq; buyFillBps = bBps; sellFillBps = sBps; rate = 1000;
    }
    function scriptRevert(bytes calldata r1, bytes calldata r2) external { revertOn1 = r1; revertOn2 = r2; }

    receive() external payable {}

    function unlock(bytes calldata data) external returns (bytes memory r) {
        require(!unlocked, "AlreadyUnlocked");
        unlocked = true;
        r = IV4UnlockCallback(msg.sender).unlockCallback(data);
        if (deltas[touched[0]] != 0 || deltas[touched[1]] != 0) revert("CurrencyNotSettled");
        unlocked = false;
    }

    function swap(V4PoolKey memory key, V4SwapParams memory p, bytes calldata hookData)
        external returns (int256)
    {
        require(unlocked, "ManagerLocked");
        require(key.currency0 < key.currency1, "unsorted");
        swaps++;
        lastHookDataLen = hookData.length;
        if (swaps == 1) { lastLimit0 = p.sqrtPriceLimitX96; bytes memory r = revertOn1; if (r.length > 0) _bubble(r); }
        else            { lastLimit1 = p.sqrtPriceLimitX96; bytes memory r = revertOn2; if (r.length > 0) _bubble(r); }

        uint256 amtIn = uint256(-p.amountSpecified);
        (address cIn, address cOut) = p.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        touched = [cIn, cOut];
        uint256 consumed; uint256 out;
        if (cIn == quote) {                       // buy: quote -> token
            consumed = amtIn * buyFillBps / 10_000;
            out = consumed * rate;
            poolQuote += consumed;                // the buyer's quote now sits in the pool
        } else {                                  // sell: token -> quote
            consumed = amtIn * sellFillBps / 10_000;
            out = consumed / rate;
            if (out > poolQuote) { out = poolQuote; consumed = out * rate; } // partial fill at the limit
            poolQuote -= out;
        }
        deltas[cIn] -= int256(consumed);
        deltas[cOut] += int256(out);
        int256 a0 = p.zeroForOne ? -int256(consumed) : int256(out);
        int256 a1 = p.zeroForOne ? int256(out) : -int256(consumed);
        return (a0 << 128) | int256(uint256(uint128(int128(a1))));
    }

    function sync(address currency) external {
        if (currency == address(0)) { syncedCurrency = address(0); return; }
        syncedCurrency = currency;
        syncedReserve = MockERC20(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        require(unlocked, "ManagerLocked");
        address cur = syncedCurrency;
        if (cur == address(0)) { paid = msg.value; }
        else {
            require(msg.value == 0, "NonzeroNativeValue");
            paid = MockERC20(cur).balanceOf(address(this)) - syncedReserve;
        }
        deltas[cur] += int256(paid);
        syncedCurrency = address(0);
    }

    function take(address currency, address to, uint256 amount) external {
        require(unlocked, "ManagerLocked");
        deltas[currency] -= int256(amount);
        if (currency == address(0)) { (bool ok,) = to.call{value: amount}(""); require(ok, "native"); }
        else { MockERC20(currency).transfer(to, amount); }
    }

    function _bubble(bytes memory r) private pure { assembly { revert(add(r, 32), mload(r)) } }
}

contract V4RoundTripTest is Test {
    address constant PM = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant WETH = 0x4200000000000000000000000000000000000006;

    V4RoundTrip rt;
    RtMockPM pm;
    MockERC20 token;
    uint256 constant ETH_IN = 1 ether;

    error NotEnoughLiquidity(bytes32 poolId);
    error BuyFailed(bytes reason);
    error SellFailed(bytes reason);

    function setUp() public {
        RtMockPM impl = new RtMockPM();
        vm.etch(PM, address(impl).code);
        pm = RtMockPM(payable(PM));
        vm.etch(WETH, address(new MockWETH()).code);
        rt = new V4RoundTrip();
        token = new MockERC20("T", "T", 18);
        token.mint(PM, 1e30);
        vm.deal(PM, 100 ether);
        vm.deal(address(rt), ETH_IN + 1 ether);
    }

    // native ETH is currency0 (address(0)); the token is currency1
    function _nativeKey() internal view returns (V4PoolKey memory) {
        return V4PoolKey({currency0: address(0), currency1: address(token), fee: 3000, tickSpacing: 60, hooks: address(0)});
    }
    // WETH vs token, sorted by address
    function _wethKey() internal view returns (V4PoolKey memory k, bool wethIs0) {
        wethIs0 = WETH < address(token);
        k = V4PoolKey({
            currency0: wethIs0 ? WETH : address(token), currency1: wethIs0 ? address(token) : WETH,
            fee: 3000, tickSpacing: 60, hooks: address(0)
        });
    }
    function _poolId(V4PoolKey memory k) internal pure returns (bytes32) { return keccak256(abi.encode(k)); }

    function _expectSell(bytes memory inner) internal { vm.expectRevert(abi.encodeWithSelector(SellFailed.selector, inner)); }
    function _expectBuy(bytes memory inner) internal { vm.expectRevert(abi.encodeWithSelector(BuyFailed.selector, inner)); }

    // ---- selectors, pinned against v4-core / the adapter (cast sig) ----
    function testSelectorsMatchV4Core() public pure {
        assertEq(IV4PoolManager.swap.selector, bytes4(0xf3cd914c));
        assertEq(IV4PoolManager.unlock.selector, bytes4(0x48c89491));
        assertEq(IV4PoolManager.sync.selector, bytes4(0xa5841194));
        assertEq(IV4PoolManager.take.selector, bytes4(0x0b0d9c09));
        assertEq(IV4PoolManager.settle.selector, bytes4(0x11da60b4));
        assertEq(V4RoundTrip.roundTrip.selector, bytes4(0xe31b3cb1));
        assertEq(V4RoundTrip.BuyFailed.selector, bytes4(0xbd608e71));
        assertEq(V4RoundTrip.SellFailed.selector, bytes4(0x3c42935a));
        assertEq(V4RoundTrip.NotEnoughLiquidity.selector, bytes4(0x7a5ed734));
    }

    // ---- both legs succeed ----
    function testNormalPoolNativeBothLegsSucceed() public {
        pm.script(address(0), 50 ether, 10_000, 10_000);
        uint256 ethBefore = address(rt).balance;
        (uint256 tokensOut, uint256 ethBack) = rt.roundTrip(_nativeKey(), true, ETH_IN);
        assertEq(tokensOut, ETH_IN * 1000);
        assertEq(ethBack, ETH_IN);
        assertEq(address(rt).balance, ethBefore, "native ETH came back");
        assertEq(token.balanceOf(address(rt)), 0, "token fully sold");
        assertEq(pm.swaps(), 2);
        assertEq(pm.lastHookDataLen(), 0, "empty hookData");
        assertEq(uint256(pm.lastLimit0()), 4295128739 + 1, "buy zeroForOne -> MIN+1");
        assertEq(uint256(pm.lastLimit1()), 1461446703485210103287273052203988822378723970342 - 1, "sell oneForZero -> MAX-1");
    }

    // XTO: a fresh single-sided pool holds no ETH before the buy; the buyer's ETH is what pays the sell
    function testFreshSingleSidedPoolBothLegsSucceed() public {
        pm.script(address(0), 0, 10_000, 10_000);
        (uint256 tokensOut, uint256 ethBack) = rt.roundTrip(_nativeKey(), true, ETH_IN);
        assertEq(tokensOut, ETH_IN * 1000);
        assertEq(ethBack, ETH_IN);
    }

    function testWethQuoteBothLegsSucceed() public {
        (V4PoolKey memory k, bool wethIs0) = _wethKey();
        MockWETH(payable(WETH)).mint(PM, 100 ether);
        pm.script(WETH, 0, 10_000, 10_000);
        (uint256 tokensOut, uint256 ethBack) = rt.roundTrip(k, wethIs0, ETH_IN);
        assertEq(tokensOut, ETH_IN * 1000);
        assertEq(ethBack, ETH_IN);
        assertEq(MockWETH(payable(WETH)).balanceOf(address(rt)), ETH_IN, "ETH ended up wrapped (WETH)");
    }

    // ---- the sell leg ----
    function testSellFillsNothingIsSellFailedNotEnoughLiquidity() public {
        pm.script(address(0), 0, 10_000, 0);
        V4PoolKey memory k = _nativeKey();
        _expectSell(abi.encodeWithSelector(NotEnoughLiquidity.selector, _poolId(k)));
        rt.roundTrip(k, true, ETH_IN);
    }

    function testSellPartialFillIsSellFailedNotEnoughLiquidity() public {
        pm.script(address(0), 0, 10_000, 5_000);   // pool pays out only half
        V4PoolKey memory k = _nativeKey();
        _expectSell(abi.encodeWithSelector(NotEnoughLiquidity.selector, _poolId(k)));
        rt.roundTrip(k, true, ETH_IN);
    }

    function testSellFailedCarriesOtherReasonUntouched() public {
        pm.script(address(0), 0, 10_000, 10_000);
        bytes memory hookErr = abi.encodeWithSelector(bytes4(0x90bfb865), address(0xBEEF));
        pm.scriptRevert("", hookErr);
        _expectSell(hookErr);
        rt.roundTrip(_nativeKey(), true, ETH_IN);
    }

    // ---- the buy leg ----
    function testBuyRevertIsBuyFailed() public {
        pm.script(address(0), 0, 10_000, 10_000);
        bytes memory err = abi.encodeWithSignature("Error(string)", "boom");
        pm.scriptRevert(err, "");
        _expectBuy(err);
        rt.roundTrip(_nativeKey(), true, ETH_IN);
    }

    function testBuyPartialFillIsBuyFailedNotSellFailed() public {
        pm.script(address(0), 0, 4_000, 10_000);
        V4PoolKey memory k = _nativeKey();
        _expectBuy(abi.encodeWithSelector(NotEnoughLiquidity.selector, _poolId(k)));
        rt.roundTrip(k, true, ETH_IN);
    }

    function testBuyZeroFillIsBuyFailed() public {
        pm.script(address(0), 0, 0, 10_000);
        V4PoolKey memory k = _nativeKey();
        _expectBuy(abi.encodeWithSelector(NotEnoughLiquidity.selector, _poolId(k)));
        rt.roundTrip(k, true, ETH_IN);
    }

    // ---- guards ----
    function testUsdcQuoteIsUnsupported() public {
        V4PoolKey memory k = V4PoolKey({currency0: address(token), currency1: address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913), fee: 500, tickSpacing: 10, hooks: address(0)});
        vm.expectRevert(abi.encodeWithSelector(V4RoundTrip.UnsupportedQuote.selector, k.currency1));
        rt.roundTrip(k, false, ETH_IN);
    }

    function testCallbackOnlyFromPoolManager() public {
        vm.expectRevert(V4RoundTrip.OnlyPoolManager.selector);
        rt.unlockCallback("");
    }

    function testLegsOnlyFromSelf() public {
        V4RoundTrip.Ctx memory c = V4RoundTrip.Ctx(_nativeKey(), true, ETH_IN);
        vm.expectRevert(V4RoundTrip.OnlySelf.selector);
        rt.buyLeg(c);
        vm.expectRevert(V4RoundTrip.OnlySelf.selector);
        rt.sellLeg(c, 1);
    }

    // a fee-on-transfer token leaves a settle shortfall: the unlock itself fails,
    // and that is neither BuyFailed nor SellFailed (never read as "one-way")
    function testFeeOnTransferDebtIsNeitherBuyNorSellFailed() public {
        MockFeeToken fot = new MockFeeToken(500);
        fot.mint(PM, 1e30);
        V4PoolKey memory k = V4PoolKey({currency0: address(0), currency1: address(fot), fee: 3000, tickSpacing: 60, hooks: address(0)});
        pm.script(address(0), 0, 10_000, 10_000);
        try rt.roundTrip(k, true, ETH_IN) { fail(); } catch (bytes memory r) {
            assertTrue(bytes4(r) != V4RoundTrip.SellFailed.selector && bytes4(r) != V4RoundTrip.BuyFailed.selector);
        }
    }
}
