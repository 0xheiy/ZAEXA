import asyncio,json,re,os
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
SOL='So11111111111111111111111111111111111111112'
USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
USDT='Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
LEGACY='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
OWNER='11111111111111111111111111111111'
async def main():
 async with async_playwright() as pw:
  browser=await pw.chromium.launch()
  page=await browser.new_page(viewport={'width':1280,'height':900})
  errors=[];quotes=[];events=[];rpc=[];config={'impact':'0.06','fee':25,'missing':False}
  page.on('pageerror',lambda e:errors.append(str(e)))
  async def route(r):
   u=urlparse(r.request.url);path=u.path;q=parse_qs(u.query)
   if path=='/ev':
    events.append(json.loads(r.request.post_data));return await r.fulfill(status=204,body='')
   if path=='/sol/quote':
    quotes.append(q);amount=q['amount'][0];direct=q.get('onlyDirectRoutes')==['true'];exact=q.get('swapMode')==['ExactOut']
    return await r.fulfill(json={'inputMint':q['inputMint'][0],'outputMint':q['outputMint'][0],'inAmount':str(int(amount)*(2 if direct else 1)) if exact else amount,'outAmount':amount if exact else str(int(amount)*(1 if direct else 2)),'otherAmountThreshold':amount,'swapMode':'ExactOut' if exact else 'ExactIn','slippageBps':50,'priceImpactPct':config['impact'],'platformFee':{'feeBps':config['fee']},'routePlan':[{'percent':100,'swapInfo':{'label':'Test DEX'}}]})
   if path=='/sol/rpc':
    d=json.loads(r.request.post_data);rpc.append(d);method=d['method']
    result=None
    if method=='getAccountInfo':result={'value':None if config['missing'] else {'owner':LEGACY,'data':{'parsed':{'type':'mint','info':{'decimals':6,'supply':'100000000','mintAuthority':None,'freezeAuthority':OWNER}}}}}
    elif method=='getTokenLargestAccounts':result={'value':[{'amount':'60000000'}]}
    elif method=='getEpochInfo':result={'epoch':100}
    elif method=='getBalance':result={'value':1000000000}
    elif method=='getTokenAccountsByOwner':result={'value':[]}
    else:raise AssertionError('Unexpected RPC '+method)
    return await r.fulfill(json={'result':result})
   if path.startswith('/vd/'):return await r.fulfill(json={'v':'sell'})
   if '/gt/' in path:
    if '/ohlcv/' in path:return await r.fulfill(json={'data':{'attributes':{'ohlcv_list':[[1700000000,1,1,1,1,1],[1700000060,2,2,2,2,1]]}}})
    if path.endswith('/pools'):
     mint=path.split('/tokens/')[1].split('/')[0] if '/tokens/' in path else USDT
     return await r.fulfill(json={'data':[{'id':'solana_'+SOL,'attributes':{'address':SOL,'name':'Token / SOL','reserve_in_usd':'100','volume_usd':{'h24':'200'}},'relationships':{'base_token':{'data':{'id':'solana_'+mint}},'quote_token':{'data':{'id':'solana_'+SOL}},'dex':{'data':{'id':'test-dex'}}}}]})
    if '/multi/' in path:return await r.fulfill(json={'data':[]})
    if '/tokens/' in path:
     mint=path.split('/tokens/')[1]
     return await r.fulfill(json={'data':{'attributes':{'address':mint,'symbol':'USDC' if mint==USDC else 'USDT','decimals':6,'price_usd':'1'}}})
    return await r.fulfill(json={'data':[]})
   if path.startswith('/t/') or path in ['/app','/index.html']:
    src=(ROOT/'index.html').read_text();src=re.sub(r'const ETHERS_SRC="[^"]*";','const ETHERS_SRC="/stub-ethers.js";',src,count=1);src=re.sub(r'const ETHERS_SRI="[^"]*";','const ETHERS_SRI="";',src,count=1)
    return await r.fulfill(content_type='text/html',body=src)
   if path=='/stub-ethers.js':return await r.fulfill(content_type='text/javascript',body=(ROOT/'test/stub-ethers.js').read_text())
   file=(ROOT/path.lstrip('/')).resolve()
   if file.is_relative_to(ROOT) and file.is_file():return await r.fulfill(body=file.read_bytes(),content_type='text/javascript')
   return await r.fulfill(json={})
  await page.route('**/*',route)
  await page.goto(f'http://zaexa.test/app#swap?chain=solana&in={USDC}&out={USDT}&amt=1.25')
  await page.wait_for_function('solQuote!==null')
  assert await page.locator('#solSwapBtn').is_enabled()
  await page.locator('#solSwapBtn').click()
  assert await page.locator('#solWalletOv').is_visible()
  await page.locator('#solWalClose').click()
  state=await page.evaluate('({chain:activeChain,a:solInputMint(),b:solOutputMint(),share:shareUrl()})')
  assert state['a']==USDC and state['b']==USDT,state
  assert parse_qs(urlparse(state['share']).fragment.split('?')[1])['chain']==['solana']
  assert quotes[0]['amount']==['1250000'],quotes
  assert await page.locator('#solProtocolF').inner_text()=='0.25%'
  assert await page.locator('#solImpactF').evaluate('e=>e.style.color')=='var(--neg)'
  assert 'chain=solana' in await page.locator('#hdr a[href^="/pairs"]').get_attribute('href') if await page.locator('#hdr').count() else True
  await page.wait_for_function('document.querySelector("#solDirectF").textContent.includes("more received")')
  await page.wait_for_function('document.querySelector("#solSafety").textContent.includes("60.00%")')
  safety=await page.locator('#solSafety').inner_text();assert 'Revoked' in safety and 'Active' in safety and 'No transfer-fee' in safety,safety
  await page.wait_for_function('document.querySelector("#solPools").textContent.includes("test-dex")')
  await page.locator('#solTopBtn').click();await page.locator('#solTokList [data-mint="'+SOL+'"]').click()
  await page.wait_for_function('solInputMint()==="'+SOL+'"')
  config['impact']='0.02';await page.locator('#solAmt').fill('0.1');await page.wait_for_function('document.querySelector("#solImpactF").style.color==="var(--warn)"')
  await page.locator('#solAmt').fill('0.0000000001');await page.wait_for_function('solQuote===null')
  await page.evaluate('solApplyShare(new URLSearchParams({chain:"solana",in:"'+USDC+'",out:"'+USDT+'",amt:"3",mode:"exactOut"}))')
  await page.wait_for_function('solQuote?.swapMode==="ExactOut"');assert await page.locator('#solMinLabel').inner_text()=='Max sent'
  for theme in ['light','dark']:
   await page.evaluate('(theme)=>document.documentElement.dataset.theme=theme',theme)
   for width in [360,375,390,430,768,1280]:
    await page.set_viewport_size({'width':width,'height':900})
    await page.evaluate('scrollTo(0,0)')
    geo=await page.evaluate("""() => {
     const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,b:r.bottom};};
     return {swap:rect('#solSwap'),chart:rect('#appSolHero>.card'),pools:rect('#solPools'),safety:rect('#appSolSafetyCard'),cta:rect('#solSwapBtn'),overflow:document.documentElement.scrollWidth>innerWidth};
    }""")
    assert not geo['overflow'],(theme,width,geo)
    base=await page.evaluate("""() => {
     const b=document.querySelector('#baseHeroRow'),s=document.querySelector('#appSolHero');
     b.hidden=false;s.hidden=true;
     const card=b.querySelector('.swapCard'),r=card.getBoundingClientRect(),leg=card.querySelector('.leg').getBoundingClientRect();
     const out={x:r.x,y:r.y,w:r.width,leg:leg.height};b.hidden=true;s.hidden=false;return out;
    }""")
    for key in ['x','y','w']:
     assert abs(geo['swap'][key]-base[key])<1,(theme,width,key,geo,base)
    sol_leg=await page.locator('#solSwap .leg').first.evaluate('e=>e.getBoundingClientRect().height')
    assert abs(sol_leg-base['leg'])<1,(theme,width,sol_leg,base)
    assert geo['swap']['w']>0 and geo['cta']['w']>0,(width,geo)
    if width<=940:
     assert geo['swap']['y']<geo['chart']['y'],(width,geo)
     assert abs(geo['swap']['w']-geo['chart']['w'])<1,(width,geo)
     assert geo['pools']['y']>=geo['chart']['b'] and geo['safety']['y']>=geo['pools']['b'],(width,geo)
    else:
     assert abs(geo['swap']['y']-geo['chart']['y'])<1,(width,geo)
     assert abs(geo['pools']['y']-geo['safety']['y'])<1,(width,geo)
    if width<=430:
     await page.locator('#solTopBtn').click()
     picker=await page.locator('#solTokOv').evaluate('e=>{const r=e.firstElementChild.getBoundingClientRect();return {x:r.x,right:r.right,w:innerWidth};}')
     assert picker['x']>=0 and picker['right']<=picker['w'],(width,picker)
     await page.evaluate('solCloseTokenPicker()')
    if os.environ.get('ZAEXA_TEST_ARTIFACTS') and width in [390,1280]:
     await page.screenshot(path=str(Path(os.environ['ZAEXA_TEST_ARTIFACTS'])/f'solana-layout-{width}-{theme}.png'),full_page=True)
  print('mobile card order, shared widths, lower panel placement and no overflow verified at 360/375/390/430/768/1280 in both themes')
  for width in [390,1280]:
   await page.set_viewport_size({'width':width,'height':900});assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),width
  if os.environ.get('ZAEXA_TEST_ARTIFACTS'):
   await page.screenshot(path=str(Path(os.environ['ZAEXA_TEST_ARTIFACTS'])/'solana-parity-preview.png'),full_page=True)
  print('pair selection, exact amounts, share URL, impact colours, live fee, direct comparison and safety verified')
  await page.goto('http://zaexa.test/t/'+USDT)
  await page.wait_for_function('document.querySelector("#tk-plot svg")!==null')
  assert not await page.locator('#tk-chartCard').evaluate('e=>e.hidden')
  assert await page.locator('#solSafety').is_visible()
  assert await page.locator('#tk-trade').is_visible()
  assert not await page.locator('#solSwap').is_visible()
  assert not await page.locator('#solPools').is_visible()
  assert await page.evaluate('activeChain')=='solana'
  assert await page.locator('#walletMenu').is_visible()
  assert await page.locator('#solSafety').evaluate('e=>e.parentElement.id')=='tk-grid'
  if os.environ.get('ZAEXA_TEST_ARTIFACTS'):
   await page.set_viewport_size({'width':1280,'height':900})
   await page.screenshot(path=str(Path(os.environ['ZAEXA_TEST_ARTIFACTS'])/'solana-check-desktop.png'),full_page=True)
   await page.set_viewport_size({'width':390,'height':844})
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   await page.screenshot(path=str(Path(os.environ['ZAEXA_TEST_ARTIFACTS'])/'solana-check-mobile.png'),full_page=True)
  await page.locator('#tk-trade').click()
  assert await page.locator('#solSwap').is_visible()
  assert '/app' in page.url
  assert await page.evaluate('activeChain')=='solana'
  await page.goto('http://zaexa.test/t/'+USDT)
  await page.wait_for_function('() => document.querySelector("#solSafety").textContent.includes("60.00%")')
  config['missing']=True;await page.evaluate('solLoadDetails()');assert 'not a readable' in await page.locator('#solSafety').inner_text()
  await page.goto('http://zaexa.test/t/not-an-address');await page.wait_for_function('document.querySelector("#tk-sym").textContent==="Unreadable address"')
  assert await page.locator('#solSwap').evaluate('e=>e.hidden')
  assert await page.evaluate('document.baseURI')=='http://zaexa.test/'
  await page.goto('http://zaexa.test/app#swap?chain=solana')
  await page.wait_for_function('typeof solLoadMobileBundle==="function"')
  await page.set_viewport_size({'width':390,'height':844})
  await page.evaluate("Object.defineProperty(navigator,'userAgent',{value:'Android Mobile',configurable:true})")
  await page.evaluate('solOpenWalletPicker()')
  assert await page.locator('#solPhantomOpen').is_visible()
  assert await page.locator('#solSolflareOpen').is_visible()
  assert (await page.locator('#solSolflareOpen').get_attribute('href')).startswith('https://solflare.com/ul/v1/browse/')
  link=await page.locator('#solPhantomOpen').get_attribute('href')
  assert link.startswith('https://phantom.app/ul/browse/') and 'chain%3Dsolana' in link,link
  if os.environ.get('ZAEXA_TEST_ARTIFACTS'):
   await page.screenshot(path=str(Path(os.environ['ZAEXA_TEST_ARTIFACTS'])/'solana-wallet-mobile.png'))
  await page.locator('#solWalClose').click()
  await page.evaluate('solLoadMobileBundle()')
  await page.evaluate("""() => {
   const handlers={};window.mobileAborted=false;window.mobileSent=null;
   const session={namespaces:{solana:{methods:['solana_signTransaction'],accounts:[SOL_WC_CHAIN+':11111111111111111111111111111111']}}};
   const provider={session:null,on:(name,fn)=>handlers[name]=fn,
    connect:()=>new Promise((resolve,reject)=>{window.finishMobile=()=>{provider.session=session;resolve(session);};window.cancelMobile=()=>reject(Error('cancelled'));handlers.display_uri('wc:test-pairing@2?relay-protocol=irn&symKey=0000000000000000000000000000000000000000000000000000000000000000');}),
    abortPairingAttempt:()=>{window.mobileAborted=true;window.cancelMobile?.();},
    disconnect:async()=>{provider.session=null;handlers.session_delete?.();},
    request:async request=>{window.mobileSent=request;return {transaction:request.params.transaction};}};
   SolMobile.UniversalProvider.init=async()=>provider;
  }""")
  await page.evaluate('solOpenWalletPicker()');await page.locator('#solMobileConnect').click()
  await page.wait_for_function('document.querySelector("#solQr")?.width>100')
  await page.locator('#solWalClose').click();await page.wait_for_function('!solMobilePending')
  assert await page.evaluate('mobileAborted && solAccount===null')
  assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  await page.evaluate('solOpenWalletPicker()');await page.locator('#solMobileConnect').click()
  await page.wait_for_function('document.querySelector("#solQr")?.width>100')
  await page.evaluate('finishMobile()');await page.wait_for_function('solAccount!==null')
  assert await page.evaluate('solAccount.address')==OWNER
  await page.evaluate("""async()=>{const tx=new Uint8Array(100);tx[0]=1;tx[70]=2;const out=await solWalletApi.features['solana:signTransaction'].signTransaction({account:solAccount,transaction:tx});if(!solBytesEq(out[0].signedTransaction,tx))throw Error('Adapter changed bytes');}""")
  assert await page.evaluate('mobileSent.method')=='solana_signTransaction'
  await page.evaluate('solDisconnectWallet(true)');assert await page.evaluate('solAccount===null')
  print('mobile QR rendered with real local library; cancellation, reconnect, signing adapter and disconnect verified against fake wallet; no real signatures')
  assert not errors,errors
  assert all(e.get('c') in ['base','solana'] for e in events),events
  print('token-page chart, unreadable-address card, network-labelled events; no page errors')
  await browser.close()
asyncio.run(main())
