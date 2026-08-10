// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * SwapExecutor
 * ============
 * برنامه‌ی مسیریابی (شامل تقسیم سفارش و مسیر چندمرحله‌ای) را در یک تراکنش اجرا می‌کند.
 *
 * ⚠️ مهم‌ترین تصمیم امنیتی این قرارداد:
 *
 *    خیلی از روترهای تجمیع‌کننده، calldata دلخواه از کاربر می‌گیرند و آن را
 *    به یک آدرس دلخواه می‌فرستند. این الگو یک آسیب‌پذیری جدی و شناخته‌شده دارد:
 *    هر کسی که به قرارداد approve داده باشد، مهاجم می‌تواند calldata بسازد که
 *    transferFrom از *او* را صدا بزند و دارایی‌اش را بدزدد.
 *
 *    برای همین اینجا:
 *      • هیچ calldata دلخواهی پذیرفته نمی‌شود — قرارداد خودش فراخوانی را می‌سازد
 *      • فقط روترهای در لیست سفید قابل استفاده‌اند
 *      • مقدار خروجی از *موجودی واقعی* سنجیده می‌شود، نه از عدد برگشتی روتر
 *
 * محافظت‌های دیگر:
 *      • جلوگیری از ورود مجدد (reentrancy)
 *      • deadline برای جلوگیری از اجرای تراکنش کهنه
 *      • سقف سخت کارمزد (owner نمی‌تواند کارمزد را بالاتر ببرد)
 *      • قرارداد بین تراکنش‌ها هیچ دارایی کاربر را نگه نمی‌دارد
 *
 * ⚠️ این قرارداد آدیت رسمی نشده. قبل از استفاده با مبلغ قابل توجه،
 *    بررسی مستقل و تست کامل لازم است.
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/*
 * ⚠️ دو نسل روتر یونی‌سواپ V3 وجود دارد و ساختار ورودی‌شان *فرق دارد*:
 *
 *   SwapRouter   (نسل اول) — ساختار هشت‌فیلدی، شامل `deadline`
 *                            سلکتور: 0x414bf389
 *   SwapRouter02 (نسل دوم) — ساختار هفت‌فیلدی، بدون `deadline`
 *                            سلکتور: 0x04e45aaf
 *
 * چون سلکتور از روی شکل ساختار ساخته می‌شود، فرستادن ساختار اشتباه یعنی
 * فراخوانی تابعی که در قرارداد *وجود ندارد* — و EVM آن را بدون هیچ داده‌ای
 * revert می‌کند («missing revert data»). نسخه‌ی اول این قرارداد فقط نسل اول
 * را می‌شناخت، در حالی که Base از SwapRouter02 استفاده می‌کند.
 *
 * پس هر دو را تعریف می‌کنیم و انتخاب با `kind` است.
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


contract SwapExecutor {

    uint8 constant KIND_V2 = 0;
    uint8 constant KIND_V3 = 1;          // SwapRouter02 — استاندارد امروز (Base و اکثر شبکه‌ها)
    uint8 constant KIND_SOLIDLY = 2;
    uint8 constant KIND_V3_LEGACY = 3;   // SwapRouter نسل اول، با فیلد deadline
    uint8 constant KIND_MAX = 3;

    /// سقف سخت کارمزد: ۱٪. حتی owner هم نمی‌تواند از این بالاتر ببرد.
    uint256 public constant MAX_FEE_BPS = 100;

    struct SwapStep {
        uint8   kind;
        address router;
        address tokenIn;
        address tokenOut;
        uint24  feeTier;      // فقط V3
        bool    stable;       // فقط Solidly
        address poolFactory;  // فقط Solidly
    }

    /// یک بخش از سفارش تقسیم‌شده: یک مسیر (یک یا چند مرحله) با مبلغ مشخص
    struct RoutePart {
        SwapStep[] steps;
        uint256 amountIn;
    }

    /// آدرس توکن پیچیده‌ی شبکه (WETH روی Base). تغییرناپذیر است.
    address public immutable WETH;
    /// در ورودی/خروجی، address(0) یعنی «ETH بومی»
    address constant NATIVE = address(0);

    address public owner;
    address public feeRecipient;
    uint256 public feeBps;                       // کارمزد فعلی
    mapping(address => bool) public allowedRouter;   // لیست سفید روترها

    bool private _locked;

    /// @param fee مقدار کارمزد — همیشه به واحد tokenIn است، نه tokenOut
    event Swapped(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );
    event RouterAllowed(address indexed router, bool allowed);
    event FeeChanged(uint256 oldBps, uint256 newBps);
    event FeeRecipientChanged(address indexed oldTo, address indexed newTo);
    event OwnerChanged(address indexed oldOwner, address indexed newOwner);

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

    /// فقط WETH موقع withdraw می‌تواند ETH بفرستد. هیچ‌کس دیگر.
    receive() external payable {
        require(msg.sender == WETH, "only weth");
    }

    // -------------------------------------------------------------------
    // اجرای سواپ
    //
    // 🪙 ETH بومی: در tokenIn یا tokenOut آدرس صفر بگذار.
    //    ورودی بومی  → ETH را با msg.value بفرست؛ قرارداد خودش wrap می‌کند
    //                  (پس نه approve لازم است نه تراکنش جدا)
    //    خروجی بومی  → قرارداد بعد از سواپ unwrap می‌کند و ETH می‌فرستد
    //    نتیجه: «USDC به ETH» یک امضا می‌خواهد، نه دو تا.
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

        // در مسیرها همیشه با توکن پیچیده کار می‌کنیم؛ بومی فقط پوسته است.
        // ⚠️ tokenIn == tokenOut عمداً مجاز است (مسیر حلقه‌ای): هم «شبیه‌سازی
        //    خروج» در رابط به آن تکیه می‌کند، هم آربیتراژ بین دو استخر.
        address inTok  = tokenIn  == NATIVE ? WETH : tokenIn;
        address outTok = tokenOut == NATIVE ? WETH : tokenOut;

        // ℹ️ اعتبارسنجی و اجرا عمداً در توابع جدا هستند.
        //    وقتی همه‌چیز در یک تابع بود، شمارنده‌های حلقه و متغیرهای موقت
        //    تابع را از سقف ۱۶ اسلات استک EVM رد می‌کردند («stack too deep»).
        _validatePlan(parts, inTok, outTok, totalAmountIn);

        uint256 fee;
        uint256 swapAmount;
        {
            uint256 received;
            if (tokenIn == NATIVE) {
                // ETH با خود تراکنش آمده — wrap می‌کنیم و بقیه مثل ERC-20 پیش می‌رود
                require(msg.value == totalAmountIn, "value != amountIn");
                IWETH(WETH).deposit{value: msg.value}();
                received = msg.value;
            } else {
                require(msg.value == 0, "unexpected value");
                // موجودی واقعی دریافتی را می‌سنجیم تا با توکن‌های کارمزددار هم درست کار کند
                uint256 balBefore = IERC20(inTok).balanceOf(address(this));
                _safeTransferFrom(inTok, msg.sender, address(this), totalAmountIn);
                received = IERC20(inTok).balanceOf(address(this)) - balBefore;
            }
            require(received > 0, "nothing received");

            // --- کارمزد از توکن *ورودی* برداشته می‌شود ---
            // 🔑 چرا ورودی و نه خروجی؟ کاربر معمولاً از توکنی معتبر شروع می‌کند
            //    و به توکن ناشناخته می‌رود. کارمزدِ خروجی می‌تواند فردا بی‌ارزش
            //    یا اصلاً غیرقابل فروش باشد.
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
            // 🔑 در مسیر حلقه‌ای (ورودی و خروجی یکی) مبلغی که قرار است خرج شود
            //    همین حالا داخل موجودی است. اگر از «قبل» کم نشود، اختلاف نهایی
            //    منفی می‌شود و تراکنش با panic می‌افتد.
            if (inTok == outTok) {
                outBefore -= swapAmount;
            }

            _runParts(parts, swapAmount, totalAmountIn);

            // 🔒 خروجی از موجودی *واقعی* سنجیده می‌شود، نه از عدد برگشتی روتر
            amountOut = IERC20(outTok).balanceOf(address(this)) - outBefore;
        }
        require(amountOut >= minAmountOut, "slippage: output below minimum");

        // کل خروجی به کاربر می‌رسد — کارمزد قبلاً از ورودی کسر شده است
        if (tokenOut == NATIVE) {
            // پوسته را برمی‌داریم و ETH واقعی می‌فرستیم — بدون تراکنش دوم
            IWETH(WETH).withdraw(amountOut);
            (bool sent, ) = msg.sender.call{value: amountOut}("");
            require(sent, "eth transfer failed");
        } else {
            _safeTransfer(outTok, msg.sender, amountOut);
        }
        emit Swapped(msg.sender, tokenIn, tokenOut, totalAmountIn, amountOut, fee);
    }

    /// اعتبارسنجی کامل برنامه — قبل از اینکه هیچ دارایی جابه‌جا شود
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
                // 🔒 حیاتی: فقط روترهای تأییدشده. جلوی تزریق فراخوانی دلخواه را می‌گیرد.
                require(allowedRouter[s.router], "router not allowed");
                require(s.tokenIn != s.tokenOut, "step same token");
                if (j > 0) {
                    require(s.tokenIn == p.steps[j-1].tokenOut, "steps not chained");
                }
            }
            sum += p.amountIn;
        }
        require(sum == totalAmountIn, "parts sum mismatch");
    }

    /// اجرای بخش‌های سفارش. سهم هر بخش متناسب با مبلغ خالص محاسبه می‌شود،
    /// پس هم کارمزد لحاظ می‌شود هم توکن‌های کارمزددار.
    function _runParts(
        RoutePart[] calldata parts,
        uint256 swapAmount,
        uint256 totalAmountIn
    ) internal {
        for (uint256 i = 0; i < parts.length; i++) {
            RoutePart calldata p = parts[i];
            uint256 amt = (p.amountIn * swapAmount) / totalAmountIn;
            if (amt == 0) continue;
            for (uint256 j = 0; j < p.steps.length; j++) {
                amt = _swap(p.steps[j], amt);
                require(amt > 0, "zero step output");
            }
        }
    }

    // -------------------------------------------------------------------
    function _swap(SwapStep calldata s, uint256 amountIn) internal returns (uint256) {
        _ensureApproval(s.tokenIn, s.router);

        if (s.kind == KIND_V3) {
            // SwapRouter02 — بدون deadline. محافظت زمانی در سطح executeSwap است.
            return IUniswapV3Router02(s.router).exactInputSingle(
                IUniswapV3Router02.ExactInputSingleParams({
                    tokenIn: s.tokenIn, tokenOut: s.tokenOut, fee: s.feeTier,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: 0,        // محافظت نهایی در سطح کل سفارش انجام می‌شود
                    sqrtPriceLimitX96: 0
                })
            );
        }

        if (s.kind == KIND_V3_LEGACY) {
            return IUniswapV3Router01(s.router).exactInputSingle(
                IUniswapV3Router01.ExactInputSingleParams({
                    tokenIn: s.tokenIn, tokenOut: s.tokenOut, fee: s.feeTier,
                    recipient: address(this), deadline: block.timestamp,
                    amountIn: amountIn,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        if (s.kind == KIND_SOLIDLY) {
            ISolidlyRouter.Route[] memory routes = new ISolidlyRouter.Route[](1);
            routes[0] = ISolidlyRouter.Route({
                from: s.tokenIn, to: s.tokenOut,
                stable: s.stable, factory: s.poolFactory
            });
            uint256[] memory o = ISolidlyRouter(s.router).swapExactTokensForTokens(
                amountIn, 0, routes, address(this), block.timestamp);
            return o[o.length - 1];
        }

        // استفاده‌ی صریح از KIND_V2 به‌جای else ضمنی — خواناتر و ایمن‌تر
        require(s.kind == KIND_V2, "unknown kind");
        address[] memory path = new address[](2);
        path[0] = s.tokenIn;
        path[1] = s.tokenOut;
        uint256[] memory amts = IUniswapV2Router(s.router).swapExactTokensForTokens(
            amountIn, 0, path, address(this), block.timestamp);
        return amts[amts.length - 1];
    }

    function _ensureApproval(address token, address spender) internal {
        uint256 current = IERC20(token).allowance(address(this), spender);
        if (current > type(uint128).max) {
            return;      // ⛽ approve بی‌نهایت از قبل ست شده
        }

        // بعضی توکن‌ها (مثل USDT) اجازه‌ی تغییر مستقیم allowance غیرصفر را نمی‌دهند.
        // ولی این ریست فقط وقتی لازم است که allowance فعلی صفر نباشد —
        // این هم گس کمتری می‌برد، هم دیگر لازم نیست نتیجه‌ای را نادیده بگیریم.
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

    // --- انتقال امن (سازگار با توکن‌هایی مثل USDT که bool برنمی‌گردانند) ---
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
    // مدیریت
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

    function setOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    /**
     * برداشت توکن‌هایی که اشتباهی به قرارداد فرستاده شده‌اند.
     * چون قرارداد بین تراکنش‌ها هیچ دارایی کاربری نگه نمی‌دارد، این تابع
     * نمی‌تواند پول کاربران را بردارد — فقط باقی‌مانده‌های اتفاقی را.
     */
    function rescue(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "nothing to rescue");
        _safeTransfer(token, owner, bal);
    }
}
