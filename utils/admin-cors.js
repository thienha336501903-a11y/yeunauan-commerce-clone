function firstHeaderValue(value) {
  return String(value || '').split(',')[0].trim();
}

function requestOrigin(req) {
  const host = firstHeaderValue(req.headers?.['x-forwarded-host'] || req.headers?.host);
  if (!host) return '';
  const protocol = firstHeaderValue(req.headers?.['x-forwarded-proto']) || 'https';
  if (protocol !== 'https' && protocol !== 'http') return '';
  return `${protocol}://${host}`;
}

function normalizedOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['https:', 'http:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch {
    return '';
  }
}

export function enforceSameOriginAdminRequest(req, res, methods) {
  const suppliedOrigin = String(req.headers?.origin || '').trim();
  const origin = normalizedOrigin(suppliedOrigin);
  const sameOrigin = origin && origin === requestOrigin(req);

  res.setHeader('Vary', 'Origin');

  if (suppliedOrigin && !sameOrigin) {
    res.status(403).json({ error: 'Cross-origin admin request denied.' });
    return false;
  }

  if (sameOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
  }

  if (req.method === 'OPTIONS') {
    if (!sameOrigin) {
      res.status(403).json({ error: 'Cross-origin admin preflight denied.' });
      return false;
    }
    res.status(204).end();
    return false;
  }

  return true;
}
