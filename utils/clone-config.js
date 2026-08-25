const DEFAULTS = Object.freeze({
  systemId: 'system-b',
  systemName: 'YeuBep',
  commercePublicUrl: 'https://yeubep.shop',
  lmsPublicUrl: 'https://hoc.yeubep.shop',
  v4PublicUrl: 'https://v4.daubepnho.store',
  telegramClonerUrl: 'https://reader.yeubep.shop',
  legacyPortalPublicUrl: 'https://yeunauan.live'
});

const clean = value => String(value || '').trim().replace(/^['"]|['"]$/g, '');

export function normalizeHttpsOrigin(value, fallback = '') {
  const candidate = clean(value || fallback);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) && !/^https:\/\//i.test(candidate)) {
    throw new Error('clone_config_invalid_https_origin');
  }
  const url = new URL(/^https:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('clone_config_invalid_https_origin');
  }
  return url.origin;
}

export function cloneConfig(env = process.env) {
  return Object.freeze({
    systemId: clean(env.SYSTEM_ID) || DEFAULTS.systemId,
    systemName: clean(env.SYSTEM_NAME) || DEFAULTS.systemName,
    commercePublicUrl: normalizeHttpsOrigin(env.COMMERCE_PUBLIC_URL, DEFAULTS.commercePublicUrl),
    lmsPublicUrl: normalizeHttpsOrigin(env.SYSTEM3_URL || env.LMS_PUBLIC_URL, DEFAULTS.lmsPublicUrl),
    v4PublicUrl: normalizeHttpsOrigin(env.V4_PUBLIC_URL, DEFAULTS.v4PublicUrl),
    telegramClonerUrl: normalizeHttpsOrigin(env.TELEGRAM_CLONER_URL, DEFAULTS.telegramClonerUrl),
    legacyPortalPublicUrl: normalizeHttpsOrigin(env.SYSTEM1_URL || env.LEGACY_PORTAL_PUBLIC_URL, DEFAULTS.legacyPortalPublicUrl)
  });
}

export { DEFAULTS as CLONE_CONFIG_DEFAULTS };
