/**
 * JDauto 配置管理
 * - 读取 accounts.json / tasks.json
 * - 支持环境变量 / 命令行注入敏感信息（支付密码）
 * - 密码不落盘，只存在内存中
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ChromeAccount {
  /** 账号显示名称 */
  name: string;
  /** OpenCLI profile 名称（opencli --profile） */
  profile: string;
  /** 浏览器 profile 目录名（对应 --profile-directory），未提供时回退到 profile */
  browserProfileDir?: string;
  /** 浏览器 User Data 目录（对应 --user-data-dir），用于隔离自动化环境 */
  browserUserDataDir?: string;
  /** OpenCLI profile 的 contextId（用于追踪映射关系） */
  opencliContextId?: string;
  /** Chrome 可执行文件路径 */
  chromePath?: string;
  /** 独立调试端口（每个实例不同） */
  cdpPort?: number;
}

export interface FlashSaleTask {
  /** 商品 SKU */
  sku: string;
  /** 抢购时间（ISO 8601） */
  flashSaleTime: string;
  /** 提交订单失败重试次数 */
  maxRetries?: number;
}

export interface JDAutoConfig {
  accounts: ChromeAccount[];
  tasks: FlashSaleTask[];
}

const CONFIG_ENV_KEY = 'JDAUTO_CONFIG_PATH';
const DEFAULT_CONFIG_PATH = path.join(process.cwd(), 'config', 'accounts.json');

function configError(source: string, field: string, message: string): Error {
  return new Error(`配置 ${source} 的 ${field} ${message}`);
}

function nonEmptyString(value: unknown, source: string, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw configError(source, field, '必须是非空字符串');
  }
}

function validateConfig(value: unknown, source: string): JDAutoConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError(source, '根节点', '必须是对象');
  }

  const config = value as Record<string, unknown>;
  if (!Array.isArray(config.accounts)) {
    throw configError(source, 'accounts', '必须是数组');
  }
  if (!Array.isArray(config.tasks)) {
    throw configError(source, 'tasks', '必须是数组');
  }

  const seenProfiles = new Set<string>();
  config.accounts.forEach((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw configError(source, `accounts[${index}]`, '必须是对象');
    }
    const account = value as Record<string, unknown>;
    nonEmptyString(account.name, source, `accounts[${index}].name`);
    nonEmptyString(account.profile, source, `accounts[${index}].profile`);

    const profile = account.profile.trim();
    if (seenProfiles.has(profile)) {
      throw configError(source, `accounts[${index}].profile`, `不能重复: ${profile}`);
    }
    seenProfiles.add(profile);

    for (const field of ['browserProfileDir', 'browserUserDataDir', 'opencliContextId', 'chromePath']) {
      if (account[field] !== undefined && typeof account[field] !== 'string') {
        throw configError(source, `accounts[${index}].${field}`, '必须是字符串');
      }
    }
    if (
      account.cdpPort !== undefined
      && (!Number.isInteger(account.cdpPort) || Number(account.cdpPort) < 1 || Number(account.cdpPort) > 65_535)
    ) {
      throw configError(source, `accounts[${index}].cdpPort`, '必须是 1–65535 的整数');
    }
  });

  config.tasks.forEach((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw configError(source, `tasks[${index}]`, '必须是对象');
    }
    const task = value as Record<string, unknown>;
    nonEmptyString(task.sku, source, `tasks[${index}].sku`);
    if (!/^\d{5,20}$/.test(task.sku.trim())) {
      throw configError(source, `tasks[${index}].sku`, '必须是 5–20 位数字');
    }
    nonEmptyString(task.flashSaleTime, source, `tasks[${index}].flashSaleTime`);
    if (Number.isNaN(Date.parse(task.flashSaleTime))) {
      throw configError(source, `tasks[${index}].flashSaleTime`, '必须是有效时间');
    }
    if (
      task.maxRetries !== undefined
      && (!Number.isInteger(task.maxRetries) || Number(task.maxRetries) <= 0)
    ) {
      throw configError(source, `tasks[${index}].maxRetries`, '必须是大于 0 的整数');
    }
  });

  return value as JDAutoConfig;
}

/**
 * 从显式路径、环境变量或默认路径加载并验证 Runtime Config
 */
export function loadConfig(configPath?: string): JDAutoConfig {
  const resolvedPath = path.resolve(configPath ?? process.env[CONFIG_ENV_KEY] ?? DEFAULT_CONFIG_PATH);
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`配置 ${resolvedPath} 不是有效 JSON: ${String(error)}`);
  }
  return validateConfig(parsed, resolvedPath);
}

/**
 * 验证并原子保存 Runtime Config
 */
export function saveConfig(configPath: string, config: JDAutoConfig): void {
  const resolvedPath = path.resolve(configPath);
  const validated = validateConfig(config, resolvedPath);
  const tempPath = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, resolvedPath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

/**
 * 运行时注入的支付密码（不落盘）
 * 通过环境变量 JDAUTO_PASSWORD 注入
 */
export function getPaymentPassword(): string {
  const pwd = process.env['JDAUTO_PASSWORD'];
  if (!pwd) throw new Error('支付密码未提供：设置环境变量 JDAUTO_PASSWORD 或通过命令行注入');
  return pwd;
}
