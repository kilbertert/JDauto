/**
 * 统一日志输出
 * - 带时间戳 + 账号前缀
 * - 区分 INFO / WARN / ERROR / SUCCESS
 */

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' | 'DEBUG';

const RESET = '\x1b[0m';
const GRAY = '\x1b[90m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

function color(level: LogLevel): string {
  switch (level) {
    case 'SUCCESS': return GREEN;
    case 'WARN': return YELLOW;
    case 'ERROR': return RED;
    case 'DEBUG': return GRAY;
    default: return CYAN;
  }
}

function levelTag(level: LogLevel): string {
  switch (level) {
    case 'INFO': return '[INFO]';
    case 'WARN': return '[WARN]';
    case 'ERROR': return '[ERROR]';
    case 'SUCCESS': return '[OK]';
    case 'DEBUG': return '[DEBUG]';
  }
}

function formatLocalTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function log(level: LogLevel, account: string, message: string): void {
  const ts = formatLocalTime(new Date());
  const lvl = levelTag(level).padEnd(7);
  const prefix = `[${account}]`.padEnd(10);
  console.log(`${GRAY}${ts}${RESET} ${color(level)}${lvl}${RESET} ${prefix} ${message}`);
}

export const logger = {
  info: (account: string, msg: string) => log('INFO', account, msg),
  warn: (account: string, msg: string) => log('WARN', account, msg),
  error: (account: string, msg: string) => log('ERROR', account, msg),
  success: (account: string, msg: string) => log('SUCCESS', account, msg),
  debug: (account: string, msg: string) => log('DEBUG', account, msg),
};
