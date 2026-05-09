#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const sourceNode = process.execPath;
const targetDir = path.join(projectRoot, 'vendor', 'node-runtime');
const targetNode = path.join(targetDir, process.platform === 'win32' ? 'node.exe' : 'node');

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(sourceNode, targetNode);

if (process.platform === 'win32') {
  const srcDir = path.dirname(sourceNode);
  for (const name of ['node.dll', 'libssl-3-x64.dll', 'libcrypto-3-x64.dll']) {
    const src = path.join(srcDir, name);
    const dst = path.join(targetDir, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  }
}

console.log(`[bundle-node] source=${sourceNode}`);
console.log(`[bundle-node] target=${targetNode}`);
