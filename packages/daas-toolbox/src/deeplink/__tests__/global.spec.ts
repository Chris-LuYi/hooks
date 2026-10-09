import { afterEach, expect, test, vi } from 'vitest';
import { createDeeplinkRegistry } from '../registry';

const KEY = Symbol.for('daas-toolbox/deeplink');
const store = globalThis as unknown as Record<symbol, unknown>;

afterEach(() => {
  delete store[KEY];
  vi.resetModules();
  vi.restoreAllMocks();
});

test('the first import creates the global entry', async () => {
  const { deeplink } = await import('../index');
  expect(store[KEY]).toEqual({ version: 1, registry: deeplink });
});

test('two module copies share one registry', async () => {
  const a = (await import('../index')).deeplink;
  vi.resetModules();
  const b = (await import('../index')).deeplink;
  expect(b).toBe(a);
  const off = a.handle('global.shared', () => 'from-a');
  await expect(b.invoke('global.shared')).resolves.toBe('from-a');
  off();
});

test('an entry with a different version is reused, not overwritten, and warns', async () => {
  const foreign = createDeeplinkRegistry();
  store[KEY] = { version: 0, registry: foreign };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { deeplink } = await import('../index');
  expect(deeplink).toBe(foreign);
  expect(store[KEY]).toEqual({ version: 0, registry: foreign });
  expect(warn).toHaveBeenCalledWith(
    '[daas-toolbox] deeplink registry version mismatch (found 0, expected 1); reusing the existing registry',
  );
});
