// Offline integration checks. Requires Playwright + Chromium, like run.py.
// PLAYWRIGHT_MODULE may point to a shared Playwright installation.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { renderReportPage } from '../../worker/report_page.js';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=process.env.ZAEXA_TEST_OUTPUT||await mkdtemp(join(tmpdir(),'zaexa-watchlist-'));
await mkdir(output,{recursive:true});
const SOL='So11111111111111111111111111111111111111112';
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT='Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const JUP='JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const AERO='0x940181a94a35a4569e4529a3cdfb74e38fd98631';
const WETH='0x4200000000000000000000000000000000000006';
const KEY='zaexa.watchlist.v1';
const app=(await readFile(join(root,'index.html'),'utf8'))
  .replace(/const ETHERS_SRC="[^"]*";/,'const ETHERS_SRC="/stub-ethers.js";')
  .replace(/const ETHERS_SRI="[^"]*";/,'const ETHERS_SRI="";');
// Validate every inline program, not just the new functions.
for(const match of app.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
const fixtureRows=[];
for(const [chain,total,sell,no] of [['base',30,13,2],['solana',11,8,1]]){
  for(let i=0;i<total;i++)fixtureRows.push({chain,address:chain==='base'?'0x'+(100+i).toString(16).padStart(40,'0'):JUP,
    symbol:'TEST'+i,v:i<sell?'sell':i<sell+no?'nosell':null,checkedAt:'2026-10-22T12:17:00Z',ret:98});
}
const report=(rows=fixtureRows,date='2026-10-22')=>renderReportPage({date,today:date,firstDate:'2026-09-07',rows,history:[]});
await writeFile(join(output,'report-preview.html'),report());
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
try{
  const context=await browser.newContext({viewport:{width:1280,height:900},permissions:['clipboard-read','clipboard-write']});
  const errors=[],requests=[];
  let reportHtml=report(),failPrices=false;
  context.on('page',page=>page.on('pageerror',e=>errors.push(e.message)));
  const meta=address=>({id:'token_'+address,attributes:{address,symbol:address===JUP?'JUP':address.toLowerCase()===AERO?'AERO':address===USDT?'USDT':'TOKEN',name:'Test token',price_usd:failPrices?null:'0.75',decimals:6}});
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname,q=url.searchParams;
    requests.push(path);
    const json=body=>route.fulfill({json:body});
    if(path==='/ev')return route.fulfill({status:204});
    if(path.startsWith('/report'))return route.fulfill({contentType:'text/html',body:reportHtml});
    if(path==='/app'||path.startsWith('/t/'))return route.fulfill({contentType:'text/html',body:app});
    if(path==='/stub-ethers.js')return route.fulfill({contentType:'text/javascript',body:(await readFile(join(root,'test/stub-ethers.js'),'utf8')).replace('if (!u.includes("api.geckoterminal.com")) {','if (true) {')});
    if(path==='/sol/rpc'){
      const data=req.postDataJSON();let result=null;
      if(data.method==='getAccountInfo')result={value:{owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',data:{parsed:{type:'mint',info:{decimals:6,supply:'100000000',mintAuthority:null,freezeAuthority:null}}}}};
      if(data.method==='getEpochInfo')result={epoch:100};
      if(data.method==='getTokenLargestAccounts')result={value:[{amount:'1000000'}]};
      if(data.method==='getBalance')result={value:1000000000};
      if(data.method==='getTokenAccountsByOwner')result={value:[]};
      return json({jsonrpc:'2.0',id:data.id,result});
    }
    if(path==='/sol/quote')return json({inputMint:q.get('inputMint'),outputMint:q.get('outputMint'),inAmount:q.get('amount'),outAmount:q.get('amount'),otherAmountThreshold:q.get('amount'),swapMode:'ExactIn',slippageBps:50,priceImpactPct:'0.002',routePlan:[]});
    if(path.startsWith('/vd/'))return json({v:'sell'});
    if(path.includes('/networks/')){
      if(path.includes('/multi/'))return json({data:path.split('/multi/')[1].split(',').map(meta)});
      if(path.includes('/ohlcv/'))return json({data:{attributes:{ohlcv_list:[]}}});
      if(path.endsWith('/pools'))return json({data:[]});
      if(path.includes('/tokens/'))return json({data:meta(path.split('/tokens/')[1])});
      return json({data:[]});
    }
    if(path.endsWith('.js')){
      const target=resolve(root,'.'+path);
      if(target.startsWith(root+'\\')||target.startsWith(root+'/')){
        try{return await route.fulfill({contentType:'text/javascript',body:await readFile(target)});}catch{}
      }
    }
    return json({});
  });
  const page=await context.newPage();
  await page.goto('https://zaexa.test/app#swap?chain=solana&out='+JUP);
  try{await page.waitForFunction(()=>typeof savedWatchReady!=='undefined'&&savedWatchReady&&solMintCur!==null&&solTokenSymbol==='JUP');}
  catch(e){console.log({errors,state:await page.evaluate(()=>({ready:typeof savedWatchReady,chain:typeof activeChain==='undefined'?null:activeChain,mint:typeof solMintCur==='undefined'?null:solMintCur,symbol:typeof solTokenSymbol==='undefined'?null:solTokenSymbol,body:document.body.innerText.slice(-1700)})),requests:requests.slice(-12)});throw e;}
  await page.locator('#solWatch').click();
  await page.waitForFunction(()=>document.getElementById('savedCount').textContent==='1');
  assert.equal(await page.locator('#solWatch').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('.savedLink').getAttribute('href'),'/t/'+JUP);
  await page.reload();
  await page.waitForFunction(()=>typeof savedWatchReady!=='undefined'&&savedWatchReady);
  assert.equal(await page.locator('#savedCount').innerText(),'1','Saved across reloads without a wallet');
  await page.locator('#savedWatch').evaluate(e=>e.open=true);
  try{await page.waitForFunction(()=>document.querySelector('.savedPrice')?.textContent.includes('$0.75'));}
  catch(e){console.log({errors,watch:await page.locator('#savedWatch').innerText(),requests:requests.slice(-20)});throw e;}

  // Cross-tab updates are visible; malformed and injected values never become HTML.
  const other=await context.newPage();await other.goto('https://zaexa.test/app#swap?chain=solana');
  await other.waitForFunction(()=>typeof savedWatchReady!=='undefined'&&savedWatchReady);
  await other.evaluate(({KEY,AERO,JUP})=>localStorage.setItem(KEY,JSON.stringify([
    {chain:'base',address:AERO.toUpperCase().replace('0X','0x'),symbol:'<img src=x onerror=alert(1)>'},
    {chain:'base',address:AERO,symbol:'duplicate'},
    {chain:'solana',address:JUP,symbol:'JUP'},
    {chain:'evil',address:AERO},{chain:'base',address:'javascript:alert(1)'}
  ])),{KEY,AERO,JUP});
  await page.waitForFunction(()=>document.getElementById('savedCount').textContent==='2');
  assert.equal(await page.locator('#savedList img').count(),0);
  assert.equal(await page.locator('.savedRow').count(),2);
  assert.match(await page.locator('.savedRow').first().innerText(),/<img src=x/);
  assert.equal(await page.locator('.savedLink').first().getAttribute('href'),'/t/'+AERO);

  // No guessed zero when a token has no usable market price.
  failPrices=true;
  await page.evaluate(async()=>{await gtChain;gtCache.clear();gtInflight.clear();try{localStorage.removeItem('zaexa.gt.v1')}catch{};});
  await page.evaluate(()=>{gtcGet=()=>null;return savedWatchRefresh()});
  assert.equal(await page.locator('.savedPrice').first().innerText(),'—\nPrice unavailable');
  failPrices=false;
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{savedWatchRows[0].symbol='AERO';gtCache.clear();savedWatchRender();return savedWatchRefresh()});
  await page.locator('#savedWatch').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Mobile watchlist fits viewport');
  await page.screenshot({path:join(output,'watchlist-mobile.png'),fullPage:false});
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await page.screenshot({path:join(output,'watchlist-mobile-dark.png')});
  await page.evaluate(()=>document.documentElement.dataset.theme='light');

  // Base selection, duplicate toggle, limit, write errors, and empty-state focus.
  await page.evaluate(()=>{tokenOut=BASE_TOKENS.find(t=>t.symbol==='AERO');savedWatchSelection()});
  await page.evaluate(()=>savedWatchToggle('base'));
  assert.equal(await page.locator('#savedCount').innerText(),'1');
  await page.evaluate(()=>savedWatchToggle('base'));
  assert.equal(await page.locator('#savedCount').innerText(),'2');
  await page.evaluate(({KEY})=>{
    const rows=Array.from({length:30},(_,i)=>({chain:'base',address:'0x'+(i+1).toString(16).padStart(40,'0'),symbol:'T'+i}));
    localStorage.setItem(KEY,JSON.stringify(rows));savedWatchRows=savedWatchRead();savedWatchRender();savedWatchToggle('base');
  },{KEY});
  assert.equal(await page.locator('#savedCount').innerText(),'30');
  assert.match(await page.locator('#savedStatus').innerText(),/full/);
  await page.evaluate(({KEY})=>{localStorage.setItem(KEY,'[]');savedWatchRows=[];savedWatchRender();Storage.prototype.setItem=function(){throw new Error('Storage disabled')};savedWatchToggle('base')},{KEY});
  assert.equal(await page.locator('#savedCount').innerText(),'0');
  assert.match(await page.locator('#savedStatus').innerText(),/Could not save/);
  // The monkey-patch is scoped to this page; a reload restores native Storage.
  await page.reload();await page.waitForFunction(()=>typeof savedWatchReady!=='undefined'&&savedWatchReady);
  await page.evaluate(()=>savedWatchToggle('solana'));
  await page.locator('.savedRemove').click();
  assert.equal(await page.locator('#savedCount').innerText(),'0');
  assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#savedWatch summary')),true);
  await page.goto('https://zaexa.test/app#swap?chain=base&out=AERO');
  await page.reload(); // A hash-only goto on /app is a same-document navigation.
  try{await page.waitForFunction(()=>typeof tokenOut!=='undefined'&&tokenOut?.symbol==='AERO');}
  catch(e){console.log({errors,state:await page.evaluate(()=>({chain:activeChain,symbol:tokenOut?.symbol,body:document.body.innerText.slice(0,1500)})),requests:requests.slice(-15)});throw e;}
  await page.evaluate(()=>{document.getElementById('savedWatch').open=false;scrollTo(0,0)});
  for(const width of [360,390,430,768,940]){
    await page.setViewportSize({width,height:844});
    assert.equal(await page.locator('#actBtn').evaluate((e,width)=>e.getBoundingClientRect().bottom<=(width<=430?document.getElementById('nav').getBoundingClientRect().top:844),width),true,'Base CTA stays clear of navigation at '+width);
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('#view-swap .mTabs [data-mtab="exit"]:visible').click();
  await page.locator('#baseWatch').click();
  assert.equal(await page.locator('#savedCount').innerText(),'1');
  await page.goto('https://zaexa.test/t/'+AERO);
  await page.waitForFunction(()=>!document.getElementById('tokenWatch').disabled);
  assert.equal(await page.locator('#tokenWatch').getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Base token actions fit mobile viewport');
  await page.locator('#tokenWatch').click();
  assert.equal(await page.locator('#savedCount').innerText(),'0');
  await page.goto('https://zaexa.test/t/'+JUP);
  await page.waitForFunction(()=>!document.getElementById('tokenWatch').disabled);
  await page.locator('#tokenWatch').click();
  assert.equal(await page.locator('#savedCount').innerText(),'1');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Solana token actions fit mobile viewport');
  console.log('Watchlist: persistence, chain identity, cross-tab edits, invalid data, missing prices, limit, storage errors, removal and mobile layout passed.');

  await page.goto('https://zaexa.test/report/2026-10-22');
  await page.locator('#reportSummaryCopy').click();
  assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/13 sell route quoted, 2 no sell route, 15 unknown/);
  await page.evaluate(()=>{
    Object.defineProperty(navigator,'canShare',{configurable:true,value:({files})=>files.length===1});
    Object.defineProperty(navigator,'share',{configurable:true,value:async({files,text})=>{window.sharedReport={name:files[0].name,type:files[0].type,size:files[0].size,text}}});
  });
  await page.locator('#reportCardOpen').click();
  await page.waitForFunction(()=>!document.getElementById('reportCardSave').disabled);
  assert.equal(await page.evaluate(()=>document.fonts.check('400 16px "Manrope"')&&document.fonts.check('700 48px "Manrope"')),true,'Existing public font loaded before PNG export');
  assert.equal(await page.evaluate(()=>Array.from(document.fonts).some(f=>f.family==='Manrope'&&f.status==='loaded')),true);
  assert.equal(await page.evaluate(()=>{
    const pixels=document.getElementById('reportShareCanvas').getContext('2d').getImageData(48,24,78,54).data;
    let colored=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i+1]>100&&pixels[i+2]>150)colored++;
    return colored>150;
  }),true,'Official public SVG symbol renders into the downloadable PNG');
  assert.equal(await page.locator('#reportShareDialog').evaluate(e=>e.open),true);
  assert.equal(await page.locator('#reportCardShare').isVisible(),true);
  await page.locator('#reportCardShare').click();
  const shared=await page.evaluate(()=>window.sharedReport);
  assert.equal(shared.name,'zaexa-exit-report-2026-10-22.png');assert.equal(shared.type,'image/png');assert.ok(shared.size>1000);
  assert.match(shared.text,/https:\/\/zaexa.com\/report\/2026-10-22$/);
  const download=page.waitForEvent('download');await page.locator('#reportCardSave').click();
  await (await download).saveAs(join(output,'zaexa-report-sample.png'));
  const png=await readFile(join(output,'zaexa-report-sample.png'));
  assert.equal(png.readUInt32BE(16),1200);assert.equal(png.readUInt32BE(20),630);
  await page.screenshot({path:join(output,'report-mobile-light.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await page.screenshot({path:join(output,'report-mobile-dark.png')});
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#reportShareDialog').evaluate(e=>e.open),false);
  await page.setViewportSize({width:1280,height:900});
  await page.locator('#reportCardOpen').click();
  await page.screenshot({path:join(output,'report-desktop-dark.png')});
  await page.keyboard.press('Escape');
  // Clipboard-denied fallback stays usable, with selectable complete text.
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('Denied')}}}));
  await page.locator('#reportSummaryCopy').click();
  assert.equal(await page.locator('#reportShareDialog').evaluate(e=>e.open),true);
  await page.waitForFunction(()=>document.getElementById('reportShareStatus').textContent.includes('Select and copy'));
  assert.match(await page.locator('#reportShareStatus').innerText(),/Select and copy/);
  assert.match(await page.locator('#reportShareText').inputValue(),/https:\/\/zaexa.com\/report\/2026-10-22/);
  reportHtml=report([]);await page.goto('https://zaexa.test/report/2026-10-22');
  assert.equal(await page.locator('#reportCardOpen').count(),0);
  reportHtml=report(fixtureRows,'2026-09-21');await page.goto('https://zaexa.test/report/2026-09-21');
  assert.doesNotMatch(await page.locator('#reportShareText').inputValue(),/Solana/);
  console.log('Report: counts, UTC timestamp, historical/empty reports, clipboard fallback, dialog, PNG dimensions and both themes passed.');
  assert.deepEqual(errors,[],'No uncaught browser errors');
  console.log('Preview artifacts: '+output);
}finally{await browser.close();}
