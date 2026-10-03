import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
// دو بسته با همان تنظیمات و همان نام‌گذاریِ هش: بزرگ (WalletConnect) و کوچکِ تأیید اتصال (کیف‌پول تزریق‌شده)
const targets=[['./entry.js','SolMobile','solana-wallet'],['./confirm-entry.js','SolConfirm','solana-confirm']];
for(const [entry,globalName,prefix] of targets){
  const result=await build({entryPoints:[new URL(entry,import.meta.url).pathname],bundle:true,format:'iife',globalName,minify:true,target:'es2020',legalComments:'none',write:false});
  const bytes=result.outputFiles[0].contents;
  const hash=createHash('sha256').update(bytes).digest('hex').slice(0,8);
  writeFileSync(new URL('../../web/'+prefix+'.bundle.'+hash+'.js',import.meta.url),bytes);
  console.log(prefix+'.bundle.'+hash+'.js',bytes.length);
}
