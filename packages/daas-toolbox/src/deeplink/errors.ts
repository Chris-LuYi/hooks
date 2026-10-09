import type { DeeplinkPhase } from './types';

const TIMEOUT_ERROR_FLAG = '__DAAS_DEEPLINK_TIMEOUT_ERROR__';

/** Rejection reason when a `deeplink.invoke` call exceeds its `timeout`. */
export class DeeplinkTimeoutError extends Error {
  /** Marker that survives duplicated copies of the module, unlike `instanceof`. */
  readonly [TIMEOUT_ERROR_FLAG] = true;
  /** The deeplink key that was invoked. */
  readonly key: string;
  /** Whether the call was still waiting for a handler or already running one. */
  readonly phase: DeeplinkPhase;
  /** The timeout that elapsed, in milliseconds. */
  readonly timeout: number;

  constructor(key: string, phase: DeeplinkPhase, timeout: number) {
    super(
      `[daas-toolbox] deeplink "${key}" timed out after ${timeout}ms ${
        phase === 'waiting' ? 'waiting for a handler' : 'while its handler was running'
      }`,
    );
    this.name = 'DeeplinkTimeoutError';
    this.key = key;
    this.phase = phase;
    this.timeout = timeout;
    // keep `instanceof` working when the class is downleveled
    Object.setPrototypeOf(this, DeeplinkTimeoutError.prototype);
  }
}

/** Type guard that also works across duplicated toolbox copies (checks the flag, not only `instanceof`). */
export function isDeeplinkTimeoutError(error: unknown): error is DeeplinkTimeoutError {
  return (
    error instanceof DeeplinkTimeoutError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as Record<string, unknown>)[TIMEOUT_ERROR_FLAG] === true)
  );
}
