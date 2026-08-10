"""
اتصال چند-RPC با جابه‌جایی خودکار.

مشکلی که در کل این پروژه تکرار شد:
   RPCهای عمومی غیرقابل پیش‌بینی‌اند — یکی امروز کار می‌کند و فردا نه،
   یکی eth_call را رد می‌کند ولی eth_blockNumber را جواب می‌دهد، یکی
   محدودیت جغرافیایی دارد. تکیه بر یک RPC یعنی ابزار به‌طور تصادفی خراب شود.

راه‌حل: چند RPC را نگه می‌داریم. اگر یکی چند بار پشت‌سرهم شکست خورد،
خودکار به بعدی سوئیچ می‌کنیم. کاربر لازم نیست کاری بکند.
"""

import os
from typing import List, Optional

from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware


# RPCهای عمومی که در عمل آزمایش شده‌اند، به ترتیب اولویت
FALLBACK_RPCS = {
    "base": [
        "https://base.drpc.org",
        "https://base-rpc.publicnode.com",
        "https://base.blockpi.network/v1/rpc/public",
        "https://mainnet.base.org",
        "https://base.meowrpc.com",
    ],
    "arbitrum": [
        "https://arbitrum.drpc.org",
        "https://arbitrum-one-rpc.publicnode.com",
        "https://arb1.arbitrum.io/rpc",
        "https://arbitrum.blockpi.network/v1/rpc/public",
    ],
}


class MultiRPC:
    """
    چند RPC را مدیریت می‌کند و در صورت خرابی خودکار سوئیچ می‌کند.

    استفاده:
        m = MultiRPC("base")
        w3 = m.web3()          # نمونه‌ی فعلی
        m.report_failure()     # وقتی درخواستی شکست خورد
        w3 = m.web3()          # ممکن است حالا RPC دیگری باشد
    """

    def __init__(self, chain_key: str, custom: Optional[str] = None,
                 env_var: Optional[str] = None,
                 failures_before_switch: int = 4):
        urls: List[str] = []
        if custom:
            urls.append(custom)
        if env_var:
            e = os.environ.get(env_var)
            if e and e not in urls:
                urls.append(e)
        for u in FALLBACK_RPCS.get(chain_key, []):
            if u not in urls:
                urls.append(u)

        if not urls:
            raise ValueError(f"هیچ RPC ای برای {chain_key} تعریف نشده")

        self.urls = urls
        self.index = 0
        self.failures = 0
        self.threshold = failures_before_switch
        self._w3: Optional[Web3] = None
        self.switches = 0

    @property
    def current_url(self) -> str:
        return self.urls[self.index]

    def web3(self) -> Web3:
        if self._w3 is None:
            self._w3 = self._make(self.current_url)
        return self._w3

    def _make(self, url: str) -> Web3:
        w3 = Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 30}))
        try:
            w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
        except Exception:
            pass
        return w3

    def report_success(self):
        self.failures = 0

    def report_failure(self) -> bool:
        """
        یک شکست ثبت می‌کند. اگر به آستانه رسید، به RPC بعدی سوئیچ می‌کند.
        خروجی: True اگر سوئیچ انجام شد.
        """
        self.failures += 1
        if self.failures < self.threshold:
            return False
        if self.index + 1 >= len(self.urls):
            self.failures = 0
            return False          # دیگر جایگزینی نمانده
        self.index += 1
        self.failures = 0
        self.switches += 1
        self._w3 = self._make(self.current_url)
        print(f"\n  ⚠️ RPC قبلی جواب نداد — سوئیچ به: {self.current_url}")
        return True

    def probe(self, verbose: bool = True) -> bool:
        """
        RPCها را امتحان می‌کند تا یکی پیدا شود که *واقعاً* کار کند.

        ⚠️ مهم: فقط خواندن شماره‌ی بلاک کافی نیست. بعضی RPCها بلاک را
        می‌دهند ولی eth_call را رد می‌کنند — و ابزار ما به eth_call نیاز دارد.
        پس یک فراخوانی واقعی هم تست می‌شود.
        """
        from chains import CHAINS, V3_QUOTER_ABI
        chain = None
        for c in CHAINS.values():
            if c.key in FALLBACK_RPCS and self.urls[0] in FALLBACK_RPCS[c.key] + [self.urls[0]]:
                chain = c
                break
        for i in range(self.index, len(self.urls)):
            url = self.urls[i]
            try:
                w3 = self._make(url)
                block = w3.eth.block_number
                if chain is not None:
                    dex = next((d for d in chain.dexes if d.quoter), None)
                    if dex:
                        tin = chain.token(chain.reference)
                        tout = chain.token(chain.wrapped_native)
                        q = w3.eth.contract(address=Web3.to_checksum_address(dex.quoter),
                                            abi=V3_QUOTER_ABI)
                        amt = 10 ** tin.decimals
                        q.functions.quoteExactInputSingle(
                            (Web3.to_checksum_address(tin.address),
                             Web3.to_checksum_address(tout.address),
                             amt, dex.fee_tiers[1] if len(dex.fee_tiers) > 1 else 500, 0)
                        ).call()
                self.index = i
                self._w3 = w3
                self.failures = 0
                if verbose:
                    print(f"  ✓ RPC سالم: {url}  (بلاک {block:,})")
                return True
            except Exception as e:
                if verbose:
                    print(f"  ✗ {url}  ({type(e).__name__})")
                continue
        return False
