// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "forge-std/console2.sol";
import "../src/SwapExecutor.sol";
import "../src/UniswapV4Adapter.sol";

interface IStateViewLike {
    function getSlot0(bytes32 poolId)
        external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}

interface IWethLike {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IUsdcLike {
    function balanceOf(address) external view returns (uint256);
}

/*
 * Fork test for the Uniswap v4 adapter - against the real PoolManager on Base.
 * Run it with script/fork_test.sh (it passes BASE_RPC_URL / FORK_BLOCK).
 * Without BASE_RPC_URL the tests skip - loudly, never silently.
 *
 * Pool under test: native ETH (currency0 = address(0)) / USDC (currency1).
 * Two keys are tried (fee/tickSpacing 500/10 and 3000/60, hookless). A key whose
 * pool is not initialised (StateView.getSlot0 -> sqrtPrice 0) is skipped and the
 * log says which keys ran. If NO key is initialised the test fails: a green run
 * that swapped nothing proves nothing.
 */
contract UniswapV4AdapterForkTest is Test {
    address constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant V4_QUOTER    = 0x0d5e0F971ED27FBfF6c2837bf31316121532048D; // not used here, recorded for the web side
    address constant STATE_VIEW   = 0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71;
    address constant WETH         = 0x4200000000000000000000000000000000000006;
    address constant USDC         = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    SwapExecutor exec;
    UniswapV4Adapter adapter;
    address user = address(0xBEEF);
    bool active;

    function setUp() public {
        string memory url = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            console2.log("");
            console2.log("  !! V4 FORK TESTS SKIPPED - nothing was verified on-chain");
            console2.log("     run ./script/fork_test.sh");
            console2.log("");
            return;
        }
        uint256 pinned = vm.envOr("FORK_BLOCK", uint256(0));
        if (pinned > 0) vm.createSelectFork(url, pinned);
        else vm.createSelectFork(url);
        active = true;

        exec = new SwapExecutor(address(this), address(this), 0, WETH);
        adapter = new UniswapV4Adapter(POOL_MANAGER, WETH, address(exec));
        exec.setAdapterAllowed(address(adapter), true);
    }

    function _initialised(uint24 fee, int24 spacing) internal view returns (bool) {
        bytes32 id = keccak256(abi.encode(address(0), USDC, fee, spacing, address(0)));
        try IStateViewLike(STATE_VIEW).getSlot0(id) returns (uint160 p, int24, uint24, uint24) {
            return p != 0;
        } catch {
            return false;
        }
    }

    function _swapOnce(uint24 fee, int24 spacing) internal {
        uint256 amt = 0.001 ether;
        vm.deal(user, 1 ether);
        vm.startPrank(user);
        IWethLike(WETH).deposit{value: amt}();
        IWethLike(WETH).approve(address(exec), amt);

        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](1);
        steps[0] = SwapExecutor.SwapStep({
            kind: 5, router: address(adapter), tokenIn: WETH, tokenOut: USDC,
            feeTier: fee, stable: true /* WETH side is native ETH */,
            poolFactory: address(0) /* no hooks */, tickSpacing: spacing
        });
        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0] = SwapExecutor.RoutePart({steps: steps, amountIn: amt});

        uint256 usdcBefore = IUsdcLike(USDC).balanceOf(user);
        uint256 out = exec.executeSwap(WETH, USDC, amt, 1, parts, block.timestamp + 300);
        vm.stopPrank();

        assertGt(out, 0, "no USDC out");
        assertEq(IUsdcLike(USDC).balanceOf(user) - usdcBefore, out, "user did not receive the reported output");
        console2.log("    0.001 WETH ->", out, "USDC (6 decimals)");

        assertEq(IWethLike(WETH).balanceOf(address(exec)), 0, "exec WETH");
        assertEq(IUsdcLike(USDC).balanceOf(address(exec)), 0, "exec USDC");
        assertEq(address(exec).balance, 0, "exec ETH");
        assertEq(IWethLike(WETH).balanceOf(address(adapter)), 0, "adapter WETH");
        assertEq(IUsdcLike(USDC).balanceOf(address(adapter)), 0, "adapter USDC");
        assertEq(address(adapter).balance, 0, "adapter ETH");
    }

    function testNativeEthUsdcThroughExecutorAndAdapter() public {
        if (!active) return;
        uint24[2] memory fees = [uint24(500), uint24(3000)];
        int24[2] memory spacings = [int24(10), int24(60)];
        uint256 ran;
        for (uint256 i = 0; i < 2; i++) {
            if (!_initialised(fees[i], spacings[i])) {
                console2.log("  v4 key SKIPPED (pool not initialised): fee", uint256(fees[i]));
                continue;
            }
            console2.log("  v4 key RAN: fee", uint256(fees[i]));
            _swapOnce(fees[i], spacings[i]);
            ran++;
        }
        console2.log("  v4 keys that ran:", ran, "of 2");
        assertGt(ran, 0, "no initialised ETH/USDC v4 pool among the tried keys");
    }
}
