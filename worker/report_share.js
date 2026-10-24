// Presentation only: consume the report's guarded rows and its existing counts.
// The client is inlined by the Worker, so no static deployment rule is needed.
export function reportShareData(date, stats, rows, solana) {
  const validTimes = rows.map(r => r.checkedAt).filter(value =>
    typeof value === 'string' && value.startsWith(date + 'T') && Number.isFinite(Date.parse(value)));
  const latest = validTimes.length ? new Date(Math.max(...validTimes.map(Date.parse))).toISOString() : null;
  const url = 'https://zaexa.com/report/' + date;
  const base = { total: stats.b, sell: stats.bSell, no: stats.bNo, unknown: stats.bNa };
  const sol = solana ? { total: stats.s, sell: stats.sSell, no: stats.sNo, unknown: stats.sNa } : null;
  const lines = [
    'ZAEXA · Exit Report · ' + date + ' (UTC)',
    'Base — ' + base.total + ' checked: ' + base.sell + ' sell route quoted, ' + base.no + ' no sell route, ' + base.unknown + ' unknown.',
    'Base method: sell quote on $100 of the token; not a simulated round trip.',
  ];
  if (sol) lines.push(
    'Solana — ' + sol.total + ' checked: ' + sol.sell + ' passed buy-and-sell simulation, ' + sol.no + ' sell-back failed, ' + sol.unknown + ' unknown.',
    'Solana method: buy and sell simulated together.');
  lines.push(latest ? 'Latest included check: ' + latest.replace('T', ' ').replace('.000Z', ' UTC') : 'Check times unavailable.',
    'A snapshot, not a safety guarantee. Unknown means the check could not finish.', url);
  return { date, url, latest, base, solana: sol, text: lines.join('\n') };
}

export const REPORT_SHARE_CSS = String.raw`
.reportShareActions{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}
.reportShareActions[hidden]{display:none}
.reportShareActions button,.shareActions button{font:600 13px var(--sans);cursor:pointer;min-height:42px;padding:10px 16px;border-radius:12px;border:1px solid var(--line2);color:var(--tx);background:var(--card)}
.reportShareActions button{border-radius:999px}
.reportShareActions button:first-child,.shareActions .shareSave{background:var(--grad);color:var(--on-acc);border-color:transparent;font-weight:620}
.reportShareActions button:first-child:active,.shareActions .shareSave:active{transform:translateY(1px);box-shadow:inset 0 2px 4px rgba(20,30,55,.22)}
.reportShareActions button:disabled{opacity:.45;cursor:default}
.reportShareDialog{color:var(--tx);background:var(--card);border:1px solid var(--line2);border-radius:22px;padding:24px;width:min(900px,calc(100% - 24px));max-height:calc(100dvh - 32px);overflow:auto;box-shadow:0 28px 100px #0005}
.reportShareDialog::backdrop{background:#080a16b8;backdrop-filter:blur(5px)}
.shareDialogHead{display:flex;align-items:center;gap:12px;justify-content:space-between;margin-bottom:18px}.shareDialogHead h2{margin:0;font-size:21px}.shareClose{width:40px;height:40px;border:1px solid var(--line2);border-radius:12px;background:var(--raise);font-size:24px;cursor:pointer}
.reportShareDialog canvas{display:block;width:100%;height:auto;border-radius:14px;background:#0c101b}
.shareActions{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}.shareSummary{display:block;font-size:12px;color:var(--tx2)}
.reportShareDialog textarea{box-sizing:border-box;width:100%;height:160px;padding:12px;margin-top:8px;border:1px solid var(--line2);border-radius:12px;background:var(--bg);color:var(--tx);font:12px/1.6 var(--sans);resize:vertical}
.reportShareStatus{font-size:12px;color:var(--tx2);margin:10px 0 0;min-height:20px}
.reportShareActions button:focus-visible,.reportShareDialog button:focus-visible,.reportShareDialog textarea:focus-visible{outline:2px solid var(--acc);outline-offset:3px}
@media(max-width:600px){.reportShareDialog{padding:16px}.shareActions button{flex:1}.shareDialogHead h2{font-size:18px}}
`;

export const REPORT_SHARE_HTML = `
<div class="reportShareActions" id="reportShareActions" hidden>
  <button type="button" id="reportCardOpen">Get report card</button>
  <button type="button" id="reportSummaryCopy">Copy summary</button>
</div>
<p class="reportShareStatus" id="reportCopyStatus" role="status" aria-live="polite"></p>
<dialog class="reportShareDialog" id="reportShareDialog" aria-labelledby="reportShareTitle">
  <div class="shareDialogHead"><h2 id="reportShareTitle">Share this Exit Report</h2><button class="shareClose" id="reportCardClose" type="button" aria-label="Close report card">×</button></div>
  <canvas id="reportShareCanvas" width="1200" height="630" role="img" aria-label="Exit Report summary"></canvas>
  <div class="shareActions"><button class="shareSave" type="button" id="reportCardSave">Download PNG</button><button type="button" id="reportCardShare" hidden>Share image</button><button type="button" id="reportCardCopy">Copy summary</button></div>
  <label class="shareSummary" for="reportShareText">Summary and report link<textarea id="reportShareText" readonly></textarea></label>
  <p class="reportShareStatus" id="reportShareStatus" role="status" aria-live="polite"></p>
</dialog>`;

export const REPORT_SHARE_JS = String.raw`
(function(){
  var dataNode=document.getElementById('reportData'),D;
  try{D=JSON.parse(dataNode.textContent).share;}catch(e){return;}
  if(!D||!D.base||D.base.total+(D.solana?D.solana.total:0)===0)return;
  var $=function(id){return document.getElementById(id)},dialog=$('reportShareDialog'),canvas=$('reportShareCanvas');
  $('reportShareActions').hidden=false;
  $('reportShareText').value=D.text;
  canvas.setAttribute('aria-label',D.text);
  var png=null,brandReady=null;
  // Reuse only the SVG definitions and Manrope face already shipped in the
  // public landing/report shell. No separate artwork or font bundle is needed.
  function loadLogo(){
    return new Promise(function(resolve,reject){
      var ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),defs=document.createElementNS(ns,'defs');
      svg.setAttribute('width','2822');svg.setAttribute('height','698');svg.setAttribute('viewBox','0 0 2822 698');svg.setAttribute('color','#eaf5ff');
      ['zxm','zxMark','zxWord'].forEach(function(id){var node=document.getElementById(id);if(!node)throw new Error('Public artwork unavailable');defs.append(node.cloneNode(true));});
      svg.append(defs);
      function use(id,x,y,width,height){var node=document.createElementNS(ns,'use');node.setAttribute('href','#'+id);node.setAttribute('x',x);node.setAttribute('y',y);node.setAttribute('width',width);node.setAttribute('height',height);svg.append(node);}
      use('zxMark',0,0,1000,698);use('zxWord',1170,253,1652,192);
      var url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml'})),img=new Image();
      img.onload=function(){URL.revokeObjectURL(url);resolve(img)};
      img.onerror=function(){URL.revokeObjectURL(url);reject(new Error('Public artwork unavailable'))};img.src=url;
    });
  }
  function loadBrand(){
    if(brandReady)return brandReady;
    brandReady=Promise.all([
      document.fonts.load('400 16px "Manrope"'),
      document.fonts.load('700 48px "Manrope"'),
      loadLogo()
    ]).then(function(loaded){if(!loaded[0].length||!loaded[1].length)throw new Error('Public font unavailable');return loaded[2]})
      .catch(function(e){brandReady=null;throw e});
    return brandReady;
  }
  function line(ctx,text,x,y,size,color,weight){ctx.font=(weight||400)+' '+size+'px "Manrope"';ctx.fillStyle=color||'#edf2ff';ctx.fillText(text,x,y);}
  function round(ctx,x,y,w,h,r){ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fill();}
  function draw(logo){
    var ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas unavailable');
    ctx.fillStyle='#0c101b';ctx.fillRect(0,0,1200,630);
    var glow=ctx.createRadialGradient(50,0,0,50,0,800);glow.addColorStop(0,'#153848');glow.addColorStop(1,'#0c101b00');ctx.fillStyle=glow;ctx.fillRect(0,0,1200,630);
    var glow2=ctx.createRadialGradient(1200,250,0,1200,250,700);glow2.addColorStop(0,'#332849');glow2.addColorStop(1,'#0c101b00');ctx.fillStyle=glow2;ctx.fillRect(0,0,1200,630);
    // Preserve the public SVG paths, including the outlined custom logotype.
    var logoHeight=54;ctx.drawImage(logo,48,24,logoHeight*2822/698,logoHeight);
    ctx.textAlign='right';line(ctx,D.date+' · UTC',1152,65,19,'#b8c3da');ctx.textAlign='left';
    line(ctx,'The daily exit check.',48,139,48,'#f3f6ff',700);
    line(ctx,'A snapshot of new tokens on '+(D.solana?'Base and Solana.':'Base.'),48,177,21,'#b8c3da');
    function panel(x,w,title,method,counts,sol){
      ctx.fillStyle='#ffffff09';round(ctx,x,210,w,245,18);ctx.strokeStyle='#ffffff1a';ctx.lineWidth=1;ctx.stroke();
      line(ctx,title,x+24,251,25,'#f3f6ff',700);
      line(ctx,method,x+24,280,16,'#aebbd2');
      var values=[counts.total,counts.sell,counts.no,counts.unknown],labels=sol?['Checked','Passed','Sell-back failed','Unknown']:['Checked','Sell quoted','No sell route','Unknown'];
      var colors=['#f3f6ff','#5ad7cf','#f3b775','#b8c3da'],cell=(w-48)/4;
      values.forEach(function(n,i){
        var xx=x+24+i*cell;
        line(ctx,String(n),xx,353,39,colors[i],700);line(ctx,labels[i],xx,385,14,'#b8c3da');
      });
      line(ctx,sol?'Both legs run in one simulation.':'Sell quote on $100; not a round-trip simulation.',x+24,430,15,'#aebbd2');
    }
    panel(48,D.solana?540:1104,'Base','Sell-route check',D.base,false);
    if(D.solana)panel(612,540,'Solana','Buy-and-sell check',D.solana,true);
    var checked=D.latest?'Latest included check: '+D.latest.slice(0,10)+' '+D.latest.slice(11,16)+' UTC':'Check times unavailable.';
    line(ctx,checked,48,492,16,'#aebbd2');
    ctx.strokeStyle='#ffffff25';ctx.beginPath();ctx.moveTo(48,518);ctx.lineTo(1152,518);ctx.stroke();
    line(ctx,'zaexa.com/report/'+D.date,48,560,25,'#eaf5ff',700);
    line(ctx,'Results can change. Unknown means the check could not finish. Not a safety guarantee.',48,599,16,'#aebbd2');
  }
  function makePng(){return new Promise(function(resolve,reject){canvas.toBlob(function(blob){blob?resolve(blob):reject(new Error('PNG unavailable'));},'image/png');});}
  function file(){return new File([png],'zaexa-exit-report-'+D.date+'.png',{type:'image/png'});}
  async function open(){
    $('reportShareStatus').textContent='Preparing image…';
    png=null;$('reportCardSave').disabled=true;$('reportCardShare').hidden=true;
    if(!dialog.open)dialog.showModal();
    try{
      var logo=await loadBrand();draw(logo);png=await makePng();
      $('reportCardSave').disabled=false;
      $('reportShareStatus').textContent='';
      $('reportCardShare').hidden=!(navigator.share&&navigator.canShare&&navigator.canShare({files:[file()]}));
    }catch(e){png=null;$('reportCardSave').disabled=true;$('reportCardShare').hidden=true;$('reportShareStatus').textContent='Image export is unavailable in this browser. You can still copy the summary below.';}
  }
  async function copy(status){
    try{await navigator.clipboard.writeText(D.text);$(status).textContent='Summary and report link copied.';}
    catch(e){await open();$('reportShareText').focus();$('reportShareText').select();$('reportShareStatus').textContent='Select and copy the summary below.';}
  }
  $('reportCardOpen').onclick=open;
  $('reportSummaryCopy').onclick=function(){copy('reportCopyStatus')};
  $('reportCardCopy').onclick=function(){copy('reportShareStatus')};
  $('reportCardClose').onclick=function(){dialog.close()};
  dialog.addEventListener('click',function(e){if(e.target!==dialog)return;var r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();});
  $('reportCardSave').onclick=function(){
    if(!png)return;var url=URL.createObjectURL(png),a=document.createElement('a');a.href=url;a.download='zaexa-exit-report-'+D.date+'.png';document.body.append(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url)},60000);
    $('reportShareStatus').textContent='PNG ready. If your browser opens the image, use Save Image.';
  };
  $('reportCardShare').onclick=async function(){
    if(!png)return;
    try{await navigator.share({files:[file()],title:'Zaexa Exit Report · '+D.date,text:D.text});}
    catch(e){if(e.name!=='AbortError')$('reportShareStatus').textContent='Sharing is unavailable here. Download the PNG and copy the summary instead.';}
  };
})();`;
