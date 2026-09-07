// Only a short-lived page name is retained across the external login redirect.
// No identity, credential, business input or arbitrary redirect URL is stored.
const storageKey = 'freightclaw.login-destination';
const allowedPages = new Set(['account', 'customs', 'tax', 'quote', 'quote-history', 'customs-history', 'workbench', 'api-keys', 'calls', 'members']);
export function rememberLoginDestination(page, storage, now = Date.now()) {
  try {
    if (allowedPages.has(page)) storage.setItem(storageKey, JSON.stringify({ page, expiresAt: now + 15 * 60 * 1000 }));
    else storage.removeItem(storageKey);
  } catch { /* Login still works when browser storage is disabled. */ }
}
export function consumeLoginDestination(storage, now = Date.now()) {
  try {
    const value = storage.getItem(storageKey);
    storage.removeItem(storageKey);
    if (!value) return null;
    const target = JSON.parse(value);
    return allowedPages.has(target.page) && Number.isFinite(target.expiresAt) && target.expiresAt > now && target.expiresAt <= now + 15 * 60 * 1000 ? target.page : null;
  } catch { return null; }
}
