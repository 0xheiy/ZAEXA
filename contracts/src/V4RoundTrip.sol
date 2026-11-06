// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {V4PoolKey, V4SwapParams, IV4PoolManager, IV4UnlockCallback, IV4ERC20, IV4WETH} from "./UniswapV4Adapter.sol";

/*
 * V4RoundTrip - NEVER DEPLOYED. The worker injects its runtime bytecode with an
 * eth_call state override (code + ETH balance) and asks one question: on this
 * exact Uniswap v4 pool, does a buyer who buys with `ethIn` and then sells back
 * exactly what arrived get a fill on both legs?
 *
 * Why it exists: two separate V4Quoter calls on the pre-buy pool state made every
 * fresh single-sided pool (Clanker) look one-way, because the buyer's ETH is not
 * in the pool yet when the sell is quoted (XTO, 4 Nov). Here the buy settles
 * inside the PoolManager first, so the sell sees the state a real buyer would.
 *
 * Interfaces are the adapter's own (src/UniswapV4Adapter.sol), which mirror v4-core
 * @ 46c6834698c48bc4a463a86d8420f4eb1d7f3b75. Selectors, checked with `cast sig`:
 *   swap 0xf3cd914c  unlock 0x48c89491  sync 0xa5841194  take 0x0b0d9c09  settle 0x11da60b4
 *
 * Quote currency (the side we pay with): native ETH (address(0)) and WETH.
 * USDC is NOT supported in v1: the call would need a USDC balance injected into
 * the USDC proxy's storage, which is fragile; the worker skips USDC-quoted keys.
 * WETH is wrapped from the ETH balance given by the override.
 *
 * Errors the caller can tell apart (top-level revert data of the eth_call):
 *   BuyFailed(bytes reason)   the buy leg reverted or did not fill
 *   SellFailed(bytes reason)  the sell leg reverted or did not fill; the buy had succeeded
 * `reason` is the inner revert data. v4-core does not revert on a partial fill, it
 * just stops at the price limit, so a leg that consumes less than the whole input
 * is reported as NotEnoughLiquidity(poolId) (poolId = keccak256(abi.encode(key)),
 * the same id and selector 0x7a5ed734 the V4Quoter uses). Any other inner error
 * (hook reverts, price-limit errors, mismatches) is passed through untouched.
 * A failure after both legs (e.g. a fee-on-transfer token leaving a debt, so unlock
 * ends with CurrencyNotSettled) is bubbled as-is and is neither BuyFailed nor
 * SellFailed.
 */
contract V4RoundTrip is IV4UnlockCallback {
    // v4-core TickMath, copied exactly (same as the adapter)
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    // Base mainnet. PoolManager = CHAIN.v4PoolManager in web/index.html.
    address internal constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;

    error BuyFailed(bytes reason);
    error SellFailed(bytes reason);
    error NotEnoughLiquidity(bytes32 poolId);
    error UnexpectedFill(int256 inDelta, int256 outDelta);
    error ZeroOutput();
    error UnsupportedQuote(address currency);
    error ZeroAmount();
    error OnlyPoolManager();
    error OnlySelf();

    struct Ctx {
        V4PoolKey key;
        bool quoteIsCurrency0;
        uint256 ethIn;
    }

    receive() external payable {}

    function roundTrip(V4PoolKey calldata key, bool ethIsCurrency0, uint256 ethIn)
        external
        returns (uint256 tokensOut, uint256 ethBack)
    {
        address quote = ethIsCurrency0 ? key.currency0 : key.currency1;
        address token = ethIsCurrency0 ? key.currency1 : key.currency0;
        if (quote != address(0) && quote != WETH) revert UnsupportedQuote(quote);
        if (token == address(0) || token == quote) revert UnsupportedQuote(token);
        if (ethIn == 0) revert ZeroAmount();

        if (quote == WETH) IV4WETH(WETH).deposit{value: ethIn}();

        bytes memory r = IV4PoolManager(POOL_MANAGER).unlock(abi.encode(Ctx(key, ethIsCurrency0, ethIn)));
        (tokensOut, ethBack) = abi.decode(r, (uint256, uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != POOL_MANAGER) revert OnlyPoolManager();
        Ctx memory c = abi.decode(data, (Ctx));

        (bool ok, bytes memory ret) = address(this).call(abi.encodeCall(this.buyLeg, (c)));
        if (!ok) revert BuyFailed(ret);
        uint256 tokensOut = abi.decode(ret, (uint256));

        (ok, ret) = address(this).call(abi.encodeCall(this.sellLeg, (c, tokensOut)));
        if (!ok) revert SellFailed(ret);
        uint256 ethBack = abi.decode(ret, (uint256));

        return abi.encode(tokensOut, ethBack);
    }

    // --- legs: external only so the callback can catch their revert data ---

    function buyLeg(Ctx memory c) external returns (uint256 tokensOut) {
        if (msg.sender != address(this)) revert OnlySelf();
        (address quote, address token) = _sides(c);
        uint256 owed = _swapExactIn(c.key, quote == c.key.currency0, c.ethIn);
        _settle(quote, c.ethIn);
        uint256 before = IV4ERC20(token).balanceOf(address(this));
        IV4PoolManager(POOL_MANAGER).take(token, address(this), owed);
        // measured, not trusted: a fee-on-transfer token delivers less than `owed`
        tokensOut = IV4ERC20(token).balanceOf(address(this)) - before;
        if (tokensOut == 0) revert ZeroOutput();
    }

    function sellLeg(Ctx memory c, uint256 tokensOut) external returns (uint256 ethBack) {
        if (msg.sender != address(this)) revert OnlySelf();
        (address quote, address token) = _sides(c);
        uint256 owed = _swapExactIn(c.key, token == c.key.currency0, tokensOut);
        _settle(token, tokensOut);
        uint256 before = _bal(quote);
        IV4PoolManager(POOL_MANAGER).take(quote, address(this), owed);
        ethBack = _bal(quote) - before;
    }

    // --- helpers ---

    function _sides(Ctx memory c) private pure returns (address quote, address token) {
        quote = c.quoteIsCurrency0 ? c.key.currency0 : c.key.currency1;
        token = c.quoteIsCurrency0 ? c.key.currency1 : c.key.currency0;
    }

    function _bal(address currency) private view returns (uint256) {
        return currency == address(0) ? address(this).balance : IV4ERC20(currency).balanceOf(address(this));
    }

    // exact-input swap; returns the output the pool owes. A partial fill is
    // NotEnoughLiquidity(poolId); anything else odd is UnexpectedFill.
    function _swapExactIn(V4PoolKey memory key, bool zeroForOne, uint256 amount) private returns (uint256) {
        int256 delta = IV4PoolManager(POOL_MANAGER).swap(
            key,
            V4SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
            }),
            ""
        );
        // amount0 = upper 128 bits, amount1 = lower 128 bits (exact v4-core packing)
        int256 a0 = delta >> 128;
        int256 a1 = int256(int128(delta));
        int256 inD = zeroForOne ? a0 : a1;
        int256 outD = zeroForOne ? a1 : a0;
        if (inD > -int256(amount) && inD <= 0) revert NotEnoughLiquidity(keccak256(abi.encode(key)));
        if (inD != -int256(amount) || outD <= 0) revert UnexpectedFill(inD, outD);
        return uint256(outD);
    }

    function _settle(address currency, uint256 amount) private {
        if (currency == address(0)) {
            IV4PoolManager(POOL_MANAGER).settle{value: amount}();
        } else {
            IV4PoolManager(POOL_MANAGER).sync(currency);
            (bool ok, bytes memory ret) = currency.call(abi.encodeCall(IV4ERC20.transfer, (POOL_MANAGER, amount)));
            require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "rt: transfer failed");
            IV4PoolManager(POOL_MANAGER).settle();
        }
    }
}
