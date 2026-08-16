// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SwapExecutor.sol";
import "./Mocks.sol";

/**
 * The two defects found in the deployed contract.
 *
 * Both tests here must fail against the contract *before* the fix and pass after
 * it. If one of them is green on the old version too, that test proves nothing.
 */
contract SwapExecutorV3Test is Test {
    SwapExecutor exec;
    MockERC20 tokenIn;
    MockERC20 tokenOut;
    MockFeeToken feeOut;          // fee-on-transfer output token
    MockV2Router router;
    MockWETH weth;

    address owner    = address(0xA11CE);
    address feeSink  = address(0xFEE5);
    address user     = address(0xB0B);

    function setUp() public {
        weth     = new MockWETH();
        tokenIn  = new MockERC20("In",  "IN",  18);
        tokenOut = new MockERC20("Out", "OUT", 18);
        feeOut   = new MockFeeToken(500);              // 5% transfer fee
        router   = new MockV2Router();

        exec = new SwapExecutor(owner, feeSink, 0, address(weth));

        address[] memory rs = new address[](1);
        rs[0] = address(router);
        vm.prank(owner);
        exec.setRoutersAllowed(rs, true);
    }

    function _oneStep(address a, address b)
        internal view returns (SwapExecutor.SwapStep memory s)
    {
        s.kind = 0;                 // V2
        s.router = address(router);
        s.tokenIn = a;
        s.tokenOut = b;
    }

    // ---------------------------------------------------------------
    // 1) Rounding dust must not stay in the contract
    //
    // When the protocol fee is non-zero, swapAmount no longer equals
    // totalAmountIn and each leg's share is rounded down. The shares then sum
    // to less than the balance and the remainder is left behind.
    //
    // The fee is switched on deliberately: with a zero fee the division is
    // exact, this test would pass against the broken contract too, and it
    // would prove nothing.
    // ---------------------------------------------------------------
    function test_splitOrderLeavesNoDust() public {
        vm.prank(owner);
        exec.setFee(30);                       // 0.3%, so swapAmount != totalAmountIn

        uint256 total = 1000;
        tokenIn.mint(user, total);
        vm.prank(user);
        tokenIn.approve(address(exec), total);

        // shares that do not divide evenly into the total
        uint256[3] memory shares = [uint256(333), 333, 334];
        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](3);
        for (uint256 i = 0; i < 3; i++) {
            SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](1);
            steps[0] = _oneStep(address(tokenIn), address(tokenOut));
            parts[i].steps = steps;
            parts[i].amountIn = shares[i];
        }

        vm.prank(user);
        exec.executeSwap(address(tokenIn), address(tokenOut), total, 1, parts,
                         block.timestamp + 60);

        assertEq(
            tokenIn.balanceOf(address(exec)), 0,
            "rounding dust from the split stayed in the contract - it belongs to the user"
        );
    }

    // ---------------------------------------------------------------
    // 2) minAmountOut must measure what reaches the user's wallet
    //
    // With a fee-on-transfer output token the contract receives X and the user
    // receives X minus 5%. If the check runs against the contract's balance,
    // a swap with minOut = X succeeds while the user got less - the slippage
    // guard silently stopped guarding.
    // ---------------------------------------------------------------
    function test_minOutMeasuresWhatTheUserReceives() public {
        uint256 amount = 1000;
        tokenIn.mint(user, amount);
        vm.prank(user);
        tokenIn.approve(address(exec), amount);

        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](1);
        steps[0] = _oneStep(address(tokenIn), address(feeOut));
        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0].steps = steps;
        parts[0].amountIn = amount;

        // the router pays 2x, so the contract receives 2000 and the user 1900
        uint256 reachesContract = amount * 2;

        vm.prank(user);
        vm.expectRevert(bytes("slippage: output below minimum"));
        exec.executeSwap(address(tokenIn), address(feeOut), amount,
                         reachesContract, parts, block.timestamp + 60);
    }

    /// and the same swap must still go through at the minimum that is actually achievable
    function test_feeOnTransferOutputStillSwapsAtTheRightMinimum() public {
        uint256 amount = 1000;
        tokenIn.mint(user, amount);
        vm.prank(user);
        tokenIn.approve(address(exec), amount);

        SwapExecutor.SwapStep[] memory steps = new SwapExecutor.SwapStep[](1);
        steps[0] = _oneStep(address(tokenIn), address(feeOut));
        SwapExecutor.RoutePart[] memory parts = new SwapExecutor.RoutePart[](1);
        parts[0].steps = steps;
        parts[0].amountIn = amount;

        uint256 delivered = (amount * 2 * 9500) / 10_000;   // 2000 minus 5%

        vm.prank(user);
        uint256 got = exec.executeSwap(address(tokenIn), address(feeOut), amount,
                                       delivered, parts, block.timestamp + 60);

        assertEq(feeOut.balanceOf(user), delivered, "user did not receive what we promised");
        assertEq(got, delivered, "the return value must be what the user got, not what we held");
    }
}
