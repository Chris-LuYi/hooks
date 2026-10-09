import { afterEach, expect, test, vi } from 'vitest';
import { createDeeplinkRegistry } from '../registry';

vi.mock('../../utils/isDev', () => ({ default: false }));

const KEY = Symbol.for('daas-toolbox/deeplink');
const store = globalThis as unknown as Record<symbol, unknown>;

afterEach(() => {
  delete store[KEY];
  vi.resetModules();
  vi.restoreAllMocks();
});

test('replacing an owner handler does not warn in production', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const reg = createDeeplinkRegistry();
  reg.registerHandler('k', () => 1, { owner: 'a' });
  reg.registerHandler('k', () => 2, { owner: 'a' });
  expect(warn).not.toHaveBeenCalled();
});

test('a version mismatch does not warn in production', async () => {
  const foreign = createDeeplinkRegistry();
  store[KEY] = { version: 0, registry: foreign };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { deeplink } = await import('../index');
  expect(deeplink).toBe(foreign);
  expect(warn).not.toHaveBeenCalled();
});
