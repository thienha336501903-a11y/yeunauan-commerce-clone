// utils/v2-sync-worker.js
//
// Worker-secret gate for internal V2 endpoints (api/v2/diagnostics.js,
// api/v2/readiness.js). Ported from LMS utils/v2-sync-worker.js — only the
// authorization surface needed by Shop's diagnostics/readiness endpoints.
// Shop has no outbox worker, so the full LMS worker surface is not ported.
//
// Contract:
//   assertV2WorkerAuthorized(req) throws an Error with statusCode=401 when
//   the expected worker secret is missing OR the request did not supply a
//   matching `x-v2-worker-secret` / `x-sync-secret` header. Never throws on
//   a valid match. The expected secret is V2_WORKER_SECRET || INTERNAL_SYNC_SECRET.

import crypto from 'crypto';

function cleanText(value) {
  return String(value || '').trim();
}

// Constant-time string compare. Returns false (without calling
// timingSafeEqual) when lengths differ, which leaks length — acceptable for
// shared secrets where length is not secret. On equal length it performs a
// timing-safe compare so the secret value is not recoverable via timing.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function getV2SyncWorkerSecret() {
  const workerSecret = process.env.V2_WORKER_SECRET;
  if (workerSecret && String(workerSecret).trim()) return String(workerSecret).trim();
  const internalSync = process.env.INTERNAL_SYNC_SECRET;
  if (internalSync && String(internalSync).trim()) return String(internalSync).trim();
  return '';
}

export function assertV2WorkerAuthorized(req) {
  const expectedSecret = getV2SyncWorkerSecret();
  const providedSecret = cleanText(
    req?.headers?.['x-v2-worker-secret'] || req?.headers?.['x-sync-secret']
  );

  if (!expectedSecret || !providedSecret || !safeEqual(providedSecret, expectedSecret)) {
    const error = new Error('Unauthorized V2 worker request');
    error.statusCode = 401;
    throw error;
  }
}

export const _internals = { getV2SyncWorkerSecret, assertV2WorkerAuthorized };
