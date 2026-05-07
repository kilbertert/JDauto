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

/**
 * 从环境变量或默认路径加载配置
 */
export function loadConfig(): JDAutoConfig {
  const configPath = process.env[CONFIG_ENV_KEY] ?? DEFAULT_CONFIG_PATH;
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as JDAutoConfig;
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
