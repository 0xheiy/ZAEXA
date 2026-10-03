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
  errors=[];quotes=[];events=[];rpc=[];config={'impact':'0.06','fee':25,'missing':False,'foreign':False,'plan':None,'dplan':None,'mult':2,'tokaccts':[],'vd':{},'multi':None}
  page.on('pageerror',lambda e:errors.append(str(e)))
  async def route(r):
   u=urlparse(r.request.url);path=u.path;q=parse_qs(u.query)
   if path=='/ev':
    events.append(json.loads(r.request.post_data));return await r.fulfill(status=204,body='')
   if path=='/sol/quote':
    quotes.append(q);amount=q['amount'][0];direct=q.get('onlyDirectRoutes')==['true'];exact=q.get('swapMode')==['ExactOut']
    return await r.fulfill(json={'inputMint':q['inputMint'][0],'outputMint':q['outputMint'][0],'inAmount':str(int(amount)*(2 if direct else 1)) if exact else amount,'outAmount':amount if exact else str(int(int(amount)*(1 if direct else config['mult']))),'otherAmountThreshold':amount,'swapMode':'ExactOut' if exact else 'ExactIn','slippageBps':50,'priceImpactPct':config['impact'],'platformFee':{'feeBps':config['fee']},'routePlan':(config['dplan'] if direct and config['dplan'] is not None else config['plan'] if config['plan'] is not None else [{'percent':100,'swapInfo':{'label':'Test DEX'}}])})
   if path=='/sol/rpc':
    d=json.loads(r.request.post_data);rpc.append(d);method=d['method']
    result=None
    if method=='getAccountInfo':result={'value':{'owner':OWNER,'data':['','base64']} if config['foreign'] else None if config['missing'] else {'owner':LEGACY,'data':{'parsed':{'type':'mint','info':{'decimals':6,'supply':'100000000','mintAuthority':None,'freezeAuthority':OWNER}}}}}
    elif method=='getTokenLargestAccounts':result={'value':[{'amount':'60000000'}]}
    elif method=='getEpochInfo':result={'epoch':100}
    elif method=='getBalance':result={'value':1000000000}
    elif method=='getTokenAccountsByOwner':result={'value':config['tokaccts']}
    else:raise AssertionError('Unexpected RPC '+method)
    return await r.fulfill(json={'result':result})
   if path.startswith('/vd/'):return await r.fulfill(json=config['vd'].get(path[4:],{'v':'sell'}))
   if '/gt/' in path:
    if '/ohlcv/' in path:return await r.fulfill(json={'data':{'attributes':{'ohlcv_list':[[1700000000,1,1,1,1,1],[1700000060,2,2,2,2,1]]}}})
    if path.endswith('/pools'):
     mint=path.split('/tokens/')[1].split('/')[0] if '/tokens/' in path else USDT
     return await r.fulfill(json={'data':[{'id':'solana_'+SOL,'attributes':{'address':SOL,'name':'Token / SOL','reserve_in_usd':'100','volume_usd':{'h24':'200'}},'relationships':{'base_token':{'data':{'id':'solana_'+mint}},'quote_token':{'data':{'id':'solana_'+SOL}},'dex':{'data':{'id':'test-dex'}}}}]})
    if '/multi/' in path:
     if config['multi'] is None:return await r.fulfill(json={'data':[]})
     m=config['multi'];mints=path.split('/multi/')[1].split(',');m['urls'].add(path);m['inflight']+=1;m['peak']=max(m['peak'],m['inflight'])
     try:
      await asyncio.sleep(0.05)
      if mints[0] in m['fail']:return await r.fulfill(status=400,json={'error':'bad chunk'})  # 400 = permanent for gtJson (a 5xx would start its own 60s global backoff)
      return await r.fulfill(json={'data':[{'attributes':{'address':a,'symbol':'T'+a[3:6],'price_usd':'1'}} for a in mints]})
     finally:m['inflight']-=1
    if '/tokens/' in path:
     mint=path.split('/tokens/')[1]
     return await r.fulfill(json={'data':{'attributes':{'address':mint,'symbol':'USDC' if mint==USDC else 'USDT','decimals':6,'price_usd':'1'}}})
    return await r.fulfill(json={'data':[]})
   if path.startswith('/t/') or path in ['/app','/index.html']:
    src=(ROOT/'index.html').read_text();src=re.sub(r'const ETHERS_SRC="[^"]*";','const ETHERS_SRC="/stub-ethers.js";',src,count=1);src=re.sub(r'const ETHERS_SRI="[^"]*";','const ETHERS_SRI="";',src,count=1)
    return await r.fulfill(content_type='text/html',body=src)
   if path=='/stub-ethers.js':return await r.fulfill(content_type='text/javascript',body=(ROOT/'test/stub-ethers.js').read_text())
   file=(ROOT/path.lstrip('/')).resolve()
   if file.is_relative_to(ROOT) and file.is_file():return await r.fulfill(body=file.read_bytes(),content_type='image/svg+xml' if file.suffix=='.svg' else 'text/javascript')
   return await r.fulfill(json={})
  await page.route('**/*',route)
  await page.goto(f'http://zaexa.test/app#swap?chain=solana&in={USDC}&out={USDT}&amt=1.25')
  await page.wait_for_function('solQuote!==null')

  assert await page.locator('#srcMenu').evaluate('e=>e.parentElement.id')=='swapNetworkBar'
  assert await page.locator('#swapNetworkBar').evaluate('e=>e.parentElement.id')=='solSwapNetworkSlot'
  assert await page.locator('body>header #srcMenu').count()==0
  await page.locator('#srcChip').click();await page.locator('#srcOptBase').click()
  assert await page.locator('#swapNetworkBar').evaluate('e=>e.parentElement.id')=='baseSwapNetworkSlot'
  assert await page.locator('#srcTx').inner_text()=='Base'
  for theme in ['light','dark']:
   await page.evaluate('(t)=>document.documentElement.dataset.theme=t',theme)
   for width in [390,768,1280]:
    await page.set_viewport_size({'width':width,'height':900})
    geo=await page.evaluate("""() => {
     const hero=document.querySelector('#baseHeroRow');
     const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,b:r.bottom,h:r.height};};
     return {chart:rect(hero.querySelector('.swapChartCard')),swap:rect(hero.querySelector('.swapCard')),
       pools:rect(hero.querySelector('.swapPoolsCard')),safety:rect(hero.querySelector('.swapSafetyCard')),
       overflow:document.documentElement.scrollWidth>innerWidth};
    }""")
    assert not geo['overflow'],(theme,width,geo)
    if width>940:
     assert abs(geo['pools']['y']-geo['chart']['b']-18)<1,(theme,width,geo)
     assert abs(geo['safety']['y']-geo['swap']['b']-18)<1,(theme,width,geo)
     await page.evaluate("(message)=>setNotice(message)", '<div class="note err">Connection failed. Try again.</div>')
     assert await page.locator('#baseHeroRow .swapChartCard').evaluate('e=>e.getBoundingClientRect().height')==geo['chart']['h']
     await page.evaluate('setNotice("")')
    else:
     assert geo['swap']['y']<geo['chart']['y']<geo['pools']['y']<geo['safety']['y'],(theme,width,geo)
    if os.environ.get('ZAEXA_TEST_ARTIFACTS') and width in [390,1280]:
     await page.screenshot(path=str(Path(os.environ['ZAEXA_TEST_ARTIFACTS'])/f'base-spacing-{width}-{theme}.png'),full_page=True)
  await page.set_viewport_size({'width':1280,'height':900})
  print('Base independent 18px column gaps, stable chart under notices and mobile order verified')
  await page.evaluate('applyTheme()')

  await page.locator('#srcChip').click();await page.locator('#srcOptSolana').click()
  await page.wait_for_function('solQuote!==null')
  assert await page.locator('#swapNetworkBar').evaluate('e=>e.parentElement.id')=='solSwapNetworkSlot'
  for tab in ['folio','flow','faq']:
   await page.evaluate('(v)=>setView(v,false)',tab)
   if tab in ['folio','flow']:
    assert await page.locator('#srcMenu').evaluate('e=>e.parentElement.id')==('folioNetworkSlot' if tab=='folio' else 'flowNetworkSlot')
    assert await page.locator('body>header #srcMenu').count()==0
   else:assert await page.locator('body>header #srcMenu').count()==1
   assert not await page.locator('#swapNetworkBar').is_visible()
  await page.evaluate('setView("swap",false)')
  assert await page.locator('body>header #srcMenu').count()==0
  assert await page.locator('#swapNetworkBar').is_visible()
  print('one shared network control moves between Base/Solana cards and returns to header outside swap')

  assert await page.locator('body>header #themeBtn').is_visible()
  assert await page.locator('#setPop #themeBtn, #walletPop #themeBtn').count()==0
  before=await page.get_attribute('html','data-theme')
  await page.locator('#themeBtn').click()
  after=await page.get_attribute('html','data-theme');assert after!=before
  assert await page.evaluate('localStorage.getItem("zaexa.theme.v1")')==after
  assert await page.locator('#themeBtn').get_attribute('aria-label')==('Switch to light mode' if after=='dark' else 'Switch to dark mode')
  await page.locator('#themeBtn').click();assert await page.get_attribute('html','data-theme')==before
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
  assert await page.locator('body>header a[href^="/pairs"]').count()>=1
  assert 'chain=solana' in await page.locator('body>header a[href^="/pairs"]').first.get_attribute('href')
  await page.wait_for_function('document.querySelector("#solDirectF").textContent.includes("more received")')
  await page.wait_for_function('document.querySelector("#solSafety").textContent.includes("60.00%")')
  safety=await page.locator('#solSafety').inner_text();assert 'Revoked' in safety and 'Active' in safety and 'No transfer-fee' in safety,safety
  await page.wait_for_function('document.querySelector("#solPools").textContent.includes("Test DEX")')
  assert await page.locator('#shareBtn').count()==0
  assert await page.locator('#solSafety .chkGroup, #solSafety .chkNum').count()==0
  assert await page.locator('#solSafety .chk.high').count()==1
  assert await page.locator('#solSafety .chk.medium').count()==1
  assert await page.locator('#solSafety .chk.ok').count()==2
  for row in await page.locator('#solSafety .chk').all():
   assert await row.evaluate('e=>getComputedStyle(e).borderTopWidth')=='1px'
  assert await page.locator('#appSolExitBox .exitTtl').evaluate('e=>getComputedStyle(e).fontSize')=='15.5px'
  for v in ['sell','nosell',None]:
   await page.evaluate('(v)=>renderSolExit(v,null,"appSolExitBox")',v)
   assert await page.locator('#appSolExitBox .exitHead').count()==1
   assert await page.locator('#appSolExitBox .tripPct').count()==0
  await page.evaluate('renderSolExit("sell",null,"appSolExitBox","quote",99.5)')
  assert await page.locator('#appSolExitBox .exitBadge').text_content()=='Estimated from quotes'
  await page.evaluate("""async()=>{
   window.riskRaf=requestAnimationFrame;window.riskFrames=[];requestAnimationFrame=fn=>{riskFrames.push(fn);return 0;};
   await solLoadDetails();
  }""")
  assert await page.locator('#sol-risk-score').inner_text()=='0'
  circle=await page.locator('#sol-risk-arc').evaluate('e=>({offset:Number(e.getAttribute("stroke-dashoffset")),total:Number(e.getAttribute("stroke-dasharray"))})')
  assert circle['offset']==circle['total']
  await page.evaluate('requestAnimationFrame=riskRaf;for(const f of riskFrames)requestAnimationFrame(f)')
  await page.wait_for_function('document.querySelector("#sol-risk-score").textContent==="17"')
  await page.emulate_media(reduced_motion='reduce');await page.evaluate('solLoadDetails()')
  assert await page.locator('#sol-risk-score').inner_text()=='17'
  await page.emulate_media(reduced_motion='no-preference')
  print('Solana numeric risk, warning/clear groups, animation from zero and reduced motion verified')

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
     return {swap:rect('#solSwap'),chart:rect('#appSolHero .swapChartCard'),pools:rect('#solPools'),safety:rect('#appSolSafetyCard'),cta:rect('#solSwapBtn'),overflow:document.documentElement.scrollWidth>innerWidth};
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
    assert await page.locator('#srcTx').inner_text()=='Solana'
    assert await page.locator('#srcNetworkIcon svg path').count()>0
    for tab,slot in [('folio','folioNetworkSlot'),('flow','flowNetworkSlot')]:
     await page.evaluate('(v)=>setView(v,false)',tab)
     assert await page.locator('#srcMenu').evaluate('e=>e.parentElement.id')==slot
     assert await page.locator('#srcTx').inner_text()=='Solana'
     assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(theme,width,tab)
     await page.locator('#srcChip').click()
     assert await page.locator('#srcOptSolana').evaluate('e=>{const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest("button")===e;}'),(theme,width,tab)
     await page.keyboard.press('Escape')
     if os.environ.get('ZAEXA_TEST_ARTIFACTS') and width in [390,1280]:
      await page.screenshot(path=str(Path(os.environ['ZAEXA_TEST_ARTIFACTS'])/f'network-{tab}-{width}-{theme}.png'),full_page=True)
    await page.evaluate('setView("swap",false)')

    await page.locator('#srcChip').click()
    menu=await page.locator('#srcPop').evaluate('e=>{const r=e.getBoundingClientRect();return {x:r.x,right:r.right,b:r.bottom,w:innerWidth};}')
    assert menu['x']>=0 and menu['right']<=menu['w'],(theme,width,menu)
    assert await page.locator('#srcOptSolana').evaluate('e=>{const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest("button")===e;}'),(theme,width,'menu clipped')
    await page.keyboard.press('Escape')
    assert await page.locator('#srcChip').get_attribute('aria-expanded')=='false'
    await page.evaluate('scrollTo(0,0)')


    assert geo['swap']['w']>0 and geo['cta']['w']>0,(width,geo)
    if width<=940:
     assert geo['swap']['y']<geo['chart']['y'],(width,geo)
     assert abs(geo['swap']['w']-geo['chart']['w'])<1,(width,geo)
     assert geo['pools']['y']>=geo['chart']['b'] and geo['safety']['y']>=geo['pools']['b'],(width,geo)
    else:
     assert abs(geo['swap']['y']-geo['chart']['y'])<1,(width,geo)
     assert abs(geo['pools']['y']-geo['chart']['b']-18)<1,(width,geo)
     assert abs(geo['safety']['y']-geo['swap']['b']-18)<1,(width,geo)
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
  await page.locator('#solAmt').fill('')
  await page.wait_for_function('solQuote===null')
  assert await page.locator('#solStatusSlot').evaluate('e=>e.getBoundingClientRect().height')==0
  await page.evaluate('solSetNotice(note("err","Connection failed. Try again."))')
  assert await page.locator('#solNotices').is_visible()
  assert await page.locator('#solStatusSlot').evaluate('e=>e.getBoundingClientRect().height')>0
  await page.evaluate('solSetNotice("")')
  if os.environ.get('ZAEXA_TEST_ARTIFACTS'):
   await page.screenshot(path=str(Path(os.environ['ZAEXA_TEST_ARTIFACTS'])/'solana-spacing-idle-dark.png'),full_page=True)

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
  assert await page.locator('#tk-chip').get_attribute('data-chain')=='solana'
  assert await page.locator('#tk-chip svg').count()==1
  assert 'linear-gradient' in await page.locator('#tk-chip').evaluate('e=>getComputedStyle(e).backgroundImage')
  assert await page.locator('body>header #srcMenu').count()==0
  assert not await page.locator('#srcMenu').is_visible()
  assert not await page.locator('#swapNetworkBar').is_visible()
  assert await page.locator('#solSafety .chkGroup .eyebrow').all_text_contents()==['2 to look at','2 checked and clear']
  assert await page.locator('#solSafety .chkNum').count()==4
  assert await page.locator('#tk-exitBox .tripPct').inner_text()=='Sell route found'
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
  await page.go_back();await page.wait_for_function('tokenPage && location.pathname.startsWith("/t/")')
  assert await page.locator('#tk-trade').is_visible()
  assert not await page.locator('#solSwap').is_visible()
  await page.go_forward();await page.wait_for_function('!tokenPage && location.pathname==="/app"')
  assert await page.locator('#solSwap').is_visible()
  print('report -> Trade -> browser Back -> report -> Forward -> swap verified')

  await page.goto('http://zaexa.test/t/'+USDT)
  await page.wait_for_function('() => document.querySelector("#solSafety").textContent.includes("60.00%")')
  config['missing']=True;await page.evaluate('solLoadDetails()');assert 'not a readable' in await page.locator('#solSafety').inner_text()
  config['missing']=False;config['foreign']=True;await page.evaluate('solLoadDetails()')
  await page.wait_for_function('document.querySelector("#solSafety").textContent.includes("not a readable")')
  assert 'Safety is unknown' not in await page.locator('#solSafety').inner_text()
  config['foreign']=False
  # Venues card (replaces the GeckoTerminal indexed-pools list): empty until an amount, then Jupiter route steps + best single pool
  await page.goto('http://zaexa.test/app#swap?chain=solana&in='+USDC+'&out='+USDT)
  await page.wait_for_function('document.querySelector("#solPools .ttl")?.textContent==="Venues for this swap"')
  assert 'Enter an amount and we will show every venue Jupiter routes through, plus the best single pool.' in await page.locator('#solPools').inner_text()
  assert await page.locator('#solPools .vrow').count()==0 and await page.locator('#solVenueMeta').text_content()=='—'
  assert await page.locator('#solPools button').count()==0 and 'Load more' not in await page.locator('#solPools').inner_text()
  def step(label,amm,pct,out,a=USDC,b=USDT):return {'percent':pct,'swapInfo':{'label':label,'ammKey':amm,'inputMint':a,'outputMint':b,'outAmount':out}}
  # 2 steps sharing one ammKey collapse to one row; direct quote (1.25) is worse than the route (2.5) so the route rows carry "best"
  config['plan']=[step('Orca','AMM1',60,'1500000'),step('Orca again','AMM1',40,'1000000')]
  config['dplan']=[step('Raydium','AMM9',100,'1250000')]
  await page.wait_for_function('solInputDecimals()!=null && solOutputDecimals()!=null')
  await page.fill('#solAmt','1.25')
  await page.wait_for_function('document.querySelector("#solPools").textContent.includes("Best single pool · Raydium")')
  assert await page.locator('#solPools .vrow').count()==2   # the duplicate ammKey must not become a third row
  rows=await page.locator('#solPools .vrow').all_inner_texts()
  assert 'Orca' in rows[0] and 'Orca again' not in rows[0] and 'USDC → USDT' in rows[0] and '1.5' in rows[0] and '60% of route' in rows[0],rows
  assert 'Best single pool · Raydium' in rows[1] and '1.25' in rows[1],rows
  assert await page.locator('#solPools .vrow').nth(1).locator('.vtag').count()==0 and await page.locator('#solPools .vrow').nth(0).locator('.vtag').count()==1
  assert await page.locator('#solVenueMeta').text_content()=='2 venues',await page.locator('#solPools').inner_html()
  assert await page.locator('#solPools .vrow.win').count()==1
  assert await page.locator('#solPools .vrow .vdot').count()==2 and await page.locator('#solPools .vrow .vout .a').count()==2
  # when the single pool beats the route, it (and only it) is marked best
  config['mult']=0.5;config['dplan']=[step('Meteora','AMM8',100,'1250000')];config['plan']=[step('Orca','AMM1',100,'1000000')]
  await page.fill('#solAmt','1.26');await page.wait_for_function('document.querySelector("#solPools").textContent.includes("Meteora")')
  assert await page.locator('#solPools .vrow.win').count()==1 and 'Best single pool' in await page.locator('#solPools .vrow.win').inner_text()
  config['mult']=2
  # untrusted labels are escaped
  config['plan']=[step('<img src=x onerror=window.pwned=1>','AMM2',100,'2000000')]
  config['dplan']=[step('<b id=bold>x</b>','AMM3',100,'1000000')]
  await page.fill('#solAmt','1.27');await page.wait_for_function('document.querySelector("#solPools").textContent.includes("<img src=x")')
  assert await page.locator('#solPools img, #solPools #bold').count()==0 and await page.evaluate('window.pwned===undefined')
  assert '<b id=bold>x</b>' in await page.locator('#solPools').inner_text()
  # a failed direct quote omits the single-pool row only
  config['dplan']=[];config['plan']=[step('Orca','AMM1',100,'2000000')]
  await page.fill('#solAmt','1.28');await page.wait_for_function('document.querySelector("#solPools").textContent.includes("Orca")')
  assert await page.locator('#solPools .vrow').count()==1 and 'Best single pool' not in await page.locator('#solPools').inner_text()
  assert await page.locator('#solVenueMeta').text_content()=='1 venue'
  # clearing the amount empties the card; a token change does too
  await page.fill('#solAmt','');await page.wait_for_function('document.querySelectorAll("#solPools .vrow").length===0')
  assert 'Enter an amount' in await page.locator('#solPools').inner_text() and await page.locator('#solVenueMeta').text_content()=='—'
  await page.fill('#solAmt','1.3');await page.wait_for_function('document.querySelectorAll("#solPools .vrow").length===1')
  await page.evaluate('solSwapReset(solMintCur)');assert await page.locator('#solPools .vrow').count()==0
  config['plan']=None;config['dplan']=None
  print('venues card: empty before an amount; one row per distinct ammKey plus Best single pool; best marked on the better side; labels escaped; failed direct quote omits only its row; clearing the amount or changing token empties it')
  assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  print('token report: pending approval notice and Cancel visible on mobile; late approval remains disconnected')
  await page.goto('http://zaexa.test/app#swap?chain=solana')
  await page.wait_for_function('typeof solLoadMobileBundle==="function"')
  await page.evaluate('solLoadMobileBundle()')

  await page.evaluate("""() => {
   const handlers={};window.fireUri=u=>handlers.display_uri(u);window.mobileConnects=0;window.mobileAborted=false;window.mobileSent=null;
   const kp=SolMobile.nacl.sign.keyPair();window.mobileOwner=SolMobile.bs58.encode(kp.publicKey);
   const session={namespaces:{solana:{methods:['solana_signTransaction','solana_signMessage'],accounts:[SOL_WC_CHAIN+':'+mobileOwner]}}};
   const provider={session:null,on:(name,fn)=>handlers[name]=fn,
    connect:()=>new Promise((resolve,reject)=>{window.mobileConnects++;window.finishMobile=()=>{provider.session=session;resolve(session);};window.cancelMobile=()=>reject(Error('cancelled'));handlers.display_uri('wc:test-pairing@2?relay-protocol=irn&symKey=0000000000000000000000000000000000000000000000000000000000000000');}),
    abortPairingAttempt:()=>{window.mobileAborted=true;},  // مثلِ کتابخانه‌ی واقعی ۲٫۲۳٫۱۰: هیچ‌چیز را لغو نمی‌کند
    
    disconnect:async()=>{provider.session=null;handlers.session_delete?.();},
    request:async request=>{window.mobileSent=request;if(request.method==='solana_signMessage'){window.mobileApproval=request;return {signature:SolMobile.bs58.encode(SolMobile.nacl.sign.detached(SolMobile.bs58.decode(request.params.message),kp.secretKey))};}return {transaction:request.params.transaction};}};
   SolMobile.UniversalProvider.init=async()=>provider;
  }""")
  await page.evaluate('solOpenWalletPicker()');await page.locator('#solMobileConnect').click()
  await page.wait_for_function('document.querySelector("#solQr")?.width>100')
  await page.locator('#solWalClose').click();await page.wait_for_function('!solMobilePending')
  assert await page.evaluate('mobileAborted && solAccount===null')
  # abortPairingAttempt — پوچ است؛ لغوِ محلی باید QR را پاک کند و uriِ دیررسیده را نادیده بگیرد
  assert await page.evaluate('!solMobilePending && document.querySelector("#solQr")===null')
  await page.evaluate('fireUri("wc:late-after-cancel@2?symKey=00")');await page.wait_for_timeout(300)
  assert await page.evaluate('document.querySelector("#solQr")===null')
  assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  # تلاشِ لغوشده باید واقعاً تمام شود (race با promiseِ لغو)، نه برای همیشه معلق بماند
  await page.evaluate('void(window.att=solConnectMobile())');await page.wait_for_function('document.querySelector("#solQr")?.width>100')
  await page.evaluate('solCloseWalletPicker()')
  assert await page.evaluate('Promise.race([att.then(()=>"settled"),new Promise(r=>setTimeout(()=>r("hung"),1500))])')=='settled'
  await page.evaluate('solOpenWalletPicker()');await page.locator('#solMobileConnect').click()
  await page.wait_for_function('document.querySelector("#solQr")?.width>100')
  assert await page.evaluate('mobileConnects')==3
  await page.evaluate('finishMobile()');await page.wait_for_function('solAccount!==null')
  assert await page.evaluate('solAccount.address===mobileOwner')
  assert await page.evaluate('mobileApproval.method')=='solana_signMessage'
  await page.evaluate("""async()=>{const tx=new Uint8Array(100);tx[0]=1;tx[70]=2;const out=await solWalletApi.features['solana:signTransaction'].signTransaction({account:solAccount,transaction:tx});if(!solBytesEq(out[0].signedTransaction,tx))throw Error('Adapter changed bytes');}""")
  assert await page.evaluate('mobileSent.method')=='solana_signTransaction'
  await page.evaluate('solDisconnectWallet(true)');assert await page.evaluate('solAccount===null')
  print('mobile QR rendered with real local library; cancellation, reconnect, signing adapter and disconnect verified against fake wallet; no real signatures')
  # ---- 4 Oct: injected wallet + sol:unconfirmed + 300-token portfolio, on a page where the big WalletConnect bundle is blocked ----
  seedp=await browser.new_page()
  await seedp.route('**/*',route);await seedp.goto('http://zaexa.test/app#swap?chain=solana')
  await seedp.wait_for_function('typeof solLoadMobileBundle==="function"');await seedp.evaluate('solLoadMobileBundle()')
  kp=await seedp.evaluate('()=>{const k=SolMobile.nacl.sign.keyPair();return {secret:Array.from(k.secretKey),address:SolMobile.bs58.encode(k.publicKey),pub:Array.from(k.publicKey)}}')
  await seedp.close()
  ip=await browser.new_page(viewport={'width':1280,'height':900});ip.on('pageerror',lambda e:errors.append(str(e)))
  blocked=[];reqs=[]
  async def block_route(r):
   if 'solana-wallet.bundle' in r.request.url:blocked.append(r.request.url);return await r.abort()
   return await route(r)
  ip.on('request',lambda q:reqs.append(q.url) if q.resource_type=='script' else None)
  await ip.route('**/*',block_route)
  config['vd']={USDT:{'v':None,'why':'sol:unconfirmed'}}
  await ip.goto('http://zaexa.test/app#swap?chain=solana&in='+SOL+'&out='+USDT+'&amt=0.1')
  await ip.wait_for_function('solQuote!==null && solOutputDecimals()!=null')
  before=len(reqs)
  await ip.evaluate("""(kp)=>{const account={address:kp.address,publicKey:new Uint8Array(kp.pub),chains:['solana:mainnet'],features:['solana:signMessage']};
   window.injWallet={name:'Injected test',accounts:[account],features:{'standard:connect':{connect:async()=>({accounts:[account]})},'standard:disconnect':{disconnect:async()=>{}},
   'solana:signMessage':{signMessage:async({message})=>[{signedMessage:message,signature:SolConfirm.nacl.sign.detached(message,new Uint8Array(kp.secret)),signatureType:'ed25519'}]}}};
   window.injAttempt=solConnectWallet(injWallet);}""",kp)
  await ip.wait_for_function('solAccount!==null')
  extra=[u for u in reqs[before:] if 'bundle' in u]
  assert len(extra)==1 and 'solana-confirm.bundle.' in extra[0],extra
  assert not blocked and await ip.evaluate('window.SolMobile===undefined && typeof SolConfirm==="object"'),blocked
  print('injected wallet connects with only the small confirm bundle fetched; the WalletConnect bundle was never requested')
  # buy into a sol:unconfirmed token: amber card, two-step button; sell side never gated
  await ip.wait_for_function('document.querySelector("#appSolExitBox").textContent.includes("unconfirmed")')
  box=await ip.locator('#appSolExitBox').inner_text()
  assert 'Sell-back failed in our simulation' in box and 'we do not call it a honeypot yet. Treat it as high risk.' in box and 'No way out' not in box and 'No sell route' not in box,box
  assert 'var(--warn)' in await ip.locator('#appSolExitBox .exitTtl').get_attribute('style')
  await ip.wait_for_function('solQuote!==null')
  await ip.wait_for_function('document.querySelector("#solSwapBtn").textContent!=="Connect wallet"')
  assert await ip.locator('#solSwapBtn').inner_text()=='Buy anyway (sell-back unconfirmed)' and await ip.locator('#solSwapBtn').is_enabled()
  swaps=[]
  ip.on('request',lambda q:swaps.append(q.url) if '/sol/swap' in q.url else None)
  await ip.locator('#solSwapBtn').click()
  assert await ip.locator('#solSwapBtn').inner_text()=='Swap' and not swaps,swaps
  await ip.evaluate('solSide="sell";solOnSideChange()')
  assert not await ip.evaluate('solNeedsArm()') and 'Buy anyway' not in await ip.locator('#solSwapBtn').inner_text()
  await ip.evaluate('solArmedMints.clear();solSide="buy";solOnSideChange()')
  await ip.fill('#solAmt','0.1');await ip.wait_for_function('solQuote!==null')
  assert await ip.locator('#solSwapBtn').inner_text()=='Buy anyway (sell-back unconfirmed)'
  print('sol:unconfirmed: amber caution card, first click only arms the buy, sell side not gated, arming is per token')
  # 320-mint wallet: only the first 300 are priced, 30 per request, at most 3 in flight; a failed chunk leaves its rows unpriced
  def mint_of(i):return 'Tok'+''.join(chr(97+int(d)) for d in '%03d'%i)+'X'*37
  mints=[mint_of(i) for i in range(320)]
  config['tokaccts']=[{'pubkey':'Acct'+m,'account':{'data':{'parsed':{'info':{'mint':m,'tokenAmount':{'amount':'1000000','decimals':6}}}}}} for m in mints]
  config['multi']={'urls':set(),'inflight':0,'peak':0,'fail':{mints[59]}}
  await ip.evaluate('setView("folio",false)')
  await ip.wait_for_function('document.querySelectorAll("#folioBody .frow").length===321')
  m=config['multi']
  assert len(m['urls'])==10 and m['peak']<=3,(len(m['urls']),m['peak'])
  assert 'Only the first 300 tokens are priced.' in await ip.locator('#folioBody').inner_text()
  assert await ip.locator('#folioBody .frow .u:text-is("no price")').count()==21+30
  print('portfolio: 321 holdings -> 10 price requests of 30, at most 3 in flight, failed chunk leaves 30 rows unpriced, 21 beyond the cap unpriced, cap note shown')
  config['multi']=None;config['tokaccts']=[]
  await ip.goto('http://zaexa.test/t/'+USDT)
  await ip.wait_for_function('document.querySelector("#tk-exitBox").textContent.includes("unconfirmed")')
  tb=await ip.locator('#tk-exitBox').inner_text()
  assert 'Our simulated sell of this token failed.' in tb and 'No way out' not in tb and 'var(--warn)' in await ip.locator('#tk-exitBox .tripPct').get_attribute('style'),tb
  print('token page shows the same amber unconfirmed card, never the red No way out')
  await ip.close()
  assert not errors,errors
  assert all(e.get('c') in ['base','solana'] for e in events),events
  print('token-page chart, unreadable-address card, network-labelled events; no page errors')
  await browser.close()
asyncio.run(main())
