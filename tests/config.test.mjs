import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, saveConfig } from '../dist/config.js';

function validConfig() {
  return {
    accounts: [{
      name: '账号1',
      profile: '账号1',
      browserProfileDir: 'Default',
      cdpPort: 9221,
    }],
    tasks: [{
      sku: '100218876132',
      flashSaleTime: '2026-07-27T12:00:00.000Z',
      maxRetries: 3,
    }],
  };
}

test('loadConfig validates and saveConfig atomically replaces Runtime Config', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jdauto-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'accounts.json');
  await writeFile(configPath, JSON.stringify(validConfig()), 'utf8');

  const loaded = loadConfig(configPath);
  assert.equal(loaded.accounts[0].profile, '账号1');

  loaded.accounts[0].name = '主账号';
  saveConfig(configPath, loaded);
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.accounts[0].name, '主账号');
});

test('loadConfig reports duplicate OpenCLI Profiles with a precise path', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jdauto-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'accounts.json');
  const config = validConfig();
  config.accounts.push({
    name: '账号2',
    profile: '账号1',
    browserProfileDir: 'Profile 2',
    cdpPort: 9222,
  });
  await writeFile(configPath, JSON.stringify(config), 'utf8');

  assert.throws(
    () => loadConfig(configPath),
    /accounts\[1\]\.profile 不能重复: 账号1/
  );
});

test('loadConfig rejects invalid order task data', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jdauto-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'accounts.json');
  const config = validConfig();
  config.tasks[0].flashSaleTime = 'not-a-date';
  await writeFile(configPath, JSON.stringify(config), 'utf8');

  assert.throws(
    () => loadConfig(configPath),
    /tasks\[0\]\.flashSaleTime 必须是有效时间/
  );
});
