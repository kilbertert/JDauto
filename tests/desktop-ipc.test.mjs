import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DESKTOP_IPC_CHANNELS } from '../dist/desktop/ipc-contract.cjs';

test('desktop IPC Interface exposes the complete renderer operation set', () => {
  assert.deepEqual(Object.keys(DESKTOP_IPC_CHANNELS), [
    'getState',
    'start',
    'stop',
    'syncProfiles',
    'cleanupProfiles',
    'initProfiles',
  ]);
});

test('desktop renderer is isolated behind the preload IPC Adapter', async () => {
  const main = await readFile(
    new URL('../dist/desktop/main.js', import.meta.url),
    'utf8'
  );
  const preload = await readFile(
    new URL('../dist/desktop/preload.cjs', import.meta.url),
    'utf8'
  );

  assert.match(main, /preload:\s*path\.join\(__dirname,\s*'preload\.cjs'\)/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /const api = window\.jdauto/);
  assert.doesNotMatch(main, /require\(['"]electron['"]\)/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\(['"]jdauto['"], api\)/);
  for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) {
    assert.equal(preload.includes(`'${channel}'`), true, `preload is missing ${channel}`);
  }
});
