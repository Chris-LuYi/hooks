import isDev from '../utils/isDev';
import { DeeplinkTimeoutError } from './errors';
import type {
  DeeplinkHandler,
  DeeplinkHandlerContext,
  DeeplinkInvokeOptions,
  DeeplinkPhase,
  DeeplinkRegistry,
} from './types';

/** Default time budget for `invoke`, from the call until it settles. */
const DEFAULT_TIMEOUT = 10000;

/** Largest delay `setTimeout` honours; longer delays overflow and fire immediately. */
const MAX_TIMER_DELAY = 2147483647;

/**
 * One `handle()` call. Disposers compare this object rather than the handler function, so
 * registering the same function twice stays safe.
 */
interface Registration {
  handler: DeeplinkHandler<unknown>;
}

/** An `invoke()` call; `start` hands it to a handler. */
interface PendingCall {
  start: (handler: DeeplinkHandler<unknown>) => void;
}

function assertKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key === '') {
    throw new TypeError(
      `[daas-toolbox] deeplink key must be a non-empty string, got ${
        key === '' ? 'an empty string' : typeof key
      }`,
    );
  }
}

function assertTimeout(timeout: unknown): asserts timeout is number {
  if (typeof timeout !== 'number' || Number.isNaN(timeout) || timeout < 0) {
    throw new TypeError(
      `[daas-toolbox] deeplink timeout must be a non-negative number or Infinity, got ${String(timeout)}`,
    );
  }
}

/**
 * Create an isolated deeplink handler registry. Application code should use the shared
 * `deeplink` instance; separate registries are mainly for tests.
 */
export function createDeeplinkRegistry(): DeeplinkRegistry {
  const registrations = new Map<string, Registration>();
  const pending = new Map<string, Set<PendingCall>>();

  function enqueue(key: string, call: PendingCall) {
    let queue = pending.get(key);
    if (!queue) {
      queue = new Set();
      pending.set(key, queue);
    }
    queue.add(call);
  }

  function dequeue(key: string, call: PendingCall) {
    const queue = pending.get(key);
    if (!queue) return;
    queue.delete(call);
    if (queue.size === 0) pending.delete(key);
  }

  function handle<TResult>(key: string, handler: DeeplinkHandler<TResult>): () => void {
    assertKey(key);
    if (isDev && registrations.has(key)) {
      console.warn(`[daas-toolbox] deeplink "${key}" handler replaced`);
    }
    const registration: Registration = { handler };
    registrations.set(key, registration);

    const queue = pending.get(key);
    if (queue) {
      pending.delete(key);
      for (const call of queue) call.start(handler);
    }

    return () => {
      if (registrations.get(key) === registration) registrations.delete(key);
    };
  }

  function invoke<TResult = unknown>(
    key: string,
    params?: Record<string, unknown>,
    options: DeeplinkInvokeOptions = {},
  ): Promise<TResult> {
    assertKey(key);
    const { timeout = DEFAULT_TIMEOUT, signal } = options;
    assertTimeout(timeout);

    return new Promise<TResult>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }

      const controller = new AbortController();
      const ctx: DeeplinkHandlerContext = { options, signal: controller.signal };
      let phase: DeeplinkPhase = 'waiting';
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let detachAbort = () => {};

      const call: PendingCall = {
        start: (handler) => {
          phase = 'running';
          Promise.resolve()
            .then(() => handler(params, ctx))
            .then(
              (value) => settle(() => resolve(value as TResult)),
              (error: unknown) => settle(() => reject(error)),
            );
        },
      };

      /** Runs `outcome` once; every later result, timeout or abort is ignored. */
      function settle(outcome: () => void) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detachAbort();
        dequeue(key, call);
        outcome();
      }

      /** Rejects the call and aborts the handler's `ctx.signal` with the same reason. */
      function abortWith(reason: unknown) {
        settle(() => {
          controller.abort(reason);
          reject(reason);
        });
      }

      if (Number.isFinite(timeout)) {
        timer = setTimeout(
          () => abortWith(new DeeplinkTimeoutError(key, phase, timeout)),
          Math.min(timeout, MAX_TIMER_DELAY),
        );
      }

      if (signal) {
        const onAbort = () => abortWith(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        detachAbort = () => signal.removeEventListener('abort', onAbort);
      }

      const current = registrations.get(key);
      if (current) call.start(current.handler);
      else enqueue(key, call);
    });
  }

  function has(key: string): boolean {
    return registrations.has(key);
  }

  return { handle, invoke, has };
}
