#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Browser, detectBrowserPlatform, install, resolveBuildId } from '@puppeteer/browsers';

const projectRoot = process.cwd();
const targetDir = path.join(projectRoot, 'vendor', 'chromium');
const metadataPath = path.join(targetDir, 'metadata.json');

async function main() {
  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error('无法识别当前平台，不能下载 Chromium');
  }

  fs.mkdirSync(targetDir, { recursive: true });

  const existingMetadata = readJson(metadataPath);
  if (existingMetadata?.relativeExecutablePath) {
    const existingExec = path.join(targetDir, existingMetadata.relativeExecutablePath);
    if (fs.existsSync(existingExec)) {
      console.log(`[bundle-chromium] reuse=${existingExec}`);
      return;
    }
  }

  const buildId = await resolveBuildId(Browser.CHROMIUM, platform, 'latest');
  console.log(`[bundle-chromium] platform=${platform}`);
  console.log(`[bundle-chromium] buildId=${buildId}`);

  const installed = await install({
    browser: Browser.CHROMIUM,
    buildId,
    cacheDir: targetDir,
    platform,
    unpack: true,
    downloadProgressCallback: 'default',
  });

  const relativeExecutablePath = path.relative(targetDir, installed.executablePath);
  fs.writeFileSync(
    metadataPath,
    `${JSON.stringify({
      browser: 'chromium',
      buildId,
      platform,
      relativeExecutablePath,
    }, null, 2)}\n`,
    'utf8'
  );

  console.log(`[bundle-chromium] executable=${installed.executablePath}`);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error(`[bundle-chromium] failed: ${String(err)}`);
  process.exitCode = 1;
});

