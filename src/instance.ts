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
    const url = `https://item.jd.com/${this.ctx.sku}.html`;
    logger.info(this.accountName, `打开商品页: ${url}`);

    await opencli.openAndRefresh(this.profile, url);
    logger.success(this.accountName, '商品页已打开（刷新完成）');

    logger.info(this.accountName, '执行加购...');
    await opencli.addToCart(this.profile, this.ctx.sku);
    logger.success(this.accountName, '已加入购物车');
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

    // 打开购物车
    logger.info(this.accountName, '打开购物车页面...');
    await opencli.openCart(this.profile);

    // 点击"去结算"：极速轮询（低延迟）
    logger.info(this.accountName, '点击"去结算"...');
    let checkoutResult = '';
    let checkoutOk = false;
    for (let i = 0; i < 6; i++) {
      checkoutResult = await opencli.clickCheckoutButton(this.profile);
      if (checkoutResult === 'ok') {
        checkoutOk = true;
        break;
      }
      logger.warn(this.accountName, `结算按钮未就绪（第 ${i + 1}/6 次）: ${checkoutResult || 'empty'}`);
      if (i === 2) {
        await opencli.openCart(this.profile);
      }
      await sleep(120);
    }
    logger.info(this.accountName, `结算按钮: ${checkoutResult || 'empty'}`);
    if (!checkoutOk) {
      logger.error(this.accountName, '去结算按钮点击失败，结束本次任务');
      this.setState(FlashSaleState.FAILED);
      return;
    }

    // 去结算后短等待“提交订单”就绪，避免页面还在跳转时误判点击成功
    let submitReady = false;
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

    // 循环提交订单，最多重试 maxRetries 次
    for (let i = 0; i < this.ctx.maxRetries; i++) {
      this.ctx.retryCount = i + 1;
      logger.info(this.accountName, `提交订单尝试 ${this.ctx.retryCount}/${this.ctx.maxRetries}...`);

      const result = await opencli.clickSubmitOrderButton(this.profile);
      logger.info(this.accountName, `提交订单: ${result}`);

      if (result.startsWith('ok:')) {
        // 提交返回 ok 后做短时确认：出现支付入口或密码框才进入 PAYMENT
        let payReady = false;
        for (let j = 0; j < 10; j++) {
          if (await opencli.isPasswordInputReady(this.profile)) {
            payReady = true;
            break;
          }
          if (await opencli.isPayEntryReady(this.profile)) {
            payReady = true;
            break;
          }
          await sleep(100);
        }

        if (payReady) {
          logger.success(this.accountName, '订单提交成功，进入支付阶段');
          this.setState(FlashSaleState.PAYMENT);
          return;
        }

        logger.warn(this.accountName, '提交返回 ok，但支付入口未出现，继续重试...');
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

    // 按手工流程：先点击“立即支付”唤起密码输入，再极速轮询输入框
    let inputReady = await opencli.isPasswordInputReady(this.profile);
    for (let i = 0; i < 6 && !inputReady; i++) {
      logger.info(this.accountName, `点击"立即支付"唤起密码输入（第 ${i + 1}/6 次）...`);
      const r1 = await opencli.clickFirstPayButton(this.profile);
      logger.info(this.accountName, `立即支付(进入): ${r1}`);
      await sleep(100);
      inputReady = await opencli.isPasswordInputReady(this.profile);
    }

    if (!inputReady) {
      logger.error(this.accountName, '支付密码输入框未出现，支付终止');
      this.setState(FlashSaleState.FAILED);
      return;
    }

    logger.info(this.accountName, '注入支付密码...');
    const r2 = await opencli.injectPassword(this.profile, this.paymentPassword);
    logger.info(this.accountName, `密码注入: ${r2}`);
    if (!r2.startsWith('password set:')) {
      logger.error(this.accountName, '支付密码注入失败');
      this.setState(FlashSaleState.FAILED);
      return;
    }

    logger.info(this.accountName, '点击"立即支付"确认...');
    const r3 = await opencli.clickFinalPayButton(this.profile);
    logger.info(this.accountName, `确认支付: ${r3}`);
    if (!r3.includes('clicked at')) {
      logger.error(this.accountName, '未找到最终确认支付按钮');
      this.setState(FlashSaleState.FAILED);
      return;
    }

    this.setState(FlashSaleState.DONE);
    logger.success(this.accountName, '支付完成！');
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
