import asyncio,json,subprocess,os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
KEY=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import nacl from './scripts/solana-wallet/node_modules/tweetnacl/nacl-fast.js';import bs58 from './scripts/solana-wallet/node_modules/bs58/src/esm/index.js';const k=nacl.sign.keyPair();console.log(JSON.stringify({publicKey:[...k.publicKey],secretKey:[...k.secretKey],address:bs58.encode(k.publicKey)}));"],text=True))
INIT='''(() => {
 const key=KEY;window.evmRequests=[];window.proofs=[];window.disconnectCalls=0;
 window.ethereum={isMetaMask:true,request:async({method})=>{evmRequests.push(method);return ['0x1234567890123456789012345678901234567890'];},on:()=>{}};
 const account={address:key.address,publicKey:new Uint8Array(key.publicKey),chains:['solana:mainnet'],features:['solana:signMessage']};
 const wallet={name:'Phantom test',chains:['solana:mainnet'],accounts:[account],features:{
  'standard:connect':{connect:async()=>({accounts:[account]})},'standard:disconnect':{disconnect:async()=>{++disconnectCalls;}},
  'solana:signMessage':{signMessage:({message})=>new Promise((resolve,reject)=>{
   proofs.push(SolMobile.bs58.encode(message));window.approveTest=()=>resolve([{signedMessage:message,signature:SolMobile.nacl.sign.detached(message,new Uint8Array(key.secretKey))}]);
   window.rejectTest=()=>reject(Object.assign(Error('Rejected'),{code:4001}));
  })}
 }};window.addEventListener('wallet-standard:app-ready',e=>e.detail.register(wallet));
})();'''.replace('KEY',json.dumps(KEY))
async def main():
 async with async_playwright() as p:
  b=await p.chromium.launch();page=await b.new_page(viewport={'width':390,'height':844});errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)));await page.add_init_script(INIT)
  async def route(r):
   path=urlparse(r.request.url).path
   if path in ['/pairs','/pairs.html']:return await r.fulfill(path=str(ROOT/'pairs.html'),content_type='text/html')
   if path=='/pairs.json':return await r.fulfill(json={'rows':[],'updatedAt':1700000000})
   if path=='/ev':return await r.fulfill(status=204,body='')
   file=ROOT/path.lstrip('/')
   if file.is_file():return await r.fulfill(path=str(file))
   return await r.fulfill(status=200,json={'data':[]})
  await page.route('**/*',route);await page.goto('http://zaexa.test/pairs?chain=solana')
  await page.wait_for_function('typeof zaexaPairsSolana!=="undefined"');await page.wait_for_timeout(250)

  assert await page.locator('body>header #themeBtn').is_visible()
  assert await page.locator('#setPop #themeBtn, #walletPop #themeBtn').count()==0
  before=await page.get_attribute('html','data-theme')
  await page.locator('#themeBtn').click()
  after=await page.get_attribute('html','data-theme');assert after!=before
  assert await page.evaluate('localStorage.getItem("zaexa.theme.v1")')==after
  assert await page.locator('#themeBtn').get_attribute('aria-label')==('Switch to light mode' if after=='dark' else 'Switch to dark mode')
  await page.locator('#themeBtn').click();assert await page.get_attribute('html','data-theme')==before
  assert await page.evaluate('evmRequests.length')==0
  await page.locator('#connectBtn').click();assert await page.locator('#walList .walName').all_text_contents()==['Phantom test','WalletConnect']
  await page.locator('#walList .walRow').first.click();await page.wait_for_function('proofs.length===1')
  assert await page.locator('#connectBtn').inner_text()=='Approve in wallet…'
  await page.evaluate('rejectTest()');await page.wait_for_function('!document.querySelector("#connectBtn").disabled')
  assert await page.locator('#connectBtn').inner_text()=='Connect wallet'
  await page.locator('#connectBtn').click();await page.locator('#walList .walRow').first.click();await page.wait_for_function('proofs.length===2')
  await page.locator('#walClose').click();await page.evaluate('approveTest()');await page.wait_for_timeout(50)
  assert await page.locator('#connectBtn').inner_text()=='Connect wallet'
  await page.locator('#connectBtn').click();await page.locator('#walList .walRow').first.click();await page.wait_for_function('proofs.length===3')
  await page.evaluate('approveTest()');await page.wait_for_function('document.querySelector("#connectBtn").textContent!=="Approve in wallet…"')
  expected=KEY['address'][:6]+'…'+KEY['address'][-4:];assert await page.locator('#connectBtn').inner_text()==expected
  await page.locator('#connectBtn').click();assert await page.locator('#walletAddr').inner_text()==expected
  await page.locator('#disconnectBtn').click();assert await page.locator('#connectBtn').inner_text()=='Connect wallet'
  assert await page.evaluate('disconnectCalls')>=2
  await page.locator('#connectBtn').click();await page.locator('#walList .walRow').first.click();await page.wait_for_function('proofs.length===4')
  assert await page.evaluate('new Set(proofs).size')==4
  await page.locator('#walClose').click();await page.evaluate('approveTest()')
  await page.locator('#chainTabs [data-chain="base"]').click();assert await page.locator('#connectBtn').inner_text()=='Connect wallet'
  await page.locator('#connectBtn').click();assert 'MetaMask' in await page.locator('#walList').inner_text()
  await page.locator('#walList .walRow').first.click();await page.wait_for_function('evmRequests.includes("eth_requestAccounts")')
  await page.locator('#chainTabs [data-chain="solana"]').click();assert await page.locator('#connectBtn').inner_text()=='Connect wallet'
  await page.reload();await page.wait_for_function('typeof zaexaPairsSolana!=="undefined"');assert await page.locator('#connectBtn').inner_text()=='Connect wallet'
  assert await page.evaluate('evmRequests.length')==0
  assert await page.locator('#srcMenu, #srcChip').count()==0
  for width in [360,390,430,768,960,1280]:
   await page.set_viewport_size({'width':width,'height':844});assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  await page.evaluate('Object.defineProperty(navigator,"userAgent",{value:"Android Mobile",configurable:true})')
  await page.set_viewport_size({'width':390,'height':844})
  await page.locator('#connectBtn').click();assert 'Solflare' in await page.locator('#walList').inner_text()
  if os.environ.get('ZAEXA_TEST_ARTIFACTS'):
   await page.screenshot(path=str(Path(os.environ['ZAEXA_TEST_ARTIFACTS'])/'pairs-solana-mobile.png'))
  await page.locator('#walClose').click()
  await page.evaluate('''async()=>{
   const l=await new Promise(resolve=>{const s=document.createElement('script');s.src='/solana-wallet.bundle.b6eb73e1.js';s.onload=()=>resolve(SolMobile);document.head.appendChild(s);});
   const handlers={},kp=l.nacl.sign.keyPair(),chain='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
   const provider={session:null,on:(n,fn)=>handlers[n]=fn,abortPairingAttempt:()=>window.mobileCancelled=true,
    connect:()=>new Promise(resolve=>{window.mobileFinish=()=>{provider.session={namespaces:{solana:{methods:['solana_signMessage','solana_signTransaction'],accounts:[chain+':'+l.bs58.encode(kp.publicKey)]}}};resolve();};handlers.display_uri('wc:test@2?relay-protocol=irn&symKey=0000000000000000000000000000000000000000000000000000000000000000');}),
    disconnect:async()=>{provider.session=null;handlers.session_delete?.();},
    request:async request=>{window.mobileMethod=request.method;return {signature:l.bs58.encode(l.nacl.sign.detached(l.bs58.decode(request.params.message),kp.secretKey))};}};
   l.UniversalProvider.init=async()=>provider;
  }''')
  await page.locator('#connectBtn').click();await page.locator('#walList .walRow').last.click();await page.wait_for_function('document.querySelector("#pairsSolQr")?.width>100')
  await page.locator('#walClose').click();assert await page.evaluate('mobileCancelled')
  await page.evaluate('mobileFinish()');await page.wait_for_timeout(50);assert await page.locator('#connectBtn').inner_text()=='Connect wallet'
  await page.locator('#connectBtn').click();await page.locator('#walList .walRow').last.click();await page.wait_for_function('document.querySelector("#pairsSolQr")?.width>100')
  await page.evaluate('mobileFinish()');await page.wait_for_function('!document.querySelector("#connectBtn").disabled')
  assert await page.evaluate('mobileMethod')=='solana_signMessage';assert await page.locator('#connectBtn').inner_text()!='Connect wallet'
  assert not errors,errors
  print('pairs: Solana fresh approval, rejection/cancel/late approval, reconnect/reload, Base isolation, mobile links/QR and no overflow all passed; fake signatures only')
  await b.close()
asyncio.run(main())
