import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
const { rememberLoginDestination, consumeLoginDestination, peekLoginDestination } = await import(pathToFileURL(resolve('apps/console/login-destination.js')).href) as {
  rememberLoginDestination: (page: string, storage: Storage, now: number) => void;
  consumeLoginDestination: (storage: Storage, now: number) => string | null;
  peekLoginDestination: (storage: Storage, now: number) => string | null;
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
  it('restores the schedule first screen after a real login redirect', () => {
    const saved = storage();
    rememberLoginDestination('schedules', saved, 1000);
    expect(peekLoginDestination(saved, 2000)).toBe('schedules');
    // renderLogin only records its own page when no earlier destination exists.
    if (!peekLoginDestination(saved, 2001)) rememberLoginDestination('login', saved, 2001);
    expect(peekLoginDestination(saved, 2002)).toBe('schedules');
    expect(consumeLoginDestination(saved, 2003)).toBe('schedules');
    expect(consumeLoginDestination(saved, 2004)).toBeNull();
  });
  it('does not let the login page overwrite an earlier schedule destination', () => {
    const saved = storage();
    rememberLoginDestination('schedules', saved, 1000);
    const existing = peekLoginDestination(saved, 1500);
    if (!existing) rememberLoginDestination('login', saved, 1500);
    expect(existing).toBe('schedules');
    expect(consumeLoginDestination(saved, 1600)).toBe('schedules');
  });
  it('does not prevent login if session storage is unavailable', () => {
    const unavailable = { getItem: () => { throw Error('disabled'); }, setItem: () => { throw Error('disabled'); }, removeItem: () => { throw Error('disabled'); } };
    expect(() => rememberLoginDestination('customs', unavailable, 1000)).not.toThrow();
    expect(consumeLoginDestination(unavailable, 2000)).toBeNull();
  });
});

it('restores allowlisted module configuration only',()=>{
 const saved=storage();
 for(const page of ['market/configure','configure/quote.zone_preview/pricing','configure/customs.tax.estimate/tariffs']){rememberLoginDestination(page,saved,1000);expect(consumeLoginDestination(saved,2000)).toBe(page);}
 for(const page of ['configure/unknown','configure/customs.query/../../account','configure/customs.query/credential','configure/customs.query?token=secret']){rememberLoginDestination(page,saved,1000);expect(consumeLoginDestination(saved,2000)).toBeNull();}
});
