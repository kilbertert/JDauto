/**
 * Chrome 实例管理器
 * - 负责启动/关闭多个 Chrome 实例（每个对应一个账号 profile）
 * - 通过 child_process 启动 chrome.exe，传入 --profile-directory + --remote-debugging-port
 * - 验证 Browser Bridge 连接
 */

import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { logger } from './utils/logger.js';
import * as opencli from './commands/opencli-wrap.js';
import type { ChromeAccount } from './config.js';

const DEFAULT_CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export interface ChromeInstance {
  account: ChromeAccount;
  process?: ChildProcess;
  managedByTool: boolean;
  cdpPort: number;
}

/**
 * 启动一个 Chrome 实例
 */
function launchChrome(account: ChromeAccount): ChildProcess {
  const chromePath = account.chromePath ?? DEFAULT_CHROME_PATH;
  const port = account.cdpPort ?? 9221;
  const profileDir = account.browserProfileDir ?? account.profile;
  const userDataDir = account.browserUserDataDir;
  const extensionDir = process.env['JDAUTO_OPENCLI_EXTENSION_DIR'];

  const args = [
    `--profile-directory=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    'https://www.jd.com/',
  ];
  if (userDataDir) {
    args.push(`--user-data-dir=${userDataDir}`);
  }
  if (extensionDir && fs.existsSync(extensionDir)) {
    args.push(`--disable-extensions-except=${extensionDir}`);
    args.push(`--load-extension=${extensionDir}`);
  }

  logger.info(account.name, `启动 Chrome (profileDir=${profileDir}, opencli=${account.profile}, port=${port})...`);
  return spawn(chromePath, args, {
    detached: false,
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
  });
}

export class InstanceManager {
  private instances = new Map<string, ChromeInstance>();
  private readyProfiles = new Set<string>();

  /**
   * 启动所有账号的 Chrome 实例
   */
  async startAll(accounts: ChromeAccount[]): Promise<void> {
    logger.info('Manager', `准备启动 ${accounts.length} 个 Chrome 实例...`);
    this.readyProfiles.clear();

    // 先检测已经打开并连上 Browser Bridge 的账号：直接复用，不重复拉起浏览器
    const preflight = await Promise.all(
      accounts.map(async (account) => ({
        account,
        connected: await opencli.pingProfile(account.profile, 3_000),
      }))
    );

    const alreadyReady = preflight.filter((x) => x.connected).map((x) => x.account);
    const needLaunch = preflight.filter((x) => !x.connected).map((x) => x.account);

    for (const account of alreadyReady) {
      const instance: ChromeInstance = {
        account,
        managedByTool: false,
        cdpPort: account.cdpPort ?? 9221,
      };
      this.instances.set(account.profile, instance);
      logger.success(account.name, '检测到已连接浏览器，直接复用');
    }

    for (const account of needLaunch) {
      const proc = launchChrome(account);
      const instance: ChromeInstance = {
        account,
        process: proc,
        managedByTool: true,
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

    let ready = [...alreadyReady];
    let failed: ChromeAccount[] = [];
    if (needLaunch.length > 0) {
      logger.info('Manager', `等待 Browser Bridge 连接（复用 ${alreadyReady.length}，新启动 ${needLaunch.length}）...`);
      const r = await this.waitForAllProfiles(needLaunch);
      ready = [...ready, ...r.ready];
      failed = r.failed;
    } else {
      logger.info('Manager', `全部账号均已连接，无需新启动 (${alreadyReady.length}/${accounts.length})`);
    }
    this.readyProfiles = new Set(ready.map((a) => a.profile));

    if (failed.length === 0) {
      logger.success('Manager', `所有 Chrome 实例已就绪 (${ready.length}/${accounts.length})`);
      return;
    }

    logger.warn(
      'Manager',
      `仅 ${ready.length}/${accounts.length} 个账号就绪，未连接账号: ${failed.map((a) => a.name).join(', ')}`
    );
  }

  /**
   * 等待所有 profile 的 Browser Bridge 连接
   */
  private async waitForAllProfiles(
    accounts: ChromeAccount[],
    timeoutMs = 30_000
  ): Promise<{ ready: ChromeAccount[]; failed: ChromeAccount[] }> {
    const checks = await Promise.all(
      accounts.map(async (account) => ({
        account,
        ok: await this.waitForSingleProfile(account, timeoutMs),
      }))
    );

    const ready = checks.filter((x) => x.ok).map((x) => x.account);
    const failed = checks.filter((x) => !x.ok).map((x) => x.account);
    return { ready, failed };
  }

  private async waitForSingleProfile(account: ChromeAccount, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await opencli.pingProfile(account.profile);
      if (ok) {
        logger.success(account.name, 'Browser Bridge 已连接');
        return true;
      }
      await sleep(800);
    }
    logger.warn(account.name, `Browser Bridge 连接超时 (${Math.round(timeoutMs / 1000)}s)`);
    return false;
  }

  /**
   * 关闭所有 Chrome 实例
   */
  async stopAll(): Promise<void> {
    logger.info('Manager', '关闭所有 Chrome 实例...');
    for (const [profile, instance] of this.instances) {
      try {
        if (instance.managedByTool && instance.process) {
          instance.process.kill();
          logger.info(instance.account.name, '已关闭');
        } else {
          logger.info(instance.account.name, '复用实例不自动关闭');
        }
      } catch (err) {
        logger.error(instance.account.name, `关闭失败: ${err}`);
      }
    }
    this.instances.clear();
  }

  getInstance(profile: string): ChromeInstance | undefined {
    return this.instances.get(profile);
  }

  getReadyAccounts(accounts: ChromeAccount[]): ChromeAccount[] {
    return accounts.filter((a) => this.readyProfiles.has(a.profile));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
