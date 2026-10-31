# Deeplink Middleware Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-handler deeplink registry with onion-style middleware chains. Several MFEs register ordered handlers per key (with a required `owner`, so duplicates replace instead of stacking), the host registers global handlers that wrap every key, and the host tracks registration status through `inspect()` and `subscribe()`.

**Architecture:** A pure `compose(steps, ctx)` runs a chain snapshot as an onion (`await next(ctx)`). `createDeeplinkRegistry()` stores, per key, a sorted list of registrations plus one sorted global list. It snapshots `[...global, ...keyHandlers]` when a call starts and keeps the existing timeout, abort and queue machinery. Waiting calls start one microtask after the first key handler is registered (batch flush). `useDeeplinkHandler` is the recommended MFE path (it unregisters automatically on unmount). The plain `registerHandler` / `registerGlobalHandler` stay public for the host, non-React code and MFEs on another React version.

**Tech Stack:** TypeScript (strict, `verbatimModuleSyntax`), React ≥16.8, vitest + jsdom + `@testing-library/react`, Biome (repo-pinned, `lineWidth: 100`, single quotes).

**Spec:** `packages/daas-toolbox/docs/specs/2026-10-10-deeplink-middleware-chain-design.md`. Where it is silent, the base spec `2026-10-09-daas-toolbox-deeplink-design.md` still governs (timeout, abort, global singleton, errors).

## Global Constraints

- No new runtime dependencies. `react` stays the only runtime import, and nothing imports `@chrisluyi/daas-sdk`.
- Public names: `registerHandler(key, handler, options)`, `registerGlobalHandler(handler, options)`, `invoke`, `has`, `inspect`, `subscribe`; `useDeeplinkHandler(key, handler, options)`; types `DeeplinkHandler`, `DeeplinkNext`, `DeeplinkCallContext`, `DeeplinkStepInfo`, `DeeplinkRegisterOptions`, `DeeplinkStepStatus`, `DeeplinkStatus`, `DeeplinkInspection`, `TypedDeeplinkCallContext`, `TypedDeeplinkNext`, `TypedDeeplinkHandler`.
- `options.owner` is **required** (a non-empty string) for `registerHandler`, `registerGlobalHandler` and the hook.
- All messages start with `[daas-toolbox]`. Exact texts:
  - `[daas-toolbox] deeplink "<key>" handler from owner "<owner>" replaced` (dev warn)
  - `[daas-toolbox] global handler from owner "<owner>" replaced` (dev warn)
  - `[daas-toolbox] deeplink "<key>": next() called multiple times` (rejection `Error`)
  - `[daas-toolbox] deeplink handler must be a function` (`TypeError`)
  - `[daas-toolbox] deeplink order must be a finite number, got <String(value)>` (`TypeError`)
  - `[daas-toolbox] deeplink owner must be a non-empty string` (`TypeError`)
  - `[daas-toolbox] deeplink subscriber threw` (dev `console.error`, second argument is the thrown value)
- `order` defaults to `0`. Lower runs first (outermost), and ties go by registration order.
- Global handlers are always outermost, never satisfy the wait rule, never trigger the batch flush, and `has()` ignores them.
- Default timeout `10000` ms; `Infinity` disables it; delays are clamped to `2147483647`. Only an invalid key throws synchronously from `invoke`.
- Code style (AGENTS.md): `interface` for object shapes, `type` for unions and functions, no `enum`, no non-null `!`, JSDoc on public types, `as` only where unavoidable.
- Coverage must be 100% for `src/deeplink/**` and `src/hooks/useDeeplinkHandler/**`.
- Run Biome with the repo-pinned `npx biome`, never `bunx`. Commit headers and body lines must be ≤ 100 characters (commitlint).
- Work on branch `daas-hooks`. Commit after each task. Don't push.

## Review Focus

1. **Register then unregister in the same tick while a call is waiting:** the batch flush finds no chain. The call must keep waiting, not crash or run an empty chain. Tested in Task 2.
2. **Every waiting call aborted before the batch microtask runs:** the flush is a no-op, and later invokes work normally. Tested in Task 2.
3. **Concurrent and nested invokes:** each call gets its own `state`, and a handler that invokes another key mid-chain works. Tested in Task 2.
4. **A subscriber that calls `inspect()` inside its listener** sees the change already applied. Tested in Task 3.
5. **The same owner name used for a key handler and for a global handler:** they are independent, and neither replaces the other. Tested in Task 3.

---

## File Structure (end state)

```
packages/daas-toolbox/src/
  deeplink/
    types.ts            handler/context/options/status + typed-contract types (Task 2; edited in 3, 4)
    compose.ts          NEW pure onion runner (Task 1)
    registry.ts         chains, owner replace, batch flush (Task 2); global + tracking (Task 3)
    typed.ts            typed facade, new names (Task 2); registerGlobalHandler/inspect/subscribe (Task 4)
    index.ts            exports (Task 2)
    errors.ts, global.ts  unchanged
    __tests__/
      compose.spec.ts            NEW (Task 1)
      registry.spec.ts           rewritten (Task 2)
      registry.timeout.spec.ts   rewritten (Task 2)
      registry.prod.spec.ts      rewritten (Task 2), appended (Task 3)
      registry.global.spec.ts    NEW (Task 3)
      registry.inspect.spec.ts   NEW (Task 3)
      typed.spec.ts              rewritten (Task 2), appended (Task 4)
      global.spec.ts             one call renamed (Task 2)
  hooks/useDeeplinkHandler/index.ts                 final version (Task 2)
  hooks/useDeeplinkHandler/__tests__/index.spec.ts  rewritten (Task 2)
  __tests__/index.spec.ts                           barrel expectation (Tasks 2 and 3)
packages/daas-toolbox/README.md                     deeplink section rewritten (Task 5)
```

All commands run from `/home/chris/Github/hooks/packages/daas-toolbox` unless stated otherwise.

---

### Task 1: Pure onion `compose`

**Files:**
- Modify: `src/deeplink/types.ts` (append three types)
- Create: `src/deeplink/compose.ts`
- Test: `src/deeplink/__tests__/compose.spec.ts`

**Interfaces:**
- Produces (types, appended now and kept verbatim by Task 2's full rewrite): `DeeplinkStepInfo { index: number; count: number; owner: string; global: boolean }`, `DeeplinkCallContext`, `DeeplinkNext = (ctx?: DeeplinkCallContext) => Promise<unknown>`. (`DeeplinkHandler` is **not** added here: the old `DeeplinkHandler<TResult>` still exists until Task 2 replaces it.)
- Produces (`compose.ts`): `interface ComposeStep { handler: (ctx: DeeplinkCallContext, next: DeeplinkNext) => unknown; owner: string; global: boolean }` and `compose(steps: readonly ComposeStep[], ctx: DeeplinkCallContext): Promise<unknown>`.

- [ ] **Step 1: Append the chain types to `src/deeplink/types.ts`**

```ts

/** Position of a handler within one call's chain. */
export interface DeeplinkStepInfo {
  /** 0-based position in this call's chain snapshot. */
  index: number;
  /** Number of handlers in this call's chain snapshot. */
  count: number;
  /** The handler's owner. */
  owner: string;
  /** Whether this is a global handler (`registerGlobalHandler`) rather than a key handler. */
  global: boolean;
}

/**
 * Context each handler receives. `key`, `input`, `options`, `signal` and `step` are owned by the
 * runtime: values passed for them through `next(ctx)` are overwritten.
 */
export interface DeeplinkCallContext {
  /** The invoked key. */
  readonly key: string;
  /** Current payload. Starts as the caller's params; upstream handlers may replace it via next(ctx). */
  params: unknown;
  /** The caller's original params; never changed by handlers. */
  readonly input: DeeplinkParams;
  /** The options the caller passed (`{}` when omitted). */
  readonly options: DeeplinkInvokeOptions;
  /** Aborted on timeout or caller abort; the same signal for every handler of the call. */
  readonly signal: AbortSignal;
  /** Position of the handler receiving this context. */
  readonly step: DeeplinkStepInfo;
  /** Scratch space shared by every handler of this call. */
  state: Record<string, unknown>;
}

/**
 * Continue the chain. Pass a new context to change what downstream handlers see. Resolves to
 * what downstream returned; after the last handler, to that context's `params`.
 */
export type DeeplinkNext = (ctx?: DeeplinkCallContext) => Promise<unknown>;
```

- [ ] **Step 2: Write the failing test** at `src/deeplink/__tests__/compose.spec.ts`

```ts
import { describe, expect, test, vi } from 'vitest';
import { type ComposeStep, compose } from '../compose';
import type { DeeplinkCallContext, DeeplinkParams, DeeplinkStepInfo } from '../types';

type Handler = ComposeStep['handler'];

const signal = new AbortController().signal;

function makeCtx(params: unknown = { id: 1 }): DeeplinkCallContext {
  return {
    key: 'k',
    params,
    input: params as DeeplinkParams,
    options: {},
    signal,
    step: { index: -1, count: 0, owner: '', global: false },
    state: {},
  };
}

function step(handler: Handler, owner = 'o', global = false): ComposeStep {
  return { handler, owner, global };
}

/** Records `<name>-in` / `<name>-out` around next(). */
function tracer(trace: string[], name: string): Handler {
  return async (_ctx, next) => {
    trace.push(`${name}-in`);
    const res = await next();
    trace.push(`${name}-out`);
    return res;
  };
}

describe('compose', () => {
  test('an empty chain resolves to the context params', async () => {
    await expect(compose([], makeCtx({ a: 1 }))).resolves.toEqual({ a: 1 });
  });

  test('runs handlers as an onion and returns the innermost value outward', async () => {
    const trace: string[] = [];
    const inner: Handler = () => {
      trace.push('c-in');
      trace.push('c-out');
      return 'result';
    };
    const res = await compose(
      [step(tracer(trace, 'a')), step(tracer(trace, 'b')), step(inner)],
      makeCtx(),
    );
    expect(res).toBe('result');
    expect(trace).toEqual(['a-in', 'b-in', 'c-in', 'c-out', 'b-out', 'a-out']);
  });

  test('next(newCtx) changes params for downstream handlers only', async () => {
    let seenByInner: unknown;
    let outerAfter: unknown;
    const outer: Handler = async (ctx, next) => {
      const res = await next({ ...ctx, params: { id: 2 } });
      outerAfter = ctx.params;
      return res;
    };
    const inner: Handler = (ctx) => {
      seenByInner = ctx.params;
      return 'ok';
    };
    await compose([step(outer), step(inner)], makeCtx({ id: 1 }));
    expect(seenByInner).toEqual({ id: 2 });
    expect(outerAfter).toEqual({ id: 1 });
  });

  test('runtime-owned fields cannot be overwritten through next(ctx)', async () => {
    const ctx = makeCtx({ id: 1 });
    let seen: DeeplinkCallContext | undefined;
    const outer: Handler = (c, next) =>
      next({
        ...c,
        key: 'hijacked',
        input: { evil: true },
        options: { evil: true },
        signal: new AbortController().signal,
        step: { index: 99, count: 99, owner: 'evil', global: true },
      });
    const inner: Handler = (c) => {
      seen = c;
      return 'ok';
    };
    await compose([step(outer, 'outer'), step(inner, 'inner')], ctx);
    expect(seen?.key).toBe('k');
    expect(seen?.input).toBe(ctx.input);
    expect(seen?.options).toBe(ctx.options);
    expect(seen?.signal).toBe(signal);
    expect(seen?.step).toEqual({ index: 1, count: 2, owner: 'inner', global: false });
  });

  test('state is shared by every handler of the call', async () => {
    const outer: Handler = async (ctx, next) => {
      ctx.state.fromOuter = 1;
      await next();
      return ctx.state.fromInner;
    };
    const inner: Handler = (ctx) => {
      ctx.state.fromInner = ctx.state.fromOuter;
      return undefined;
    };
    await expect(compose([step(outer), step(inner)], makeCtx())).resolves.toBe(1);
  });

  test('a transform-only chain returns the final params', async () => {
    const setN: Handler = (ctx, next) => next({ ...ctx, params: { n: 1 } });
    const inc: Handler = (ctx, next) =>
      next({ ...ctx, params: { n: (ctx.params as { n: number }).n + 1 } });
    await expect(compose([step(setN), step(inc)], makeCtx())).resolves.toEqual({ n: 2 });
  });

  test('a handler that does not call next short-circuits; outer handlers still see the value', async () => {
    const innermost = vi.fn(() => 'never');
    const outer: Handler = async (_ctx, next) => `outer(${String(await next())})`;
    const mock: Handler = () => 'mock';
    await expect(
      compose([step(outer), step(mock), step(innermost)], makeCtx()),
    ).resolves.toBe('outer(mock)');
    expect(innermost).not.toHaveBeenCalled();
  });

  test('an inner error propagates unchanged through outer handlers', async () => {
    const boom = new Error('boom');
    const afterNext = vi.fn();
    const outer: Handler = async (_ctx, next) => {
      const res = await next();
      afterNext();
      return res;
    };
    const failing: Handler = () => {
      throw boom;
    };
    await expect(compose([step(outer), step(failing)], makeCtx())).rejects.toBe(boom);
    expect(afterNext).not.toHaveBeenCalled();
  });

  test('an outer handler can recover from an inner error', async () => {
    const outer: Handler = async (_ctx, next) => {
      try {
        return await next();
      } catch {
        return 'recovered';
      }
    };
    const failing: Handler = async () => {
      throw new Error('inner');
    };
    await expect(compose([step(outer), step(failing)], makeCtx())).resolves.toBe('recovered');
  });

  test('a synchronous throw becomes a rejection, not a synchronous throw', async () => {
    const failing: Handler = () => {
      throw new Error('sync');
    };
    let p: Promise<unknown> = Promise.resolve();
    expect(() => {
      p = compose([step(failing)], makeCtx());
    }).not.toThrow();
    await expect(p).rejects.toThrow('sync');
  });

  test('calling next() twice rejects the second call; the first result is used', async () => {
    const inner = vi.fn(() => 'once');
    const errors: unknown[] = [];
    const outer: Handler = async (_ctx, next) => {
      const first = await next();
      await next().catch((e: unknown) => errors.push(e));
      return first;
    };
    await expect(compose([step(outer), step(inner)], makeCtx())).resolves.toBe('once');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe(
      '[daas-toolbox] deeplink "k": next() called multiple times',
    );
  });

  test('each handler receives its index, count, owner and global flag', async () => {
    const infos: DeeplinkStepInfo[] = [];
    const record: Handler = (ctx, next) => {
      infos.push(ctx.step);
      return next();
    };
    await compose([step(record, 'log', true), step(record, 'orders')], makeCtx());
    expect(infos).toEqual([
      { index: 0, count: 2, owner: 'log', global: true },
      { index: 1, count: 2, owner: 'orders', global: false },
    ]);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run src/deeplink/__tests__/compose.spec.ts`
Expected: FAIL with `Failed to resolve import "../compose"`.

- [ ] **Step 4: Implement `src/deeplink/compose.ts`**

```ts
import type { DeeplinkCallContext, DeeplinkNext } from './types';

/** One entry of a chain snapshot. */
export interface ComposeStep {
  handler: (ctx: DeeplinkCallContext, next: DeeplinkNext) => unknown;
  owner: string;
  global: boolean;
}

/** Call-wide fields the runtime owns; handlers cannot change them through next(ctx). */
type FixedFields = Pick<DeeplinkCallContext, 'key' | 'input' | 'options' | 'signal'>;

/**
 * Run `steps` as an onion around `ctx`: each handler gets `next`, which runs the rest of the
 * chain. After the last handler, `next()` resolves to the current `params`. Handlers always run
 * inside a Promise chain, so a synchronous throw becomes a rejection.
 */
export function compose(steps: readonly ComposeStep[], ctx: DeeplinkCallContext): Promise<unknown> {
  const fixed: FixedFields = {
    key: ctx.key,
    input: ctx.input,
    options: ctx.options,
    signal: ctx.signal,
  };

  function dispatch(index: number, current: DeeplinkCallContext): Promise<unknown> {
    if (index === steps.length) return Promise.resolve(current.params);
    const { handler, owner, global } = steps[index];
    const stepCtx: DeeplinkCallContext = {
      ...current,
      ...fixed,
      step: { index, count: steps.length, owner, global },
    };
    let called = false;
    const next: DeeplinkNext = (nextCtx) => {
      if (called) {
        return Promise.reject(
          new Error(`[daas-toolbox] deeplink "${fixed.key}": next() called multiple times`),
        );
      }
      called = true;
      return dispatch(index + 1, nextCtx ?? stepCtx);
    };
    return Promise.resolve().then(() => handler(stepCtx, next));
  }

  return dispatch(0, ctx);
}
```

- [ ] **Step 5: Run the test and the typecheck**

Run: `npx vitest run src/deeplink/__tests__/compose.spec.ts && npx tsc --noEmit -p .`
Expected: PASS (12 tests), and tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/deeplink
git commit -m "feat(daas-toolbox): pure onion compose for deeplink handlers"
```

---

### Task 2: Key-handler chains, required owner, final hook, and migration of every consumer

**Files:**
- Rewrite: `src/deeplink/types.ts`, `src/deeplink/registry.ts`, `src/deeplink/typed.ts`, `src/deeplink/index.ts`, `src/hooks/useDeeplinkHandler/index.ts`
- Rewrite tests: `src/deeplink/__tests__/registry.spec.ts`, `registry.timeout.spec.ts`, `registry.prod.spec.ts`, `typed.spec.ts`, `src/hooks/useDeeplinkHandler/__tests__/index.spec.ts`
- Edit tests: `src/deeplink/__tests__/global.spec.ts` (one call), `src/__tests__/index.spec.ts` (barrel)

**Interfaces:**
- Consumes: `compose`, `ComposeStep` (Task 1).
- Produces: `DeeplinkHandler = (ctx: DeeplinkCallContext, next: DeeplinkNext) => unknown`; `DeeplinkRegisterOptions { owner: string; order?: number }`; `DeeplinkRegistry.registerHandler(key: string, handler: DeeplinkHandler, options: DeeplinkRegisterOptions): () => void`, `invoke`, `has`; `DeeplinkStepStatus { owner: string; order: number }`, `DeeplinkStatus`, `DeeplinkInspection`; `TypedDeeplinkCallContext<C>`, `TypedDeeplinkNext<C>`, `TypedDeeplinkHandler<C>`; `TypedDeeplinkRegistry.registerHandler/invoke/has`; `useDeeplinkHandler(key, handler, options)` and `useDeeplinkHandler(typedRegistry, key, handler, options)`. **Removed:** `handle`, the old `DeeplinkHandler<TResult>`, `DeeplinkHandlerContext`, `TypedDeeplinkHandler` (old shape).

- [ ] **Step 1: Write the failing registry tests.** Replace `src/deeplink/__tests__/registry.spec.ts` with:

```ts
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDeeplinkRegistry } from '../registry';
import type { DeeplinkCallContext, DeeplinkHandler, DeeplinkRegisterOptions } from '../types';

/** Lets pending microtasks and 0 ms timers run (real timers in this file). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Records `<name>-in` / `<name>-out` around next(). */
function tracer(trace: string[], name: string): DeeplinkHandler {
  return async (_ctx, next) => {
    trace.push(`${name}-in`);
    const res = await next();
    trace.push(`${name}-out`);
    return res;
  };
}

const own = { owner: 'test' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('single handler', () => {
  test('resolves with the result of an async handler', async () => {
    const reg = createDeeplinkRegistry();
    reg.registerHandler('orders.open', async () => ({ opened: true }), own);
    await expect(reg.invoke('orders.open')).resolves.toEqual({ opened: true });
  });

  test('resolves with the return value of a sync handler', async () => {
    const reg = createDeeplinkRegistry();
    reg.registerHandler('k', () => 42, own);
    await expect(reg.invoke('k')).resolves.toBe(42);
  });

  test('the handler sees params, input, the exact options object and a live signal', async () => {
    const reg = createDeeplinkRegistry();
    let seen: DeeplinkCallContext | undefined;
    reg.registerHandler(
      'k',
      (ctx) => {
        seen = ctx;
        return 'ok';
      },
      own,
    );
    const options = { timeout: 5000, tab: 'items' };
    await reg.invoke('k', { id: 42 }, options);
    expect(seen?.key).toBe('k');
    expect(seen?.params).toEqual({ id: 42 });
    expect(seen?.input).toEqual({ id: 42 });
    expect(seen?.options).toBe(options);
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(seen?.signal.aborted).toBe(false);
    expect(seen?.state).toEqual({});
    expect(seen?.step).toEqual({ index: 0, count: 1, owner: 'test', global: false });
  });

  test('omitted params and options become undefined and {}', async () => {
    const reg = createDeeplinkRegistry();
    let seen: DeeplinkCallContext | undefined;
    reg.registerHandler(
      'k',
      (ctx) => {
        seen = ctx;
        return 'ok';
      },
      own,
    );
    await reg.invoke('k');
    expect(seen?.params).toBeUndefined();
    expect(seen?.options).toEqual({});
  });
});

describe('waiting for a first handler', () => {
  test('a call made before any handler resolves once one is registered', async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke('k', { id: 1 });
    const handler = vi.fn((ctx: DeeplinkCallContext) => ctx.params);
    await flush();
    expect(handler).not.toHaveBeenCalled();
    reg.registerHandler('k', handler, own);
    await expect(p).resolves.toEqual({ id: 1 });
  });

  test('several waiting calls each run, in arrival order', async () => {
    const reg = createDeeplinkRegistry();
    const order: unknown[] = [];
    const calls = [reg.invoke('k', { n: 1 }), reg.invoke('k', { n: 2 }), reg.invoke('k', { n: 3 })];
    reg.registerHandler(
      'k',
      (ctx) => {
        const n = (ctx.params as { n: number }).n;
        order.push(n);
        return n;
      },
      own,
    );
    await expect(Promise.all(calls)).resolves.toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test('a handler for another key does not start waiting calls', async () => {
    const reg = createDeeplinkRegistry();
    const pB = reg.invoke('b');
    const aHandler = vi.fn(() => 'a');
    reg.registerHandler('a', aHandler, own);
    await flush();
    expect(aHandler).not.toHaveBeenCalled();
    reg.registerHandler('b', () => 'b', own);
    await expect(pB).resolves.toBe('b');
  });
});

describe('chain order', () => {
  test('handlers run by ascending order regardless of registration order', async () => {
    const reg = createDeeplinkRegistry();
    const trace: string[] = [];
    reg.registerHandler('k', tracer(trace, 'c'), { owner: 'c', order: 30 });
    reg.registerHandler('k', tracer(trace, 'a'), { owner: 'a', order: 10 });
    reg.registerHandler('k', tracer(trace, 'b'), { owner: 'b', order: 20 });
    await reg.invoke('k');
    expect(trace).toEqual(['a-in', 'b-in', 'c-in', 'c-out', 'b-out', 'a-out']);
  });

  test('ties keep registration order; negative and fractional orders work', async () => {
    const reg = createDeeplinkRegistry();
    const trace: string[] = [];
    reg.registerHandler('k', tracer(trace, 'x'), { owner: 'x' });
    reg.registerHandler('k', tracer(trace, 'y'), { owner: 'y', order: -1.5 });
    reg.registerHandler('k', tracer(trace, 'z'), { owner: 'z', order: 0 });
    await reg.invoke('k');
    expect(trace).toEqual(['y-in', 'x-in', 'z-in', 'z-out', 'x-out', 'y-out']);
  });

  test('a chain of transform handlers passes the payload through to the caller', async () => {
    const reg = createDeeplinkRegistry();
    reg.registerHandler(
      'k',
      (ctx, next) => next({ ...ctx, params: { ...(ctx.params as object), userId: 'u1' } }),
      { owner: 'auth', order: 10 },
    );
    reg.registerHandler(
      'k',
      async (_ctx, next) => ({ ...((await next()) as object), tracked: true }),
      { owner: 'analytics', order: 20 },
    );
    await expect(reg.invoke('k', { id: '42' })).resolves.toEqual({
      id: '42',
      userId: 'u1',
      tracked: true,
    });
  });
});

describe('owner', () => {
  test('the same owner replaces its own handler and warns in dev', async () => {
    const reg = createDeeplinkRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const trace: string[] = [];
    reg.registerHandler('k', tracer(trace, 'other'), { owner: 'other', order: 5 });
    reg.registerHandler('k', tracer(trace, 'old'), { owner: 'orders', order: 1 });
    reg.registerHandler('k', tracer(trace, 'new'), { owner: 'orders', order: 10 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[daas-toolbox] deeplink "k" handler from owner "orders" replaced',
    );
    await reg.invoke('k');
    expect(trace).toEqual(['other-in', 'new-in', 'new-out', 'other-out']);
  });

  test('registering repeatedly with one owner (a leaky side effect) leaves one handler', async () => {
    const reg = createDeeplinkRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = vi.fn(() => 'ok');
    for (let i = 0; i < 5; i += 1) reg.registerHandler('k', handler, { owner: 'leaky' });
    await reg.invoke('k');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  test("a replaced handler's unregister is a no-op", async () => {
    const reg = createDeeplinkRegistry();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unregisterOld = reg.registerHandler('k', () => 'old', { owner: 'orders' });
    reg.registerHandler('k', () => 'new', { owner: 'orders' });
    unregisterOld();
    expect(reg.has('k')).toBe(true);
    await expect(reg.invoke('k')).resolves.toBe('new');
  });

  test('the same function under two owners gives two handlers; unregister removes only its own', async () => {
    const reg = createDeeplinkRegistry();
    const fn = vi.fn((_ctx: DeeplinkCallContext, next: () => Promise<unknown>) => next());
    const unregister1 = reg.registerHandler('k', fn, { owner: 'one' });
    reg.registerHandler('k', fn, { owner: 'two' });
    await reg.invoke('k');
    expect(fn).toHaveBeenCalledTimes(2);
    unregister1();
    await reg.invoke('k');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('unregister', () => {
  test('after the last handler is unregistered, new calls wait again', async () => {
    const reg = createDeeplinkRegistry();
    const unregister = reg.registerHandler('k', () => 'first', own);
    unregister();
    expect(reg.has('k')).toBe(false);
    const p = reg.invoke('k');
    reg.registerHandler('k', () => 'second', own);
    await expect(p).resolves.toBe('second');
  });

  test('unregistering one handler keeps the others', async () => {
    const reg = createDeeplinkRegistry();
    const unregister = reg.registerHandler('k', (_ctx, next) => next(), { owner: 'a', order: 1 });
    reg.registerHandler('k', () => 'inner', { owner: 'b', order: 2 });
    unregister();
    expect(reg.has('k')).toBe(true);
    await expect(reg.invoke('k')).resolves.toBe('inner');
  });

  test('calling unregister twice is a no-op', () => {
    const reg = createDeeplinkRegistry();
    const unregister = reg.registerHandler('k', () => 1, own);
    unregister();
    unregister();
    reg.registerHandler('k', () => 2, own);
    unregister();
    expect(reg.has('k')).toBe(true);
  });
});

describe('partial chain and batch flush', () => {
  test('with one handler present, a call runs at once with just that handler', async () => {
    const reg = createDeeplinkRegistry();
    reg.registerHandler('k', (ctx, next) => next({ ...ctx, params: 'auth-only' }), {
      owner: 'auth',
    });
    await expect(reg.invoke('k', { id: 1 })).resolves.toBe('auth-only');
  });

  test('handlers registered in the same tick all join a waiting call', async () => {
    const reg = createDeeplinkRegistry();
    const trace: string[] = [];
    const p = reg.invoke('k');
    reg.registerHandler('k', tracer(trace, 'c'), { owner: 'c', order: 3 });
    reg.registerHandler('k', tracer(trace, 'a'), { owner: 'a', order: 1 });
    reg.registerHandler('k', tracer(trace, 'b'), { owner: 'b', order: 2 });
    await p;
    expect(trace).toEqual(['a-in', 'b-in', 'c-in', 'c-out', 'b-out', 'a-out']);
  });

  test('a handler registered a macrotask later does not join the earlier call', async () => {
    const reg = createDeeplinkRegistry();
    const trace: string[] = [];
    const p = reg.invoke('k');
    reg.registerHandler('k', tracer(trace, 'first'), { owner: 'first' });
    await flush();
    reg.registerHandler('k', tracer(trace, 'late'), { owner: 'late' });
    await p;
    expect(trace).toEqual(['first-in', 'first-out']);
  });

  test('register then unregister in the same tick: the waiting call keeps waiting', async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke('k');
    let settled = false;
    p.then(() => {
      settled = true;
    });
    const unregister = reg.registerHandler('k', () => 'gone', own);
    unregister();
    await flush();
    expect(settled).toBe(false);
    reg.registerHandler('k', () => 'later', own);
    await expect(p).resolves.toBe('later');
  });

  test('all waiting calls aborted before the flush: the flush is a no-op', async () => {
    const reg = createDeeplinkRegistry();
    const controller = new AbortController();
    const p = reg.invoke('k', undefined, { signal: controller.signal });
    const handler = vi.fn(() => 'ok');
    reg.registerHandler('k', handler, own);
    controller.abort(new Error('cancel'));
    await expect(p).rejects.toThrow('cancel');
    await flush();
    expect(handler).not.toHaveBeenCalled();
    await expect(reg.invoke('k')).resolves.toBe('ok');
  });
});

describe('snapshot', () => {
  test('a handler registered while a call runs does not join it', async () => {
    const reg = createDeeplinkRegistry();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const trace: string[] = [];
    reg.registerHandler(
      'k',
      async (_ctx, next) => {
        trace.push('a');
        await gate;
        return next();
      },
      { owner: 'a' },
    );
    const p = reg.invoke('k', { v: 1 });
    await flush();
    reg.registerHandler(
      'k',
      () => {
        trace.push('late');
        return 'late';
      },
      { owner: 'late' },
    );
    release();
    await expect(p).resolves.toEqual({ v: 1 });
    expect(trace).toEqual(['a']);
  });

  test('a handler unregistered while a call runs still runs for that call', async () => {
    const reg = createDeeplinkRegistry();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    reg.registerHandler(
      'k',
      async (_ctx, next) => {
        await gate;
        return next();
      },
      { owner: 'outer', order: 1 },
    );
    const unregisterInner = reg.registerHandler('k', () => 'inner', { owner: 'inner', order: 2 });
    const p = reg.invoke('k');
    await flush();
    unregisterInner();
    release();
    await expect(p).resolves.toBe('inner');
  });
});

describe('calls are isolated', () => {
  test('concurrent calls get their own state', async () => {
    const reg = createDeeplinkRegistry();
    reg.registerHandler(
      'k',
      async (ctx, next) => {
        ctx.state.mine = ctx.params;
        await flush();
        return next();
      },
      { owner: 'a', order: 1 },
    );
    reg.registerHandler('k', (ctx) => ctx.state.mine, { owner: 'b', order: 2 });
    await expect(
      Promise.all([reg.invoke('k', { n: 1 }), reg.invoke('k', { n: 2 })]),
    ).resolves.toEqual([{ n: 1 }, { n: 2 }]);
  });

  test('a handler can invoke another key mid-chain', async () => {
    const reg = createDeeplinkRegistry();
    reg.registerHandler('inner.key', () => 'inner', own);
    reg.registerHandler(
      'outer.key',
      async () => `outer+${String(await reg.invoke('inner.key'))}`,
      own,
    );
    await expect(reg.invoke('outer.key')).resolves.toBe('outer+inner');
  });
});

describe('errors and validation', () => {
  test('a sync throw becomes a rejection with the same error object', async () => {
    const reg = createDeeplinkRegistry();
    const boom = new Error('boom');
    reg.registerHandler(
      'k',
      () => {
        throw boom;
      },
      own,
    );
    await expect(reg.invoke('k')).rejects.toBe(boom);
  });

  test('one waiting call failing does not stop the other waiting calls', async () => {
    const reg = createDeeplinkRegistry();
    const p1 = reg.invoke('k', { fail: true });
    const p2 = reg.invoke('k', { fail: false });
    reg.registerHandler(
      'k',
      (ctx) => {
        if ((ctx.params as { fail: boolean }).fail) throw new Error('first');
        return 'second';
      },
      own,
    );
    await expect(p1).rejects.toThrow('first');
    await expect(p2).resolves.toBe('second');
  });

  test('an empty key throws TypeError from registerHandler and invoke', () => {
    const reg = createDeeplinkRegistry();
    const msg = '[daas-toolbox] deeplink key must be a non-empty string, got an empty string';
    expect(() => reg.registerHandler('', () => 1, own)).toThrow(new TypeError(msg));
    expect(() => reg.invoke('')).toThrow(new TypeError(msg));
  });

  test.each([42, undefined, null])('a %s key throws TypeError naming its type', (key) => {
    const reg = createDeeplinkRegistry();
    expect(() => reg.registerHandler(key as unknown as string, () => 1, own)).toThrow(TypeError);
    expect(() => reg.invoke(key as unknown as string)).toThrow(
      `deeplink key must be a non-empty string, got ${typeof key}`,
    );
  });

  test('a handler that is not a function throws TypeError', () => {
    const reg = createDeeplinkRegistry();
    expect(() => reg.registerHandler('k', 'nope' as unknown as DeeplinkHandler, own)).toThrow(
      new TypeError('[daas-toolbox] deeplink handler must be a function'),
    );
  });

  test.each([Number.NaN, Infinity, '5'])('order %s throws TypeError', (order) => {
    const reg = createDeeplinkRegistry();
    expect(() => reg.registerHandler('k', () => 1, { owner: 'o', order: order as number })).toThrow(
      new TypeError(`[daas-toolbox] deeplink order must be a finite number, got ${String(order)}`),
    );
  });

  test.each(['', 42, undefined])('owner %s throws TypeError', (owner) => {
    const reg = createDeeplinkRegistry();
    expect(() => reg.registerHandler('k', () => 1, { owner: owner as string })).toThrow(
      new TypeError('[daas-toolbox] deeplink owner must be a non-empty string'),
    );
  });

  test('omitting options throws the owner TypeError', () => {
    const reg = createDeeplinkRegistry();
    expect(() =>
      reg.registerHandler('k', () => 1, undefined as unknown as DeeplinkRegisterOptions),
    ).toThrow(new TypeError('[daas-toolbox] deeplink owner must be a non-empty string'));
  });
});

describe('has', () => {
  test('reflects whether at least one key handler is registered', () => {
    const reg = createDeeplinkRegistry();
    expect(reg.has('k')).toBe(false);
    const unregister = reg.registerHandler('k', () => 1, own);
    expect(reg.has('k')).toBe(true);
    unregister();
    expect(reg.has('k')).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/deeplink/__tests__/registry.spec.ts`
Expected: FAIL. `reg.registerHandler is not a function` in every test that registers, while the invalid-key-on-`invoke` tests still pass.

- [ ] **Step 3: Replace `src/deeplink/types.ts`**

```ts
/** Options accepted by `deeplink.invoke`. Mirrors the open shape of daas-sdk `NavigateOptions`. */
export interface DeeplinkInvokeOptions {
  /**
   * Milliseconds from `invoke()` until the call settles, covering both waiting for a first key
   * handler and running the chain. `Infinity` disables the timeout.
   * @default 10000
   */
  timeout?: number;
  /** Caller-side cancellation. Aborting rejects the call with `signal.reason`. */
  signal?: AbortSignal;
  /** Any extra caller options are passed to every handler untouched. */
  [key: string]: unknown;
}

/** Params passed by the caller; same shape as daas-sdk `navigate` params. */
export type DeeplinkParams = Record<string, unknown> | undefined;

/**
 * Where a timed-out call was:
 * - `'waiting'`: no key handler had been registered yet
 * - `'running'`: the chain started but did not settle in time
 */
export type DeeplinkPhase = 'waiting' | 'running';

/** Position of a handler within one call's chain. */
export interface DeeplinkStepInfo {
  /** 0-based position in this call's chain snapshot. */
  index: number;
  /** Number of handlers in this call's chain snapshot. */
  count: number;
  /** The handler's owner. */
  owner: string;
  /** Whether this is a global handler (`registerGlobalHandler`) rather than a key handler. */
  global: boolean;
}

/**
 * Context each handler receives. `key`, `input`, `options`, `signal` and `step` are owned by the
 * runtime: values passed for them through `next(ctx)` are overwritten.
 */
export interface DeeplinkCallContext {
  /** The invoked key. */
  readonly key: string;
  /** Current payload. Starts as the caller's params; upstream handlers may replace it via next(ctx). */
  params: unknown;
  /** The caller's original params; never changed by handlers. */
  readonly input: DeeplinkParams;
  /** The options the caller passed (`{}` when omitted). */
  readonly options: DeeplinkInvokeOptions;
  /** Aborted on timeout or caller abort; the same signal for every handler of the call. */
  readonly signal: AbortSignal;
  /** Position of the handler receiving this context. */
  readonly step: DeeplinkStepInfo;
  /** Scratch space shared by every handler of this call. */
  state: Record<string, unknown>;
}

/**
 * Continue the chain. Pass a new context to change what downstream handlers see. Resolves to
 * what downstream returned; after the last handler, to that context's `params`.
 */
export type DeeplinkNext = (ctx?: DeeplinkCallContext) => Promise<unknown>;

/**
 * One handler in a deeplink chain (onion middleware). `return await next(ctx)` to continue,
 * return a value without calling `next` to short-circuit, or throw to reject the call.
 */
export type DeeplinkHandler = (ctx: DeeplinkCallContext, next: DeeplinkNext) => unknown;

/** Options for `registerHandler` / `registerGlobalHandler` / `useDeeplinkHandler`. */
export interface DeeplinkRegisterOptions {
  /**
   * Required. Identifies the registering MFE (e.g. 'orders', or 'orders:load' when one MFE
   * registers several handlers on a key). Registering again with the same owner replaces that
   * owner's handler, so a re-running side effect never stacks duplicates.
   */
  owner: string;
  /**
   * Lower runs first (outermost); ties keep registration order. Suggested bands: gates 0–99,
   * enrichers 100–199, producers 500+.
   * @default 0
   */
  order?: number;
}

/** One handler as reported by `inspect()`. */
export interface DeeplinkStepStatus {
  owner: string;
  order: number;
}

/** One key as reported by `inspect()`. */
export interface DeeplinkStatus {
  key: string;
  /** Key handlers in execution order. */
  steps: DeeplinkStepStatus[];
  /** Calls currently waiting for a first key handler. */
  waiting: number;
}

/** Snapshot returned by `inspect()`; never contains params or results. */
export interface DeeplinkInspection {
  /** Global handlers in execution order. */
  global: DeeplinkStepStatus[];
  /** Keys with at least one key handler or waiting call, sorted by key. */
  keys: DeeplinkStatus[];
}

/** A deeplink registry. Use the shared `deeplink` instance; create your own only in tests. */
export interface DeeplinkRegistry {
  /**
   * Register a key handler. Handlers run by ascending `order`; the same `owner` replaces its own
   * handler. In React components prefer `useDeeplinkHandler`, which unregisters on unmount.
   * @returns an identity-safe `unregister` that removes only this registration
   */
  registerHandler(
    key: string,
    handler: DeeplinkHandler,
    options: DeeplinkRegisterOptions,
  ): () => void;
  /**
   * Run the chain for `key`, waiting for a first key handler if none is registered.
   * @example
   * const res = await deeplink.invoke<{ opened: boolean }>('orders.open', { id: '42' });
   */
  invoke<TResult = unknown>(
    key: string,
    params?: Record<string, unknown>,
    options?: DeeplinkInvokeOptions,
  ): Promise<TResult>;
  /** Whether at least one key handler is registered for `key` (global handlers don't count). */
  has(key: string): boolean;
}

/**
 * One deeplink's contract: what the caller sends and what the chain returns.
 * Omit `params` (or make it optional / `undefined`) for keys callers may invoke without params;
 * omit `result` for chains that return nothing.
 */
export interface DeeplinkContract {
  params?: object;
  result?: unknown;
}

/**
 * A map of deeplink key → contract, usually an `interface` in a shared contracts module that MFEs
 * import type-only. Written as a self-referential mapped type so plain interfaces (which have no
 * index signature) satisfy it.
 * @example
 * export interface AppDeeplinks {
 *   'orders.open': { params: { id: string }; result: { opened: boolean } };
 *   'auth.reauth': { result: { token: string } };
 * }
 */
export type DeeplinkContractMap<M> = { [K in keyof M]: DeeplinkContract };

/** The `params` type of a contract (`undefined` when the contract declares none). */
export type DeeplinkParamsOf<C> = 'params' extends keyof C ? C['params' & keyof C] : undefined;

/** The `result` type of a contract (`void` when the contract declares none). */
export type DeeplinkResultOf<C> = 'result' extends keyof C ? C['result' & keyof C] : void;

/** `invoke` arguments after the key: `params` is required unless the contract allows `undefined`. */
export type DeeplinkInvokeArgs<C> = undefined extends DeeplinkParamsOf<C>
  ? [params?: DeeplinkParamsOf<C>, options?: DeeplinkInvokeOptions]
  : [params: DeeplinkParamsOf<C>, options?: DeeplinkInvokeOptions];

/**
 * Handler context for a typed key: `input` is the contract's params; everything else is unchanged.
 * (An `Omit` intersection, because an interface-typed `input` is not assignable to
 * `Record<string, unknown>`.)
 */
export type TypedDeeplinkCallContext<C> = Omit<DeeplinkCallContext, 'input'> & {
  readonly input: DeeplinkParamsOf<C>;
};

/** `next` for a typed handler: accepts the typed context. */
export type TypedDeeplinkNext<C> = (ctx?: TypedDeeplinkCallContext<C>) => Promise<unknown>;

/**
 * A handler for a typed key. Only the chain's ends are typed: `ctx.input` is the contract's params,
 * while `ctx.params` and `next()`'s result are `unknown` (a handler can't know its position).
 */
export type TypedDeeplinkHandler<C> = (
  ctx: TypedDeeplinkCallContext<C>,
  next: TypedDeeplinkNext<C>,
) => unknown;

/**
 * Typed view of a deeplink registry, created by `createAppDeeplinks<M>()`. Same runtime object
 * semantics as `DeeplinkRegistry`; only the types differ.
 */
export interface TypedDeeplinkRegistry<M extends DeeplinkContractMap<M>> {
  /** Register a key handler; `ctx.input` is typed from the contract. */
  registerHandler<K extends keyof M & string>(
    key: K,
    handler: TypedDeeplinkHandler<M[K]>,
    options: DeeplinkRegisterOptions,
  ): () => void;
  /** Invoke `key`; params are checked and the result type is inferred from the contract. */
  invoke<K extends keyof M & string>(
    key: K,
    ...args: DeeplinkInvokeArgs<M[K]>
  ): Promise<DeeplinkResultOf<M[K]>>;
  /** Whether at least one key handler is registered for `key`. */
  has(key: keyof M & string): boolean;
}

/** Contract map used when `createAppDeeplinks()` is called without a type argument. */
export type UntypedDeeplinks = Record<string, { params?: object; result?: unknown }>;
```

- [ ] **Step 4: Replace `src/deeplink/registry.ts`**

```ts
import isDev from '../utils/isDev';
import { type ComposeStep, compose } from './compose';
import { DeeplinkTimeoutError } from './errors';
import type {
  DeeplinkCallContext,
  DeeplinkHandler,
  DeeplinkInvokeOptions,
  DeeplinkPhase,
  DeeplinkRegisterOptions,
  DeeplinkRegistry,
} from './types';

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

function assertHandler(handler: unknown): asserts handler is DeeplinkHandler {
  if (typeof handler !== 'function') {
    throw new TypeError('[daas-toolbox] deeplink handler must be a function');
  }
}

/** Validate register options; `owner` is required (also when `options` itself is missing). */
function readRegisterOptions(options: DeeplinkRegisterOptions | undefined): {
  owner: string;
  order: number;
} {
  const owner: unknown = options?.owner;
  const order: unknown = options?.order ?? 0;
  if (typeof owner !== 'string' || owner === '') {
    throw new TypeError('[daas-toolbox] deeplink owner must be a non-empty string');
  }
  if (typeof order !== 'number' || !Number.isFinite(order)) {
    throw new TypeError(
      `[daas-toolbox] deeplink order must be a finite number, got ${String(order)}`,
    );
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
  let seq = 0;

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
    if (queue?.delete(call) && queue.size === 0) pending.delete(key);
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
      for (const call of waiting) call.start(chain);
    });
  }

  function registerHandler(
    key: string,
    handler: DeeplinkHandler,
    options: DeeplinkRegisterOptions,
  ): () => void {
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
    scheduleFlush(key);

    return () => {
      const current = chains.get(key);
      if (!current || !current.includes(registration)) return;
      const remaining = current.filter((existing) => existing !== registration);
      if (remaining.length > 0) chains.set(key, remaining);
      else chains.delete(key);
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
      let phase: DeeplinkPhase = 'waiting';
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let detachAbort = () => {};

      const call: PendingCall = {
        start: (keyChain) => {
          phase = 'running';
          const chain = [...keyChain];
          const ctx: DeeplinkCallContext = {
            key,
            params,
            input: params,
            options: opts,
            signal: controller.signal,
            step: { index: 0, count: chain.length, owner: '', global: false },
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
        signal.addEventListener('abort', onAbort, { once: true });
        detachAbort = () => signal.removeEventListener('abort', onAbort);
      }

      const keyChain = chains.get(key);
      if (keyChain) call.start(keyChain);
      else enqueue(key, call);
    });
  }

  function has(key: string): boolean {
    return chains.has(key);
  }

  return { registerHandler, invoke, has };
}
```

- [ ] **Step 5: Replace `src/deeplink/typed.ts`**

```ts
import { getGlobalRegistry } from './global';
import type {
  DeeplinkContractMap,
  DeeplinkHandler,
  DeeplinkRegistry,
  TypedDeeplinkRegistry,
  UntypedDeeplinks,
} from './types';

/** One facade per registry, so `createAppDeeplinks()` is identity-stable (safe in render and hook deps). */
const facades = new WeakMap<DeeplinkRegistry, TypedDeeplinkRegistry<UntypedDeeplinks>>();

/**
 * Typed facade over a deeplink registry (the shared global one by default). Mirrors daas-sdk
 * `createAppEvents<T>()`: MFEs import the contract map **type-only**, so there is no runtime
 * coupling between them. Typed and untyped callers share the same registry.
 *
 * @example
 * import type { AppDeeplinks } from '@company/contracts';
 * const dl = createAppDeeplinks<AppDeeplinks>();
 * const res = await dl.invoke('orders.open', { id: '42' }); // res: { opened: boolean }
 */
export function createAppDeeplinks<M extends DeeplinkContractMap<M> = UntypedDeeplinks>(
  registry: DeeplinkRegistry = getGlobalRegistry(),
): TypedDeeplinkRegistry<M> {
  let facade = facades.get(registry);
  if (!facade) {
    facade = {
      // Contract types exist only at compile time; typed and untyped handlers are identical at runtime.
      registerHandler: (key, handler, options) =>
        registry.registerHandler(key, handler as unknown as DeeplinkHandler, options),
      invoke: (key, params, options) =>
        registry.invoke(key, params as Record<string, unknown> | undefined, options),
      has: (key) => registry.has(key),
    };
    facades.set(registry, facade);
  }
  // Safe: the facade has no per-M state; M only narrows the compile-time signatures.
  return facade as unknown as TypedDeeplinkRegistry<M>;
}
```

- [ ] **Step 6: Replace `src/deeplink/index.ts`**

```ts
import { getGlobalRegistry } from './global';

/**
 * The page-wide deeplink registry, shared by every MFE.
 * @example
 * // in components prefer useDeeplinkHandler; outside React:
 * const unregister = deeplink.registerHandler('orders.open', (ctx) => openOrder(ctx.params), {
 *   owner: 'orders',
 * });
 * // any MFE
 * const res = await deeplink.invoke<{ opened: boolean }>('orders.open', { id: '42' });
 */
export const deeplink = getGlobalRegistry();

export { DeeplinkTimeoutError, isDeeplinkTimeoutError } from './errors';
export { createDeeplinkRegistry } from './registry';
export { createAppDeeplinks } from './typed';
export type {
  DeeplinkCallContext,
  DeeplinkContract,
  DeeplinkContractMap,
  DeeplinkHandler,
  DeeplinkInspection,
  DeeplinkInvokeArgs,
  DeeplinkInvokeOptions,
  DeeplinkNext,
  DeeplinkParams,
  DeeplinkParamsOf,
  DeeplinkPhase,
  DeeplinkRegisterOptions,
  DeeplinkRegistry,
  DeeplinkResultOf,
  DeeplinkStatus,
  DeeplinkStepInfo,
  DeeplinkStepStatus,
  TypedDeeplinkCallContext,
  TypedDeeplinkHandler,
  TypedDeeplinkNext,
  TypedDeeplinkRegistry,
  UntypedDeeplinks,
} from './types';
```

- [ ] **Step 7: Replace `src/hooks/useDeeplinkHandler/index.ts`**

```ts
import { useEffect } from 'react';
import { deeplink } from '../../deeplink';
import type {
  DeeplinkContractMap,
  DeeplinkHandler,
  DeeplinkRegisterOptions,
  TypedDeeplinkHandler,
  TypedDeeplinkRegistry,
} from '../../deeplink/types';
import useLatest from '../useLatest';

/** The part of a registry this hook needs; `deeplink` and typed facades both provide it. */
interface RegisterTarget {
  registerHandler(
    key: string,
    handler: DeeplinkHandler,
    options: DeeplinkRegisterOptions,
  ): () => void;
}

type UntypedArgs = [key: string, handler: DeeplinkHandler, options: DeeplinkRegisterOptions];
type TypedArgs = [
  registry: RegisterTarget,
  key: string,
  handler: DeeplinkHandler,
  options: DeeplinkRegisterOptions,
];

/**
 * Register a deeplink handler for the lifetime of the component — the recommended way for MFEs,
 * because it unregisters automatically on unmount.
 *
 * Registers once per `key` / `owner` / `order` and always calls the latest `handler`, so
 * re-renders never re-register. Calls made before the effect runs are queued by the registry
 * until it does. Unregisters on unmount or when `key`, `owner` or `order` changes. Safe under
 * React StrictMode.
 *
 * Use `deeplink.registerHandler` instead outside React, or in an MFE whose React version differs
 * from the toolbox's shared copy.
 *
 * @example
 * useDeeplinkHandler('orders.open', async (ctx) => {
 *   const order = await api.getOrder((ctx.params as { id: string }).id, { signal: ctx.signal });
 *   openOrderDrawer(order);
 *   return { opened: true };
 * }, { owner: 'orders', order: 500 });
 */
function useDeeplinkHandler(
  key: string,
  handler: DeeplinkHandler,
  options: DeeplinkRegisterOptions,
): void;
/**
 * Typed form: `ctx.input` is typed from the contract of a registry created by
 * `createAppDeeplinks<M>()`.
 *
 * @example
 * const dl = createAppDeeplinks<AppDeeplinks>();
 * useDeeplinkHandler(dl, 'orders.open', (ctx) => ({ opened: ctx.input.id === '42' }), {
 *   owner: 'orders',
 * });
 */
function useDeeplinkHandler<M extends DeeplinkContractMap<M>, K extends keyof M & string>(
  registry: TypedDeeplinkRegistry<M>,
  key: K,
  handler: TypedDeeplinkHandler<M[K]>,
  options: DeeplinkRegisterOptions,
): void;
function useDeeplinkHandler(...args: UntypedArgs | TypedArgs): void {
  // A string first argument means the untyped form (the global registry).
  const [registry, key, handler, options]: TypedArgs =
    typeof args[0] === 'string' ? [deeplink, ...(args as UntypedArgs)] : (args as TypedArgs);
  const { owner, order } = options;
  const handlerRef = useLatest(handler);

  // biome-ignore lint/correctness/useExhaustiveDependencies: handlerRef is a stable ref; re-registering on every handler change is exactly what this hook avoids
  useEffect(
    () => registry.registerHandler(key, (ctx, next) => handlerRef.current(ctx, next), { owner, order }),
    [registry, key, owner, order],
  );
}

export default useDeeplinkHandler;
```

- [ ] **Step 8: Replace `src/hooks/useDeeplinkHandler/__tests__/index.spec.ts`**

```ts
import { renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAppDeeplinks, deeplink } from '../../../deeplink';
import useDeeplinkHandler from '../index';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDeeplinkHandler', () => {
  test('registers on mount and unregisters on unmount', async () => {
    const { unmount } = renderHook(() =>
      useDeeplinkHandler('hook.mount', () => 'ok', { owner: 'm' }),
    );
    expect(deeplink.has('hook.mount')).toBe(true);
    await expect(deeplink.invoke('hook.mount')).resolves.toBe('ok');
    unmount();
    expect(deeplink.has('hook.mount')).toBe(false);
  });

  test('uses the latest handler closure without re-registering', async () => {
    const register = vi.spyOn(deeplink, 'registerHandler');
    const { rerender, unmount } = renderHook(
      ({ value }) => useDeeplinkHandler('hook.latest', () => value, { owner: 'm' }),
      { initialProps: { value: 1 } },
    );
    rerender({ value: 2 });
    await expect(deeplink.invoke('hook.latest')).resolves.toBe(2);
    expect(register).toHaveBeenCalledTimes(1);
    unmount();
  });

  test('two components chain on one key by order, not by mount order', async () => {
    const inner = renderHook(() =>
      useDeeplinkHandler('hook.chain', (ctx) => `inner(${String(ctx.params)})`, {
        owner: 'inner',
        order: 2,
      }),
    );
    const outer = renderHook(() =>
      useDeeplinkHandler(
        'hook.chain',
        async (ctx, next) => `${String(await next({ ...ctx, params: 'b' }))}+outer`,
        { owner: 'outer', order: 1 },
      ),
    );
    await expect(deeplink.invoke('hook.chain')).resolves.toBe('inner(b)+outer');
    outer.unmount();
    inner.unmount();
  });

  test('re-registers when key, owner or order changes, not on re-render with equal options', () => {
    const register = vi.spyOn(deeplink, 'registerHandler');
    const { rerender, unmount } = renderHook(
      ({ k, owner, order }) => useDeeplinkHandler(k, () => 'x', { owner, order }),
      { initialProps: { k: 'hook.re.a', owner: 'o1', order: 1 } },
    );
    rerender({ k: 'hook.re.a', owner: 'o1', order: 1 });
    expect(register).toHaveBeenCalledTimes(1);
    rerender({ k: 'hook.re.a', owner: 'o1', order: 2 });
    expect(register).toHaveBeenCalledTimes(2);
    rerender({ k: 'hook.re.a', owner: 'o2', order: 2 });
    expect(register).toHaveBeenCalledTimes(3);
    rerender({ k: 'hook.re.b', owner: 'o2', order: 2 });
    expect(register).toHaveBeenCalledTimes(4);
    expect(deeplink.has('hook.re.a')).toBe(false);
    expect(deeplink.has('hook.re.b')).toBe(true);
    unmount();
    expect(deeplink.has('hook.re.b')).toBe(false);
  });

  test('the same owner in two components leaves one handler (the later one)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = renderHook(() =>
      useDeeplinkHandler('hook.dup', () => 'first', { owner: 'dup' }),
    );
    const second = renderHook(() =>
      useDeeplinkHandler('hook.dup', () => 'second', { owner: 'dup' }),
    );
    await expect(deeplink.invoke('hook.dup')).resolves.toBe('second');
    expect(warn).toHaveBeenCalledWith(
      '[daas-toolbox] deeplink "hook.dup" handler from owner "dup" replaced',
    );
    first.unmount();
    expect(deeplink.has('hook.dup')).toBe(true);
    second.unmount();
    expect(deeplink.has('hook.dup')).toBe(false);
  });

  test('StrictMode double-mount leaves exactly one live handler and no replace warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { unmount } = renderHook(
      () => useDeeplinkHandler('hook.strict', () => 'strict', { owner: 's' }),
      { wrapper: StrictMode },
    );
    expect(deeplink.has('hook.strict')).toBe(true);
    await expect(deeplink.invoke('hook.strict')).resolves.toBe('strict');
    expect(warn).not.toHaveBeenCalled();
    unmount();
    expect(deeplink.has('hook.strict')).toBe(false);
  });

  test('a call made before mount is delivered once the hook registers', async () => {
    const p = deeplink.invoke('hook.early', { id: 7 });
    const { unmount } = renderHook(() =>
      useDeeplinkHandler('hook.early', (ctx) => (ctx.params as { id: number }).id, {
        owner: 'early',
      }),
    );
    await expect(p).resolves.toBe(7);
    unmount();
  });

  test('accepts a typed registry and infers ctx.input from its contract', async () => {
    interface HookDeeplinks {
      'hook.typed': { params: { n: number }; result: number };
    }
    const dl = createAppDeeplinks<HookDeeplinks>();
    const { unmount } = renderHook(() =>
      useDeeplinkHandler(dl, 'hook.typed', (ctx) => ctx.input.n * 2, { owner: 'typed', order: 3 }),
    );
    await expect(dl.invoke('hook.typed', { n: 21 })).resolves.toBe(42);
    unmount();
    expect(dl.has('hook.typed')).toBe(false);
  });
});
```

- [ ] **Step 9: Replace `src/deeplink/__tests__/registry.timeout.spec.ts`**

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DeeplinkTimeoutError } from '../errors';
import { createDeeplinkRegistry } from '../registry';
import type { DeeplinkCallContext, DeeplinkInvokeOptions } from '../types';

const own = { owner: 'test' };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('timeout', () => {
  test('rejects with phase "waiting" when no handler is registered in time', async () => {
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

  test('rejects with phase "running" and aborts ctx.signal when the chain is too slow', async () => {
    const reg = createDeeplinkRegistry();
    let seen: DeeplinkCallContext | undefined;
    reg.registerHandler(
      'k',
      (ctx) => {
        seen = ctx;
        return new Promise<never>(() => {});
      },
      own,
    );
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
    // past the 2^31-1 ms setTimeout cap, so a clamped timer would have fired
    await vi.advanceTimersByTimeAsync(2 ** 31);
    reg.registerHandler('k', () => 'eventually', own);
    await expect(p).resolves.toBe('eventually');
  });

  test('a timeout above the setTimeout limit does not fire early', async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke('k', undefined, { timeout: 2 ** 31 });
    await vi.advanceTimersByTimeAsync(60 * 1000);
    reg.registerHandler('k', () => 'ok', own);
    await expect(p).resolves.toBe('ok');
  });

  test('timeout 0 still lets an already-registered handler answer', async () => {
    const reg = createDeeplinkRegistry();
    reg.registerHandler('k', () => 'fast', own);
    await expect(reg.invoke('k', undefined, { timeout: 0 })).resolves.toBe('fast');
  });

  test('a result arriving after the timeout is ignored', async () => {
    const reg = createDeeplinkRegistry();
    let release: (value: string) => void = () => {};
    reg.registerHandler(
      'k',
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
      own,
    );
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
    reg.registerHandler('k', handler, own);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();
  });

  test.each([
    Number.NaN,
    -1,
    '100',
  ])('timeout %s rejects with TypeError instead of throwing synchronously (spec rule 2)', async (timeout) => {
    const reg = createDeeplinkRegistry();
    let p: Promise<unknown> = Promise.resolve();
    expect(() => {
      p = reg.invoke('k', undefined, { timeout: timeout as number });
    }).not.toThrow();
    await expect(p).rejects.toThrow(
      new TypeError(
        `[daas-toolbox] deeplink timeout must be a non-negative number or Infinity, got ${String(timeout)}`,
      ),
    );
  });

  test('null options behave like omitted options', async () => {
    const reg = createDeeplinkRegistry();
    reg.registerHandler('k', (ctx) => ctx.options, own);
    await expect(
      reg.invoke('k', undefined, null as unknown as DeeplinkInvokeOptions),
    ).resolves.toEqual({});
  });

  test('settling clears the timer', async () => {
    const reg = createDeeplinkRegistry();
    reg.registerHandler('k', () => 'ok', own);
    await reg.invoke('k', undefined, { timeout: 500 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('caller abort', () => {
  test('an already-aborted signal rejects with its reason and never runs the handler', async () => {
    const reg = createDeeplinkRegistry();
    const handler = vi.fn();
    reg.registerHandler('k', handler, own);
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
    reg.registerHandler('k', handler, own);
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
    reg.registerHandler('k', (ctx) => (ctx.params as { n: number }).n, own);
    await expect(kept).resolves.toBe(2);
  });

  test('aborting while running aborts ctx.signal and rejects with the reason', async () => {
    const reg = createDeeplinkRegistry();
    let seen: DeeplinkCallContext | undefined;
    reg.registerHandler(
      'k',
      (ctx) => {
        seen = ctx;
        return new Promise<never>(() => {});
      },
      own,
    );
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
    reg.registerHandler('k', () => 'ok', own);
    await reg.invoke('k', undefined, { signal: controller.signal });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
```

- [ ] **Step 10: Replace `src/deeplink/__tests__/registry.prod.spec.ts`**

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
```

- [ ] **Step 11: Replace `src/deeplink/__tests__/typed.spec.ts`**

```ts
import { describe, expect, expectTypeOf, test } from 'vitest';
import { deeplink } from '../index';
import { createDeeplinkRegistry } from '../registry';
import { createAppDeeplinks } from '../typed';

interface OrderParams {
  id: string;
  tab?: 'items' | 'history';
}

interface TestDeeplinks {
  'orders.open': { params: OrderParams; result: { opened: boolean } };
  'auth.reauth': { params: undefined; result: { token: string } };
  'ui.ping': { result: string };
  'ui.close': { params?: { force: boolean } };
}

const own = { owner: 'test' };

describe('createAppDeeplinks (runtime)', () => {
  test('a typed invoke runs the chain and returns its result', async () => {
    const dl = createAppDeeplinks<TestDeeplinks>(createDeeplinkRegistry());
    dl.registerHandler('orders.open', async (ctx) => ({ opened: ctx.input.id === '42' }), own);
    await expect(dl.invoke('orders.open', { id: '42' })).resolves.toEqual({ opened: true });
  });

  test('typed handlers chain in order', async () => {
    const dl = createAppDeeplinks<TestDeeplinks>(createDeeplinkRegistry());
    dl.registerHandler(
      'orders.open',
      (ctx) => ({ opened: (ctx.params as OrderParams).tab === 'items' }),
      { owner: 'orders', order: 50 },
    );
    dl.registerHandler(
      'orders.open',
      (ctx, next) => next({ ...ctx, params: { ...ctx.input, tab: 'items' } }),
      { owner: 'tabs', order: 10 },
    );
    await expect(dl.invoke('orders.open', { id: '1' })).resolves.toEqual({ opened: true });
  });

  test('params can be omitted when the contract allows it', async () => {
    const dl = createAppDeeplinks<TestDeeplinks>(createDeeplinkRegistry());
    dl.registerHandler('auth.reauth', () => ({ token: 't' }), own);
    dl.registerHandler('ui.ping', () => 'pong', own);
    await expect(dl.invoke('auth.reauth')).resolves.toEqual({ token: 't' });
    await expect(dl.invoke('ui.ping')).resolves.toBe('pong');
  });

  test('options pass through to the handler', async () => {
    const dl = createAppDeeplinks<TestDeeplinks>(createDeeplinkRegistry());
    let seenOptions: unknown;
    dl.registerHandler(
      'ui.ping',
      (ctx) => {
        seenOptions = ctx.options;
        return 'pong';
      },
      own,
    );
    const options = { timeout: 1000, source: 'test' };
    await dl.invoke('ui.ping', undefined, options);
    expect(seenOptions).toBe(options);
  });

  test('has reflects registration', () => {
    const dl = createAppDeeplinks<TestDeeplinks>(createDeeplinkRegistry());
    expect(dl.has('ui.ping')).toBe(false);
    const unregister = dl.registerHandler('ui.ping', () => 'pong', own);
    expect(dl.has('ui.ping')).toBe(true);
    unregister();
    expect(dl.has('ui.ping')).toBe(false);
  });

  test('typed and untyped callers share the global registry by default', async () => {
    const dl = createAppDeeplinks<TestDeeplinks>();
    const unregister = dl.registerHandler('ui.ping', () => 'pong', own);
    await expect(deeplink.invoke('ui.ping')).resolves.toBe('pong');
    unregister();
  });

  test('returns the same facade for the same registry, so it is safe to call during render', () => {
    const reg = createDeeplinkRegistry();
    expect(createAppDeeplinks<TestDeeplinks>(reg)).toBe(createAppDeeplinks<TestDeeplinks>(reg));
    expect(createAppDeeplinks()).toBe(createAppDeeplinks());
    expect(createAppDeeplinks(reg)).not.toBe(createAppDeeplinks());
  });
});

describe('createAppDeeplinks (types, checked by tsc)', () => {
  test('contract types are enforced and inferred', () => {
    // Never called: these lines only need to type-check (or fail to, under @ts-expect-error).
    const typeChecks = () => {
      const dl = createAppDeeplinks<TestDeeplinks>();

      expectTypeOf(dl.invoke('orders.open', { id: '1' })).resolves.toEqualTypeOf<{
        opened: boolean;
      }>();
      expectTypeOf(dl.invoke('auth.reauth')).resolves.toEqualTypeOf<{ token: string }>();
      expectTypeOf(dl.invoke('ui.ping')).resolves.toEqualTypeOf<string>();
      expectTypeOf(dl.invoke('ui.close')).resolves.toEqualTypeOf<void>();

      // interface-typed params are accepted
      const params: OrderParams = { id: '1' };
      dl.invoke('orders.open', params);

      // @ts-expect-error unknown key
      dl.invoke('orders.opne', { id: '1' });
      // @ts-expect-error misspelled param
      dl.invoke('orders.open', { idd: '1' });
      // @ts-expect-error params are required for this key
      dl.invoke('orders.open');

      dl.registerHandler(
        'orders.open',
        (ctx, next) => {
          expectTypeOf(ctx.input).toEqualTypeOf<OrderParams>();
          expectTypeOf(ctx.params).toBeUnknown();
          expectTypeOf(next).returns.resolves.toBeUnknown();
          return next();
        },
        own,
      );
      dl.registerHandler(
        'auth.reauth',
        (ctx) => {
          expectTypeOf(ctx.input).toEqualTypeOf<undefined>();
          return { token: 't' };
        },
        own,
      );
      // @ts-expect-error unknown key on registerHandler
      dl.registerHandler('orders.opne', () => null, own);
      // @ts-expect-error owner is required
      dl.registerHandler('ui.ping', () => 'pong', {});

      // untyped fallback: any string key, unknown result
      const loose = createAppDeeplinks();
      expectTypeOf(loose.invoke('anything', { a: 1 })).resolves.toBeUnknown();
    };
    expect(typeChecks).toBeTypeOf('function');
  });
});
```

- [ ] **Step 12: Edit the global-singleton and barrel tests for the new name**

```bash
cd /home/chris/Github/hooks/packages/daas-toolbox
python3 - <<'EOF'
def edit(path, old, new):
    s = open(path).read()
    assert old in s, f'{path}: missing {old!r}'
    open(path, 'w').write(s.replace(old, new))

edit('src/deeplink/__tests__/global.spec.ts',
     "a.handle('global.shared', () => 'from-a')",
     "a.registerHandler('global.shared', () => 'from-a', { owner: 'a' })")
edit('src/__tests__/index.spec.ts',
     "      handle: expect.any(Function),\n",
     "      registerHandler: expect.any(Function),\n")
EOF
grep -rnE "\.handle\(|DeeplinkHandlerContext|DeeplinkMiddleware|_params" src || echo "no old names left"
```
Expected: `no old names left`.

- [ ] **Step 13: Run every test, then the typecheck**

Run: `npx vitest run && npx tsc --noEmit -p .`
Expected: every test file PASSes, and tsc exits 0.

- [ ] **Step 14: Commit**

```bash
git add src
git commit -m "feat(daas-toolbox): deeplink handler chains with required owner and order"
```

---

### Task 3: Global handlers and host tracking

**Files:**
- Rewrite: `src/deeplink/registry.ts`
- Modify: `src/deeplink/types.ts` (add `registerGlobalHandler`, `inspect` and `subscribe` to `DeeplinkRegistry`), `src/__tests__/index.spec.ts` (barrel expectation)
- Create tests: `src/deeplink/__tests__/registry.global.spec.ts`, `src/deeplink/__tests__/registry.inspect.spec.ts`
- Append tests: `src/deeplink/__tests__/registry.prod.spec.ts`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: `DeeplinkRegistry.registerGlobalHandler(handler: DeeplinkHandler, options: DeeplinkRegisterOptions): () => void`, `inspect(): DeeplinkInspection`, `subscribe(listener: () => void): () => void`.

- [ ] **Step 1: Write the failing global-handler tests** at `src/deeplink/__tests__/registry.global.spec.ts`

```ts
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDeeplinkRegistry } from '../registry';
import type { DeeplinkHandler, DeeplinkRegisterOptions, DeeplinkStepInfo } from '../types';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function tracer(trace: string[], name: string): DeeplinkHandler {
  return async (_ctx, next) => {
    trace.push(`${name}-in`);
    const res = await next();
    trace.push(`${name}-out`);
    return res;
  };
}

const own = { owner: 'test' };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('global handlers', () => {
  test('wrap every key', async () => {
    const reg = createDeeplinkRegistry();
    const keys: string[] = [];
    reg.registerGlobalHandler(
      (ctx, next) => {
        keys.push(ctx.key);
        return next();
      },
      { owner: 'log' },
    );
    reg.registerHandler('a', () => 'A', own);
    reg.registerHandler('b', () => 'B', own);
    await expect(reg.invoke('a')).resolves.toBe('A');
    await expect(reg.invoke('b')).resolves.toBe('B');
    expect(keys).toEqual(['a', 'b']);
  });

  test('are outermost even when a key handler has a lower order', async () => {
    const reg = createDeeplinkRegistry();
    const trace: string[] = [];
    reg.registerGlobalHandler(tracer(trace, 'g'), { owner: 'g', order: 100 });
    reg.registerHandler('k', tracer(trace, 'k'), { owner: 'k', order: -1000 });
    await reg.invoke('k');
    expect(trace).toEqual(['g-in', 'k-in', 'k-out', 'g-out']);
  });

  test('are sorted by their own order, ties by registration', async () => {
    const reg = createDeeplinkRegistry();
    const trace: string[] = [];
    reg.registerGlobalHandler(tracer(trace, 'g2'), { owner: 'g2', order: 2 });
    reg.registerGlobalHandler(tracer(trace, 'g1a'), { owner: 'g1a', order: 1 });
    reg.registerGlobalHandler(tracer(trace, 'g1b'), { owner: 'g1b', order: 1 });
    reg.registerHandler('k', () => 'x', own);
    await reg.invoke('k');
    expect(trace).toEqual(['g1a-in', 'g1b-in', 'g2-in', 'g2-out', 'g1b-out', 'g1a-out']);
  });

  test('the same owner replaces its global handler and warns in dev', async () => {
    const reg = createDeeplinkRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const trace: string[] = [];
    const unregisterOld = reg.registerGlobalHandler(tracer(trace, 'old'), { owner: 'logger' });
    reg.registerGlobalHandler(tracer(trace, 'new'), { owner: 'logger' });
    expect(warn).toHaveBeenCalledWith(
      '[daas-toolbox] global handler from owner "logger" replaced',
    );
    unregisterOld();
    reg.registerHandler('k', () => 'x', own);
    await reg.invoke('k');
    expect(trace).toEqual(['new-in', 'new-out']);
  });

  test('a global owner and a key-handler owner with the same name are independent', async () => {
    const reg = createDeeplinkRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reg.registerHandler('k', () => 'key-handler', { owner: 'shared' });
    reg.registerGlobalHandler((_ctx, next) => next(), { owner: 'shared' });
    expect(reg.has('k')).toBe(true);
    await expect(reg.invoke('k')).resolves.toBe('key-handler');
    expect(warn).not.toHaveBeenCalled();
  });

  test('global handlers alone do not satisfy the wait rule', async () => {
    vi.useFakeTimers();
    const reg = createDeeplinkRegistry();
    reg.registerGlobalHandler((_ctx, next) => next(), { owner: 'log' });
    expect(reg.has('k')).toBe(false);
    const p = reg.invoke('k', undefined, { timeout: 100 });
    const assertion = expect(p).rejects.toMatchObject({
      name: 'DeeplinkTimeoutError',
      phase: 'waiting',
    });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  test('registerGlobalHandler does not start waiting calls', async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke('k');
    let settled = false;
    p.then(() => {
      settled = true;
    });
    reg.registerGlobalHandler((_ctx, next) => next(), { owner: 'log' });
    await flush();
    expect(settled).toBe(false);
    reg.registerHandler('k', () => 'ok', own);
    await expect(p).resolves.toBe('ok');
  });

  test('registering or unregistering one while a call runs does not change that call', async () => {
    const reg = createDeeplinkRegistry();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const trace: string[] = [];
    const unregisterG = reg.registerGlobalHandler(tracer(trace, 'g1'), { owner: 'g1' });
    reg.registerHandler(
      'k',
      async () => {
        await gate;
        return 'done';
      },
      own,
    );
    const p = reg.invoke('k');
    await flush();
    reg.registerGlobalHandler(tracer(trace, 'late'), { owner: 'late' });
    unregisterG();
    release();
    await expect(p).resolves.toBe('done');
    expect(trace).toEqual(['g1-in', 'g1-out']);
  });

  test('step info covers the combined chain and flags global handlers', async () => {
    const reg = createDeeplinkRegistry();
    const infos: DeeplinkStepInfo[] = [];
    reg.registerGlobalHandler(
      (ctx, next) => {
        infos.push(ctx.step);
        return next();
      },
      { owner: 'log' },
    );
    reg.registerHandler(
      'k',
      (ctx) => {
        infos.push(ctx.step);
        return 'x';
      },
      { owner: 'orders' },
    );
    await reg.invoke('k');
    expect(infos).toEqual([
      { index: 0, count: 2, owner: 'log', global: true },
      { index: 1, count: 2, owner: 'orders', global: false },
    ]);
  });

  test('a global handler can recover from a key handler error', async () => {
    const reg = createDeeplinkRegistry();
    reg.registerGlobalHandler(
      async (_ctx, next) => {
        try {
          return await next();
        } catch {
          return 'fallback';
        }
      },
      { owner: 'guard' },
    );
    reg.registerHandler(
      'k',
      () => {
        throw new Error('inner');
      },
      own,
    );
    await expect(reg.invoke('k')).resolves.toBe('fallback');
  });

  test('unregister removes it; a second unregister is a no-op', async () => {
    const reg = createDeeplinkRegistry();
    const trace: string[] = [];
    const unregister = reg.registerGlobalHandler(tracer(trace, 'g'), { owner: 'g' });
    unregister();
    unregister();
    reg.registerHandler('k', () => 'x', own);
    await reg.invoke('k');
    expect(trace).toEqual([]);
  });

  test('registerGlobalHandler validates its arguments', () => {
    const reg = createDeeplinkRegistry();
    expect(() => reg.registerGlobalHandler('x' as unknown as DeeplinkHandler, own)).toThrow(
      new TypeError('[daas-toolbox] deeplink handler must be a function'),
    );
    expect(() => reg.registerGlobalHandler(() => 1, { owner: 'o', order: Number.NaN })).toThrow(
      new TypeError('[daas-toolbox] deeplink order must be a finite number, got NaN'),
    );
    expect(() => reg.registerGlobalHandler(() => 1, { owner: '' })).toThrow(
      new TypeError('[daas-toolbox] deeplink owner must be a non-empty string'),
    );
    expect(() =>
      reg.registerGlobalHandler(() => 1, undefined as unknown as DeeplinkRegisterOptions),
    ).toThrow(new TypeError('[daas-toolbox] deeplink owner must be a non-empty string'));
  });
});
```

- [ ] **Step 2: Write the failing tracking tests** at `src/deeplink/__tests__/registry.inspect.spec.ts`

```ts
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDeeplinkRegistry } from '../registry';

const own = { owner: 'test' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('inspect', () => {
  test('an empty registry reports nothing', () => {
    expect(createDeeplinkRegistry().inspect()).toEqual({ global: [], keys: [] });
  });

  test('lists global and key handlers in execution order, keys sorted', () => {
    const reg = createDeeplinkRegistry();
    reg.registerGlobalHandler(() => 1, { owner: 'log', order: 5 });
    reg.registerGlobalHandler(() => 1, { owner: 'trace' });
    reg.registerHandler('zeta', () => 1, { owner: 'z' });
    reg.registerHandler('alpha', () => 1, { owner: 'orders', order: 50 });
    reg.registerHandler('alpha', () => 1, { owner: 'auth', order: 10 });
    expect(reg.inspect()).toEqual({
      global: [
        { owner: 'trace', order: 0 },
        { owner: 'log', order: 5 },
      ],
      keys: [
        {
          key: 'alpha',
          steps: [
            { owner: 'auth', order: 10 },
            { owner: 'orders', order: 50 },
          ],
          waiting: 0,
        },
        { key: 'zeta', steps: [{ owner: 'z', order: 0 }], waiting: 0 },
      ],
    });
  });

  test('counts waiting calls and drops keys with nothing left', async () => {
    const reg = createDeeplinkRegistry();
    const controller = new AbortController();
    const p1 = reg.invoke('pending.key', undefined, { signal: controller.signal });
    const p2 = reg.invoke('pending.key');
    expect(reg.inspect().keys).toEqual([{ key: 'pending.key', steps: [], waiting: 2 }]);
    controller.abort(new Error('x'));
    await expect(p1).rejects.toThrow('x');
    expect(reg.inspect().keys).toEqual([{ key: 'pending.key', steps: [], waiting: 1 }]);
    const unregister = reg.registerHandler('pending.key', () => 'ok', own);
    await expect(p2).resolves.toBe('ok');
    expect(reg.inspect().keys).toEqual([
      { key: 'pending.key', steps: [{ owner: 'test', order: 0 }], waiting: 0 },
    ]);
    unregister();
    expect(reg.inspect().keys).toEqual([]);
  });

  test('never exposes params or results', async () => {
    const reg = createDeeplinkRegistry();
    reg.registerHandler('k', () => ({ token: 'result-secret' }), own);
    const p = reg.invoke('k', { password: 'param-secret' });
    const during = JSON.stringify(reg.inspect());
    await p;
    expect(during).not.toContain('secret');
    expect(JSON.stringify(reg.inspect())).not.toContain('secret');
  });

  test('returns a fresh snapshot every time', () => {
    const reg = createDeeplinkRegistry();
    const first = reg.inspect();
    first.global.push({ owner: 'x', order: 1 });
    expect(reg.inspect().global).toEqual([]);
  });
});

describe('subscribe', () => {
  test('fires once per change to handlers or waiting counts', async () => {
    const reg = createDeeplinkRegistry();
    let count = 0;
    reg.subscribe(() => {
      count += 1;
    });
    const p = reg.invoke('k'); // waiting 0 → 1
    expect(count).toBe(1);
    const unregister = reg.registerHandler('k', () => 'ok', own); // handler registered
    expect(count).toBe(2);
    await expect(p).resolves.toBe('ok'); // batch flush: waiting 1 → 0
    expect(count).toBe(3);
    await reg.invoke('k'); // ran at once: nothing changed
    expect(count).toBe(3);
    const unregisterG = reg.registerGlobalHandler((_ctx, next) => next(), { owner: 'g' }); // 4
    unregisterG(); // 5
    unregisterG(); // no-op
    unregister(); // 6
    unregister(); // no-op
    expect(count).toBe(6);
    const controller = new AbortController();
    const p2 = reg.invoke('x', undefined, { signal: controller.signal }); // waiting 0 → 1
    controller.abort(new Error('stop')); // waiting 1 → 0
    await expect(p2).rejects.toThrow('stop');
    expect(count).toBe(8);
  });

  test('a listener reading inspect() sees the change already applied', () => {
    const reg = createDeeplinkRegistry();
    const seen: number[] = [];
    reg.subscribe(() => seen.push(reg.inspect().keys.length));
    reg.registerHandler('a', () => 1, own);
    reg.registerHandler('b', () => 1, own);
    expect(seen).toEqual([1, 2]);
  });

  test('a throwing listener is isolated and reported in dev', async () => {
    const reg = createDeeplinkRegistry();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('listener');
    reg.subscribe(() => {
      throw boom;
    });
    const second = vi.fn();
    reg.subscribe(second);
    expect(() => reg.registerHandler('k', () => 'ok', own)).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('[daas-toolbox] deeplink subscriber threw', boom);
    await expect(reg.invoke('k')).resolves.toBe('ok');
  });

  test('unsubscribe stops notifications and is idempotent', () => {
    const reg = createDeeplinkRegistry();
    const listener = vi.fn();
    const unsubscribe = reg.subscribe(listener);
    reg.registerHandler('a', () => 1, own);
    unsubscribe();
    unsubscribe();
    reg.registerHandler('b', () => 1, own);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Append the prod-mode cases** to `src/deeplink/__tests__/registry.prod.spec.ts`

```ts

test('replacing a global handler does not warn in production', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const reg = createDeeplinkRegistry();
  reg.registerGlobalHandler((_ctx, next) => next(), { owner: 'logger' });
  reg.registerGlobalHandler((_ctx, next) => next(), { owner: 'logger' });
  expect(warn).not.toHaveBeenCalled();
});

test('a throwing subscriber is not reported in production', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const reg = createDeeplinkRegistry();
  reg.subscribe(() => {
    throw new Error('x');
  });
  reg.registerHandler('k', () => 1, { owner: 'a' });
  expect(error).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Update the barrel expectation** in `src/__tests__/index.spec.ts`. Replace

```ts
      has: expect.any(Function),
    });
```

with

```ts
      has: expect.any(Function),
      registerGlobalHandler: expect.any(Function),
      inspect: expect.any(Function),
      subscribe: expect.any(Function),
    });
```

- [ ] **Step 5: Run them to confirm they fail**

Run: `npx vitest run src/deeplink/__tests__/registry.global.spec.ts src/deeplink/__tests__/registry.inspect.spec.ts src/deeplink/__tests__/registry.prod.spec.ts src/__tests__/index.spec.ts`
Expected: FAIL with `reg.registerGlobalHandler is not a function`, `reg.inspect is not a function` and `reg.subscribe is not a function`, plus the barrel mismatch.

- [ ] **Step 6: Add the methods to `DeeplinkRegistry`** in `src/deeplink/types.ts`. Replace

```ts
  /** Whether at least one key handler is registered for `key` (global handlers don't count). */
  has(key: string): boolean;
}
```

with

```ts
  /** Whether at least one key handler is registered for `key` (global handlers don't count). */
  has(key: string): boolean;
  /**
   * Register a global handler that wraps every key's chain (always outermost). Meant for the host
   * (logger, tracker). The same `owner` replaces its own global handler.
   * @returns an identity-safe `unregister` that removes only this registration
   */
  registerGlobalHandler(handler: DeeplinkHandler, options: DeeplinkRegisterOptions): () => void;
  /** Read-only snapshot of global handlers and every key with handlers or waiting calls. */
  inspect(): DeeplinkInspection;
  /**
   * Call `listener` after any change to handlers or waiting counts.
   * @returns an idempotent unsubscribe function
   */
  subscribe(listener: () => void): () => void;
}
```

- [ ] **Step 7: Replace `src/deeplink/registry.ts` with the full implementation**

```ts
import isDev from '../utils/isDev';
import { type ComposeStep, compose } from './compose';
import { DeeplinkTimeoutError } from './errors';
import type {
  DeeplinkCallContext,
  DeeplinkHandler,
  DeeplinkInspection,
  DeeplinkInvokeOptions,
  DeeplinkPhase,
  DeeplinkRegisterOptions,
  DeeplinkRegistry,
  DeeplinkStepStatus,
} from './types';

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

function assertHandler(handler: unknown): asserts handler is DeeplinkHandler {
  if (typeof handler !== 'function') {
    throw new TypeError('[daas-toolbox] deeplink handler must be a function');
  }
}

/** Validate register options; `owner` is required (also when `options` itself is missing). */
function readRegisterOptions(options: DeeplinkRegisterOptions | undefined): {
  owner: string;
  order: number;
} {
  const owner: unknown = options?.owner;
  const order: unknown = options?.order ?? 0;
  if (typeof owner !== 'string' || owner === '') {
    throw new TypeError('[daas-toolbox] deeplink owner must be a non-empty string');
  }
  if (typeof order !== 'number' || !Number.isFinite(order)) {
    throw new TypeError(
      `[daas-toolbox] deeplink order must be a finite number, got ${String(order)}`,
    );
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
        if (isDev) console.error('[daas-toolbox] deeplink subscriber threw', error);
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

  function registerHandler(
    key: string,
    handler: DeeplinkHandler,
    options: DeeplinkRegisterOptions,
  ): () => void {
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

  function registerGlobalHandler(
    handler: DeeplinkHandler,
    options: DeeplinkRegisterOptions,
  ): () => void {
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
      let phase: DeeplinkPhase = 'waiting';
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let detachAbort = () => {};

      const call: PendingCall = {
        start: (keyChain) => {
          phase = 'running';
          // Snapshot: global handlers (outermost) + key handlers, as they are right now.
          const chain = [...globals, ...keyChain];
          const ctx: DeeplinkCallContext = {
            key,
            params,
            input: params,
            options: opts,
            signal: controller.signal,
            step: { index: 0, count: chain.length, owner: '', global: false },
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
        signal.addEventListener('abort', onAbort, { once: true });
        detachAbort = () => signal.removeEventListener('abort', onAbort);
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
```

- [ ] **Step 8: Run all tests and the typecheck**

Run: `npx vitest run && npx tsc --noEmit -p .`
Expected: every file PASSes, and tsc exits 0.

- [ ] **Step 9: Commit**

```bash
git add src
git commit -m "feat(daas-toolbox): global deeplink handlers and inspect/subscribe tracking"
```

---

### Task 4: Typed facade `registerGlobalHandler` / `inspect` / `subscribe`

**Files:**
- Modify: `src/deeplink/types.ts` (`TypedDeeplinkRegistry` gains three methods)
- Rewrite: `src/deeplink/typed.ts`
- Append tests: `src/deeplink/__tests__/typed.spec.ts`

**Interfaces:**
- Consumes: `DeeplinkRegistry.registerGlobalHandler/inspect/subscribe` (Task 3).
- Produces: `TypedDeeplinkRegistry.registerGlobalHandler(handler: DeeplinkHandler, options: DeeplinkRegisterOptions): () => void`, `inspect(): DeeplinkInspection`, `subscribe(listener: () => void): () => void`.

- [ ] **Step 1: Append the failing test** to `src/deeplink/__tests__/typed.spec.ts`

```ts

describe('createAppDeeplinks (global handlers and tracking)', () => {
  test('registerGlobalHandler, inspect and subscribe reach the underlying registry', async () => {
    const reg = createDeeplinkRegistry();
    const dl = createAppDeeplinks<TestDeeplinks>(reg);
    let changes = 0;
    const unsubscribe = dl.subscribe(() => {
      changes += 1;
    });
    const unregisterGlobal = dl.registerGlobalHandler(
      async (_ctx, next) => `[${String(await next())}]`,
      { owner: 'wrap' },
    );
    dl.registerHandler('ui.ping', () => 'pong', { owner: 'ping' });
    await expect(dl.invoke('ui.ping')).resolves.toBe('[pong]');
    expect(dl.inspect()).toEqual(reg.inspect());
    expect(dl.inspect().global).toEqual([{ owner: 'wrap', order: 0 }]);
    expect(changes).toBe(2);
    unregisterGlobal();
    unsubscribe();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/deeplink/__tests__/typed.spec.ts`
Expected: FAIL with `dl.subscribe is not a function`. tsc also reports the three missing properties on `TypedDeeplinkRegistry`.

- [ ] **Step 3: Extend `TypedDeeplinkRegistry`** in `src/deeplink/types.ts`. Replace

```ts
  /** Whether at least one key handler is registered for `key`. */
  has(key: keyof M & string): boolean;
}
```

with

```ts
  /** Whether at least one key handler is registered for `key`. */
  has(key: keyof M & string): boolean;
  /** Register a global handler (untyped: it wraps every key). */
  registerGlobalHandler(handler: DeeplinkHandler, options: DeeplinkRegisterOptions): () => void;
  /** Read-only snapshot of global handlers and every key with handlers or waiting calls. */
  inspect(): DeeplinkInspection;
  /** Call `listener` after any change to handlers or waiting counts. */
  subscribe(listener: () => void): () => void;
}
```

- [ ] **Step 4: Replace `src/deeplink/typed.ts`**

```ts
import { getGlobalRegistry } from './global';
import type {
  DeeplinkContractMap,
  DeeplinkHandler,
  DeeplinkRegistry,
  TypedDeeplinkRegistry,
  UntypedDeeplinks,
} from './types';

/** One facade per registry, so `createAppDeeplinks()` is identity-stable (safe in render and hook deps). */
const facades = new WeakMap<DeeplinkRegistry, TypedDeeplinkRegistry<UntypedDeeplinks>>();

/**
 * Typed facade over a deeplink registry (the shared global one by default). Mirrors daas-sdk
 * `createAppEvents<T>()`: MFEs import the contract map **type-only**, so there is no runtime
 * coupling between them. Typed and untyped callers share the same registry.
 *
 * @example
 * import type { AppDeeplinks } from '@company/contracts';
 * const dl = createAppDeeplinks<AppDeeplinks>();
 * const res = await dl.invoke('orders.open', { id: '42' }); // res: { opened: boolean }
 */
export function createAppDeeplinks<M extends DeeplinkContractMap<M> = UntypedDeeplinks>(
  registry: DeeplinkRegistry = getGlobalRegistry(),
): TypedDeeplinkRegistry<M> {
  let facade = facades.get(registry);
  if (!facade) {
    facade = {
      // Contract types exist only at compile time; typed and untyped handlers are identical at runtime.
      registerHandler: (key, handler, options) =>
        registry.registerHandler(key, handler as unknown as DeeplinkHandler, options),
      invoke: (key, params, options) =>
        registry.invoke(key, params as Record<string, unknown> | undefined, options),
      has: (key) => registry.has(key),
      registerGlobalHandler: (handler, options) => registry.registerGlobalHandler(handler, options),
      inspect: () => registry.inspect(),
      subscribe: (listener) => registry.subscribe(listener),
    };
    facades.set(registry, facade);
  }
  // Safe: the facade has no per-M state; M only narrows the compile-time signatures.
  return facade as unknown as TypedDeeplinkRegistry<M>;
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run src/deeplink && npx tsc --noEmit -p .`
Expected: every file PASSes, and tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add src
git commit -m "feat(daas-toolbox): typed facade registerGlobalHandler, inspect and subscribe"
```

---

### Task 5: README, coverage gate, lint, final verification

**Files:**
- Modify: `README.md` (replace the deeplink sections)

**Interfaces:**
- Consumes: the final API from Tasks 1–4.
- Produces: user documentation.

- [ ] **Step 1: Replace the deeplink part of `README.md`.** Replace everything from the line `## Deeplink handlers` up to (but not including) `## Copying into an SDK` with:

````markdown
## Deeplink handler chains

Several MFEs can register **handlers** on the same deeplink key. A call runs them as an onion:
each handler can change the payload on the way in (`next(ctx)`) and the result on the way out,
and the caller receives the final value. Keys match the `deeplink` string used by daas-sdk
`navigate(deeplink, params, options)`.

### Registering in an MFE: use the hook

`useDeeplinkHandler` is the recommended way for MFEs: it unregisters automatically when the
component unmounts.

```ts
import { deeplink, isDeeplinkTimeoutError, useDeeplinkHandler } from './toolbox';

// auth MFE: outermost gate, enriches the payload
useDeeplinkHandler('orders.open', (ctx, next) => {
  if (!hasRole('orders:view')) throw new ForbiddenError();
  return next({ ...ctx, params: { ...(ctx.params as object), userId: currentUser.id } });
}, { owner: 'auth', order: 10 });

// orders MFE: produces the result (doesn't call next)
useDeeplinkHandler('orders.open', async (ctx) => {
  const { id, userId } = ctx.params as { id: string; userId: string };
  return openOrder(id, userId, { signal: ctx.signal });
}, { owner: 'orders', order: 500 });

// any MFE
try {
  const res = await deeplink.invoke('orders.open', { id: '42' });
} catch (e) {
  if (isDeeplinkTimeoutError(e) && e.phase === 'waiting') {
    // no MFE has registered a handler for this key yet
  }
}
```

### Registering outside React: `registerHandler`

```ts
const unregister = deeplink.registerHandler('orders.open', handler, { owner: 'orders' });
// …when the module or app shuts down
unregister();
```

Use it for host code, non-React modules, tests, and **MFEs whose React version differs from
the toolbox's shared copy**: a hook from the shared toolbox runs on the host's React and fails
with "invalid hook call" there. In a side effect, return `unregister` as the cleanup.

### `owner` and duplicates

`owner` is required. Registering again with the same owner **replaces** that owner's handler
(dev warning: `handler from owner "orders" replaced`), so a side effect that re-runs without
cleanup never stacks duplicate handlers, and the warning points at the leak. Use the MFE name,
or `<mfe>:<purpose>` when one MFE registers several handlers on a key.

### Handlers

- **Order:** lower `order` runs first (outermost), and ties keep registration order. Suggested
  bands: gates 0–99, enrichers 100–199, producers 500+.
- **`return next(ctx)`** continues the chain. Forgetting `return` hands `undefined` to the
  outer handlers. After the last handler, `next()` resolves to the current `params`, so a chain
  made only of transforms returns the transformed payload.
- **Short-circuit** by returning without calling `next` (mocks, caches, producers). **Throw** to
  reject the call (gates). Calling `next()` twice rejects.
- `ctx.input` is the caller's original params, `ctx.state` is shared by every handler of the
  call, and `ctx.signal` is aborted on timeout or caller abort.

### Calls

- **No handler registered yet:** the call waits until one is, or until `options.timeout`
  (default `10000` ms; `Infinity` disables it) rejects it with `DeeplinkTimeoutError`
  (`phase: 'waiting'`).
- **At least one handler registered:** the call runs right away with the handlers present. A
  gate whose MFE isn't mounted yet is skipped, so logic that must always run belongs in the
  producing handler.
- Handlers registered in the same tick (for example, sibling MFEs mounting together) all join a
  call that was waiting.
- Each call uses the chain as it was when the call started.

### Global handlers (host)

```ts
// host boot: wraps every deeplink, always outside the key handlers
deeplink.registerGlobalHandler(async (ctx, next) => {
  const t = Date.now();
  try {
    return await next();
  } finally {
    logger.info('deeplink', { key: ctx.key, ms: Date.now() - t, step: ctx.step });
  }
}, { owner: 'host-logger' });
```

Global handlers never count as "a handler registered" (a call with only global handlers still
waits), and `has(key)` ignores them. They are meant for the host. A buggy global handler
affects every deeplink on the page.

### Tracking registration status

```ts
deeplink.inspect();
// { global: [{ owner: 'host-logger', order: 0 }],
//   keys: [{ key: 'orders.open', waiting: 0,
//            steps: [{ owner: 'auth', order: 10 }, { owner: 'orders', order: 500 }] }] }

const unsubscribe = deeplink.subscribe(() => renderPanel(deeplink.inspect()));
```

`inspect()` never contains params or results. `subscribe` fires after every registration,
unregistration, replacement or waiting-count change.

### Typed deeplinks

Declare contracts once, in a module MFEs import **type-only** (the daas-sdk
`createAppEvents<T>()` pattern):

```ts
export interface AppDeeplinks {
  'orders.open': { params: { id: string }; result: { opened: boolean } };
  'auth.reauth': { result: { token: string } }; // no params: invoke('auth.reauth')
}

const dl = createAppDeeplinks<AppDeeplinks>();
useDeeplinkHandler(dl, 'orders.open', (ctx) => ({ opened: ctx.input.id === '42' }), {
  owner: 'orders',
  order: 500,
});
const res = await dl.invoke('orders.open', { id: '42' }); // res: { opened: boolean }
```

Only the ends of the chain are typed: `ctx.input` is the contract's params, and `invoke`
returns the contract's result. `ctx.params` and `next()`'s result are `unknown`, because a
handler can't know its position in the chain. Types are checked at build time, not at runtime.

````

- [ ] **Step 2: Run the full suite, the typecheck and the coverage gate**

```bash
npx tsc --noEmit -p .
npx vitest run
npx vitest run --coverage \
  --coverage.include='src/deeplink/**' \
  --coverage.include='src/hooks/useDeeplinkHandler/**' \
  --coverage.thresholds.100
```
Expected: tsc exits 0. Every test file passes. The coverage run reports 100% statements, branches, functions and lines and exits 0. If something is uncovered, add a test to the spec file that owns that code; don't lower the threshold.

- [ ] **Step 3: Lint and format the new code with the repo-pinned Biome** (from the repo root)

```bash
cd /home/chris/Github/hooks
T="packages/daas-toolbox/src/deeplink packages/daas-toolbox/src/hooks/useDeeplinkHandler packages/daas-toolbox/src/__tests__"
npx biome check --write $T
npx biome check $T
git status --short
```
Expected: the second command exits 0. `git status` shows changes only under `packages/daas-toolbox/`.

- [ ] **Step 4: Rerun the tests after formatting, then commit**

```bash
cd /home/chris/Github/hooks/packages/daas-toolbox && npx vitest run
cd /home/chris/Github/hooks
git add packages/daas-toolbox
git commit -m "docs(daas-toolbox): document deeplink handler chains, hook-first registration"
```
