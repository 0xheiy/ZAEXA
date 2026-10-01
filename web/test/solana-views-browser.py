import asyncio,json,re,os
from pathlib import Path
from urllib.parse import urlparse
from datetime import datetime,timezone,timedelta
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
ARTIFACTS=Path(os.environ.get('ZAEXA_TEST_ARTIFACTS',str(ROOT/'test')))
ARTIFACTS.mkdir(parents=True,exist_ok=True)
SOL='So11111111111111111111111111111111111111112'
USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
USDT='Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
OWNER='11111111111111111111111111111111'
INIT='''(()=>{const wallet={name:'Views Test Wallet',chains:['solana:mainnet'],features:{
'standard:connect':{connect:async()=>({accounts:[{address:'11111111111111111111111111111111',publicKey:new Uint8Array(32)}]})},
'standard:disconnect':{disconnect:async()=>{}},'solana:signTransaction':{signTransaction:async()=>{throw Error('No real signing in this test');}}}};
addEventListener('wallet-standard:app-ready',e=>e.detail.register(wallet));})();'''
def tokens(mint,amount):
    return {'value':[{'pubkey':'account-'+mint,'account':{'data':{'parsed':{'info':{'mint':mint,'tokenAmount':{'amount':str(amount),'decimals':6,'uiAmountString':str(amount/1e6)}}}}}}]}
async def main():
    async with async_playwright() as pw:
        browser=await pw.chromium.launch()
        page=await browser.new_page(viewport={'width':1280,'height':900})
        errors=[];calls=[];broken={'2022':False,'trades':False}
        page.on('pageerror',lambda error:errors.append(str(error)))
        await page.add_init_script(INIT)
        async def route(r):
            u=urlparse(r.request.url);path=u.path
            if path=='/ev': return await r.fulfill(status=204,body='')
            if path=='/sol/rpc':
                data=json.loads(r.request.post_data);calls.append(data)
                method=data['method']
                if method=='getBalance':result={'value':2000000000}
                elif method=='getTokenAccountsByOwner':
                    program=data['params'][1].get('programId','')
                    if program.startswith('Tokenz') and broken['2022']:return await r.fulfill(status=502,json={'error':'unavailable'})
                    result=tokens(USDT,3000000) if program.startswith('Tokenz') else tokens(USDC,5000000)
                else:result=None
                return await r.fulfill(json={'result':result})
            if path.startswith('/vd/'):return await r.fulfill(json={'v':'sell','basis':'quote'})
            if '/gt/' in path:
                if '/trades' in path:
                    if broken['trades']:return await r.fulfill(status=503,json={'error':'unavailable'})
                    now=datetime.now(timezone.utc)
                    return await r.fulfill(json={'data':[{'id':str(i),'attributes':{
                        'from_token_address':SOL if i==0 else USDC,'to_token_address':USDC if i==0 else SOL,
                        'block_timestamp':(now-timedelta(minutes=i+1)).isoformat(),'volume_in_usd':'10' if i==0 else '4',
                        'tx_from_address':OWNER}} for i in range(2)]})
                if '/tokens/multi/' in path:
                    mints=path.split('/multi/')[1].split(',')
                    return await r.fulfill(json={'data':[{'attributes':{'address':m,'symbol':'SOL' if m==SOL else 'USDC' if m==USDC else 'USDT','price_usd':'100' if m==SOL else '1'}} for m in mints]})
                if path.endswith('/pools'):
                    return await r.fulfill(json={'data':[{'attributes':{'address':SOL,'name':'USDC / SOL','reserve_in_usd':'100000'},'relationships':{'base_token':{'data':{'id':'solana_'+USDC}}}}]})
                if '/tokens/' in path:return await r.fulfill(json={'data':{'attributes':{'symbol':'USDC','name':'USD Coin','decimals':6,'price_usd':'1'}}})
                return await r.fulfill(json={'data':[]})
            if path in ['/app','/','/index.html']:
                src=(ROOT/'index.html').read_text()
                src=re.sub(r'const ETHERS_SRC="[^"]*";','const ETHERS_SRC="/stub-ethers.js";',src,count=1)
                src=re.sub(r'const ETHERS_SRI="[^"]*";','const ETHERS_SRI="";',src,count=1)
                return await r.fulfill(content_type='text/html',body=src)
            if path=='/stub-ethers.js':return await r.fulfill(content_type='text/javascript',body=(ROOT/'test/stub-ethers.js').read_text())
            file=(ROOT/path.lstrip('/')).resolve()
            if file.is_relative_to(ROOT) and file.is_file():return await r.fulfill(body=file.read_bytes(),content_type='text/javascript' if path.endswith('.js') else 'application/octet-stream')
            return await r.fulfill(json={})
        await page.route('**/*',route)
        await page.goto('http://zaexa.test/app#folio?chain=solana')
        await page.wait_for_function("document.querySelector('#folioBody').textContent.includes('Connect Solana wallet')")
        await page.locator('#folioBody [data-act="connect"]').click()
        await page.locator('#solWalList .walRow[data-i]' ).click()
        await page.wait_for_function("document.querySelector('#folioTotal').textContent==='$208'")
        assert 'USDT' in await page.locator('#folioBody').inner_text()
        assert len({x['params'][1].get('programId') for x in calls if x['method']=='getTokenAccountsByOwner' and 'programId' in x['params'][1]})==2
        for width in [390,1280]:
            await page.set_viewport_size({'width':width,'height':900})
            assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),('portfolio',width)
        await page.screenshot(path=str(ARTIFACTS/'solana-portfolio-preview.png'))
        print('portfolio: connected Solana wallet, both token programs, native balance and $208 valuation verified')
        await page.locator('#nav [data-view="flow"]').click()
        await page.wait_for_function("document.querySelector('#flowBody').textContent.includes('1 buys · 1 sells')")
        assert 'Recent-trade sample' in await page.locator('#flowBody').inner_text()
        for width in [390,1280]:
            await page.set_viewport_size({'width':width,'height':900})
            assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),('flow',width)
        await page.screenshot(path=str(ARTIFACTS/'solana-flow-preview.png'))

        await page.locator('#flowTokBtn').click()
        assert await page.locator('#solTokOv').evaluate("e=>e.classList.contains('on')")
        await page.keyboard.press('Escape')
        await page.evaluate('solCloseTokenPicker()')
        print('flow: Solana trades, sample coverage and Solana token picker verified')
        await page.locator('#srcChip').click();await page.locator('#srcPop [data-chain="base"]').click()
        assert await page.evaluate('activeChain')=='base'
        assert 'Recent-trade sample' not in await page.locator('#flowBody').inner_text()
        await page.locator('#srcChip').click();await page.locator('#srcPop [data-chain="solana"]').click()
        await page.locator('#nav [data-view="folio"]').click()
        await page.wait_for_function("document.querySelector('#folioTotal').textContent==='$208'")
        broken['2022']=True
        await page.evaluate('renderFolio()')
        assert 'partial portfolio' in await page.locator('#folioBody').inner_text()
        print('network switch and partial RPC failure verified')
        await page.locator('#connectBtn').click();await page.locator('#disconnectBtn').click()
        await page.wait_for_function("document.querySelector('#folioBody').textContent.includes('Connect Solana wallet')")
        for width in [390,1280]:
            await page.set_viewport_size({'width':width,'height':900})
            assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),width
        assert not errors,errors
        print('disconnect clears holdings; mobile and desktop have no horizontal overflow; no page errors')
        await browser.close()
asyncio.run(main())
