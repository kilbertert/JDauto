/**
 * Chrome 实例管理器
 * - 负责启动/关闭多个 Chrome 实例（每个对应一个账号 profile）
 * - 通过 child_process 启动 chrome.exe，传入 --profile-directory + --remote-debugging-port
 * - 验证 Browser Bridge 连接
 */

import { spawn, ChildProcess } from 'node:child_process';
import { logger } from './utils/logger.js';
import * as opencli from './commands/opencli-wrap.js';
import type { ChromeAccount } from './config.js';

const DEFAULT_CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export interface ChromeInstance {
  account: ChromeAccount;
  process: ChildProcess;
  cdpPort: number;
}

/**
 * 启动一个 Chrome 实例
 */
function launchChrome(account: ChromeAccount): ChildProcess {
  const chromePath = account.chromePath ?? DEFAULT_CHROME_PATH;
  const port = account.cdpPort ?? 9221;

  const args = [
    `--profile-directory=${account.profile}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
  ];

  logger.info(account.name, `启动 Chrome (profile=${account.profile}, port=${port})...`);
  return spawn(chromePath, args, {
    detached: false,
    stdio: 'ignore',
    shell: true,
  });
}

export class InstanceManager {
  private instances = new Map<string, ChromeInstance>();

  /**
   * 启动所有账号的 Chrome 实例
   */
  async startAll(accounts: ChromeAccount[]): Promise<void> {
    logger.info('Manager', `准备启动 ${accounts.length} 个 Chrome 实例...`);

    for (const account of accounts) {
      const proc = launchChrome(account);
      const instance: ChromeInstance = {
        account,
        process: proc,
        cdpPort: account.cdpPort ?? 9221,
      };
      this.instances.set(account.profile, instance);

      proc.on('error', (err) => {
        logger.error(account.name, `Chrome 进程错误: ${err}`);
      });

      proc.on('exit', (code) => {
        logger.warn(account.name, `Chrome 进程退出，code=${code}`);
      });
    }

    // 等待 Chrome 启动完成
    logger.info('Manager', '等待 Browser Bridge 连接...');
    await this.waitForAllProfiles(accounts);
    logger.success('Manager', '所有 Chrome 实例已就绪');
  }

  /**
   * 等待所有 profile 的 Browser Bridge 连接
   */
  private async waitForAllProfiles(accounts: ChromeAccount[], timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    for (const account of accounts) {
      while (Date.now() < deadline) {
        const ok = await opencli.pingProfile(account.profile);
        if (ok) {
          logger.success(account.name, 'Browser Bridge 已连接');
          break;
        }
        await sleep(1000);
      }
    }
  }

  /**
   * 关闭所有 Chrome 实例
   */
  async stopAll(): Promise<void> {
    logger.info('Manager', '关闭所有 Chrome 实例...');
    for (const [profile, instance] of this.instances) {
      try {
        instance.process.kill();
        logger.info(instance.account.name, '已关闭');
      } catch (err) {
        logger.error(instance.account.name, `关闭失败: ${err}`);
      }
    }
    this.instances.clear();
  }

  getInstance(profile: string): ChromeInstance | undefined {
    return this.instances.get(profile);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}