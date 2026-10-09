// Dependency-free port of lodash `debounce` / `throttle` (MIT, https://lodash.com),
// covering the subset used by useRequest: leading, trailing, maxWait, cancel, flush.

export interface DebounceSettings {
  /** Invoke on the leading edge of the timeout. @default false */
  leading?: boolean;
  /** Maximum time `func` is allowed to be delayed before it's invoked. */
  maxWait?: number;
  /** Invoke on the trailing edge of the timeout. @default true */
  trailing?: boolean;
}

export interface ThrottleSettings {
  /** Invoke on the leading edge of the timeout. @default true */
  leading?: boolean;
  /** Invoke on the trailing edge of the timeout. @default true */
  trailing?: boolean;
}

export interface DebouncedFunc<T extends (...args: any[]) => any> {
  (...args: Parameters<T>): ReturnType<T> | undefined;
  /** Cancel any pending invocation. */
  cancel: () => void;
  /** Immediately invoke any pending invocation. */
  flush: () => ReturnType<T> | undefined;
}

export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait = 0,
  options: DebounceSettings = {},
): DebouncedFunc<T> {
  let lastArgs: Parameters<T> | undefined;
  let lastThis: unknown;
  let result: ReturnType<T> | undefined;
  let timerId: ReturnType<typeof setTimeout> | undefined;
  let lastCallTime: number | undefined;
  let lastInvokeTime = 0;

  const leading = !!options.leading;
  const maxing = 'maxWait' in options && options.maxWait !== undefined;
  const maxWait = maxing ? Math.max(options.maxWait ?? 0, wait) : 0;
  const trailing = options.trailing === undefined ? true : !!options.trailing;

  function invokeFunc(time: number) {
    const args = lastArgs as Parameters<T>;
    const thisArg = lastThis;
    lastArgs = undefined;
    lastThis = undefined;
    lastInvokeTime = time;
    result = func.apply(thisArg, args);
    return result;
  }

  function remainingWait(time: number) {
    const timeSinceLastCall = time - (lastCallTime ?? 0);
    const timeSinceLastInvoke = time - lastInvokeTime;
    const timeWaiting = wait - timeSinceLastCall;
    return maxing ? Math.min(timeWaiting, maxWait - timeSinceLastInvoke) : timeWaiting;
  }

  function shouldInvoke(time: number) {
    if (lastCallTime === undefined) {
      return true;
    }
    const timeSinceLastCall = time - lastCallTime;
    const timeSinceLastInvoke = time - lastInvokeTime;
    return (
      timeSinceLastCall >= wait ||
      timeSinceLastCall < 0 ||
      (maxing && timeSinceLastInvoke >= maxWait)
    );
  }

  function trailingEdge(time: number) {
    timerId = undefined;
    // Only invoke if `func` has been debounced at least once.
    if (trailing && lastArgs) {
      return invokeFunc(time);
    }
    lastArgs = undefined;
    lastThis = undefined;
    return result;
  }

  function timerExpired() {
    const time = Date.now();
    if (shouldInvoke(time)) {
      trailingEdge(time);
      return;
    }
    timerId = setTimeout(timerExpired, remainingWait(time));
  }

  function leadingEdge(time: number) {
    lastInvokeTime = time;
    timerId = setTimeout(timerExpired, wait);
    return leading ? invokeFunc(time) : result;
  }

  function cancel() {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
    lastInvokeTime = 0;
    lastArgs = undefined;
    lastCallTime = undefined;
    lastThis = undefined;
    timerId = undefined;
  }

  function flush() {
    return timerId === undefined ? result : trailingEdge(Date.now());
  }

  function debounced(this: unknown, ...args: Parameters<T>) {
    const time = Date.now();
    const isInvoking = shouldInvoke(time);

    lastArgs = args;
    lastThis = this;
    lastCallTime = time;

    if (isInvoking) {
      if (timerId === undefined) {
        return leadingEdge(lastCallTime);
      }
      if (maxing) {
        // Handle invocations in a tight loop.
        clearTimeout(timerId);
        timerId = setTimeout(timerExpired, wait);
        return invokeFunc(lastCallTime);
      }
    }
    if (timerId === undefined) {
      timerId = setTimeout(timerExpired, wait);
    }
    return result;
  }

  debounced.cancel = cancel;
  debounced.flush = flush;
  return debounced;
}

export function throttle<T extends (...args: any[]) => any>(
  func: T,
  wait = 0,
  options: ThrottleSettings = {},
): DebouncedFunc<T> {
  return debounce(func, wait, {
    leading: options.leading === undefined ? true : !!options.leading,
    maxWait: wait,
    trailing: options.trailing === undefined ? true : !!options.trailing,
  });
}
