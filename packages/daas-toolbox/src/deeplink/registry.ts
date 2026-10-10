import isDev from "../utils/isDev";
import { type ComposeStep, compose } from "./compose";
import { DeeplinkTimeoutError } from "./errors";
import type {
  DeeplinkCallContext,
  DeeplinkHandler,
  DeeplinkInspection,
  DeeplinkInvokeOptions,
  DeeplinkPhase,
  DeeplinkRegisterOptions,
  DeeplinkRegistry,
  DeeplinkStepStatus,
} from "./types";

/** Default time budget for `invoke`, from the call until it settles. */
const DEFAULT_TIMEOUT = 10000;

/** Largest delay `setTimeout` honours; longer delays overflow and fire immediately. */
const MAX_TIMER_DELAY = 2147483647;

/**
 * One registered handler. `unregister` compares this object rather than the handler function,
 * so registering the same function under several owners stays safe.
 */
interface Registration extends ComposeStep {
  order: number;
  /** Registration sequence; breaks ties between equal `order` values. */
  seq: number;
}

/** An `invoke()` call waiting for its first key handler; `start` runs it on a chain snapshot. */
interface PendingCall {
  start: (keyChain: readonly ComposeStep[]) => void;
}

function byOrder(a: Registration, b: Registration): number {
  return a.order - b.order || a.seq - b.seq;
}

function toStatus({ owner, order }: Registration): DeeplinkStepStatus {
  return { owner, order };
}

function assertKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key === "") {
    throw new TypeError(
      `[daas-toolbox] deeplink key must be a non-empty string, got ${key === "" ? "an empty string" : typeof key}`,
    );
  }
}

function assertTimeout(timeout: unknown): asserts timeout is number {
  if (typeof timeout !== "number" || Number.isNaN(timeout) || timeout < 0) {
    throw new TypeError(
      `[daas-toolbox] deeplink timeout must be a non-negative number or Infinity, got ${String(timeout)}`,
    );
  }
}

function assertHandler(handler: unknown): asserts handler is DeeplinkHandler {
  if (typeof handler !== "function") {
    throw new TypeError("[daas-toolbox] deeplink handler must be a function");
  }
}

/** Validate register options; `owner` is required (also when `options` itself is missing). */
function readRegisterOptions(options: DeeplinkRegisterOptions | undefined): {
  owner: string;
  order: number;
} {
  const owner: unknown = options?.owner;
  const order: unknown = options?.order ?? 0;
  if (typeof owner !== "string" || owner === "") {
    throw new TypeError("[daas-toolbox] deeplink owner must be a non-empty string");
  }
  if (typeof order !== "number" || !Number.isFinite(order)) {
    throw new TypeError(`[daas-toolbox] deeplink order must be a finite number, got ${String(order)}`);
  }
  return { owner, order };
}

/** `list` plus `registration`, minus any earlier registration from the same owner; sorted. */
function insertRegistration(
  list: readonly Registration[],
  registration: Registration,
  onReplace: () => void,
): Registration[] {
  const next = list.filter((existing) => {
    if (existing.owner !== registration.owner) return true;
    onReplace();
    return false;
  });
  next.push(registration);
  return next.sort(byOrder);
}

/**
 * Create an isolated deeplink registry. Application code should use the shared `deeplink`
 * instance; separate registries are mainly for tests.
 */
export function createDeeplinkRegistry(): DeeplinkRegistry {
  const chains = new Map<string, Registration[]>();
  const pending = new Map<string, Set<PendingCall>>();
  const flushScheduled = new Set<string>();
  const listeners = new Set<() => void>();
  let globals: Registration[] = [];
  let seq = 0;

  function notify() {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        if (isDev) console.error("[daas-toolbox] deeplink subscriber threw", error);
      }
    }
  }

  function enqueue(key: string, call: PendingCall) {
    let queue = pending.get(key);
    if (!queue) {
      queue = new Set();
      pending.set(key, queue);
    }
    queue.add(call);
    notify();
  }

  function dequeue(key: string, call: PendingCall) {
    const queue = pending.get(key);
    if (queue?.delete(call)) {
      if (queue.size === 0) pending.delete(key);
      notify();
    }
  }

  /** Start a key's waiting calls one microtask after its first handler, so same-tick registrations join. */
  function scheduleFlush(key: string) {
    if (!pending.has(key) || flushScheduled.has(key)) return;
    flushScheduled.add(key);
    queueMicrotask(() => {
      flushScheduled.delete(key);
      const waiting = pending.get(key);
      const chain = chains.get(key);
      if (!waiting || !chain) return;
      pending.delete(key);
      notify();
      for (const call of waiting) call.start(chain);
    });
  }

  function registerHandler(key: string, handler: DeeplinkHandler, options: DeeplinkRegisterOptions): () => void {
    assertKey(key);
    assertHandler(handler);
    const { owner, order } = readRegisterOptions(options);
    const registration: Registration = { handler, owner, order, seq: seq++, global: false };
    chains.set(
      key,
      insertRegistration(chains.get(key) ?? [], registration, () => {
        if (isDev) {
          console.warn(`[daas-toolbox] deeplink "${key}" handler from owner "${owner}" replaced`);
        }
      }),
    );
    notify();
    scheduleFlush(key);

    return () => {
      const current = chains.get(key);
      if (!current || !current.includes(registration)) return;
      const remaining = current.filter((existing) => existing !== registration);
      if (remaining.length > 0) chains.set(key, remaining);
      else chains.delete(key);
      notify();
    };
  }

  function registerGlobalHandler(handler: DeeplinkHandler, options: DeeplinkRegisterOptions): () => void {
    assertHandler(handler);
    const { owner, order } = readRegisterOptions(options);
    const registration: Registration = { handler, owner, order, seq: seq++, global: true };
    globals = insertRegistration(globals, registration, () => {
      if (isDev) console.warn(`[daas-toolbox] global handler from owner "${owner}" replaced`);
    });
    notify();

    return () => {
      if (!globals.includes(registration)) return;
      globals = globals.filter((existing) => existing !== registration);
      notify();
    };
  }

  function invoke<TResult = unknown>(
    key: string,
    params?: Record<string, unknown>,
    options?: DeeplinkInvokeOptions,
  ): Promise<TResult> {
    assertKey(key);
    // `?? {}` rather than a default parameter, so an explicit `null` is treated as omitted
    const opts: DeeplinkInvokeOptions = options ?? {};

    return new Promise<TResult>((resolve, reject) => {
      // Inside the executor so an invalid timeout rejects instead of throwing synchronously.
      const { timeout = DEFAULT_TIMEOUT, signal } = opts;
      assertTimeout(timeout);

      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }

      const controller = new AbortController();
      let phase: DeeplinkPhase = "waiting";
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let detachAbort = () => {};

      const call: PendingCall = {
        start: (keyChain) => {
          // A subscriber notified during the batch flush may already have settled this call.
          if (settled) return;
          phase = "running";
          // Snapshot: global handlers (outermost) + key handlers, as they are right now.
          const chain = [...globals, ...keyChain];
          const ctx: DeeplinkCallContext = {
            key,
            params,
            input: params,
            options: opts,
            signal: controller.signal,
            step: { index: 0, count: chain.length, owner: "", global: false },
            state: {},
          };
          compose(chain, ctx).then(
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

      /** Rejects the call and aborts every handler's `ctx.signal` with the same reason. */
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
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }

      const keyChain = chains.get(key);
      if (keyChain) call.start(keyChain);
      else enqueue(key, call);
    });
  }

  function has(key: string): boolean {
    return chains.has(key);
  }

  function inspect(): DeeplinkInspection {
    const keys = [...new Set([...chains.keys(), ...pending.keys()])].sort();
    return {
      global: globals.map(toStatus),
      keys: keys.map((key) => ({
        key,
        steps: (chains.get(key) ?? []).map(toStatus),
        waiting: pending.get(key)?.size ?? 0,
      })),
    };
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { registerHandler, invoke, has, registerGlobalHandler, inspect, subscribe };
}
