import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import type { JDAutoConfig, ChromeAccount } from '../config.js';
import { resolveBrowserExecutablePath } from '../browser-path.js';

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

interface InitProfilesPayload {
  count?: number;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MAX_LOG_LINES = 800;
const DAEMON_READY_CACHE_MS = 30_000;

let mainWindow: BrowserWindow | null = null;
let child: ChildProcessWithoutNullStreams | null = null;
let stdoutBuffer = '';
let stderrBuffer = '';
let daemonWarmupPromise: Promise<void> | null = null;
let lastDaemonReadyAt = 0;

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

function resolveSyncScriptPath(): string {
  const devPath = path.join(PROJECT_ROOT, 'scripts', 'sync-opencli-accounts.mjs');
  const packagedPath = path.join(process.resourcesPath, 'scripts', 'sync-opencli-accounts.mjs');
  const found = app.isPackaged
    ? findFirstExisting([packagedPath, devPath])
    : findFirstExisting([devPath, packagedPath]);
  if (!found) {
    throw new Error(`未找到同步脚本: ${devPath} 或 ${packagedPath}`);
  }
  return found;
}

function resolveCleanupScriptPath(): string {
  const devPath = path.join(PROJECT_ROOT, 'scripts', 'cleanup-opencli-profiles.mjs');
  const packagedPath = path.join(process.resourcesPath, 'scripts', 'cleanup-opencli-profiles.mjs');
  const found = app.isPackaged
    ? findFirstExisting([packagedPath, devPath])
    : findFirstExisting([devPath, packagedPath]);
  if (!found) {
    throw new Error(`未找到清理脚本: ${devPath} 或 ${packagedPath}`);
  }
  return found;
}

function resolveOpenCliCliPath(): string | null {
  const envPath = process.env['JDAUTO_OPENCLI_CLI_PATH'];
  if (envPath && fs.existsSync(envPath)) return envPath;
  const devPath = path.join(PROJECT_ROOT, 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js');
  const bundledResourcePath = path.join(process.resourcesPath, 'opencli-package', 'dist', 'src', 'main.js');
  const appAsarPath = path.join(process.resourcesPath, 'app.asar', 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js');
  const appUnpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js');
  return app.isPackaged
    ? findFirstExisting([bundledResourcePath, appAsarPath, appUnpackedPath, devPath])
    : findFirstExisting([devPath, bundledResourcePath, appAsarPath, appUnpackedPath]);
}

function resolveNodeRuntimePath(): string {
  const envPath = process.env['JDAUTO_NODE_PATH'];
  if (envPath && fs.existsSync(envPath)) return envPath;
  const binary = process.platform === 'win32' ? 'node.exe' : 'node';
  const devPath = path.join(PROJECT_ROOT, 'vendor', 'node-runtime', binary);
  const packagedPath = path.join(process.resourcesPath, 'node-runtime', binary);
  return app.isPackaged
    ? (findFirstExisting([packagedPath, devPath]) ?? process.execPath)
    : (findFirstExisting([devPath, packagedPath]) ?? process.execPath);
}

function resolveExtensionDir(): string {
  const envPath = process.env['JDAUTO_OPENCLI_EXTENSION_DIR'];
  if (envPath && fs.existsSync(envPath)) return envPath;

  const local = process.env['LOCALAPPDATA'];
  const stableDir = local
    ? path.join(local, 'JDauto', 'opencli-extension')
    : path.join(PROJECT_ROOT, '.jdauto-opencli-extension');
  if (fs.existsSync(stableDir)) return stableDir;

  const candidates = [
    path.join(PROJECT_ROOT, 'OpenCLI-main', 'extension'),
    path.join(PROJECT_ROOT, 'opencli-extension'),
    path.join(process.resourcesPath, 'opencli-extension'),
    path.join(process.resourcesPath, 'OpenCLI-main', 'extension'),
  ];
  const found = findFirstExisting(candidates);
  if (!found) {
    throw new Error('未找到 OpenCLI 扩展目录，请先配置 JDAUTO_OPENCLI_EXTENSION_DIR 或确保 OpenCLI-main/extension 存在');
  }
  return found;
}

function ensureStableExtensionDir(): string {
  const local = process.env['LOCALAPPDATA'];
  const stableDir = local
    ? path.join(local, 'JDauto', 'opencli-extension')
    : path.join(PROJECT_ROOT, '.jdauto-opencli-extension');

  const sourceCandidates = [
    path.join(PROJECT_ROOT, 'OpenCLI-main', 'extension'),
    path.join(PROJECT_ROOT, 'opencli-extension'),
    path.join(process.resourcesPath, 'opencli-extension'),
    path.join(process.resourcesPath, 'OpenCLI-main', 'extension'),
  ];
  const source = findFirstExisting(sourceCandidates);
  if (!source) {
    throw new Error('未找到可复制的 OpenCLI 扩展源目录');
  }

  const sourceManifest = path.join(source, 'manifest.json');
  if (!fs.existsSync(sourceManifest)) {
    throw new Error(`扩展源目录缺少 manifest.json: ${source}`);
  }

  fs.mkdirSync(path.dirname(stableDir), { recursive: true });
  // 使用固定目录，避免每次打包路径变化导致浏览器中的 unpacked 扩展失效
  fs.cpSync(source, stableDir, { recursive: true, force: true });
  return stableDir;
}

function resolveBrowserUserDataDir(): string {
  const local = process.env['LOCALAPPDATA'];
  if (local) {
    return path.join(local, 'JDauto', 'EdgeUserData');
  }
  return path.join(PROJECT_ROOT, '.jdauto-edge-user-data');
}

function isStandardAccountProfile(name: string): boolean {
  return /^账号\d+$/.test(name);
}

function getStandardProfileIndex(name: string): number | null {
  const m = String(name).match(/^账号(\d+)$/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isInteger(n) ? n : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function shouldDisplayLog(line: string): boolean {
  const text = stripAnsi(line).trim();
  if (!text) return false;

  const keepPatterns = [
    /^启动任务:/,
    /^任务结束:/,
    /^已发送停止信号/,
    /^开始同步 OpenCLI Profile/,
    /^Profile 同步完成/,
    /^Profile 同步失败/,
    /^开始设置默认 Profile:/,
    /^默认 Profile 已设置:/,
    /^设置默认 Profile 失败:/,
    /^未检测到已连接 OpenCLI Profile，跳过设置默认 Profile/,
    /^开始启动 OpenCLI daemon/,
    /^OpenCLI daemon 已就绪/,
    /^OpenCLI daemon 启动失败:/,
    /^浏览器可执行文件:/,
    /^开始清理 OpenCLI 历史 profile/,
    /^OpenCLI 历史 profile 清理完成/,
    /^OpenCLI profile 清理失败/,
    /^开始初始化 Profile/,
    /^初始化完成/,
    /^已创建并启动:/,
    /^已清理异常账号/,
    /^同步后标准账号已收敛:/,
    /^已收敛账号列表:/,
    /^请先在新打开的浏览器窗口中登录账号并确认插件为 connected/,
    /\[(Main|Manager|Scheduler|账号\d+)\]/,
    /\b(PREPARE|EXECUTE|PAYMENT)\b/,
    /Browser Bridge/,
    /连接超时/,
    /没有可用账号/,
    /\bFatal\b/,
    /提交订单/,
    /支付/,
    /结算/,
    /加购/,
    /购物车/,
    /任务/,
  ];
  if (keepPatterns.some((pattern) => pattern.test(text))) return true;

  const dropPatterns = [
    /^Node 运行时:/,
    /^OpenCLI 已内置:/,
    /^扩展目录已就绪:/,
    /^扩展目录:/,
    /^浏览器数据目录:/,
    /^提示：opencli doctor/,
    /^Extension update available:/i,
    /^Download:/,
    /^Current runtime:/,
    /^Upgrade Node\.js/i,
    /^Usage: opencli\b/i,
    /^Options:/,
    /^Commands:/,
    /^error: unknown command\b/i,
    /^at /,
    /^node:/,
    /^const err = new Error/,
    /^throw new /,
    /^pid:/,
    /^stdout:/,
    /^stderr:/,
    /^signal:/,
    /^status:/,
    /^output:\s*\[/,
  ];
  if (dropPatterns.some((pattern) => pattern.test(text))) return false;
  return false;
}

function addLog(line: string): void {
  const clean = stripAnsi(line).trim();
  if (!clean || !shouldDisplayLog(clean)) return;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildStartArgs(payload: StartRequestBody): {
  args: string[];
  password: string;
  commandPreview: string;
  startSummary: string;
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
  const startSummary = `启动任务: SKU=${sku} 抢购时间=${normalizedTime} 启用账号=${accountsRaw ? String(accountsRaw) : '全部'}${manual ? ' 手动模式=是' : ''}`;
  return { args, password, commandPreview, startSummary };
}

async function ensureOpenCliDaemonReady(reason: string, force = false): Promise<void> {
  const now = Date.now();
  if (!force && daemonWarmupPromise) {
    await daemonWarmupPromise;
    return;
  }
  if (!force && lastDaemonReadyAt > 0 && now - lastDaemonReadyAt < DAEMON_READY_CACHE_MS) {
    return;
  }

  daemonWarmupPromise = (async () => {
    addLog(`开始启动 OpenCLI daemon (${reason})...`);
    const result = await runOpenCliCommand(['doctor']);
    const combined = stripAnsi(`${result.stdout}\n${result.stderr}`);
    const daemonRunning = /\[OK\]\s+Daemon:\s+running\b/i.test(combined);
    if (!daemonRunning) {
      addMultilineLog(result.stdout, false);
      addMultilineLog(result.stderr, true);
      addLog(`OpenCLI daemon 启动失败: ${reason}`);
      throw new Error(`OpenCLI daemon 未就绪: ${reason}`);
    }

    if (/Starting daemon/i.test(combined)) {
      await sleep(1500);
    }

    lastDaemonReadyAt = Date.now();
    addLog('OpenCLI daemon 已就绪');
  })();

  try {
    await daemonWarmupPromise;
  } finally {
    daemonWarmupPromise = null;
  }
}

async function startJob(payload: StartRequestBody): Promise<void> {
  if (state.running) {
    throw new Error('任务已在运行，请先停止当前任务');
  }

  ensureDistBuilt();
  await ensureOpenCliDaemonReady('开始任务前');
  const { args, password, commandPreview, startSummary } = buildStartArgs(payload);

  state.running = true;
  state.startedAt = nowIso();
  state.endedAt = undefined;
  state.exitCode = undefined;
  state.command = commandPreview;
  state.logs = [];
  stdoutBuffer = '';
  stderrBuffer = '';

  addLog(startSummary);
  const cfgPath = resolveConfigPath();
  const nodeExec = resolveNodeRuntimePath();
  child = spawn(nodeExec, args, {
    cwd: app.isPackaged ? process.resourcesPath : PROJECT_ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      JDAUTO_PASSWORD: password,
      ...(cfgPath ? { JDAUTO_CONFIG_PATH: cfgPath } : {}),
      JDAUTO_NODE_PATH: nodeExec,
      ...(process.env['JDAUTO_OPENCLI_CLI_PATH'] ? { JDAUTO_OPENCLI_CLI_PATH: process.env['JDAUTO_OPENCLI_CLI_PATH'] } : {}),
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

function nextPort(accounts: ChromeAccount[]): number {
  const max = accounts.reduce((m, a) => {
    if (typeof a.cdpPort === 'number' && Number.isFinite(a.cdpPort)) return Math.max(m, a.cdpPort);
    return m;
  }, 9220);
  return max + 1;
}

function loadConfigFile(): { cfg: JDAutoConfig; configPath: string } {
  const configPath = resolveConfigPath();
  if (!configPath) {
    throw new Error('未找到 accounts.json');
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(raw) as JDAutoConfig;
  if (!Array.isArray(cfg.accounts)) cfg.accounts = [];
  if (!Array.isArray(cfg.tasks)) cfg.tasks = [];
  return { cfg, configPath };
}

function saveConfigFile(configPath: string, cfg: JDAutoConfig): void {
  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

function launchProfileWindow(browserPath: string, userDataDir: string, profileDir: string, cdpPort: number, extensionDir: string): void {
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileDir}`,
    `--remote-debugging-port=${cdpPort}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://www.jd.com/',
  ];
  const proc = spawn(browserPath, args, {
    detached: false,
    stdio: 'ignore',
    shell: false,
    windowsHide: false,
  });
  proc.unref();
}

async function runNodeScript(scriptPath: string, scriptArgs: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const nodeExec = resolveNodeRuntimePath();
    const proc = spawn(nodeExec, [scriptPath, ...scriptArgs], {
      cwd: app.isPackaged ? process.resourcesPath : PROJECT_ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        JDAUTO_NODE_PATH: nodeExec,
        ...(process.env['JDAUTO_OPENCLI_CLI_PATH'] ? { JDAUTO_OPENCLI_CLI_PATH: process.env['JDAUTO_OPENCLI_CLI_PATH'] } : {}),
      },
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += String(chunk); });
    proc.stderr.on('data', (chunk) => { stderr += String(chunk); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function runOpenCliCommand(cliArgs: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const cliEntry = resolveOpenCliCliPath();
  if (!cliEntry) {
    throw new Error('未找到 OpenCLI CLI 入口');
  }
  return new Promise((resolve, reject) => {
    const nodeExec = resolveNodeRuntimePath();
    const proc = spawn(nodeExec, [cliEntry, ...cliArgs], {
      cwd: app.isPackaged ? process.resourcesPath : PROJECT_ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        JDAUTO_NODE_PATH: nodeExec,
        JDAUTO_OPENCLI_CLI_PATH: cliEntry,
      },
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += String(chunk); });
    proc.stderr.on('data', (chunk) => { stderr += String(chunk); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

interface ConnectedOpenCliProfile {
  contextId: string;
  alias: string;
}

function parseConnectedOpenCliProfiles(raw: string): ConnectedOpenCliProfile[] {
  const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const profiles: ConnectedOpenCliProfile[] = [];
  for (const line of lines) {
    if (/^Connected Browser Bridge profiles/i.test(line)) continue;
    if (/^Disconnected saved profiles:/i.test(line)) break;
    if (!/\bconnected\b/i.test(line)) continue;
    if (/\bnot\s+connected\b/i.test(line)) continue;
    const m = line.match(/^(\S+)(?:\s+(.+?))?\s+connected\b/i);
    if (!m) continue;
    let alias = String(m[2] || '')
      .replace(/\bdefault\b/gi, '')
      .replace(/[—-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!alias) alias = '';
    profiles.push({
      contextId: String(m[1] || '').trim(),
      alias,
    });
  }
  return profiles;
}

async function getConnectedOpenCliProfiles(): Promise<ConnectedOpenCliProfile[]> {
  const result = await runOpenCliCommand(['profile', 'list']);
  if (result.exitCode !== 0) {
    addMultilineLog(result.stdout, false);
    addMultilineLog(result.stderr, true);
    throw new Error(`读取 OpenCLI profile 列表失败 (exitCode=${result.exitCode})`);
  }
  return parseConnectedOpenCliProfiles(result.stdout);
}

function addMultilineLog(text: string, isErr = false): void {
  for (const line of text.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean) continue;
    addLog(isErr ? `[ERR] ${clean}` : clean);
  }
}

async function syncProfiles(): Promise<void> {
  if (state.running) {
    throw new Error('任务运行中，无法同步 Profile，请先停止任务');
  }
  await ensureOpenCliDaemonReady('同步 Profile 前');
  const before = loadConfigFile();
  const baselineStandardSet = new Set(
    before.cfg.accounts
      .map((a) => String(a.profile || ''))
      .filter((p) => isStandardAccountProfile(p))
  );

  const scriptPath = resolveSyncScriptPath();
  const cfgPath = resolveConfigPath();
  const args: string[] = [];
  if (cfgPath) {
    args.push('--config', cfgPath);
  }

  addLog('开始同步 OpenCLI Profile...');
  const result = await runNodeScript(scriptPath, args);
  addMultilineLog(result.stdout, false);
  addMultilineLog(result.stderr, true);

  if (result.exitCode !== 0) {
    addLog(`Profile 同步失败，exitCode=${result.exitCode}`);
    throw new Error(`同步失败 (exitCode=${result.exitCode})`);
  }

  // 防止同步把历史连接的标准账号（例如 账号6..账号10）追加回来导致数量膨胀。
  // 策略：标准账号仅允许保留“同步前已有集合”；非标准账号仍可新增。
  const after = loadConfigFile();
  const rawCount = after.cfg.accounts.length;
  after.cfg.accounts = after.cfg.accounts.filter((a) => {
    const profile = String(a.profile || '').trim();
    if (!profile) return false;
    if (!isStandardAccountProfile(profile)) return true;
    return baselineStandardSet.has(profile);
  });
  if (after.cfg.accounts.length !== rawCount) {
    addLog(`同步后标准账号已收敛: ${rawCount} -> ${after.cfg.accounts.length}`);
    saveConfigFile(after.configPath, after.cfg);
  }

  const connectedProfiles = await getConnectedOpenCliProfiles();
  if (connectedProfiles.length === 0) {
    addLog('未检测到已连接 OpenCLI Profile，跳过设置默认 Profile');
    addLog('Profile 同步完成');
    return;
  }

  const connectedContextSet = new Set(connectedProfiles.map((p) => p.contextId));
  const preferredAccount =
    after.cfg.accounts.find((a) => String(a.profile || '').trim() === '账号1' && a.opencliContextId && connectedContextSet.has(a.opencliContextId))
    || after.cfg.accounts.find((a) => Boolean(a.opencliContextId && connectedContextSet.has(a.opencliContextId) && isStandardAccountProfile(String(a.profile || '').trim())))
    || after.cfg.accounts.find((a) => Boolean(a.opencliContextId && connectedContextSet.has(a.opencliContextId)));

  const defaultProfileArg =
    preferredAccount?.opencliContextId
    || connectedProfiles.find((p) => p.alias === '账号1')?.contextId
    || connectedProfiles[0]?.contextId;

  const defaultProfileLabel =
    preferredAccount?.profile
    || connectedProfiles.find((p) => p.alias === '账号1')?.alias
    || connectedProfiles[0]?.alias
    || connectedProfiles[0]?.contextId;

  if (defaultProfileArg) {
    addLog(`开始设置默认 Profile: ${defaultProfileLabel}`);
    const defaultResult = await runOpenCliCommand(['profile', 'use', defaultProfileArg]);
    addMultilineLog(defaultResult.stdout, false);
    addMultilineLog(defaultResult.stderr, true);
    if (defaultResult.exitCode !== 0) {
      addLog(`设置默认 Profile 失败: ${defaultProfileLabel} (exitCode=${defaultResult.exitCode})`);
      throw new Error(`设置默认 Profile 失败: ${defaultProfileLabel}`);
    }
    addLog(`默认 Profile 已设置: ${defaultProfileLabel}`);
  }

  addLog('Profile 同步完成');
}

async function cleanupOpencliProfiles(): Promise<void> {
  if (state.running) {
    throw new Error('任务运行中，无法清理 OpenCLI profile，请先停止任务');
  }
  const scriptPath = resolveCleanupScriptPath();
  addLog('开始清理 OpenCLI 历史 profile...');
  const result = await runNodeScript(scriptPath, []);
  addMultilineLog(result.stdout, false);
  addMultilineLog(result.stderr, true);
  if (result.exitCode !== 0) {
    addLog(`OpenCLI profile 清理失败，exitCode=${result.exitCode}`);
    throw new Error(`清理失败 (exitCode=${result.exitCode})`);
  }
  addLog('OpenCLI 历史 profile 清理完成');
}

async function initProfiles(payload: InitProfilesPayload): Promise<void> {
  if (state.running) {
    throw new Error('任务运行中，无法初始化 Profile，请先停止任务');
  }
  await ensureOpenCliDaemonReady('初始化 Profile 前');

  const count = Number(payload.count ?? 0);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error('初始化数量必须是大于 0 的整数');
  }

  const { cfg, configPath } = loadConfigFile();
  const extensionDir = resolveExtensionDir();
  const userDataDir = resolveBrowserUserDataDir();
  const browserPath = resolveBrowserExecutablePath(cfg.accounts[0]?.chromePath);
  if (!fs.existsSync(browserPath)) {
    throw new Error(`浏览器路径不存在: ${browserPath}`);
  }

  addLog(`开始初始化 Profile，数量=${count}`);
  addLog(`浏览器可执行文件: ${browserPath}`);
  addLog(`扩展目录: ${extensionDir}`);
  addLog(`浏览器数据目录: ${userDataDir}`);

  const beforeCount = cfg.accounts.length;
  // 清理明显错误的自动账号，避免 "账号1 not"、"Browser Bridge profiles" 污染配置
  cfg.accounts = cfg.accounts.filter((a) => {
    const p = String(a.profile || '').trim();
    if (!p) return false;
    if (/^Browser Bridge profiles$/i.test(p)) return false;
    if (/\bnot\b/i.test(p)) return false;
    return true;
  });
  const afterInvalidCleanup = cfg.accounts.length;
  if (afterInvalidCleanup < beforeCount) {
    addLog(`已清理异常账号 ${beforeCount - afterInvalidCleanup} 个`);
  }

  // 一键初始化采用“重建标准账号”的方式，避免累计叠加
  let port = nextPort([]);
  const generated: ChromeAccount[] = [];
  const targetProfileSet = new Set<string>();
  for (let i = 1; i <= count; i++) {
    const alias = `账号${i}`;
    targetProfileSet.add(alias);
    generated.push({
      name: alias,
      profile: alias,
      browserProfileDir: alias,
      browserUserDataDir: userDataDir,
      chromePath: browserPath,
      cdpPort: port++,
    });
  }
  cfg.accounts = generated;

  for (const account of generated) {
    launchProfileWindow(
      browserPath,
      userDataDir,
      account.browserProfileDir ?? account.profile,
      account.cdpPort ?? 9221,
      extensionDir
    );
    addLog(`已创建并启动: ${account.profile} (port=${account.cdpPort})`);
  }

  saveConfigFile(configPath, cfg);
  addLog(`初始化完成，标准账号重建为 ${generated.length} 个`);
  addLog('请先在新打开的浏览器窗口中登录账号并确认插件为 connected，再手动点击“同步Profile”');
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
      <div class="row"><label for="initCount">初始化Profile数量</label><input id="initCount" type="number" min="1" value="1" /></div>
      <div class="row"><label for="manual">手动模式</label><input id="manual" type="checkbox" /></div>
      <div class="inline">
        <button id="startBtn">开始任务</button>
        <button id="stopBtn">停止任务</button>
        <button id="syncBtn">同步Profile</button>
        <button id="cleanBtn">清理OpenCLI</button>
        <button id="initBtn">一键初始化Profile</button>
        <button id="refreshBtn">刷新状态</button>
      </div>
      <p class="muted">配置概览：<span id="cfg"></span></p>
    </div>

    <div class="card">
      <p>当前状态：<span id="running" class="status warn">未知</span></p>
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
      const timingEl = document.getElementById('timing');
      const cfgEl = document.getElementById('cfg');
      const startBtn = document.getElementById('startBtn');
      const stopBtn = document.getElementById('stopBtn');
      const syncBtn = document.getElementById('syncBtn');
      const cleanBtn = document.getElementById('cleanBtn');
      const initBtn = document.getElementById('initBtn');
      const refreshBtn = document.getElementById('refreshBtn');
      const editableInputIds = ['sku', 'time', 'password', 'maxRetries', 'prepareAhead', 'accounts', 'initCount', 'manual'];

      function toNum(v) {
        if (v === '' || v === null || v === undefined) return undefined;
        return Number(v);
      }

      function ensureInputsEditable() {
        for (const id of editableInputIds) {
          const el = document.getElementById(id);
          if (!el) continue;
          el.disabled = false;
          if (Object.prototype.hasOwnProperty.call(el, 'readOnly')) {
            el.readOnly = false;
          }
        }
      }

      function renderState(s) {
        ensureInputsEditable();
        runningEl.textContent = s.running ? '运行中' : '空闲';
        runningEl.className = 'status ' + (s.running ? 'ok' : 'warn');
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

      syncBtn.addEventListener('click', async () => {
        syncBtn.disabled = true;
        syncBtn.textContent = '同步中...';
        try {
          await ipcRenderer.invoke('jdauto:sync-profiles');
          await refresh();
          alert('Profile 同步完成');
        } catch (err) {
          alert(String(err));
        } finally {
          syncBtn.disabled = false;
          syncBtn.textContent = '同步Profile';
        }
      });

      cleanBtn.addEventListener('click', async () => {
        cleanBtn.disabled = true;
        cleanBtn.textContent = '清理中...';
        try {
          await ipcRenderer.invoke('jdauto:cleanup-opencli-profiles');
          await refresh();
          alert('OpenCLI 历史 profile 清理完成');
        } catch (err) {
          alert(String(err));
        } finally {
          cleanBtn.disabled = false;
          cleanBtn.textContent = '清理OpenCLI';
        }
      });

      initBtn.addEventListener('click', async () => {
        const count = toNum(document.getElementById('initCount').value);
        initBtn.disabled = true;
        initBtn.textContent = '初始化中...';
        try {
          await ipcRenderer.invoke('jdauto:init-profiles', { count });
          await refresh();
          alert('Profile 初始化完成，请在新开的浏览器窗口中登录账号并确认插件连接');
        } catch (err) {
          alert(String(err));
        } finally {
          initBtn.disabled = false;
          initBtn.textContent = '一键初始化Profile';
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
ipcMain.handle('jdauto:start', async (_event, payload: StartRequestBody) => {
  await startJob(payload);
  return getState();
});
ipcMain.handle('jdauto:stop', () => {
  stopJob();
  return getState();
});
ipcMain.handle('jdauto:sync-profiles', async () => {
  await syncProfiles();
  // 普通同步也做一次轻量清理，移除明显污染项
  const loaded = loadConfigFile();
  const before = loaded.cfg.accounts.length;
  loaded.cfg.accounts = loaded.cfg.accounts.filter((a) => {
    const p = String(a.profile || '').trim();
    if (!p) return false;
    if (/^Browser Bridge profiles$/i.test(p)) return false;
    if (/\bnot\b/i.test(p)) return false;
    return true;
  });
  if (loaded.cfg.accounts.length !== before) {
    addLog(`已清理异常账号 ${before - loaded.cfg.accounts.length} 个`);
    saveConfigFile(loaded.configPath, loaded.cfg);
  }
  return getState();
});
ipcMain.handle('jdauto:cleanup-opencli-profiles', async () => {
  await cleanupOpencliProfiles();
  return getState();
});
ipcMain.handle('jdauto:init-profiles', async (_event, payload: InitProfilesPayload) => {
  await initProfiles(payload ?? {});
  return getState();
});

app.whenReady().then(() => {
  const cfgPath = resolveConfigPath();
  if (cfgPath) {
    process.env['JDAUTO_CONFIG_PATH'] = cfgPath;
  }
  try {
    process.env['JDAUTO_OPENCLI_EXTENSION_DIR'] = ensureStableExtensionDir();
    addLog(`扩展目录已就绪: ${process.env['JDAUTO_OPENCLI_EXTENSION_DIR']}`);
  } catch {
    // ignore: extension may not exist yet, only required when init/start with auto extension
  }
  const opencliCliPath = resolveOpenCliCliPath();
  const nodeRuntimePath = resolveNodeRuntimePath();
  const browserPath = resolveBrowserExecutablePath();
  process.env['JDAUTO_NODE_PATH'] = nodeRuntimePath;
  process.env['JDAUTO_BROWSER_PATH'] = browserPath;
  addLog(`Node 运行时: ${nodeRuntimePath}`);
  addLog(`浏览器可执行文件: ${browserPath}`);
  if (opencliCliPath) {
    process.env['JDAUTO_OPENCLI_CLI_PATH'] = opencliCliPath;
    addLog(`OpenCLI 已内置: ${opencliCliPath}`);
  } else {
    addLog('[WARN] 未找到内置 OpenCLI CLI，回退系统 opencli 命令');
  }
  createWindow();
  if (opencliCliPath) {
    void ensureOpenCliDaemonReady('应用启动', true).catch((err) => {
      addLog(`[ERR] ${String(err)}`);
    });
  }
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
