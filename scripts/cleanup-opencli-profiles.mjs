#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
  };
}

function runOpenCli(cmd) {
  const cliPath = resolveOpenCliCliPath();
  const nodeExec = resolveNodeExecutable();
  if (cliPath) {
    const args = cmd.trim().split(/\s+/).slice(1); // strip leading `opencli`
    const argLine = args.map((x) => quoteArg(x)).join(' ');
    return execSync(`"${nodeExec}" "${cliPath}" ${argLine}`, {
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

function resolveNodeExecutable() {
  const envPath = process.env.JDAUTO_NODE_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  return process.execPath;
}

function quoteArg(v) {
  const s = String(v);
  if (!s.includes(' ')) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function resolveOpenCliCliPath() {
  const envPath = process.env.JDAUTO_OPENCLI_CLI_PATH;
  if (envPath) return envPath;
  const candidates = [
    path.join(path.dirname(process.execPath), 'resources', 'opencli-package', 'dist', 'src', 'main.js'),
    path.join(process.cwd(), 'app.asar', 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js'),
    path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js'),
    path.join(path.dirname(process.execPath), 'resources', 'app.asar.unpacked', 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js'),
    path.join(process.cwd(), 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function parseConnectedContextIds(raw) {
  const lines = raw.split(/\r?\n/);
  const ids = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^Disconnected saved profiles:/i.test(trimmed)) break;
    // 形如: tkhm4hgf 账号6 — connected v1.0.5
    const m = trimmed.match(/^([a-z0-9_-]+)\s+.+?—\s+connected\b/i);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function profileConfigPath() {
  const baseDir = process.env.OPENCLI_CONFIG_DIR || path.join(os.homedir(), '.opencli');
  return path.join(baseDir, 'browser-profiles.json');
}

function loadProfileConfig(filePath) {
  if (!fs.existsSync(filePath)) return { version: 1, aliases: {} };
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    version: 1,
    aliases: parsed?.aliases && typeof parsed.aliases === 'object' ? parsed.aliases : {},
    ...(typeof parsed?.defaultContextId === 'string' && parsed.defaultContextId ? { defaultContextId: parsed.defaultContextId } : {}),
  };
}

function saveProfileConfig(filePath, cfg) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let output = '';
  let opencliFailed = false;
  try {
    output = runOpenCli('opencli profile list');
  } catch (err) {
    opencliFailed = true;
    const out = String(err?.stdout || '');
    const errText = String(err?.stderr || '');
    output = `${out}\n${errText}`;
  }
  if (opencliFailed) {
    throw new Error(`opencli profile list 执行失败:\n${output.trim()}`);
  }

  const connectedIds = parseConnectedContextIds(output);
  const cfgPath = profileConfigPath();
  const cfg = loadProfileConfig(cfgPath);

  const aliases = Object.entries(cfg.aliases || {});
  const kept = {};
  const removed = [];
  for (const [alias, contextId] of aliases) {
    if (connectedIds.has(String(contextId))) {
      kept[alias] = contextId;
    } else {
      removed.push({ alias, contextId });
    }
  }

  const nextCfg = {
    version: 1,
    aliases: kept,
  };
  if (cfg.defaultContextId && connectedIds.has(String(cfg.defaultContextId))) {
    nextCfg.defaultContextId = cfg.defaultContextId;
  }

  if (args.dryRun) {
    console.log(`[cleanup] dry-run: 将删除 ${removed.length} 个未连接 profile 映射`);
    for (const x of removed) {
      console.log(`  - ${x.contextId} ${x.alias}`);
    }
    return;
  }

  saveProfileConfig(cfgPath, nextCfg);
  console.log(`[cleanup] 已清理完成: 删除 ${removed.length} 个未连接 profile 映射，保留 ${Object.keys(kept).length} 个。`);
  if (removed.length > 0) {
    for (const x of removed) {
      console.log(`  - ${x.contextId} ${x.alias}`);
    }
  }
  if (cfg.defaultContextId && !connectedIds.has(String(cfg.defaultContextId))) {
    console.log(`[cleanup] 已移除失效默认 profile: ${cfg.defaultContextId}`);
  }
}

main();
