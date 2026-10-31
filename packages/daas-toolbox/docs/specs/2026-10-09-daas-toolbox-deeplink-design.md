# daas-toolbox + deeplink handler registry — design

- **Date:** 2026-10-09
- **Status:** Accepted; §4 rules 4, 5 and 10 and the "Replace" duplicate rule are superseded by `2026-10-10-deeplink-middleware-chain-design.md`
- **Branch:** `daas-hooks`

## 1. Goal

1. Rename the vendored hooks package `@daas/hooks` to `@daas/toolbox`, a general toolbox where the
   hooks are one folder among other utilities.
2. Add a **deeplink handler registry**. Any MFE can register an async handler for a deeplink key,
   and any other MFE can invoke that key and get the handler's result back as a Promise.

### Context

- The DaaS ecosystem (the DaaS SDK) already has deeplinks: a string key that resolves
  through the deeplink registry to a `daas` route and/or host-registered `targets`. Its
  `navigate(deeplink, params?, options?)` returns `void` (fire-and-forget), and its
  `deeplinkTargets` handlers are host-only and keyed by target type.
- Nothing lets an **MFE** register a handler for a deeplink, and nothing **returns a result**.
  This design fills that gap.
- MFEs are loaded with Module Federation, and the toolbox is a shared singleton.
- The toolbox is pure source that gets copied by hand into the owner's SDK. It is not published
  to npm.

### Decisions made during brainstorming

| Topic | Decision |
| --- | --- |
| Location | `daas-toolbox`, standalone. It does **not** import the DaaS SDK. |
| Call shape | Mirrors `navigate`: `(deeplink: string, params?: Record<string, unknown>, options?)` |
| Handler not registered yet | The call waits in a queue, with a timeout |
| Duplicate registration | **Replace**: the latest registration wins and the previous one is dropped for good |
| API style | Plain `handle`/`invoke` functions plus a thin React hook (follows ADR-0004 in daas-cli) |

### Non-goals

- Integrating with `navigate()` or the deeplink JSON registry. The toolbox matches only the key
  string.
- Multiple handlers per key, or broadcast or fan-out.
- Pattern or URL matching (`daas://orders/:id`). Keys must match exactly.
- Calls across iframes or windows (`postMessage`).
- Validating params or results. Callers and handlers own their own types.

## 2. Package structure

```
packages/daas-toolbox/              (git mv from packages/daas-hooks; name "@daas/toolbox")
  LICENSE                           ahooks MIT license (kept)
  README.md
  docs/specs/                       this file
  src/
    index.ts                        root barrel: hooks + deeplink + errors + types
    hooks/
      useHistoryTravel/  useMount/  useRequest/  useWhyDidYouUpdate/
      useMemoizedFn/  useLatest/  useUpdate/  useUnmount/  useCreation/
      useUpdateEffect/  createUpdateEffect/
      useDeeplinkHandler/           NEW
    deeplink/                       NEW
      index.ts                      `deeplink` global instance + re-exports
      registry.ts                   createDeeplinkRegistry(): the pure logic
      errors.ts                     DeeplinkTimeoutError, isDeeplinkTimeoutError
      global.ts                     globalThis singleton lookup/creation
      types.ts
    utils/                          shared helpers (debounce, isDev, isBrowser, depsAreSame, …)
```

Moving the hooks into `src/hooks/` changes their relative imports of `utils` from `../utils` to
`../../utils`. Nothing else in the hook code changes.

## 3. Public API

```ts
/** Options for `deeplink.invoke`. Mirrors the open shape of daas-sdk `NavigateOptions`. */
export interface DeeplinkInvokeOptions {
  /** Milliseconds from invoke() until the call settles (wait + run). `Infinity` disables. @default 10000 */
  timeout?: number;
  /** Caller-side cancellation. */
  signal?: AbortSignal;
  /** Extra caller options, passed through to the handler untouched. */
  [key: string]: unknown;
}

export interface DeeplinkHandlerContext {
  /** The options object the caller passed (or `{}`). */
  options: DeeplinkInvokeOptions;
  /** Aborted when the call times out or the caller aborts. */
  signal: AbortSignal;
}

export type DeeplinkParams = Record<string, unknown> | undefined;

export type DeeplinkHandler<TResult = unknown> = (
  params: DeeplinkParams,
  ctx: DeeplinkHandlerContext,
) => TResult | Promise<TResult>;

export interface DeeplinkRegistry {
  /** Register `handler` for `key`, replacing any existing one. Returns an identity-safe disposer. */
  handle<TResult>(key: string, handler: DeeplinkHandler<TResult>): () => void;
  /** Invoke the handler for `key`, waiting for one to register if needed. */
  invoke<TResult = unknown>(
    key: string,
    params?: Record<string, unknown>,
    options?: DeeplinkInvokeOptions,
  ): Promise<TResult>;
  /** Whether a handler is currently registered for `key`. */
  has(key: string): boolean;
}

export function createDeeplinkRegistry(): DeeplinkRegistry;
export const deeplink: DeeplinkRegistry; // the shared global instance

export class DeeplinkTimeoutError extends Error {
  readonly key: string;
  readonly phase: 'waiting' | 'running';
  readonly timeout: number;
}
export function isDeeplinkTimeoutError(e: unknown): e is DeeplinkTimeoutError;

/** React wrapper: registers on mount, disposes on unmount, always calls the latest handler. */
export function useDeeplinkHandler<TResult>(key: string, handler: DeeplinkHandler<TResult>): void;
```

### Usage

```ts
// MFE A (owner)
useDeeplinkHandler('orders.open', async (params, { signal }) => {
  const order = await api.getOrder(params?.id as string, { signal });
  openOrderDrawer(order);
  return { opened: true };
});

// MFE B (caller)
try {
  const res = await deeplink.invoke<{ opened: boolean }>('orders.open', { id: '42' });
} catch (e) {
  if (isDeeplinkTimeoutError(e) && e.phase === 'waiting') {
    // MFE A never registered: not loaded, or loaded without handling this key
  }
}
```

## 4. Runtime behavior

### Call lifecycle

```
invoke(key, params, opts)
  ├─ handler registered → run → settle
  └─ none → add to pending[key] (in arrival order)
       ├─ handle(key, fn) → send every waiting call to fn, in order → run → settle
       ├─ timeout        → remove from queue, reject DeeplinkTimeoutError{ phase: 'waiting' }
       └─ opts.signal    → remove from queue, reject signal.reason
```

### Rules

1. **One time budget.** `timeout` (default `10000` ms) runs from `invoke()` until the call settles,
   covering both the wait and the handler's run time. `Infinity` disables it. The rejection's
   `phase` is `'waiting'` if no handler had received the call yet, and `'running'` otherwise.
2. **Sync and async handlers are treated the same.** The handler always runs inside a Promise
   chain, so a synchronous `throw` becomes a rejection. `invoke` itself never throws
   synchronously, except for an invalid key (rule 9).
3. **Handler errors are passed through unchanged.** `invoke` rejects with the exact value the
   handler threw or rejected with. The toolbox wraps only its own failures (timeout).
4. **Replacing a handler mid-call doesn't interrupt the call.** Calls already running finish on
   the handler that started them and still deliver their result. New calls go to the new
   handler. Replacement does **not** abort `ctx.signal`.
5. **Disposing a handler mid-call doesn't interrupt it either.** A running call still settles.
   Calls that arrive later wait in the queue for the next registration.
6. **A late result is dropped.** Once a call has rejected (timeout or abort), a later handler
   result or error is ignored. On timeout or caller abort, `ctx.signal` is aborted so the
   handler can stop early.
7. **Disposers are identity-safe.** A disposer removes the handler only if it is still the
   current one for that key. Calling it a second time does nothing.
8. **Caller abort.** If `opts.signal` is already aborted, the call rejects right away with
   `signal.reason`. If it aborts while the call is waiting, the call is removed from the queue
   and rejects with `signal.reason`. If it aborts while the handler is running, `ctx.signal` is
   aborted and the call rejects with `signal.reason`.
9. **Invalid key.** A key that is not a non-empty string throws a `TypeError` from
   `handle`/`invoke` in every mode, because it is always a programming error.
10. **Dev warning on replace.** When `isDev` is true, replacing an existing handler logs
    `console.warn('[daas-toolbox] deeplink "<key>" handler replaced')`. Production logs nothing.
11. **Cleanup.** Every settle path (resolve, reject, timeout, abort) clears that call's timer and
    removes its abort listener.

### Global singleton

- Stored at `globalThis[Symbol.for('daas-toolbox/deeplink')]` as `{ version: 1, registry }`.
- `deeplink` resolves on first import: it reuses an existing entry, or creates one if none exists.
- If an entry exists with a different `version`, the existing registry is **reused, not
  overwritten**, and a dev warning is logged. A stray old copy of the toolbox must never wipe out
  handlers other MFEs have registered.
- This keeps the registry shared even when an MFE bundles its own copy of the toolbox instead of
  using the Module Federation shared one.

### `useDeeplinkHandler`

- Keeps the latest `handler` in a ref (the `useLatest` pattern) and registers one stable wrapper
  that calls `ref.current(...)`. Re-renders never re-register.
- `useEffect(() => deeplink.handle(key, wrapper), [key])` means a key change disposes the old
  registration and registers the new one, and unmounting disposes.
- StrictMode is safe: in dev, React runs register → dispose → register, and the identity-safe
  disposer guarantees exactly one live handler at the end.
- It uses the global `deeplink` instance. Tests that need isolation call `createDeeplinkRegistry()`
  directly.

## 5. Testing

The stack is vitest, jsdom and `@testing-library/react`, the same as the vendored hooks. Fake
timers are used for every timeout case. Coverage target: **100%** for `src/deeplink/**` and
`src/hooks/useDeeplinkHandler/**`. The vendored ahooks code keeps its upstream coverage.

**`deeplink/__tests__/registry.spec.ts`** (each test uses a fresh `createDeeplinkRegistry()`)

| Area | Cases |
| --- | --- |
| Happy path | registered → resolves; sync handler; async handler; `params` and `options` reach the handler |
| Waiting | invoke before handle → resolves when the handler registers; several waiting calls run in arrival order; other keys unaffected |
| Timeout | `phase: 'waiting'`; `phase: 'running'` with `ctx.signal.aborted`; `Infinity` never times out; default is 10000; a late result is ignored |
| Caller abort | while waiting → removed from queue, rejects `signal.reason`; while running → `ctx.signal` aborted; already aborted → immediate rejection |
| Errors | sync throw becomes a rejection; the handler's error is the same object (`toBe`); invalid key throws `TypeError` |
| Replace | new handler gets new calls; a running call finishes on the old handler; dev warning logged |
| Dispose | later calls wait again; a stale disposer doesn't remove the newer handler; double dispose does nothing; a running call still settles |
| `has()` | reflects whether a handler is registered |

**`deeplink/__tests__/global.spec.ts`**

- Two module instances (`vi.resetModules()` + re-import) share one registry.
- An entry with a mismatched `version` is reused, not overwritten, and a dev warning is logged.

**`hooks/useDeeplinkHandler/__tests__/index.spec.ts`**

- Registers on mount and disposes on unmount.
- A new handler closure on re-render is used by later invokes, and `handle` is called only once
  (spy).
- Changing the key disposes the old key and registers the new one.
- Under `<React.StrictMode>`, exactly one handler is live after mount.

## 6. Rename / migration steps

1. `git mv packages/daas-hooks packages/daas-toolbox`, and set `package.json` `name` to
   `@daas/toolbox`.
2. Move the hook folders into `src/hooks/`, and fix their `utils` imports (`../utils` →
   `../../utils`, and `../../../utils` → `../../../../utils` inside `useRequest/src/**`).
3. Rewrite `src/index.ts` to re-export the hooks, `deeplink`, `createDeeplinkRegistry`, the errors
   and the types.
4. Update the README: package name, the new folder layout, and a deeplink usage section.
5. Verify with `tsc --noEmit`, the full vitest run, and the repo-pinned Biome scoped to the
   package. Commit on `daas-hooks`.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Toolbox not configured as an MF shared singleton | `Symbol.for` global keeps one registry anyway |
| Two MFEs handle the same key and each silently replaces the other | Dev warning on replace; key naming convention `<mfe>.<action>` recommended in the README |
| Caller waits the full 10 s for an MFE that will never load | `phase: 'waiting'` makes it diagnosable; caller can pass a shorter `timeout` or check `has()` first |
| Handler keeps running after timeout | `ctx.signal` is aborted; handlers should pass it to `fetch` and other cancellable work |
