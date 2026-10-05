/* Solana wallet on the read-only pairs page; no transaction APIs are exposed. */
(() => {
  const $=id=>document.getElementById(id),isSol=()=>new URL(location.href).searchParams.get('chain')==='solana';
  const chain='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',wallets=[];
  let seq=0,busy=false,account=null,wallet=null,pendingWallet=null,unsubscribe=null,disconnecting=Promise.resolve(),loading=null,provider=null,mobile=false;
  const short=s=>s.length>12?s.slice(0,6)+'…'+s.slice(-4):s;
  // انتقالِ تأییدِ همین تب بین /app و /pairs (دو سندِ جدا): sessionStorage، نه localStorage،
  // با بسته شدنِ تب پاک می‌شود و فقط ۳۰ دقیقه معتبر است. بازیابی فقط connect({silent:true})
  // است و فقط اگر همان آدرسِ تأییدشده برگردد؛ بدون امضای تازه و بدون رویدادِ /ev.
  const SKEY='zaexa.solsession.v1',TTL=30*60*1000;
  function sRead(){try{const r=JSON.parse(sessionStorage.getItem(SKEY)||'null');if(r&&typeof r.name==='string'&&typeof r.address==='string'&&typeof r.t==='number')return r;}catch{}return null;}
  function sWrite(name,address){try{sessionStorage.setItem(SKEY,JSON.stringify({name,address,t:Date.now()}));}catch{}}
  function sClear(){try{sessionStorage.removeItem(SKEY);}catch{}}
  let restoreStarted=false;
  // حالتِ «در انتظارِ بازیابی»: window.__zxSolPend را اسکریپتِ درون‌خطیِ کنارِ #connectBtn می‌گذارد
  const pend=()=>window.__zxSolPend&&!account&&!busy;
  function endPending(){
    if(!window.__zxSolPend)return;
    window.__zxSolPend=null;const b=$('connectBtn');if(b)b.removeAttribute('aria-busy');
    if(!paint())window.zaexaPairsBasePaint?.();
  }
  setTimeout(()=>{
    if(!window.__zxSolPend)return;
    if(restoreStarted){setTimeout(()=>{if(window.__zxSolPend&&!account){sClear();endPending();}},5000);return;}
    sClear();endPending();
  },2500);
  function offFlag(){try{return localStorage.getItem('zaexa.solwallet.off.v1')==='1';}catch{return false;}}
  async function tryRestore(w){
    if(restoreStarted||!isSol()||account||busy)return;
    const rec=sRead();if(!rec||rec.name!==w.name)return;
    if(rec.name==='WalletConnect Solana'||offFlag()||Date.now()-rec.t>TTL){sClear();endPending();return;}
    restoreStarted=true;const id=seq;
    try{
      const result=await w.features['standard:connect'].connect({silent:true});
      if(id!==seq||account||busy)return;
      const a=result?.accounts?.[0];if(!a||a.address!==rec.address)throw Error('restore mismatch');
      wallet=w;account=a;window.__zxSolPend=null;sWrite(w.name,rec.address);subscribe(w);paint();
    }catch{if(id===seq){sClear();endPending();}}
  }
  function restoreAll(){for(const w of wallets)tryRestore(w);}
  function subscribe(w){
    const on=w.features['standard:events']?.on;
    if(on)unsubscribe=w.features['standard:events'].on('change',props=>{
      if(wallet!==w||!Object.hasOwn(props,'accounts'))return;
      const a=props.accounts?.[0];if(!a||a.address!==account.address)disconnect(false);
    });
  }
  function notice(text){$('walletDisconnectNote').textContent=text;$('walletDisconnectNote').hidden=!text;}
  function close(){ $('walletOv').classList.remove('on'); }
  function paint(){
    if(!isSol())return false;
    const b=$('connectBtn');
    if(pend()){b.disabled=false;b.textContent=short(window.__zxSolPend.address);b.className='chip';b.setAttribute('aria-busy','true');$('walletAddr').textContent='—';return true;}
    b.removeAttribute('aria-busy');b.disabled=busy;b.textContent=busy?'Approve in wallet…':account?short(account.address):'Connect wallet';b.className=account?'chip':'chip solid';
    $('walletAddr').textContent=account?short(account.address):'—';
    if(!account){$('walletPop').classList.remove('on');b.setAttribute('aria-expanded','false');}
    return true;
  }
  async function lib(){
    if(window.SolMobile)return window.SolMobile;
    if(!loading)loading=new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='/solana-wallet.bundle.b6eb73e1.js';s.onload=()=>window.SolMobile?resolve(window.SolMobile):reject(Error('Wallet library unavailable'));s.onerror=()=>{loading=null;s.remove();reject(Error('Could not load wallet library'));};document.head.appendChild(s);});
    return loading;
  }
  // بسته‌ی کوچکِ تأیید برای کیف‌پولِ تزریق‌شده؛ بسته‌ی بزرگ فقط برای WalletConnect
  let confirmLoading=null;
  async function confirmLib(){
    if(window.SolConfirm)return window.SolConfirm;
    if(!confirmLoading)confirmLoading=new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='/solana-confirm.bundle.6a6dd398.js';s.onload=()=>window.SolConfirm?resolve(window.SolConfirm):(confirmLoading=null,reject(Error('Wallet confirmation library unavailable')));s.onerror=()=>{confirmLoading=null;s.remove();reject(Error('Could not load the wallet confirmation library'));};document.head.appendChild(s);});
    return confirmLoading;
  }
  function disconnect(callWallet=true){
    sClear();window.__zxSolPend=null;++seq;const old=wallet||pendingWallet;account=null;wallet=null;pendingWallet=null;busy=false;mobile=false;
    try{unsubscribe?.();}catch{}unsubscribe=null;
    if(callWallet){try{localStorage.setItem('zaexa.solwallet.off.v1','1');localStorage.removeItem('zaexa.solwallet.v1');}catch{}
      try{const d=old?.features?.['standard:disconnect'];if(d)disconnecting=Promise.resolve(d.disconnect()).catch(()=>{});else provider?.abortPairingAttempt();}catch{}
    }
    close();paint();
  }
  async function connect(w){
    if(busy)return;const id=++seq;busy=true;pendingWallet=w;paint();
    $('walletOv').classList.add('on');$('walList').textContent='Approve the connection message in your wallet.';$('walNote').textContent='No transaction, network fee or spending permission. Close this window to cancel.';
    notice('');
    try{
      await disconnecting;if(id!==seq)return;
      const result=await w.features['standard:connect'].connect({silent:false});if(id!==seq)return;
      const acc=result?.accounts?.[0];if(!acc)throw Error('No account returned');
      const l=w.name==='WalletConnect Solana'?await lib():await confirmLib();await l.confirmConnection(w,acc,()=>id===seq&&isSol(),location.origin);if(id!==seq)return;
      wallet=w;account=acc;
      try{localStorage.removeItem('zaexa.solwallet.off.v1');}catch{}
      sWrite(w.name,acc.address);subscribe(w);
      close();notice('');
    }catch(e){if(id===seq)notice('Wallet not connected. '+(e?.message||'Approval cancelled.'));}
    finally{if(id===seq){busy=false;pendingWallet=null;close();paint();}}
  }
  function mobileAccount(session,l){
    const ns=session?.namespaces?.solana;
    if(!ns?.methods?.includes('solana_signMessage'))throw Error('Wallet must support Solana message approval');
    const qualified=ns.accounts?.find(a=>a.startsWith(chain+':'));if(!qualified)throw Error('Wallet did not approve Solana mainnet');
    const address=qualified.slice(chain.length+1),publicKey=l.bs58.decode(address);if(publicKey.length!==32)throw Error('Invalid wallet account');
    return {address,publicKey,chains:['solana:mainnet'],features:['solana:signMessage']};
  }
  async function connectMobile(){
    if(busy)return;const id=++seq;busy=true;mobile=true;paint();$('walList').textContent='Preparing connection…';
    try{
      await disconnecting;const l=await lib();if(id!==seq)return;
      if(!provider){
        provider=await l.UniversalProvider.init({projectId:'c1fcdd7d857fb7f0c54788295dfd09fc',metadata:{name:'ZAEXA',description:'Solana wallet connection',url:location.origin,icons:[]}});
        provider.on('display_uri',async uri=>{
          if(!mobile||!isSol())return;
          $('walList').innerHTML='<p>Scan with a compatible Solana wallet.</p><canvas id="pairsSolQr" style="display:block;max-width:100%;margin:auto"></canvas><button class="chip" id="pairsSolCode">Copy connection code</button>';
          await l.QRCode.toCanvas($('pairsSolQr'),uri,{width:256,margin:2});
          $('pairsSolCode').onclick=()=>navigator.clipboard.writeText(uri).then(()=>$('pairsSolCode').textContent='Copied').catch(()=>{});
        });
        const changed=()=>{if(wallet?.name==='WalletConnect Solana'||pendingWallet?.name==='WalletConnect Solana')disconnect(false);};
        for(const e of ['session_delete','accountsChanged','chainChanged','session_update'])provider.on(e,changed);
      }
      if(id!==seq)return;
      if(provider.session)await provider.disconnect();
      await provider.connect({namespaces:{solana:{chains:[chain],methods:['solana_signMessage','solana_signTransaction'],events:['accountsChanged','chainChanged']}}});
      if(id!==seq){if(provider.session)await provider.disconnect();return;}
      const w={name:'WalletConnect Solana',features:{
        'standard:connect':{connect:async()=>({accounts:[mobileAccount(provider.session,l)]})},
        'standard:disconnect':{disconnect:async()=>{if(provider.session)await provider.disconnect();}},
        'solana:signMessage':{signMessage:async({account:acc,message})=>{
          if(mobileAccount(provider.session,l).address!==acc.address)throw Error('Wallet account changed');
          const r=await provider.request({method:'solana_signMessage',params:{pubkey:acc.address,message:l.bs58.encode(message)}},chain);
          if(mobileAccount(provider.session,l).address!==acc.address)throw Error('Wallet account changed');
          return [{signedMessage:message,signature:l.bs58.decode(r?.signature||'')}];
        }}
      }};
      busy=false;mobile=false;await connect(w);
    }catch(e){if(id===seq){busy=false;mobile=false;close();paint();notice('Wallet not connected. '+(e?.message||'Pairing cancelled.'));}}
  }
  function render(){
    if(!isSol()||busy)return;
    $('walletOv').querySelector('h3').firstChild.nodeValue='Connect a Solana wallet';
    const list=$('walList');list.replaceChildren();$('walNote').textContent='Approve a fresh connection message in your wallet. No transaction or network fee.';
    function row(name,kind,go,icon){const b=document.createElement('button');b.type='button';b.className='walRow';
      const img=document.createElement(icon?'img':'span');if(icon){img.src=icon;img.alt='';}else{img.className='walFallback';
        const marks={Phantom:'<svg viewBox="0 0 32 32" width="28" height="28"><path fill="white" d="M7 24C4 20 6 9 14 6c8-3 14 4 13 12-1 7-5 9-8 6-2 3-5 3-6 0-2 2-4 2-6 0Z"/><circle cx="16" cy="14" r="1.5" fill="#9886eb"/><circle cx="23" cy="14" r="1.5" fill="#9886eb"/></svg>',Solflare:'<svg viewBox="0 0 32 32" width="27" height="27" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="16" cy="16" r="6"/><path d="M16 2v5m0 18v5M2 16h5m18 0h5M6 6l4 4m12 12 4 4M6 26l4-4m12-12 4-4"/></svg>',WalletConnect:'<svg viewBox="0 0 32 24" width="29" height="23" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M5 7c6-6 16-6 22 0M2 12l7 7 7-7 7 7 7-7"/></svg>'};
        if(marks[name]){img.innerHTML=marks[name];if(name==='Phantom')img.style.background='#9886eb';if(name==='Solflare'){img.style.background='#ffb229';img.style.color='#171717';}}
        else img.textContent=name[0];
      }b.append(img);
      for(const [cls,text] of [['walName',name],['walKind',kind]]){const span=document.createElement('span');span.className=cls;span.textContent=text;b.append(span);}b.onclick=go;list.append(b);}
    for(const w of wallets)row(w.name,'Installed wallet',()=>connect(w),w.icon);
    const phone=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
    if(phone){for(const [name,base] of [['Phantom','https://phantom.app/ul/browse/'],['Solflare','https://solflare.com/ul/v1/browse/']]){
      if(wallets.some(w=>w.name.toLowerCase().includes(name.toLowerCase())))continue;
      const target=location.origin+'/app#swap?chain=solana';row(name,'Open on this phone ↗',()=>location.assign(base+encodeURIComponent(target)+'?ref='+encodeURIComponent(location.origin)));
    }}
    row('WalletConnect','Connect with QR',connectMobile);$('walletOv').classList.add('on');
  }
  function register(...items){for(const w of items){if(w.chains?.includes('solana:mainnet')&&w.features?.['standard:connect']&&w.features?.['solana:signMessage']&&!wallets.includes(w)){wallets.push(w);tryRestore(w);}}if(isSol()&&$('walletOv').classList.contains('on')&&!busy)render();}
  window.addEventListener('wallet-standard:register-wallet',e=>{try{e.detail({register});}catch{}});
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready',{detail:{register}}));
  function capture(id,fn){$(id).addEventListener('click',e=>{if(!isSol())return;e.stopImmediatePropagation();fn(e);},true);}
  capture('connectBtn',()=>{if(pend())return;if(account){const pop=$('walletPop');const open=pop.classList.toggle('on');$('connectBtn').setAttribute('aria-expanded',String(open));}else render();});
  capture('copyAddrBtn',()=>{if(account)navigator.clipboard.writeText(account.address).catch(()=>{});});
  capture('disconnectBtn',()=>{disconnect();notice('Disconnected. Connecting again requires fresh approval in your wallet.');});
  capture('walClose',()=>{if(busy)disconnect();else close();});
  $('walletOv').addEventListener('click',e=>{if(isSol()&&e.target===$('walletOv')){e.stopImmediatePropagation();if(busy)disconnect();else close();}},true);
  document.addEventListener('keydown',e=>{if(isSol()&&e.key==='Escape'){if(busy)disconnect();else close();$('walletPop').classList.remove('on');}},true);
  window.addEventListener('zaexa:pairs-chain',()=>{if(!isSol()&&window.__zxSolPend){window.__zxSolPend=null;$('connectBtn').removeAttribute('aria-busy');}restoreAll();if(busy)disconnect();close();notice('');$('walletPop').classList.remove('on');$('connectBtn').disabled=false;if(!paint()){$('walletOv').querySelector('h3').firstChild.nodeValue='Connect a wallet';window.zaexaPairsBasePaint?.();}});
  window.zaexaPairsSolana={paint};paint();
})();
