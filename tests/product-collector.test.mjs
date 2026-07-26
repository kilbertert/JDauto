import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildProductRecord,
  collectProducts,
  extractProductDetails,
  isProductRecordForSku,
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

test('parseSkuInput reads JSON arrays and object containers', () => {
  assert.deepEqual(
    parseSkuInput('{"skus":["100102037778","https://item.jd.com/100221470915.html"]}'),
    ['100102037778', '100221470915']
  );
});

test('extractProductDetails selects the JD ware business response', () => {
  const details = {
    pageConfigVO: { skuid: 10023749565113 },
    skuHeadVO: { skuTitle: '测试商品' },
  };
  const actual = extractProductDetails(
    {
      entries: [
        { url: 'https://api.m.jd.com/other', status: 200, body: {} },
        {
          url: 'https://api.m.jd.com/client.action?functionId=pc_detailpage_wareBusiness',
          status: 200,
          timestamp: '2026-07-26T05:00:00.000Z',
          body: { data: details },
        },
      ],
    },
    '10023749565113'
  );
  assert.deepEqual(actual, details);
});

test('extractProductDetails skips a newer response for another SKU', () => {
  const expected = {
    pageConfigVO: { skuid: '10023749565113' },
    skuHeadVO: { skuTitle: '目标商品' },
  };
  const stale = {
    pageConfigVO: { skuid: 100218876132 },
    skuHeadVO: { skuTitle: '旧商品' },
  };

  const actual = extractProductDetails(
    {
      entries: [
        {
          url: 'https://api.m.jd.com/client.action?functionId=pc_detailpage_wareBusiness',
          status: 200,
          timestamp: '2026-07-26T05:00:01.000Z',
          body: { data: stale },
        },
        {
          url: 'https://api.m.jd.com/client.action?functionId=pc_detailpage_wareBusiness',
          status: 200,
          timestamp: '2026-07-26T05:00:00.000Z',
          body: { data: expected },
        },
      ],
    },
    '10023749565113'
  );

  assert.deepEqual(actual, expected);
});

test('extractProductDetails fails closed when only another SKU is captured', () => {
  assert.throws(
    () => extractProductDetails(
      {
        entries: [{
          url: 'https://api.m.jd.com/client.action?functionId=pc_detailpage_wareBusiness',
          status: 200,
          body: { data: { pageConfigVO: { skuid: 100218876132 } } },
        }],
      },
      '10023749565113'
    ),
    /目标 SKU 10023749565113.*其他 SKU: 100218876132/
  );
});

test('buildProductRecord matches the requested top-level shape', () => {
  const record = buildProductRecord(
    '10023749565113',
    { pageConfigVO: { skuid: 10023749565113 }, skuHeadVO: { skuTitle: '测试商品' } },
    new Date('2026-07-26T05:21:28.000Z')
  );
  assert.deepEqual(Object.keys(record), ['商品ID', '商品名称', '商品平台', '商品链接', '采集时间', '详情数据']);
  assert.equal(record.商品名称, '测试商品');
  assert.equal(record.商品平台, '京东');
  assert.equal(isProductRecordForSku(record, '10023749565113'), true);
});

test('the provided sample can be used as a captured response body', async () => {
  const sample = JSON.parse(
    await readFile(new URL('../id采集商品信息.json', import.meta.url), 'utf8')
  );
  const details = extractProductDetails(
    {
      entries: [{
        url: 'https://api.m.jd.com/client.action?functionId=pc_detailpage_wareBusiness',
        status: 200,
        body: sample.详情数据,
      }],
    },
    String(sample.商品ID)
  );
  assert.equal(details.pageConfigVO.skuid, 10023749565113);
  assert.equal(details.skuHeadVO.skuTitle.length > 0, true);
});

test('collectProducts uses the Product Capture Adapter and re-collects mismatched resume files', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'jdauto-collector-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));

  const sku = '10023749565113';
  let captureCalls = 0;
  const options = {
    outputDir,
    profiles: ['TestProfile'],
    retries: 0,
    delayMs: 0,
    resume: true,
    captureProductPage: async () => {
      captureCalls++;
      return {
        entries: [{
          url: 'https://api.m.jd.com/client.action?functionId=pc_detailpage_wareBusiness',
          status: 200,
          body: {
            data: {
              pageConfigVO: { skuid: Number(sku) },
              skuHeadVO: { skuTitle: '目标商品' },
            },
          },
        }],
      };
    },
  };

  assert.deepEqual(
    await collectProducts([sku], options),
    { completed: 1, failed: 0, skipped: 0, total: 1 }
  );
  assert.equal(captureCalls, 1);

  assert.deepEqual(
    await collectProducts([sku], options),
    { completed: 0, failed: 0, skipped: 1, total: 1 }
  );
  assert.equal(captureCalls, 1);

  const outputPath = join(outputDir, `${sku}.json`);
  const mismatched = buildProductRecord(
    sku,
    { pageConfigVO: { skuid: 100218876132 }, skuHeadVO: { skuTitle: '错误商品' } }
  );
  await writeFile(outputPath, `${JSON.stringify(mismatched)}\n`, 'utf8');

  assert.deepEqual(
    await collectProducts([sku], options),
    { completed: 1, failed: 0, skipped: 0, total: 1 }
  );
  assert.equal(captureCalls, 2);

  const saved = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(isProductRecordForSku(saved, sku), true);
});
