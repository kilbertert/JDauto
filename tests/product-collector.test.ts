import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  buildProductRecord,
  extractProductDetails,
  parseSkuInput,
} from '../dist/product-collector.js';

test('parseSkuInput accepts text and removes duplicates', () => {
  assert.deepEqual(
    parseSkuInput('10023749565113\nhttps://item.jd.com/10023749565113.html\n100218876132'),
    ['10023749565113', '100218876132']
  );
});

test('parseSkuInput reads the id column and filters CSV to JD rows', () => {
  const csv = [
    '_id,id,platform,state,time',
    'a,1044666675527,tb,2,2026-07-26 18:36:47',
    'b,100102037778,jd,2,2026-07-26 15:58:08',
    'c,"100221470915",jd,2,2026-07-26 15:58:34',
  ].join('\n');
  assert.deepEqual(parseSkuInput(csv), ['100102037778', '100221470915']);
});

test('extractProductDetails selects the JD ware business response', () => {
  const details = {
    pageConfigVO: { skuid: 10023749565113 },
    skuHeadVO: { skuTitle: '测试商品' },
  };
  const actual = extractProductDetails({
    entries: [
      { url: 'https://api.m.jd.com/other', status: 200, body: {} },
      {
        url: 'https://api.m.jd.com/client.action?functionId=pc_detailpage_wareBusiness',
        status: 200,
        timestamp: '2026-07-26T05:00:00.000Z',
        body: { data: details },
      },
    ],
  });
  assert.deepEqual(actual, details);
});

test('buildProductRecord matches the requested top-level shape', () => {
  const record = buildProductRecord(
    '10023749565113',
    { pageConfigVO: {}, skuHeadVO: { skuTitle: '测试商品' } },
    new Date('2026-07-26T05:21:28.000Z')
  );
  assert.deepEqual(Object.keys(record), ['商品ID', '商品名称', '商品平台', '商品链接', '采集时间', '详情数据']);
  assert.equal(record.商品名称, '测试商品');
  assert.equal(record.商品平台, '京东');
});

test('the provided sample can be used as a captured response body', async () => {
  const sample = JSON.parse(
    await readFile(new URL('../id采集商品信息.json', import.meta.url), 'utf8')
  );
  const details = extractProductDetails({
    entries: [{
      url: 'https://api.m.jd.com/client.action?functionId=pc_detailpage_wareBusiness',
      status: 200,
      body: sample.详情数据,
    }],
  });
  assert.equal(details.pageConfigVO.skuid, 10023749565113);
  assert.equal(details.skuHeadVO.skuTitle.length > 0, true);
});
