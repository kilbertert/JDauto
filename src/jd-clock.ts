import * as https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';

export interface JdClockSample {
  requestId: string;
  serverTs: number;
  localStart: number;
  localEnd: number;
  localMid: number;
  offsetMs: number;
}

export interface JdClockSyncResult {
  offsetMs: number;
  samples: JdClockSample[];
  medianRttMs: number;
}

const JD_CLOCK_URL = 'https://api.m.jd.com/';

function headRequest(url: string, timeoutMs: number): Promise<IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'HEAD' }, (res) => {
      res.resume();
      resolve(res.headers);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`JD clock request timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

function parseServerTs(headers: IncomingHttpHeaders): string {
  const requestId = headers['x-api-request-id'];
  const value = Array.isArray(requestId) ? requestId[0] : requestId;
  if (!value) {
    throw new Error('JD response missing X-API-Request-Id');
  }
  return value;
}

function median(values: number[]): number {
  if (values.length === 0) {
    throw new Error('median() requires at least one value');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sampleJdClock(timeoutMs = 5_000): Promise<JdClockSample> {
  const localStart = Date.now();
  const headers = await headRequest(JD_CLOCK_URL, timeoutMs);
  const localEnd = Date.now();
  const requestId = parseServerTs(headers);
  const parts = requestId.split('-');
  const serverTs = Number.parseInt(parts[parts.length - 1] ?? '', 10);
  if (!Number.isFinite(serverTs)) {
    throw new Error(`Invalid JD server timestamp in request id: ${requestId}`);
  }
  const localMid = Math.round((localStart + localEnd) / 2);
  return {
    requestId,
    serverTs,
    localStart,
    localEnd,
    localMid,
    offsetMs: serverTs - localMid,
  };
}

export async function syncJdClock(sampleCount = 7, timeoutMs = 5_000): Promise<JdClockSyncResult> {
  const samples: JdClockSample[] = [];
  for (let i = 0; i < sampleCount; i++) {
    samples.push(await sampleJdClock(timeoutMs));
    if (i < sampleCount - 1) {
      await sleep(120);
    }
  }

  const rtts = samples.map((sample) => sample.localEnd - sample.localStart);
  const medianRttMs = median(rtts);
  const stableSamples = samples.filter((sample) => (sample.localEnd - sample.localStart) <= Math.max(medianRttMs * 2, medianRttMs + 80));
  const chosenSamples = stableSamples.length > 0 ? stableSamples : samples;
  const offsetMs = median(chosenSamples.map((sample) => sample.offsetMs));

  return {
    offsetMs,
    samples,
    medianRttMs,
  };
}
