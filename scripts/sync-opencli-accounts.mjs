#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEFAULT_CONFIG_PATH = path.join(process.cwd(), 'config', 'accounts.json');

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG_PATH,
    autoRename: true,
    prefix: '账号',
    startIndex: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      args.config = path.resolve(argv[i + 1]);
      i++;
      continue;
    }
    if (argv[i] === '--no-rename') {
      args.autoRename = false;
      continue;
    }
    if (argv[i] === '--prefix' && argv[i + 1]) {
      args.prefix = String(argv[i + 1]);
      i++;
      continue;
    }
    if (argv[i] === '--start-index' && argv[i + 1]) {
      const n = Number.parseInt(String(argv[i + 1]), 10);
      if (Number.isInteger(n) && n > 0) args.startIndex = n;
      i++;
    }
  }
  return args;
}

function parseOpenCliProfiles(raw) {
  const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const profileLines = lines.filter((line) => {
    if (/^Connected Browser Bridge profiles/i.test(line)) return false;
    if (/\bnot\s+connected\b/i.test(line)) return false;
    return /\bconnected\b/i.test(line);
  });

  return profileLines
    .map((line) => {
      const m = line.match(/^(\S+)(?:\s+(.+?))?\s+connected\b/i);
      if (!m) return null;
      const contextId = m[1];
      let alias = String(m[2] ?? '')
        .replace(/\bdefault\b/gi, '')
        .replace(/[—-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!alias) alias = '';
      return { contextId, alias };
    })
    .filter(Boolean);
}

function isStandardAlias(alias) {
  return /^账号\d+$/.test(String(alias || '').trim());
}

function getNextPort(existingAccounts) {
  const maxPort = existingAccounts.reduce((max, a) => {
    if (typeof a.cdpPort === 'number' && Number.isFinite(a.cdpPort)) {
      return Math.max(max, a.cdpPort);
    }
    return max;
  }, 9220);
  return maxPort + 1;
}

function getNextAlias(usedAliases, prefix, startIndex) {
  let i = startIndex;
  while (usedAliases.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

function runOpenCli(cmd) {
  const cliPath = resolveOpenCliCliPath();
  if (cliPath) {
    const args = cmd.trim().split(/\s+/).slice(1); // strip leading `opencli`
    const argLine = args.map((x) => quoteArg(x)).join(' ');
    return execSync(`"${process.execPath}" "${cliPath}" ${argLine}`, {
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      windowsHide: true,
    });
  }
  return execSync(cmd, { encoding: 'utf8' });
}

function quoteArg(v) {
  const s = String(v);
  if (!s.includes(' ')) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function resolveOpenCliCliPath() {
  const envPath = process.env.JDAUTO_OPENCLI_CLI_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const candidates = [
    path.join(process.cwd(), 'node_modules', '@jackwener', 'opencli', 'dist', 'cli.js'),
    path.join(process.cwd(), 'app.asar', 'node_modules', '@jackwener', 'opencli', 'dist', 'cli.js'),
    path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'node_modules', '@jackwener', 'opencli', 'dist', 'cli.js'),
    path.join(path.dirname(process.execPath), 'resources', 'app.asar.unpacked', 'node_modules', '@jackwener', 'opencli', 'dist', 'cli.js'),
    path.join(os.homedir(), '.opencli', 'cli.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config;
  if (!fs.existsSync(configPath)) {
    throw new Error(`配置文件不存在: ${configPath}`);
  }

  const opencliOutput = runOpenCli('opencli profile list');
  const connected = parseOpenCliProfiles(opencliOutput);

  if (connected.length === 0) {
    console.log('[sync] 未检测到已连接的 Browser Bridge profile，未修改配置。');
    return;
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(raw);
  const accounts = Array.isArray(cfg.accounts) ? [...cfg.accounts] : [];
  const profileSet = new Set(accounts.map((a) => String(a.profile)));
  const usedAliases = new Set([
    ...accounts.map((a) => String(a.profile)),
    ...connected.map((p) => p.alias).filter(Boolean),
  ]);
  const standardAliasesFromConfig = accounts
    .map((a) => String(a.profile))
    .filter((x) => isStandardAlias(x));
  const connectedNamedAliases = new Set(
    connected.map((p) => String(p.alias || '').trim()).filter(Boolean)
  );
  const availableStandardAliases = standardAliasesFromConfig.filter((x) => !connectedNamedAliases.has(x));
  const chromePath = accounts[0]?.chromePath || DEFAULT_EDGE_PATH;
  const browserUserDataDir = accounts[0]?.browserUserDataDir;

  let nextPort = getNextPort(accounts);
  const renamed = [];
  const renameFailed = [];
  const skippedNoAlias = [];
  let added = 0;

  // 先自动重命名无别名 profile，保证后续可同步到 accounts.json
  for (const p of connected) {
    if (p.alias || !args.autoRename) continue;
    const alias = availableStandardAliases.shift() ?? getNextAlias(usedAliases, args.prefix, args.startIndex);
    try {
      runOpenCli(`opencli profile rename ${p.contextId} ${alias}`);
      p.alias = alias;
      usedAliases.add(alias);
      renamed.push({ contextId: p.contextId, alias });
    } catch {
      renameFailed.push(p.contextId);
    }
  }

  // 再同步到配置
  for (const p of connected) {
    if (!p.alias) {
      skippedNoAlias.push(p.contextId);
      continue;
    }
    if (profileSet.has(p.alias)) continue;
    accounts.push({
      name: p.alias,
      profile: p.alias,
      browserProfileDir: p.alias,
      ...(browserUserDataDir ? { browserUserDataDir } : {}),
      opencliContextId: p.contextId,
      chromePath,
      cdpPort: nextPort++,
    });
    profileSet.add(p.alias);
    added++;
  }

  // 对已有账号回填 opencliContextId（便于追踪映射）
  const contextByAlias = new Map(
    connected
      .filter((p) => p.alias)
      .map((p) => [String(p.alias), String(p.contextId)])
  );
  for (const acc of accounts) {
    const alias = String(acc.profile || '');
    if (contextByAlias.has(alias)) {
      acc.opencliContextId = contextByAlias.get(alias);
    }
  }

  // 默认 profile：优先账号1，其次第一个已连接 contextId
  const hasAliasAccount1 = connected.some((p) => p.alias === '账号1');
  try {
    if (hasAliasAccount1) {
      runOpenCli('opencli profile use 账号1');
    } else if (connected[0]?.contextId) {
      runOpenCli(`opencli profile use ${connected[0].contextId}`);
    }
  } catch {
    // ignore: default selection best effort
  }

  cfg.accounts = accounts;
  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

  console.log(`[sync] 已同步完成: 新增 ${added} 个账号，当前共 ${accounts.length} 个账号。`);
  if (renamed.length > 0) {
    console.log(`[sync] 已自动重命名 ${renamed.length} 个 profile:`);
    for (const x of renamed) {
      console.log(`  - ${x.contextId} -> ${x.alias}`);
    }
  }
  if (renameFailed.length > 0) {
    console.log('[sync] 以下 profile 自动重命名失败:');
    for (const id of renameFailed) {
      console.log(`  - ${id}`);
      console.log(`    手动执行: opencli profile rename ${id} ${args.prefix}X`);
    }
  }
  if (skippedNoAlias.length > 0) {
    console.log('[sync] 以下 profile 尚未命名别名，已跳过同步:');
    for (const id of skippedNoAlias) {
      console.log(`  - ${id}`);
      console.log(`    建议: opencli profile rename ${id} ${args.prefix}X`);
    }
  }
}

main();
