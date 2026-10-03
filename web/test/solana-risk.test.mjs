import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const ctx=vm.createContext({BigInt,Number,Array,String,Math,SOL_MINT_RE:/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,SOL_TOKEN_PROGRAMS:['legacy','2022'],shortAddr:x=>x.slice(0,6),solFormatUnits:x=>String(x)});
for(const name of ['verdictOf','solSafetyReport']){const start=html.indexOf('function '+name+'('),end=html.indexOf('\n}',start)+2;vm.runInContext(html.slice(start,end),ctx);}
const address='11111111111111111111111111111111';
const clean={mintAuthority:null,freezeAuthority:null,supply:'1000000',decimals:6};
test('active mint/freeze authorities add risk; revoked authorities are checked clear',()=>{
 const a=ctx.solSafetyReport(clean,'legacy',[{amount:'100000'}],100),b=ctx.solSafetyReport({...clean,mintAuthority:address,freezeAuthority:address},'legacy',[{amount:'100000'}],100);
 assert.equal(a.score,0);assert.equal(a.findings.filter(f=>f.level==='ok').length,4);assert.equal(b.score,24);assert.equal(b.findings.filter(f=>f.level==='high').length,2);
});
test('failed largest-account data stays unknown rather than clear',()=>{
 const r=ctx.solSafetyReport(clean,'legacy',null,100);assert.equal(r.unknown,1);assert.equal(r.verdict.txt,'Checks incomplete');assert.equal(r.findings.find(f=>f.title.startsWith('Largest')).level,'info');
});
test('malformed or impossible concentration data never becomes a clean result',()=>{
 for(const data of [[{amount:'1000001'}],[{amount:'bad'}],Array(21).fill({amount:'1'})]){const r=ctx.solSafetyReport(clean,'legacy',data,100);assert.equal(r.findings.find(f=>f.title.startsWith('Largest')).level,'info');}
});
test('transfer fee follows current epoch and mutable authority remains a separate risk',()=>{
 const info={...clean,extensions:[{extension:'transferFeeConfig',state:{transferFeeConfigAuthority:address,olderTransferFee:{epoch:0,transferFeeBasisPoints:0,maximumFee:'0'},newerTransferFee:{epoch:101,transferFeeBasisPoints:600,maximumFee:'100'}}}]};
 const before=ctx.solSafetyReport(info,'2022',[{amount:'100000'}],100),after=ctx.solSafetyReport(info,'2022',[{amount:'100000'}],101);
 assert.equal(before.findings.find(f=>f.title==='Current transfer fee').level,'ok');assert.match(after.findings.find(f=>f.title==='Current transfer fee').detail,/6.00%/);assert.ok(after.score>before.score);assert.equal(after.findings.find(f=>f.title==='Transfer fee authority').level,'high');
 assert.equal(ctx.solSafetyReport(info,'2022',null,null).findings.find(f=>f.title==='Current transfer fee').level,'info');
});
test('seizure/transfer restrictions add risk; unreviewed extension effects remain unknown',()=>{
 const r=ctx.solSafetyReport({...clean,extensions:[{extension:'permanentDelegate',state:{delegate:address}},{extension:'nonTransferable'},{extension:'transferHook',state:{programId:address}}]},'2022',[{amount:'900000'}],100);
 assert.ok(r.score>=50);assert.equal(r.findings.filter(f=>f.level==='critical').length,2);assert.equal(r.findings.find(f=>f.title==='Transfer hook').level,'info');
});
test('all unknown facts never produce a numeric zero or a green verdict',()=>{
 const r=ctx.solSafetyReport({},'2022',null,null);assert.equal(r.score,null);assert.equal(r.verdict.tone,'warn');assert.equal(r.findings.filter(f=>f.level==='ok').length,0);
});
test('any unknown check can never yield a positive verdict, whatever the score',()=>{
 // Medium finding (score 5, below the "acceptable" bar) plus an unreadable largest-accounts check.
 const info={...clean,extensions:[{extension:'transferFeeConfig',state:{transferFeeConfigAuthority:null,olderTransferFee:{epoch:0,transferFeeBasisPoints:100,maximumFee:'0'},newerTransferFee:{epoch:0,transferFeeBasisPoints:100,maximumFee:'0'}}}]};
 const r=ctx.solSafetyReport(info,'2022',null,100);
 assert.ok(r.unknown>=1&&r.score>0);assert.equal(r.verdict.txt,'Checks incomplete');assert.equal(r.verdict.tone,'warn');
 assert.equal(ctx.solSafetyReport(clean,'legacy',[{amount:'100000'}],100).verdict.tone,'pos');
});
test('empty largest-accounts list with supply is unknown, not 0.00%',()=>{
 const r=ctx.solSafetyReport(clean,'legacy',[],100);
 const f=r.findings.find(x=>x.title.startsWith('Largest'));
 assert.equal(f.level,'info');assert.ok(!/0\.00%/.test(f.detail));assert.equal(r.verdict.txt,'Checks incomplete');
});
test('a scheduled higher transfer fee is flagged with its epoch',()=>{
 const info={...clean,extensions:[{extension:'transferFeeConfig',state:{transferFeeConfigAuthority:null,olderTransferFee:{epoch:0,transferFeeBasisPoints:0,maximumFee:'0'},newerTransferFee:{epoch:105,transferFeeBasisPoints:250,maximumFee:'9'}}}]};
 const r=ctx.solSafetyReport(info,'2022',[{amount:'100000'}],100);
 const f=r.findings.find(x=>/rises/.test(x.title+x.detail));
 assert.ok(f);assert.equal(f.level,'medium');assert.match(f.detail,/Transfer fee rises to 2\.50% at epoch 105/);
 // already in effect or lower: no warning
 assert.ok(!ctx.solSafetyReport(info,'2022',[{amount:'100000'}],105).findings.some(x=>/rises/.test(x.title)));
 const lower={...info,extensions:[{extension:'transferFeeConfig',state:{...info.extensions[0].state,olderTransferFee:{epoch:0,transferFeeBasisPoints:900,maximumFee:'0'}}}]};
 assert.ok(!ctx.solSafetyReport(lower,'2022',[{amount:'100000'}],100).findings.some(x=>/rises/.test(x.title)));
});
