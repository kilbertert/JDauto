/**
 * 精准定时器 + 抢购阶段管理
 *
 * PREPARE: 抢购时间 - 10s 触发（提前打开商品页+加购）
 * EXECUTE: 精确到抢购时间触发（结算+提交+支付）
 */

import { logger } from './utils/logger.js';
import type { FlashSaleTask } from './config.js';

export interface SchedulerConfig {
  /** 抢购前多少毫秒开始 PREPARE */
  prepareAheadMs: number;
}

const DEFAULT_PREPARE_AHEAD_MS = 10_000; // 10 秒

/**
 * 精确调度器
 * 在指定时间触发回调，支持 PREPARE 和 EXECUTE 两个阶段
 */
export class FlashSaleScheduler {
  private prepareTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private executeTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /**
   * 注册一个抢购任务
   * @param task 抢购任务
   * @param onPrepare PREPARE 阶段回调
   * @param onExecute EXECUTE 阶段回调（精确时间触发）
   */
  schedule(
    task: FlashSaleTask,
    onPrepare: (task: FlashSaleTask) => void,
    onExecute: (task: FlashSaleTask) => void,
    cfg: SchedulerConfig = { prepareAheadMs: DEFAULT_PREPARE_AHEAD_MS }
  ): void {
    const flashTime = new Date(task.flashSaleTime).getTime();
    const now = Date.now();

    const prepareTime = flashTime - cfg.prepareAheadMs;
    const executeTime = flashTime;

    if (prepareTime > now) {
      const delay = prepareTime - now;
      logger.info('Scheduler', `任务 ${task.sku} PREPARE 阶段将在 ${Math.round(delay / 1000)}s 后触发`);
      const timer = setTimeout(() => {
        logger.info('Scheduler', `PREPARE 触发: ${task.sku}`);
        onPrepare(task);
      }, delay);
      this.prepareTimers.set(task.sku, timer);
    } else {
      logger.warn('Scheduler', `任务 ${task.sku} PREPARE 时间已过，立即触发`);
      onPrepare(task);
    }

    if (executeTime > now) {
      const delay = executeTime - now;
      logger.info('Scheduler', `任务 ${task.sku} EXECUTE 阶段将在 ${Math.round(delay / 1000)}s 后触发`);
      const timer = setTimeout(() => {
        logger.info('Scheduler', `EXECUTE 触发: ${task.sku}`);
        onExecute(task);
      }, delay);
      this.executeTimers.set(task.sku, timer);
    } else {
      logger.warn('Scheduler', `任务 ${task.sku} 抢购时间已过，立即触发`);
      onExecute(task);
    }
  }

  /**
   * 取消所有定时器
   */
  cancelAll(): void {
    for (const timer of this.prepareTimers.values()) clearTimeout(timer);
    for (const timer of this.executeTimers.values()) clearTimeout(timer);
    this.prepareTimers.clear();
    this.executeTimers.clear();
    logger.info('Scheduler', '所有定时器已取消');
  }
}