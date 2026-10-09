import isDev from '../utils/isDev';
import { createDeeplinkRegistry } from './registry';
import type { DeeplinkRegistry } from './types';

/** Shared across every bundle on the page: `Symbol.for` returns the same symbol everywhere. */
const GLOBAL_KEY = Symbol.for('daas-toolbox/deeplink');

/** Bump only when the registry's runtime shape changes incompatibly. */
const GLOBAL_VERSION = 1;

interface GlobalEntry {
  version: number;
  registry: DeeplinkRegistry;
}

/**
 * Return the page-wide registry, creating it on first use. An existing entry is always reused,
 * even with a different version, so a stray old toolbox copy never wipes out other MFEs' handlers.
 */
export function getGlobalRegistry(): DeeplinkRegistry {
  const store = globalThis as unknown as Record<symbol, GlobalEntry | undefined>;
  const existing = store[GLOBAL_KEY];
  if (existing) {
    if (isDev && existing.version !== GLOBAL_VERSION) {
      console.warn(
        `[daas-toolbox] deeplink registry version mismatch (found ${existing.version}, expected ${GLOBAL_VERSION}); reusing the existing registry`,
      );
    }
    return existing.registry;
  }
  const entry: GlobalEntry = { version: GLOBAL_VERSION, registry: createDeeplinkRegistry() };
  store[GLOBAL_KEY] = entry;
  return entry.registry;
}
