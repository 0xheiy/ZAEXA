import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReportPage } from './report_page.js';

const render = (date, rows) => renderReportPage({date, today:date, firstDate:'2026-09-07', rows, history:[]});
const dataOf = html => JSON.parse(/id="reportData">([\s\S]*?)<\/script>/.exec(html)[1]);

test('Share counts match guarded report rows, including both unknown and failed Solana checks', () => {
  const rows=[
    {chain:'base',v:'sell',checkedAt:'2026-10-22T10:20:00Z'},
    {chain:'base',v:'nosell',checkedAt:'2026-10-22T11:20:00Z'},
    {chain:'base',v:null,checkedAt:'not-a-time'},
    {chain:'solana',v:'sell',checkedAt:'2026-10-22T12:20:00Z'},
    {chain:'solana',v:'nosell',checkedAt:'2026-10-21T23:20:00Z'},
    {chain:'solana',v:null,checkedAt:'2026-10-22T09:20:00Z'},
  ];
  const share=dataOf(render('2026-10-22',rows)).share;
  assert.deepEqual(share.base,{total:3,sell:1,no:1,unknown:1});
  assert.deepEqual(share.solana,{total:3,sell:1,no:1,unknown:1});
  assert.equal(share.latest,'2026-10-22T12:20:00.000Z');
  assert.match(share.text,/not a simulated round trip/);
  assert.match(share.text,/1 sell-back failed, 1 unknown/);
  assert.match(share.text,/https:\/\/zaexa.com\/report\/2026-10-22$/);
});

test('Early reports exclude Solana from share data; missing timestamps stay unknown',()=>{
  const share=dataOf(render('2026-09-21',[{chain:'base',v:null},{chain:'solana',v:'sell'}])).share;
  assert.equal(share.solana,null);
  assert.equal(share.latest,null);
  assert.doesNotMatch(share.text,/Solana/);
  assert.match(share.text,/Check times unavailable/);
});

test('No sharing controls for empty reports; token labels cannot break out of the data island',()=>{
  assert.doesNotMatch(render('2026-10-22',[]),/id="reportCardOpen"/);
  const html=render('2026-10-22',[{chain:'base',v:null,symbol:'</script><img src=x onerror=alert(1)>',checkedAt:'</script>'}]);
  assert.doesNotMatch(html,/<img src=x/);
  assert.equal(dataOf(html).share.base.unknown,1);
  assert.equal(dataOf(html).share.latest,null);
});

test('Sharing adds no embedded artwork or font payload beyond the public report shell',()=>{
  const embeddedAssets=html=>html.match(/data:(?:font|image)\/[^;"\s]+;base64,[A-Za-z0-9+/=]+/g)||[];
  const empty=render('2026-10-22',[]);
  const populated=render('2026-10-22',[{chain:'base',v:'sell'}]);
  assert.ok(embeddedAssets(empty).length>0,'The existing public shell supplies its assets');
  assert.deepEqual(embeddedAssets(populated),embeddedAssets(empty));
});
