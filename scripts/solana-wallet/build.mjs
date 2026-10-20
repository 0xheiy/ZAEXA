import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
// دو بسته با همان تنظیمات و همان نام‌گذاریِ هش: بزرگ (WalletConnect) و کوچکِ تأیید اتصال (کیف‌پول تزریق‌شده)
const targets=[['./entry.js','SolMobile','solana-wallet'],['./confirm-entry.js','SolConfirm','solana-confirm'],['./intent.js','SolIntent','solana-intent']];
for(const [entry,globalName,prefix] of targets){
  const result=await build({entryPoints:[fileURLToPath(new URL(entry,import.meta.url))],bundle:true,format:'iife',globalName,minify:true,target:'es2020',legalComments:'none',write:false});
  const bytes=result.outputFiles[0].contents;
  const hash=createHash('sha256').update(bytes).digest('hex').slice(0,8);
  writeFileSync(new URL('../../web/'+prefix+'.bundle.'+hash+'.js',import.meta.url),bytes);
  if(prefix==='solana-intent'){
    const app=new URL('../../web/index.html',import.meta.url);
    writeFileSync(app,readFileSync(app,'utf8').replace(/solana-intent\.bundle\.[a-f0-9]{8}\.js/g,prefix+'.bundle.'+hash+'.js'));
  }
  console.log(prefix+'.bundle.'+hash+'.js',bytes.length);
}
