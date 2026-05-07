/**
 * JDauto — 京东抢购工具
 * 主入口 CLI
 *
 * 使用方式:
 *   jdauto --sku 100218876132 --time "2026-05-07T20:00:00" --password 263414
 *   jdauto --config config/tasks.json --password 263414
 *   jdauto --sku 100218876132 --time "2026-05-07T20:00:00" --password 263414 --manual  (手动模式：不尝试启动浏览器，使用已运行的浏览器)
 */

import { FlashSaleState } from './state-machine.js';
import { loadConfig, getPaymentPassword } from './config.js';
import { InstanceManager } from './instance-manager.js';
import { FlashSaleScheduler } from './scheduler.js';
import { FlashSaleInstance } from './instance.js';
import { logger } from './utils/logger.js';
import type { ChromeAccount, FlashSaleTask } from './config.js';

interface CliArgs {
  sku?: string;
  time?: string;
  password?: string;
  config?: string;
  maxRetries?: number;
  prepareAhead?: number;
  /** 手动模式：不启动浏览器，使用已运行的浏览器（Browser Bridge 已连接） */
  manual?: boolean;
}

function parseArgs(): CliArgs {
  const args: CliArgs = {};
  const raw = process.argv.slice(2);

  for (let i = 0; i < raw.length; i++) {
    switch (raw[i]) {
      case '--sku': args.sku = raw[++i]; break;
      case '--time': args.time = raw[++i]; break;
      case '--password': args.password = raw[++i]; break;
      case '--config': args.config = raw[++i]; break;
      case '--max-retries': args.maxRetries = parseInt(raw[++i], 10); break;
      case '--prepare-ahead': args.prepareAhead = parseInt(raw[++i], 10); break;
      case '--manual': args.manual = true; break;
    }
  }

  return args;
}

async function main(): Promise<void> {
  console.log('\n=== JDauto 京东抢购工具 ===\n');

  const args = parseArgs();
  const password = args.password ?? getPaymentPassword();
  const prepareAheadMs = (args.prepareAhead ?? 45) * 1000;

  // 加载配置（优先用命令行 --sku/--time，否则用配置文件）
  let config: { accounts: ChromeAccount[]; tasks: FlashSaleTask[] };
  if (args.config) {
    const mod = await import(`file://${args.config}`);
    config = mod.default as { accounts: ChromeAccount[]; tasks: FlashSaleTask[] };
  } else {
    config = loadConfig();
  }

  // 如果用 --sku/--time 命令行参数覆盖 tasks
  if (args.sku && args.time) {
    const tasks: FlashSaleTask[] = [{
      sku: args.sku,
      flashSaleTime: args.time,
      maxRetries: args.maxRetries ?? 3,
    }];
    config = { accounts: config.accounts, tasks };
  }

  logger.info('Main', `加载到 ${config.accounts.length} 个账号，${config.tasks.length} 个任务`);

  const manager = new InstanceManager();
  const scheduler = new FlashSaleScheduler();

  // 注册 Ctrl+C 退出
  process.on('SIGINT', async () => {
    logger.warn('Main', '收到中断信号，正在关闭...');
    scheduler.cancelAll();
    await manager.stopAll();
    process.exit(0);
  });

  if (args.manual) {
    // ── 手动模式（不启动浏览器，使用已运行的 Browser Bridge）─────────────
    logger.info('Main', '手动模式：跳过浏览器启动，使用已连接的浏览器');

    // 取第一个账号作为执行器（单账号测试）
    const account = config.accounts[0];

    for (const task of config.tasks) {
      // 同一任务复用同一个实例，避免 PREPARE/EXECUTE 状态断裂
      const instance = new FlashSaleInstance(
        account.name, account.profile,
        task.sku, task.flashSaleTime,
        task.maxRetries ?? 3, password
      );
      let preparePromise: Promise<void> | null = null;

      scheduler.schedule(
        task,
        async () => {
          preparePromise = instance.prepare();
          await preparePromise;
        },
        async () => {
          // EXECUTE 必须等待 PREPARE 完成，保证流程与手工串行一致
          if (preparePromise) {
            await preparePromise;
          }
          await instance.execute();
          if (instance.getState() === FlashSaleState.PAYMENT) {
            await instance.pay();
          }
        },
        { prepareAheadMs }
      );
    }

    logger.info('Main', '所有任务已注册，等待触发...');
  } else {
    // ── 自动模式：启动所有 Chrome 实例 ─────────────────────────────────
    logger.info('Main', '自动模式：启动所有 Chrome 实例...');
    await manager.startAll(config.accounts);

    for (const account of config.accounts) {
      for (const task of config.tasks) {
        // 同一账号+任务复用单实例，避免 prepare/execute 各自 new 导致状态丢失
        const instance = new FlashSaleInstance(
          account.name, account.profile,
          task.sku, task.flashSaleTime,
          task.maxRetries ?? 3, password
        );
        let preparePromise: Promise<void> | null = null;

        scheduler.schedule(
          task,
          async () => {
            preparePromise = instance.prepare();
            await preparePromise;
          },
          async () => {
            // EXECUTE 必须等待 PREPARE 完成，保证流程与手工串行一致
            if (preparePromise) {
              await preparePromise;
            }
            await instance.execute();
            if (instance.getState() === FlashSaleState.PAYMENT) {
              await instance.pay();
            }
          },
          { prepareAheadMs }
        );
      }
    }

    logger.info('Main', '所有任务已注册，等待触发...');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
