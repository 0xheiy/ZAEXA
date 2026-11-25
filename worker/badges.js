/* =====================================================================
   worker/badges.js — نشان‌های Portfolio، فقط از رویدادهای Swapped روی زنجیره
   =====================================================================
   قاعده‌ی محصول (از مالک):
   • فقط از رویدادِ Swappedِ اجراکننده‌های خودمان؛ هرگز localStorage یا ادعای کاربر.
   • یک سواپ فقط وقتی شمرده می‌شود که ≥ ۵ دلار باشد و دلار فقط وقتی قابل‌محاسبه است که
     یک طرفش ETH بومی (address(0))، WETH یا استیبلِ همان زنجیره باشد. بقیه «شمرده نمی‌شوند».
   • 🔴 «نامعلوم هرگز نه نیست»: مکان‌نما (cursor) فقط روی بازه‌ای جلو می‌رود که لاگ‌هایش
     کامل خوانده شده و حکمِ شمرده/نشمرده نهایی است. شکستِ RPC یا قیمتِ نامعلوم = توقف
     در آخرین بلاکِ خوب؛ هرگز «هیچ سواپی نبود».
   • حریم: نشانِ هر کیف با آدرسِ کامل در URL دیده می‌شود (داده‌ی عمومیِ زنجیره)، ولی هیچ
     فهرست/جست‌وجو/نقطه‌ای که کیف‌ها را بشمارد وجود ندارد. */

import { keccak256, utf8Bytes, bytesToHex } from "./keccak.js";
import { LANDING_SVG_DEFS } from "./report_page.js";
import { BADGE_SVG, BADGE_SVG_OFF, OG_PNG_PARTS, BADGE_ART_VERSION } from "./badge-art.js";

export const BADGE_IDS = Object.freeze(["first", "base", "rh", "stock", "ten", "ref1", "ref10"]);
export const BADGE_TITLES = Object.freeze({
  first: "First swap", base: "Base trader", rh: "Robinhood trader", stock: "Stock buyer", ten: "10 swaps", ref1: "First friend", ref10: "Ten friends",
});
export const BADGE_MIN_USD = 5;
export const BADGES_CRON = "47 * * * *";

/* سهام توکنیزه‌ی Base (B20) — کپیِ BASE_TOKENS در web/index.html؛ تستِ برابری هر دو را می‌سنجد. */
export const BASE_STOCKS = Object.freeze([
  "0xb200000000000000000000c2e324d24d7eecd1fb", // AAPLc
  "0xb200000000000000000000d9192b6b456483c2e8", // AMZNc
  "0xb20000000000000000000016e38fd364d271ba28", // ANTc
  "0xb2000000000000000000002d0ba3164cc74f58b7", // GOOGLc
  "0xb2000000000000000000008bc8786b856e61707c", // METAc
  "0xb200000000000000000000ab99cfa739e253872b", // MSFTc
  "0xb2000000000000000000004884b426556b92883d", // MSTRc
  "0xb200000000000000000000fd2f87532b90095211", // MUc
  "0xb20000000000000000000078ee7ce2fe4908108c", // NVDAc
  "0xb2000000000000000000007d16372840df4dabbe", // PLTRc
  "0xb200000000000000000000397293cb8cda9a10c5", // SNDKc
  "0xb2000000000000000000007b9fcbd005511acbd5", // SPCXc
  "0xb2000000000000000000001e800a7f5189430cd0", // TSLAc
]);

/* سهام Robinhood Chain: ۲۰۵ توکنِ رسمی؛ نمادها هم‌ترتیب در RH_STOCK_SYMBOLS. */
export const RH_STOCK_SYMBOLS = Object.freeze([
  "AAOI", "AAPL", "ABCL", "ADBE", "AEHR", "AEIS", "ALAB", "AMAT", "AMBA", "AMC", "AMD", "AMKR", "AMZN",
  "ANET", "ANT", "APLD", "APP", "ASML", "ASTS", "AUR", "AVAV", "AVGO", "AXON", "AXTI", "BA", "BABA", "BB",
  "BE", "BMNR", "BND", "BULL", "CBRS", "CCL", "CEG", "CELH", "CIEN", "CLOV", "CLS", "CLSK", "COHR", "COIN",
  "COST", "CRCL", "CRDO", "CRM", "CRWD", "CRWV", "CSCO", "CTSH", "CVNA", "DDOG", "DELL", "DIS", "DJT", "DOCN",
  "ELF", "EWT", "EWY", "F", "FICO", "FIG", "FISV", "FIX", "FLNC", "FLY", "FTNT", "FUTU", "GDX", "GE", "GEV",
  "GLD", "GLW", "GLXY", "GME", "GOOGL", "HII", "HIMS", "HPE", "HWM", "IBM", "IBRX", "INDA", "INFQ", "INOD",
  "INTC", "INTU", "IONQ", "IREN", "JBL", "JNJ", "JOBY", "JPM", "KLAC", "KSS", "KTOS", "LHX", "LITE", "LLY",
  "LMT", "LRCX", "LULU", "LUNR", "MCD", "MDB", "META", "MOD", "MPWR", "MRNA", "MRVL", "MSFT", "MSTR", "MTSI",
  "MU", "MXL", "NAVN", "NBIS", "NET", "NFLX", "NNE", "NOW", "NU", "NVDA", "NVTS", "OKLO", "ON", "ONTO",
  "ORCL", "OUST", "P", "PANW", "PATH", "PENG", "PFE", "PL", "PLTR", "POET", "POWL", "PR", "PWR", "PYPL",
  "QBTS", "QCOM", "QQQ", "QUBT", "RBLX", "RCAT", "RDDT", "RDW", "RGTI", "RIVN", "RKLB", "RUN", "SATS", "SCHD",
  "SGOV", "SHOP", "SHY", "SIMO", "SKHY", "SLS", "SLV", "SMCI", "SMH", "SMR", "SNAP", "SNDK", "SNOW", "SOFI",
  "SOUN", "SOXX", "SPCX", "SPMO", "SPY", "TE", "TEAM", "TEM", "TER", "TSEM", "TSLA", "TSM", "TTD", "TTEQ",
  "TTWO", "UBER", "UMC", "UNH", "UPS", "USAR", "USO", "V", "VICR", "VRT", "VSAT", "VST", "VTI", "WDAY", "WDC",
  "WULF", "WYFI", "XLK", "XNDU", "XOM", "ZETA", "ZM", "ZS",
]);
export const RH_STOCKS = Object.freeze([
  "0x521cf887e6531c6f667b5bc4d896e5d9bfe8eb2e",
  "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9",
  "0x3139d77ace0cbaa5bdfd38bd1f1911a794af0b0e",
  "0x232b8ed6377be97813853b0ac104c4cda8378d1b",
  "0x5f604fba1162193a4388a5dfa56f556f3e133cc2",
  "0xfaf9cb261b5fcc1f404bb10cd39c5c6c1974e612",
  "0x748c32c3ca24edf31ea597db1f3d330a7a6da3dc",
  "0x36046893810a7e7fce501229d57dc3fc8c8716d0",
  "0x99d9d8663545151603863c5acbd6fc3218899009",
  "0x05a3d1cd21d0c88145e82600e62e7e496e0f222b",
  "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc",
  "0xdd356aa38f40a7b7076755ac854b6fbb1f0d305b",
  "0x12f190a9f9d7d37a250758b26824b97ce941bf54",
  "0x28babd556b60e53663b8615036479a29c2cdd1bf",
  "0xbbb6c29bcc3a1028a2b54310df73f4f7a3bcb373",
  "0xb8dbf92f9741c9ac1c32115e78581f23509916fd",
  "0xa249baf1063af884807c1e1400aef7784836917e",
  "0x47f93d52cbec7c6d2cfc080e154002370a60daea",
  "0x1af6446f07eb1d97c546afc8c9544cbdf3ad5137",
  "0x373c06c4f7bde527d7dae4ba169e42b55e393ced",
  "0xf6290b5e7c26502e2da514c31509849718ea76a5",
  "0x156e175dd063a8ce274c50654ef40e0032b3fbcf",
  "0xc27dbd474af5181c5a8777903690d8d262d12648",
  "0x141eea040c2250eec0314e336975e81f85f6585e",
  "0x4d21483a44bf67a86b77e3da301411880797d452",
  "0xad25ac6c84d497db898fa1e8387bf6af3532a1c4",
  "0x48e39e56acdba37b09020c0b734a613c9a2f100a",
  "0x822cc93ffd030293e9842c30bbd678f530701867",
  "0x9a7842eded60b0fe1e03eec342c82a397c821ed0",
  "0x2f62fc9fabb470c690f141c28340ed832bb27020",
  "0xcef9027c7d6985b85f0ba431125073529a947a68",
  "0x5c90450bbb4273d7b2f17cf6917aeb237a569679",
  "0x9651342cea770ae9a2969ba2a52611523146aef9",
  "0xae517a2903e68bd929dfd15be875f8369d53e94a",
  "0x8cf07c5a878945185d327aaa6e33faa95f95e7bf",
  "0x44f6d488021f8233b9416294d1fe9b1fee28382d",
  "0x62200915e7deab1ec7f79fb246dadbb80eacddd0",
  "0xbf449977089c718c004a66c554b26b94ef3ad4de",
  "0xcbb95bbf36099d34da091dc6fa6f49efa257cee3",
  "0x92f9f459f1a9a5ad266b182be7bffd1c6c666894",
  "0x6330d8c3178a418788df01a47479c0ce7ccf450b",
  "0x4ea005168d7f09a7a0ba9d1def21a479950e44c2",
  "0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5",
  "0x4d67253bc223e6b0e104f1084c1fb2b669ddc41b",
  "0xd95b44124e475743a7589e68f3d74008a5536d44",
  "0xea72ecca2d0f6bfa1394dbbcff85b52cd4233931",
  "0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3",
  "0xf543967eebb6f1917992ef0e68de63ab07a5a0da",
  "0x63d5a3b6939a33f1e75d8bcd85759858239600db",
  "0xa4f319104089fe321dc8093c6e707d4fe190a988",
  "0x27c99fbde9d0d2aa4f4bfb4943f237843ddf6958",
  "0x941ae714ec6d8130c7b75d67160ca08f1e7d11dd",
  "0x501b1b3b79750313ad2c4cccd08586c4c17d7283",
  "0x1d11f0496982706c5e14a514d4e79f2e6bde4516",
  "0xc02f12b9fe9e707079ec0d546f3050d3f6c1f8bd",
  "0x39ec44bee4f6a116c6f9b8de566848a985c53c60",
  "0x1c690498150252222c275a5ced69d3a6b1f52d5e",
  "0x7f0abef0c07280f82c6a08ead09ded6bae2c13fc",
  "0x25c288e6d899b9bc30160965ad9644c67e73be0c",
  "0xa48f22a46c0f1c46ca7d111cb6c137c271987180",
  "0x41f4267525a8aff329540ef24fd83d9044758b33",
  "0x9ece29a4a2397c0a35fb5fa8ee2b9509130a98cc",
  "0x93dbb1d2dc5d63f4abacff30485273f538df68ac",
  "0x282e87451e10fa6679bc7d76c69be44cd3fc777c",
  "0x03bc731ffb162cdd7b98d3c6542bfc291126075d",
  "0x3fb8976980d486084b2eb4a404bd12e72823958f",
  "0xeb30663bdff0622ef4e4e5cbb4e975f19f33f51d",
  "0xbdfa7a06458aa26b8e736e0fc87ad37c3bb8ac2e",
  "0x63b814ddbd6bf339f25fed8c36158a008d5b373e",
  "0x94b8aae43a1ccc08aa64b7d1f29b4d920af4a0c9",
  "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e",
  "0x7c04e6a3368f2a1de3874f0e80d2e0a1a9915da6",
  "0x2d427692e928fa156ec22acfabafa0447c5805b7",
  "0x1b0e319c6a659f002271b69db8a7df2f911c153e",
  "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3",
  "0xeb61c0ed490a367d4e3631ccf8a74b3bfc7e775d",
  "0xccee82fe024c36fa15e1005ede3e9e4787e23d09",
  "0x59dd09d4900c2e4b5f75b7c0d4e6796fcc234cb1",
  "0xaea445c5f3db1a462998ccc422a875a361ee5d99",
  "0x980dcf6766fa79f5cf0c4aadb3ab477ff15a9619",
  "0x7c148f74ac7445d1f28366b7fcdc6792a9fcd0cf",
  "0xacef2e09adb47ad6abebad9ff06689e60615c2b6",
  "0xb853bc83a753342a4f8320ea680b4b1e84118d21",
  "0xf1953dab6fad537488d5a022361ffaa8b4c95ec6",
  "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681",
  "0x56d23bee5f41a7120170b0c603dae30128e460e9",
  "0x558378e000d634a36593e338ebacdd6207640efe",
  "0xf0ab0c93be6f41369d302e55db1a96b3c430212d",
  "0xeaf2512dfc1beac608f8794b3793cd4e02894aa6",
  "0x03dfbbe0ac4e7bcdafd08ed41a400326b77d8c80",
  "0xb334c5ce741b80b5b671f47f5c269cb193fe8e24",
  "0x07c44da0848960bff894f17584db8b2f60b2409e",
  "0x96b933c74ecb4a0926b9210cef7b743ef46be2e9",
  "0x12e3c047bf9aecaf9ddc98c05c31bfd1dd043993",
  "0x7fd06a4d81ccfa3f351394e144d5191874c31313",
  "0x48d60243c66437c6ac3c2495be94747aed5dfe25",
  "0x8ef20885f94e3d9bc7eb3080279188bd5ed7c08c",
  "0x8005d266423c7ea827372c9c864491e5786600ea",
  "0x329fcaceb9ad6f9580dd5f643fed0646900d043c",
  "0x57b0030166db0c31690d1a5aa167e2e26e2c29a4",
  "0x4e62068525ab11fe768e29dfd00ef909b9803016",
  "0xa5d4968421ba94814be3b136b15cf422101ac1a3",
  "0x2fdaa4604f10f4ae7f66fa48a174bcd25b1ece20",
  "0xddf2266b79abf0b48898959b0ed6e6adf512be74",
  "0xc0d6457c16cc70d6790dd43521c899c87ce02f35",
  "0xc6cbad1016b38b797610c25e1dc7d95988b1f362",
  "0x52d50d0280ad1054b43f052bd70a49a212a1b128",
  "0x43b07d15ce533bec5476d70c22a78a1b2b662155",
  "0x62fd0668e10d8b72339be2dcf7643001688ff13b",
  "0xe93237c50d904957cf27e7b1133b510c669c2e74",
  "0xec262a75e413fafd0df80480274532c79d42da09",
  "0xc93f4d80e268ab922e871bd169156c3cc41894e6",
  "0xff080c8ce2e5feadaca0da81314ae59d232d4afd",
  "0x48961813349333209994750ffa89b3c5c22ec969",
  "0xf7181b63fdb858558a74ba96bc42732684cd7965",
  "0x9d9c6684f596f66a64c030b93a886d51fd4d7931",
  "0x116f00968269b7bfbad4109ce591d6e74c0601d4",
  "0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8",
  "0xbef75684c43c4ea7bd18dd532a2244674ee8b926",
  "0x0c3260af4b8f13a69c4c2dfb84fd667890cdfa14",
  "0x408c14038a04f7bd235329e26d2bf569ee20e250",
  "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
  "0xbe6702d7b70315376dc48a3293f24f0982f86386",
  "0x8b2f88497f15a18e9d4ffa1a8ffb8538399ae774",
  "0xbbd09f72b025360fee5c928053dca6248d35be54",
  "0x8ff63eaeee3fe54ba450c4f5538064ec5a893aef",
  "0xb0992820e760d836549ba69bc7598b4af75dee03",
  "0x40e7a279850e443f582059ae5dc1c3b6563e6395",
  "0x1cdad396db64bda184d5182a97dd9b3c62100b7d",
  "0xb039597ed45cba7b6e2fb9e8be51802969cee5be",
  "0xfb2664f07b6aadd29ea7a59d8859b1aeb8645cda",
  "0x9b23573b156b52565012f5ce02cdf60afbaa70be",
  "0x7066a64c24e4206cd62e83bf198c1e7eb361f51e",
  "0xaa4d64474c172010ab57719cb9951e6142a100d3",
  "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a",
  "0xcf6b2d875361be807eafa57458c80f28521f9333",
  "0x237c16d66590f67b886d978acd362eaead8b18c7",
  "0x4189f0c66ebbb0bfef1c31f763131361ef32f77c",
  "0x9ab02ead789b6903c3c44d0ed32f9c707cdf12fd",
  "0xa45abdc77918f7b9199b022eee400c0bc5712bd2",
  "0xc583c60aef9dc401da72cec1b404743a93cea1cc",
  "0x0f17206447090e464c277571124dd2688e48aea9",
  "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68",
  "0x59818904ab4ce163b3ce4ffb64f2d6ca02c434b4",
  "0xf0c4bf4c582cb3836e98394b1d4e7b7281101be8",
  "0xfde6b5d9bb419b10c23268c74e369abff39c0460",
  "0x05b37fb53a299a1b874a619e1c4c404d52c36f4c",
  "0x92ef19e82bd8ff36661de838d5eae7e5cef0effe",
  "0x284358abc07f9359f19f4b5b4ac91901be2597ba",
  "0xb1bf26c1d20ff267a4f93550d1e0d06ac40a114b",
  "0x3b14c39e89d60d627b42a1a4ca45b5bb45fc12e2",
  "0x756bc80af765c82da966a788858d65adf14f3793",
  "0x95052ddcd5dc25641657424a8cf04834997e1730",
  "0xd63abb2c13d7a8421a8017a712802053568e3c1d",
  "0x92fd66527192e3e61d4ddd13322aa222de86f9b5",
  "0xf53f66751b1eff985311b693531e3290f600c410",
  "0xbe274710bf3d9567e1b290ef6a5f9f90ca016fd8",
  "0x77e655e37f4d913fb9540e0d541d824171a60e81",
  "0x84cab63bc87912e71ad199ff14a0ba45de68fef8",
  "0x285b231728c7e4333799183df1094d775246a535",
  "0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f",
  "0xc01aa1fecec0605b13bc84874ff7256c0f5f562a",
  "0x072f979c2cac8e1391b0162a87fee094bf8744a0",
  "0x1eebee7f74517e0279dfb09d25b0407beec3fdd6",
  "0xf6589f11bc40b669e584073f428b05562f568733",
  "0xb90a19ff0af67f7779aff50a882a9cff42446400",
  "0xba0cab75495255d0cb58e22b648bfed4ecd1f47e",
  "0x98e75885157c80992a8d41b696d8c9c6fb30a926",
  "0x6e3dfd9f7e1649baa14d25cac18c94d62db10a54",
  "0x75742c18bc1f1c5c5f448f4c9d9c6f66dafaaa38",
  "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea",
  "0xad622320e520de39e72d41ef07438c3fd3354875",
  "0x117cc2133c37b721f49de2a7a74833232b3b4c0c",
  "0xb1969f6604ca1ae7a2cd3f1827876e914594ca2d",
  "0x5b97476b922f3305131b8f0b9d333172e87f4aae",
  "0xb1cc0ec7db69cf43539119814df40071b9d61793",
  "0x2778c5024d5ca2cdb0f8ead671ffc69963adcd9c",
  "0x89776d4cd68193597a2fc132cfac1fde36ccea8a",
  "0x322f0929c4625ed5bad873c95208d54e1c003b2d",
  "0x58ffe4a942d3885baa22d7520691f611ef09e7aa",
  "0x0b5fb4031cae9163db10b169ee72685f0edc8545",
  "0x80e10255a83b257f5a8674d363f547842aa53b8e",
  "0x5e81213613b6b86eab4c6c50d718d34359459786",
  "0xbd335aa5a1693f0121a5c0ef18a080e9958da78b",
  "0x0e6e67ba88e7b5d9b67636a215c76779b948de79",
  "0xcf364ea52787e289de6f32077834056e3e70d6a8",
  "0xf23250dac154d05bb671cb0d0ebef3c635c79ce2",
  "0xd917b029c761d264c6a312bbbcda868658ef86a6",
  "0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344",
  "0x9bff87700337babf5099e99f322f888dafb1d551",
  "0x6006ed4b2f94110851ff7509d97d034f0eed9226",
  "0xfa78c12e6488814a0262e4e802749a4a737d5fb7",
  "0x26dcbfb34fc83cabd6990f449674efdc6097ff85",
  "0x561e2a49212b7ccf47f2744ccb83e200722fadbc",
  "0x0594134df3f171a354d9c85ebd65b7a6148f6d09",
  "0x82da4646242e1d962e96e932269dc644c94a9caa",
  "0xf52597345a8edf418bc4071b4a35112472277d3e",
  "0x348be1a8663f15edde5cdf8a96bb69078f7ab6fd",
  "0x9e7abd3c9139d14e4c86dce0e455aab7a0c2fb3e",
  "0x15cd20759ce7f3285c29a319de2d1a2e098c6f43",
  "0xa8eb3bccbf2017ee7cbfb652eb51cf2e1b153289",
  "0xf9b46d3d1b22199d4d1025a9cedb540a33f1a2d5",
  "0xe674c5c071821f48bb2d12cadb83617eff438f9e",
  "0x44c4f142009036cf477ed2d09932051843137cf1",
  "0x7dc013eb55e436f30d7ed1afe4e36d6e45e3c3f7",
]);

/* ------------------------------ دعوت (referral) ------------------------------ */
/* قالبِ سیم: data0 + (آدرسِ دعوت‌کننده + REF_MAGIC) + (فقط Base) پسوندِ ERC-8021. */
export const REF_MAGIC = "5a585201";
const ERC8021_MARK = "80218021802180218021802180218021";
const REF_MIN_BYTES = 4 + 20 + 4;
export const REFS_MAX = 10;

/* دعوت‌کننده را از input تراکنش می‌خواند؛ هرگز پرتاب نمی‌کند. */
export function parseRefFromInput(input) {
  try {
    if (typeof input !== "string" || !/^0x[0-9a-fA-F]*$/.test(input) || input.length % 2 !== 0) return null;
    let h = input.slice(2).toLowerCase();
    if (h.endsWith(ERC8021_MARK)) {
      const end = h.length - ERC8021_MARK.length;
      if (end < 4) return null;
      const L = parseInt(h.slice(end - 4, end - 2), 16);
      const cut = ERC8021_MARK.length + 4 + 2 * L;
      if (!(h.length >= cut)) return null;
      h = h.slice(0, h.length - cut);
    }
    if (!h.endsWith(REF_MAGIC) || h.length < REF_MIN_BYTES * 2) return null;
    const a = h.slice(h.length - REF_MAGIC.length - 40, h.length - REF_MAGIC.length);
    if (!/^[0-9a-f]{40}$/.test(a) || /^0{40}$/.test(a)) return null;
    return "0x" + a;
  } catch (e) { return null; }
}

export const SIG_V6 = "Swapped(address,address,address,uint256,uint256,uint256,address)";
export const SIG_V5 = "Swapped(address,address,address,uint256,uint256,uint256)";
const topicOf = (sig) => "0x" + bytesToHex(keccak256(utf8Bytes(sig)));
export const TOPIC0_V6 = topicOf(SIG_V6);
export const TOPIC0_V5 = topicOf(SIG_V5);

const ZERO = "0x0000000000000000000000000000000000000000";

export const BADGE_CHAINS = Object.freeze({
  base: Object.freeze({
    id: "base",
    weth: "0x4200000000000000000000000000000000000006",
    stables: Object.freeze([
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
      "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", // USDT
      "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC
    ]),
    rpcs: null, // از deps.baseRpcs
    fallbackBlocksPerHour: 18000, // بلاکِ ۲۰۰ms
    execs: Object.freeze([
      Object.freeze({ addr: "0x15e511bf2ea1a0f50f25e973d57dce0d01946b6d", ver: 5, topic: TOPIC0_V5,
        creationTx: "0x5f0798986fd30dd33b28f24264718365ac9667be42b2f955b9e9a3cec6d709e1" }),
      Object.freeze({ addr: "0x5f3fccff3339daa9ea7d2ebc3f77017d65467132", ver: 6, topic: TOPIC0_V6,
        creationTx: "0x0563d0ded9e1ba8e25ec26f8e10092e12e889bdd555c5237f094d6be1163bdda" }),
    ]),
  }),
  rh: Object.freeze({
    id: "rh",
    weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    stables: Object.freeze(["0x5fc5360d0400a0fd4f2af552add042d716f1d168"]), // USDG
    rpcs: Object.freeze(["https://rpc.mainnet.chain.robinhood.com"]),
    fallbackBlocksPerHour: 18000,
    execs: Object.freeze([
      Object.freeze({ addr: "0xc261e57cf5739a8a538884405600e4e45df24802", ver: 6, topic: TOPIC0_V6, creationTx: null }),
    ]),
  }),
});

// سقف‌های ثابتِ هر گذر
export const BADGES_RPC_MAX = 20;      // کلِ تماس‌های RPC (هر تلاشِ failover هم یک تماس)
export const BADGES_RH_RPC_MAX = 8;    // سهمِ Robinhood؛ Base بقیه را می‌گیرد
export const BADGES_GT_MAX = 4;
export const BADGES_USERS_MAX = 200;
export const BADGES_SPAN_START = 50000;
export const BADGES_SPAN_MIN = 500;
export const BADGES_CONF = 10;         // بلاکِ اطمینان (reorg)
const RPC_TIMEOUT_MS = 8000;
const SEEN_CAP = 30;

const KEY_CUR = (c, a) => "badges:cur:" + c + ":" + a;
const KEY_SPAN = (c) => "badges:span:" + c;
const KEY_START = (c, a) => "badges:start:" + c + ":" + a;
const KEY_ETHUSD = (d) => "badges:ethusd:" + d;
const KEY_ETHPOOL = "badges:ethpool";
export const KEY_STATUS = "badges:status";
export const KEY_USER = (a) => "badge:u:" + String(a).toLowerCase();

class Unknown extends Error {}

/* ------------------------------ رمزگشایی ------------------------------ */
const ADDR_TOPIC = /^0x[0-9a-fA-F]{64}$/;
export function decodeSwapped(log, ver) {
  if (!log || !Array.isArray(log.topics) || log.topics.length !== 4) return null;
  if (!log.topics.slice(1).every((t) => typeof t === "string" && ADDR_TOPIC.test(t))) return null;
  const data = typeof log.data === "string" ? log.data.replace(/^0x/, "") : "";
  const words = ver === 5 ? 3 : 4;
  if (data.length < words * 64 || /[^0-9a-fA-F]/.test(data)) return null;
  const w = (i) => BigInt("0x" + data.slice(i * 64, i * 64 + 64));
  const a = (t) => "0x" + t.slice(-40).toLowerCase();
  const ev = {
    user: a(log.topics[1]), tokenIn: a(log.topics[2]), tokenOut: a(log.topics[3]),
    amountIn: w(0), amountOut: w(1), fee: w(2), feeToken: null,
  };
  if (ver === 6) ev.feeToken = "0x" + data.slice(3 * 64 + 24, 4 * 64).toLowerCase();
  return ev;
}

/* دلارِ یک سواپ. stable اول (بدونِ نیاز به قیمت)، بعد ETH/WETH (قیمتِ روزانه لازم).
   برمی‌گرداند: {kind:"usd",usd} | {kind:"eth",eth} | {kind:"skip"} */
export function classifySwap(ev, chain) {
  const cfg = typeof chain === "string" ? BADGE_CHAINS[chain] : chain;
  const stable = (t) => cfg.stables.includes(t);
  const eth = (t) => t === ZERO || t === cfg.weth;
  if (stable(ev.tokenIn)) return { kind: "usd", usd: Number(ev.amountIn) / 1e6 };
  if (stable(ev.tokenOut)) return { kind: "usd", usd: Number(ev.amountOut) / 1e6 };
  if (eth(ev.tokenIn)) return { kind: "eth", eth: Number(ev.amountIn) / 1e18 };
  if (eth(ev.tokenOut)) return { kind: "eth", eth: Number(ev.amountOut) / 1e18 };
  return { kind: "skip" };
}

/* ------------------------------ رکوردِ کاربر ------------------------------ */
export function emptyUser() {
  return { v: 1, n: 0, first: null, base: null, rh: null, stock: null, ten: null, ts10: [], seen: [], w: {},
    refs: [], ref1: null, ref10: null, refBy: null };
}
const earlier = (a, b) => a.ts < b.ts || (a.ts === b.ts && a.tx < b.tx);

/* یک سواپِ شمرده‌شده را روی رکورد می‌نشاند. dedupe با seen. true = تغییر کرد. */
export function applyCounted(rec, chain, tx, logIndex, ts, tokenOut, pos) {
  const key = chain + ":" + String(tx).toLowerCase() + ":" + logIndex;
  if (rec.seen.includes(key)) return false;
  /* واترمارکِ هر اجراکننده (بلاک، logIndex): بازپخشِ یک تکه بعد از شکستِ نوشتنِ cursor هرگز دوبار نمی‌شمارد،
     حتی اگر آن تکه بیشتر از SEEN_CAP سواپِ همین کیف داشته باشد. */
  if (pos) {
    const w = rec.w && rec.w[pos.x];
    if (w && (pos.b < w[0] || (pos.b === w[0] && pos.i <= w[1]))) return false;
    rec.w = { ...(rec.w || {}), [pos.x]: [pos.b, pos.i] };
  }
  const e = { c: chain, tx: String(tx).toLowerCase(), ts };
  rec.n += 1;
  const put = (slot) => { if (!rec[slot] || earlier(e, rec[slot])) rec[slot] = e; };
  put("first");
  put(chain === "rh" ? "rh" : "base");
  if ((chain === "base" && BASE_STOCKS.includes(String(tokenOut).toLowerCase())) ||
      (chain === "rh" && RH_STOCKS.includes(String(tokenOut).toLowerCase()))) put("stock");
  rec.ts10.push(e);
  rec.ts10.sort((x, y) => (earlier(x, y) ? -1 : earlier(y, x) ? 1 : 0));
  if (rec.ts10.length > 10) rec.ts10.length = 10;
  rec.ten = rec.ts10.length === 10 ? rec.ts10[9] : null;
  rec.seen.push(key);
  if (rec.seen.length > SEEN_CAP) rec.seen.splice(0, rec.seen.length - SEEN_CAP);
  return true;
}

/* ------------------------------ RPC ------------------------------ */
const RANGE_RE = /range|limit|too many|exceed|size|more than|max/i;
function isRangeError(err) {
  if (!err || typeof err !== "object") return false;
  const code = typeof err.code === "number" ? err.code : null;
  if (code === -32005 || code === -32602) return true;
  return typeof err.message === "string" && !/rate/i.test(err.message) && RANGE_RE.test(err.message);
}

async function rpcCall(ctx, chain, method, params) {
  const list = ctx.rpcs[chain] || [];
  for (const url of list) {
    if (ctx.dead.has(url)) continue;
    if (ctx.rpcLeft <= 0 || ctx.chainLeft <= 0) return { ok: false, budget: true };
    ctx.rpcLeft--; ctx.chainLeft--; ctx.rpcUsed++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RPC_TIMEOUT_MS);
    let res = null;
    try {
      res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ac.signal,
      });
    } catch (e) { res = null; }
    clearTimeout(timer);
    if (!res || res.status !== 200) { ctx.dead.add(url); continue; }
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!body || typeof body !== "object") { ctx.dead.add(url); continue; }
    if (body.error) {
      if (isRangeError(body.error)) return { ok: false, range: true };
      ctx.dead.add(url);
      continue;
    }
    return { ok: true, result: body.result };
  }
  return { ok: false };
}

const hex = (n) => "0x" + BigInt(n).toString(16);
const toNum = (h) => (typeof h === "string" && /^0x[0-9a-fA-F]+$/.test(h) ? Number(BigInt(h)) : null);

/* ------------------------------ قیمتِ ETH/USD روزانه ------------------------------ */
const dayOf = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
const todayUtc = (ctx) => new Date(ctx.now()).toISOString().slice(0, 10);

async function gtJson(ctx, rest) {
  if (ctx.gtLeft <= 0 || typeof ctx.deps.gt !== "function") return null;
  ctx.gtLeft--;
  try {
    const r = await ctx.deps.gt(rest);
    if (!r || r.status !== 200) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function ethPool(ctx) {
  try {
    const raw = await ctx.kv.get(KEY_ETHPOOL);
    if (raw) { const j = JSON.parse(raw); if (j && /^0x[0-9a-f]{40}$/.test(j.pool) && (j.token === "base" || j.token === "quote")) return j; }
  } catch (e) { /* دوباره پیدا می‌شود */ }
  const weth = BADGE_CHAINS.base.weth, usdc = BADGE_CHAINS.base.stables[0];
  const j = await gtJson(ctx, "networks/base/tokens/" + weth + "/pools?page=1");
  const rows = j && Array.isArray(j.data) ? j.data : [];
  let best = null;
  for (const r of rows) {
    const a = r && r.attributes, rel = r && r.relationships;
    const b = rel && rel.base_token && rel.base_token.data && String(rel.base_token.data.id || "").toLowerCase();
    const q = rel && rel.quote_token && rel.quote_token.data && String(rel.quote_token.data.id || "").toLowerCase();
    const addr = a && String(a.address || "").toLowerCase();
    const res = a ? Number(a.reserve_in_usd) : NaN;
    if (!addr || !/^0x[0-9a-f]{40}$/.test(addr) || !(res > 0)) continue;
    let token = null;
    if (b === "base_" + weth && q === "base_" + usdc) token = "base";
    else if (q === "base_" + weth && b === "base_" + usdc) token = "quote";
    if (token && (!best || res > best.res)) best = { pool: addr, token, res };
  }
  if (!best) return null;
  const out = { pool: best.pool, token: best.token };
  try { await ctx.kv.put(KEY_ETHPOOL, JSON.stringify(out)); } catch (e) { /* بعداً دوباره */ }
  return out;
}

async function loadOhlcv(ctx) {
  if (ctx.ohlcv !== undefined) return ctx.ohlcv;
  ctx.ohlcv = null;
  const p = await ethPool(ctx);
  if (!p) return null;
  const j = await gtJson(ctx, "networks/base/pools/" + p.pool + "/ohlcv/day?aggregate=1&limit=1000&currency=usd&token=" + p.token);
  const list = j && j.data && j.data.attributes && j.data.attributes.ohlcv_list;
  if (!Array.isArray(list)) return null;
  const m = new Map();
  for (const r of list) {
    if (!Array.isArray(r)) continue;
    const t = Number(r[0]), c = Number(r[4]);
    if (Number.isFinite(t) && Number.isFinite(c) && c > 0) m.set(dayOf(t), c);
  }
  ctx.ohlcv = m;
  return m;
}

/* بستهٔ ETH/USD آن روزِ UTC؛ روزِ ناتمام یا ناخوانا = null (نامعلوم). */
async function ethUsdForDay(ctx, day) {
  if (ctx.prices.has(day)) return ctx.prices.get(day);
  let v = null;
  if (day >= todayUtc(ctx)) { ctx.prices.set(day, null); return null; }
  let raw = null;
  try { raw = await ctx.kv.get(KEY_ETHUSD(day)); } catch (e) { raw = null; }
  const cached = raw === null || raw === undefined ? NaN : Number(raw);
  if (Number.isFinite(cached) && cached > 0) v = cached;
  else {
    const m = await loadOhlcv(ctx);
    const c = m ? m.get(day) : undefined;
    if (c !== undefined) {
      v = c;
      try { await ctx.kv.put(KEY_ETHUSD(day), String(c)); } catch (e) { /* فقط کش */ }
    }
  }
  ctx.prices.set(day, v);
  return v;
}

/* ۲۴ نوامبر — سواپِ اتریِ امروز منتظرِ بسته‌ی روز نمی‌ماند (متنِ نشان‌ها «تا یک ساعت» می‌گوید):
   بسته‌ی همان ساعتِ تمام‌شده از OHLCVِ ساعتی (۴۸ ساعتِ اخیر، یک تماس در هر گذر). ساعتِ ناتمام یا ناخوانا = null (نامعلوم). */
async function loadHourly(ctx) {
  if (ctx.hourly !== undefined) return ctx.hourly;
  ctx.hourly = null;
  const p = await ethPool(ctx);
  if (!p) return null;
  const j = await gtJson(ctx, "networks/base/pools/" + p.pool + "/ohlcv/hour?aggregate=1&limit=48&currency=usd&token=" + p.token);
  const list = j && j.data && j.data.attributes && j.data.attributes.ohlcv_list;
  if (!Array.isArray(list)) return null;
  const m = new Map();
  for (const r of list) {
    if (!Array.isArray(r)) continue;
    const t = Number(r[0]), c = Number(r[4]);
    if (Number.isFinite(t) && Number.isFinite(c) && c > 0) m.set(t, c);
  }
  ctx.hourly = m;
  return m;
}
async function ethUsdAt(ctx, ts) {
  const day = dayOf(ts);
  if (day < todayUtc(ctx)) return ethUsdForDay(ctx, day);
  const hour = Math.floor(ts / 3600) * 3600;
  if ((hour + 3600) * 1000 > ctx.now()) return null;        // ساعتِ جاری هنوز بسته نشده
  const m = await loadHourly(ctx);
  const c = m ? m.get(hour) : undefined;
  return c === undefined ? null : c;
}

async function blockTs(ctx, chain, log) {
  const inline = toNum(log.blockTimestamp);
  if (inline !== null) return inline;
  const bn = toNum(log.blockNumber);
  if (bn === null) throw new Unknown("block");
  const k = chain + ":" + bn;
  if (ctx.ts.has(k)) return ctx.ts.get(k);
  const r = await rpcCall(ctx, chain, "eth_getBlockByNumber", [hex(bn), false]);
  const ts = r.ok && r.result ? toNum(r.result.timestamp) : null;
  if (ts === null) throw new Unknown("ts");
  ctx.ts.set(k, ts);
  return ts;
}

/* ------------------------------ پردازشِ یک تکه از لاگ‌ها ------------------------------ */
async function getUser(ctx, addr) {
  if (ctx.users.has(addr)) return ctx.users.get(addr);
  if (ctx.users.size >= BADGES_USERS_MAX) throw new Unknown("users");
  const raw = await ctx.kv.get(KEY_USER(addr));
  let rec = emptyUser();
  if (raw) {
    try { const j = JSON.parse(raw); if (j && j.v === 1) rec = { ...emptyUser(), ...j }; }
    catch (e) { throw new Unknown("user-json"); }
  }
  const entry = { rec, before: JSON.stringify(rec) };
  ctx.users.set(addr, entry);
  return entry;
}

async function flushUsers(ctx) {
  for (const [addr, e] of ctx.users) {
    const now = JSON.stringify(e.rec);
    if (now !== e.before) { await ctx.kv.put(KEY_USER(addr), now); e.before = now; }
  }
}

/* برمی‌گرداند آخرین بلاکی که کامل و نهایی پردازش شد (≥ from-1). */
async function applyLogs(ctx, cfg, exec, logs, from, to) {
  const sorted = logs.slice().sort((a, b) => (toNum(a.blockNumber) - toNum(b.blockNumber)) || (toNum(a.logIndex) - toNum(b.logIndex)));
  let done = from - 1;
  let cur = from; // بلاکی که الان در دست است
  let i = 0;
  try {
    while (i < sorted.length) {
      const bn = toNum(sorted[i].blockNumber);
      cur = bn === null ? from : bn;
      if (bn === null || bn < from || bn > to) throw new Unknown("block-range");
      while (i < sorted.length && toNum(sorted[i].blockNumber) === bn) {
        const log = sorted[i];
        if (log.removed) throw new Unknown("removed");
        const ev = decodeSwapped(log, exec.ver);
        if (!ev) throw new Unknown("decode");
        const c = classifySwap(ev, cfg);
        if (c.kind !== "skip") {
          let usd = c.kind === "usd" ? c.usd : null;
          let ts = null;
          if (c.kind === "eth") {
            ts = await blockTs(ctx, cfg.id, log);
            const px = await ethUsdAt(ctx, ts);
            if (px === null) throw new Unknown("price");
            usd = c.eth * px;
          }
          if (usd >= BADGE_MIN_USD) {
            if (ts === null) ts = await blockTs(ctx, cfg.id, log);
            const u = await getUser(ctx, ev.user);
            const txh = String(log.transactionHash).toLowerCase();
            const isFirst = u.rec.n === 0 && u.rec.refBy === null && !u.rec.seen.includes(cfg.id + ":" + txh + ":" + toNum(log.logIndex));
            let ref = null, R = null;
            if (isFirst) {
              /* 🔴 تراکنش پیش از applyCounted خوانده می‌شود؛ شکست = Unknown و بازپخشِ کامل. */
              const r = await rpcCall(ctx, cfg.id, "eth_getTransactionByHash", [log.transactionHash]);
              const tx = r.ok && r.result && typeof r.result === "object" ? r.result : null;
              if (!tx || typeof tx.from !== "string" || typeof tx.to !== "string" || typeof tx.input !== "string") throw new Unknown("ref-tx");
              if (tx.from.toLowerCase() === ev.user && tx.to.toLowerCase() === exec.addr) {
                const p = parseRefFromInput(tx.input);
                if (p && p !== ev.user) ref = p;
              }
              if (ref) R = await getUser(ctx, ref);
            }
            if (applyCounted(u.rec, cfg.id, log.transactionHash, toNum(log.logIndex), ts, ev.tokenOut, { x: exec.addr, b: bn, i: toNum(log.logIndex) })) {
              ctx.counted++;
              if (isFirst) {
                if (!ref) u.rec.refBy = { a: null };
                else {
                  u.rec.refBy = { a: ref };
                  const e = { u: ev.user, c: cfg.id, tx: txh, ts };
                  const rr = R.rec;
                  if (!rr.refs.some((x) => x.u === ev.user) && (rr.refs.length < REFS_MAX || earlier(e, rr.refs[rr.refs.length - 1]))) {
                    rr.refs.push(e);
                    rr.refs.sort((x, y) => (earlier(x, y) ? -1 : earlier(y, x) ? 1 : 0));
                    if (rr.refs.length > REFS_MAX) rr.refs.length = REFS_MAX;
                  }
                  const pick = (x) => ({ c: x.c, tx: x.tx, ts: x.ts });
                  rr.ref1 = rr.refs.length ? pick(rr.refs[0]) : null;
                  rr.ref10 = rr.refs.length === REFS_MAX ? pick(rr.refs[REFS_MAX - 1]) : null;
                }
              }
            }
          }
        }
        i++;
      }
      done = bn;
    }
    done = to;
    return done;
  } catch (e) {
    if (!(e instanceof Unknown)) throw e; // خطای KV و مانند آن: بالاتر مکان‌نما را جلو نمی‌برد
    return Math.max(done, cur - 1); // همه‌ی بلاک‌های پیش از بلاکِ شکست‌خورده نهایی‌اند؛ خودِ آن دوباره خوانده می‌شود (dedupe با seen/w)
  }
}

/* ------------------------------ شروعِ هر اجراکننده ------------------------------ */
async function startBlock(ctx, cfg, exec, safeHead) {
  const key = KEY_START(cfg.id, exec.addr);
  let raw = null;
  try { raw = await ctx.kv.get(key); } catch (e) { return null; }
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  if (cfg.id === "base") {
    const r = await rpcCall(ctx, "base", "eth_getTransactionReceipt", [exec.creationTx]);
    const rc = r.ok ? r.result : null;
    const bn = rc ? toNum(rc.blockNumber) : null;
    if (bn === null) return null;
    if (rc.contractAddress && String(rc.contractAddress).toLowerCase() !== exec.addr) return null;
    await ctx.kv.put(key, String(bn));
    return bn;
  }
  // Robinhood: جست‌وجوی دودویی روی eth_getCode، قابلِ ادامه بین گذرها
  let st = null;
  if (raw) { try { st = JSON.parse(raw); } catch (e) { st = null; } }
  if (!st || !Number.isFinite(st.lo) || !Number.isFinite(st.hi)) {
    const r = await rpcCall(ctx, cfg.id, "eth_getCode", [exec.addr, hex(safeHead)]);
    if (!r.ok || typeof r.result !== "string") return null;
    if (r.result === "0x") return null; // هنوز کدی نیست یا نامعلوم؛ هرگز حدس نمی‌زنیم
    st = { lo: 0, hi: safeHead };
  }
  while (st.hi - st.lo > 1) {
    const mid = Math.floor((st.lo + st.hi) / 2);
    const r = await rpcCall(ctx, cfg.id, "eth_getCode", [exec.addr, hex(mid)]);
    if (!r.ok || typeof r.result !== "string") break;
    if (r.result === "0x") st.lo = mid; else st.hi = mid;
  }
  if (st.hi - st.lo <= 1) {
    await ctx.kv.put(key, String(st.hi));
    return st.hi;
  }
  await ctx.kv.put(key, JSON.stringify(st));
  return null;
}

/* ------------------------------ گذرِ یک زنجیره ------------------------------ */
async function runChain(ctx, cfg, prev) {
  const out = { cursor: null, head: null, complete: false, at: ctx.now() };
  const h = await rpcCall(ctx, cfg.id, "eth_blockNumber", []);
  const head = h.ok ? toNum(h.result) : null;
  if (head === null) { out.stale = true; out.head = prev ? prev.head : null; out.cursor = prev ? prev.cursor : null; return out; }
  const safeHead = head - BADGES_CONF;
  out.head = head;
  let bph = cfg.fallbackBlocksPerHour;
  if (prev && Number.isFinite(prev.head) && Number.isFinite(prev.at) && ctx.now() > prev.at + 60000 && head > prev.head) {
    const r = (head - prev.head) / ((ctx.now() - prev.at) / 1000);
    if (r > 0.05 && r < 50) bph = Math.ceil(r * 3600);
  }
  let spanRaw = null;
  try { spanRaw = await ctx.kv.get(KEY_SPAN(cfg.id)); } catch (e) { spanRaw = null; }
  let span = /^\d+$/.test(spanRaw || "") ? Math.max(BADGES_SPAN_MIN, Math.min(BADGES_SPAN_START, Number(spanRaw))) : BADGES_SPAN_START;
  const span0 = span;
  const cursors = [];
  let allDone = true;
  for (const exec of cfg.execs) {
    let cursor = null;
    const start = await startBlock(ctx, cfg, exec, safeHead);
    if (start === null) { allDone = false; cursors.push(null); break; }
    let raw = null;
    try { raw = await ctx.kv.get(KEY_CUR(cfg.id, exec.addr)); } catch (e) { allDone = false; cursors.push(null); break; }
    cursor = /^\d+$/.test(raw || "") ? Number(raw) : start - 1;
    let stopped = false;
    while (cursor < safeHead && !stopped) {
      const from = cursor + 1, to = Math.min(from + span - 1, safeHead);
      const r = await rpcCall(ctx, cfg.id, "eth_getLogs", [{ address: exec.addr, topics: [exec.topic], fromBlock: hex(from), toBlock: hex(to) }]);
      if (!r.ok) {
        if (r.range && span > BADGES_SPAN_MIN) { span = Math.max(BADGES_SPAN_MIN, span >> 1); continue; }
        stopped = true; break;
      }
      if (!Array.isArray(r.result)) { stopped = true; break; }
      let done = from - 1;
      try {
        done = await applyLogs(ctx, cfg, exec, r.result, from, to);
        await flushUsers(ctx);
        ctx.users.clear();
      } catch (e) { stopped = true; break; }
      if (done >= from) {
        cursor = done;
        try { await ctx.kv.put(KEY_CUR(cfg.id, exec.addr), String(cursor)); } catch (e) { stopped = true; }
      }
      if (done < to) stopped = true;
    }
    cursors.push(cursor);
    // ترتیبِ زمانی: v6 فقط بعد از اینکه v5 تا سرِ زنجیره خوانده شد
    if (cursor === null || cursor < safeHead) { allDone = false; break; }
  }
  if (span !== span0) { try { await ctx.kv.put(KEY_SPAN(cfg.id), String(span)); } catch (e) { /* خوب */ } }
  const got = cursors.filter((c) => c !== null);
  out.cursor = got.length === cfg.execs.length ? Math.min(...got) : (prev ? prev.cursor : null);
  out.complete = got.length === cfg.execs.length && got.every((c) => c >= head - bph);
  out.bph = bph;
  return out;
}

export function baseRpcList(env, v4LogRpcs) {
  const l = Array.isArray(v4LogRpcs) ? v4LogRpcs.slice() : [];
  const own = env && typeof env.BASE_RPC === "string" && env.BASE_RPC;
  if (own && !l.includes(own)) l.push(own);
  return l;
}

/* گذرِ ساعتیِ نشان‌ها. هرگز پرتاب نمی‌کند. deps: {gt(rest)→Response, baseRpcs:[url], now?} */
export async function runBadgesPass(env, deps) {
  const d = deps || {};
  const kv = env && env.ZX_KV;
  if (!kv) return { skipped: "no-kv" };
  try {
    const ctx = {
      env, kv, deps: d, now: d.now || (() => Date.now()),
      rpcs: { base: d.baseRpcs || [], rh: BADGE_CHAINS.rh.rpcs },
      rpcLeft: BADGES_RPC_MAX, chainLeft: 0, rpcUsed: 0, gtLeft: BADGES_GT_MAX,
      dead: new Set(), ts: new Map(), prices: new Map(), users: new Map(), counted: 0,
    };
    let prev = null;
    try { prev = JSON.parse((await kv.get(KEY_STATUS)) || "null"); } catch (e) { prev = null; }
    const status = { base: prev && prev.base ? prev.base : null, rh: prev && prev.rh ? prev.rh : null };
    for (const id of ["rh", "base"]) {
      ctx.chainLeft = id === "rh" ? Math.min(BADGES_RH_RPC_MAX, ctx.rpcLeft) : ctx.rpcLeft;
      ctx.users = new Map();
      try { status[id] = await runChain(ctx, BADGE_CHAINS[id], status[id]); }
      catch (e) { status[id] = { ...(status[id] || {}), complete: false, stale: true }; }
    }
    try { await kv.put(KEY_STATUS, JSON.stringify(status)); } catch (e) { /* بعدی */ }
    return { rpc: ctx.rpcUsed, counted: ctx.counted, status };
  } catch (e) {
    return { error: true };
  }
}

/* ------------------------------ خروجی برای مسیرها ------------------------------ */
async function readStatus(kv) {
  try { return JSON.parse((await kv.get(KEY_STATUS)) || "null") || {}; } catch (e) { return {}; }
}

/* ساختِ JSON: state = got | pending | none (نامعلوم هرگز «none» نیست). */
export function badgesDoc(addr, rec, status) {
  const r = rec || emptyUser();
  const cb = !!(status && status.base && status.base.complete);
  const cr = !!(status && status.rh && status.rh.complete);
  const need = { first: cb && cr, base: cb, rh: cr, stock: cb && cr, ten: cb && cr, ref1: cb && cr, ref10: cb && cr };
  const badges = BADGE_IDS.map((id) => {
    const g = r[id];
    if (g) return { id, got: true, state: "got", ts: g.ts, tx: g.tx, chain: g.c };
    return { id, got: false, state: need[id] ? "none" : "pending" };
  });
  return { address: String(addr).toLowerCase(), complete: { base: cb, rh: cr }, n: r.n || 0, badges, progress: { ten: Math.min(r.n || 0, 10), ref: Math.min(Array.isArray(r.refs) ? r.refs.length : 0, REFS_MAX) } };
}

const NOINDEX = { "x-robots-tag": "noindex" };
const ADDR_PATH = /^\/badges\/(0x[0-9a-fA-F]{40})(\.json)?$/;

function notFound() {
  return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", ...NOINDEX } });
}

const shortAddr = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDate(ts) {
  const d = new Date(ts * 1000);
  return MON[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear();
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const PAGE_CSS = ":root{--bg:#0a0810;--card:#131020;--line:#221d33;--tx:#f0eef7;--tx2:#a49fb8;--tx3:#736d8a;--g1:#22EFF6;--g2:#C56CF5}" +
  "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.55 ui-sans-serif,-apple-system,'Segoe UI',Roboto,sans-serif}" +
  "a{color:inherit;text-decoration:none}header{padding:18px 26px;border-bottom:1px solid var(--line)}" +
  ".brand{display:inline-flex;align-items:center;gap:12px}.mark{height:26.5px;width:auto;display:block}.word{height:12.7px;width:auto;display:block;color:var(--tx)}" +
  "main{max-width:980px;margin:0 auto;padding:34px 20px 60px}h1{margin:0 0 4px;font-size:28px;letter-spacing:-.01em}" +
  ".sub{margin:0 0 26px;color:var(--tx2);font-size:14px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}" +
  ".grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}" +
  ".medal{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px 10px;text-align:center}" +
  ".medal img{width:100%;max-width:172px;height:auto;display:block;margin:0 auto 10px}" +
  ".medal b{display:block;font-size:14px}.medal span{display:block;font-size:12.5px;color:var(--tx3);margin-top:2px}" +
  ".cta{display:inline-block;margin-top:30px;padding:14px 22px;border-radius:999px;font-weight:700;font-size:13px;color:#05121a;background:linear-gradient(105deg,var(--g1),#50c8f6 42%,var(--g2))}" +
  "@media(max-width:720px){.grid{grid-template-columns:repeat(2,1fr)}h1{font-size:23px}}";

export function badgePageHtml(addr, doc) {
  const got = doc.badges.filter((b) => b.got).length;
  const cards = doc.badges.map((b) => {
    const when = b.got ? fmtDate(b.ts) : b.state === "pending" ? "Still reading history" : "Not yet";
    return '<div class="medal' + (b.got ? "" : " off") + '"><img src="/badges/art/' + b.id + (b.got ? "" : "-off") + ".svg?v=" + BADGE_ART_VERSION +
      '" alt="" width="140" height="140"><b>' + esc(BADGE_TITLES[b.id]) + "</b><span>" + esc(when) + "</span></div>";
  }).join("");
  const desc = got + " of 7 Zaexa badges";
  return "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">" +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>Zaexa badges</title>" +
    '<meta name="robots" content="noindex">' +
    '<meta name="description" content="' + esc(desc) + '">' +
    '<meta property="og:type" content="website"><meta property="og:site_name" content="Zaexa">' +
    '<meta property="og:title" content="Zaexa badges">' +
    '<meta property="og:description" content="' + esc(desc) + '">' +
    '<meta property="og:image" content="https://zaexa.com/badges/og.png">' +
    '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">' +
    '<meta name="twitter:card" content="summary_large_image">' +
    '<meta name="twitter:title" content="Zaexa badges"><meta name="twitter:description" content="' + esc(desc) + '">' +
    "<style>" + PAGE_CSS + "</style></head><body>" + LANDING_SVG_DEFS +
    '<header><a class="brand" href="/" aria-label="Zaexa home"><svg class="mark" viewBox="0 0 1000 697.98" aria-hidden="true"><use href="#zxMark"/></svg>' +
    '<svg class="word" viewBox="0 0 2581.74 300" aria-hidden="true"><use href="#zxWord"/></svg></a></header>' +
    "<main><h1>Zaexa badges</h1><p class=\"sub mono\">" + esc(shortAddr(addr)) + " · " + esc(desc) + "</p>" +
    '<div class="grid">' + cards + "</div>" +
    '<a class="cta" href="/app">Open Zaexa</a></main></body></html>\n';
}

const PAGE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

let ogBytes = null;
function ogPng() {
  if (ogBytes) return ogBytes;
  const bin = atob(OG_PNG_PARTS.join(""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  ogBytes = out;
  return out;
}

/* GET /badges/... — هر پاسخ X-Robots-Tag: noindex دارد. هیچ فهرست/ایندکسی نیست. */
export async function badgesRoute(request, url, env) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: NOINDEX });
  const head = request.method === "HEAD";
  const p = url.pathname;
  const m = ADDR_PATH.exec(p);
  if (m) {
    const addr = m[1].toLowerCase();
    const kv = env && env.ZX_KV;
    let rec = null, status = {};
    try {
      if (!kv) throw new Error("no-kv");
      const raw = await kv.get(KEY_USER(addr));
      rec = raw ? JSON.parse(raw) : null;
      status = await readStatus(kv);
    } catch (e) {
      return new Response(head ? null : JSON.stringify({ error: "unavailable" }), {
        status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...NOINDEX } });
    }
    const doc = badgesDoc(addr, rec, status);
    if (m[2]) {
      return new Response(head ? null : JSON.stringify(doc), { status: 200, headers: {
        "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60",
        "access-control-allow-origin": "*", ...NOINDEX } });
    }
    return new Response(head ? null : badgePageHtml(addr, doc), { status: 200, headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60",
      "content-security-policy": PAGE_CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...NOINDEX } });
  }
  const art = /^\/badges\/art\/([a-z0-9]+)(-off)?\.svg$/.exec(p);
  const artMap = art && art[2] ? BADGE_SVG_OFF : BADGE_SVG; // «-off» = هنرِ قفل
  if (art && Object.prototype.hasOwnProperty.call(artMap, art[1]) && BADGE_IDS.includes(art[1])) {
    const versioned = url.searchParams.get("v") === BADGE_ART_VERSION;
    return new Response(head ? null : artMap[art[1]], { status: 200, headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": versioned ? "public, max-age=31536000, immutable" : "public, max-age=3600",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff", ...NOINDEX } });
  }
  if (p === "/badges/og.png") {
    const b = ogPng();
    return new Response(head ? null : b, { status: 200, headers: {
      "content-type": "image/png", "content-length": String(b.length),
      "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff", ...NOINDEX } });
  }
  return notFound();
}
