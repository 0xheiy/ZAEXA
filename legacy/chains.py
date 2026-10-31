"""
تنظیمات شبکه‌ها و صرافی‌ها.

آدرس‌ها از منابع رسمی گرفته شده‌اند، ولی قبل از استفاده‌ی جدی خودت هم
از اکسپلورر همان شبکه تأیید کن.
"""

from dataclasses import dataclass, field
from typing import List, Optional, Dict

KIND_V2 = "v2"
KIND_V3 = "v3"
KIND_SOLIDLY = "solidly"


@dataclass
class Dex:
    name: str
    kind: str
    router: str
    factory: str
    quoter: Optional[str] = None
    fee_tiers: List[int] = field(default_factory=list)
    solidly_modes: List[bool] = field(default_factory=lambda: [False, True])

    def variants(self):
        if self.kind == KIND_V3:
            return [{"fee_tier": t, "stable": None} for t in self.fee_tiers]
        if self.kind == KIND_SOLIDLY:
            return [{"fee_tier": None, "stable": s} for s in self.solidly_modes]
        return [{"fee_tier": None, "stable": None}]


@dataclass
class Venue:
    dex: Dex
    fee_tier: Optional[int] = None
    stable: Optional[bool] = None

    @property
    def name(self):
        if self.dex.kind == KIND_V3:
            return f"{self.dex.name} {self.fee_tier/10_000:.2f}%"
        if self.dex.kind == KIND_SOLIDLY:
            return f"{self.dex.name} {'stable' if self.stable else 'volatile'}"
        return self.dex.name


@dataclass
class Token:
    symbol: str
    address: str
    decimals: int
    is_stable: bool = False


@dataclass
class Chain:
    key: str
    name: str
    rpc_env: str
    default_rpc: str
    explorer: str
    dexes: List[Dex]
    tokens: Dict[str, Token]
    wrapped_native: str
    reference: str          # ارز مرجع برای قیمت‌گذاری

    def token(self, symbol: str) -> Optional[Token]:
        return self.tokens.get(symbol)


# ---------------------------------------------------------------------------

CHAINS = {
    "base": Chain(
        key="base",
        name="Base",
        rpc_env="BASE_RPC_URL",
        default_rpc="https://base.drpc.org",
        explorer="https://basescan.org",
        wrapped_native="WETH",
        reference="USDC",
        dexes=[
            Dex(name="Uniswap V3", kind=KIND_V3,
                router="0x2626664c2603336E57B271c5C0b26F421741e481",
                factory="0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
                quoter="0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
                fee_tiers=[100, 500, 3000, 10000]),
            Dex(name="Aerodrome", kind=KIND_SOLIDLY,
                router="0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
                factory="0x420DD381b31aEf6683db6B902084cB0FFECe40Da"),
        ],
        tokens={
            "WETH": Token("WETH", "0x4200000000000000000000000000000000000006", 18),
            "USDC": Token("USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6, True),
            "AERO": Token("AERO", "0x940181a94A35A4569E4529A3CDfB74e38FD98631", 18),
            "cbBTC": Token("cbBTC", "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", 8),
            "DAI": Token("DAI", "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", 18, True),
        },
    ),

    "arbitrum": Chain(
        key="arbitrum",
        name="Arbitrum One",
        rpc_env="ARBITRUM_RPC_URL",
        default_rpc="https://arb1.arbitrum.io/rpc",
        explorer="https://arbiscan.io",
        wrapped_native="WETH",
        reference="USDC",
        dexes=[
            Dex(name="Uniswap V3", kind=KIND_V3,
                router="0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
                factory="0x1F98431c8aD98523631AE4a59f267346ea31F984",
                quoter="0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
                fee_tiers=[100, 500, 3000, 10000]),
            Dex(name="PancakeSwap V3", kind=KIND_V3,
                router="0x32226588378236Fd0c7c4053999F88aC0e5cAc77",
                factory="0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
                quoter="0xB048Bbc1Ee6b733FFfCFb9e9cEF7375518e25997",
                fee_tiers=[100, 500, 2500, 10000]),
            Dex(name="SushiSwap", kind=KIND_V2,
                router="0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
                factory="0xc35DADB65012eC5796536bD9864eD8773aBc74C4"),
            Dex(name="Camelot", kind=KIND_V2,
                router="0xc873fEcbd354f5A56E00E710B90EF4201db2448d",
                factory="0x6EcCab422D763aC031210895C81787E87B43A652"),
        ],
        tokens={
            "WETH": Token("WETH", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", 18),
            "USDC": Token("USDC", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6, True),
            "USDT0": Token("USDT0", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", 6, True),
            "ARB": Token("ARB", "0x912CE59144191C1204E64559FE8253a0e49E6548", 18),
            "WBTC": Token("WBTC", "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0F", 8),
        },
    ),
}


# ---------------------------------------------------------------------------
# ABIها
# ---------------------------------------------------------------------------

ERC20_ABI = [
    {"constant": True, "inputs": [], "name": "name",
     "outputs": [{"name": "", "type": "string"}], "type": "function"},
    {"constant": True, "inputs": [], "name": "symbol",
     "outputs": [{"name": "", "type": "string"}], "type": "function"},
    {"constant": True, "inputs": [], "name": "decimals",
     "outputs": [{"name": "", "type": "uint8"}], "type": "function"},
    {"constant": True, "inputs": [], "name": "totalSupply",
     "outputs": [{"name": "", "type": "uint256"}], "type": "function"},
    {"constant": True, "inputs": [{"name": "a", "type": "address"}], "name": "balanceOf",
     "outputs": [{"name": "", "type": "uint256"}], "type": "function"},
]

OWNABLE_ABI = [
    {"constant": True, "inputs": [], "name": "owner",
     "outputs": [{"name": "", "type": "address"}], "type": "function"},
]

V3_QUOTER_ABI = [{
    "inputs": [{"components": [
        {"name": "tokenIn", "type": "address"},
        {"name": "tokenOut", "type": "address"},
        {"name": "amountIn", "type": "uint256"},
        {"name": "fee", "type": "uint24"},
        {"name": "sqrtPriceLimitX96", "type": "uint160"}],
        "name": "params", "type": "tuple"}],
    "name": "quoteExactInputSingle",
    "outputs": [
        {"name": "amountOut", "type": "uint256"},
        {"name": "sqrtPriceX96After", "type": "uint160"},
        {"name": "ticksCrossed", "type": "uint32"},
        {"name": "gasEstimate", "type": "uint256"}],
    "stateMutability": "nonpayable", "type": "function"}]

V2_ROUTER_ABI = [{
    "inputs": [{"name": "amountIn", "type": "uint256"},
               {"name": "path", "type": "address[]"}],
    "name": "getAmountsOut",
    "outputs": [{"name": "amounts", "type": "uint256[]"}],
    "stateMutability": "view", "type": "function"}]

SOLIDLY_ROUTER_ABI = [{
    "inputs": [{"name": "amountIn", "type": "uint256"},
               {"components": [
                   {"name": "from", "type": "address"},
                   {"name": "to", "type": "address"},
                   {"name": "stable", "type": "bool"},
                   {"name": "factory", "type": "address"}],
                   "name": "routes", "type": "tuple[]"}],
    "name": "getAmountsOut",
    "outputs": [{"name": "amounts", "type": "uint256[]"}],
    "stateMutability": "view", "type": "function"}]

V3_FACTORY_ABI = [{
    "inputs": [{"name": "tokenA", "type": "address"},
               {"name": "tokenB", "type": "address"},
               {"name": "fee", "type": "uint24"}],
    "name": "getPool", "outputs": [{"name": "", "type": "address"}],
    "stateMutability": "view", "type": "function"}]

V2_FACTORY_ABI = [{
    "inputs": [{"name": "tokenA", "type": "address"},
               {"name": "tokenB", "type": "address"}],
    "name": "getPair", "outputs": [{"name": "", "type": "address"}],
    "stateMutability": "view", "type": "function"}]

SOLIDLY_FACTORY_ABI = [{
    "inputs": [{"name": "tokenA", "type": "address"},
               {"name": "tokenB", "type": "address"},
               {"name": "stable", "type": "bool"}],
    "name": "getPool", "outputs": [{"name": "", "type": "address"}],
    "stateMutability": "view", "type": "function"}]

ZERO = "0x0000000000000000000000000000000000000000"
DEAD = "0x000000000000000000000000000000000000dEaD"
