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
