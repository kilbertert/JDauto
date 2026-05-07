/**
 * 单个抢购账号的状态机执行器
 */

import { FlashSaleState, createStateContext, canTransition } from './state-machine.js';
import { logger } from './utils/logger.js';
import * as opencli from './commands/opencli-wrap.js';

export interface InstanceResult {
  accountName: string;
  state: FlashSaleState;
  success: boolean;
  error?: string;
  startTime: Date;
  endTime: Date;
}

export class FlashSaleInstance {
  private state = FlashSaleState.IDLE;
  private ctx: ReturnType<typeof createStateContext>;
  private accountName: string;
  private profile: string;
  private paymentPassword: string;

  constructor(accountName: string, profile: string, sku: string, flashSaleTime: string, maxRetries: number, paymentPassword: string) {
    this.accountName = accountName;
    this.profile = profile;
    this.paymentPassword = paymentPassword;
    this.ctx = createStateContext(sku, flashSaleTime, maxRetries);
  }

  getState(): FlashSaleState {
    return this.state;
  }

  private setState(s: FlashSaleState): void {
    if (s === this.state) return; // 重复状态转换直接忽略
    if (!canTransition(this.state, s)) {
      logger.warn(this.accountName, `非法状态转换: ${this.state} → ${s}，强制切换`);
    }
    this.state = s;
    logger.info(this.accountName, `状态切换: ${s}`);
  }

  /**
   * PREPARE 阶段：提前打开商品页 + 加入购物车
   */
  async prepare(): Promise<void> {
    this.setState(FlashSaleState.PREPARE);
    // 快速短路：已经在提交订单页则直接完成预热
    if (await this.waitSubmitReady(4, 80)) {
      logger.success(this.accountName, '预热完成：已在提交订单页');
      return;
    }

    logger.info(this.accountName, '打开购物车检查商品...');
    await opencli.openCart(this.profile);
    const inCart = await opencli.isSkuInCart(this.profile, this.ctx.sku);
    if (!inCart) {
      logger.info(this.accountName, '购物车无目标商品，执行加购...');
      if (process.env['JDAUTO_PREPARE_OPEN_ITEM'] === '1') {
        const url = `https://item.jd.com/${this.ctx.sku}.html`;
        logger.info(this.accountName, `打开商品页: ${url}`);
        await opencli.openAndRefresh(this.profile, url);
        logger.success(this.accountName, '商品页已打开（刷新完成）');
      }

      logger.info(this.accountName, '执行加购...');
      await opencli.addToCart(this.profile, this.ctx.sku);
      logger.success(this.accountName, '已加入购物车');
    } else {
      logger.info(this.accountName, '商品已在购物车，跳过加购');
    }

    // 统一执行一次结算预热，避免无效双遍历
    logger.info(this.accountName, '预热到结算页...');
    await opencli.openCart(this.profile);
    for (let i = 0; i < 5; i++) {
      const r = await opencli.clickCheckoutButton(this.profile);
      if (r === 'ok') break;
      await sleep(120);
    }
    if (await this.waitSubmitReady(20, 100)) {
      logger.success(this.accountName, '预热完成：提交订单按钮已就绪');
      return;
    }

    logger.warn(this.accountName, '预热未完全就绪，EXECUTE 阶段将自动兜底');
  }

  /**
   * EXECUTING 阶段：结算 → 提交订单（带重试）
   */
  async execute(): Promise<void> {
    if (
      this.state === FlashSaleState.DONE
      || this.state === FlashSaleState.FAILED
      || this.state === FlashSaleState.PAYMENT
    ) {
      logger.warn(this.accountName, `当前状态 ${this.state}，跳过重复 EXECUTE`);
      return;
    }

    this.setState(FlashSaleState.EXECUTING);

    let submitReady = await opencli.isSubmitOrderReady(this.profile);
    if (!submitReady) {
      // 兜底：预热未成功时，回到购物车再走一次去结算
      logger.warn(this.accountName, '提交页未就绪，执行兜底跳转...');
      await opencli.openCart(this.profile);
      for (let i = 0; i < 6; i++) {
        const checkoutResult = await opencli.clickCheckoutButton(this.profile);
        if (checkoutResult === 'ok') break;
        await sleep(120);
      }
      for (let i = 0; i < 12; i++) {
        submitReady = await opencli.isSubmitOrderReady(this.profile);
        if (submitReady) break;
        await sleep(100);
      }
      if (!submitReady) {
        logger.error(this.accountName, '提交订单页面未就绪，结束本次任务');
        this.setState(FlashSaleState.FAILED);
        return;
      }
    }

    // 循环提交订单，最多重试 maxRetries 次
    for (let i = 0; i < this.ctx.maxRetries; i++) {
      this.ctx.retryCount = i + 1;
      logger.info(this.accountName, `提交订单尝试 ${this.ctx.retryCount}/${this.ctx.maxRetries}...`);

      const result = await opencli.clickSubmitOrderButton(this.profile);
      logger.info(this.accountName, `提交订单: ${result}`);

      if (result.startsWith('ok:')) {
        logger.success(this.accountName, '订单提交成功，进入支付阶段');
        this.setState(FlashSaleState.PAYMENT);
        return;
      }

      if (i < this.ctx.maxRetries - 1) {
        logger.warn(this.accountName, '提交失败，120ms 后重试...');
        await sleep(120);
      }
    }

    // 重试耗尽
    logger.error(this.accountName, `提交订单失败，已重试 ${this.ctx.maxRetries} 次`);
    this.setState(FlashSaleState.FAILED);
  }

  /**
   * PAYMENT 阶段：注入密码 + 点击立即支付
   */
  async pay(): Promise<void> {
    if (this.state !== FlashSaleState.PAYMENT) {
      logger.warn(this.accountName, `支付阶段状态异常: ${this.state}，跳过支付`);
      return;
    }

    // 直接启动自动支付观察器，避免一次状态探测往返
    logger.info(this.accountName, '启动自动支付观察器...');
    const started = await opencli.startAutoPayFlow(this.profile, this.paymentPassword);
    logger.info(this.accountName, `自动支付启动: ${started}`);
    if (started !== 'started') {
      logger.error(this.accountName, '自动支付脚本启动失败');
      this.setState(FlashSaleState.FAILED);
      return;
    }

    for (let i = 0; i < 100; i++) {
      const next = await opencli.getAutoPayStatus(this.profile);
      if (next.status === 'done') {
        this.setState(FlashSaleState.DONE);
        logger.success(this.accountName, '支付完成！');
        return;
      }
      if (next.status === 'failed') {
        logger.error(this.accountName, `自动支付失败: ${next.error || next.lastAction || 'unknown'}`);
        this.setState(FlashSaleState.FAILED);
        return;
      }
      await sleep(50);
    }

    logger.error(this.accountName, '自动支付超时');
    this.setState(FlashSaleState.FAILED);
  }

  async run(prepareMs: number): Promise<InstanceResult> {
    const startTime = new Date();
    const endTime = new Date();

    try {
      // 等待到 PREPARE 时间点
      const waitTime = prepareMs - Date.now();
      if (waitTime > 0) {
        logger.info(this.accountName, `等待 ${Math.round(waitTime / 1000)}s 后开始 PREPARE...`);
        await sleep(waitTime);
      }

      await this.prepare();

      // 等待到精确抢购时间
      const execWait = this.ctx.flashSaleTime.getTime() - Date.now();
      if (execWait > 0) {
        logger.info(this.accountName, `等待 ${Math.round(execWait / 1000)}s 后开始抢购...`);
        await sleep(execWait);
      }

      await this.execute();
      if (this.state === FlashSaleState.PAYMENT) {
        await this.pay();
      }
    } catch (err) {
      logger.error(this.accountName, `异常: ${err}`);
      if (canTransition(this.state, FlashSaleState.FAILED)) {
        this.setState(FlashSaleState.FAILED);
      }
    }

    endTime.setTime(Date.now());
    return {
      accountName: this.accountName,
      state: this.state,
      success: this.state === FlashSaleState.DONE,
      error: this.state === FlashSaleState.FAILED ? '抢购失败' : undefined,
      startTime,
      endTime,
    };
  }

  private async waitSubmitReady(maxChecks: number, intervalMs: number): Promise<boolean> {
    for (let i = 0; i < maxChecks; i++) {
      if (await opencli.isSubmitOrderReady(this.profile)) {
        return true;
      }
      await sleep(intervalMs);
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
