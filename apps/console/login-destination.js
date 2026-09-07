// Only a short-lived page name is retained across the external login redirect.
// No identity, credential, business input or arbitrary redirect URL is stored.
const storageKey = 'freightclaw.login-destination';
const allowedPages = new Set(['channels', 'cases', 'operations', 'account', 'customs', 'tax', 'quote', 'quote-history', 'customs-history', 'workbench', 'api-keys', 'calls', 'members']);
const allowed = page => allowedPages.has(page) || /^cli-authorize\/[A-F0-9]{8}$/u.test(page) || /^channels\/(?:new|[0-9a-f-]{36})$/u.test(page) || /^case\/[0-9a-f-]{36}$/u.test(page);
export function rememberLoginDestination(page, storage, now = Date.now()) {
  try {
    if (allowed(page)) storage.setItem(storageKey, JSON.stringify({ page, expiresAt: now + 15 * 60 * 1000 }));
    else storage.removeItem(storageKey);
  } catch { /* Login still works when browser storage is disabled. */ }
}
export function consumeLoginDestination(storage, now = Date.now()) {
  try {
    const value = storage.getItem(storageKey);
    storage.removeItem(storageKey);
    if (!value) return null;
    const target = JSON.parse(value);
    return allowed(target.page) && Number.isFinite(target.expiresAt) && target.expiresAt > now && target.expiresAt <= now + 15 * 60 * 1000 ? target.page : null;
  } catch { return null; }
}
