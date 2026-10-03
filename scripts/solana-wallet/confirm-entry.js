import bs58 from "bs58";
import nacl from "tweetnacl";
import { confirmConnection } from "./connection.js";
// بسته‌ی کوچک فقط برای کیف‌پول‌های تزریق‌شده — بدون WalletConnect/QRCode
export { confirmConnection, nacl, bs58 };
