/**
 * 抢购流程状态机
 *
 * 状态转换:
 *   IDLE → PREPARE (抢购前10s，预先打开商品页+加购)
 *   PREPARE → EXECUTING (到达抢购时间，结算+提交订单，循环重试)
 *   EXECUTING → PAYMENT (提交订单成功，注入支付密码)
 *   EXECUTING → FAILED (重试耗尽仍未成功)
 *   PAYMENT → DONE (支付完成)
 *   PAYMENT → FAILED (支付失败)
 */

export enum FlashSaleState {
  IDLE = 'IDLE',
  PREPARE = 'PREPARE',
  EXECUTING = 'EXECUTING',
  PAYMENT = 'PAYMENT',
  DONE = 'DONE',
  FAILED = 'FAILED',
}

export interface StateContext {
  sku: string;
  flashSaleTime: Date;
  maxRetries: number;
  retryCount: number;
}

export function createStateContext(sku: string, flashSaleTime: string, maxRetries = 3): StateContext {
  return {
    sku,
    flashSaleTime: new Date(flashSaleTime),
    maxRetries,
    retryCount: 0,
  };
}

export function canTransition(from: FlashSaleState, to: FlashSaleState): boolean {
  const valid: Record<FlashSaleState, FlashSaleState[]> = {
    [FlashSaleState.IDLE]: [FlashSaleState.PREPARE],
    [FlashSaleState.PREPARE]: [FlashSaleState.EXECUTING],
    [FlashSaleState.EXECUTING]: [FlashSaleState.PAYMENT, FlashSaleState.FAILED],
    [FlashSaleState.PAYMENT]: [FlashSaleState.DONE, FlashSaleState.FAILED],
    [FlashSaleState.DONE]: [],
    [FlashSaleState.FAILED]: [],
  };
  return valid[from]?.includes(to) ?? false;
}