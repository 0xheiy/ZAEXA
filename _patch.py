"""پچ موقت — پس از اجرا می‌توانی پاکش کنی."""

p = "executor.py"
s = open(p, encoding="utf-8").read()

old = '''    try:
        base = w3.eth.get_block("latest").get("baseFeePerGas")
        params = {
            "from": account.address,
            "gas": gas_limit,
            "chainId": w3.eth.chain_id,
            "nonce": w3.eth.get_transaction_count(account.address, "pending"),
        }
        if base is not None:
            prio = w3.to_wei(0.005, "gwei")
            params["maxPriorityFeePerGas"] = prio
            params["maxFeePerGas"] = int(base * 2) + prio
        else:
            params["gasPrice"] = w3.eth.gas_price

        tx = fn.build_transaction(params)
        signed = account.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        h = tx_hash.hex()
        print(f"\\n  📤 ارسال شد: {h}")
        print(f"     {chain.explorer}/tx/{h}")

        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
        if receipt.status == 1:
            print(f"  ✅ موفق | گس مصرفی: {receipt.gasUsed:,}")
            return h
        print(f"  ❌ تراکنش revert شد")
        return None
    except Exception as e:
        print(f"  ❌ خطای ارسال: {e}")
        return None'''

new = '''    try:
        base = w3.eth.get_block("latest").get("baseFeePerGas")
        params = {
            "from": account.address,
            "gas": gas_limit,
            "chainId": w3.eth.chain_id,
            "nonce": w3.eth.get_transaction_count(account.address, "pending"),
        }
        if base is not None:
            prio = w3.to_wei(0.005, "gwei")
            params["maxPriorityFeePerGas"] = prio
            params["maxFeePerGas"] = int(base * 2) + prio
        else:
            params["gasPrice"] = w3.eth.gas_price

        tx = fn.build_transaction(params)
        signed = account.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    except Exception as e:
        print(f"  ❌ ارسال تراکنش ناموفق: {e}")
        return None

    # 🔑 از اینجا به بعد تراکنش *ارسال شده است*.
    #    هر خطایی که پیش بیاید فقط مربوط به خواندن نتیجه است، نه به خود تراکنش.
    #    این تفکیک مهم است: یک بار در عمل پیش آمد که RPC موقع خواندن رسید 403 داد
    #    و ابزار طوری رفتار کرد که انگار سواپ شکست خورده — در حالی که موفق بود.
    h = tx_hash.hex()
    if not h.startswith("0x"):
        h = "0x" + h

    print(f"\\n  📤 ارسال شد: {h}")
    print(f"     {chain.explorer}/tx/{h}")

    try:
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    except Exception as e:
        print(f"\\n  ⚠️ خواندن رسید ناموفق بود — ولی تراکنش ارسال شده است.")
        print(f"     دلیل: {type(e).__name__}")
        print(f"     وضعیت را خودت چک کن:")
        print(f"       cast receipt {h} --rpc-url <RPC سالم>")
        print(f"     یا در مرورگر: {chain.explorer}/tx/{h}")
        return h          # هش را برمی‌گردانیم چون تراکنش واقعاً ارسال شده

    if receipt.status == 1:
        print(f"  ✅ موفق | گس مصرفی: {receipt.gasUsed:,}")
        return h
    print(f"  ❌ تراکنش revert شد | {chain.explorer}/tx/{h}")
    return None'''

if old in s:
    open(p, "w", encoding="utf-8").write(s.replace(old, new))
    print("✓ executor.py اصلاح شد")
    print("  • هش تراکنش حالا با 0x شروع می‌شود")
    print("  • خطای خواندن رسید دیگر با شکست تراکنش اشتباه گرفته نمی‌شود")
elif "از اینجا به بعد تراکنش" in s:
    print("• قبلاً اعمال شده")
else:
    print("✗ الگو پیدا نشد — فایل شاید تغییر کرده")

import ast
ast.parse(open(p, encoding="utf-8").read())
print("✓ سینتکس سالم")
