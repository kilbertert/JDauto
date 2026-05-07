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

export interface AutoPayStatus {
  status: string;
  error?: string;
  lastAction?: string;
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
      .find(e => {
        if (!e.className.includes('_submit_')) return false;
        const txt = (e.textContent || '').replace(/\\s+/g, '');
        return txt.includes('去结算') || txt.includes('领券结算') || txt.includes('领劵结算');
      });
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
 * 判断商品是否已在购物车
 */
export async function isSkuInCart(profile: string, sku: string): Promise<boolean> {
  const safeSku = JSON.stringify(sku);
  const script = `(function(){
    const sku=${safeSku};
    const nodes = Array.from(document.querySelectorAll('[data-sku],a,div,span'));
    const found = nodes.some(e => {
      const dataSku = e.getAttribute ? (e.getAttribute('data-sku') || '') : '';
      const txt = (e.textContent || '');
      const href = (e.tagName === 'A' && e.getAttribute) ? (e.getAttribute('href') || '') : '';
      return dataSku.includes(sku) || txt.includes(sku) || href.includes(sku);
    });
    return found ? 'yes' : 'no';
  })()`;
  return (await evalScript(profile, script)) === 'yes';
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
 * 注入一次自动支付脚本（页面内 MutationObserver 连续处理）
 */
export async function startAutoPayFlow(profile: string, password: string): Promise<string> {
  const pwd = JSON.stringify(password);
  const script = `(function(){
    const KEY='__JDAUTO_AUTOPAY__';
    const password=${pwd};
    const old=window[KEY];
    if(old && typeof old.cleanup==='function'){ try{ old.cleanup(); }catch(_){} }
    const state={status:'running',error:'',lastAction:'init',startedAt:Date.now(),cleanup:null};
    window[KEY]=state;
    const isVisible=(e)=>!!e&&e.offsetParent!==null;
    const hasText=(e,t)=>((e&&e.textContent)||'').replace(/\\s+/g,'').includes(t);
    const findEntry=()=>Array.from(document.querySelectorAll('div,button'))
      .filter(e=>hasText(e,'立即支付')&&String(e.className||'').includes('base-button')&&isVisible(e)&&e.getBoundingClientRect().width>90&&e.getBoundingClientRect().height>30)
      .sort((a,b)=>b.getBoundingClientRect().x-a.getBoundingClientRect().x)[0]||null;
    const findFinal=()=>Array.from(document.querySelectorAll('div,button'))
      .filter(e=>hasText(e,'立即支付')&&String(e.className||'').includes('base-button')&&isVisible(e)&&e.getBoundingClientRect().x<800)
      [0]||null;
    const fillPwd=()=>{const i=document.querySelector('#shortPwdInput');if(!i)return false;i.value=password;if(i._valueTracker)i._valueTracker.setValue('');['input','change'].forEach(t=>i.dispatchEvent(new Event(t,{bubbles:true})));return true;};
    const finish=(status,error='')=>{state.status=status;state.error=error;cleanup();};
    const step=()=>{try{
      if(state.status==='done'||state.status==='failed')return;
      const input=document.querySelector('#shortPwdInput');
      if(!input){
        const entry=findEntry();
        if(entry){entry.click();state.lastAction='click-entry';}
        state.status='waiting_password';
        return;
      }
      const ok=fillPwd();
      if(!ok){state.status='waiting_password';return;}
      state.lastAction='password-set';
      const finalBtn=findFinal();
      if(finalBtn){finalBtn.click();state.lastAction='click-final';finish('done');return;}
      state.status='waiting_final';
    }catch(err){finish('failed',String(err));}};
    const timer=setInterval(step,80);
    const observer=new MutationObserver(()=>step());
    observer.observe(document.documentElement||document.body,{childList:true,subtree:true,attributes:true});
    const cleanup=()=>{clearInterval(timer);observer.disconnect();};
    state.cleanup=cleanup;
    setTimeout(()=>{if(state.status!=='done'&&state.status!=='failed'){finish('failed','timeout');}},10000);
    step();
    return 'started';
  })()`;
  return evalScript(profile, script);
}

/**
 * 获取自动支付脚本状态
 */
export async function getAutoPayStatus(profile: string): Promise<AutoPayStatus> {
  const script = `(function(){
    const KEY='__JDAUTO_AUTOPAY__';
    const s=window[KEY];
    if(!s)return JSON.stringify({status:'idle'});
    return JSON.stringify({status:s.status||'idle',error:s.error||'',lastAction:s.lastAction||''});
  })()`;
  const raw = await evalScript(profile, script);
  try {
    return JSON.parse(raw) as AutoPayStatus;
  } catch {
    return { status: 'unknown', error: raw };
  }
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
export async function pingProfile(profile: string, timeoutMs = 10_000): Promise<boolean> {
  const r = await runOpenCLI(['browser', 'tab', 'list'], profile, timeoutMs);
  return r.exitCode === 0;
}
