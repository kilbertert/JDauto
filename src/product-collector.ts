import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { openAndCaptureNetwork } from './commands/opencli-wrap.js';

const PRODUCT_API_MARKER = 'pc_detailpage_wareBusiness';

export interface ProductRecord {
  商品ID: string;
  商品名称: string;
  商品平台: '京东';
  商品链接: string;
  采集时间: string;
  详情数据: Record<string, unknown>;
}

interface NetworkEntry {
  url?: unknown;
  status?: unknown;
  timestamp?: unknown;
  body?: unknown;
}

interface NetworkEnvelope {
  entries?: unknown;
}

export interface CollectOptions {
  outputDir: string;
  profiles: string[];
  retries: number;
  delayMs: number;
  resume: boolean;
  timeoutMs?: number;
  onProgress?: (progress: CollectProgress) => void;
}

export interface CollectProgress {
  completed: number;
  failed: number;
  skipped: number;
  total: number;
  sku: string;
  profile: string;
}

export interface CollectSummary {
  completed: number;
  failed: number;
  skipped: number;
  total: number;
}

export function normalizeSku(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (/^\d{5,20}$/.test(text)) return text;
  const itemUrl = text.match(/^https?:\/\/item\.jd\.com\/(\d{5,20})\.html(?:[?#].*)?$/i);
  return itemUrl?.[1] ?? null;
}

export function parseSkuInput(raw: string): string[] {
  let values: unknown[];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const firstLine = trimmed.split(/\r?\n/, 1)[0];
  if (firstLine.includes(',') && /(?:^|,)id(?:,|$)/i.test(firstLine)) {
    const rows = parseCsv(trimmed);
    const headers = rows.shift()?.map((value) => value.trim().toLowerCase()) ?? [];
    const idIndex = headers.indexOf('id');
    const platformIndex = headers.indexOf('platform');
    if (idIndex < 0) throw new Error('CSV 输入缺少 id 列');
    values = rows
      .filter((row) => platformIndex < 0 || row[platformIndex]?.trim().toLowerCase() === 'jd')
      .map((row) => row[idIndex]);
  } else {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        values = parsed;
      } else if (parsed && typeof parsed === 'object') {
        const object = parsed as Record<string, unknown>;
        const candidate = object.skus ?? object.skuIds ?? object.items;
        if (!Array.isArray(candidate)) {
          throw new Error('JSON 输入必须是数组，或包含 skus/skuIds/items 数组');
        }
        values = candidate;
      } else {
        values = [parsed];
      }
    } catch (error) {
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) throw error;
      values = trimmed.split(/[\s,]+/);
    }
  }

  const skus = values.map(normalizeSku);
  const invalid = values.filter((_, index) => skus[index] === null);
  if (invalid.length > 0) {
    throw new Error(`发现非法 SKU: ${invalid.slice(0, 5).join(', ')}`);
  }
  return [...new Set(skus as string[])];
}

function parseCsv(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === '"') {
      if (quoted && raw[index + 1] === '"') {
        field += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && raw[index + 1] === '\n') index++;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((value) => value.length > 0)) rows.push(row);
  if (quoted) throw new Error('CSV 存在未闭合的引号');
  return rows;
}

function isDetails(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return Boolean(object.pageConfigVO || object.productAttributeVO || object.wareInfoReadMap);
}

function findDetails(value: unknown, depth = 0): Record<string, unknown> | null {
  if (isDetails(value)) return value;
  if (!value || typeof value !== 'object' || depth >= 3) return null;

  const object = value as Record<string, unknown>;
  for (const key of ['data', 'result', 'body']) {
    const found = findDetails(object[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export function extractProductDetails(capture: unknown): Record<string, unknown> {
  const entries = (capture as NetworkEnvelope | null)?.entries;
  if (!Array.isArray(entries)) throw new Error('网络捕获中没有 entries 数组');

  const candidates = (entries as NetworkEntry[])
    .filter((entry) =>
      typeof entry.url === 'string'
      && entry.url.includes(PRODUCT_API_MARKER)
      && (entry.status === 200 || entry.status === undefined)
    )
    .sort((a, b) => parseTimestamp(b.timestamp) - parseTimestamp(a.timestamp));

  for (const entry of candidates) {
    let body = entry.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        continue;
      }
    }
    const details = findDetails(body);
    if (details) return details;
  }
  throw new Error(`未捕获到 ${PRODUCT_API_MARKER} 的有效商品响应`);
}

function productTitle(details: Record<string, unknown>, fallback: string): string {
  const head = details.skuHeadVO as Record<string, unknown> | undefined;
  const ware = details.wareInfoReadMap as Record<string, unknown> | undefined;
  const title = head?.skuTitle ?? ware?.sku_name ?? ware?.product_name;
  return typeof title === 'string' && title.trim() ? title.trim() : fallback;
}

export function buildProductRecord(
  sku: string,
  details: Record<string, unknown>,
  collectedAt = new Date()
): ProductRecord {
  return {
    商品ID: sku,
    商品名称: productTitle(details, `京东商品 ${sku}`),
    商品平台: '京东',
    商品链接: `https://item.jd.com/${sku}.html`,
    采集时间: collectedAt.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
    }),
    详情数据: details,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

async function isCompleted(filePath: string, sku: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as Partial<ProductRecord>;
    return parsed.商品ID === sku && Boolean(parsed.详情数据);
  } catch {
    return false;
  }
}

export async function collectProducts(
  skus: string[],
  options: CollectOptions
): Promise<CollectSummary> {
  if (options.profiles.length === 0) throw new Error('至少需要一个 OpenCLI profile');
  await fs.mkdir(options.outputDir, { recursive: true });

  const summary: CollectSummary = { completed: 0, failed: 0, skipped: 0, total: skus.length };
  const queue = [...skus];
  let errorWrite = Promise.resolve();
  const errorPath = path.join(options.outputDir, 'errors.jsonl');

  const report = (sku: string, profile: string): void => {
    options.onProgress?.({ ...summary, sku, profile });
  };

  const worker = async (profile: string): Promise<void> => {
    while (queue.length > 0) {
      const sku = queue.shift();
      if (!sku) return;
      const outputPath = path.join(options.outputDir, `${sku}.json`);

      if (options.resume && await isCompleted(outputPath, sku)) {
        summary.skipped++;
        report(sku, profile);
        continue;
      }

      let lastError: unknown;
      for (let attempt = 0; attempt <= options.retries; attempt++) {
        try {
          const capture = await openAndCaptureNetwork(
            profile,
            `https://item.jd.com/${sku}.html`,
            options.timeoutMs
          );
          const details = extractProductDetails(capture);
          await writeJsonAtomic(outputPath, buildProductRecord(sku, details));
          summary.completed++;
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < options.retries) {
            await sleep(Math.min(30_000, 1_000 * (2 ** attempt)) + Math.floor(Math.random() * 500));
          }
        }
      }

      if (lastError !== undefined) {
        summary.failed++;
        const line = JSON.stringify({
          sku,
          profile,
          time: new Date().toISOString(),
          error: String(lastError),
        });
        errorWrite = errorWrite.then(() => fs.appendFile(errorPath, `${line}\n`, 'utf8'));
        await errorWrite;
      }

      report(sku, profile);
      if (options.delayMs > 0) {
        await sleep(options.delayMs + Math.floor(Math.random() * Math.max(1, options.delayMs / 2)));
      }
    }
  };

  await Promise.all(options.profiles.map(worker));
  return summary;
}
