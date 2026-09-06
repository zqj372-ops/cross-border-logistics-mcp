import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
const { rememberLoginDestination, consumeLoginDestination } = await import(pathToFileURL(resolve('apps/console/login-destination.js')).href) as {
  rememberLoginDestination: (page: string, storage: Storage, now: number) => void;
  consumeLoginDestination: (storage: Storage, now: number) => string | null;
};
function storage() {
  const items = new Map<string, string>();
  return { items, getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); }, removeItem: (key: string) => { items.delete(key); } };
}
describe('return to the requested business after login', () => {
  it('restores a customs visit exactly once across the login redirect', () => {
    const saved = storage();
    rememberLoginDestination('customs', saved, 1000);
    expect(consumeLoginDestination(saved, 2000)).toBe('customs');
    expect(consumeLoginDestination(saved, 2000)).toBeNull();
  });
  it('does not follow external URLs, private object paths or unsupported pages', () => {
    const saved = storage();
    for (const page of ['https://example.test/', '//example.test/', 'credential-new/app-1', 'constructor', 'organizations']) {
      rememberLoginDestination(page, saved, 1000);
      expect(saved.items.size).toBe(0);
      saved.setItem('freightclaw.login-destination', JSON.stringify({ page, expiresAt: 3000 }));
      expect(consumeLoginDestination(saved, 2000)).toBeNull();
    }
  });
  it('expires old intent and rejects malformed or unbounded retention', () => {
    const saved = storage();
    rememberLoginDestination('customs', saved, 1000);
    expect(consumeLoginDestination(saved, 901000)).toBeNull();
    for (const value of ['invalid', 'null', '{"page":"customs","expiresAt":9999999999999}']) {
      saved.setItem('freightclaw.login-destination', value);
      expect(consumeLoginDestination(saved, 2000)).toBeNull();
      expect(saved.items.size).toBe(0);
    }
  });
  it('clears earlier intent when login is started from the generic entry', () => {
    const saved = storage();
    rememberLoginDestination('tax', saved, 1000);
    rememberLoginDestination('login', saved, 1001);
    expect(consumeLoginDestination(saved, 2000)).toBeNull();
  });
  it('does not prevent login if session storage is unavailable', () => {
    const unavailable = { getItem: () => { throw Error('disabled'); }, setItem: () => { throw Error('disabled'); }, removeItem: () => { throw Error('disabled'); } };
    expect(() => rememberLoginDestination('customs', unavailable, 1000)).not.toThrow();
    expect(consumeLoginDestination(unavailable, 2000)).toBeNull();
  });
});
