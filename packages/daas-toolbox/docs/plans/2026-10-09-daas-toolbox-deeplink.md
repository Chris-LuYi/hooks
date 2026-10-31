# daas-toolbox + Deeplink Handler Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the vendored `@daas/hooks` package to `@daas/toolbox`, with the hooks in one folder, and add a cross-MFE deeplink handler registry (`deeplink.handle` / `deeplink.invoke` / `useDeeplinkHandler`) that returns handler results as Promises.

**Architecture:** `createDeeplinkRegistry()` is a pure factory that holds a `Map` of handler registrations and a per-key queue of waiting calls. Each call has one timeout budget and an `AbortController`. A shared instance lives on `globalThis[Symbol.for('daas-toolbox/deeplink')]`, so every MFE (and every bundled copy of the toolbox) sees one registry. `useDeeplinkHandler` is a thin React wrapper that registers once per key and always calls the latest handler.

**Tech Stack:** TypeScript (strict, `verbatimModuleSyntax`), React ≥16.8, vitest + jsdom + `@testing-library/react`, Biome (version pinned by the repo), pnpm workspace.

**Spec:** `packages/daas-toolbox/docs/specs/2026-10-09-daas-toolbox-deeplink-design.md` (it is at `packages/daas-hooks/docs/specs/…` until Task 1 renames the folder; this plan moves with it).

## Global Constraints

- No new runtime dependencies. `react` stays the only runtime import, and nothing imports the DaaS SDK.
- Global singleton key: `Symbol.for('daas-toolbox/deeplink')`; entry shape `{ version: 1, registry }`.
- Default `invoke` timeout: `10000` ms, measured from `invoke()` until the call settles. `Infinity` disables it.
- All log and error messages start with `[daas-toolbox]`.
- Replace warning text, exact: `[daas-toolbox] deeplink "<key>" handler replaced`, logged only when `isDev`.
- Code style (AGENTS.md): `interface` for object shapes, `type` for unions and functions, no `enum`, no non-null `!`, JSDoc on public types, `as` only where unavoidable.
- Do not change the logic of the vendored ahooks code. Task 1 only moves it and fixes import paths.
- Test coverage must be 100% for `src/deeplink/**` and `src/hooks/useDeeplinkHandler/**`.
- Format and lint with the **repo-pinned** Biome (`npx biome …` from the repo root), never `bunx biome`, which pulls a newer version and rewrites upstream files.
- Work on branch `daas-hooks`. Commit after each task. Do not push unless asked.

## Review Focus

1. **Timeout error from another toolbox copy:** if MFE A's bundled copy created the registry, MFE B's `isDeeplinkTimeoutError` must still return `true` even though `instanceof` fails. Tested in Task 2 with a flag-marker case.
2. **The same function registered twice:** with `off1 = handle(k, fn); off2 = handle(k, fn); off1()`, the handler must stay registered. Disposers compare registration objects, not functions. Tested in Task 3.
3. **Invalid or huge `timeout`:** `NaN`, negative numbers and non-numbers throw `TypeError` synchronously. A value above `2147483647` ms must not overflow `setTimeout` and fire right away. Tested in Task 4.
4. **A call that timed out or was aborted must never reach a handler registered later:** the queue has to be cleaned up when a call settles. Tested in Task 4.
5. **One queued call's handler throwing must not stop the other queued calls from being delivered.** Tested in Task 3.

---

## File Structure (end state)

```
packages/daas-toolbox/
  package.json                          name "@daas/toolbox"
  README.md                             rewritten in Task 7
  docs/specs/…-design.md, docs/plans/…  (moved by Task 1)
  src/
    index.ts                            export * from './deeplink'; export * from './hooks'
    __tests__/index.spec.ts             barrel smoke test
    hooks/
      index.ts                          hooks barrel
      <11 vendored hook folders>        moved unchanged except utils import depth
      useDeeplinkHandler/index.ts       + __tests__/index.spec.ts
    deeplink/
      index.ts                          `deeplink` global instance + re-exports
      types.ts                          public types
      errors.ts                         DeeplinkTimeoutError, isDeeplinkTimeoutError
      registry.ts                       createDeeplinkRegistry()
      global.ts                         getGlobalRegistry()
      __tests__/errors.spec.ts
      __tests__/registry.spec.ts        core behavior
      __tests__/registry.timeout.spec.ts timeout + caller abort
      __tests__/global.spec.ts          singleton
      __tests__/registry.prod.spec.ts   isDev=false paths
    utils/                              unchanged location
```

All commands below run from `<repo-root>/packages/daas-toolbox` unless stated otherwise.

---

### Task 1: Rename package and move hooks into `src/hooks/`

**Files:**
- Move: `packages/daas-hooks` → `packages/daas-toolbox`
- Move: `src/{createUpdateEffect,useCreation,useHistoryTravel,useLatest,useMemoizedFn,useMount,useRequest,useUnmount,useUpdate,useUpdateEffect,useWhyDidYouUpdate}` → `src/hooks/`
- Create: `src/hooks/index.ts`, `src/__tests__/index.spec.ts`
- Modify: `src/index.ts`, `package.json`, `<repo-root>/pnpm-lock.yaml` (regenerated)

**Interfaces:**
- Produces: `src/hooks/index.ts` re-exports `useHistoryTravel`, `useMount`, `useRequest`, `useWhyDidYouUpdate`, `CancelledError`, `clearCache`, `isCancelledError`, and the types `Options`, `Plugin`, `Result`, `Service`. Root `src/index.ts` does `export * from './hooks'`.

- [ ] **Step 1: Move the folders**

```bash
cd <repo-root>
git mv packages/daas-hooks packages/daas-toolbox
cd packages/daas-toolbox/src
mkdir hooks
git mv createUpdateEffect useCreation useHistoryTravel useLatest useMemoizedFn useMount useRequest useUnmount useUpdate useUpdateEffect useWhyDidYouUpdate hooks/
```

- [ ] **Step 2: Fix imports of the top-level `src/utils`.** Every such import needs one more `../`. The patterns depend on file depth and are quote-anchored, so `useRequest`'s local `src/utils` (`'./utils/…'`, `'../utils/cache'`, etc.) is never touched.

```bash
cd <repo-root>/packages/daas-toolbox/src
# depth 2: hooks/<hook>/index.ts
find hooks -mindepth 2 -maxdepth 2 -name '*.ts' -exec sed -i "s#'\.\./utils#'../../utils#g" {} +
# depth 3: hooks/<hook>/__tests__/*.spec.ts(x), hooks/useRequest/src/*.ts
find hooks -mindepth 3 -maxdepth 3 \( -name '*.ts' -o -name '*.tsx' \) -exec sed -i "s#'\.\./\.\./utils#'../../../utils#g" {} +
# depth 4: hooks/useRequest/src/{plugins,utils}/*.ts
find hooks -mindepth 4 -maxdepth 4 -name '*.ts' -exec sed -i "s#'\.\./\.\./\.\./utils#'../../../../utils#g" {} +
```

Verify that no import still points at the old location:

```bash
cd <repo-root>/packages/daas-toolbox && npx tsc --noEmit -p .
```
Expected: `src/index.ts` errors only (it still imports `./useMount` and the other old paths). No errors under `src/hooks/`.

- [ ] **Step 3: Write the failing barrel test** at `src/__tests__/index.spec.ts`

```ts
import { describe, expect, test } from 'vitest';
import * as toolbox from '../index';

const exported = toolbox as Record<string, unknown>;

describe('@daas/toolbox barrel', () => {
  test.each([
    'useRequest',
    'useHistoryTravel',
    'useMount',
    'useWhyDidYouUpdate',
    'clearCache',
    'isCancelledError',
    'CancelledError',
  ])('exports %s', (name) => {
    expect(typeof exported[name]).toBe('function');
  });
});
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `npx vitest run src/__tests__/index.spec.ts`
Expected: FAIL, because `src/index.ts` cannot resolve `./useMount` (and the other old paths).

- [ ] **Step 5: Create `src/hooks/index.ts`**

```ts
export type { Options, Plugin, Result, Service } from './useRequest/src/types';
export { default as useHistoryTravel } from './useHistoryTravel';
export { default as useMount } from './useMount';
export {
  CancelledError,
  clearCache,
  isCancelledError,
  default as useRequest,
} from './useRequest';
export { default as useWhyDidYouUpdate } from './useWhyDidYouUpdate';
```

- [ ] **Step 6: Replace `src/index.ts`**

```ts
export * from './hooks';
```

- [ ] **Step 7: Rename the package.** In `package.json`, change these two fields (leave the others as they are):

```json
  "name": "@daas/toolbox",
  "description": "DaaS toolbox: vendored ahooks 3.10.1 subset (useRequest, useHistoryTravel, useMount, useWhyDidYouUpdate) plus a cross-MFE deeplink handler registry. No runtime dependencies besides React.",
```

Then regenerate the workspace lockfile entry:

```bash
cd <repo-root> && pnpm install
```
Expected: `pnpm-lock.yaml` importer key changes from `packages/daas-hooks` to `packages/daas-toolbox`.

- [ ] **Step 8: Run the full suite and the typecheck**

Run: `npx tsc --noEmit -p . && npx vitest run`
Expected: tsc exits 0. All test files pass: the 20 existing files (84 tests) plus the new barrel test (7 tests), for 91 tests in total.

- [ ] **Step 9: Commit**

```bash
cd <repo-root>
git add -A packages/daas-toolbox packages/daas-hooks pnpm-lock.yaml
git commit -m "refactor(daas-toolbox): rename daas-hooks to @daas/toolbox and move hooks into src/hooks"
```

---

### Task 2: Deeplink public types and timeout error

**Files:**
- Create: `src/deeplink/types.ts`, `src/deeplink/errors.ts`
- Test: `src/deeplink/__tests__/errors.spec.ts`

**Interfaces:**
- Produces (`types.ts`): `DeeplinkInvokeOptions`, `DeeplinkHandlerContext`, `DeeplinkParams`, `DeeplinkHandler<TResult>`, `DeeplinkPhase`, `DeeplinkRegistry` (exact definitions below).
- Produces (`errors.ts`): `class DeeplinkTimeoutError(key: string, phase: DeeplinkPhase, timeout: number)` with readonly `key`, `phase`, `timeout`; `isDeeplinkTimeoutError(e: unknown): e is DeeplinkTimeoutError`.

- [ ] **Step 1: Create `src/deeplink/types.ts`** (type-only; later tasks use it)

```ts
/** Options accepted by `deeplink.invoke`. Mirrors the open shape of daas-sdk `NavigateOptions`. */
export interface DeeplinkInvokeOptions {
  /**
   * Milliseconds from `invoke()` until the call settles, covering both waiting for a handler
   * and running it. `Infinity` disables the timeout.
   * @default 10000
   */
  timeout?: number;
  /** Caller-side cancellation. Aborting rejects the call with `signal.reason`. */
  signal?: AbortSignal;
  /** Any extra caller options are passed to the handler untouched. */
  [key: string]: unknown;
}

/** Second argument passed to every deeplink handler. */
export interface DeeplinkHandlerContext {
  /** The options object the caller passed (`{}` when omitted). */
  options: DeeplinkInvokeOptions;
  /** Aborted when the call times out or the caller aborts. Pass it to `fetch` and similar APIs. */
  signal: AbortSignal;
}

/** Params passed by the caller; same shape as daas-sdk `navigate` params. */
export type DeeplinkParams = Record<string, unknown> | undefined;

/**
 * Handles one deeplink key. May be sync or async; its return value (or rejection) is what
 * `deeplink.invoke` resolves (or rejects) with.
 */
export type DeeplinkHandler<TResult = unknown> = (
  params: DeeplinkParams,
  ctx: DeeplinkHandlerContext,
) => TResult | Promise<TResult>;

/**
 * Where a timed-out call was:
 * - `'waiting'`: no handler had received it yet (owner MFE not loaded, or not handling this key)
 * - `'running'`: a handler received it but did not settle in time
 */
export type DeeplinkPhase = 'waiting' | 'running';

/** A deeplink handler registry. Use the shared `deeplink` instance; create your own only in tests. */
export interface DeeplinkRegistry {
  /**
   * Register `handler` for `key`, replacing any existing handler.
   * @returns a disposer that removes this registration only if it is still the current one
   */
  handle<TResult>(key: string, handler: DeeplinkHandler<TResult>): () => void;
  /**
   * Invoke the handler for `key`, waiting for one to register if needed.
   * @example
   * const res = await deeplink.invoke<{ opened: boolean }>('orders.open', { id: '42' });
   */
  invoke<TResult = unknown>(
    key: string,
    params?: Record<string, unknown>,
    options?: DeeplinkInvokeOptions,
  ): Promise<TResult>;
  /** Whether a handler is currently registered for `key`. */
  has(key: string): boolean;
}
```

- [ ] **Step 2: Write the failing test** at `src/deeplink/__tests__/errors.spec.ts`

```ts
import { describe, expect, test } from 'vitest';
import { DeeplinkTimeoutError, isDeeplinkTimeoutError } from '../errors';

describe('DeeplinkTimeoutError', () => {
  test('carries key, phase, timeout and a readable message for the waiting phase', () => {
    const err = new DeeplinkTimeoutError('orders.open', 'waiting', 500);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DeeplinkTimeoutError);
    expect(err.name).toBe('DeeplinkTimeoutError');
    expect(err.key).toBe('orders.open');
    expect(err.phase).toBe('waiting');
    expect(err.timeout).toBe(500);
    expect(err.message).toBe(
      '[daas-toolbox] deeplink "orders.open" timed out after 500ms waiting for a handler',
    );
  });

  test('has a distinct message for the running phase', () => {
    const err = new DeeplinkTimeoutError('orders.open', 'running', 500);
    expect(err.message).toBe(
      '[daas-toolbox] deeplink "orders.open" timed out after 500ms while its handler was running',
    );
  });
});

describe('isDeeplinkTimeoutError', () => {
  test('recognises instances', () => {
    expect(isDeeplinkTimeoutError(new DeeplinkTimeoutError('k', 'waiting', 1))).toBe(true);
  });

  test('recognises an error created by another copy of the module (flag, not instanceof)', () => {
    const foreign = Object.assign(new Error('x'), { __DAAS_DEEPLINK_TIMEOUT_ERROR__: true });
    expect(isDeeplinkTimeoutError(foreign)).toBe(true);
  });

  test.each([new Error('x'), null, undefined, 'str', 42, {}])('rejects %s', (value) => {
    expect(isDeeplinkTimeoutError(value)).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run src/deeplink/__tests__/errors.spec.ts`
Expected: FAIL, because `../errors` cannot be resolved.

- [ ] **Step 4: Implement `src/deeplink/errors.ts`**

```ts
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
```

- [ ] **Step 5: Run the test and the typecheck**

Run: `npx vitest run src/deeplink/__tests__/errors.spec.ts && npx tsc --noEmit -p .`
Expected: PASS (10 tests), and tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/deeplink
git commit -m "feat(daas-toolbox): deeplink public types and DeeplinkTimeoutError"
```

---

### Task 3: Registry core (register, invoke, wait, replace, dispose)

**Files:**
- Create: `src/deeplink/registry.ts`
- Test: `src/deeplink/__tests__/registry.spec.ts`

**Interfaces:**
- Consumes: `DeeplinkHandler`, `DeeplinkHandlerContext`, `DeeplinkInvokeOptions`, `DeeplinkRegistry` from `./types`; `isDev` default export from `../utils/isDev`.
- Produces: `createDeeplinkRegistry(): DeeplinkRegistry`, returning a plain object `{ handle, invoke, has }` (so tests can `vi.spyOn` its methods).

- [ ] **Step 1: Write the failing tests** at `src/deeplink/__tests__/registry.spec.ts`

```ts
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDeeplinkRegistry } from '../registry';
import type { DeeplinkHandlerContext } from '../types';

/** Lets pending microtasks and 0 ms timers run (real timers in this file). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('happy path', () => {
  test('resolves with the result of a registered async handler', async () => {
    const reg = createDeeplinkRegistry();
    reg.handle('orders.open', async () => ({ opened: true }));
    await expect(reg.invoke('orders.open')).resolves.toEqual({ opened: true });
  });

  test('resolves with the return value of a sync handler', async () => {
    const reg = createDeeplinkRegistry();
    reg.handle('k', () => 42);
    await expect(reg.invoke('k')).resolves.toBe(42);
  });

  test('passes params and the exact caller options object to the handler', async () => {
    const reg = createDeeplinkRegistry();
    const handler = vi.fn((_params: unknown, _ctx: DeeplinkHandlerContext) => 'ok');
    reg.handle('k', handler);
    const options = { timeout: 5000, tab: 'items' };
    await reg.invoke('k', { id: 42 }, options);
    const [params, ctx] = handler.mock.calls[0];
    expect(params).toEqual({ id: 42 });
    expect(ctx.options).toBe(options);
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.signal.aborted).toBe(false);
  });

  test('passes undefined params and {} options when omitted', async () => {
    const reg = createDeeplinkRegistry();
    const handler = vi.fn((_params: unknown, _ctx: DeeplinkHandlerContext) => 'ok');
    reg.handle('k', handler);
    await reg.invoke('k');
    const [params, ctx] = handler.mock.calls[0];
    expect(params).toBeUndefined();
    expect(ctx.options).toEqual({});
  });
});

describe('waiting for a handler', () => {
  test('a call made before the handler registers resolves once it does', async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke('k', { id: 1 });
    const handler = vi.fn(() => 'late');
    await flush();
    expect(handler).not.toHaveBeenCalled();
    reg.handle('k', handler);
    await expect(p).resolves.toBe('late');
    expect(handler).toHaveBeenCalledWith({ id: 1 }, expect.anything());
  });

  test('several waiting calls are delivered in arrival order', async () => {
    const reg = createDeeplinkRegistry();
    const order: unknown[] = [];
    const calls = [reg.invoke('k', { n: 1 }), reg.invoke('k', { n: 2 }), reg.invoke('k', { n: 3 })];
    reg.handle('k', (params) => {
      order.push(params?.n);
      return params?.n;
    });
    await expect(Promise.all(calls)).resolves.toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test('a handler for another key does not receive waiting calls', async () => {
    const reg = createDeeplinkRegistry();
    const pB = reg.invoke('b');
    const aHandler = vi.fn(() => 'a');
    reg.handle('a', aHandler);
    await flush();
    expect(aHandler).not.toHaveBeenCalled();
    reg.handle('b', () => 'b');
    await expect(pB).resolves.toBe('b');
  });
});

describe('errors', () => {
  test('a sync throw becomes a rejection with the same error object', async () => {
    const reg = createDeeplinkRegistry();
    const boom = new Error('boom');
    reg.handle('k', () => {
      throw boom;
    });
    await expect(reg.invoke('k')).rejects.toBe(boom);
  });

  test('an async rejection is passed through unchanged', async () => {
    const reg = createDeeplinkRegistry();
    class ValidationError extends Error {}
    const err = new ValidationError('bad');
    reg.handle('k', async () => {
      throw err;
    });
    await expect(reg.invoke('k')).rejects.toBe(err);
  });

  test('one queued call failing does not stop the other queued calls', async () => {
    const reg = createDeeplinkRegistry();
    const p1 = reg.invoke('k', { fail: true });
    const p2 = reg.invoke('k', { fail: false });
    reg.handle('k', (params) => {
      if (params?.fail) throw new Error('first');
      return 'second';
    });
    await expect(p1).rejects.toThrow('first');
    await expect(p2).resolves.toBe('second');
  });

  test('an empty key throws TypeError from handle and invoke', () => {
    const reg = createDeeplinkRegistry();
    const msg = '[daas-toolbox] deeplink key must be a non-empty string, got an empty string';
    expect(() => reg.handle('', () => 1)).toThrow(new TypeError(msg));
    expect(() => reg.invoke('')).toThrow(new TypeError(msg));
  });

  test.each([42, undefined, null])('a %s key throws TypeError naming its type', (key) => {
    const reg = createDeeplinkRegistry();
    expect(() => reg.handle(key as unknown as string, () => 1)).toThrow(TypeError);
    expect(() => reg.invoke(key as unknown as string)).toThrow(
      `deeplink key must be a non-empty string, got ${typeof key}`,
    );
  });
});

describe('replace', () => {
  test('a new handler receives new calls', async () => {
    const reg = createDeeplinkRegistry();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reg.handle('k', () => 'old');
    reg.handle('k', () => 'new');
    await expect(reg.invoke('k')).resolves.toBe('new');
  });

  test('a call already running finishes on the handler that started it', async () => {
    const reg = createDeeplinkRegistry();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let release: (value: string) => void = () => {};
    reg.handle('k', () => new Promise<string>((resolve) => {
          release = resolve;
        }));
    const p = reg.invoke('k');
    await flush();
    reg.handle('k', () => 'new');
    release('old');
    await expect(p).resolves.toBe('old');
    await expect(reg.invoke('k')).resolves.toBe('new');
  });

  test('replacing logs a dev warning; the first registration does not', () => {
    const reg = createDeeplinkRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reg.handle('orders.open', () => 1);
    expect(warn).not.toHaveBeenCalled();
    reg.handle('orders.open', () => 2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[daas-toolbox] deeplink "orders.open" handler replaced');
  });
});

describe('dispose', () => {
  test('after dispose, new calls wait for the next registration', async () => {
    const reg = createDeeplinkRegistry();
    const off = reg.handle('k', () => 'first');
    off();
    expect(reg.has('k')).toBe(false);
    const p = reg.invoke('k');
    reg.handle('k', () => 'second');
    await expect(p).resolves.toBe('second');
  });

  test('a stale disposer does not remove a newer handler', async () => {
    const reg = createDeeplinkRegistry();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const offOld = reg.handle('k', () => 'old');
    reg.handle('k', () => 'new');
    offOld();
    expect(reg.has('k')).toBe(true);
    await expect(reg.invoke('k')).resolves.toBe('new');
  });

  test('the same function registered twice: the first disposer leaves the second registration', () => {
    const reg = createDeeplinkRegistry();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = () => 'same';
    const off1 = reg.handle('k', fn);
    const off2 = reg.handle('k', fn);
    off1();
    expect(reg.has('k')).toBe(true);
    off2();
    expect(reg.has('k')).toBe(false);
  });

  test('calling a disposer twice is a no-op', () => {
    const reg = createDeeplinkRegistry();
    const off = reg.handle('k', () => 1);
    off();
    reg.handle('k', () => 2);
    off();
    expect(reg.has('k')).toBe(true);
  });

  test('a call already running still settles after its handler is disposed', async () => {
    const reg = createDeeplinkRegistry();
    let release: (value: string) => void = () => {};
    const off = reg.handle('k', () => new Promise<string>((resolve) => {
          release = resolve;
        }));
    const p = reg.invoke('k');
    await flush();
    off();
    release('done');
    await expect(p).resolves.toBe('done');
  });
});

describe('has', () => {
  test('reflects whether a handler is registered', () => {
    const reg = createDeeplinkRegistry();
    expect(reg.has('k')).toBe(false);
    const off = reg.handle('k', () => 1);
    expect(reg.has('k')).toBe(true);
    off();
    expect(reg.has('k')).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/deeplink/__tests__/registry.spec.ts`
Expected: FAIL, because `../registry` cannot be resolved.

- [ ] **Step 3: Implement `src/deeplink/registry.ts`** (core only; Task 4 adds timeout and abort)

```ts
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
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run src/deeplink/__tests__/registry.spec.ts && npx tsc --noEmit -p .`
Expected: PASS (23 tests), and tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/deeplink
git commit -m "feat(daas-toolbox): deeplink registry core with queueing, replace and identity-safe dispose"
```

---

### Task 4: Timeout and caller abort

**Files:**
- Modify (full replacement): `src/deeplink/registry.ts`
- Test: `src/deeplink/__tests__/registry.timeout.spec.ts`

**Interfaces:**
- Consumes: `DeeplinkTimeoutError` from `./errors`; `DeeplinkPhase` from `./types`.
- Produces: the same `createDeeplinkRegistry(): DeeplinkRegistry`, now enforcing `options.timeout` (default `10000`) and `options.signal`.

- [ ] **Step 1: Write the failing tests** at `src/deeplink/__tests__/registry.timeout.spec.ts`

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DeeplinkTimeoutError } from '../errors';
import { createDeeplinkRegistry } from '../registry';
import type { DeeplinkHandlerContext } from '../types';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('timeout', () => {
  test('rejects with phase "waiting" when no handler registers in time', async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke('k', undefined, { timeout: 500 });
    const assertion = expect(p).rejects.toMatchObject({
      name: 'DeeplinkTimeoutError',
      key: 'k',
      phase: 'waiting',
      timeout: 500,
    });
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  test('defaults to 10000 ms', async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke('k');
    let rejected = false;
    p.catch(() => {
      rejected = true;
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(rejected).toBe(true);
    await expect(p).rejects.toBeInstanceOf(DeeplinkTimeoutError);
  });

  test('rejects with phase "running" and aborts ctx.signal when the handler is too slow', async () => {
    const reg = createDeeplinkRegistry();
    let seen: DeeplinkHandlerContext | undefined;
    reg.handle('k', (_params, ctx) => {
      seen = ctx;
      return new Promise<never>(() => {});
    });
    const p = reg.invoke('k', undefined, { timeout: 500 });
    const assertion = expect(p).rejects.toMatchObject({ phase: 'running' });
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(seen?.signal.aborted).toBe(true);
    expect(seen?.signal.reason).toBeInstanceOf(DeeplinkTimeoutError);
  });

  test('Infinity never times out', async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke('k', undefined, { timeout: Infinity });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    reg.handle('k', () => 'eventually');
    await expect(p).resolves.toBe('eventually');
  });

  test('a timeout above the setTimeout limit does not fire early', async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke('k', undefined, { timeout: 2 ** 31 });
    await vi.advanceTimersByTimeAsync(60 * 1000);
    reg.handle('k', () => 'ok');
    await expect(p).resolves.toBe('ok');
  });

  test('timeout 0 still lets an already-registered handler answer', async () => {
    const reg = createDeeplinkRegistry();
    reg.handle('k', () => 'fast');
    await expect(reg.invoke('k', undefined, { timeout: 0 })).resolves.toBe('fast');
  });

  test('a result arriving after the timeout is ignored', async () => {
    const reg = createDeeplinkRegistry();
    let release: (value: string) => void = () => {};
    reg.handle('k', () => new Promise<string>((resolve) => {
          release = resolve;
        }));
    const p = reg.invoke('k', undefined, { timeout: 100 });
    const assertion = expect(p).rejects.toBeInstanceOf(DeeplinkTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    release('too late');
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).rejects.toBeInstanceOf(DeeplinkTimeoutError);
  });

  test('a call that timed out while waiting is never delivered to a later handler', async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke('k', undefined, { timeout: 100 });
    const assertion = expect(p).rejects.toBeInstanceOf(DeeplinkTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    const handler = vi.fn();
    reg.handle('k', handler);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();
  });

  test.each([Number.NaN, -1, '100'])('timeout %s throws TypeError synchronously', (timeout) => {
    const reg = createDeeplinkRegistry();
    expect(() => reg.invoke('k', undefined, { timeout: timeout as number })).toThrow(
      `[daas-toolbox] deeplink timeout must be a non-negative number or Infinity, got ${String(timeout)}`,
    );
  });

  test('settling clears the timer', async () => {
    const reg = createDeeplinkRegistry();
    reg.handle('k', () => 'ok');
    await reg.invoke('k', undefined, { timeout: 500 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('caller abort', () => {
  test('an already-aborted signal rejects with its reason and never runs the handler', async () => {
    const reg = createDeeplinkRegistry();
    const handler = vi.fn();
    reg.handle('k', handler);
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(reg.invoke('k', undefined, { signal: controller.signal })).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('aborting while waiting removes the call from the queue', async () => {
    const reg = createDeeplinkRegistry();
    const controller = new AbortController();
    const p = reg.invoke('k', undefined, { signal: controller.signal });
    const reason = new Error('cancel');
    controller.abort(reason);
    await expect(p).rejects.toBe(reason);
    const handler = vi.fn();
    reg.handle('k', handler);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();
  });

  test('aborting one waiting call leaves the other waiting calls queued', async () => {
    const reg = createDeeplinkRegistry();
    const controller = new AbortController();
    const aborted = reg.invoke('k', { n: 1 }, { signal: controller.signal });
    const kept = reg.invoke('k', { n: 2 });
    controller.abort(new Error('cancel'));
    await expect(aborted).rejects.toThrow('cancel');
    reg.handle('k', (params) => params?.n);
    await expect(kept).resolves.toBe(2);
  });

  test('aborting while running aborts ctx.signal and rejects with the reason', async () => {
    const reg = createDeeplinkRegistry();
    let seen: DeeplinkHandlerContext | undefined;
    reg.handle('k', (_params, ctx) => {
      seen = ctx;
      return new Promise<never>(() => {});
    });
    const controller = new AbortController();
    const p = reg.invoke('k', undefined, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    const reason = new Error('user left');
    controller.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(seen?.signal.aborted).toBe(true);
    expect(seen?.signal.reason).toBe(reason);
  });

  test('settling removes the abort listener', async () => {
    const reg = createDeeplinkRegistry();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    reg.handle('k', () => 'ok');
    await reg.invoke('k', undefined, { signal: controller.signal });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/deeplink/__tests__/registry.timeout.spec.ts`
Expected: FAIL. The timeout tests hang until vitest's own timeout or never reject, and the invalid-timeout tests fail with "expected to throw".

- [ ] **Step 3: Replace `src/deeplink/registry.ts` with the full implementation**

```ts
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
```

- [ ] **Step 4: Run both registry suites and the typecheck**

Run: `npx vitest run src/deeplink && npx tsc --noEmit -p .`
Expected: PASS for `errors.spec.ts`, `registry.spec.ts` and `registry.timeout.spec.ts`, and tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/deeplink
git commit -m "feat(daas-toolbox): deeplink invoke timeout budget and caller abort"
```

---

### Task 5: Global singleton and `deeplink` export

**Files:**
- Create: `src/deeplink/global.ts`, `src/deeplink/index.ts`
- Test: `src/deeplink/__tests__/global.spec.ts`, `src/deeplink/__tests__/registry.prod.spec.ts`

**Interfaces:**
- Consumes: `createDeeplinkRegistry` from `./registry`; `isDev` from `../utils/isDev`.
- Produces: `getGlobalRegistry(): DeeplinkRegistry` (internal). `src/deeplink/index.ts` exports `deeplink` (the shared `DeeplinkRegistry`), `createDeeplinkRegistry`, `DeeplinkTimeoutError`, `isDeeplinkTimeoutError`, and the types `DeeplinkHandler`, `DeeplinkHandlerContext`, `DeeplinkInvokeOptions`, `DeeplinkParams`, `DeeplinkPhase`, `DeeplinkRegistry`.

- [ ] **Step 1: Write the failing tests**

`src/deeplink/__tests__/global.spec.ts`:

```ts
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
```

`src/deeplink/__tests__/registry.prod.spec.ts`:

```ts
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

test('replacing a handler does not warn in production', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const reg = createDeeplinkRegistry();
  reg.handle('k', () => 1);
  reg.handle('k', () => 2);
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
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/deeplink/__tests__/global.spec.ts src/deeplink/__tests__/registry.prod.spec.ts`
Expected: FAIL. `global.spec.ts` and the second prod test cannot resolve `../index`. The first prod test passes already, because the registry exists since Task 3.

- [ ] **Step 3: Implement `src/deeplink/global.ts`**

```ts
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
```

- [ ] **Step 4: Implement `src/deeplink/index.ts`**

```ts
import { getGlobalRegistry } from './global';

/**
 * The page-wide deeplink handler registry, shared by every MFE.
 * @example
 * // owner MFE
 * const off = deeplink.handle('orders.open', async (params) => ({ opened: true }));
 * // any MFE
 * const res = await deeplink.invoke<{ opened: boolean }>('orders.open', { id: '42' });
 */
export const deeplink = getGlobalRegistry();

export { DeeplinkTimeoutError, isDeeplinkTimeoutError } from './errors';
export { createDeeplinkRegistry } from './registry';
export type {
  DeeplinkHandler,
  DeeplinkHandlerContext,
  DeeplinkInvokeOptions,
  DeeplinkParams,
  DeeplinkPhase,
  DeeplinkRegistry,
} from './types';
```

- [ ] **Step 5: Run the deeplink suites and the typecheck**

Run: `npx vitest run src/deeplink && npx tsc --noEmit -p .`
Expected: all 5 deeplink spec files PASS, and tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/deeplink
git commit -m "feat(daas-toolbox): page-wide deeplink singleton via Symbol.for"
```

---

### Task 6: `useDeeplinkHandler` hook

**Files:**
- Create: `src/hooks/useDeeplinkHandler/index.ts`
- Modify: `src/hooks/index.ts` (add the export)
- Test: `src/hooks/useDeeplinkHandler/__tests__/index.spec.ts`

**Interfaces:**
- Consumes: `deeplink` from `../../deeplink`; `DeeplinkHandler` type from `../../deeplink/types`; `useLatest` default export from `../useLatest`.
- Produces: `useDeeplinkHandler<TResult>(key: string, handler: DeeplinkHandler<TResult>): void`, the default export, re-exported by name from `src/hooks/index.ts`.

- [ ] **Step 1: Write the failing tests** at `src/hooks/useDeeplinkHandler/__tests__/index.spec.ts`

```ts
import { renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { deeplink } from '../../../deeplink';
import useDeeplinkHandler from '../index';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDeeplinkHandler', () => {
  test('registers on mount and disposes on unmount', async () => {
    const { unmount } = renderHook(() => useDeeplinkHandler('hook.mount', () => 'ok'));
    expect(deeplink.has('hook.mount')).toBe(true);
    await expect(deeplink.invoke('hook.mount')).resolves.toBe('ok');
    unmount();
    expect(deeplink.has('hook.mount')).toBe(false);
  });

  test('uses the latest handler closure without re-registering', async () => {
    const handle = vi.spyOn(deeplink, 'handle');
    const { rerender, unmount } = renderHook(
      ({ value }) => useDeeplinkHandler('hook.latest', () => value),
      { initialProps: { value: 1 } },
    );
    rerender({ value: 2 });
    await expect(deeplink.invoke('hook.latest')).resolves.toBe(2);
    expect(handle).toHaveBeenCalledTimes(1);
    unmount();
  });

  test('changing the key disposes the old key and registers the new one', () => {
    const { rerender, unmount } = renderHook(({ k }) => useDeeplinkHandler(k, () => k), {
      initialProps: { k: 'hook.key.a' },
    });
    expect(deeplink.has('hook.key.a')).toBe(true);
    rerender({ k: 'hook.key.b' });
    expect(deeplink.has('hook.key.a')).toBe(false);
    expect(deeplink.has('hook.key.b')).toBe(true);
    unmount();
    expect(deeplink.has('hook.key.b')).toBe(false);
  });

  test('StrictMode double-mount leaves exactly one live handler and no replace warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { unmount } = renderHook(() => useDeeplinkHandler('hook.strict', () => 'strict'), {
      wrapper: StrictMode,
    });
    expect(deeplink.has('hook.strict')).toBe(true);
    await expect(deeplink.invoke('hook.strict')).resolves.toBe('strict');
    expect(warn).not.toHaveBeenCalled();
    unmount();
    expect(deeplink.has('hook.strict')).toBe(false);
  });

  test('a call made before mount is delivered once the hook registers', async () => {
    const p = deeplink.invoke('hook.early', { id: 7 });
    const { unmount } = renderHook(() => useDeeplinkHandler('hook.early', (params) => params?.id));
    await expect(p).resolves.toBe(7);
    unmount();
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/hooks/useDeeplinkHandler`
Expected: FAIL, because `../index` cannot be resolved.

- [ ] **Step 3: Implement `src/hooks/useDeeplinkHandler/index.ts`**

```ts
import { useEffect } from 'react';
import { deeplink } from '../../deeplink';
import type { DeeplinkHandler } from '../../deeplink/types';
import useLatest from '../useLatest';

/**
 * Register a deeplink handler for the lifetime of the component.
 *
 * Registers once per `key` and always calls the latest `handler`, so re-renders never
 * re-register (and an invoke arriving mid-render is never missed). Disposes on unmount
 * or when `key` changes. Safe under React StrictMode.
 *
 * @example
 * useDeeplinkHandler('orders.open', async (params, { signal }) => {
 *   const order = await api.getOrder(params?.id as string, { signal });
 *   openOrderDrawer(order);
 *   return { opened: true };
 * });
 */
function useDeeplinkHandler<TResult>(key: string, handler: DeeplinkHandler<TResult>): void {
  const handlerRef = useLatest(handler);

  // biome-ignore lint/correctness/useExhaustiveDependencies: handlerRef is a stable ref; re-registering on every handler change is exactly what this hook avoids
  useEffect(
    () => deeplink.handle<TResult>(key, (params, ctx) => handlerRef.current(params, ctx)),
    [key],
  );
}

export default useDeeplinkHandler;
```

- [ ] **Step 4: Export it from `src/hooks/index.ts`.** Add this line after the `useHistoryTravel` export so the list stays alphabetical:

```ts
export { default as useDeeplinkHandler } from './useDeeplinkHandler';
```

- [ ] **Step 5: Run the hook tests and the typecheck**

Run: `npx vitest run src/hooks/useDeeplinkHandler && npx tsc --noEmit -p .`
Expected: PASS (5 tests), and tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/hooks
git commit -m "feat(daas-toolbox): useDeeplinkHandler hook"
```

---

### Task 7: Root barrel, README, coverage gate, lint, final verification

**Files:**
- Modify: `src/index.ts`, `src/__tests__/index.spec.ts`, `README.md`

**Interfaces:**
- Consumes: everything exported by `src/deeplink/index.ts` and `src/hooks/index.ts`.
- Produces: the final public surface of `@daas/toolbox`.

- [ ] **Step 1: Extend the barrel test.** Replace `src/__tests__/index.spec.ts` with:

```ts
import { describe, expect, test } from 'vitest';
import * as toolbox from '../index';

const exported = toolbox as Record<string, unknown>;

describe('@daas/toolbox barrel', () => {
  test.each([
    'useRequest',
    'useHistoryTravel',
    'useMount',
    'useWhyDidYouUpdate',
    'useDeeplinkHandler',
    'clearCache',
    'isCancelledError',
    'CancelledError',
    'createDeeplinkRegistry',
    'DeeplinkTimeoutError',
    'isDeeplinkTimeoutError',
  ])('exports %s', (name) => {
    expect(typeof exported[name]).toBe('function');
  });

  test('exports the shared deeplink registry', () => {
    expect(toolbox.deeplink).toEqual({
      handle: expect.any(Function),
      invoke: expect.any(Function),
      has: expect.any(Function),
    });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/__tests__/index.spec.ts`
Expected: FAIL on `createDeeplinkRegistry`, `DeeplinkTimeoutError`, `isDeeplinkTimeoutError` and `deeplink`, which the root does not export yet. `useDeeplinkHandler` already passes through `./hooks`.

- [ ] **Step 3: Replace `src/index.ts`**

```ts
export * from './deeplink';
export * from './hooks';
```

- [ ] **Step 4: Replace `README.md`**

````markdown
# @daas/toolbox

DaaS toolbox: pure TypeScript source, copied by hand into the SDK. Not published to npm.
No runtime dependencies besides `react` (≥16.8).

```
src/
  hooks/      vendored subset of ahooks 3.10.1 (MIT) + useDeeplinkHandler
  deeplink/   cross-MFE deeplink handler registry
  utils/      shared helpers
```

## Hooks

| Hook | Notes |
| --- | --- |
| `useRequest` | All built-in plugins (auto-run, cache, debounce, throttle, polling, retry, loading delay, refresh on focus). Also exports `clearCache`, `CancelledError`, `isCancelledError`. |
| `useHistoryTravel` | |
| `useMount` | |
| `useWhyDidYouUpdate` | |
| `useDeeplinkHandler` | Registers a deeplink handler for the component's lifetime (see below). |

Internal helpers (`useMemoizedFn`, `useLatest`, `useUpdate`, `useUnmount`, `useCreation`,
`useUpdateEffect`, `createUpdateEffect`) are kept because the hooks above depend on them.

Differences from upstream ahooks: `lodash/debounce` and `lodash/throttle` are replaced by
`src/utils/debounce.ts`, and `src/utils/isDev.ts` no longer needs `@types/node`.

## Deeplink handlers

Lets one MFE handle a deeplink key and lets any other MFE invoke it and get the result back.
Keys match the `deeplink` string used by daas-sdk `navigate(deeplink, params, options)`.

```ts
import { deeplink, isDeeplinkTimeoutError, useDeeplinkHandler } from './toolbox';

// Owner MFE: register for the component's lifetime
useDeeplinkHandler('orders.open', async (params, { signal }) => {
  const order = await api.getOrder(params?.id as string, { signal });
  openOrderDrawer(order);
  return { opened: true };
});

// Any MFE: invoke and await the result
try {
  const res = await deeplink.invoke<{ opened: boolean }>('orders.open', { id: '42' });
} catch (e) {
  if (isDeeplinkTimeoutError(e) && e.phase === 'waiting') {
    // the owner MFE never registered a handler (not loaded?)
  }
}
```

Behavior:

- **One handler per key; the latest registration wins.** A dev warning is logged when a
  handler is replaced. Name keys `<mfe>.<action>` to avoid collisions.
- **Calls wait for a handler.** An `invoke` made before the owner registers is queued and
  delivered once it does.
- **Timeout:** `options.timeout` (default `10000` ms) covers both the wait and the run.
  `Infinity` disables it. The rejection is a `DeeplinkTimeoutError` with `phase: 'waiting' | 'running'`.
- **Cancellation:** pass `options.signal` to cancel from the caller. Handlers receive
  `ctx.signal`, which is aborted on timeout or caller abort; forward it to `fetch` and similar APIs.
- **Errors** thrown by the handler reach the caller unchanged.
- **One registry per page:** it is stored at `globalThis[Symbol.for('daas-toolbox/deeplink')]`,
  so it stays shared even if an MFE bundles its own copy of the toolbox.
- Outside React, use `deeplink.handle(key, handler)`, which returns a disposer.

## Copying into an SDK

Copy `src/` and `LICENSE` (required by ahooks' MIT license). You can skip `**/__tests__/`
and `src/utils/testingHelpers.ts`. The target tsconfig needs `strict`-compatible settings and
the `DOM` lib.

## Checks

```bash
pnpm --filter @daas/toolbox tsc
pnpm --filter @daas/toolbox test
```
````

- [ ] **Step 5: Run the full suite, typecheck, and coverage gate for the new code**

```bash
npx tsc --noEmit -p .
npx vitest run
npx vitest run --coverage \
  --coverage.include='src/deeplink/**' \
  --coverage.include='src/hooks/useDeeplinkHandler/**' \
  --coverage.thresholds.100
```
Expected: tsc exits 0. Every test file passes. The coverage run reports 100% statements, branches, functions and lines for the included files and exits 0. If a branch is uncovered, add a test for it to the spec file that owns that code; do not lower the threshold.

- [ ] **Step 6: Lint and format with the repo-pinned Biome** (from the repo root)

```bash
cd <repo-root>
npx biome check --fix packages/daas-toolbox/src/deeplink packages/daas-toolbox/src/hooks/useDeeplinkHandler packages/daas-toolbox/src/hooks/index.ts packages/daas-toolbox/src/index.ts packages/daas-toolbox/src/__tests__
npx biome check packages/daas-toolbox/src/deeplink packages/daas-toolbox/src/hooks/useDeeplinkHandler packages/daas-toolbox/src/hooks/index.ts packages/daas-toolbox/src/index.ts packages/daas-toolbox/src/__tests__
git status --short
```
Expected: the second command reports no errors. `git status` shows changes only under `packages/daas-toolbox/`. If anything outside that folder changed, run `git checkout -- <path>` on it. The vendored ahooks code still has its upstream lint findings; leave them alone.

- [ ] **Step 7: Rerun tests after formatting, then commit**

```bash
cd <repo-root>/packages/daas-toolbox && npx vitest run
cd <repo-root>
git add packages/daas-toolbox
git commit -m "feat(daas-toolbox): export deeplink API from root and document it"
```
