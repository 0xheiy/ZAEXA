"""
محدودکننده‌ی نرخ و تلاش مجدد.

درسی که در پروژه‌ی قبلی گران تمام شد:
   RPCهای عمومی سقف نرخ دارند. بدون کنترل، درخواست‌ها بی‌صدا شکست می‌خورند و
   نتیجه این می‌شود که ابزار می‌گوید «این تابع وجود ندارد» یا «این استخر نیست»،
   در حالی که فقط شبکه جواب نداده. برای یک ابزار امنیتی این فاجعه است —
   چون ممکن است خطر واقعی را نبیند یا خطر کاذب گزارش کند.
"""

import os
import threading
import time

DEFAULT_RATE = float(os.environ.get("RPC_RATE", "6"))


class RateLimiter:
    def __init__(self, rate_per_sec: float = DEFAULT_RATE):
        self.rate = rate_per_sec
        self.capacity = max(1.0, rate_per_sec)
        self._tokens = self.capacity
        self._last = time.monotonic()
        self._lock = threading.Lock()

    def acquire(self):
        while True:
            with self._lock:
                now = time.monotonic()
                self._tokens = min(self.capacity,
                                   self._tokens + (now - self._last) * self.rate)
                self._last = now
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return
                wait = (1.0 - self._tokens) / self.rate
            time.sleep(wait)


_limiter = RateLimiter()

TRANSIENT = ("429", "too many", "timeout", "timed out", "connection",
             "reset", "unreachable", "temporarily", "503", "502")


class RpcFailure(Exception):
    """درخواست حتی پس از چند تلاش هم شکست خورد — یعنی نتیجه نامعلوم است."""


def call_rpc(fn, *args, retries: int = 3, base_delay: float = 1.0, **kwargs):
    """
    یک فراخوانی را با محدودکننده‌ی نرخ و تلاش مجدد اجرا می‌کند.

    تفاوت کلیدی با نسخه‌ی قبلی: بین «تابع وجود ندارد» و «شبکه جواب نداد»
    فرق می‌گذارد. اولی نتیجه‌ی واقعی است، دومی RpcFailure می‌دهد تا
    گزارش بتواند بگوید «نامعلوم» به‌جای «وجود ندارد».
    """
    last = None
    for attempt in range(retries):
        _limiter.acquire()
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            last = e
            msg = str(e).lower()
            if any(t in msg for t in TRANSIENT):
                if attempt < retries - 1:
                    time.sleep(base_delay * (attempt + 1))
                    continue
                raise RpcFailure(str(e)) from e
            raise          # خطای منطقی (revert و...) — واقعی است، دوباره تلاش نکن
    if last:
        raise RpcFailure(str(last))


def try_call(fn, *args, default=None, retries: int = 3, **kwargs):
    """
    مثل call_rpc ولی خطای منطقی را به default تبدیل می‌کند.
    خروجی: (نتیجه، وضعیت) که وضعیت یکی از "ok" | "missing" | "rpc_error" است.
    """
    try:
        return call_rpc(fn, *args, retries=retries, **kwargs), "ok"
    except RpcFailure:
        return default, "rpc_error"
    except Exception:
        return default, "missing"


def set_rate(rate: float):
    global _limiter
    _limiter = RateLimiter(rate)
