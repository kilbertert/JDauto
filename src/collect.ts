import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadConfig } from './config.js';
import { collectProducts, parseSkuInput } from './product-collector.js';

interface Args {
  input?: string;
  output: string;
  profiles?: string[];
  accounts?: number;
  retries: number;
  delayMs: number;
  resume: boolean;
}

function usage(): string {
  return [
    '用法:',
    '  node dist/collect.js --input skus.txt --output data/products',
    '  node dist/collect.js --input skus.json --profiles 账号1,账号2',
    '',
    '参数:',
    '  --input <file>       SKU 文本/JSON 文件；省略时从 stdin 读取',
    '  --output <dir>       输出目录（默认 data/products）',
    '  --profiles <names>   OpenCLI profile，逗号分隔；默认读取 config/accounts.json',
    '  --accounts <n>       使用配置文件中的前 N 个 profile',
    '  --retries <n>        单 SKU 重试次数（默认 3）',
    '  --delay-ms <n>       每个 profile 两次请求间隔（默认 500ms，另加随机抖动）',
    '  --no-resume          不跳过输出目录中已有的有效 SKU 文件',
  ].join('\n');
}

function integer(value: string, name: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} 必须是大于等于 ${minimum} 的整数`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    output: path.resolve('data', 'products'),
    retries: 3,
    delayMs: 500,
    resume: true,
  };

  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    switch (value) {
      case '--input': args.input = argv[++index]; break;
      case '--output': args.output = path.resolve(argv[++index]); break;
      case '--profiles':
        args.profiles = argv[++index].split(',').map((item) => item.trim()).filter(Boolean);
        break;
      case '--accounts': args.accounts = integer(argv[++index], '--accounts', 1); break;
      case '--retries': args.retries = integer(argv[++index], '--retries', 0); break;
      case '--delay-ms': args.delayMs = integer(argv[++index], '--delay-ms', 0); break;
      case '--no-resume': args.resume = false; break;
      case '--help':
      case '-h':
        console.log(usage());
        process.exit(0);
      default: throw new Error(`未知参数: ${value}`);
    }
  }
  return args;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = args.input
    ? await fs.readFile(path.resolve(args.input), 'utf8')
    : await readStdin();
  const skus = parseSkuInput(raw);
  if (skus.length === 0) throw new Error('输入中没有 SKU');

  let profiles = args.profiles;
  if (!profiles) {
    profiles = loadConfig().accounts.map((account) => account.profile);
    if (args.accounts) profiles = profiles.slice(0, args.accounts);
  }
  if (profiles.length === 0) throw new Error('没有可用的 OpenCLI profile');

  console.log(`开始采集 ${skus.length} 个 SKU，profiles: ${profiles.join(', ')}`);
  const summary = await collectProducts(skus, {
    outputDir: args.output,
    profiles,
    retries: args.retries,
    delayMs: args.delayMs,
    resume: args.resume,
    onProgress: ({ completed, failed, skipped, total, sku, profile }) => {
      console.log(`[${completed + failed + skipped}/${total}] ${sku} @ ${profile} | 成功 ${completed} / 失败 ${failed} / 跳过 ${skipped}`);
    },
  });
  console.log(`采集结束：成功 ${summary.completed}，失败 ${summary.failed}，跳过 ${summary.skipped}，总计 ${summary.total}`);
  if (summary.failed > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`Fatal: ${String(error)}`);
  process.exitCode = 1;
});
