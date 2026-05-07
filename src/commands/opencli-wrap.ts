/**
 * opencli browser 命令封装
 *
 * 参考 OpenCLI-main/src/cli.ts 的 browserAction() 模式
 * 使用 child_process 执行 opencli 命令
 */

import { spawn } from 'node:child_process';

const OPENCLI_CMD = 'opencli';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function pickOutputText(r: CommandResult): string {
  const out = r.stdout.trim();
  if (out) return out;
  const err = r.stderr.trim();
  if (err) return err;
  return '';
}

function normalizeEvalScript(script: string): string {
  return script.replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function buildSafeEvalScript(script: string): string {
  const normalized = normalizeEvalScript(script);
  const encoded = Buffer.from(normalized, 'utf-8').toString('base64');
  // 生成无空格脚本并按 UTF-8 解码，避免中文（如“去结算”）在 atob 后乱码
  return `(()=>{const b=atob('${encoded}');const u=Uint8Array.from(b,c=>c.charCodeAt(0));return eval(new TextDecoder().decode(u));})()`;
}

function quoteForPowerShell(arg: string): string {
  return `'${arg.replace(/'/g, "''")}'`;
}

/**
 * 执行 opencli 命令
 * 注意：--profile 是全局选项，必须放在 subcommand 前面
 * 正确: opencli --profile <name> browser open <url>
 * 错误: opencli browser open <url> --profile <name>
 */
async function runOpenCLI(args: string[], profile?: string, timeoutMs = 60_000): Promise<CommandResult> {
  const fullArgs = profile
    ? ['--profile', profile, ...args]
    : [...args];

  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const spawnCmd = isWindows ? 'powershell.exe' : OPENCLI_CMD;
    const spawnArgs = isWindows
      ? [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `opencli ${fullArgs.map(quoteForPowerShell).join(' ')}`,
      ]
      : fullArgs;

    let child;
    try {
      child = spawn(spawnCmd, spawnArgs, {
        shell: false,
        windowsHide: true,
        timeout: timeoutMs,
      });
    } catch (err) {
      resolve({ stdout: '', stderr: String(err), exitCode: 1 });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
    child.on('error', (err) => {
      resolve({ stdout: '', stderr: String(err), exitCode: 1 });
    });
  });
}

/**
 * 打开商品页 + 按 F5 刷新
 */
export async function openAndRefresh(profile: string, url: string): Promise<string> {
  const r1 = await runOpenCLI(['browser', 'open', url], profile);
  if (r1.exitCode !== 0) throw new Error(`browser open failed: ${r1.stderr}`);

  const r2 = await runOpenCLI(['browser', 'keys', 'F5'], profile);
  return r2.stdout;
}

/**
 * 执行 JS 脚本
 */
export async function evalScript(profile: string, script: string): Promise<string> {
  const r = await runOpenCLI(['browser', 'eval', buildSafeEvalScript(script)], profile);
  return pickOutputText(r);
}

/**
 * 找"去结算"按钮并点击
 */
export async function clickCheckoutButton(profile: string): Promise<string> {
  const script = `(function(){
    const el = Array.from(document.querySelectorAll('div'))
      .find(e => e.className.includes('_submit_') && e.textContent.includes('去结算'));
    if (el) { el.click(); return 'ok'; }
    return 'not found';
  })()`;
  return evalScript(profile, script);
}

/**
 * 找"提交订单"按钮并点击
 */
export async function clickSubmitOrderButton(profile: string): Promise<string> {
  const script = `(function(){
    const href = location.href;
    const onOrderPage = href.includes('trade.jd.com') || href.includes('/order/getOrderInfo');
    const btn = Array.from(document.querySelectorAll('button'))
      .find(e => {
        const txt = (e.textContent || '').replace(/\\s+/g, '');
        const rect = e.getBoundingClientRect();
        const disabled = e.hasAttribute('disabled') || e.getAttribute('aria-disabled') === 'true';
        return txt.includes('提交订单')
          && e.offsetParent !== null
          && rect.width > 40
          && rect.height > 20
          && !disabled;
      });
    if (btn && onOrderPage) {
      const rect = btn.getBoundingClientRect();
      btn.click();
      return 'ok:clicked at (' + Math.round(rect.x) + ',' + Math.round(rect.y) + ')';
    }
    return 'not found';
  })()`;
  return evalScript(profile, script);
}

/**
 * 判断“提交订单”按钮是否已就绪（页面加载完成）
 */
export async function isSubmitOrderReady(profile: string): Promise<boolean> {
  const script = `(function(){
    const href = location.href;
    const onOrderPage = href.includes('trade.jd.com') || href.includes('/order/getOrderInfo');
    const btn = Array.from(document.querySelectorAll('button'))
      .find(e => {
        const txt = (e.textContent || '').replace(/\\s+/g, '');
        const rect = e.getBoundingClientRect();
        const disabled = e.hasAttribute('disabled') || e.getAttribute('aria-disabled') === 'true';
        return txt.includes('提交订单')
          && e.offsetParent !== null
          && rect.width > 40
          && rect.height > 20
          && !disabled;
      });
    return (onOrderPage && btn) ? 'ready' : 'not ready';
  })()`;
  return (await evalScript(profile, script)) === 'ready';
}

/**
 * 判断支付页是否就绪（出现密码框或可见“立即支付”按钮）
 */
export async function isPaymentPageReady(profile: string): Promise<boolean> {
  const script = `(function(){
    const pwd = document.querySelector('#shortPwdInput');
    if (pwd) return 'ready';
    const btn = Array.from(document.querySelectorAll('div,button'))
      .find(e => {
        const txt = (e.textContent || '').replace(/\\s+/g, '');
        const cls = String(e.className || '');
        const rect = e.getBoundingClientRect();
        return txt.includes('立即支付')
          && cls.includes('base-button')
          && e.offsetParent !== null
          && rect.width > 90
          && rect.height > 30;
      });
    return btn ? 'ready' : 'not ready';
  })()`;
  return (await evalScript(profile, script)) === 'ready';
}

/**
 * 判断是否出现可点击的“立即支付”入口（不要求已出现密码框）
 */
export async function isPayEntryReady(profile: string): Promise<boolean> {
  const script = `(function(){
    const hit = Array.from(document.querySelectorAll('div,button'))
      .find(e => {
        const txt = (e.textContent || '').replace(/\\s+/g, '');
        const cls = String(e.className || '');
        const rect = e.getBoundingClientRect();
        return txt.includes('立即支付')
          && cls.includes('base-button')
          && e.offsetParent !== null
          && rect.width > 90
          && rect.height > 30;
    });
    return hit ? 'ready' : 'not ready';
  })()`;
  return (await evalScript(profile, script)) === 'ready';
}

/**
 * 判断支付密码输入框是否就绪
 */
export async function isPasswordInputReady(profile: string): Promise<boolean> {
  const script = `(function(){
    return document.querySelector('#shortPwdInput') ? 'ready' : 'not ready';
  })()`;
  return (await evalScript(profile, script)) === 'ready';
}

/**
 * 找"立即支付"按钮并点击（第一个，用于进入支付页）
 */
export async function clickFirstPayButton(profile: string): Promise<string> {
  const script = `(function(){
    const candidates = Array.from(document.querySelectorAll('div,button'))
      .filter(e => {
        const txt = (e.textContent || '').replace(/\\s+/g, '');
        const cls = String(e.className || '');
        const rect = e.getBoundingClientRect();
        return txt.includes('立即支付')
          && cls.includes('base-button')
          && e.offsetParent !== null
          && rect.width > 90
          && rect.height > 30;
      })
      .sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x);
    const btn = candidates[0];
    if (btn) {
      const rect = btn.getBoundingClientRect();
      btn.click();
      return 'clicked at (' + Math.round(rect.x) + ',' + Math.round(rect.y) + ')';
    }
    return 'not found';
  })()`;
  return evalScript(profile, script);
}

/**
 * 注入支付密码
 */
export async function injectPassword(profile: string, password: string): Promise<string> {
  const script = `(function(){
    var i = document.querySelector('#shortPwdInput');
    if (!i) return 'input not found';
    i.value = '${password}';
    if (i._valueTracker) i._valueTracker.setValue('');
    ['input','change'].forEach(function(t){
      i.dispatchEvent(new Event(t, {bubbles: true}));
    });
    return 'password set: ' + i.value;
  })()`;
  return evalScript(profile, script);
}

/**
 * 点击最后一个"立即支付"按钮（输入密码后的确认按钮）
 */
export async function clickFinalPayButton(profile: string): Promise<string> {
  const script = `(function(){
    const btn = Array.from(document.querySelectorAll('div'))
      .find(e => e.className.includes('base-button')
        && e.textContent.includes('立即支付')
        && e.getBoundingClientRect().x < 800);
    if (btn) {
      btn.click();
      return 'clicked at (' + Math.round(btn.getBoundingClientRect().x) + ',' + Math.round(btn.getBoundingClientRect().y) + ')';
    }
    return 'not found';
  })()`;
  return evalScript(profile, script);
}

/**
 * 加入购物车（调用 opencli jd add-cart）
 */
export async function addToCart(profile: string, sku: string): Promise<string> {
  const r = await runOpenCLI(['jd', 'add-cart', sku], profile);
  return r.stdout;
}

/**
 * 打开购物车页面
 */
export async function openCart(profile: string): Promise<string> {
  const r = await runOpenCLI(['browser', 'open', 'https://cart.jd.com/cart.action'], profile);
  return pickOutputText(r);
}

/**
 * 验证 Browser Bridge 连接
 */
export async function pingProfile(profile: string): Promise<boolean> {
  const r = await runOpenCLI(['browser', 'tab', 'list'], profile, 10_000);
  return r.exitCode === 0;
}
