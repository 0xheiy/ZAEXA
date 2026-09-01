// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SwapExecutor.sol";

/*
 * Selector test - the cheapest test that would have caught the mainnet bug.
 * ==========================================================================
 *
 * The story: the contract declared the ExactInputSingleParams struct with a
 * `deadline` field. But SwapRouter02 (the one Base and most networks use) does
 * not have that field. Since the selector is derived from the *shape* of the
 * struct, our call went to a function that did not exist on the router, and the
 * EVM reverted with no data at all.
 *
 * 27 mock-based tests did not catch this, because the mock implemented the same
 * wrong struct.
 *
 * This test needs no network and runs in a few milliseconds: it only proves that
 * the selectors our interfaces produce are exactly the ones Uniswap published.
 * If someone ever adds or removes a field in these structs, it goes red here -
 * not three weeks later on mainnet with real money.
 *
 * Reference values (reproducible with `cast sig`):
 *   exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
 *     = 0x04e45aaf   <- SwapRouter02
 *   exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
 *     = 0x414bf389   <- first-generation SwapRouter
 *   exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))
 *     = 0xa026383e   <- Aerodrome Slipstream. Same eight-field shape as the
 *                        first-generation router, `int24 tickSpacing` instead of
 *                        `uint24 fee` - and yet a different selector. This is the
 *                        one that would have let Slipstream get folded into
 *                        KIND_V3_LEGACY by mistake.
 */
contract SelectorTest is Test {

    function testV3SelectorMatchesSwapRouter02() public pure {
        assertEq(
            IUniswapV3Router02.exactInputSingle.selector,
            bytes4(0x04e45aaf),
            "KIND_V3 must target SwapRouter02 (no deadline field)"
        );
    }

    function testLegacyV3SelectorMatchesSwapRouter01() public pure {
        assertEq(
            IUniswapV3Router01.exactInputSingle.selector,
            bytes4(0x414bf389),
            "KIND_V3_LEGACY must target the original SwapRouter (with deadline)"
        );
    }

    /// The two generations must have *different* selectors - otherwise the whole split is
    /// pointless
    function testTheTwoGenerationsDiffer() public pure {
        assertTrue(
            IUniswapV3Router02.exactInputSingle.selector
                != IUniswapV3Router01.exactInputSingle.selector,
            "the two router generations must not collide"
        );
    }

    function testSlipstreamSelectorMatchesAerodromeCL() public pure {
        assertEq(
            ISlipstreamRouter.exactInputSingle.selector,
            bytes4(0xa026383e),
            "KIND_SLIPSTREAM must target Aerodrome Slipstream's CL router"
        );
    }

    /// Same eight-field shape as the legacy router, but the selectors must not collide -
    /// this is exactly the trap that makes a separate KIND_SLIPSTREAM mandatory.
    function testSlipstreamAndLegacyV3SelectorsDiffer() public pure {
        assertTrue(
            ISlipstreamRouter.exactInputSingle.selector
                != IUniswapV3Router01.exactInputSingle.selector,
            "Slipstream must not collide with the legacy SwapRouter despite the identical shape"
        );
    }

    function testSolidlySelectorMatchesAerodrome() public pure {
        // Aerodrome is Solidly-style: the route is an array of structs, not a plain
        // address path. That struct shape is part of the selector, so it is what can
        // silently break us.
        assertEq(
            ISolidlyRouter.swapExactTokensForTokens.selector,
            bytes4(keccak256(
                "swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)"
            )),
            "Solidly route struct shape changed"
        );
    }

    function testV2SelectorMatchesUniswapV2() public pure {
        assertEq(
            IUniswapV2Router.swapExactTokensForTokens.selector,
            bytes4(keccak256(
                "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"
            )),
            "UniswapV2 swapExactTokensForTokens shape changed"
        );
    }
}
