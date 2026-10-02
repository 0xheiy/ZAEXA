import asyncio,json,re,os,time
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
SOL='So11111111111111111111111111111111111111112'
USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
USDT='Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
JUP='JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
BONK='DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
WETH='0x4200000000000000000000000000000000000006'
AERO='0x940181a94A35A4569E4529A3CDfB74e38FD98631'
BTC='0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'
BASE_USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
META={SOL:('SOL',150),USDC:('USDC',1),USDT:('USDT',1),JUP:('JUP',.8),BONK:('BONK',.00002),WETH:('WETH',2500),AERO:('AERO',.75),BTC:('cbBTC',60000),BASE_USDC:('USDC',1)}
async def main():
 async with async_playwright() as pw:
  browser=await pw.chromium.launch();page=await browser.new_page(viewport={'width':1280,'height':900});errors=[];calls=[];cfg={'failure':False,'partial':False,'stale':False}
  page.on('pageerror',lambda e:errors.append(str(e)))
  def metadata(address):
   symbol,price=META.get(address,('TOKEN',1))
   return {'id':'token_'+address,'attributes':{'address':address,'symbol':symbol,'price_usd':str(price),'decimals':9 if address in [SOL,WETH] else 6,'image_url':'https://images.test/token.png'}}
  async def route(r):
   u=urlparse(r.request.url);path=u.path;q=parse_qs(u.query);calls.append((path,q))
   if path=='/ev':return await r.fulfill(status=204,body='')
   if path=='/sol/rpc':
    d=json.loads(r.request.post_data);method=d['method'];result=None
    if method=='getAccountInfo':result={'value':{'owner':'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','data':{'parsed':{'type':'mint','info':{'decimals':6,'supply':'100000000','mintAuthority':None,'freezeAuthority':None}}}}}
    elif method=='getTokenLargestAccounts':result={'value':[{'amount':'1000000'}]}
    elif method=='getEpochInfo':result={'epoch':100}
    elif method=='getBalance':result={'value':1000000000}
    elif method=='getTokenAccountsByOwner':result={'value':[]}
    return await r.fulfill(json={'result':result})
   if path=='/sol/quote':
    amount=q['amount'][0];return await r.fulfill(json={'inputMint':q['inputMint'][0],'outputMint':q['outputMint'][0],'inAmount':amount,'outAmount':str(int(amount)*2),'otherAmountThreshold':amount,'swapMode':'ExactIn','slippageBps':50,'priceImpactPct':'0.002','routePlan':[{'percent':100,'swapInfo':{'label':'Orca','inputMint':q['inputMint'][0],'outputMint':q['outputMint'][0]}}]})
   if path.startswith('/vd/'):return await r.fulfill(json={'v':'sell'})
   if '/gt/' in path:
    chain=path.split('/networks/')[1].split('/')[0]
    if cfg['failure']:return await r.fulfill(status=404,json={},headers={'x-zaexa-proxy':'1'})
    if '/multi/' in path:return await r.fulfill(json={'data':[metadata(a) for a in path.split('/multi/')[1].split(',')]})
    if '/ohlcv/' in path:
     now=int(time.time())-3600*(48 if cfg['stale'] else 0);count=2 if cfg['partial'] else 25
     return await r.fulfill(json={'data':{'attributes':{'ohlcv_list':[[now-i*3600,124-i,125-i,123-i,124-i,100] for i in range(count)]}}})
    if path.endswith('/pools'):
     address=path.split('/tokens/')[1].split('/')[0] if '/tokens/' in path else USDC
     return await r.fulfill(json={'data':[{'id':chain+'_PoolTest','attributes':{'address':'PoolTest','name':'USDC / Token','reserve_in_usd':'10000'},'relationships':{'base_token':{'data':{'id':chain+'_other'}},'quote_token':{'data':{'id':chain+'_'+address}},'dex':{'data':{'id':'orca'}}}}]})
    if '/tokens/' in path:return await r.fulfill(json={'data':metadata(path.split('/tokens/')[1])})
    return await r.fulfill(json={'data':[]})
   if path.startswith('/t/') or path=='/app':
    src=(ROOT/'index.html').read_text();src=re.sub(r'const ETHERS_SRC="[^"]*";','const ETHERS_SRC="/stub-ethers.js";',src,count=1);src=re.sub(r'const ETHERS_SRI="[^"]*";','const ETHERS_SRI="";',src,count=1)
    return await r.fulfill(content_type='text/html',body=src)
   if path=='/stub-ethers.js':return await r.fulfill(content_type='text/javascript',body=(ROOT/'test/stub-ethers.js').read_text())
   file=(ROOT/path.lstrip('/')).resolve()
   if file.is_relative_to(ROOT) and file.is_file():return await r.fulfill(body=file.read_bytes(),content_type='text/javascript')
   if u.hostname=='images.test':return await r.fulfill(status=404,body='')
   return await r.fulfill(json={})
  await page.route('**/*',route)
  await page.goto(f'http://zaexa.test/app#swap?chain=solana&in={USDC}&out={USDT}&amt=1')
  await page.wait_for_function('solQuote!==null')
  await page.evaluate('loadMarketWatch("solana")')
  assert await page.locator('#appSolHero .watchPrice').all_text_contents()==['$150','$0.8','$0.00002']
  assert await page.locator('#appSolHero .watchSpark polyline').count()==3
  assert await page.locator('#appSolHero .watchChange').all_text_contents()==['▲ 24.00%']*3
  assert all(q.get('token')==['quote'] for path,q in calls if '/ohlcv/hour' in path)
  assert await page.locator('#solRouteVisual').is_visible()
  assert 'Orca' in await page.locator('#solRouteVisual').inner_text()
  assert '100%' in await page.locator('#solRouteVisual').inner_text()
  # Persist horizontal position and keyboard focus through data refresh.
  await page.set_viewport_size({'width':390,'height':844})
  await page.locator('#appSolHero [data-watch="1"]').focus()
  before=await page.locator('#appSolHero .watchItems').evaluate('e=>{e.scrollLeft=120;return e.scrollLeft}')
  await page.evaluate('paintMarketWatch("solana")')
  assert await page.evaluate('document.activeElement.dataset.watch')=='1'
  assert abs(await page.locator('#appSolHero .watchItems').evaluate('e=>e.scrollLeft')-before)<1
  await page.locator('#appSolHero [data-watch="1"]').click()
  await page.wait_for_function(f'solInputMint()==="{USDC}"&&solOutputMint()==="{JUP}"')
  assert await page.locator('#solAmt').input_value()==''
  assert not await page.locator('#solRouteVisual').is_visible()
  await page.evaluate('async()=>{await Promise.all([chooseMarketPair("solana",MARKET_WATCH_SOL[1]),chooseMarketPair("solana",MARKET_WATCH_SOL[2])])}')
  assert await page.evaluate('solOutputMint()')==BONK
  print('Solana live data, correct token-side candles, quick selection, rapid selection, focus and stale-route clearing verified',flush=True)
  # Do not invent 24h performance from a partial, old or failed sample.
  for kind in ['partial','stale','failure']:
   cfg[kind]=True
   await page.evaluate('async()=>{++marketWatchSeq;await gtChain;gtCache.clear();marketWatchCache.clear()}')
   await page.evaluate('loadMarketWatch("solana")')
   assert await page.locator('#appSolHero .watchChange').all_text_contents()==['—']*3,kind
   if kind=='failure':
    assert await page.locator('#appSolHero .watchPrice').all_text_contents()==['—']*3,await page.locator('#appSolHero .watchPrice').all_text_contents()
    assert await page.locator('#appSolHero .watchSpark polyline').count()==0
   cfg[kind]=False
  print('Unavailable, partial and stale market data remains unknown',flush=True)
  await page.evaluate('setChain("base")')
  await page.evaluate('gtCache.clear();loadMarketWatch("base")')
  assert await page.locator('#baseHeroRow .watchPrice').all_text_contents()==['$2,500','$0.75','$60,000']
  await page.locator('#baseHeroRow [data-watch="1"]').click()
  assert await page.evaluate('tokenIn.symbol+">"+tokenOut.symbol')=='USDC>AERO'
  await page.locator('#amtIn').fill('100')
  await page.wait_for_function('currentPlan!==null',timeout=45000)
  assert await page.locator('#baseRouteVisual').is_visible()
  assert 'AERO' in await page.locator('#baseRouteVisual').inner_text()
  await page.locator('#amtIn').fill('')
  await page.wait_for_function('document.querySelector("#baseRouteVisual").hidden')
  print('Base quick selection and visual route driven by an actual test quote verified',flush=True)
  await page.evaluate("setChain('solana')")
  await page.evaluate("""() => {
   solRenderRouteBar({inputMint:solInputMint(),outputMint:solOutputMint(),routePlan:[
    {percent:40,swapInfo:{inputMint:solInputMint(),outputMint:solOutputMint(),label:'Orca'}},
    {percent:60,swapInfo:{inputMint:solInputMint(),outputMint:solOutputMint(),label:'Raydium'}},
    {percent:100,swapInfo:{inputMint:solInputMint(),outputMint:solOutputMint(),label:'<img src=x onerror=alert(1)>'}},
    {percent:100,swapInfo:{inputMint:solInputMint(),outputMint:solOutputMint(),label:'Meteora'}}]});
  }""")
  assert await page.locator('#solRouteVisual details summary').inner_text()=='2 more route legs'
  assert await page.locator('#solRouteVisual .routeVenue img').count()==0
  await page.locator('#solRouteVisual details summary').click()
  assert await page.locator('#solRouteVisual details').get_attribute('open') is not None
  assert '<img' in await page.locator('#solRouteVisual .routeVenue').nth(2).inner_text()
  await page.evaluate('solRenderRouteBar(null)')
  print('Multiple route legs can expand; upstream labels are escaped',flush=True)
  # Both networks keep an active quote and CTA clear of mobile navigation.
  for chain,hero in [('base','baseHeroRow'),('solana','appSolHero')]:
   await page.evaluate('(c)=>setChain(c)',chain)
   await page.locator('#amtIn' if chain=='base' else '#solAmt').fill('10')
   await page.wait_for_function('currentPlan!==null' if chain=='base' else 'solQuote!==null',timeout=45000)
   for theme in ['light','dark']:
    await page.evaluate('(t)=>{theme=t;applyTheme()}',theme);await page.wait_for_timeout(350)
    for width in [360,390,430,768,941,960,1280,1920]:
     await page.set_viewport_size({'width':width,'height':844});await page.evaluate('scrollTo(0,0)');await page.wait_for_timeout(200)
     geo=await page.evaluate('''id=>{
      const root=document.getElementById(id),rect=s=>{const r=root.querySelector(s).getBoundingClientRect();return {y:r.y,b:r.bottom};};
      return {watch:rect('.marketWatch'),swap:rect('.swapCard'),chart:rect('.swapChartCard'),overflow:document.documentElement.scrollWidth>innerWidth};
     }''',hero)
     assert not geo['overflow'],(chain,theme,width,geo)
     assert await page.locator('#'+hero+' .watchPair').evaluate_all('els=>els.every(e=>{const price=e.querySelector(".watchNumbers").getBoundingClientRect(),spark=e.querySelector(".watchSpark");return getComputedStyle(spark).display==="none"||price.right<=spark.getBoundingClientRect().left+1})'),(chain,theme,width,'watch text overlaps sparkline')
     if width<=940:
      assert geo['swap']['y']<geo['watch']['y']<geo['chart']['y'],(chain,theme,width,geo)
      cta=page.locator('#actBtn' if chain=='base' else '#solSwapBtn')
      assert await cta.evaluate('e=>e.getBoundingClientRect().bottom')<=844,(chain,theme,width)
      if width<=430:
       assert await cta.evaluate('e=>e.getBoundingClientRect().bottom<=document.querySelector("#nav").getBoundingClientRect().top'),(chain,theme,width,await cta.evaluate('e=>({bottom:e.getBoundingClientRect().bottom,nav:document.querySelector("#nav").getBoundingClientRect().top,status:document.querySelector("#solStatusSlot").getBoundingClientRect().height})'),'CTA covered by bottom navigation')
     else:assert geo['watch']['b']<geo['chart']['y'],(chain,theme,width,geo)
     if os.environ.get('ZAEXA_TEST_ARTIFACTS') and width in [390,1280]:await page.screenshot(path=str(Path(os.environ['ZAEXA_TEST_ARTIFACTS'])/f'workspace-{chain}-{theme}-{width}.png'),full_page=True)
  await page.goto('http://zaexa.test/t/'+USDT+'?check=1')
  await page.locator('#tk-trade').wait_for(state='visible')
  assert not await page.locator('.marketWatch').first.is_visible()
  await page.locator('#tk-trade').click();await page.locator('#solSwap').wait_for(state='visible')
  await page.go_back();await page.locator('#tk-trade').wait_for(state='visible')
  assert not await page.locator('.marketWatch').first.is_visible()
  await page.locator('#tk-trade').click();await page.locator('#solSwap').wait_for(state='visible')
  await page.evaluate('setChain("base")')
  await page.wait_for_url('**/app#swap?chain=base')
  await page.locator('#baseHeroRow .marketWatch').wait_for(state='visible')
  await page.wait_for_function('baseDexInitPromise!==null')
  print('Base initializes after entering from a Solana-only report',flush=True)
  assert not errors,errors
  print('Shared light/dark desktop/mobile layout, CTA within first screen and unchanged report navigation verified',flush=True)
  await browser.close()
asyncio.run(main())
