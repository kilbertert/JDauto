import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

interface BundledBrowserMetadata {
  relativeExecutablePath?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

function fileExists(p: string | null | undefined): p is string {
  return Boolean(p && fs.existsSync(p));
}

function getResourcesPath(): string | null {
  const candidate = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return typeof candidate === 'string' && candidate ? candidate : null;
}

function readBundledBrowserMetadata(baseDir: string): BundledBrowserMetadata | null {
  const metadataPath = path.join(baseDir, 'metadata.json');
  if (!fs.existsSync(metadataPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as BundledBrowserMetadata;
  } catch {
    return null;
  }
}

function resolveBundledBrowserFromDir(baseDir: string): string | null {
  const meta = readBundledBrowserMetadata(baseDir);
  if (meta?.relativeExecutablePath) {
    const fullPath = path.join(baseDir, meta.relativeExecutablePath);
    if (fs.existsSync(fullPath)) return fullPath;
  }

  const fallbackCandidates = [
    path.join(baseDir, 'chrome-win', 'chrome.exe'),
    path.join(baseDir, 'chrome-win64', 'chrome.exe'),
    path.join(baseDir, 'chrome.exe'),
  ];
  for (const p of fallbackCandidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getBundledBrowserCandidates(): string[] {
  const candidates: string[] = [];
  const envPath = process.env['JDAUTO_BROWSER_PATH'];
  if (fileExists(envPath)) candidates.push(envPath);

  const resourcesPath = getResourcesPath();
  if (resourcesPath) {
    const packagedDir = path.join(resourcesPath, 'chromium');
    const packagedPath = resolveBundledBrowserFromDir(packagedDir);
    if (packagedPath) candidates.push(packagedPath);
  }

  const devDir = path.join(PROJECT_ROOT, 'vendor', 'chromium');
  const devPath = resolveBundledBrowserFromDir(devDir);
  if (devPath) candidates.push(devPath);

  return candidates;
}

function getSystemBrowserCandidates(): string[] {
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
}

export function resolveBrowserExecutablePath(preferredPath?: string): string {
  for (const p of getBundledBrowserCandidates()) {
    if (fs.existsSync(p)) return p;
  }

  if (fileExists(preferredPath)) return preferredPath;

  for (const p of getSystemBrowserCandidates()) {
    if (fs.existsSync(p)) return p;
  }

  return preferredPath ?? getSystemBrowserCandidates()[0];
}
