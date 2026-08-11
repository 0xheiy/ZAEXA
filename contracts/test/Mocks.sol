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
            (bool ok, bytes memory ret) = executor.call(payload);
            // دلیل واقعی را بالا می‌فرستیم. اگر اینجا پیام خودمان را بگذاریم،
            // تست دیگر نمی‌تواند «قفل کار کرد» را از «به دلیلی دیگر افتاد»
            // تشخیص بدهد — و همان چیزی بود که تست قبلی را بی‌اثر کرده بود.
            if (!ok) {
                assembly { revert(add(ret, 0x20), mload(ret)) }
            }
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


/**
 * توکن کارمزددار (fee-on-transfer): در هر انتقال درصدی می‌سوزد.
 * بدون این ماک، شاخه‌ای از قرارداد که «چقدر واقعاً رسید» را می‌سنجد هرگز
 * اجرا نمی‌شد و ماک با فرض ما هم‌دست بود، نه با واقعیت.
 */
contract MockFeeToken {
    string public name = "Fee On Transfer";
    string public symbol = "FOT";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    uint256 public feeBps;                       // در ده‌هزارم

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
        totalSupply -= fee;                      // سوخته
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
 * توکن سبک USDT: هیچ مقداری برنمی‌گرداند، و allowance غیرصفر را مستقیم
 * نمی‌شود عوض کرد. هر دو شاخه‌ی `_safeTransfer` و ریست در `_ensureApproval`
 * فقط با چنین توکنی اجرا می‌شوند.
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
 * روتر V2 که از ذخیره‌ی خودش پرداخت می‌کند، نه اینکه توکن جدید mint کند.
 * ماک‌های قبلی نقدینگی بی‌نهایت داشتند، پس هیچ‌وقت معلوم نمی‌شد قرارداد
 * دارد از موجودی خودش خرج می‌کند یا از استخر.
 */
contract MockReserveRouter {
    uint256 public rateNum = 2;
    uint256 public rateDen = 1;

    function fund(address token, uint256 amount) external {
        MockERC20(token).mint(address(this), amount);
    }

    /* انتقال با فراخوانی سطح‌پایین — روتر واقعی هم همین کار را می‌کند.
       نسخه‌ی اول اینجا به MockERC20 کست می‌کرد و مقدار bool انتظار داشت، پس
       با توکن سبک USDT که چیزی برنمی‌گرداند revert می‌شد. ماک نباید فرض
       کند همه‌ی توکن‌ها مؤدب‌اند — همان چیزی که قرارداد برایش ساخته شده. */
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
