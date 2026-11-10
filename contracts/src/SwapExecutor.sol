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
 *      - the contract holds no user funds between transactions - and, as of v6,
 *        that is enforced rather than assumed: whatever input or intermediate
 *        token a router leaves unspent is refunded to the caller in the same call
 *
 * v6 CHANGES (v5 is live at 0x15e511Bf2Ea1a0F50F25E973d57Dce0D01946b6d):
 *      - the fee is charged in a token from an owner-managed allowlist whenever
 *        the route touches one: on the input if it is listed (buys, as v5),
 *        otherwise at each leg's first listed hop, in flight (sells); a route
 *        that touches no listed token pays on the input as in v5. Full rule and
 *        its two revert cases: the comment in executeSwap.
 *      - a failing fee transfer no longer blocks the swap (FeeSkipped); the fee
 *        is measured by balance delta, gas-capped, and copies no return data
 *      - unspent input / intermediate tokens are refunded (Refunded), after the
 *        output has been delivered
 *
 * ACCEPTED LIMITS of the fee rule - stated so nobody mistakes them for bugs
 * already fixed:
 *      - a caller who injects value from outside the executor's accounting (a
 *        pool they control and price, a tiny fee-token input a manipulated pool
 *        inflates) can still route around the fee. Not closable on-chain without
 *        prices; equally true of v5; and such a caller could call the routers
 *        directly instead.
 *      - an input-side fee is taken on the whole input before the route runs, so
 *        a partial fill (say 60%) pays the fee on 100%; the unspent input is
 *        refunded fee-free. A fee taken in flight is charged only on what reached
 *        the fee point.
 *
 * WHAT THE OWNER KEY CAN STILL DO - stated because the list above reads like a
 * complete account of the trust model, and without these five it is not:
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
 *      - `setFeeToken` (v6) is likewise a single-EOA call. It decides on which
 *        side of a swap the fee is taken, never how much: the amount stays bound
 *        by `feeBps` <= MAX_FEE_BPS, and WETH cannot be removed from the list.
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

    /* Per-call state, in memory. One struct instead of a dozen locals: executeSwap
       already sits at the EVM's 16-slot stack limit (see the note in executeSwap),
       and every v6 feature needed state that has to survive across the pull, the
       route, delivery and the refund. */
    struct Ctx {
        address inTok;          // tokenIn, with native mapped to WETH
        address outTok;         // tokenOut, with native mapped to WETH
        bool inFlight;          // fee taken at each leg's first fee-token hop (see executeSwap)
        uint256[] feePoint;     // per part: 0 = on the leg's input, j+1 = on step j's output
        address[] toks;         // tokens this call may leave behind: input + intermediates
        uint256[] bals;         // the contract's balance of each, before any asset moved
        bool[] preFee;          // token sits before its leg's fee point (never fee-charged)
        address feeTok;         // token the fee was charged in ...
        bool feeMixed;          // ... unless legs charged it in different tokens
        uint256 fee;            // total that actually left the contract as fee
    }

    /* Gas forwarded to the fee transfer. A plain ERC-20 transfer is ~30k gas cold
       (WETH ~30k, USDC through its proxy ~40k); 150k leaves room for tokens with
       tax or reflection logic on transfer while bounding what a gas-burning token
       can take from the swap. A transfer that runs out of it fails like any other
       failure: the fee is skipped, the swap continues. */
    uint256 constant FEE_TRANSFER_GAS = 150_000;

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
    /* Fee-token allowlist. Decides in which token, and at which point of each
       leg, the fee is taken - see the fee rule in `executeSwap`. Owner-managed and seeded from the constructor so that
       no stablecoin address is ever hardcoded here: the same bytecode must be
       deployable on any chain, and a token list is configuration, not code.
       WETH is always on it (native ETH is routed as WETH) and cannot be removed. */
    mapping(address => bool) public feeToken;

    bool private _locked;

    /// @param amountIn input actually consumed (fee included, refunded input excluded)
    /// @param amountOut what reached the user's wallet, net of any fee
    /// @param fee      total that left the contract as fee (0 if none or skipped);
    ///                 0 when feeToken is address(0) - see FeeTaken for the breakdown
    /// @param feeToken the ERC-20 the fee was charged in. Since v6 this is no longer
    ///                 always tokenIn - see the fee rule in executeSwap. Native ETH is
    ///                 reported as WETH, because WETH is what feeRecipient receives.
    ///                 address(0) means the legs of a split order charged it in
    ///                 different tokens; the FeeTaken events then carry the amounts.
    event Swapped(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee,
        address feeToken
    );
    event FeeTokenSet(address indexed token, bool allowed);
    /// The fee transfer failed (recipient blacklisted, token paused, ...) and was skipped;
    /// the amount stayed with the user's swap instead.
    event FeeSkipped(address indexed token, address indexed recipient, uint256 amount);
    /// One fee transfer: `amount` is what left the contract (measured, not trusted).
    event FeeTaken(address indexed token, address indexed recipient, uint256 amount);
    /// Unspent input or intermediate token returned to the caller (msg.sender).
    event Refunded(address indexed token, uint256 amount);
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

    constructor(
        address _owner,
        address _feeRecipient,
        uint256 _feeBps,
        address _weth,
        address[] memory _feeTokens
    ) {
        require(_owner != address(0), "zero owner");
        require(_weth != address(0), "zero weth");
        require(_feeBps <= MAX_FEE_BPS, "fee too high");
        WETH = _weth;
        owner = _owner;
        feeRecipient = _feeRecipient == address(0) ? _owner : _feeRecipient;
        // A fee "sent" to ourselves never leaves the balance: the delta would read 0
        // and every fee would be reported as skipped while the amount sat here,
        // indistinguishable from rescuable dust. Same check in setFeeRecipient.
        require(feeRecipient != address(this), "fee recipient is self");
        feeBps = _feeBps;
        // Emitted for WETH and the seed list too, so the allowlist can be rebuilt
        // from logs alone - same reasoning as the Rescued events below.
        feeToken[_weth] = true;
        emit FeeTokenSet(_weth, true);
        for (uint256 i = 0; i < _feeTokens.length; i++) {
            require(_feeTokens[i] != address(0), "zero token");
            feeToken[_feeTokens[i]] = true;
            emit FeeTokenSet(_feeTokens[i], true);
        }
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
        Ctx memory c;
        c.inTok  = tokenIn  == NATIVE ? WETH : tokenIn;
        c.outTok = tokenOut == NATIVE ? WETH : tokenOut;

        // Validation and execution are deliberately separate functions.
        //    With everything in one function, the loop counters and temporaries pushed
        //    it past the EVM's 16-slot stack limit ("stack too deep").
        _validatePlan(parts, c.inTok, c.outTok, totalAmountIn);

        /* --- the fee rule (v6) ---
           The fee is 1% (at most) of the order, taken in a token we are willing to
           hold. v5 always took it from the input, so that it would not be
           denominated in a token that could be worthless tomorrow - right for a
           BUY, but for a SELL (unknown token -> ETH/stablecoin) it put the fee in
           the unknown token. The allowlist now decides, per leg of the route:

             1. input is a fee token                 -> fee from the input, up front
                                                        (buys; exactly as v5)
             2. else, in each leg, at the FIRST hop  -> fee from that hop's output,
                whose output is a fee token             in flight, before the next hop
                                                        (sells; and token->USDC->token)
                a leg of such an order that never   -> fee from that leg's input share
                touches a fee token
             3. no leg touches a fee token at all    -> fee from the input, up front
                                                        (v5 token->token fallback)

           Why "first fee-token hop" and not "output, plus whatever comes back":
           the fee is charged once, on the full value of the leg, at the first
           point that value is in a vetted token. Anything refunded after that
           point was already charged, so an honest partial fill pays exactly once;
           and nothing can leave fee-free by being stranded on purpose. An
           audit of the first v6 draft showed the hole this closes: unknown ->
           USDC -> junk, with a dust pool on the last hop, returned almost all the
           USDC as an "unspent intermediate" while the fee landed in the unknown
           input (or, for a sell to WETH, on a dust-sized output).

           Two shapes could still let value out before a leg's fee point; both
           revert instead of paying it out:
             - an intermediate refunded from before the fee point (unknown -> X ->
               USDC, the X->USDC hop under-spends): swapped, never charged, not a
               vetted token -> "leftover before fee point", at refund time;
             - the OUTPUT token produced before the fee point (A->B, B->USDC
               through a dust pool, USDC->B): the early B is not in the refund list,
               so it would be delivered as output uncharged -> "output before fee
               point", in _prepare, before any asset moves (audit round 2).
           Unspent INPUT is always refunded freely - it was never swapped.
           Accepted limits of this rule (value injected from outside; input-side
           fee on a partial fill) are listed in the header. */
        _prepare(c, parts);

        uint256 received = _pullInput(tokenIn, c.inTok, totalAmountIn);
        uint256 swapAmount = received;
        if (!c.inFlight) {
            // `_takeFee` returns what actually left the contract, measured by
            // balance, so swapAmount can never exceed what is really held.
            swapAmount -= _takeFee(c, c.inTok, received);
            require(swapAmount > 0, "amount too small after fee");
        }

        amountOut = _routeAndMeasure(parts, swapAmount, totalAmountIn, c);

        /* Slippage protection must be measured on what reaches the *user's wallet*,
           not on what reached the contract. For a fee-on-transfer output token these
           are not the same: the contract receives X, the user receives X minus the
           transfer fee. The check used to run against X, so minAmountOut could hold
           while the user got less than they were promised - meaning the very guard
           that exists for this silently stopped working.

           Since v6 the same holds for our own fee when it is taken on the output
           side: it leaves the contract during the route, so `amountOut` is already
           net of it, and the user-side measurement is net of both the protocol fee
           and any transfer tax. minAmountOut therefore means "what lands in my
           wallet", whichever side the fee was taken on.

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
        uint256 delivered = _deliver(tokenOut, c.outTok, amountOut);
        require(delivered >= minAmountOut, "slippage: output below minimum");

        /* Refunds come LAST, after the output and its check. Settlement order is
           part of the contract: the user's wallet is measured for minAmountOut
           before any refund transfer can call into a token hook, and a refund
           hook observes a swap that has already delivered. The refund returns
           the input-token part, so the event reports input actually consumed;
           clamped, because a plan may route back through the input token mid-path
           (A->B->A->C) and the refund can then exceed what arrived - still the
           caller's, but "consumed" is zero, not an underflow panic. */
        uint256 inRefund = _refundLeftovers(c);

        // What was *actually delivered* is logged, not what the caller asked for.
        // For fee-on-transfer tokens these differ, and v1 logged the larger number.
        emit Swapped(msg.sender, tokenIn, tokenOut,
                     inRefund >= received ? 0 : received - inRefund,
                     delivered,
                     c.feeMixed ? 0 : c.fee,
                     c.feeMixed ? address(0) : c.feeTok);
        amountOut = delivered;
    }

    /// Runs the route and returns the output that reached the contract, net of any
    /// fee taken in flight. Split out of executeSwap for stack depth.
    function _routeAndMeasure(
        RoutePart[] calldata parts,
        uint256 swapAmount,
        uint256 totalAmountIn,
        Ctx memory c
    ) internal returns (uint256 amountOut) {
        uint256 outBefore = IERC20(c.outTok).balanceOf(address(this));
        // On a loop route (same token in and out) the amount about to be spent is
        //    already part of the balance. Without subtracting it up front, the final
        //    difference underflows and the transaction panics.
        if (c.inTok == c.outTok) {
            outBefore -= swapAmount;
        }

        _runParts(parts, swapAmount, totalAmountIn, c);

        // Output is measured from the *actual* balance, not the router's return value
        amountOut = IERC20(c.outTok).balanceOf(address(this)) - outBefore;
    }

    /// Takes the input from the caller and returns what actually arrived.
    function _pullInput(address tokenIn, address inTok, uint256 totalAmountIn)
        internal returns (uint256 received)
    {
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
    }

    /// Sends `amount` of the output to the caller and returns what actually arrived
    /// (clamped at zero - see the comment in executeSwap for why the clamp matters).
    function _deliver(address tokenOut, address outTok, uint256 amount)
        internal returns (uint256 delivered)
    {
        if (tokenOut == NATIVE) {
            // Unwrap and send real ETH - no second transaction
            IWETH(WETH).withdraw(amount);
            uint256 ethBefore = msg.sender.balance;
            (bool sent, ) = msg.sender.call{value: amount}("");
            require(sent, "eth transfer failed");
            uint256 ethAfter = msg.sender.balance;
            delivered = ethAfter > ethBefore ? ethAfter - ethBefore : 0;
        } else {
            uint256 userBefore = IERC20(outTok).balanceOf(msg.sender);
            _safeTransfer(outTok, msg.sender, amount);
            uint256 userAfter = IERC20(outTok).balanceOf(msg.sender);
            delivered = userAfter > userBefore ? userAfter - userBefore : 0;
        }
    }

    /**
     * Takes the protocol fee on `amount` of `token`; returns what actually LEFT the
     * contract.
     *
     * The fee must never be able to block a swap. With the reverting `_safeTransfer`,
     * a fee recipient that a token has blacklisted (USDC and USDT both keep such lists),
     * or a token that pauses transfers to one address, would turn every swap through
     * that token into a revert - a denial of service on the user that is entirely
     * about *our* cut. So this one transfer is a raw call whose outcome is ignored:
     *
     *   - what counts is the contract's balance delta around the call, not the
     *     call's success flag or return value. A token that moves the funds but
     *     returns false would otherwise leave the caller believing it still holds
     *     the fee - and route, or count as loop-route output, money it no longer has.
     *     Nothing moved (revert, false, out of gas) -> fee skipped, FeeSkipped.
     *   - gas is capped at FEE_TRANSFER_GAS, so a token that burns gas on this one
     *     transfer cannot starve the rest of the swap.
     *   - no return data is copied (output size 0 in the call): a token returning a
     *     megabyte would otherwise make *us* pay the memory expansion. Since the
     *     return value is not consulted, there is nothing to copy.
     *
     * More leaving than was asked (a token that taxes the sender on top) is allowed
     * up to, but not including, the in-flight amount; the full delta is what is
     * deducted, so accounting always matches the balance. Anything beyond that is a
     * broken token and reverts.
     *
     * The token is recorded in `c` even when no fee is charged, so the Swapped event
     * can name the token the fee side resolved to.
     */
    function _takeFee(Ctx memory c, address token, uint256 amount) internal returns (uint256 moved) {
        if (c.feeTok == address(0)) c.feeTok = token;
        else if (c.feeTok != token) c.feeMixed = true;

        address to = feeRecipient;
        if (feeBps == 0 || to == address(0)) return 0;
        uint256 fee = (amount * feeBps) / 10_000;
        if (fee == 0) return 0;

        uint256 balBefore = IERC20(token).balanceOf(address(this));
        bytes memory data = abi.encodeWithSelector(IERC20.transfer.selector, to, fee);
        assembly {
            pop(call(FEE_TRANSFER_GAS, token, 0, add(data, 0x20), mload(data), 0, 0))
        }
        uint256 balAfter = IERC20(token).balanceOf(address(this));
        moved = balBefore > balAfter ? balBefore - balAfter : 0;
        require(moved < amount, "fee overdrawn");

        if (moved == 0) {
            emit FeeSkipped(token, to, fee);
        } else {
            c.fee += moved;
            emit FeeTaken(token, to, moved);
        }
    }

    /**
     * Before any asset moves: decides the fee mode and fee point of every leg (see
     * the rule in executeSwap), lists the tokens this call could leave behind - the
     * input token and every intermediate - and records the contract's balance of each.
     *
     * The output token is excluded from the list on purpose: its growth is the swap's
     * output and is measured and delivered separately. That also covers the loop route
     * (inTok == outTok): there the input token IS the output token, so an unspent
     * input simply stays in the balance and is delivered as output - it reaches the
     * user either way, it is just counted against minAmountOut rather than refunded.
     * An intermediate that happens to equal outTok (A->C->B->C) is excluded for the
     * same reason.
     *
     * Bounds: _validatePlan has already capped parts at 5 and steps at 3, so the list
     * holds at most 1 + 5 x 3 = 16 entries; were that ever exceeded, the indexed write
     * reverts with a bounds-check panic before any asset moves. The quadratic
     * de-duplication is over at most 16 entries.
     */
    function _prepare(Ctx memory c, RoutePart[] calldata parts) internal view {
        c.feePoint = new uint256[](parts.length);
        if (!feeToken[c.inTok]) {
            for (uint256 i = 0; i < parts.length; i++) {
                SwapStep[] calldata st = parts[i].steps;
                for (uint256 j = 0; j < st.length; j++) {
                    if (feeToken[st[j].tokenOut]) {
                        c.feePoint[i] = j + 1;
                        c.inFlight = true;
                        break;
                    }
                }
            }
        }

        address[] memory toks = new address[](16);
        bool[] memory pre = new bool[](16);
        uint256 n = 0;
        if (c.inTok != c.outTok) {
            toks[n++] = c.inTok;        // unspent input: never swapped, never "pre-fee"
        }
        for (uint256 i = 0; i < parts.length; i++) {
            SwapStep[] calldata st = parts[i].steps;
            uint256 fp = c.feePoint[i];
            for (uint256 j = 0; j < st.length; j++) {
                address t = st[j].tokenOut;
                // Step j's output sits at position j + 1; the fee is taken at position
                // fp (fp == 0: on the input, or up-front mode - nothing is "before").
                bool isPre = j + 1 < fp;  // swapped before this leg's fee was taken
                if (t == c.outTok) {
                    /* The output token is not in the refund list (its growth IS the
                       output), so output-token value produced before the fee point would
                       be delivered uncharged: A->B (full), B->USDC through a dust pool
                       (the fee point, on a few units), USDC->B - the unspent B from hop 1
                       goes out as "output". Audit round 2. Reverting here, before any
                       asset moves, is the only place it can be told apart from real
                       output. The leg's final step is never caught (fp <= its position),
                       nor is a loop route, whose output token is the input at position 0. */
                    require(!isPre, "output before fee point");
                    continue;
                }
                uint256 k = 0;
                while (k < n && toks[k] != t) k++;
                if (k == n) toks[n++] = t;
                if (isPre) pre[k] = true;
            }
        }
        // shrink both arrays in place to the entries actually used
        assembly {
            mstore(toks, n)
            mstore(pre, n)
        }
        uint256[] memory bals = new uint256[](n);
        for (uint256 k = 0; k < n; k++) {
            bals[k] = IERC20(toks[k]).balanceOf(address(this));
        }
        c.toks = toks;
        c.bals = bals;
        c.preFee = pre;
    }

    /**
     * Refunds to the caller whatever the route left of the input and intermediate
     * tokens, measured as growth over the snapshot taken in _prepare.
     *
     * Why this exists: nothing used to check that a router consumed its whole
     * input. A pool that runs out of liquidity mid-swap or a price limit leaves the
     * rest here - and with no refund it stayed, the user's money sitting in a
     * contract that promises it holds nothing. Multi-hop parts have the same hole
     * one level down: a hop that under-spends strands the intermediate token.
     *
     * Adapters are a different case and are NOT covered by this refund. An adapter
     * is handed the in-flight amount outright, so anything it does not send back
     * stays in the adapter, where this contract cannot see it. UniswapV4Adapter
     * cannot keep leftovers at all: it reverts unless the pool consumed exactly the
     * amount it received and it ends holding no tokenIn ("v4: input mismatch",
     * "v4: tokenIn left"). Any other adapter must honour the IZaexaAdapter contract
     * above; the order-level minAmountOut is the backstop.
     *
     * Only growth is paid out, never the absolute balance, so pre-existing balances
     * are untouched. A shrink - possible only if a whitelisted router pulled more
     * than it was told - is not "refundable" and is ignored here; minAmountOut is
     * the backstop for that, as everywhere else.
     *
     * A leftover of a token that sits before its leg's fee point reverts - see the
     * fee rule in executeSwap for why paying it out would let value leave uncharged.
     *
     * The refund uses the reverting `_safeTransfer`, unlike the fee: this is the
     * user's own money, and failing closed is preferable to silently keeping it.
     *
     * Native ETH input: the unspent part is refunded as WETH, not unwrapped. WETH
     * is 1:1 ETH and an ERC-20 transfer cannot be refused by the recipient, while
     * an ETH send can - a contract caller without a payable receive would turn a
     * partial fill into a revert of the whole swap. It also adds no new external
     * call to the caller's code in the middle of settlement.
     *
     * Returns the amount refunded of the input token, so the Swapped event can
     * report the input actually consumed. Matched by address, not by position: on
     * a loop route the input token is not in the list at all.
     */
    function _refundLeftovers(Ctx memory c) internal returns (uint256 inRefund) {
        address[] memory toks = c.toks;
        uint256[] memory bals = c.bals;
        for (uint256 k = 0; k < toks.length; k++) {
            uint256 nowBal = IERC20(toks[k]).balanceOf(address(this));
            if (nowBal > bals[k]) {
                require(!c.preFee[k], "leftover before fee point");
                uint256 extra = nowBal - bals[k];
                _safeTransfer(toks[k], msg.sender, extra);
                emit Refunded(toks[k], extra);
                if (toks[k] == c.inTok) inRefund = extra;
            }
        }
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
    /// In in-flight fee mode (see executeSwap) each leg also pays its fee here, at its
    /// fee point, out of the amount in flight.
    function _runParts(
        RoutePart[] calldata parts,
        uint256 swapAmount,
        uint256 totalAmountIn,
        Ctx memory c
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

            // type(uint256).max = "no fee in this leg" (up-front mode: already taken)
            uint256 fp = c.inFlight ? c.feePoint[i] : type(uint256).max;
            if (fp == 0) {
                amt -= _takeFee(c, c.inTok, amt);
            }
            for (uint256 j = 0; j < p.steps.length; j++) {
                amt = _swap(p.steps[j], amt);
                require(amt > 0, "zero step output");
                if (j + 1 == fp) {
                    amt -= _takeFee(c, p.steps[j].tokenOut, amt);
                }
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

    /**
     * Adds or removes a fee token (see the fee rule in executeSwap).
     * WETH cannot be removed: native ETH is routed as WETH. Without it on the list,
     * every sell into ETH would lose its fee point and fall back to the v5 input
     * fee - in the unknown token being sold - which is exactly the exposure the fee
     * rule exists to avoid; one owner call would do that silently.
     */
    function setFeeToken(address token, bool allowed) external onlyOwner {
        require(token != address(0), "zero token");
        require(allowed || token != WETH, "weth is always a fee token");
        feeToken[token] = allowed;
        emit FeeTokenSet(token, allowed);
    }

    function setFeeRecipient(address to) external onlyOwner {
        require(to != address(0), "zero recipient");
        require(to != address(this), "fee recipient is self");
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
