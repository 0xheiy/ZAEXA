// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IZaexaAdapter} from "./SwapExecutor.sol";

/*
 * Minimal local copies of the Uniswap v4-core types this adapter needs. Nothing
 * from v4-core is imported or vendored; the signatures below were copied from
 *   github.com/Uniswap/v4-core @ 46c6834698c48bc4a463a86d8420f4eb1d7f3b75
 * (src/interfaces/IPoolManager.sol, src/interfaces/callback/IUnlockCallback.sol,
 *  src/types/PoolKey.sol, src/types/PoolOperation.sol, src/types/BalanceDelta.sol,
 *  src/libraries/TickMath.sol).
 * `Currency` is `type Currency is address` upstream, so it is a plain address in
 * the ABI. `BalanceDelta` is `type BalanceDelta is int256` upstream:
 * amount0 = upper 128 bits (sar 128), amount1 = lower 128 bits (signextend 15).
 * Names are prefixed V4 so they never clash with other declarations in the repo.
 */
struct V4PoolKey {
    address currency0;   // lower address; address(0) = native ETH
    address currency1;
    uint24  fee;
    int24   tickSpacing;
    address hooks;
}

struct V4SwapParams {
    bool    zeroForOne;
    int256  amountSpecified;   // negative = exact input
    uint160 sqrtPriceLimitX96;
}

interface IV4PoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(V4PoolKey memory key, V4SwapParams memory params, bytes calldata hookData)
        external returns (int256 swapDelta);
    function sync(address currency) external;
    function take(address currency, address to, uint256 amount) external;
    function settle() external payable returns (uint256 paid);
}

interface IV4UnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

interface IV4ERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IV4WETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/*
 * Uniswap v4 adapter for the Zaexa SwapExecutor (KIND_ADAPTER).
 *
 * Field mapping (the executor's SwapStep fields are reused, no executor change):
 *   feeTier     -> PoolKey.fee
 *   tickSpacing -> PoolKey.tickSpacing
 *   poolFactory -> PoolKey.hooks   (address(0) = hookless pool)
 *   stable      -> "the WETH side of this pool is native ETH (currency address(0))"
 *   currency0/1 -> sorted by address after mapping WETH -> address(0) when stable
 *
 * Money rules (owner rule: no funds ever stay in our contracts):
 *   - exact-input only; the input delta must be exactly -amount, else revert
 *   - output must be > 0 and goes straight to the recipient
 *   - after the swap the adapter must hold no tokenIn, and its WETH / ETH
 *     balances must equal what they were before (zero, unless someone force-sent
 *     dust, which must not be able to brick the adapter)
 *   - only the executor may call swap(); only the PoolManager may call the
 *     callback, and only while a swap of ours is in progress
 */
contract UniswapV4Adapter is IZaexaAdapter, IV4UnlockCallback {
    // v4-core TickMath, copied exactly
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    // transient flag: true only inside our own unlock() call
    bytes32 private constant ACTIVE_SLOT = keccak256("zaexa.v4adapter.active");

    address public immutable poolManager;
    address public immutable weth;
    address public immutable executor;

    struct Ctx {
        V4PoolKey key;
        bool    zeroForOne;
        address cIn;
        address cOut;
        uint256 amount;
        address recipient;
    }

    constructor(address _poolManager, address _weth, address _executor) {
        require(_poolManager != address(0) && _weth != address(0) && _executor != address(0), "v4: zero addr");
        poolManager = _poolManager;
        weth = _weth;
        executor = _executor;
    }

    receive() external payable {
        require(msg.sender == weth || msg.sender == poolManager, "v4: no eth");
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24  feeTier,
        int24   tickSpacing,
        bool    stable,
        address poolFactory,
        address recipient
    ) external {
        require(msg.sender == executor, "v4: only executor");
        require(!_active(), "v4: reentrancy");
        require(recipient != address(0), "v4: zero recipient");
        require(amountIn > 0, "v4: zero amount");
        require(tokenIn != tokenOut, "v4: same token");
        if (stable) require(tokenIn == weth || tokenOut == weth, "v4: no weth side");

        // Trade our actual balance (fee-on-transfer safe); the executor sent amountIn first.
        uint256 amount = IV4ERC20(tokenIn).balanceOf(address(this));
        require(amount > 0, "v4: nothing received");

        uint256 wethBefore = IV4ERC20(weth).balanceOf(address(this));
        if (tokenIn == weth) wethBefore = 0;   // fully traded, expected to end at zero
        uint256 ethBefore = address(this).balance;

        Ctx memory c;
        c.cIn  = (stable && tokenIn  == weth) ? address(0) : tokenIn;
        c.cOut = (stable && tokenOut == weth) ? address(0) : tokenOut;
        require(c.cIn != c.cOut, "v4: same currency");
        c.zeroForOne = c.cIn < c.cOut;
        c.key = V4PoolKey({
            currency0: c.zeroForOne ? c.cIn : c.cOut,
            currency1: c.zeroForOne ? c.cOut : c.cIn,
            fee: feeTier,
            tickSpacing: tickSpacing,
            hooks: poolFactory
        });
        c.amount = amount;
        c.recipient = recipient;

        _setActive(true);
        IV4PoolManager(poolManager).unlock(abi.encode(c));
        _setActive(false);

        require(IV4ERC20(tokenIn).balanceOf(address(this)) == 0, "v4: tokenIn left");
        require(IV4ERC20(weth).balanceOf(address(this)) == wethBefore, "v4: weth left");
        require(address(this).balance == ethBefore, "v4: eth left");
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == poolManager, "v4: only poolManager");
        require(_active(), "v4: not in swap");
        Ctx memory c = abi.decode(data, (Ctx));

        int256 delta = IV4PoolManager(poolManager).swap(
            c.key,
            V4SwapParams({
                zeroForOne: c.zeroForOne,
                amountSpecified: -int256(c.amount),
                sqrtPriceLimitX96: c.zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
            }),
            ""
        );

        // amount0 = upper 128 bits, amount1 = lower 128 bits (exact v4-core packing)
        int256 a0 = delta >> 128;
        int256 a1 = int256(int128(delta));
        int256 inDelta  = c.zeroForOne ? a0 : a1;
        int256 outDelta = c.zeroForOne ? a1 : a0;
        require(inDelta == -int256(c.amount), "v4: input mismatch");
        require(outDelta > 0, "v4: no output");
        uint256 out = uint256(outDelta);

        // settle the input
        if (c.cIn == address(0)) {
            IV4WETH(weth).withdraw(c.amount);
            IV4PoolManager(poolManager).settle{value: c.amount}();
        } else {
            IV4PoolManager(poolManager).sync(c.cIn);
            _safeTransfer(c.cIn, poolManager, c.amount);
            IV4PoolManager(poolManager).settle();
        }

        // take the output
        if (c.cOut == address(0)) {
            IV4PoolManager(poolManager).take(address(0), address(this), out);
            IV4WETH(weth).deposit{value: out}();
            _safeTransfer(weth, c.recipient, out);
        } else {
            IV4PoolManager(poolManager).take(c.cOut, c.recipient, out);
        }
        return "";
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IV4ERC20.transfer, (to, amount)));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "v4: transfer failed");
    }

    function _active() private view returns (bool a) {
        bytes32 s = ACTIVE_SLOT;
        assembly { a := tload(s) }
    }

    function _setActive(bool v) private {
        bytes32 s = ACTIVE_SLOT;
        assembly { tstore(s, v) }
    }
}
