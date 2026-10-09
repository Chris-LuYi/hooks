import isDev from '../utils/isDev';
import type {
  DeeplinkHandler,
  DeeplinkHandlerContext,
  DeeplinkInvokeOptions,
  DeeplinkRegistry,
} from './types';

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
    return new Promise<TResult>((resolve, reject) => {
      const controller = new AbortController();
      const ctx: DeeplinkHandlerContext = { options, signal: controller.signal };
      const call: PendingCall = {
        start: (handler) => {
          Promise.resolve()
            .then(() => handler(params, ctx))
            .then((value) => resolve(value as TResult), reject);
        },
      };

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
