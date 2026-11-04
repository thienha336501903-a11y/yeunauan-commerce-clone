// H5 acceptance of the shared secrets without writing anything (Admin -> v4-workflow secretCheck).
// lms /api/v5-sync and /api/sync check X-Sync-Secret before reading the body, so {} answers 401 on a wrong secret
// and 400 (no action) on the right one. Reader reader-manager GET is a read. Only status codes are returned.
import { cloneConfig } from './clone-config.js';
import { lmsFetch } from './lms-fetch.js';
import { productionV5Base } from './v5-sync-helpers.js';

const clean = value => String(value || '').trim();
const base = value => clean(value).replace(/\/$/, '');

async function probe(target, secret, fetcher, method) {
  if (!secret) return { target, status: null, verdict: 'missing' };
  try {
    const response = await fetcher(target, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': secret },
      ...(method === 'POST' ? { body: '{}' } : {}),
      signal: AbortSignal.timeout(15000)
    });
    const accepted = method === 'POST' ? response.status === 400 : response.ok;
    return { target, status: response.status, verdict: response.status === 401 ? 'mismatch' : accepted ? 'match' : 'unexpected' };
  } catch {
    return { target, status: null, verdict: 'unreachable' };
  }
}

export async function secretCheck(fetchImpl = fetch) {
  const runtime = cloneConfig();
  const v5 = clean(process.env.V5_SYNC_SECRET);
  const internal = clean(process.env.INTERNAL_SYNC_SECRET);
  const checks = {
    v5Sync: await probe(`${base(productionV5Base())}/api/v5-sync`, v5, lmsFetch, 'POST'),
    internalLms: await probe(`${base(runtime.lmsPublicUrl)}/api/sync`, internal, lmsFetch, 'POST'),
    internalReader: await probe(`${base(runtime.telegramClonerUrl)}/api/admin?action=reader-manager`, internal, fetchImpl, 'GET')
  };
  return { checks, allMatch: Object.values(checks).every(c => c.verdict === 'match') };
}
