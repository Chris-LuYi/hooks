import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { debounce, throttle } from '../debounce';

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('invokes once on trailing edge with latest args', () => {
    const fn = vi.fn((x: number) => x);
    const d = debounce(fn, 100);
    d(1);
    d(2);
    d(3);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(3);
  });

  test('leading without trailing', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100, { leading: true, trailing: false });
    d();
    d();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('maxWait forces invocation during continuous calls', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100, { maxWait: 150 });
    for (let i = 0; i < 10; i++) {
      d();
      vi.advanceTimersByTime(50);
    }
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  test('cancel drops pending call, flush runs it now', () => {
    const fn = vi.fn((x: number) => x * 2);
    const d = debounce(fn, 100);
    d(1);
    d.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();

    d(2);
    expect(d.flush()).toBe(4);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(d.flush()).toBe(4);
  });

  test('handles system clock going backwards', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    vi.setSystemTime(Date.now() - 1000);
    d();
    expect(fn).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalled();
  });
});

describe('throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('leading + trailing by default', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t();
    t();
    t();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('respects leading: false / trailing: false', () => {
    const noLead = vi.fn();
    const t1 = throttle(noLead, 100, { leading: false });
    t1();
    expect(noLead).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(noLead).toHaveBeenCalledTimes(1);

    const noTrail = vi.fn();
    const t2 = throttle(noTrail, 100, { trailing: false });
    t2();
    t2();
    vi.advanceTimersByTime(100);
    expect(noTrail).toHaveBeenCalledTimes(1);
  });
});
