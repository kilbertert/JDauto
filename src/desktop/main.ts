import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';

interface StartRequestBody {
  sku?: string;
  time?: string;
  password?: string;
  maxRetries?: number;
  prepareAhead?: number;
  accounts?: number;
  manual?: boolean;
}

interface RunState {
  running: boolean;
  pid?: number;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  command?: string;
  logs: string[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MAX_LOG_LINES = 800;

let mainWindow: BrowserWindow | null = null;
let child: ChildProcessWithoutNullStreams | null = null;
let stdoutBuffer = '';
let stderrBuffer = '';

const state: RunState = {
  running: false,
  logs: [],
};

function formatLocalTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function stripAnsi(input: string): string {
  return input.replace(/\x1B\[[0-9;]*m/g, '');
}

function findFirstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveCliEntryPath(): string {
  const devPath = path.join(PROJECT_ROOT, 'dist', 'index.js');
  const packagedPath = path.join(process.resourcesPath, 'dist-cli', 'index.js');
  const found = app.isPackaged
    ? findFirstExisting([packagedPath, devPath])
    : findFirstExisting([devPath, packagedPath]);
  if (!found) {
    throw new Error(`未找到 CLI 入口: ${devPath} 或 ${packagedPath}`);
  }
  return found;
}

function resolveConfigPath(): string | null {
  const devConfigPath = path.join(PROJECT_ROOT, 'config', 'accounts.json');
  const packagedConfigPath = path.join(process.resourcesPath, 'config', 'accounts.json');
  return app.isPackaged
    ? findFirstExisting([packagedConfigPath, devConfigPath])
    : findFirstExisting([devConfigPath, packagedConfigPath]);
}

function nowIso(): string {
  return new Date().toISOString();
}

function addLog(line: string): void {
  const clean = stripAnsi(line).trim();
  if (!clean) return;
  const ts = formatLocalTime(new Date());
  state.logs.push(`${ts} ${clean}`);
  if (state.logs.length > MAX_LOG_LINES) {
    state.logs.splice(0, state.logs.length - MAX_LOG_LINES);
  }
}

function flushBufferedLines(kind: 'stdout' | 'stderr', chunk: string): void {
  let buf = kind === 'stdout' ? stdoutBuffer : stderrBuffer;
  buf += chunk;
  const lines = buf.split(/\r?\n/);
  buf = lines.pop() ?? '';
  for (const line of lines) {
    addLog(kind === 'stderr' ? `[ERR] ${line}` : line);
  }
  if (kind === 'stdout') stdoutBuffer = buf;
  else stderrBuffer = buf;
}

function flushFinalBuffers(): void {
  if (stdoutBuffer.trim()) addLog(stdoutBuffer.trim());
  if (stderrBuffer.trim()) addLog(`[ERR] ${stderrBuffer.trim()}`);
  stdoutBuffer = '';
  stderrBuffer = '';
}

function normalizeTime(input: string): string {
  const dt = new Date(input);
  if (Number.isNaN(dt.getTime())) {
    throw new Error('时间格式错误，请使用有效时间');
  }
  return dt.toISOString();
}

function ensureDistBuilt(): void {
  if (!findFirstExisting([
    path.join(PROJECT_ROOT, 'dist', 'index.js'),
    path.join(process.resourcesPath, 'dist-cli', 'index.js'),
  ])) {
    throw new Error('未检测到 CLI 构建产物，请先执行 npm run build');
  }
}

function buildStartArgs(payload: StartRequestBody): {
  args: string[];
  password: string;
  commandPreview: string;
} {
  const sku = String(payload.sku ?? '').trim();
  const time = String(payload.time ?? '').trim();
  const password = String(payload.password ?? '').trim();
  const maxRetries = Number(payload.maxRetries ?? 3);
  const prepareAhead = Number(payload.prepareAhead ?? 45);
  const accountsRaw = payload.accounts;
  const manual = Boolean(payload.manual);

  if (!sku) throw new Error('SKU 不能为空');
  if (!time) throw new Error('抢购时间不能为空');
  if (!password) throw new Error('支付密码不能为空');
  if (!Number.isInteger(maxRetries) || maxRetries <= 0) {
    throw new Error('maxRetries 必须是大于 0 的整数');
  }
  if (!Number.isFinite(prepareAhead) || prepareAhead < 0) {
    throw new Error('prepareAhead 必须是大于等于 0 的数字');
  }

  const normalizedTime = normalizeTime(time);
  const cliEntryPath = resolveCliEntryPath();
  const args = [
    cliEntryPath,
    '--sku',
    sku,
    '--time',
    normalizedTime,
    '--max-retries',
    String(maxRetries),
    '--prepare-ahead',
    String(prepareAhead),
  ];

  if (accountsRaw !== undefined && accountsRaw !== null && String(accountsRaw).trim() !== '') {
    const accounts = Number(accountsRaw);
    if (!Number.isInteger(accounts) || accounts <= 0) {
      throw new Error('accounts 必须是大于 0 的整数');
    }
    args.push('--accounts', String(accounts));
  }

  if (manual) args.push('--manual');

  const commandPreview = `node dist/index.js --sku ${sku} --time ${normalizedTime} --max-retries ${maxRetries} --prepare-ahead ${prepareAhead}${manual ? ' --manual' : ''}`;
  return { args, password, commandPreview };
}

function startJob(payload: StartRequestBody): void {
  if (state.running) {
    throw new Error('任务已在运行，请先停止当前任务');
  }

  ensureDistBuilt();
  const { args, password, commandPreview } = buildStartArgs(payload);

  state.running = true;
  state.startedAt = nowIso();
  state.endedAt = undefined;
  state.exitCode = undefined;
  state.command = commandPreview;
  state.logs = [];
  stdoutBuffer = '';
  stderrBuffer = '';

  addLog(`启动任务: ${commandPreview}`);
  const cfgPath = resolveConfigPath();
  child = spawn(process.execPath, args, {
    cwd: app.isPackaged ? process.resourcesPath : PROJECT_ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      JDAUTO_PASSWORD: password,
      ...(cfgPath ? { JDAUTO_CONFIG_PATH: cfgPath } : {}),
    },
    stdio: 'pipe',
  });

  state.pid = child.pid;
  child.stdout.on('data', (chunk) => flushBufferedLines('stdout', String(chunk)));
  child.stderr.on('data', (chunk) => flushBufferedLines('stderr', String(chunk)));
  child.on('close', (code) => {
    flushFinalBuffers();
    state.running = false;
    state.exitCode = code ?? undefined;
    state.endedAt = nowIso();
    addLog(`任务结束: exitCode=${String(code)}`);
    child = null;
  });
  child.on('error', (err) => {
    addLog(`[ERR] 子进程异常: ${String(err)}`);
    state.running = false;
    state.endedAt = nowIso();
    child = null;
  });
}

function stopJob(): void {
  if (!child || !state.running) {
    throw new Error('当前没有运行中的任务');
  }
  child.kill('SIGINT');
  addLog('已发送停止信号 (SIGINT)');
}

function getConfigPreview(): { accountCount: number; accountNames: string[] } {
  try {
    const cfg = loadConfig();
    return {
      accountCount: cfg.accounts.length,
      accountNames: cfg.accounts.map((x) => x.name),
    };
  } catch (err) {
    addLog(`[ERR] 读取配置失败: ${String(err)}`);
    return { accountCount: 0, accountNames: [] };
  }
}

function getState(): RunState & { configPreview: { accountCount: number; accountNames: string[] } } {
  return {
    ...state,
    configPreview: getConfigPreview(),
  };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    title: 'JDauto 桌面控制台',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  const html = `<!doctype html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>JDauto 桌面控制台</title>
    <style>
      body { font-family: Arial, sans-serif; max-width: 940px; margin: 0 auto; padding: 16px; background: #171717; color: #f0f0f0; }
      h1 { margin: 0 0 14px; font-size: 24px; }
      .card { border: 1px solid #414141; border-radius: 10px; padding: 14px; margin-bottom: 14px; background: #222; }
      .row { display: grid; grid-template-columns: 170px 1fr; gap: 10px; align-items: center; margin-bottom: 10px; }
      input, button { font-size: 14px; padding: 8px; border-radius: 6px; border: 1px solid #555; background: #111; color: #fff; }
      button { cursor: pointer; }
      .inline { display: flex; gap: 8px; }
      .muted { color: #bcbcbc; font-size: 13px; }
      .ok { color: #7de89a; }
      .warn { color: #f5df87; }
      .status { font-weight: bold; }
      pre { margin: 0; background: #101010; padding: 10px; border-radius: 8px; min-height: 240px; overflow: auto; white-space: pre-wrap; }
      code { color: #b9f6ff; }
    </style>
  </head>
  <body>
    <h1>JDauto 简易桌面端</h1>
    <div class="card">
      <div class="row"><label for="sku">SKU</label><input id="sku" placeholder="例如: 100218876132" /></div>
      <div class="row"><label for="time">抢购时间</label><input id="time" type="datetime-local" step="1" /></div>
      <div class="row"><label for="password">支付密码</label><input id="password" type="password" placeholder="仅内存使用，不落盘" /></div>
      <div class="row"><label for="maxRetries">提交重试次数</label><input id="maxRetries" type="number" min="1" value="3" /></div>
      <div class="row"><label for="prepareAhead">预热提前秒数</label><input id="prepareAhead" type="number" min="0" value="45" /></div>
      <div class="row"><label for="accounts">启用账号数</label><input id="accounts" type="number" min="1" placeholder="留空=全部账号" /></div>
      <div class="row"><label for="manual">手动模式</label><input id="manual" type="checkbox" /></div>
      <div class="inline">
        <button id="startBtn">开始任务</button>
        <button id="stopBtn">停止任务</button>
        <button id="refreshBtn">刷新状态</button>
      </div>
      <p class="muted">配置概览：<span id="cfg"></span></p>
    </div>

    <div class="card">
      <p>当前状态：<span id="running" class="status warn">未知</span></p>
      <p>命令预览：<code id="cmd">-</code></p>
      <p class="muted" id="timing"></p>
    </div>

    <div class="card">
      <p>实时日志（最近 800 行）</p>
      <pre id="logs"></pre>
    </div>

    <script>
      const { ipcRenderer } = require('electron');
      const runningEl = document.getElementById('running');
      const logsEl = document.getElementById('logs');
      const cmdEl = document.getElementById('cmd');
      const timingEl = document.getElementById('timing');
      const cfgEl = document.getElementById('cfg');
      const startBtn = document.getElementById('startBtn');
      const stopBtn = document.getElementById('stopBtn');
      const refreshBtn = document.getElementById('refreshBtn');

      function toNum(v) {
        if (v === '' || v === null || v === undefined) return undefined;
        return Number(v);
      }

      function renderState(s) {
        runningEl.textContent = s.running ? '运行中' : '空闲';
        runningEl.className = 'status ' + (s.running ? 'ok' : 'warn');
        cmdEl.textContent = s.command || '-';
        timingEl.textContent = 'startedAt=' + (s.startedAt || '-') + ' | endedAt=' + (s.endedAt || '-') + ' | pid=' + (s.pid || '-') + ' | exitCode=' + (s.exitCode ?? '-');
        logsEl.textContent = (s.logs || []).join('\\n');
        logsEl.scrollTop = logsEl.scrollHeight;
        const c = s.configPreview || { accountCount: 0, accountNames: [] };
        cfgEl.textContent = c.accountCount + ' 个账号: ' + (c.accountNames.join(', ') || '无');
      }

      async function refresh() {
        try {
          const data = await ipcRenderer.invoke('jdauto:get-state');
          renderState(data);
        } catch (err) {
          logsEl.textContent += '\\n[UI] ' + String(err);
        }
      }

      startBtn.addEventListener('click', async () => {
        const body = {
          sku: document.getElementById('sku').value.trim(),
          time: document.getElementById('time').value,
          password: document.getElementById('password').value,
          maxRetries: toNum(document.getElementById('maxRetries').value),
          prepareAhead: toNum(document.getElementById('prepareAhead').value),
          accounts: toNum(document.getElementById('accounts').value),
          manual: document.getElementById('manual').checked
        };
        try {
          await ipcRenderer.invoke('jdauto:start', body);
          await refresh();
        } catch (err) {
          alert(String(err));
        }
      });

      stopBtn.addEventListener('click', async () => {
        try {
          await ipcRenderer.invoke('jdauto:stop');
          await refresh();
        } catch (err) {
          alert(String(err));
        }
      });

      refreshBtn.addEventListener('click', refresh);
      refresh();
      setInterval(refresh, 1000);
    </script>
  </body>
  </html>`;

  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('jdauto:get-state', () => getState());
ipcMain.handle('jdauto:start', (_event, payload: StartRequestBody) => {
  startJob(payload);
  return getState();
});
ipcMain.handle('jdauto:stop', () => {
  stopJob();
  return getState();
});

app.whenReady().then(() => {
  const cfgPath = resolveConfigPath();
  if (cfgPath) {
    process.env['JDAUTO_CONFIG_PATH'] = cfgPath;
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (child && state.running) {
    child.kill('SIGINT');
  }
  if (process.platform !== 'darwin') app.quit();
});
