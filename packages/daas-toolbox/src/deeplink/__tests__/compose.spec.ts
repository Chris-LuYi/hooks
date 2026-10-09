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
