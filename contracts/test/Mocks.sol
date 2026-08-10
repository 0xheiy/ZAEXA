// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * قراردادهای ساختگی برای تست.
 * این‌ها فقط در محیط تست استفاده می‌شوند و هیچ‌وقت دیپلوی نمی‌شوند.
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


/// روتر ساختگی سبک Uniswap V2 — با نرخ ثابت سواپ می‌کند
contract MockV2Router {
    uint256 public rateNum = 2;     // خروجی = ورودی × rateNum / rateDen
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


/// روتر ساختگی سبک Uniswap V3
/*
 * روتر ساختگی سبک SwapRouter02 — ساختار *هفت‌فیلدی*، بدون deadline.
 *
 * ⚠️ درس این ماک: نسخه‌ی قبلی عمداً یا سهواً همان ساختار هشت‌فیلدی‌ای را
 *    پیاده کرده بود که قرارداد می‌فرستاد. نتیجه‌اش این شد که ۲۷ تست سبز
 *    بودند ولی روی مین‌نت هیچ سواپ یونی‌سواپی کار نمی‌کرد — ماک فقط ثابت
 *    می‌کرد قرارداد با *خودش* سازگار است.
 *
 *    قاعده‌ای که از این به بعد رعایت می‌کنیم: ماک باید شکل قرارداد واقعی را
 *    آینه کند، نه شکل انتظار ما را. و برای چیزی که پول واقعی جابه‌جا می‌کند،
 *    تست fork مقابل قرارداد واقعی هم لازم است (SwapExecutor.fork.t.sol).
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


/// روتر ساختگی سبک SwapRouter نسل اول — ساختار *هشت‌فیلدی*، با deadline
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


/// روتر ساختگی سبک Solidly / Aerodrome
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
 * روتر مخرب — تلاش می‌کند دارایی یک قربانی را که به SwapExecutor
 * اجازه داده، بدزدد.
 *
 * این دقیقاً همان حمله‌ای است که طراحی «لیست سفید» برای جلوگیری از آن است.
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
        // تلاش برای برداشتن دارایی قربانی از طریق allowance ای که به executor داده
        MockERC20(token).transferFrom(victim, attacker, 1000 ether);
        uint256[] memory a = new uint256[](2);
        return a;
    }
}


/// روتری که سعی می‌کند دوباره وارد executor شود (تست reentrancy)
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
            (bool ok, ) = executor.call(payload);
            require(ok, "reentrancy blocked");
        }
        uint256[] memory a = new uint256[](2);
        return a;
    }
}


/// WETH ساختگی — deposit/withdraw واقعی، برای تست مسیر ETH بومی
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
