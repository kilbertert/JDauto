#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
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
  const profileLines = lines.filter((line) => /connected/i.test(line) && !/^Connected Browser Bridge profiles/i.test(line));

  return profileLines
    .map((line) => {
      const m = line.match(/^(\S+)\s+(.+?)\s+connected\b/i);
      if (!m) return null;
      const contextId = m[1];
      let alias = m[2]
        .replace(/\bdefault\b/gi, '')
        .replace(/[—-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!alias) alias = '';
      return { contextId, alias };
    })
    .filter(Boolean);
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
  return execSync(cmd, { encoding: 'utf8' });
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
  const chromePath = accounts[0]?.chromePath || DEFAULT_EDGE_PATH;

  let nextPort = getNextPort(accounts);
  const renamed = [];
  const renameFailed = [];
  const skippedNoAlias = [];
  let added = 0;

  // 先自动重命名无别名 profile，保证后续可同步到 accounts.json
  for (const p of connected) {
    if (p.alias || !args.autoRename) continue;
    const alias = getNextAlias(usedAliases, args.prefix, args.startIndex);
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
      chromePath,
      cdpPort: nextPort++,
    });
    profileSet.add(p.alias);
    added++;
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
