/**
 * 冒烟测试 — 验证核心模块可正常导入（从 dist 目录导入）
 */

import { strict as assert } from 'node:assert';

// 测试 logger
import { logger } from '../dist/utils/logger.js';
logger.info('Test', 'logger works');

// 测试 state-machine
import { FlashSaleState, createStateContext, canTransition } from '../dist/state-machine.js';
const ctx = createStateContext('100218876132', '2026-05-07T20:00:00', 3);
assert(ctx.sku === '100218876132');
assert(ctx.maxRetries === 3);
assert(canTransition(FlashSaleState.IDLE, FlashSaleState.PREPARE));
assert(!canTransition(FlashSaleState.DONE, FlashSaleState.PREPARE));
console.log('state-machine: OK');

// 测试 config 类型
import type { ChromeAccount, FlashSaleTask } from '../dist/config.js';
const account: ChromeAccount = { name: '测试账号', profile: 'TestProfile' };
const task: FlashSaleTask = { sku: '123', flashSaleTime: '2026-05-07T20:00:00' };
assert(account.profile === 'TestProfile');
assert(task.sku === '123');
console.log('config types: OK');

// 测试 scheduler
import { FlashSaleScheduler } from '../dist/scheduler.js';
const scheduler = new FlashSaleScheduler();
assert(scheduler !== undefined);
console.log('scheduler: OK');

console.log('\n✅ All smoke tests passed');