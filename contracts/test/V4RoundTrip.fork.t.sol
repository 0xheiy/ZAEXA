// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "forge-std/console2.sol";
import "../src/V4RoundTrip.sol";

interface IRtStateView {
    function getSlot0(bytes32 poolId)
        external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}

/*
 * Fork test for the buy -> sell round-trip helper, against the real v4
 * PoolManager on Base. Same pattern as UniswapV4Adapter.fork.t.sol: run it with
 * script/fork_test.sh (pinned block, local anvil); it needs BASE_RPC_URL and
 * skips loudly without it.
 *
 * Pool: native ETH (currency0 = address(0)) / USDC (currency1), hookless, which
 * is the pool the adapter's fork test already swaps on at this pinned block. It
 * has two-sided liquidity, so both legs must fill and ethBack must be > 0 and
 * close to ethIn (two fees plus price impact on 0.01 ETH). A key whose pool is
 * not initialised is skipped and the log says so; if no key ran the test fails.
 */
contract V4RoundTripForkTest is Test {
    address constant STATE_VIEW = 0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71;
    address constant USDC       = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    V4RoundTrip rt;
    bool active;

    function setUp() public {
        string memory url = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            console2.log("");
            console2.log("  !! V4 ROUND-TRIP FORK TESTS SKIPPED - nothing was verified on-chain");
            console2.log("     run ./script/fork_test.sh");
            console2.log("");
            return;
        }
        uint256 pinned = vm.envOr("FORK_BLOCK", uint256(0));
        if (pinned > 0) vm.createSelectFork(url, pinned);
        else vm.createSelectFork(url);
        active = true;
        rt = new V4RoundTrip();
        vm.deal(address(rt), 1 ether);
    }

    function _initialised(uint24 fee, int24 spacing) internal view returns (bool) {
        bytes32 id = keccak256(abi.encode(address(0), USDC, fee, spacing, address(0)));
        try IRtStateView(STATE_VIEW).getSlot0(id) returns (uint160 p, int24, uint24, uint24) {
            return p != 0;
        } catch {
            return false;
        }
    }

    function testRealEthUsdcPoolBothLegsFill() public {
        if (!active) return;
        uint24[2] memory fees = [uint24(500), uint24(3000)];
        int24[2] memory spacings = [int24(10), int24(60)];
        uint256 ran;
        uint256 ethIn = 0.01 ether;
        for (uint256 i = 0; i < 2; i++) {
            if (!_initialised(fees[i], spacings[i])) {
                console2.log("  v4 key SKIPPED (pool not initialised): fee", uint256(fees[i]));
                continue;
            }
            V4PoolKey memory k = V4PoolKey({
                currency0: address(0), currency1: USDC, fee: fees[i], tickSpacing: spacings[i], hooks: address(0)
            });
            uint256 balBefore = address(rt).balance;
            (uint256 tokensOut, uint256 ethBack) = rt.roundTrip(k, true, ethIn);
            console2.log("  v4 key RAN: fee", uint256(fees[i]));
            console2.log("    USDC out (6 dec):", tokensOut);
            console2.log("    ETH back (wei):  ", ethBack);
            assertGt(tokensOut, 0, "buy leg gave no USDC");
            assertGt(ethBack, 0, "sell leg gave no ETH");
            assertLe(ethBack, ethIn, "round trip cannot make money");
            assertGt(ethBack, ethIn * 9 / 10, "round trip lost more than 10% on a deep pool");
            assertEq(address(rt).balance, balBefore - ethIn + ethBack, "ETH accounting");
            ran++;
        }
        console2.log("  v4 keys that ran:", ran, "of 2");
        assertGt(ran, 0, "no initialised ETH/USDC v4 pool among the tried keys");
    }
}
