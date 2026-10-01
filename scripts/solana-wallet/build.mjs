import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const result=await build({entryPoints:[new URL('./entry.js',import.meta.url).pathname],bundle:true,format:'iife',globalName:'SolMobile',minify:true,target:'es2020',legalComments:'none',write:false});
const bytes=result.outputFiles[0].contents;
const hash=createHash('sha256').update(bytes).digest('hex').slice(0,8);
writeFileSync(new URL('../../web/solana-wallet.bundle.'+hash+'.js',import.meta.url),bytes);
console.log('solana-wallet.bundle.'+hash+'.js');
