// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * Mock contracts for testing.
 * These are used only in the test environment and are never deployed.
 */

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol, uint8 _dec) {
        name = _name; symbol = _symbol; decimals = _dec;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "not allowed");
        if (a != type(uint256).max) {
            allowance[from][msg.sender] = a - amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}


/// Uniswap V2-style mock router - swaps at a fixed rate
contract MockV2Router {
    uint256 public rateNum = 2;     // out = in * rateNum / rateDen
    uint256 public rateDen = 1;

    function setRate(uint256 n, uint256 d) external { rateNum = n; rateDen = d; }

    function swapExactTokensForTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path,
        address to, uint256
    ) external returns (uint256[] memory amounts) {
        MockERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        uint256 out = amountIn * rateNum / rateDen;
        require(out >= amountOutMin, "mock: slippage");
        MockERC20(path[path.length-1]).mint(to, out);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }
}


/// Uniswap V3-style mock router
/*
 * SwapRouter02-style mock router - *seven-field* struct, no deadline.
 *
 * !! The lesson of this mock: the previous version, deliberately or by accident,
 *    implemented the very same eight-field struct that the contract was sending.
 *    The result was that 27 tests were green while no Uniswap swap worked on
 *    mainnet - the mock was only proving that the contract agreed with *itself*.
 *
 *    The rule we follow from now on: a mock has to mirror the shape of the real
 *    contract, not the shape of our expectation. And for something that moves
 *    real money, a fork test against the real contract is needed too
 *    (SwapExecutor.fork.t.sol).
 */
contract MockV3Router {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }

    uint256 public rateNum = 2;
    uint256 public rateDen = 1;

    function setRate(uint256 n, uint256 d) external { rateNum = n; rateDen = d; }

    function exactInputSingle(ExactInputSingleParams calldata p)
        external returns (uint256 amountOut)
    {
        MockERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        amountOut = p.amountIn * rateNum / rateDen;
        require(amountOut >= p.amountOutMinimum, "mock: slippage");
        MockERC20(p.tokenOut).mint(p.recipient, amountOut);
    }
}


/// First-generation SwapRouter-style mock router - *eight-field* struct, with deadline
contract MockV3LegacyRouter {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }

    uint256 public rateNum = 2;
    uint256 public rateDen = 1;

    function exactInputSingle(ExactInputSingleParams calldata p)
        external returns (uint256 amountOut)
    {
        require(block.timestamp <= p.deadline, "mock: expired");
        MockERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        amountOut = p.amountIn * rateNum / rateDen;
        require(amountOut >= p.amountOutMinimum, "mock: slippage");
        MockERC20(p.tokenOut).mint(p.recipient, amountOut);
    }
}


/// Solidly / Aerodrome-style mock router
contract MockSolidlyRouter {
    struct Route { address from; address to; bool stable; address factory; }

    uint256 public rateNum = 2;
    uint256 public rateDen = 1;

    function swapExactTokensForTokens(
        uint256 amountIn, uint256 amountOutMin, Route[] calldata routes,
        address to, uint256
    ) external returns (uint256[] memory amounts) {
        MockERC20(routes[0].from).transferFrom(msg.sender, address(this), amountIn);
        uint256 out = amountIn * rateNum / rateDen;
        require(out >= amountOutMin, "mock: slippage");
        MockERC20(routes[routes.length-1].to).mint(to, out);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }
}


/**
 * Malicious router - tries to steal the funds of a victim who has given an
 * approval to SwapExecutor.
 *
 * This is exactly the attack the "whitelist" design is there to prevent.
 */
contract MaliciousRouter {
    address public victim;
    address public attacker;
    address public token;
    address public executor;

    constructor(address _victim, address _attacker, address _token, address _executor) {
        victim = _victim; attacker = _attacker; token = _token; executor = _executor;
    }

    function swapExactTokensForTokens(
        uint256, uint256, address[] calldata, address, uint256
    ) external returns (uint256[] memory) {
        // Try to take the victim's funds via the allowance they gave the executor
        MockERC20(token).transferFrom(victim, attacker, 1000 ether);
        uint256[] memory a = new uint256[](2);
        return a;
    }
}


/// A router that tries to re-enter the executor (reentrancy test)
contract ReentrantRouter {
    address public executor;
    bytes public payload;
    bool public attacked;

    function setup(address _executor, bytes calldata _payload) external {
        executor = _executor;
        payload = _payload;
    }

    function swapExactTokensForTokens(
        uint256, uint256, address[] calldata, address, uint256
    ) external returns (uint256[] memory) {
        if (!attacked) {
            attacked = true;
            (bool ok, bytes memory ret) = executor.call(payload);
            // Bubble the real reason up. If we put our own message here, the test
            // can no longer tell "the lock worked" from "it failed for some other
            // reason" - and that is exactly what made the previous test useless.
            if (!ok) {
                assembly { revert(add(ret, 0x20), mload(ret)) }
            }
        }
        uint256[] memory a = new uint256[](2);
        return a;
    }
}


/// Mock WETH - real deposit/withdraw, for testing the native ETH path
contract MockWETH {
    string public name = "Wrapped Ether";
    string public symbol = "WETH";
    uint8  public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "weth: balance");
        balanceOf[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "weth: send");
    }
    function approve(address s_, uint256 a) external returns (bool) {
        allowance[msg.sender][s_] = a; return true;
    }
    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "weth: balance");
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(balanceOf[f] >= a, "weth: balance");
        if (allowance[f][msg.sender] != type(uint256).max)
            allowance[f][msg.sender] -= a;
        balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    receive() external payable { balanceOf[msg.sender] += msg.value; }
}


/**
 * Fee-charging token (fee-on-transfer): burns a percentage on every transfer.
 * Without this mock, the branch of the contract that measures "how much actually
 * arrived" would never run, and the mock would be in league with our assumption
 * rather than with reality.
 */
contract MockFeeToken {
    string public name = "Fee On Transfer";
    string public symbol = "FOT";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    uint256 public feeBps;                       // in ten-thousandths

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint256 _feeBps) { feeBps = _feeBps; }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount; totalSupply += amount;
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "insufficient");
        uint256 fee = (amount * feeBps) / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;                      // burned
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount); return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "not allowed");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount); return true;
    }
}


/**
 * USDT-like token: returns no value at all, and a non-zero allowance cannot be
 * changed directly. Both the `_safeTransfer` branch and the reset in
 * `_ensureApproval` only ever run with a token like this.
 */
contract MockNoReturnToken {
    string public name = "Tether-like";
    string public symbol = "USDTL";
    uint8 public decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount; totalSupply += amount;
    }
    function approve(address spender, uint256 amount) external {
        require(amount == 0 || allowance[msg.sender][spender] == 0,
                "USDT: reset allowance to zero first");
        allowance[msg.sender][spender] = amount;
    }
    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount;
    }
    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "insufficient");
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "not allowed");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount; balanceOf[to] += amount;
    }
}


/**
 * A V2 router that pays out of its own reserve instead of minting new tokens.
 * The earlier mocks had infinite liquidity, so it was never visible whether the
 * contract was spending from its own balance or from the pool.
 */
contract MockReserveRouter {
    uint256 public rateNum = 2;
    uint256 public rateDen = 1;

    function fund(address token, uint256 amount) external {
        MockERC20(token).mint(address(this), amount);
    }

    /* Transfer via low-level call - the real router does the same thing.
       The first version cast to MockERC20 here and expected a bool return, so it
       reverted with the USDT-like token that returns nothing. A mock must not
       assume every token is well-behaved - that is exactly what the contract was
       built for. */
    function _pull(address token, address from, uint256 amount) internal {
        (bool ok, bytes memory d) = token.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)",
                                    from, address(this), amount));
        require(ok && (d.length == 0 || abi.decode(d, (bool))), "mock: pull failed");
    }
    function _push(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory d) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        require(ok && (d.length == 0 || abi.decode(d, (bool))), "mock: push failed");
    }
    function balOf(address token) public view returns (uint256) {
        (bool ok, bytes memory d) = token.staticcall(
            abi.encodeWithSignature("balanceOf(address)", address(this)));
        return ok && d.length >= 32 ? abi.decode(d, (uint256)) : 0;
    }

    function swapExactTokensForTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path,
        address to, uint256
    ) external returns (uint256[] memory amounts) {
        _pull(path[0], msg.sender, amountIn);
        uint256 out = amountIn * rateNum / rateDen;
        require(out >= amountOutMin, "mock: slippage");
        require(balOf(path[1]) >= out, "mock: no reserve");
        _push(path[1], to, out);
        amounts = new uint256[](2);
        amounts[0] = amountIn; amounts[1] = out;
    }
}
