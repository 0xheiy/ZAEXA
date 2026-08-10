// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SwapExecutor.sol";

/*
 * تست سلکتور — ارزان‌ترین تستی که باگ مین‌نت را می‌گرفت.
 * ==========================================================================
 *
 * داستان: قرارداد ساختار ExactInputSingleParams را با فیلد `deadline` اعلام
 * کرده بود. اما SwapRouter02 (که Base و اکثر شبکه‌ها استفاده می‌کنند) آن فیلد
 * را ندارد. چون سلکتور از روی *شکل* ساختار ساخته می‌شود، فراخوانی ما به تابعی
 * می‌رفت که در روتر وجود نداشت و EVM بدون هیچ داده‌ای revert می‌کرد.
 *
 * ۲۷ تست ماک‌محور این را نگرفتند، چون ماک هم همان ساختار غلط را پیاده کرده بود.
 *
 * این تست به شبکه نیاز ندارد و در چند میلی‌ثانیه اجرا می‌شود: فقط ثابت می‌کند
 * سلکتوری که اینترفیس‌های ما تولید می‌کنند دقیقاً همان‌هایی است که یونی‌سواپ
 * منتشر کرده. اگر کسی روزی فیلدی به این ساختارها اضافه یا کم کند، اینجا قرمز
 * می‌شود — نه سه هفته بعد روی مین‌نت با پول واقعی.
 *
 * مقادیر مرجع (قابل بازتولید با `cast sig`):
 *   exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
 *     = 0x04e45aaf   ← SwapRouter02
 *   exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
 *     = 0x414bf389   ← SwapRouter نسل اول
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

    /// دو نسل باید سلکتور *متفاوت* داشته باشند — وگرنه کل تفکیک بی‌معناست
    function testTheTwoGenerationsDiffer() public pure {
        assertTrue(
            IUniswapV3Router02.exactInputSingle.selector
                != IUniswapV3Router01.exactInputSingle.selector,
            "the two router generations must not collide"
        );
    }

    function testSolidlySelectorMatchesAerodrome() public pure {
        // getAmountsOut... در واقع اینجا تابع سواپ مهم است
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
