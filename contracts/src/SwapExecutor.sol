// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * SwapExecutor
 * ============
 * Executes a routing plan - split orders and multi-hop paths - in a single transaction.
 *
 * WARNING - the single most important security decision in this contract:
 *
 *    Many aggregator routers accept arbitrary calldata from the caller and
 *    forward it to an arbitrary address. That pattern has a well known, serious
 *    flaw: anyone who has approved the contract can be drained, because an
 *    attacker can craft calldata that calls transferFrom on *them*.
 *
 *    So, here:
 *      - no arbitrary calldata is ever accepted; the contract builds every call
 *      - only whitelisted routers can be used
 *      - output is measured from the *actual balance*, never from the router's return value
 *
 * Other protections:
 *      - reentrancy guard
 *      - deadline, so a stale transaction cannot execute later
 *      - hard fee ceiling the owner cannot raise past
 *      - the contract holds no user funds between transactions
 *
 * WHAT THE OWNER KEY CAN STILL DO - stated because the list above reads like a
 * complete account of the trust model, and without these four it is not:
 *
 *      - `_ensureApproval` grants a whitelisted router `type(uint256).max` on a
 *        token. The bound is real - the contract holds nothing between calls and
 *        a router's allowance cannot touch a user's approval to this contract -
 *        but within a single transaction a whitelisted router that is later
 *        compromised can take the in-flight amount. The only backstop is the
 *        caller's `minAmountOut`, because every individual step deliberately
 *        passes `amountOutMinimum: 0`.
 *      - `setRouterAllowed` / `setRoutersAllowed` are single-EOA calls with no
 *        timelock, so the allow-list is exactly as strong as one key.
 *      - `rescue` / `rescueETH` move whatever the contract is holding to the
 *        owner. They now emit, so the action is at least observable.
 *      - `setAdapterAllowed` / `setAdaptersAllowed` are likewise single-EOA calls
 *        with no timelock. A registered adapter (KIND_ADAPTER) receives the
 *        in-flight amount of a step outright, so a malicious or compromised
 *        adapter can keep it - the same bound that already applies to a
 *        compromised whitelisted router, and again the only backstop is the
 *        caller's `minAmountOut`. The compensating fact: an adapter never
 *        receives an allowance, so unlike a router its reach ends when the call
 *        ends - it can only take what was physically handed to it.
 *
 * NOTE: this contract has not been formally audited. Independent review and
 *    thorough testing are required before using it with meaningful size.
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/*
 * WARNING - there are, by now, THREE router input-struct shapes this contract
 * has to tell apart:
 *   SwapRouter   (first gen)  - eight-field struct, includes `deadline`
 *                               fee is `uint24`; selector: 0x414bf389
 *   SwapRouter02 (second gen) - seven-field struct, no `deadline`
 *                               fee is `uint24`; selector: 0x04e45aaf
 *   Slipstream (Aerodrome CL) - eight-field struct, includes `deadline`,
 *                               same shape as the first generation except the
 *                               fee-like field is `int24 tickSpacing`, not
 *                               `uint24 fee`; selector: 0xa026383e
 *
 * The selector is derived from the struct shape, so sending the wrong struct means
 * calling a function that *does not exist* on the router - and the EVM reverts with
 * no data at all ("missing revert data"). The first version of this contract only
 * knew the first generation, while Base uses SwapRouter02. See the warning above
 * `ISlipstreamRouter` below for why the third shape needs its own branch too,
 * despite looking, at a glance, like the first generation.
 *
 * So all three are declared, and `kind` selects between them.
 */
interface IUniswapV3Router02 {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256);
}

interface IUniswapV3Router01 {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path,
        address to, uint256 deadline
    ) external returns (uint256[] memory);
}

interface ISolidlyRouter {
    struct Route { address from; address to; bool stable; address factory; }
    function swapExactTokensForTokens(
        uint256 amountIn, uint256 amountOutMin, Route[] calldata routes,
        address to, uint256 deadline
    ) external returns (uint256[] memory);
}

/*
 * WARNING - the central trap of this interface: Aerodrome Slipstream's
 * ExactInputSingleParams struct has the SAME EIGHT-FIELD SHAPE as the first-gen
 * SwapRouter (IUniswapV3Router01 above), including the `deadline` field - the
 * only structural difference is `int24 tickSpacing` where the legacy struct has
 * `uint24 fee`. For every positive value the two encode identically byte for
 * byte, but the function SELECTOR differs (0xa026383e here vs 0x414bf389 for the
 * legacy router), because the selector is derived from the declared type name,
 * not merely its width. Anyone tempted to reuse KIND_V3_LEGACY for Slipstream
 * because "the shape matches" will build calldata that targets a function which
 * does not exist on the Slipstream router, and the call reverts with no data at
 * all. A separate branch (KIND_SLIPSTREAM) is mandatory - see
 * SwapExecutor.v5.t.sol:testSlipstreamKindAgainstLegacyOnlyRouterReverts, which
 * pins exactly this trap.
 */
interface ISlipstreamRouter {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; int24 tickSpacing; address recipient;
        uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256);
}

/*
 * Contract adapters must honour a small contract, since the executor grants
 * them no allowance and trusts them for exactly one inbound transfer:
 *   - the executor transfers `amountIn` of tokenIn to the adapter BEFORE
 *     calling swap; no allowance is ever granted
 *   - for fee-on-transfer tokens the adapter must trade its own actual
 *     balance, not the nominal `amountIn` it was told about
 *   - the adapter must send the output to `recipient`; the return value is
 *     ignored because output is measured as a balance difference at the
 *     executor, the same way every router call is measured
 *   - anything the adapter fails to send back is simply lost to that adapter -
 *     the order-level `minAmountOut` is what protects the user, not this
 *     interface
 */
interface IZaexaAdapter {
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24  feeTier,
        int24   tickSpacing,
        bool    stable,
        address poolFactory,
        address recipient
    ) external;
}


contract SwapExecutor {

    uint8 constant KIND_V2 = 0;
    uint8 constant KIND_V3 = 1;          // SwapRouter02 - today's standard (Base and most chains)
    uint8 constant KIND_SOLIDLY = 2;
    uint8 constant KIND_V3_LEGACY = 3;   // first-gen SwapRouter, with the deadline field
    uint8 constant KIND_SLIPSTREAM = 4;  // Aerodrome Slipstream (CL) - keyed on tickSpacing, not fee
    uint8 constant KIND_ADAPTER = 5;     // owner-registered adapter contract
    uint8 constant KIND_MAX = 5;

    /// Hard fee ceiling: 1%. Not even the owner can go above this.
    uint256 public constant MAX_FEE_BPS = 100;

    struct SwapStep {
        uint8   kind;
        address router;       // for KIND_ADAPTER this is the adapter address, not a router
        address tokenIn;
        address tokenOut;
        uint24  feeTier;      // V3 only
        bool    stable;       // Solidly only
        address poolFactory;  // Solidly only
        int24   tickSpacing;  // Slipstream only
    }

    /// One leg of a split order: a path (one or more steps) with its own amount
    struct RoutePart {
        SwapStep[] steps;
        uint256 amountIn;
    }

    /// The chain's wrapped native token (WETH on Base). Immutable.
    address public immutable WETH;
    /// In tokenIn/tokenOut, address(0) means "native ETH"
    address constant NATIVE = address(0);

    address public owner;
    address public pendingOwner;
    address public feeRecipient;
    uint256 public feeBps;                       // current fee
    mapping(address => bool) public allowedRouter;   // router whitelist
    mapping(address => bool) public allowedAdapter;  // adapter whitelist - separate from allowedRouter

    bool private _locked;

    /// @param fee the fee taken - always denominated in tokenIn, never tokenOut
    event Swapped(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );
    event RouterAllowed(address indexed router, bool allowed);
    event AdapterAllowed(address indexed adapter, bool allowed);
    event FeeChanged(uint256 oldBps, uint256 newBps);
    event FeeRecipientChanged(address indexed oldTo, address indexed newTo);
    event OwnerChanged(address indexed oldOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed oldOwner, address indexed pendingOwner);
    event ApprovalRevoked(address indexed token, address indexed router);
    /* Rescue used to be the only privileged action that left no on-chain trace.
       Every other owner power already emits; these two did not, which made owner
       withdrawals the one thing a reader could not reconstruct from logs. */
    event Rescued(address indexed token, address indexed to, uint256 amount);
    event RescuedETH(address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier nonReentrant() {
        require(!_locked, "reentrant");
        _locked = true;
        _;
        _locked = false;
    }

    constructor(address _owner, address _feeRecipient, uint256 _feeBps, address _weth) {
        require(_owner != address(0), "zero owner");
        require(_weth != address(0), "zero weth");
        require(_feeBps <= MAX_FEE_BPS, "fee too high");
        WETH = _weth;
        owner = _owner;
        feeRecipient = _feeRecipient == address(0) ? _owner : _feeRecipient;
        feeBps = _feeBps;
    }

    /// Only WETH may send ETH here, during withdraw. Nobody else.
    receive() external payable {
        require(msg.sender == WETH, "only weth");
    }

    // -------------------------------------------------------------------
    // Swap execution
    //
    // Native ETH: pass the zero address as tokenIn or tokenOut.
    //    native in  -> send ETH as msg.value; the contract wraps it itself
    //                  (so neither an approval nor a separate transaction is needed)
    //    native out -> the contract unwraps after the swap and sends real ETH
    //    Result: "USDC to ETH" costs one signature, not two.
    // -------------------------------------------------------------------
    function executeSwap(
        address tokenIn,
        address tokenOut,
        uint256 totalAmountIn,
        uint256 minAmountOut,
        RoutePart[] calldata parts,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 amountOut) {
        require(block.timestamp <= deadline, "deadline passed");
        require(totalAmountIn > 0, "zero amount");
        require(parts.length > 0 && parts.length <= 5, "bad parts count");

        // Routing always works in the wrapped token; native is only a wrapper.
        // NOTE: tokenIn == tokenOut is deliberately allowed (a loop route). The
        //    interface's "exit simulation" relies on it, as does two-pool arbitrage.
        address inTok  = tokenIn  == NATIVE ? WETH : tokenIn;
        address outTok = tokenOut == NATIVE ? WETH : tokenOut;

        // Validation and execution are deliberately separate functions.
        //    With everything in one function, the loop counters and temporaries pushed
        //    it past the EVM's 16-slot stack limit ("stack too deep").
        _validatePlan(parts, inTok, outTok, totalAmountIn);

        uint256 fee;
        uint256 swapAmount;
        {
            uint256 received;
            if (tokenIn == NATIVE) {
                // ETH arrived with the transaction - wrap it, then proceed as ERC-20
                require(msg.value == totalAmountIn, "value != amountIn");
                IWETH(WETH).deposit{value: msg.value}();
                received = msg.value;
            } else {
                require(msg.value == 0, "unexpected value");
                // Measure what actually arrived, so fee-on-transfer tokens work too
                uint256 balBefore = IERC20(inTok).balanceOf(address(this));
                _safeTransferFrom(inTok, msg.sender, address(this), totalAmountIn);
                received = IERC20(inTok).balanceOf(address(this)) - balBefore;
            }
            require(received > 0, "nothing received");

            // --- the fee is taken from the *input* token ---
            // Why input and not output? Users usually start from a token that is worth
            //    something and move toward an unknown one. A fee taken in the output
            //    token could be worthless, or unsellable, tomorrow.
            if (feeBps > 0 && feeRecipient != address(0)) {
                fee = (received * feeBps) / 10_000;
                if (fee > 0) {
                    _safeTransfer(inTok, feeRecipient, fee);
                }
            }
            swapAmount = received - fee;
            require(swapAmount > 0, "amount too small after fee");
        }

        {
            uint256 outBefore = IERC20(outTok).balanceOf(address(this));
            // On a loop route (same token in and out) the amount about to be spent is
            //    already part of the balance. Without subtracting it up front, the final
            //    difference underflows and the transaction panics.
            if (inTok == outTok) {
                outBefore -= swapAmount;
            }

            _runParts(parts, swapAmount, totalAmountIn);

            // Output is measured from the *actual* balance, not the router's return value
            amountOut = IERC20(outTok).balanceOf(address(this)) - outBefore;
        }
        /* Slippage protection must be measured on what reaches the *user's wallet*,
           not on what reached the contract. For a fee-on-transfer output token these
           are not the same: the contract receives X, the user receives X minus the
           transfer fee. The check used to run against X, so minAmountOut could hold
           while the user got less than they were promised - meaning the very guard
           that exists for this silently stopped working.

           Native ETH has no transfer fee, so there the number is unchanged.

           The balance delta is clamped at zero, and that clamp is load bearing.
           Measuring the recipient assumes the recipient is passive, and a smart
           contract wallet does not have to be: one that sweeps or forwards inside
           its receive hook ends the call with a balance at or *below* the one we
           recorded. Under 0.8.x an unguarded subtraction there is an arithmetic
           panic (0x11), not a revert string - so the whole swap failed with no
           usable message, for exactly the callers most likely to reach an
           aggregator programmatically. Clamped, the require below still fails
           closed on a genuine shortfall, but it fails with the error that
           explains itself. The clamp only turns an arithmetic panic into a
           readable revert - it does not relax the guard itself: when
           `minAmountOut > 0` a wallet that moved its own funds onward is still,
           correctly, blocked by the requirement below. Only a caller who passed
           `minAmountOut == 0` - meaning they asked for no guarantee at all -
           passes through instead of reverting.
           The ERC-20 branch has the same shape via a recipient hook. */
        uint256 delivered;
        if (tokenOut == NATIVE) {
            // Unwrap and send real ETH - no second transaction
            IWETH(WETH).withdraw(amountOut);
            uint256 ethBefore = msg.sender.balance;
            (bool sent, ) = msg.sender.call{value: amountOut}("");
            require(sent, "eth transfer failed");
            uint256 ethAfter = msg.sender.balance;
            delivered = ethAfter > ethBefore ? ethAfter - ethBefore : 0;
        } else {
            uint256 userBefore = IERC20(outTok).balanceOf(msg.sender);
            _safeTransfer(outTok, msg.sender, amountOut);
            uint256 userAfter = IERC20(outTok).balanceOf(msg.sender);
            delivered = userAfter > userBefore ? userAfter - userBefore : 0;
        }
        require(delivered >= minAmountOut, "slippage: output below minimum");

        // What was *actually delivered* is logged, not what the caller asked for.
        // For fee-on-transfer tokens these differ, and v1 logged the larger number.
        emit Swapped(msg.sender, tokenIn, tokenOut, swapAmount + fee, delivered, fee);
        amountOut = delivered;
    }

    /// Full validation of the plan - before any asset moves
    function _validatePlan(
        RoutePart[] calldata parts,
        address inTok,
        address outTok,
        uint256 totalAmountIn
    ) internal view {
        uint256 sum = 0;
        for (uint256 i = 0; i < parts.length; i++) {
            RoutePart calldata p = parts[i];
            require(p.amountIn > 0, "zero part");
            require(p.steps.length > 0 && p.steps.length <= 3, "bad steps");
            require(p.steps[0].tokenIn == inTok, "part must start at tokenIn");
            require(p.steps[p.steps.length - 1].tokenOut == outTok, "part must end at tokenOut");

            for (uint256 j = 0; j < p.steps.length; j++) {
                SwapStep calldata s = p.steps[j];
                require(s.kind <= KIND_MAX, "bad kind");
                // Critical: whitelisted routers only. This is what blocks call injection.
                // The adapter list is a *separate* whitelist and is equally mandatory -
                // an address allowed on one list must never be usable through the other.
                if (s.kind == KIND_ADAPTER) {
                    require(allowedAdapter[s.router], "adapter not allowed");
                } else {
                    require(allowedRouter[s.router], "router not allowed");
                }
                if (s.kind == KIND_SLIPSTREAM) {
                    require(s.tickSpacing > 0, "bad tick spacing");
                }
                require(s.tokenIn != s.tokenOut, "step same token");
                if (j > 0) {
                    require(s.tokenIn == p.steps[j-1].tokenOut, "steps not chained");
                }
            }
            sum += p.amountIn;
        }
        require(sum == totalAmountIn, "parts sum mismatch");
    }

    /// Runs the legs of the order. Each leg's share is computed against the net
    /// amount, so both the protocol fee and fee-on-transfer tokens are accounted for.
    function _runParts(
        RoutePart[] calldata parts,
        uint256 swapAmount,
        uint256 totalAmountIn
    ) internal {
        uint256 spent = 0;
        for (uint256 i = 0; i < parts.length; i++) {
            RoutePart calldata p = parts[i];
            /* Integer division rounds each leg down, so the shares always summed to
               slightly less than swapAmount and the remainder stayed in the contract.
               The amount is tiny, but it belongs to the user, and it accumulates over
               thousands of swaps.

               The last leg takes whatever is left. The sum of p.amountIn equals
               totalAmountIn exactly (guaranteed in _validatePlan), so this is always
               positive and at most a few wei above its nominal share. */
            uint256 amt = i + 1 == parts.length
                ? swapAmount - spent
                : (p.amountIn * swapAmount) / totalAmountIn;
            spent += amt;
            // v1 called `continue` here: that leg's share was never spent, yet we had
            // already taken the user's money and it was stuck. Silence is the worst option.
            require(amt > 0, "part rounds to zero");
            for (uint256 j = 0; j < p.steps.length; j++) {
                amt = _swap(p.steps[j], amt);
                require(amt > 0, "zero step output");
            }
        }
    }

    // -------------------------------------------------------------------
    /**
     * Runs one step and reports how much *actually* arrived.
     *
     * The output is read as a balance difference, not from the router's return value.
     *    v1 trusted the router's number. For fee-on-transfer tokens the two differ:
     *    the router says it sent 1000, 980 arrives, and the next step asks for 1000 -
     *    which either eats into the contract's leftovers or reverts. And those are exactly the
     *    tokens users come to the Exit check to inspect.
     *
     * The adapter path (KIND_ADAPTER) is strictly TIGHTER than the router path, not
     *    merely different. A router receives `type(uint256).max` approval via
     *    `_ensureApproval` and can pull from that allowance on any call for as long as
     *    it stands. An adapter receives no allowance at all: it is handed exactly the
     *    in-flight amount by a direct transfer, and once that transfer completes it
     *    holds no standing permission over this contract's tokens whatsoever.
     *
     * Reading `outBefore` before the transfer/approval below is safe because
     *    `_validatePlan` already forbids `s.tokenIn == s.tokenOut` on any step, so the
     *    outgoing transfer can never move the very balance being measured.
     */
    function _swap(SwapStep calldata s, uint256 amountIn) internal returns (uint256) {
        uint256 outBefore = IERC20(s.tokenOut).balanceOf(address(this));
        if (s.kind == KIND_ADAPTER) {
            _safeTransfer(s.tokenIn, s.router, amountIn);
            IZaexaAdapter(s.router).swap(
                s.tokenIn, s.tokenOut, amountIn, s.feeTier, s.tickSpacing,
                s.stable, s.poolFactory, address(this));
        } else {
            _ensureApproval(s.tokenIn, s.router, amountIn);
            _callRouter(s, amountIn);
        }
        return IERC20(s.tokenOut).balanceOf(address(this)) - outBefore;
    }

    /// Router call only. The return value is deliberately ignored.
    function _callRouter(SwapStep calldata s, uint256 amountIn) internal {
        if (s.kind == KIND_V3) {
            // SwapRouter02 - no deadline. Time protection lives at the executeSwap level.
            IUniswapV3Router02(s.router).exactInputSingle(
                IUniswapV3Router02.ExactInputSingleParams({
                    tokenIn: s.tokenIn, tokenOut: s.tokenOut, fee: s.feeTier,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: 0,        // the real check happens once, on the whole order
                    sqrtPriceLimitX96: 0
                })
            );
            return;
        }

        if (s.kind == KIND_V3_LEGACY) {
            IUniswapV3Router01(s.router).exactInputSingle(
                IUniswapV3Router01.ExactInputSingleParams({
                    tokenIn: s.tokenIn, tokenOut: s.tokenOut, fee: s.feeTier,
                    recipient: address(this), deadline: block.timestamp,
                    amountIn: amountIn,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
            return;
        }

        if (s.kind == KIND_SLIPSTREAM) {
            ISlipstreamRouter(s.router).exactInputSingle(
                ISlipstreamRouter.ExactInputSingleParams({
                    tokenIn: s.tokenIn, tokenOut: s.tokenOut, tickSpacing: s.tickSpacing,
                    recipient: address(this), deadline: block.timestamp,
                    amountIn: amountIn,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
            return;
        }

        if (s.kind == KIND_SOLIDLY) {
            ISolidlyRouter.Route[] memory routes = new ISolidlyRouter.Route[](1);
            routes[0] = ISolidlyRouter.Route({
                from: s.tokenIn, to: s.tokenOut,
                stable: s.stable, factory: s.poolFactory
            });
            ISolidlyRouter(s.router).swapExactTokensForTokens(
                amountIn, 0, routes, address(this), block.timestamp);
            return;
        }

        // KIND_V2 is spelled out rather than left as an implicit else - clearer and safer
        require(s.kind == KIND_V2, "unknown kind");
        address[] memory path = new address[](2);
        path[0] = s.tokenIn;
        path[1] = s.tokenOut;
        IUniswapV2Router(s.router).swapExactTokensForTokens(
            amountIn, 0, path, address(this), block.timestamp);
    }

    function _ensureApproval(address token, address spender, uint256 needed) internal {
        uint256 current = IERC20(token).allowance(address(this), spender);
        // v1 compared against `> type(uint128).max`. Tokens that store allowances in
        // uint96 (COMP/UNI style) never reach that threshold, so every step paid for two
        // extra SSTOREs. Comparing against "how much do we actually need" is both more
        // correct and cheaper.
        if (current >= needed) {
            return;
        }

        // Some tokens (USDT among them) refuse a direct change of a non-zero allowance.
        // But this reset is only needed when the current allowance is not already zero -
        // which costs less gas, and means we no longer have to ignore a return value.
        if (current != 0) {
            (bool resetOk, bytes memory rd) = token.call(
                abi.encodeWithSelector(IERC20.approve.selector, spender, 0));
            require(resetOk && (rd.length == 0 || abi.decode(rd, (bool))),
                    "approve reset failed");
        }

        (bool ok, bytes memory d) = token.call(
            abi.encodeWithSelector(IERC20.approve.selector, spender, type(uint256).max));
        require(ok && (d.length == 0 || abi.decode(d, (bool))), "approve failed");
    }

    // --- Safe transfers (compatible with tokens like USDT that return no bool) ---
    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory d) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (d.length == 0 || abi.decode(d, (bool))), "transfer failed");
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory d) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        require(ok && (d.length == 0 || abi.decode(d, (bool))), "transferFrom failed");
    }

    // -------------------------------------------------------------------
    // Administration
    // -------------------------------------------------------------------
    function setRouterAllowed(address router, bool allowed) external onlyOwner {
        require(router != address(0), "zero router");
        allowedRouter[router] = allowed;
        emit RouterAllowed(router, allowed);
    }

    function setRoutersAllowed(address[] calldata routers, bool allowed) external onlyOwner {
        for (uint256 i = 0; i < routers.length; i++) {
            require(routers[i] != address(0), "zero router");
            allowedRouter[routers[i]] = allowed;
            emit RouterAllowed(routers[i], allowed);
        }
    }

    function setAdapterAllowed(address adapter, bool allowed) external onlyOwner {
        require(adapter != address(0), "zero adapter");
        allowedAdapter[adapter] = allowed;
        emit AdapterAllowed(adapter, allowed);
    }

    function setAdaptersAllowed(address[] calldata adapters, bool allowed) external onlyOwner {
        for (uint256 i = 0; i < adapters.length; i++) {
            require(adapters[i] != address(0), "zero adapter");
            allowedAdapter[adapters[i]] = allowed;
            emit AdapterAllowed(adapters[i], allowed);
        }
    }

    function setFee(uint256 newBps) external onlyOwner {
        require(newBps <= MAX_FEE_BPS, "fee too high");
        emit FeeChanged(feeBps, newBps);
        feeBps = newBps;
    }

    function setFeeRecipient(address to) external onlyOwner {
        require(to != address(0), "zero recipient");
        emit FeeRecipientChanged(feeRecipient, to);
        feeRecipient = to;
    }

    /**
     * Two-step ownership transfer.
     * v1 was one-step: a single wrong address froze the whitelist, the fee and the
     * rescue functions forever - and since the contract is not upgradeable, there was
     * no way back. Now the new owner must call acceptOwnership themselves, which means
     * they must actually hold the key to that address.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        emit OwnerChanged(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    /**
     * Withdraws tokens sent to the contract by mistake.
     * Since the contract holds no user funds between transactions, this cannot touch
     * anyone's money - only accidental leftovers.
     */
    function rescue(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "nothing to rescue");
        _safeTransfer(token, owner, bal);
        emit Rescued(token, owner, bal);
    }

    /**
     * Recovers stranded ETH.
     * `receive()` blocks ordinary transfers, but `selfdestruct` and block rewards get
     * through anyway. v1 had no exit path for ETH, so anything arriving that way was
     * locked forever on a non-upgradeable contract. The contract holds no ETH between
     * transactions, so there is never anything here but accidental leftovers.
     */
    function rescueETH() external onlyOwner {
        uint256 bal = address(this).balance;
        require(bal > 0, "nothing to rescue");
        (bool sent, ) = owner.call{value: bal}("");
        require(sent, "eth transfer failed");
        emit RescuedETH(owner, bal);
    }

    /**
     * Revokes a router's allowance.
     * Removing a router from the whitelist stops it from being *used*, but any allowance
     * already granted to it remains. If a router is removed because it was compromised,
     * its access must be closed too. This is not automatic because the contract does not
     * know which tokens it approved to which router - it does not store that history, and
     * storing it would raise the gas cost of every swap.
     */
    function revokeApprovals(address[] calldata tokens, address router) external onlyOwner {
        for (uint256 i = 0; i < tokens.length; i++) {
            (bool ok, bytes memory d) = tokens[i].call(
                abi.encodeWithSelector(IERC20.approve.selector, router, 0));
            require(ok && (d.length == 0 || abi.decode(d, (bool))), "revoke failed");
            emit ApprovalRevoked(tokens[i], router);
        }
    }
}
