const clean = value => String(value || '').trim();

export function normalizePublicUrl(value, name = 'PUBLIC_URL') {
  const raw = clean(value);
  if (!raw) throw new Error(`Missing required environment variable: ${name}`);
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw new Error(`Invalid URL in environment variable: ${name}`); }
  const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHttp) throw new Error(`${name} must use https (http is allowed only for localhost)`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`${name} must be a public origin without credentials, query or hash`);
  if (parsed.pathname !== '/' && parsed.pathname !== '') throw new Error(`${name} must not contain a path`);
  return parsed.origin;
}

export function publicUrl(name) {
  return normalizePublicUrl(process.env[name], name);
}

export function commerceRuntimeConfig() {
  return {
    commercePublicUrl: publicUrl('COMMERCE_PUBLIC_URL'),
    lmsPublicUrl: publicUrl('LMS_PUBLIC_URL'),
    telegramClonerUrl: publicUrl('TELEGRAM_CLONER_URL')
  };
}
